/**
 * DarkMan - Servidor Web & API REST
 * 
 * Servidor nativo en Node.js (v24+) sin dependencias externas.
 * Maneja persistencia con SQLite, autenticación administrativa,
 * cálculo de fechas en zona horaria America/Lima y entrega del frontend.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const dateUtils = require('./date-utils');
const gsheetsSync = require('./gsheets-sync');

// Cargar variables de entorno desde .env si existe
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'darkman2026';
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || 'darkman_super_secret_key_2026_lima';

// MIME types para el servidor de archivos estáticos
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Genera un token HMAC firmado para la sesión de administrador
 */
function createAuthToken() {
  const payload = `admin:${Date.now()}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

/**
 * Valida un token HMAC
 */
function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [b64Payload, signature] = parts;
  try {
    const payload = Buffer.from(b64Payload, 'base64url').toString('utf8');
    const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch (err) {
    return false;
  }
}

/**
 * Extrae token de cabecera o cookies
 */
function getAuthTokenFromReq(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith('darkman_auth=')) {
        return decodeURIComponent(cookie.slice('darkman_auth='.length));
      }
    }
  }
  return null;
}

/**
 * Verifica si la solicitud está autenticada
 */
function isAuthenticated(req) {
  if (!REQUIRE_AUTH) return true;
  const token = getAuthTokenFromReq(req);
  return verifyAuthToken(token);
}

/**
 * Parsea el cuerpo JSON de una petición
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) { // Límite 1MB
        reject(new Error('Cuerpo de la petición demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Formato JSON inválido'));
      }
    });
    req.on('error', err => reject(err));
  });
}

/**
 * Envía una respuesta JSON
 */
function sendJson(res, statusCode, data, headers = {}) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...headers
  });
  res.end(json);
}

/**
 * Sirve archivos estáticos de la carpeta /public
 */
function serveStaticFile(req, res, filePath) {
  const publicDir = path.join(__dirname, 'public');
  let safePath = path.normalize(path.join(publicDir, filePath));

  if (!safePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Acceso denegado');
    return;
  }

  // Si es un directorio, servir index.html
  if (fs.existsSync(safePath) && fs.statSync(safePath).isDirectory()) {
    safePath = path.join(safePath, 'index.html');
  }

  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    // Para rutas SPA de fallback
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      safePath = indexPath;
    } else {
      res.writeHead(404);
      res.end('Archivo no encontrado');
      return;
    }
  }

  const ext = path.extname(safePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isNoCache = ext === '.html' || ext === '.json' || safePath.endsWith('sw.js') || safePath.endsWith('manifest.json');

  fs.readFile(safePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Error interno del servidor al leer archivo');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': isNoCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400'
    });
    res.end(content);
  });
}

// Inicializar la base de datos
db.getDb();

// Si la base de datos está vacía, pre-cargar datos de prueba
const currentStats = db.getSystemStats();
if (currentStats.totalClients === 0) {
  console.log('Base de datos inicializada sin registros. Pre-cargando datos de demostración...');
  db.seedDemoData();
}

const server = http.createServer(async (req, res) => {
  // Manejo de CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    // -------------------------------------------------------------
    // API: Rutas de Autenticación
    // -------------------------------------------------------------
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        authenticated: isAuthenticated(req),
        requireAuth: REQUIRE_AUTH,
        timezone: dateUtils.LIMA_TIMEZONE
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.password === ADMIN_PASSWORD) {
        const token = createAuthToken();
        return sendJson(res, 200, {
          success: true,
          token,
          message: 'Autenticado correctamente'
        }, {
          'Set-Cookie': `darkman_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
        });
      } else {
        return sendJson(res, 401, { error: 'Contraseña de administrador incorrecta.' });
      }
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return sendJson(res, 200, { success: true, message: 'Sesión cerrada' }, {
        'Set-Cookie': 'darkman_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      });
    }

    // -------------------------------------------------------------
    // Control de Acceso: requerir auth si REQUIRE_AUTH es true
    // -------------------------------------------------------------
    if (pathname.startsWith('/api/') && REQUIRE_AUTH && !isAuthenticated(req)) {
      return sendJson(res, 401, { error: 'Acceso no autorizado. Inicie sesión como administrador.' });
    }

    // -------------------------------------------------------------
    // API: Hora oficial y Zona Horaria
    // -------------------------------------------------------------
    if (pathname === '/api/time' && req.method === 'GET') {
      return sendJson(res, 200, {
        timezone: dateUtils.LIMA_TIMEZONE,
        todayLima: dateUtils.getLimaTodayString(),
        currentIso: new Date().toISOString()
      });
    }

    // -------------------------------------------------------------
    // API: Estadísticas y KPIs
    // -------------------------------------------------------------
    if (pathname === '/api/stats' && req.method === 'GET') {
      const stats = db.getSystemStats();
      return sendJson(res, 200, stats);
    }

    // -------------------------------------------------------------
    // API: Feed unificado ordenado automáticamente por urgencia
    // -------------------------------------------------------------
    if (pathname === '/api/services/feed' && req.method === 'GET') {
      const search = parsedUrl.searchParams.get('search') || '';
      const status = parsedUrl.searchParams.get('status') || 'TODOS';
      const service = parsedUrl.searchParams.get('service') || 'TODOS';

      const feed = db.getAllServicesFeed({ search, status, service });
      return sendJson(res, 200, {
        services: feed,
        total: feed.length,
        todayLima: dateUtils.getLimaTodayString()
      });
    }

    // -------------------------------------------------------------
    // API: Clientes
    // -------------------------------------------------------------
    // Crear cliente
    if (pathname === '/api/clients' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const result = db.createClient(body);
      return sendJson(res, 201, result);
    }

    // Obtener detalle de cliente
    const clientDetailMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
    if (clientDetailMatch && req.method === 'GET') {
      const clientId = clientDetailMatch[1];
      const client = db.getClientById(clientId);
      if (!client) {
        return sendJson(res, 404, { error: 'Cliente no encontrado' });
      }
      return sendJson(res, 200, client);
    }

    // Actualizar cliente
    if (clientDetailMatch && req.method === 'PUT') {
      const clientId = clientDetailMatch[1];
      const body = await parseJsonBody(req);
      const result = db.updateClient(clientId, body);
      return sendJson(res, 200, result);
    }

    // Eliminar cliente
    if (clientDetailMatch && req.method === 'DELETE') {
      const clientId = clientDetailMatch[1];
      const result = db.deleteClient(clientId);
      return sendJson(res, 200, result);
    }

    // Agregar servicio a cliente
    const clientAddServiceMatch = pathname.match(/^\/api\/clients\/(\d+)\/services$/);
    if (clientAddServiceMatch && req.method === 'POST') {
      const clientId = clientAddServiceMatch[1];
      const body = await parseJsonBody(req);
      const updatedClient = db.addServiceToClient(clientId, body);
      return sendJson(res, 201, updatedClient);
    }

    // -------------------------------------------------------------
    // API: Servicios
    // -------------------------------------------------------------
    const serviceMatch = pathname.match(/^\/api\/services\/(\d+)$/);
    if (serviceMatch && req.method === 'PUT') {
      const serviceId = serviceMatch[1];
      const body = await parseJsonBody(req);
      const updatedClient = db.updateService(serviceId, body);
      return sendJson(res, 200, updatedClient);
    }

    if (serviceMatch && req.method === 'DELETE') {
      const serviceId = serviceMatch[1];
      const result = db.deleteService(serviceId);
      return sendJson(res, 200, result);
    }

    // Renovar mensualidad
    const renewMatch = pathname.match(/^\/api\/services\/(\d+)\/renew$/);
    if (renewMatch && req.method === 'POST') {
      const serviceId = renewMatch[1];
      const body = await parseJsonBody(req);
      const updatedClient = db.renewService(serviceId, body);
      return sendJson(res, 200, {
        success: true,
        message: 'Renovación registrada exitosamente',
        client: updatedClient
      });
    }

    // -------------------------------------------------------------
    // API: Modos de Datos (Demo / Limpieza)
    // -------------------------------------------------------------
    if (pathname === '/api/demo/seed' && req.method === 'POST') {
      const stats = db.seedDemoData();
      return sendJson(res, 200, {
        success: true,
        message: 'Datos de prueba cargados correctamente',
        stats
      });
    }

    if (pathname === '/api/demo/clear' && req.method === 'POST') {
      const result = db.clearAllData();
      return sendJson(res, 200, {
        success: true,
        message: 'Base de datos vaciada para uso de producción',
        result
      });
    }

    // -------------------------------------------------------------
    // API: Integración con Google Sheets
    // -------------------------------------------------------------
    if (pathname === '/api/gsheets/info' && req.method === 'GET') {
      const sheetId = gsheetsSync.getSpreadsheetId();
      const lastSync = db.getAppSetting('last_gsheet_sync', null);
      const lastError = db.getAppSetting('last_gsheet_error', null);
      return sendJson(res, 200, {
        spreadsheetId: sheetId,
        url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
        connected: true,
        lastSync,
        lastError
      });
    }

    if (pathname === '/api/gsheets/sync' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.spreadsheetId) {
        gsheetsSync.setSpreadsheetId(body.spreadsheetId);
      }
      try {
        const syncResult = gsheetsSync.syncToGoogleSheets(body.spreadsheetId);
        const nowIso = new Date().toISOString();
        db.setAppSetting('last_gsheet_sync', nowIso);
        db.setAppSetting('last_gsheet_error', null);
        return sendJson(res, 200, {
          ...syncResult,
          lastSync: nowIso
        });
      } catch (err) {
        db.setAppSetting('last_gsheet_error', err.message);
        return sendJson(res, 500, {
          error: `Error al sincronizar con Google Sheets: ${err.message}`,
          failed: true
        });
      }
    }

    if (pathname === '/api/gsheets/import' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.spreadsheetId) {
        gsheetsSync.setSpreadsheetId(body.spreadsheetId);
      }
      try {
        const importResult = gsheetsSync.importFromGoogleSheets(body.spreadsheetId);
        return sendJson(res, 200, importResult);
      } catch (err) {
        return sendJson(res, 500, {
          error: `Error al importar desde Google Sheets: ${err.message}`,
          failed: true
        });
      }
    }

    // -------------------------------------------------------------
    // Servir Archivos Estáticos del Frontend
    // -------------------------------------------------------------
    if (!pathname.startsWith('/api/')) {
      return serveStaticFile(req, res, pathname === '/' ? 'index.html' : pathname.slice(1));
    }

    // Ruta API no encontrada
    return sendJson(res, 404, { error: 'Ruta API no encontrada' });

  } catch (error) {
    console.error('Error procesando petición:', error);
    return sendJson(res, 400, {
      error: error.message || 'Error interno del servidor'
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  DarkMan - Gestor de Suscripciones & Clientes`);
  console.log(`  Servidor activo en: http://0.0.0.0:${PORT}`);
  console.log(`  Zona Horaria: ${dateUtils.LIMA_TIMEZONE}`);
  console.log(`  Fecha Lima actual: ${dateUtils.getLimaTodayString()}`);
  console.log(`  Seguridad Admin: ${REQUIRE_AUTH ? 'ACTIVADA' : 'MODO LOCAL (Desactivada)'}`);
  console.log(`=======================================================`);
});

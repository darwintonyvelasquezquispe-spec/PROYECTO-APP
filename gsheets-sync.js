/**
 * DarkMan - Integración Bidireccional con Google Sheets
 * 
 * Permite sincronizar clientes, servicios, vencimientos y pagos
 * directamente con la hoja de cálculo de Google Sheets conectada.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const db = require('./db');
const dateUtils = require('./date-utils');

// ID de la hoja de cálculo en Google Drive del usuario
const DEFAULT_SPREADSHEET_ID = '1WS8iXX9TVqmrbMMF9QaQ16JzHEk_gyzdNbSm3p9QtzM';

function getSpreadsheetId() {
  return process.env.GOOGLE_SHEET_ID || db.getAppSetting('google_sheet_id', DEFAULT_SPREADSHEET_ID);
}

function setSpreadsheetId(id) {
  db.setAppSetting('google_sheet_id', id);
}

/**
 * Exporta y sincroniza todos los datos de DarkMan hacia Google Sheets
 */
function syncToGoogleSheets(spreadsheetId = null) {
  const targetId = spreadsheetId || getSpreadsheetId();
  const feed = db.getAllServicesFeed();

  // 1. Hoja "Suscripciones"
  const serviceRows = [
    [
      'ID Cliente',
      'Cliente',
      'Celular',
      'Servicio',
      'Fecha Inicio',
      'Fecha Vencimiento',
      'Tiempo Restante / Atraso',
      'Monto (S/.)',
      'Estado',
      'Notas del Servicio'
    ]
  ];

  for (const item of feed) {
    serviceRows.push([
      `CL-${String(item.clientId).padStart(4, '0')}`,
      item.clientName,
      `'${item.clientFullPhone}`, // Comilla simple inicial evita que Google Sheets interprete el "+" como fórmula
      item.serviceName,
      item.startDateDisplay,
      item.expiryDateDisplay,
      item.status.badgeText,
      item.amount.toFixed(2),
      item.status.label,
      item.serviceNotes || item.clientNotes || ''
    ]);
  }

  // 2. Hoja "Historial"
  const historyRows = [
    [
      'ID Pago',
      'ID Cliente',
      'Cliente',
      'Servicio',
      'Período Inicio',
      'Período Fin',
      'Monto (S/.)',
      'Método de Pago',
      'Fecha de Pago',
      'Tipo Registro',
      'Notas'
    ]
  ];

  const dbInstance = db.getDb();
  const historyList = dbInstance.prepare(`
    SELECT 
      ph.id, ph.client_id, ph.start_date, ph.expiry_date, ph.amount, ph.currency,
      ph.payment_date, ph.payment_method, ph.notes, ph.type,
      c.full_name AS client_name, s.name AS service_name
    FROM payment_history ph
    JOIN clients c ON ph.client_id = c.id
    JOIN services s ON ph.service_id = s.id
    ORDER BY ph.payment_date DESC, ph.id DESC
  `).all();

  for (const h of historyList) {
    historyRows.push([
      `PG-${String(h.id).padStart(4, '0')}`,
      `CL-${String(h.client_id).padStart(4, '0')}`,
      h.client_name,
      h.service_name,
      dateUtils.formatDateToDisplay(h.start_date),
      dateUtils.formatDateToDisplay(h.expiry_date),
      h.amount.toFixed(2),
      h.payment_method,
      dateUtils.formatDateToDisplay(h.payment_date),
      h.type,
      h.notes || ''
    ]);
  }

  // Escribir archivo de peticiones por lotes
  const tempBatchFile = path.join(__dirname, 'gsheets_sync_temp.json');
  const batchRequests = [
    {
      op: 'clear',
      range: 'Suscripciones!A1:J200'
    },
    {
      op: 'write',
      range: 'Suscripciones!A1',
      data: serviceRows
    },
    {
      op: 'clear',
      range: 'Historial!A1:K300'
    },
    {
      op: 'write',
      range: 'Historial!A1',
      data: historyRows
    }
  ];

  fs.writeFileSync(tempBatchFile, JSON.stringify(batchRequests, null, 2), 'utf8');

  // Si hay token de Google OAuth o Cuenta de Servicio configurada en entorno,
  // se utiliza la API REST oficial de Google Sheets sin depender del CLI local
  const googleToken = process.env.GOOGLE_OAUTH_TOKEN;
  if (googleToken) {
    try {
      // 1. Limpiar y escribir Suscripciones
      const syncBody = {
        valueInputOption: 'USER_ENTERED',
        data: [
          {
            range: 'Suscripciones!A1:J200',
            values: serviceRows
          },
          {
            range: 'Historial!A1:K300',
            values: historyRows
          }
        ]
      };

      const res = execSync(`curl -s -X POST "https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values:batchUpdate" -H "Authorization: Bearer ${googleToken}" -H "Content-Type: application/json" -d "${JSON.stringify(syncBody).replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
      return {
        success: true,
        mode: 'cloud-rest-api',
        spreadsheetId: targetId,
        url: `https://docs.google.com/spreadsheets/d/${targetId}/edit`,
        servicesCount: feed.length,
        historyCount: historyList.length,
        syncedAt: new Date().toISOString()
      };
    } catch (e) {
      console.warn('Fallo en sincronización REST directa, intentando con CLI local...', e.message);
    }
  }

  // Fallback: Ejecución mediante CLI local si está en entorno de desarrollo
  try {
    execSync(`gsheets mutate batch ${targetId} -f "${tempBatchFile}"`, { stdio: 'pipe' });
    fs.unlinkSync(tempBatchFile);
    return {
      success: true,
      mode: 'local-cli',
      spreadsheetId: targetId,
      url: `https://docs.google.com/spreadsheets/d/${targetId}/edit`,
      servicesCount: feed.length,
      historyCount: historyList.length,
      syncedAt: new Date().toISOString()
    };
  } catch (err) {
    if (fs.existsSync(tempBatchFile)) fs.unlinkSync(tempBatchFile);
    throw new Error(`Error sincronizando con Google Sheets: ${err.message}`);
  }
}

/**
 * Lee datos desde Google Sheets para importar clientes
 */
function importFromGoogleSheets(spreadsheetId = null) {
  const targetId = spreadsheetId || getSpreadsheetId();
  try {
    const rawOutput = execSync(`gsheets readonly read ${targetId} "Suscripciones!A2:J100" --json`, { encoding: 'utf8' });
    const parsed = JSON.parse(rawOutput);

    let importedCount = 0;
    const rows = parsed.values || parsed || [];

    for (const r of rows) {
      if (!r || r.length < 4) continue;
      const clientName = (r[1] || '').trim();
      let phone = (r[2] || '').trim().replace(/^'/, '');
      const serviceName = (r[3] || '').trim();
      const amount = parseFloat(r[7]) || 45.00;

      if (!clientName || !phone) continue;

      // Verificar si ya existe por teléfono
      const existing = db.findDuplicatesByPhone(phone);
      if (existing.length === 0) {
        db.createClient({
          fullName: clientName,
          phone,
          countryCode: '+51',
          notes: r[9] || 'Importado desde Google Sheets',
          initialService: serviceName ? {
            name: serviceName,
            startDate: dateUtils.getLimaTodayString(),
            expiryDate: dateUtils.addCalendarMonths(dateUtils.getLimaTodayString(), 1),
            amount,
            currency: 'PEN',
            paymentDate: dateUtils.getLimaTodayString(),
            paymentMethod: 'Yape',
            notes: ''
          } : null
        });
        importedCount++;
      }
    }

    return {
      success: true,
      importedCount,
      spreadsheetId: targetId
    };
  } catch (err) {
    throw new Error(`Error importando desde Google Sheets: ${err.message}`);
  }
}

if (require.main === module) {
  const cmd = process.argv[2] || 'sync';
  if (cmd === 'sync') {
    const res = syncToGoogleSheets();
    console.log('Sincronización exitosa:', res);
  } else if (cmd === 'import') {
    const res = importFromGoogleSheets();
    console.log('Importación exitosa:', res);
  }
}

module.exports = {
  getSpreadsheetId,
  setSpreadsheetId,
  syncToGoogleSheets,
  importFromGoogleSheets
};

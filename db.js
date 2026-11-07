/**
 * DarkMan - Capa de Base de Datos SQLite Nativa
 * 
 * Utiliza node:sqlite con DatabaseSync integrado en Node.js v24.
 * Almacena datos persistentes en SQLite con soporte para transacciones,
 * claves foráneas, auditoría de fechas e historial de renovaciones.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const dateUtils = require('./date-utils');

let dbInstance = null;

function getDb(customPath = null) {
  if (dbInstance) return dbInstance;

  const dbFilePath = customPath || path.join(__dirname, 'darkman.db');
  dbInstance = new DatabaseSync(dbFilePath);

  // Activamos claves foráneas y modo WAL para máximo rendimiento y seguridad
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  dbInstance.exec('PRAGMA journal_mode = WAL;');

  initSchema(dbInstance);
  return dbInstance;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      country_code TEXT NOT NULL DEFAULT '+51',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0.00,
      currency TEXT NOT NULL DEFAULT 'PEN',
      payment_date TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_services_client_id ON services(client_id);
    CREATE INDEX IF NOT EXISTS idx_services_expiry_date ON services(expiry_date);

    CREATE TABLE IF NOT EXISTS payment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'PEN',
      payment_date TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'Yape',
      notes TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'RENOVACION',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payment_history_service_id ON payment_history(service_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Registra o actualiza una configuración de la aplicación
 */
function setAppSetting(key, value) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(key, JSON.stringify(value), now);
}

function getAppSetting(key, defaultValue = null) {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const row = stmt.get(key);
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    return row.value;
  }
}

/**
 * Busca si un número de teléfono ya está registrado por otro cliente
 */
function findDuplicatesByPhone(phone, excludeClientId = null) {
  const db = getDb();
  const cleanPhone = phone.toString().replace(/\D/g, '');
  if (!cleanPhone) return [];

  const stmt = db.prepare('SELECT id, full_name, phone, country_code FROM clients');
  const allClients = stmt.all();

  return allClients.filter(c => {
    if (excludeClientId && c.id === Number(excludeClientId)) return false;
    const cClean = c.phone.replace(/\D/g, '');
    return cClean.endsWith(cleanPhone) || cleanPhone.endsWith(cClean);
  });
}

/**
 * Crea un cliente y opcionalmente su servicio inicial
 */
function createClient(data) {
  const db = getDb();
  const now = new Date().toISOString();

  const fullName = (data.fullName || '').trim();
  const phone = (data.phone || '').trim();
  const countryCode = (data.countryCode || '+51').trim();
  const notes = (data.notes || '').trim();

  if (!fullName) {
    throw new Error('El nombre completo del cliente es obligatorio.');
  }
  if (!phone) {
    throw new Error('El número de celular es obligatorio.');
  }

  // Comprobar posible duplicado
  const duplicates = findDuplicatesByPhone(phone);
  let duplicateWarning = null;
  if (duplicates.length > 0) {
    duplicateWarning = `Atención: El número ${phone} ya está registrado para el cliente "${duplicates[0].full_name}".`;
  }

  const insertClientStmt = db.prepare(`
    INSERT INTO clients (full_name, phone, country_code, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const clientRes = insertClientStmt.run(fullName, phone, countryCode, notes, now, now);
  const clientId = Number(clientRes.lastInsertRowid);

  let initialService = null;
  if (data.initialService && data.initialService.name) {
    const s = data.initialService;
    const serviceName = (s.name || '').trim();
    const startDate = s.startDate || dateUtils.getLimaTodayString();
    const expiryDate = s.expiryDate || dateUtils.addCalendarMonths(startDate, 1);
    const amount = parseFloat(s.amount) || 0;
    const currency = s.currency || 'PEN';
    const paymentDate = s.paymentDate || startDate;
    const paymentMethod = s.paymentMethod || 'Yape';
    const serviceNotes = (s.notes || '').trim();

    if (amount < 0) {
      throw new Error('El monto no puede ser negativo.');
    }

    if (expiryDate < startDate) {
      throw new Error('La fecha de vencimiento no puede ser anterior a la fecha de inicio.');
    }

    const insertServiceStmt = db.prepare(`
      INSERT INTO services (client_id, name, start_date, expiry_date, amount, currency, payment_date, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const serviceRes = insertServiceStmt.run(
      clientId, serviceName, startDate, expiryDate, amount, currency, paymentDate, serviceNotes, now, now
    );
    const serviceId = Number(serviceRes.lastInsertRowid);

    // Registro de primer pago / alta en historial
    const insertHistoryStmt = db.prepare(`
      INSERT INTO payment_history (service_id, client_id, start_date, expiry_date, amount, currency, payment_date, payment_method, notes, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ALTA', ?)
    `);

    insertHistoryStmt.run(
      serviceId, clientId, startDate, expiryDate, amount, currency, paymentDate, paymentMethod, serviceNotes, now
    );

    initialService = {
      id: serviceId,
      name: serviceName,
      startDate,
      expiryDate,
      amount,
      currency,
      paymentDate,
      paymentMethod,
      notes: serviceNotes
    };
  }

  const client = getClientById(clientId);
  return {
    client,
    duplicateWarning
  };
}

/**
 * Actualiza los datos de un cliente
 */
function updateClient(id, data) {
  const db = getDb();
  const now = new Date().toISOString();
  const clientId = Number(id);

  const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!existing) {
    throw new Error(`Cliente con ID ${id} no encontrado.`);
  }

  const fullName = (data.fullName || '').trim();
  const phone = (data.phone || '').trim();
  const countryCode = (data.countryCode || '+51').trim();
  const notes = (data.notes || '').trim();

  if (!fullName) throw new Error('El nombre completo es obligatorio.');
  if (!phone) throw new Error('El celular es obligatorio.');

  const duplicates = findDuplicatesByPhone(phone, clientId);
  let duplicateWarning = null;
  if (duplicates.length > 0) {
    duplicateWarning = `Atención: El número ${phone} ya está registrado para otro cliente: "${duplicates[0].full_name}".`;
  }

  const updateStmt = db.prepare(`
    UPDATE clients
    SET full_name = ?, phone = ?, country_code = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `);
  updateStmt.run(fullName, phone, countryCode, notes, now, clientId);

  const client = getClientById(clientId);
  return { client, duplicateWarning };
}

/**
 * Elimina un cliente y todos sus servicios y pagos asociados
 */
function deleteClient(id) {
  const db = getDb();
  const clientId = Number(id);
  const stmt = db.prepare('DELETE FROM clients WHERE id = ?');
  const res = stmt.run(clientId);
  return { deleted: res.changes > 0, id: clientId };
}

/**
 * Obtiene el detalle completo de un cliente con sus servicios e historial
 */
function getClientById(id) {
  const db = getDb();
  const clientId = Number(id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return null;

  const services = db.prepare(`
    SELECT * FROM services WHERE client_id = ? ORDER BY id ASC
  `).all(clientId);

  const servicesWithStatus = services.map(s => {
    const status = dateUtils.evaluateStatus(s.expiry_date);
    const history = db.prepare(`
      SELECT * FROM payment_history WHERE service_id = ? ORDER BY payment_date DESC, id DESC
    `).all(s.id);

    return {
      id: s.id,
      clientId: s.client_id,
      name: s.name,
      startDate: s.start_date,
      expiryDate: s.expiry_date,
      startDateDisplay: dateUtils.formatDateToDisplay(s.start_date),
      expiryDateDisplay: dateUtils.formatDateToDisplay(s.expiry_date),
      startDateLong: dateUtils.formatDateToLong(s.start_date),
      expiryDateLong: dateUtils.formatDateToLong(s.expiry_date),
      amount: s.amount,
      currency: s.currency,
      paymentDate: s.payment_date,
      paymentDateDisplay: dateUtils.formatDateToDisplay(s.payment_date),
      notes: s.notes,
      status,
      history: history.map(h => ({
        id: h.id,
        startDate: h.start_date,
        expiryDate: h.expiry_date,
        startDateDisplay: dateUtils.formatDateToDisplay(h.start_date),
        expiryDateDisplay: dateUtils.formatDateToDisplay(h.expiry_date),
        amount: h.amount,
        currency: h.currency,
        paymentDate: h.payment_date,
        paymentDateDisplay: dateUtils.formatDateToDisplay(h.payment_date),
        paymentMethod: h.payment_method,
        notes: h.notes,
        type: h.type
      }))
    };
  });

  return {
    id: client.id,
    fullName: client.full_name,
    phone: client.phone,
    countryCode: client.country_code,
    fullPhone: `${client.country_code} ${client.phone}`.trim(),
    cleanPhone: dateUtils.sanitizePhoneNumber(client.phone, client.country_code),
    notes: client.notes,
    createdAt: client.created_at,
    updatedAt: client.updated_at,
    services: servicesWithStatus
  };
}

/**
 * Agrega un nuevo servicio a un cliente existente
 */
function addServiceToClient(clientId, data) {
  const db = getDb();
  const cId = Number(clientId);
  const now = new Date().toISOString();

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(cId);
  if (!client) throw new Error('Cliente no encontrado.');

  const name = (data.name || '').trim();
  const startDate = data.startDate || dateUtils.getLimaTodayString();
  const expiryDate = data.expiryDate || dateUtils.addCalendarMonths(startDate, 1);
  const amount = parseFloat(data.amount) || 0;
  const currency = data.currency || 'PEN';
  const paymentDate = data.paymentDate || startDate;
  const paymentMethod = data.paymentMethod || 'Yape';
  const notes = (data.notes || '').trim();

  if (!name) throw new Error('El nombre del servicio es obligatorio.');
  if (amount < 0) throw new Error('El monto no puede ser negativo.');
  if (expiryDate < startDate) throw new Error('La fecha de vencimiento no puede ser menor a la fecha de inicio.');

  const insertStmt = db.prepare(`
    INSERT INTO services (client_id, name, start_date, expiry_date, amount, currency, payment_date, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = insertStmt.run(cId, name, startDate, expiryDate, amount, currency, paymentDate, notes, now, now);
  const serviceId = Number(res.lastInsertRowid);

  // Historial de alta
  db.prepare(`
    INSERT INTO payment_history (service_id, client_id, start_date, expiry_date, amount, currency, payment_date, payment_method, notes, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ALTA', ?)
  `).run(serviceId, cId, startDate, expiryDate, amount, currency, paymentDate, paymentMethod, notes, now);

  return getClientById(cId);
}

/**
 * Actualiza un servicio existente
 */
function updateService(serviceId, data) {
  const db = getDb();
  const sId = Number(serviceId);
  const now = new Date().toISOString();

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(sId);
  if (!service) throw new Error('Servicio no encontrado.');

  const name = (data.name || service.name).trim();
  const startDate = data.startDate || service.start_date;
  const expiryDate = data.expiryDate || service.expiry_date;
  const amount = data.amount !== undefined ? parseFloat(data.amount) : service.amount;
  const currency = data.currency || service.currency || 'PEN';
  const paymentDate = data.paymentDate || service.payment_date;
  const notes = data.notes !== undefined ? data.notes.trim() : service.notes;

  if (!name) throw new Error('El nombre del servicio es obligatorio.');
  if (amount < 0) throw new Error('El monto no puede ser negativo.');
  if (expiryDate < startDate) throw new Error('La fecha de vencimiento no puede ser menor a la de inicio.');

  db.prepare(`
    UPDATE services
    SET name = ?, start_date = ?, expiry_date = ?, amount = ?, currency = ?, payment_date = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(name, startDate, expiryDate, amount, currency, paymentDate, notes, now, sId);

  return getClientById(service.client_id);
}

/**
 * Elimina un servicio
 */
function deleteService(serviceId) {
  const db = getDb();
  const sId = Number(serviceId);
  const service = db.prepare('SELECT client_id FROM services WHERE id = ?').get(sId);
  if (!service) return { deleted: false };

  db.prepare('DELETE FROM services WHERE id = ?').run(sId);
  return { deleted: true, clientId: service.client_id };
}

/**
 * Renueva una mensualidad:
 * 1. Registra el pago en payment_history
 * 2. Conserva el historial anterior intacto
 * 3. Actualiza el servicio con el nuevo período y monto
 * 4. Recalcula el estado
 */
function renewService(serviceId, renewalData) {
  const db = getDb();
  const sId = Number(serviceId);
  const now = new Date().toISOString();

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(sId);
  if (!service) throw new Error('Servicio no encontrado para renovación.');

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(service.client_id);
  if (!client) throw new Error('Cliente no encontrado.');

  const newStartDate = renewalData.newStartDate || service.expiry_date;
  const newExpiryDate = renewalData.newExpiryDate || dateUtils.addCalendarMonths(newStartDate, 1);
  const amount = parseFloat(renewalData.amount !== undefined ? renewalData.amount : service.amount);
  const currency = renewalData.currency || service.currency || 'PEN';
  const paymentDate = renewalData.paymentDate || dateUtils.getLimaTodayString();
  const paymentMethod = renewalData.paymentMethod || 'Yape';
  const notes = (renewalData.notes || '').trim();

  if (amount < 0) throw new Error('El monto de renovación no puede ser negativo.');
  if (newExpiryDate < newStartDate) throw new Error('La nueva fecha de vencimiento no puede ser menor a la nueva fecha de inicio.');

  // Transacción atómica
  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Guardar en historial
    const insertHistoryStmt = db.prepare(`
      INSERT INTO payment_history (service_id, client_id, start_date, expiry_date, amount, currency, payment_date, payment_method, notes, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RENOVACION', ?)
    `);
    insertHistoryStmt.run(
      sId, service.client_id, newStartDate, newExpiryDate, amount, currency, paymentDate, paymentMethod, notes, now
    );

    // 2. Actualizar fechas actuales del servicio
    const updateServiceStmt = db.prepare(`
      UPDATE services
      SET start_date = ?, expiry_date = ?, amount = ?, currency = ?, payment_date = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `);
    updateServiceStmt.run(newStartDate, newExpiryDate, amount, currency, paymentDate, notes || service.notes, now, sId);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getClientById(service.client_id);
}

/**
 * Obtiene el Feed Completo de Servicios Ordenado Automáticamente por Urgencia de Vencimiento
 * 
 * Reglas de orden:
 * 1. Vencidos, comenzando por los de mayor atraso (urgencySortKey más negativo: -10, -5, -2, -1)
 * 2. Servicios que vencen hoy (urgencySortKey: 0)
 * 3. Servicios próximos a vencer (urgencySortKey: 1, 2, 3)
 * 4. Servicios con más días disponibles (urgencySortKey: 4, 5, 10, 30...)
 */
function getAllServicesFeed(filters = {}) {
  const db = getDb();
  const todayLima = dateUtils.getLimaTodayString();

  const rows = db.prepare(`
    SELECT 
      s.id AS service_id,
      s.client_id,
      s.name AS service_name,
      s.start_date,
      s.expiry_date,
      s.amount,
      s.currency,
      s.payment_date,
      s.notes AS service_notes,
      c.full_name AS client_name,
      c.phone AS client_phone,
      c.country_code AS client_country_code,
      c.notes AS client_notes
    FROM services s
    JOIN clients c ON s.client_id = c.id
  `).all();

  const feed = rows.map(r => {
    const status = dateUtils.evaluateStatus(r.expiry_date, todayLima);
    const cleanPhone = dateUtils.sanitizePhoneNumber(r.client_phone, r.client_country_code);

    return {
      serviceId: r.service_id,
      clientId: r.client_id,
      clientName: r.client_name,
      clientPhone: r.client_phone,
      clientCountryCode: r.client_country_code,
      clientFullPhone: `${r.client_country_code} ${r.client_phone}`.trim(),
      cleanPhone,
      serviceName: r.service_name,
      startDate: r.start_date,
      expiryDate: r.expiry_date,
      startDateDisplay: dateUtils.formatDateToDisplay(r.start_date),
      expiryDateDisplay: dateUtils.formatDateToDisplay(r.expiry_date),
      amount: r.amount,
      currency: r.currency,
      paymentDate: r.payment_date,
      paymentDateDisplay: dateUtils.formatDateToDisplay(r.payment_date),
      serviceNotes: r.service_notes,
      clientNotes: r.client_notes,
      status
    };
  });

  // Orden automático por urgencia (ascendente de urgencySortKey):
  feed.sort((a, b) => a.status.urgencySortKey - b.status.urgencySortKey);

  // Aplicar filtros opcionales
  let filtered = feed;

  if (filters.search) {
    const q = filters.search.toLowerCase().trim();
    filtered = filtered.filter(item => 
      item.clientName.toLowerCase().includes(q) ||
      item.clientPhone.includes(q) ||
      item.serviceName.toLowerCase().includes(q)
    );
  }

  if (filters.status && filters.status !== 'TODOS') {
    filtered = filtered.filter(item => item.status.code === filters.status);
  }

  if (filters.service && filters.service !== 'TODOS') {
    filtered = filtered.filter(item => item.serviceName === filters.service);
  }

  return filtered;
}

/**
 * Obtiene métricas y contadores calculados en tiempo real
 */
function getSystemStats() {
  const db = getDb();
  const totalClients = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
  const allServices = getAllServicesFeed();

  let activeCount = 0;    // VIGENTE (> 3 días)
  let imminentCount = 0;  // POR_VENCER (0 a 3 días)
  let overdueCount = 0;   // VENCIDO (< 0 días)
  let totalRevenue = 0;

  for (const item of allServices) {
    totalRevenue += item.amount;
    if (item.status.code === 'VIGENTE') activeCount++;
    else if (item.status.code === 'POR_VENCER') imminentCount++;
    else if (item.status.code === 'VENCIDO') overdueCount++;
  }

  const isDemo = getAppSetting('is_demo_mode', false);

  return {
    totalClients,
    totalServices: allServices.length,
    activeCount,
    imminentCount,
    overdueCount,
    totalRevenue,
    isDemoMode: isDemo,
    todayLima: dateUtils.getLimaTodayString()
  };
}

/**
 * Carga datos de prueba completos que cubren todos los casos requeridos
 */
function seedDemoData() {
  const db = getDb();
  clearAllData();

  const todayLima = dateUtils.getLimaTodayString();
  const [y, m, d] = todayLima.split('-').map(Number);

  // Helper para generar fechas relativas a hoy en Lima:
  function getRelativeDate(dayOffset) {
    const dateObj = new Date(Date.UTC(y, m - 1, d + dayOffset, 12, 0, 0));
    const ry = dateObj.getUTCFullYear();
    const rm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const rd = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${ry}-${rm}-${rd}`;
  }

  // 1. Caso: Vence en 5 días (Vigente, verde)
  createClient({
    fullName: 'Carlos Mendoza Valdivia',
    phone: '987654321',
    countryCode: '+51',
    notes: 'Cliente preferencial. Solicita confirmación por WhatsApp.',
    initialService: {
      name: 'Plan Premium IPTV 4K',
      startDate: getRelativeDate(-25),
      expiryDate: getRelativeDate(5), // +5 días (Vigente)
      amount: 45.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-25),
      paymentMethod: 'Yape',
      notes: '2 conexiones simultáneas activas.'
    }
  });

  // 2. Caso: Vence en 3 días (Por vencer, ámbar)
  createClient({
    fullName: 'Mariana Quispe Alarcón',
    phone: '912345678',
    countryCode: '+51',
    notes: 'Paga puntual por transferencia BCP.',
    initialService: {
      name: 'Streaming Familiar Full HD',
      startDate: getRelativeDate(-27),
      expiryDate: getRelativeDate(3), // +3 días (Por vencer)
      amount: 35.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-27),
      paymentMethod: 'BCP',
      notes: 'Cuenta compartida hogar.'
    }
  });

  // 3. Caso: Vence en 1 día (Vence mañana, ámbar)
  createClient({
    fullName: 'Jorge Luis Barrientos',
    phone: '998877665',
    countryCode: '+51',
    notes: 'Recordar preferentemente por las tardes.',
    initialService: {
      name: 'Plan Dúo Fibra Óptica 100 Mbps',
      startDate: getRelativeDate(-29),
      expiryDate: getRelativeDate(1), // +1 día (Vence mañana)
      amount: 80.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-29),
      paymentMethod: 'Plin',
      notes: 'Módem con IP estática.'
    }
  });

  // 4. Caso: Vence HOY (Vence hoy, 0 días, ámbar)
  createClient({
    fullName: 'Lucía Fernández Paredes',
    phone: '976543210',
    countryCode: '+51',
    notes: 'Vence el día de hoy. Contactar para renovación inmediata.',
    initialService: {
      name: 'Plan Premium IPTV 4K',
      startDate: getRelativeDate(-30),
      expiryDate: getRelativeDate(0), // 0 días (Vence hoy)
      amount: 45.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-30),
      paymentMethod: 'Yape',
      notes: 'Requiere soporte para Smart TV Samsung.'
    }
  });

  // 5. Caso: Vencido hace 2 días (Vencido, rojo)
  createClient({
    fullName: 'Rodrigo Salazar Gómez',
    phone: '945678123',
    countryCode: '+51',
    notes: 'Señal en suspensión preventiva hasta registrar pago.',
    initialService: {
      name: 'Servidor VPS Cloud 4GB',
      startDate: getRelativeDate(-32),
      expiryDate: getRelativeDate(-2), // -2 días (Vencido)
      amount: 60.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-32),
      paymentMethod: 'Transferencia BCP',
      notes: 'Respaldo automático activado.'
    }
  });

  // 6. Caso: Vencido hace 10 días (Mayor atraso, aparece primero en la lista, rojo)
  createClient({
    fullName: 'Ernesto Chumpitaz Ramos',
    phone: '954321987',
    countryCode: '+51',
    notes: 'Atrasado considerablemente. Enviar mensaje de reactivación.',
    initialService: {
      name: 'Streaming Familiar Full HD',
      startDate: getRelativeDate(-40),
      expiryDate: getRelativeDate(-10), // -10 días (Vencido)
      amount: 35.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-40),
      paymentMethod: 'Efectivo',
      notes: 'Perfil personal.'
    }
  });

  // 7. Caso: Cliente con múltiples servicios (Demuestra soporte multi-servicio por cliente)
  const multiClientRes = createClient({
    fullName: 'Valeria Castro Montenegro',
    phone: '965432189',
    countryCode: '+51',
    notes: 'Contrata múltiples servicios para negocio familiar.',
    initialService: {
      name: 'Plan Premium IPTV 4K',
      startDate: getRelativeDate(-15),
      expiryDate: getRelativeDate(15), // +15 días (Vigente)
      amount: 45.00,
      currency: 'PEN',
      paymentDate: getRelativeDate(-15),
      paymentMethod: 'Yape',
      notes: 'Pantalla principal de recepción.'
    }
  });

  // Agregamos un segundo servicio a Valeria:
  addServiceToClient(multiClientRes.client.id, {
    name: 'Hosting Web Corporativo & SSL',
    startDate: getRelativeDate(-28),
    expiryDate: getRelativeDate(2), // +2 días (Por vencer)
    amount: 55.00,
    currency: 'PEN',
    paymentDate: getRelativeDate(-28),
    paymentMethod: 'Plin',
    notes: 'Sitio corporativo.'
  });

  // Agregamos pagos históricos a Carlos Mendoza para emular historial del diseño de Stitch
  const carlos = findDuplicatesByPhone('987654321')[0];
  if (carlos) {
    const sCarlos = db.prepare('SELECT id FROM services WHERE client_id = ?').get(carlos.id);
    if (sCarlos) {
      // Período anterior 1
      db.prepare(`
        INSERT INTO payment_history (service_id, client_id, start_date, expiry_date, amount, currency, payment_date, payment_method, notes, type, created_at)
        VALUES (?, ?, ?, ?, 45.00, 'PEN', ?, 'Yape', 'Renovación mensual regular', 'RENOVACION', ?)
      `).run(sCarlos.id, carlos.id, getRelativeDate(-55), getRelativeDate(-25), getRelativeDate(-55), new Date().toISOString());

      // Período anterior 2
      db.prepare(`
        INSERT INTO payment_history (service_id, client_id, start_date, expiry_date, amount, currency, payment_date, payment_method, notes, type, created_at)
        VALUES (?, ?, ?, ?, 45.00, 'PEN', ?, 'BCP', 'Renovación mensual regular', 'RENOVACION', ?)
      `).run(sCarlos.id, carlos.id, getRelativeDate(-85), getRelativeDate(-55), getRelativeDate(-85), new Date().toISOString());
    }
  }

  setAppSetting('is_demo_mode', true);
  return getSystemStats();
}

/**
 * Limpia completamente la base de datos (para producción)
 */
function clearAllData() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DELETE FROM payment_history;');
  db.exec('DELETE FROM services;');
  db.exec('DELETE FROM clients;');
  db.exec('DELETE FROM sqlite_sequence;');
  db.exec('PRAGMA foreign_keys = ON;');
  setAppSetting('is_demo_mode', false);
  return { cleared: true };
}

module.exports = {
  getDb,
  createClient,
  updateClient,
  deleteClient,
  getClientById,
  findDuplicatesByPhone,
  addServiceToClient,
  updateService,
  deleteService,
  renewService,
  getAllServicesFeed,
  getSystemStats,
  seedDemoData,
  clearAllData,
  setAppSetting,
  getAppSetting
};

/**
 * DarkMan - Utilidades de Fecha y Zona Horaria (America/Lima)
 * 
 * Reglas de negocio:
 * - Zona horaria obligatoria: America/Lima (UTC-5)
 * - Fechas estrictamente por componentes de calendario sin desfases por horas o UTC
 * - Vigente: faltan más de 3 días
 * - Por vencer: faltan entre 0 y 3 días (0 = Vence hoy, 1 = Vence mañana)
 * - Vencido: la fecha de vencimiento ya pasó (días restantes < 0)
 * - Cálculo de renovación por mes calendario respetando fin de mes y años bisiestos
 */

const LIMA_TIMEZONE = 'America/Lima';

/**
 * Obtiene la fecha actual en la zona horaria America/Lima en formato YYYY-MM-DD
 */
function getLimaTodayString(customDate = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: LIMA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(customDate);
}

/**
 * Valida si un string cumple el formato YYYY-MM-DD y es una fecha de calendario real
 */
function isValidDateString(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);

  if (m < 1 || m > 12) return false;
  if (d < 1) return false;

  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/**
 * Formatea una fecha YYYY-MM-DD a formato amigable en español DD/MM/AAAA
 */
function formatDateToDisplay(dateStr) {
  if (!isValidDateString(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Formatea una fecha YYYY-MM-DD a formato largo (ej: 24 May 2024)
 */
function formatDateToLong(dateStr) {
  if (!isValidDateString(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];
  return `${d} ${meses[m - 1]} ${y}`;
}

/**
 * Calcula la diferencia en días de calendario enteros entre una fecha y hoy (o baseDateStr)
 * Retorna:
 * > 0: días futuros restantes
 *   0: vence hoy
 * < 0: días de atraso (vencido)
 */
function calculateDaysDifference(expiryDateStr, baseDateStr = null) {
  if (!isValidDateString(expiryDateStr)) {
    throw new Error(`Fecha de vencimiento inválida: ${expiryDateStr}`);
  }

  const todayStr = baseDateStr && isValidDateString(baseDateStr) 
    ? baseDateStr 
    : getLimaTodayString();

  const [yE, mE, dE] = expiryDateStr.split('-').map(Number);
  const [yT, mT, dT] = todayStr.split('-').map(Number);

  // Usamos Date.UTC con horas fijas para evitar cualquier alteración por huso horario del host
  const utcExpiry = Date.UTC(yE, mE - 1, dE, 12, 0, 0);
  const utcToday = Date.UTC(yT, mT - 1, dT, 12, 0, 0);

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((utcExpiry - utcToday) / msPerDay);
}

/**
 * Evalúa el estado de vencimiento del servicio
 */
function evaluateStatus(expiryDateStr, baseDateStr = null) {
  const days = calculateDaysDifference(expiryDateStr, baseDateStr);

  if (days < 0) {
    const overdueDays = Math.abs(days);
    const badgeText = overdueDays === 1 
      ? 'Vencido hace 1 día' 
      : `Vencido hace ${overdueDays} días`;

    return {
      code: 'VENCIDO',
      label: 'Vencido',
      daysRemaining: days,
      overdueDays,
      badgeText,
      badgeDetail: badgeText,
      color: '#EF4444',
      bgClass: 'bg-error-container/20 text-error border-error/30',
      statusClass: 'status-vencido',
      icon: 'error',
      urgencySortKey: days // Números negativos más pequeños (-10 antes de -1)
    };
  }

  if (days >= 0 && days <= 3) {
    let badgeText = '';
    if (days === 0) badgeText = 'Vence hoy';
    else if (days === 1) badgeText = 'Vence mañana';
    else badgeText = `Faltan ${days} días`;

    return {
      code: 'POR_VENCER',
      label: 'Por vencer',
      daysRemaining: days,
      overdueDays: 0,
      badgeText,
      badgeDetail: badgeText,
      color: '#F59E0B',
      bgClass: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
      statusClass: 'status-por-vencer',
      icon: days === 0 ? 'notification_important' : 'alarm',
      urgencySortKey: days // 0, 1, 2, 3
    };
  }

  // days > 3
  return {
    code: 'VIGENTE',
    label: 'Vigente',
    daysRemaining: days,
    overdueDays: 0,
    badgeText: `Faltan ${days} días`,
    badgeDetail: `Faltan ${days} días`,
    color: '#10B981',
    bgClass: 'bg-tertiary-container/20 text-tertiary border-tertiary/30',
    statusClass: 'status-vigente',
    icon: 'check_circle',
    urgencySortKey: days // 4, 5, 6...
  };
}

/**
 * Suma meses calendario a una fecha en formato YYYY-MM-DD
 * Si el día no existe en el mes destino (ej: 31 de Enero + 1 mes = 28 o 29 de Febrero),
 * se ajusta automáticamente al último día válido de dicho mes.
 */
function addCalendarMonths(dateStr, monthsToAdd = 1) {
  if (!isValidDateString(dateStr)) {
    throw new Error(`Fecha inválida: ${dateStr}`);
  }

  const [y, m, d] = dateStr.split('-').map(Number);
  
  let targetYear = y;
  let targetMonth = m + monthsToAdd;

  while (targetMonth > 12) {
    targetYear += 1;
    targetMonth -= 12;
  }
  while (targetMonth < 1) {
    targetYear -= 1;
    targetMonth += 12;
  }

  // Último día del mes de destino (UTC):
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(d, daysInTargetMonth);

  const yStr = String(targetYear).padStart(4, '0');
  const mStr = String(targetMonth).padStart(2, '0');
  const dStr = String(targetDay).padStart(2, '0');

  return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Limpia y normaliza el número de celular a formato internacional solo dígitos
 * Ej: "+51 987 654 321" -> "51987654321"
 * Si no trae código de país y tiene 9 dígitos peruanos, le añade 51
 */
function sanitizePhoneNumber(phone, countryCode = '+51') {
  if (!phone) return '';
  const digitsOnly = phone.toString().replace(/\D/g, '');
  const cleanCode = countryCode.toString().replace(/\D/g, '') || '51';

  if (digitsOnly.startsWith(cleanCode)) {
    return digitsOnly;
  }

  // Si tiene 9 dígitos (formato celular típico de Perú), anteponer código
  if (digitsOnly.length === 9) {
    return `${cleanCode}${digitsOnly}`;
  }

  return digitsOnly;
}

module.exports = {
  LIMA_TIMEZONE,
  getLimaTodayString,
  isValidDateString,
  formatDateToDisplay,
  formatDateToLong,
  calculateDaysDifference,
  evaluateStatus,
  addCalendarMonths,
  sanitizePhoneNumber
};

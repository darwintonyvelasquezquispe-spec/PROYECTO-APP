/**
 * DarkMan - Obsidian Command Application Logic
 * 
 * Cumple estrictamente:
 * 1. Zona horaria obligatoria America/Lima (UTC-5) para todos los cálculos
 * 2. Orden automático por vencimiento (vencidos con mayor atraso primero, hoy, próximos, vigentes)
 * 3. Renovación por mes calendario (+1 mes respetando fin de mes y años bisiestos)
 * 4. Fiel a la identidad visual y componentes de Google Stitch
 * 5. Acciones diferenciadas de WhatsApp (Recordatorio y Promoción/Aviso)
 */

const app = (function () {
  'use strict';

  // Estado global de la aplicación
  const state = {
    currentView: 'dashboard',
    previousView: 'dashboard',
    todayLima: '',
    stats: {},
    servicesFeed: [],
    clientsList: [],
    currentClientDetail: null,
    filters: {
      search: '',
      status: 'TODOS',
      service: 'TODOS'
    },
    activeWhatsAppContext: {
      phone: '',
      cleanPhone: '',
      clientName: '',
      serviceName: '',
      expiryDateDisplay: '',
      amount: '',
      mode: 'REMINDER', // 'REMINDER' | 'PROMO'
      status: null
    },
    isSubmitting: false,
    deferredPrompt: null,
    authToken: localStorage.getItem('darkman_auth_token') || null,
    authRequired: false,
    isAuthenticated: false
  };

  // ============================================================
  // UTILIDADES DE FECHA Y CALENDARIO (AMERICA/LIMA)
  // ============================================================

  function getLimaTodayString() {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(new Date());
  }

  function formatDisplayDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string' || !dateStr.includes('-')) return dateStr || '';
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
  }

  function formatLongDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string' || !dateStr.includes('-')) return dateStr || '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];
    return `${d} ${meses[m - 1]} ${y}`;
  }

  function calculateDaysDifference(expiryDateStr, baseDateStr = null) {
    const todayStr = baseDateStr || state.todayLima || getLimaTodayString();
    const [yE, mE, dE] = expiryDateStr.split('-').map(Number);
    const [yT, mT, dT] = todayStr.split('-').map(Number);

    const utcExpiry = Date.UTC(yE, mE - 1, dE, 12, 0, 0);
    const utcToday = Date.UTC(yT, mT - 1, dT, 12, 0, 0);
    return Math.round((utcExpiry - utcToday) / (24 * 60 * 60 * 1000));
  }

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
        color: '#EF4444',
        chipClass: 'bg-error-container/20 text-error border border-error/30',
        dotClass: 'bg-error',
        anchorClass: 'card-anchor-vencido',
        icon: 'error',
        urgencySortKey: days // Números negativos más pequeños primero (-10 antes que -1)
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
        color: '#F59E0B',
        chipClass: 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
        dotClass: days === 0 ? 'bg-amber-400 pulse-urgent' : 'bg-amber-400',
        anchorClass: 'card-anchor-por-vencer',
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
      color: '#10B981',
      chipClass: 'bg-tertiary-container/20 text-tertiary border border-tertiary/30',
      dotClass: 'bg-tertiary',
      anchorClass: 'card-anchor-vigente',
      icon: 'check_circle',
      urgencySortKey: days // 4, 5, 10, 30...
    };
  }

  /**
   * Suma meses de calendario exactos respetando fin de mes y años bisiestos
   * Ej: 31 de Enero + 1 mes = 28 o 29 de Febrero
   */
  function addCalendarMonths(dateStr, monthsToAdd = 1) {
    if (!dateStr || !dateStr.includes('-')) return dateStr;
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

    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const targetDay = Math.min(d, daysInTargetMonth);

    const yStr = String(targetYear).padStart(4, '0');
    const mStr = String(targetMonth).padStart(2, '0');
    const dStr = String(targetDay).padStart(2, '0');

    return `${yStr}-${mStr}-${dStr}`;
  }

  function sanitizePhoneNumber(phone, countryCode = '+51') {
    if (!phone) return '';
    const digitsOnly = phone.toString().replace(/\D/g, '');
    const cleanCode = (countryCode || '+51').toString().replace(/\D/g, '') || '51';

    if (digitsOnly.startsWith(cleanCode)) {
      return digitsOnly;
    }
    if (digitsOnly.length === 9) {
      return `${cleanCode}${digitsOnly}`;
    }
    return digitsOnly;
  }

  function formatMoney(amount) {
    const num = parseFloat(amount) || 0;
    return `S/ ${num.toFixed(2)}`;
  }

  // ============================================================
  // LLAMADAS AL SERVIDOR / API
  // ============================================================

  async function apiRequest(url, method = 'GET', body = null) {
    if (!navigator.onLine && method !== 'GET') {
      throw new Error('Sin conexión a internet. No se pueden guardar cambios mientras el dispositivo esté desconectado.');
    }

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (state.authToken) {
      options.headers['Authorization'] = `Bearer ${state.authToken}`;
    }
    if (body) {
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      throw new Error('Error de conexión con el servidor. La operación NO se pudo guardar.');
    }

    if (response.status === 401) {
      openModal('modal-auth');
      throw new Error('Sesión bloqueada o no autorizada. Inicie sesión para continuar.');
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Error en servidor (${response.status})`);
    }

    return data;
  }

  // ============================================================
  // INICIALIZACIÓN Y CICLO DE VIDA
  // ============================================================

  async function init() {
    state.todayLima = getLimaTodayString();
    updateClockDisplay();
    startClockTimer();

    // Registro de PWA Service Worker
    registerServiceWorker();

    // Eventos de Conectividad Online / Offline
    window.addEventListener('online', onNetworkOnline);
    window.addEventListener('offline', onNetworkOffline);
    if (!navigator.onLine) {
      onNetworkOffline();
    }

    // Instalación de PWA
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredPrompt = e;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) installBtn.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
      state.deferredPrompt = null;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) installBtn.classList.add('hidden');
      showToast('¡DarkMan se ha instalado correctamente!', 'success');
    });

    // Actualizar al regresar a la pestaña
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        onDayOrFocusChange();
      }
    });

    window.addEventListener('focus', () => {
      onDayOrFocusChange();
    });

    // Comprobar estado de autenticación de administrador
    await checkAuthStatus();

    // Cargar datos
    await refreshAll();

    // Cerrar menú de datos al hacer click fuera
    document.addEventListener('click', (e) => {
      const btn = document.getElementById('btn-data-menu');
      const menu = document.getElementById('data-menu-dropdown');
      if (menu && !menu.classList.contains('hidden') && !btn.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.add('hidden');
      }
    });
  }

  function onDayOrFocusChange() {
    const currentToday = getLimaTodayString();
    if (currentToday !== state.todayLima) {
      state.todayLima = currentToday;
      showToast('Actualizando cálculos para el nuevo día en Lima...', 'info');
      refreshAll();
    }
  }

  function startClockTimer() {
    setInterval(() => {
      updateClockDisplay();
    }, 1000);
  }

  function updateClockDisplay() {
    const clockEl = document.getElementById('lima-clock');
    const dateEl = document.getElementById('dashboard-date-display');
    const now = new Date();

    const timeFormatter = new Intl.DateTimeFormat('es-PE', {
      timeZone: 'America/Lima',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const dateFormatter = new Intl.DateTimeFormat('es-PE', {
      timeZone: 'America/Lima',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    if (clockEl) clockEl.textContent = timeFormatter.format(now);
    if (dateEl) dateEl.textContent = dateFormatter.format(now);
  }

  async function refreshAll(notify = false) {
    try {
      state.todayLima = getLimaTodayString();

      // Consultar estadísticas y feed en paralelo
      const [statsData, feedData] = await Promise.all([
        apiRequest('/api/stats'),
        apiRequest('/api/services/feed')
      ]);

      state.stats = statsData;
      state.servicesFeed = feedData.services || [];

      // Reevaluar y reordenar por urgencia automáticamente
      state.servicesFeed.forEach(s => {
        s.status = evaluateStatus(s.expiryDate, state.todayLima);
      });
      state.servicesFeed.sort((a, b) => a.status.urgencySortKey - b.status.urgencySortKey);

      updateStatsUI();
      populateServiceFilterOptions();
      renderCurrentView();

      if (notify) {
        showToast('Datos actualizados correctamente.', 'success');
      }
    } catch (err) {
      console.error('Error refrescando aplicación:', err);
      showToast(err.message || 'Error de conexión con el servidor', 'error');
    }
  }

  // ============================================================
  // ACTUALIZACIÓN DE INTERFAZ & KPIS
  // ============================================================

  function updateStatsUI() {
    const s = state.stats;
    const totalClientsEl = document.getElementById('kpi-total-clients');
    const activeEl = document.getElementById('kpi-active-services');
    const imminentEl = document.getElementById('kpi-imminent-services');
    const overdueEl = document.getElementById('kpi-overdue-services');
    const modeBadge = document.getElementById('data-mode-badge');

    if (totalClientsEl) totalClientsEl.textContent = s.totalClients || 0;
    if (activeEl) activeEl.textContent = s.activeCount || 0;
    if (imminentEl) imminentEl.textContent = s.imminentCount || 0;
    if (overdueEl) overdueEl.textContent = s.overdueCount || 0;

    if (modeBadge) {
      modeBadge.textContent = s.isDemoMode ? 'Modo Demo' : 'Modo Real';
    }

    // Banner de alerta operativo en Dashboard
    const alertBanner = document.getElementById('urgent-alert-banner');
    const alertTitle = document.getElementById('urgent-alert-title');
    const alertDesc = document.getElementById('urgent-alert-desc');

    if (alertBanner && alertTitle && alertDesc) {
      if ((s.overdueCount || 0) > 0 || (s.imminentCount || 0) > 0) {
        alertBanner.classList.remove('hidden');
        alertTitle.textContent = `Atención: ${s.overdueCount || 0} vencidos y ${s.imminentCount || 0} por vencer`;
        alertDesc.textContent = 'Envíe recordatorios rápidos por WhatsApp para coordinar los pagos y mantener el servicio.';
      } else {
        alertBanner.classList.add('hidden');
      }
    }
  }

  function populateServiceFilterOptions() {
    const select = document.getElementById('filter-service');
    if (!select) return;

    const currentVal = select.value;
    const serviceNames = Array.from(new Set(state.servicesFeed.map(s => s.serviceName))).sort();

    select.innerHTML = '<option value="TODOS">Todos los servicios</option>';
    serviceNames.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });

    if (serviceNames.includes(currentVal)) {
      select.value = currentVal;
    }
  }

  // ============================================================
  // NAVEGACIÓN ENTRE PANTALLAS
  // ============================================================

  function navigate(viewName, params = {}) {
    state.previousView = state.currentView;
    state.currentView = viewName;

    // Ocultar todas las vistas
    const views = ['dashboard', 'list', 'client-detail', 'clients'];
    views.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.add('hidden');
    });

    // Mostrar vista seleccionada
    const targetEl = document.getElementById(`view-${viewName}`);
    if (targetEl) targetEl.classList.remove('hidden');

    // Actualizar estilos de los botones de navegación
    updateNavButtons(viewName);

    if (viewName === 'client-detail' && params.clientId) {
      loadClientDetail(params.clientId);
    } else {
      renderCurrentView();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateNavButtons(viewName) {
    const navItems = ['dashboard', 'list', 'clients'];
    navItems.forEach(item => {
      const desktopBtn = document.getElementById(`nav-btn-${item}`);
      const mobBtn = document.getElementById(`mob-nav-${item}`);

      if (desktopBtn) {
        if (item === viewName || (viewName === 'client-detail' && item === 'clients')) {
          desktopBtn.className = 'px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-surface-container flex items-center gap-2 transition-all';
          const icon = desktopBtn.querySelector('.material-symbols-outlined');
          if (icon) icon.className = 'material-symbols-outlined text-[18px] text-primary';
        } else {
          desktopBtn.className = 'px-3.5 py-1.5 rounded-lg text-sm font-semibold text-on-surface-variant hover:text-white hover:bg-surface-container/50 flex items-center gap-2 transition-all';
          const icon = desktopBtn.querySelector('.material-symbols-outlined');
          if (icon) icon.className = 'material-symbols-outlined text-[18px]';
        }
      }

      if (mobBtn) {
        if (item === viewName || (viewName === 'client-detail' && item === 'clients')) {
          mobBtn.className = 'flex flex-col items-center gap-0.5 text-xs text-primary font-semibold';
        } else {
          mobBtn.className = 'flex flex-col items-center gap-0.5 text-xs text-on-surface-variant hover:text-white';
        }
      }
    });
  }

  function filterByStatusAndGo(status) {
    state.filters.status = status;
    const select = document.getElementById('filter-status');
    if (select) select.value = status;
    navigate('list');
  }

  function goBackFromDetail() {
    navigate(state.previousView || 'dashboard');
  }

  function renderCurrentView() {
    if (state.currentView === 'dashboard') {
      renderDashboardFeed();
    } else if (state.currentView === 'list') {
      renderListView();
    } else if (state.currentView === 'clients') {
      renderClientsDirectory();
    }
  }

  // ============================================================
  // RENDER PANTALLA 1: DASHBOARD FEED
  // ============================================================

  function renderDashboardFeed() {
    const container = document.getElementById('dashboard-feed-container');
    if (!container) return;

    if (state.servicesFeed.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 px-4 bg-surface-container-low rounded-xl border border-dashed border-outline-variant/40 space-y-3">
          <span class="material-symbols-outlined text-4xl text-on-surface-variant">inbox</span>
          <h3 class="font-headline font-bold text-white text-base">No hay servicios registrados</h3>
          <p class="text-xs text-on-surface-variant max-w-sm mx-auto">
            Comience registrando un cliente y su primer servicio mensual, o cargue los datos de prueba desde el menú superior.
          </p>
          <div class="flex items-center justify-center gap-2 pt-2">
            <button onclick="app.openNewClientModal()" class="px-4 py-2 rounded-xl bg-primary-container text-on-primary-container font-headline font-bold text-xs flex items-center gap-1.5 shadow-md">
              <span class="material-symbols-outlined text-[16px]">person_add</span>
              Registrar Cliente
            </button>
            <button onclick="app.loadDemoData()" class="px-4 py-2 rounded-xl bg-surface-container-high text-white font-headline font-semibold text-xs border border-outline-variant hover:bg-surface-bright">
              Cargar datos de prueba
            </button>
          </div>
        </div>
      `;
      return;
    }

    let html = '';
    state.servicesFeed.forEach(item => {
      const st = item.status;
      const avatarLetters = getInitials(item.clientName);

      html += `
        <div class="bg-surface-container-low rounded-xl p-4 border border-outline-variant/30 hover:border-outline-variant transition-all ${st.anchorClass} shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          <!-- Cliente y Servicio -->
          <div class="flex items-start gap-3.5 min-w-0">
            <div class="w-11 h-11 rounded-xl bg-surface-container-high border border-outline-variant/40 text-primary flex items-center justify-center font-headline font-bold text-sm shrink-0">
              ${avatarLetters}
            </div>

            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <button onclick="app.navigate('client-detail', { clientId: ${item.clientId} })" class="font-headline font-bold text-sm text-white hover:text-primary transition-colors truncate text-left">
                  ${escapeHtml(item.clientName)}
                </button>
                <span class="text-[11px] text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full border border-outline-variant/30">
                  ${escapeHtml(item.clientFullPhone)}
                </span>
              </div>

              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-on-surface-variant">
                <span class="font-semibold text-on-surface flex items-center gap-1">
                  <span class="material-symbols-outlined text-[15px] text-primary">tv</span>
                  ${escapeHtml(item.serviceName)}
                </span>
                <span>•</span>
                <span>Vence: <strong class="text-white">${item.expiryDateDisplay}</strong></span>
                <span>•</span>
                <span class="font-bold text-white">${formatMoney(item.amount)}</span>
              </div>
            </div>
          </div>

          <!-- Estado y Acciones Rápidas -->
          <div class="flex flex-wrap items-center justify-between md:justify-end gap-2.5 pt-2 md:pt-0 border-t md:border-t-0 border-outline-variant/20">
            
            <!-- Chip de Estado -->
            <div class="px-2.5 py-1 rounded-full ${st.chipClass} text-xs font-bold flex items-center gap-1.5 shrink-0">
              <span class="w-2 h-2 rounded-full ${st.dotClass}"></span>
              <span class="material-symbols-outlined text-[15px]">${st.icon}</span>
              <span>${st.badgeText}</span>
            </div>

            <!-- Botones de Acción -->
            <div class="flex items-center gap-1.5 shrink-0">
              <!-- WhatsApp Rápido -->
              <button onclick="app.openWhatsAppReminder(${item.serviceId})" class="p-2 rounded-lg bg-tertiary-container/20 text-tertiary hover:bg-tertiary-container hover:text-on-tertiary border border-tertiary/30 transition-all" title="Enviar recordatorio por WhatsApp">
                <span class="material-symbols-outlined text-[18px]">chat</span>
              </button>

              <!-- Renovar Mensualidad -->
              <button onclick="app.openRenewalModal(${item.serviceId})" class="px-3 py-1.5 rounded-lg bg-primary-container text-on-primary-container font-headline text-xs font-bold flex items-center gap-1 shadow-sm hover:brightness-110 active:scale-95 transition-all">
                <span class="material-symbols-outlined text-[16px]">autorenew</span>
                <span>Renovar</span>
              </button>

              <!-- Detalle -->
              <button onclick="app.navigate('client-detail', { clientId: ${item.clientId} })" class="p-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant hover:text-white transition-colors" title="Ver ficha completa del cliente">
                <span class="material-symbols-outlined text-[18px]">visibility</span>
              </button>
            </div>

          </div>

        </div>
      `;
    });

    container.innerHTML = html;
  }

  // ============================================================
  // RENDER PANTALLA 2: LISTADO RESUMIDO (TABLA Y MÓVIL)
  // ============================================================

  function onFilterChange() {
    const searchInput = document.getElementById('search-input');
    const filterStatus = document.getElementById('filter-status');
    const filterService = document.getElementById('filter-service');
    const clearBtn = document.getElementById('search-clear-btn');

    state.filters.search = searchInput ? searchInput.value.trim() : '';
    state.filters.status = filterStatus ? filterStatus.value : 'TODOS';
    state.filters.service = filterService ? filterService.value : 'TODOS';

    if (clearBtn) {
      if (state.filters.search) clearBtn.classList.remove('hidden');
      else clearBtn.classList.add('hidden');
    }

    renderListView();
  }

  function clearSearch() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    onFilterChange();
  }

  function resetFilters() {
    state.filters = { search: '', status: 'TODOS', service: 'TODOS' };
    const sInput = document.getElementById('search-input');
    const sStatus = document.getElementById('filter-status');
    const sService = document.getElementById('filter-service');
    const clearBtn = document.getElementById('search-clear-btn');

    if (sInput) sInput.value = '';
    if (sStatus) sStatus.value = 'TODOS';
    if (sService) sService.value = 'TODOS';
    if (clearBtn) clearBtn.classList.add('hidden');

    renderListView();
    showToast('Filtros restablecidos.', 'info');
  }

  function getFilteredServices() {
    let list = [...state.servicesFeed];

    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      list = list.filter(item => 
        item.clientName.toLowerCase().includes(q) ||
        item.clientPhone.includes(q) ||
        item.serviceName.toLowerCase().includes(q)
      );
    }

    if (state.filters.status && state.filters.status !== 'TODOS') {
      list = list.filter(item => item.status.code === state.filters.status);
    }

    if (state.filters.service && state.filters.service !== 'TODOS') {
      list = list.filter(item => item.serviceName === state.filters.service);
    }

    // Conservar orden automático por urgencia de vencimiento en todo momento:
    list.sort((a, b) => a.status.urgencySortKey - b.status.urgencySortKey);
    return list;
  }

  function renderListView() {
    const filtered = getFilteredServices();
    const countLabel = document.getElementById('list-counter-label');
    if (countLabel) {
      countLabel.textContent = `${filtered.length} de ${state.servicesFeed.length} servicios ordenados por urgencia`;
    }

    renderDesktopTable(filtered);
    renderMobileCards(filtered);
  }

  function renderDesktopTable(list) {
    const tbody = document.getElementById('table-services-body');
    if (!tbody) return;

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="py-12 text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-3xl mb-1">filter_alt_off</span>
            <p>No se encontraron servicios con los filtros aplicados.</p>
            <button onclick="app.resetFilters()" class="mt-2 text-primary hover:underline text-xs">Limpiar filtros</button>
          </td>
        </tr>
      `;
      return;
    }

    let html = '';
    list.forEach(item => {
      const st = item.status;
      html += `
        <tr class="hover:bg-surface-container-high/40 transition-colors">
          <!-- Cliente -->
          <td class="py-3 px-4 font-headline font-bold text-white">
            <button onclick="app.navigate('client-detail', { clientId: ${item.clientId} })" class="hover:text-primary transition-colors text-left truncate max-w-[180px] block">
              ${escapeHtml(item.clientName)}
            </button>
            <span class="text-[10px] text-on-surface-variant font-normal">ID: CL-${item.clientId}</span>
          </td>

          <!-- Celular -->
          <td class="py-3 px-4 text-on-surface font-headline text-xs tabular-nums whitespace-nowrap">
            <div class="flex items-center gap-1.5">
              <span>${escapeHtml(item.clientFullPhone)}</span>
              <a href="tel:${escapeHtml(item.cleanPhone)}" class="text-primary hover:opacity-80" title="Llamar">
                <span class="material-symbols-outlined text-[15px]">call</span>
              </a>
            </div>
          </td>

          <!-- Servicio -->
          <td class="py-3 px-4 text-on-surface font-medium truncate max-w-[180px]">
            ${escapeHtml(item.serviceName)}
          </td>

          <!-- Inicio -->
          <td class="py-3 px-4 text-on-surface-variant tabular-nums whitespace-nowrap">
            ${item.startDateDisplay}
          </td>

          <!-- Vencimiento -->
          <td class="py-3 px-4 font-bold text-white tabular-nums whitespace-nowrap">
            ${item.expiryDateDisplay}
          </td>

          <!-- Tiempo Restante -->
          <td class="py-3 px-4 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded-full ${st.chipClass} text-xs font-semibold inline-flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full ${st.dotClass}"></span>
              ${st.badgeText}
            </span>
          </td>

          <!-- Monto -->
          <td class="py-3 px-4 text-right font-headline font-bold text-white tabular-nums whitespace-nowrap">
            ${formatMoney(item.amount)}
          </td>

          <!-- Estado -->
          <td class="py-3 px-4 text-center whitespace-nowrap">
            <span class="text-xs font-bold" style="color: ${st.color}">
              ${st.label}
            </span>
          </td>

          <!-- Acciones -->
          <td class="py-3 px-4 text-center whitespace-nowrap">
            <div class="flex items-center justify-center gap-1">
              <button onclick="app.openWhatsAppReminder(${item.serviceId})" class="p-1.5 rounded-lg bg-tertiary-container/20 text-tertiary hover:bg-tertiary-container hover:text-on-tertiary transition-all" title="WhatsApp Recordatorio">
                <span class="material-symbols-outlined text-[17px]">chat</span>
              </button>
              <button onclick="app.openRenewalModal(${item.serviceId})" class="p-1.5 rounded-lg bg-primary-container/20 text-primary hover:bg-primary-container hover:text-on-primary-container transition-all" title="Renovar mensualidad">
                <span class="material-symbols-outlined text-[17px]">autorenew</span>
              </button>
              <button onclick="app.navigate('client-detail', { clientId: ${item.clientId} })" class="p-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface-variant hover:text-white transition-all" title="Ver detalle">
                <span class="material-symbols-outlined text-[17px]">visibility</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  function renderMobileCards(list) {
    const container = document.getElementById('mobile-cards-container');
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `
        <div class="text-center py-10 text-on-surface-variant bg-surface-container rounded-xl p-4 border border-outline-variant/30">
          <p>No se encontraron servicios coincidentes.</p>
        </div>
      `;
      return;
    }

    let html = '';
    list.forEach(item => {
      const st = item.status;
      html += `
        <div class="bg-surface-container rounded-xl p-4 border border-outline-variant/30 ${st.anchorClass} space-y-3 shadow-md">
          <div class="flex items-start justify-between gap-2">
            <div>
              <button onclick="app.navigate('client-detail', { clientId: ${item.clientId} })" class="font-headline font-bold text-sm text-white hover:text-primary transition-colors text-left block">
                ${escapeHtml(item.clientName)}
              </button>
              <span class="text-xs text-on-surface-variant">${escapeHtml(item.clientFullPhone)}</span>
            </div>
            <span class="px-2 py-0.5 rounded-full ${st.chipClass} text-xs font-bold inline-flex items-center gap-1 shrink-0">
              <span class="w-1.5 h-1.5 rounded-full ${st.dotClass}"></span>
              ${st.badgeText}
            </span>
          </div>

          <div class="bg-surface-container-low p-2.5 rounded-lg text-xs space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-on-surface-variant">Servicio:</span>
              <span class="font-semibold text-white truncate max-w-[160px]">${escapeHtml(item.serviceName)}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-on-surface-variant">Vencimiento:</span>
              <span class="font-bold text-white">${item.expiryDateDisplay}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-on-surface-variant">Monto:</span>
              <span class="font-headline font-bold text-primary">${formatMoney(item.amount)}</span>
            </div>
          </div>

          <div class="flex items-center gap-2 pt-1 border-t border-outline-variant/20">
            <button onclick="app.openWhatsAppReminder(${item.serviceId})" class="w-1/2 py-2 px-2 rounded-lg bg-tertiary-container text-on-tertiary font-headline font-semibold text-xs flex items-center justify-center gap-1">
              <span class="material-symbols-outlined text-[16px]">chat</span>
              WhatsApp
            </button>
            <button onclick="app.openRenewalModal(${item.serviceId})" class="w-1/2 py-2 px-2 rounded-lg bg-primary-container text-on-primary-container font-headline font-bold text-xs flex items-center justify-center gap-1">
              <span class="material-symbols-outlined text-[16px]">autorenew</span>
              Renovar
            </button>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // ============================================================
  // RENDER PANTALLA 3: DETALLE DEL CLIENTE (STITCH)
  // ============================================================

  async function loadClientDetail(clientId) {
    try {
      const client = await apiRequest(`/api/clients/${clientId}`);
      state.currentClientDetail = client;
      renderClientDetailView(client);
    } catch (err) {
      showToast('Error cargando cliente: ' + err.message, 'error');
      navigate('dashboard');
    }
  }

  function renderClientDetailView(client) {
    const headerName = document.getElementById('detail-header-name');
    const avatarBox = document.getElementById('detail-avatar-box');
    const clientName = document.getElementById('detail-client-name');
    const clientIdBadge = document.getElementById('detail-client-id');
    const clientPhone = document.getElementById('detail-client-phone');
    const callBtn = document.getElementById('detail-call-btn');
    const clientNotes = document.getElementById('detail-client-notes');
    const statusDot = document.getElementById('detail-status-dot');

    if (headerName) headerName.textContent = client.fullName;
    if (clientName) clientName.textContent = client.fullName;
    if (avatarBox) avatarBox.textContent = getInitials(client.fullName);
    if (clientIdBadge) clientIdBadge.textContent = `ID: CL-${String(client.id).padStart(4, '0')}`;
    if (clientPhone) clientPhone.textContent = client.fullPhone;
    if (callBtn) callBtn.href = `tel:${client.cleanPhone}`;
    if (clientNotes) clientNotes.textContent = client.notes || 'Sin observaciones registradas.';

    // Determinar color del status ring por el servicio más urgente
    let mostUrgentStatus = null;
    if (client.services && client.services.length > 0) {
      client.services.sort((a, b) => a.status.urgencySortKey - b.status.urgencySortKey);
      mostUrgentStatus = client.services[0].status;
    }

    if (statusDot) {
      if (mostUrgentStatus) {
        statusDot.style.backgroundColor = mostUrgentStatus.color;
      } else {
        statusDot.style.backgroundColor = '#10B981';
      }
    }

    // Renderizar lista de servicios del cliente
    renderClientServices(client);
  }

  function renderClientServices(client) {
    const container = document.getElementById('detail-services-list');
    if (!container) return;

    if (!client.services || client.services.length === 0) {
      container.innerHTML = `
        <div class="bg-surface-container rounded-2xl p-6 text-center text-on-surface-variant border border-outline-variant/30 space-y-3">
          <p>Este cliente aún no tiene servicios contratados.</p>
          <button onclick="app.openAddServiceModal()" class="px-4 py-2 rounded-xl bg-primary-container text-on-primary-container text-xs font-bold inline-flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[16px]">add</span>
            Agregar primer servicio
          </button>
        </div>
      `;
      return;
    }

    let html = '';
    client.services.forEach(service => {
      const st = service.status;

      html += `
        <div class="bg-surface-container rounded-2xl p-5 sm:p-6 border border-outline-variant/30 ${st.anchorClass} shadow-lg space-y-4">
          
          <!-- Encabezado de Servicio y Estado -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-primary text-[22px]">tv</span>
                <h4 class="font-headline font-bold text-base sm:text-lg text-white">${escapeHtml(service.name)}</h4>
              </div>
              <span class="text-xs text-on-surface-variant mt-0.5 block">
                Período actual: <strong class="text-white">${service.startDateDisplay}</strong> al <strong class="text-white">${service.expiryDateDisplay}</strong>
              </span>
            </div>

            <!-- Estado Destacado (Fiel a Stitch) -->
            <div class="px-3.5 py-1.5 rounded-xl ${st.chipClass} flex items-center gap-2 self-start sm:self-auto shadow-inner">
              <span class="w-2.5 h-2.5 rounded-full ${st.dotClass}"></span>
              <div>
                <span class="text-[10px] uppercase font-bold tracking-wider block" style="color: ${st.color}">Estado</span>
                <span class="font-headline font-bold text-xs sm:text-sm" style="color: ${st.color}">${st.badgeText}</span>
              </div>
            </div>
          </div>

          <!-- Métricas del Servicio (Tarifa y Fecha límite) -->
          <div class="grid grid-cols-2 gap-3 bg-surface-container-low p-3.5 rounded-xl border border-outline-variant/20">
            <div>
              <span class="text-[10px] uppercase font-semibold text-on-surface-variant block">Tarifa Mensual</span>
              <span class="font-headline font-extrabold text-base sm:text-lg text-white">${formatMoney(service.amount)} <span class="text-xs text-on-surface-variant font-normal">/mes</span></span>
            </div>
            <div>
              <span class="text-[10px] uppercase font-semibold text-on-surface-variant block">Límite de Pago</span>
              <span class="font-headline font-bold text-xs sm:text-sm text-white">${service.expiryDateLong || service.expiryDateDisplay}</span>
            </div>
          </div>

          <!-- Notas del Servicio -->
          ${service.notes ? `
            <div class="text-xs text-on-surface-variant bg-surface-container-low p-2.5 rounded-lg border border-outline-variant/20 flex items-start gap-2">
              <span class="material-symbols-outlined text-[16px] text-secondary shrink-0 mt-0.5">info</span>
              <span>${escapeHtml(service.notes)}</span>
            </div>
          ` : ''}

          <!-- Botones de Acción Operativa (Estilo Stitch) -->
          <div class="flex flex-col gap-2 pt-1">
            <button onclick="app.openRenewalModal(${service.id})" class="w-full py-3 px-4 rounded-xl bg-primary-container text-on-primary-container font-headline font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 hover:brightness-110 active:scale-[0.99] transition-all">
              <span class="material-symbols-outlined text-[20px]">autorenew</span>
              Renovar Mensualidad
            </button>

            <div class="grid grid-cols-2 gap-2">
              <button onclick="app.openWhatsAppReminder(${service.id})" class="py-2.5 px-3 rounded-xl bg-tertiary-container text-on-tertiary font-headline font-semibold text-xs flex items-center justify-center gap-1.5 hover:opacity-90 active:scale-[0.99] transition-all">
                <span class="material-symbols-outlined text-[17px]">notifications_active</span>
                Recordar WhatsApp
              </button>
              <button onclick="app.openWhatsAppPromo(${service.id})" class="py-2.5 px-3 rounded-xl bg-surface-container-high text-white font-headline font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-surface-bright active:scale-[0.99] transition-all">
                <span class="material-symbols-outlined text-[17px]">local_offer</span>
                Enviar Promoción
              </button>
            </div>

            <div class="flex items-center justify-end gap-2 pt-1 text-xs text-on-surface-variant">
              <button onclick="app.confirmDeleteService(${service.id})" class="text-error hover:underline flex items-center gap-1">
                <span class="material-symbols-outlined text-[14px]">delete</span>
                Eliminar servicio
              </button>
            </div>
          </div>

          <!-- Historial de Pagos y Períodos Anteriores (Fiel a Stitch) -->
          <div class="border-t border-outline-variant/30 pt-3 space-y-2.5">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5">
                <span class="material-symbols-outlined text-primary text-[18px]">history</span>
                <span class="font-headline font-bold text-xs sm:text-sm text-white">Historial de Pagos y Renovaciones</span>
              </div>
              <span class="text-[11px] text-on-surface-variant">${service.history ? service.history.length : 0} registros</span>
            </div>

            <!-- Lista de registros anteriores -->
            <div class="space-y-2">
              ${renderPaymentHistoryList(service.history)}
            </div>
          </div>

        </div>
      `;
    });

    container.innerHTML = html;
  }

  function renderPaymentHistoryList(history) {
    if (!history || history.length === 0) {
      return '<p class="text-xs text-on-surface-variant italic">No hay historial de pagos registrado.</p>';
    }

    return history.map(item => {
      let icon = 'payments';
      const m = (item.paymentMethod || '').toLowerCase();
      if (m.includes('yape') || m.includes('plin')) icon = 'qr_code_2';
      else if (m.includes('bcp') || m.includes('transferencia')) icon = 'account_balance';

      const isAlta = item.type === 'ALTA';

      return `
        <div class="bg-surface-container-low rounded-xl p-3 flex flex-col gap-1 border border-outline-variant/20">
          <div class="flex items-center justify-between text-xs">
            <div class="flex items-center gap-1.5">
              <span class="font-headline font-semibold text-white">${item.startDateDisplay} - ${item.expiryDateDisplay}</span>
              ${isAlta ? '<span class="px-1.5 py-0.2 rounded bg-primary-container/20 text-primary text-[10px] font-bold">Alta</span>' : ''}
            </div>
            <span class="px-2 py-0.5 rounded-full bg-tertiary-container/20 text-tertiary text-[10px] font-bold flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-tertiary"></span>
              Completado
            </span>
          </div>

          <div class="flex items-center justify-between text-xs text-on-surface-variant mt-0.5">
            <span class="flex items-center gap-1 text-on-surface font-medium">
              <span class="material-symbols-outlined text-primary text-[15px]">${icon}</span>
              ${escapeHtml(item.paymentMethod)} • <strong class="text-white">${formatMoney(item.amount)}</strong>
            </span>
            <span class="text-[11px]">Pagado: ${item.paymentDateDisplay || item.paymentDate}</span>
          </div>
          ${item.notes ? `<p class="text-[11px] text-on-surface-variant/80 italic mt-0.5">${escapeHtml(item.notes)}</p>` : ''}
        </div>
      `;
    }).join('');
  }

  // ============================================================
  // RENDER PANTALLA 4: DIRECTORIO DE CLIENTES
  // ============================================================

  async function renderClientsDirectory() {
    const grid = document.getElementById('clients-grid');
    if (!grid) return;

    // Obtener lista completa de clientes con estadísticas
    const qInput = document.getElementById('clients-search-input');
    const query = qInput ? qInput.value.toLowerCase().trim() : '';

    const clientsMap = new Map();
    state.servicesFeed.forEach(s => {
      if (!clientsMap.has(s.clientId)) {
        clientsMap.set(s.clientId, {
          id: s.clientId,
          fullName: s.clientName,
          phone: s.clientPhone,
          fullPhone: s.clientFullPhone,
          cleanPhone: s.cleanPhone,
          services: []
        });
      }
      clientsMap.get(s.clientId).services.push(s);
    });

    let clients = Array.from(clientsMap.values());

    if (query) {
      clients = clients.filter(c => 
        c.fullName.toLowerCase().includes(query) ||
        c.phone.includes(query)
      );
    }

    if (clients.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full text-center py-12 text-on-surface-variant bg-surface-container rounded-2xl border border-outline-variant/30">
          <p>No se encontraron clientes.</p>
        </div>
      `;
      return;
    }

    let html = '';
    clients.forEach(c => {
      const avatarLetters = getInitials(c.fullName);
      html += `
        <div class="bg-surface-container rounded-2xl p-5 border border-outline-variant/30 hover:border-primary/50 transition-all shadow-md space-y-3">
          <div class="flex items-start gap-3">
            <div class="w-12 h-12 rounded-xl bg-surface-container-high border border-outline-variant text-primary flex items-center justify-center font-headline font-bold text-base shrink-0">
              ${avatarLetters}
            </div>
            <div class="min-w-0">
              <h3 class="font-headline font-bold text-sm text-white truncate">${escapeHtml(c.fullName)}</h3>
              <span class="text-xs text-on-surface-variant block mt-0.5">${escapeHtml(c.fullPhone)}</span>
              <span class="text-[11px] text-primary/80 font-medium">${c.services.length} servicio(s) activo(s)</span>
            </div>
          </div>

          <div class="flex items-center gap-2 pt-2 border-t border-outline-variant/20">
            <a href="tel:${escapeHtml(c.cleanPhone)}" class="p-2 rounded-lg bg-surface-container-low hover:bg-surface-bright text-primary flex items-center justify-center" title="Llamar">
              <span class="material-symbols-outlined text-[18px]">call</span>
            </a>
            <button onclick="app.navigate('client-detail', { clientId: ${c.id} })" class="w-full py-2 px-3 rounded-lg bg-surface-container-high hover:bg-surface-bright text-white font-headline text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors">
              <span class="material-symbols-outlined text-[16px]">visibility</span>
              Ver Ficha Completa
            </button>
          </div>
        </div>
      `;
    });

    grid.innerHTML = html;
  }

  function onClientsSearch() {
    renderClientsDirectory();
  }

  // ============================================================
  // MODALES & FORMULARIOS
  // ============================================================

  function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.classList.remove('hidden');
      el.classList.add('flex');
    }
  }

  function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('flex');
    }
  }

  // NUEVO CLIENTE / EDITAR CLIENTE
  function openNewClientModal() {
    document.getElementById('client-edit-id').value = '';
    document.getElementById('modal-client-title').textContent = 'Registrar Nuevo Cliente';
    document.getElementById('modal-client-icon').textContent = 'person_add';
    document.getElementById('btn-save-client').innerHTML = '<span class="material-symbols-outlined text-[18px]">check_circle</span> Guardar Cliente';

    document.getElementById('client-name').value = '';
    document.getElementById('client-phone').value = '';
    document.getElementById('client-country-code').value = '+51';
    document.getElementById('client-notes').value = '';

    // Mostrar sección de servicio inicial
    const serviceSection = document.getElementById('initial-service-section');
    if (serviceSection) serviceSection.classList.remove('hidden');

    const todayStr = state.todayLima || getLimaTodayString();
    document.getElementById('service-name').value = 'Plan Premium IPTV 4K';
    document.getElementById('service-start-date').value = todayStr;
    document.getElementById('service-expiry-date').value = addCalendarMonths(todayStr, 1);
    document.getElementById('service-amount').value = '45.00';
    document.getElementById('service-payment-method').value = 'Yape';

    document.getElementById('client-phone-warning').classList.add('hidden');
    openModal('modal-client');
  }

  function openEditClientModal() {
    const client = state.currentClientDetail;
    if (!client) return;

    document.getElementById('client-edit-id').value = client.id;
    document.getElementById('modal-client-title').textContent = 'Editar Datos del Cliente';
    document.getElementById('modal-client-icon').textContent = 'edit';
    document.getElementById('btn-save-client').innerHTML = '<span class="material-symbols-outlined text-[18px]">check_circle</span> Actualizar Datos';

    document.getElementById('client-name').value = client.fullName;
    document.getElementById('client-phone').value = client.phone;
    document.getElementById('client-country-code').value = client.countryCode || '+51';
    document.getElementById('client-notes').value = client.notes || '';

    // Ocultar sección de servicio inicial en edición
    const serviceSection = document.getElementById('initial-service-section');
    if (serviceSection) serviceSection.classList.add('hidden');

    document.getElementById('client-phone-warning').classList.add('hidden');
    openModal('modal-client');
  }

  function onInitialStartDateChange() {
    const startInput = document.getElementById('service-start-date');
    const expiryInput = document.getElementById('service-expiry-date');
    if (startInput && expiryInput && startInput.value) {
      expiryInput.value = addCalendarMonths(startInput.value, 1);
    }
  }

  function checkDuplicatePhone() {
    const phoneInput = document.getElementById('client-phone');
    const warningEl = document.getElementById('client-phone-warning');
    const warningText = document.getElementById('client-phone-warning-text');
    const editId = document.getElementById('client-edit-id').value;

    if (!phoneInput || !warningEl) return;
    const digits = phoneInput.value.replace(/\D/g, '');

    if (digits.length >= 7) {
      const existing = state.servicesFeed.find(s => {
        if (editId && s.clientId === Number(editId)) return false;
        return s.cleanPhone.endsWith(digits) || digits.endsWith(s.cleanPhone);
      });

      if (existing) {
        warningEl.classList.remove('hidden');
        warningText.textContent = `Atención: este celular ya está registrado para el cliente "${existing.clientName}".`;
      } else {
        warningEl.classList.add('hidden');
      }
    } else {
      warningEl.classList.add('hidden');
    }
  }

  async function submitClientForm() {
    if (state.isSubmitting) return;

    const editId = document.getElementById('client-edit-id').value;
    const fullName = document.getElementById('client-name').value.trim();
    const phone = document.getElementById('client-phone').value.trim();
    const countryCode = document.getElementById('client-country-code').value;
    const notes = document.getElementById('client-notes').value.trim();

    if (!fullName || !phone) {
      showToast('Por favor ingrese el nombre completo y celular.', 'warning');
      return;
    }

    state.isSubmitting = true;
    const btn = document.getElementById('btn-save-client');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Guardando...';
    btn.disabled = true;

    try {
      if (editId) {
        // Actualizar cliente existente
        const res = await apiRequest(`/api/clients/${editId}`, 'PUT', {
          fullName, phone, countryCode, notes
        });
        showToast('Datos del cliente actualizados.', 'success');
        if (res.duplicateWarning) {
          showToast(res.duplicateWarning, 'warning');
        }
        closeModal('modal-client');
        await loadClientDetail(editId);
        await refreshAll();
      } else {
        // Crear nuevo cliente
        const sName = document.getElementById('service-name').value.trim();
        const sStart = document.getElementById('service-start-date').value;
        const sExpiry = document.getElementById('service-expiry-date').value;
        const sAmount = parseFloat(document.getElementById('service-amount').value) || 0;
        const sMethod = document.getElementById('service-payment-method').value;

        const res = await apiRequest('/api/clients', 'POST', {
          fullName,
          phone,
          countryCode,
          notes,
          initialService: sName ? {
            name: sName,
            startDate: sStart,
            expiryDate: sExpiry,
            amount: sAmount,
            currency: 'PEN',
            paymentDate: sStart,
            paymentMethod: sMethod,
            notes: ''
          } : null
        });

        showToast('¡Cliente registrado exitosamente!', 'success');
        if (res.duplicateWarning) {
          showToast(res.duplicateWarning, 'warning');
        }
        closeModal('modal-client');
        await refreshAll();
        if (res.client && res.client.id) {
          navigate('client-detail', { clientId: res.client.id });
        }
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      state.isSubmitting = false;
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  // AGREGAR SERVICIO A CLIENTE EXISTENTE
  function openAddServiceModal() {
    const client = state.currentClientDetail;
    if (!client) return;

    document.getElementById('add-service-client-id').value = client.id;
    document.getElementById('modal-add-service-client-name').textContent = `Cliente: ${client.fullName}`;
    document.getElementById('add-service-name').value = '';
    
    const todayStr = state.todayLima || getLimaTodayString();
    document.getElementById('add-service-start-date').value = todayStr;
    document.getElementById('add-service-expiry-date').value = addCalendarMonths(todayStr, 1);
    document.getElementById('add-service-amount').value = '45.00';
    document.getElementById('add-service-payment-method').value = 'Yape';
    document.getElementById('add-service-notes').value = '';

    openModal('modal-add-service');
  }

  function onAddServiceStartDateChange() {
    const startInput = document.getElementById('add-service-start-date');
    const expiryInput = document.getElementById('add-service-expiry-date');
    if (startInput && expiryInput && startInput.value) {
      expiryInput.value = addCalendarMonths(startInput.value, 1);
    }
  }

  async function submitAddServiceForm() {
    if (state.isSubmitting) return;

    const clientId = document.getElementById('add-service-client-id').value;
    const name = document.getElementById('add-service-name').value.trim();
    const startDate = document.getElementById('add-service-start-date').value;
    const expiryDate = document.getElementById('add-service-expiry-date').value;
    const amount = parseFloat(document.getElementById('add-service-amount').value) || 0;
    const paymentMethod = document.getElementById('add-service-payment-method').value;
    const notes = document.getElementById('add-service-notes').value.trim();

    if (!name || !startDate || !expiryDate) {
      showToast('Complete los campos obligatorios del servicio.', 'warning');
      return;
    }

    state.isSubmitting = true;
    const btn = document.getElementById('btn-save-service');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Guardando...';
    btn.disabled = true;

    try {
      await apiRequest(`/api/clients/${clientId}/services`, 'POST', {
        name,
        startDate,
        expiryDate,
        amount,
        currency: 'PEN',
        paymentDate: startDate,
        paymentMethod,
        notes
      });

      showToast('Servicio agregado correctamente.', 'success');
      closeModal('modal-add-service');
      await loadClientDetail(clientId);
      await refreshAll();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      state.isSubmitting = false;
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  // ============================================================
  // RENOVACIÓN MENSUAL (REQUERIMIENTO 8)
  // ============================================================

  function openRenewalModal(serviceId) {
    const item = state.servicesFeed.find(s => s.serviceId === serviceId) ||
      (state.currentClientDetail && state.currentClientDetail.services.find(s => s.id === serviceId));

    if (!item) {
      showToast('Servicio no encontrado.', 'error');
      return;
    }

    const clientName = item.clientName || (state.currentClientDetail && state.currentClientDetail.fullName);
    const serviceName = item.serviceName || item.name;
    const currentExpiry = item.expiryDate;
    const regularAmount = item.amount;

    document.getElementById('renewal-service-id').value = serviceId;
    document.getElementById('renewal-client-name').textContent = `Cliente: ${clientName}`;
    document.getElementById('renewal-service-name').textContent = serviceName;
    document.getElementById('renewal-prev-period').textContent = `${item.startDateDisplay || formatDisplayDate(item.startDate)} al ${item.expiryDateDisplay || formatDisplayDate(item.expiryDate)}`;

    // Regla de negocio: sugiere como nueva fecha de inicio el vencimiento anterior para continuar ciclo
    const newStart = currentExpiry;
    // Sugiere vencimiento sumando un mes de calendario exacto
    const newExpiry = addCalendarMonths(newStart, 1);

    document.getElementById('renewal-start-date').value = newStart;
    document.getElementById('renewal-expiry-date').value = newExpiry;
    document.getElementById('renewal-amount').value = regularAmount.toFixed(2);
    document.getElementById('renewal-notes').value = '';

    updateRenewalPeriodPreview();
    openModal('modal-renewal');
  }

  function onRenewalStartDateChange() {
    const startInput = document.getElementById('renewal-start-date');
    const expiryInput = document.getElementById('renewal-expiry-date');
    if (startInput && expiryInput && startInput.value) {
      expiryInput.value = addCalendarMonths(startInput.value, 1);
      updateRenewalPeriodPreview();
    }
  }

  function onRenewalDatesChange() {
    updateRenewalPeriodPreview();
  }

  function updateRenewalPeriodPreview() {
    const startInput = document.getElementById('renewal-start-date');
    const expiryInput = document.getElementById('renewal-expiry-date');
    const previewEl = document.getElementById('renewal-new-period-preview');

    if (startInput && expiryInput && previewEl) {
      previewEl.textContent = `${formatDisplayDate(startInput.value)} al ${formatDisplayDate(expiryInput.value)}`;
    }
  }

  async function submitRenewal() {
    if (state.isSubmitting) return;

    const serviceId = document.getElementById('renewal-service-id').value;
    const newStartDate = document.getElementById('renewal-start-date').value;
    const newExpiryDate = document.getElementById('renewal-expiry-date').value;
    const amount = parseFloat(document.getElementById('renewal-amount').value) || 0;
    const paymentMethodEl = document.querySelector('input[name="renewal_payment_method"]:checked');
    const paymentMethod = paymentMethodEl ? paymentMethodEl.value : 'Yape';
    const notes = document.getElementById('renewal-notes').value.trim();
    const sendWaReceipt = document.getElementById('renewal-send-wa').checked;

    if (!newStartDate || !newExpiryDate) {
      showToast('Por favor verifique las fechas de renovación.', 'warning');
      return;
    }

    if (newExpiryDate < newStartDate) {
      showToast('La fecha de vencimiento no puede ser menor a la fecha de inicio.', 'warning');
      return;
    }

    // Prevención de doble clic
    state.isSubmitting = true;
    const btn = document.getElementById('btn-confirm-renewal');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Confirmando...';
    btn.disabled = true;

    try {
      const res = await apiRequest(`/api/services/${serviceId}/renew`, 'POST', {
        newStartDate,
        newExpiryDate,
        amount,
        currency: 'PEN',
        paymentDate: state.todayLima || getLimaTodayString(),
        paymentMethod,
        notes
      });

      showToast('¡Renovación confirmada y período actualizado!', 'success');
      closeModal('modal-renewal');

      // Actualizar estado y reubicar automáticamente en el listado
      await refreshAll();

      if (state.currentView === 'client-detail' && res.client) {
        state.currentClientDetail = res.client;
        renderClientDetailView(res.client);
      }

      // Si seleccionó generar comprobante de WhatsApp
      if (sendWaReceipt) {
        openWhatsAppReceipt(res.client, serviceId, newStartDate, newExpiryDate, amount, paymentMethod);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      state.isSubmitting = false;
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  // ============================================================
  // WHATSAPP INTEGRACIÓN (REQUERIMIENTO 9)
  // ============================================================

  function openWhatsAppReminder(serviceId) {
    const item = state.servicesFeed.find(s => s.serviceId === serviceId) ||
      (state.currentClientDetail && state.currentClientDetail.services.find(s => s.id === serviceId));

    if (!item) return;

    const clientName = item.clientName || (state.currentClientDetail && state.currentClientDetail.fullName);
    const clientPhone = item.clientFullPhone || item.cleanPhone;
    const cleanPhone = item.cleanPhone;
    const serviceName = item.serviceName || item.name;
    const expiryDisplay = item.expiryDateDisplay || formatDisplayDate(item.expiryDate);
    const st = item.status;

    state.activeWhatsAppContext = {
      phone: clientPhone,
      cleanPhone,
      clientName,
      serviceName,
      expiryDateDisplay: expiryDisplay,
      amount: item.amount,
      mode: 'REMINDER',
      status: st
    };

    setWhatsAppMode('REMINDER');
    openModal('modal-whatsapp');
  }

  function openWhatsAppPromo(serviceId) {
    openWhatsAppReminder(serviceId);
    setWhatsAppMode('PROMO');
  }

  function openWhatsAppReminderForClient() {
    const client = state.currentClientDetail;
    if (!client) return;

    const s = client.services && client.services[0];
    if (s) {
      openWhatsAppReminder(s.id);
    } else {
      state.activeWhatsAppContext = {
        phone: client.fullPhone,
        cleanPhone: client.cleanPhone,
        clientName: client.fullName,
        serviceName: 'servicio contratado',
        expiryDateDisplay: '',
        amount: 0,
        mode: 'PROMO',
        status: null
      };
      setWhatsAppMode('PROMO');
      openModal('modal-whatsapp');
    }
  }

  function openWhatsAppReceipt(client, serviceId, startDate, expiryDate, amount, method) {
    const service = client.services.find(s => s.id === Number(serviceId)) || client.services[0];
    const sName = service ? service.name : 'Suscripción Mensual';

    state.activeWhatsAppContext = {
      phone: client.fullPhone,
      cleanPhone: client.cleanPhone,
      clientName: client.fullName,
      serviceName: sName,
      expiryDateDisplay: formatDisplayDate(expiryDate),
      amount,
      mode: 'RECEIPT',
      status: null
    };

    const titleEl = document.getElementById('wa-modal-title');
    const phoneEl = document.getElementById('wa-modal-phone');
    const textEl = document.getElementById('wa-message-text');

    if (titleEl) titleEl.textContent = 'Comprobante de Renovación';
    if (phoneEl) phoneEl.textContent = client.fullPhone;

    const receiptMessage = `¡Hola, ${client.fullName}! 🎉 Confirmamos la renovación exitosa de tu servicio *${sName}*.\n\n` +
      `📅 *Nuevo período:* ${formatDisplayDate(startDate)} al ${formatDisplayDate(expiryDate)}\n` +
      `💳 *Monto pagado:* S/ ${amount.toFixed(2)} (${method})\n\n` +
      `Gracias por tu puntualidad y por confiar en DarkMan. Tu señal y suscripción continúan 100% activas.`;

    if (textEl) textEl.value = receiptMessage;
    openModal('modal-whatsapp');
  }

  function setWhatsAppMode(mode) {
    state.activeWhatsAppContext.mode = mode;
    const titleEl = document.getElementById('wa-modal-title');
    const phoneEl = document.getElementById('wa-modal-phone');
    const textEl = document.getElementById('wa-message-text');
    const tabReminder = document.getElementById('wa-btn-tab-reminder');
    const tabPromo = document.getElementById('wa-btn-tab-promo');

    const ctx = state.activeWhatsAppContext;
    if (phoneEl) phoneEl.textContent = ctx.phone;

    if (mode === 'REMINDER') {
      if (titleEl) titleEl.textContent = 'Recordatorio de Vencimiento';
      if (tabReminder) {
        tabReminder.className = 'py-1.5 px-2 rounded-lg bg-tertiary-container/30 text-tertiary border border-tertiary/40 font-headline text-xs font-semibold flex items-center justify-center gap-1';
      }
      if (tabPromo) {
        tabPromo.className = 'py-1.5 px-2 rounded-lg bg-surface-container text-on-surface-variant border border-outline-variant/30 font-headline text-xs font-semibold flex items-center justify-center gap-1 hover:text-white';
      }

      // Adaptar texto según si está próximo, vence hoy o ya venció:
      let message = '';
      const st = ctx.status;

      if (st && st.code === 'VENCIDO') {
        message = `Hola, ${ctx.clientName}. Te informamos que tu servicio de ${ctx.serviceName} venció el ${ctx.expiryDateDisplay}. Para reactivar o renovar tu suscripción sin perder tu configuración, puedes escribirnos por este medio. Gracias por confiar en DarkMan.`;
      } else if (st && st.daysRemaining === 0) {
        message = `Hola, ${ctx.clientName}. Te recordamos que tu servicio de ${ctx.serviceName} vence hoy ${ctx.expiryDateDisplay}. Si deseas renovarlo y continuar disfrutando del servicio sin interrupciones, puedes escribirnos por este medio. Gracias por confiar en DarkMan.`;
      } else {
        message = `Hola, ${ctx.clientName}. Te recordamos que tu servicio de ${ctx.serviceName} vence el ${ctx.expiryDateDisplay}. Si deseas renovarlo, puedes escribirnos por este medio. Gracias por confiar en DarkMan.`;
      }

      if (textEl) textEl.value = message;
    } else {
      // Modo Promo / Aviso
      if (titleEl) titleEl.textContent = 'Aviso o Promoción';
      if (tabReminder) {
        tabReminder.className = 'py-1.5 px-2 rounded-lg bg-surface-container text-on-surface-variant border border-outline-variant/30 font-headline text-xs font-semibold flex items-center justify-center gap-1 hover:text-white';
      }
      if (tabPromo) {
        tabPromo.className = 'py-1.5 px-2 rounded-lg bg-tertiary-container/30 text-tertiary border border-tertiary/40 font-headline text-xs font-semibold flex items-center justify-center gap-1';
      }

      const promoMessage = `¡Hola, ${ctx.clientName}! 🎉 En DarkMan tenemos una promoción especial para ti:\n\n` +
        `Renueva 3 meses de tu ${ctx.serviceName} con un descuento exclusivo y asegura tu servicio sin interrupciones.\n\n` +
        `Escríbenos por aquí si deseas aprovechar esta oferta. ¡Que tengas un excelente día!`;

      if (textEl) textEl.value = promoMessage;
    }
  }

  function launchWhatsAppDirect() {
    const textEl = document.getElementById('wa-message-text');
    const message = textEl ? textEl.value.trim() : '';
    const cleanPhone = state.activeWhatsAppContext.cleanPhone;

    if (!cleanPhone) {
      showToast('Número de teléfono no disponible.', 'error');
      return;
    }

    const encoded = encodeURIComponent(message);
    const waUrl = `https://wa.me/${cleanPhone}?text=${encoded}`;

    window.open(waUrl, '_blank');
    closeModal('modal-whatsapp');
    showToast('Abriendo chat en WhatsApp...', 'info');
  }

  function copyWhatsAppText() {
    const textEl = document.getElementById('wa-message-text');
    if (textEl) {
      navigator.clipboard.writeText(textEl.value).then(() => {
        showToast('Texto copiado al portapapeles.', 'success');
      }).catch(() => {
        textEl.select();
        document.execCommand('copy');
        showToast('Texto copiado.', 'success');
      });
    }
  }

  // ============================================================
  // ELIMINACIÓN Y CONFIRMACIÓN
  // ============================================================

  function confirmDeleteCurrentClient() {
    const client = state.currentClientDetail;
    if (!client) return;

    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const btn = document.getElementById('confirm-action-btn');

    titleEl.textContent = '¿Eliminar cliente?';
    msgEl.textContent = `¿Está seguro de eliminar a "${client.fullName}"? Se eliminarán todos sus servicios y el historial completo de pagos de manera irreversible.`;

    btn.onclick = async () => {
      try {
        await apiRequest(`/api/clients/${client.id}`, 'DELETE');
        closeModal('modal-confirm');
        showToast('Cliente eliminado permanentemente.', 'success');
        await refreshAll();
        navigate('dashboard');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    openModal('modal-confirm');
  }

  function confirmDeleteService(serviceId) {
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const btn = document.getElementById('confirm-action-btn');

    titleEl.textContent = '¿Eliminar servicio?';
    msgEl.textContent = 'Se eliminará este servicio y todo su historial de pagos. ¿Desea continuar?';

    btn.onclick = async () => {
      try {
        await apiRequest(`/api/services/${serviceId}`, 'DELETE');
        closeModal('modal-confirm');
        showToast('Servicio eliminado.', 'success');
        if (state.currentClientDetail) {
          await loadClientDetail(state.currentClientDetail.id);
        }
        await refreshAll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    openModal('modal-confirm');
  }

  // ============================================================
  // MENÚ DE DATOS (DEMO / LIMPIEZA)
  // ============================================================

  function toggleDataMenu() {
    const menu = document.getElementById('data-menu-dropdown');
    if (menu) menu.classList.toggle('hidden');
  }

  async function loadDemoData() {
    const menu = document.getElementById('data-menu-dropdown');
    if (menu) menu.classList.add('hidden');

    try {
      showToast('Cargando dataset de prueba completo...', 'info');
      await apiRequest('/api/demo/seed', 'POST');
      await refreshAll();
      showToast('¡Datos de prueba cargados con todos los casos de vencimiento!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function promptClearData() {
    const menu = document.getElementById('data-menu-dropdown');
    if (menu) menu.classList.add('hidden');

    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const btn = document.getElementById('confirm-action-btn');

    titleEl.textContent = '¿Vaciar base de datos?';
    msgEl.textContent = 'Esta acción eliminará todos los registros y dejará la base de datos completamente limpia para producción. No se puede deshacer.';

    btn.onclick = async () => {
      try {
        await apiRequest('/api/demo/clear', 'POST');
        closeModal('modal-confirm');
        showToast('Base de datos vaciada. Lista para datos reales.', 'success');
        await refreshAll();
        navigate('dashboard');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    openModal('modal-confirm');
  }

  // ============================================================
  // NOTIFICACIONES TOAST FLOTANTES
  // ============================================================

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    let icon = 'info';
    let borderClass = 'border-primary/40';
    let iconClass = 'text-primary';

    if (type === 'success') {
      icon = 'check_circle';
      borderClass = 'border-tertiary/40';
      iconClass = 'text-tertiary';
    } else if (type === 'error') {
      icon = 'error';
      borderClass = 'border-error/50';
      iconClass = 'text-error';
    } else if (type === 'warning') {
      icon = 'warning';
      borderClass = 'border-amber-500/40';
      iconClass = 'text-amber-400';
    }

    const toast = document.createElement('div');
    toast.className = `p-3.5 rounded-xl bg-surface-container-high ${borderClass} border shadow-2xl flex items-center gap-3 pointer-events-auto toast-enter text-xs sm:text-sm text-white`;
    toast.innerHTML = `
      <span class="material-symbols-outlined ${iconClass} text-[20px] shrink-0">${icon}</span>
      <span class="flex-1">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease-out';
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  // ============================================================
  // AYUDANTES GENERALES
  // ============================================================

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ============================================================
  // PWA SERVICE WORKER & INSTALACIÓN
  // ============================================================

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                const banner = document.getElementById('update-banner');
                if (banner) banner.classList.remove('hidden');
              }
            });
          }
        });
      }).catch((err) => {
        console.warn('Registro de Service Worker:', err);
      });
    }
  }

  function updateAppNow() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        window.location.reload();
      });
    } else {
      window.location.reload();
    }
  }

  async function promptInstallPWA() {
    if (state.deferredPrompt) {
      state.deferredPrompt.prompt();
      const choice = await state.deferredPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        showToast('Instalando DarkMan en su dispositivo...', 'info');
      }
      state.deferredPrompt = null;
      const installBtn = document.getElementById('btn-install-pwa');
      if (installBtn) installBtn.classList.add('hidden');
    } else {
      showToast('En su celular: toque el menú del navegador (tres puntos ⋮ o botón Compartir ⎋) y elija "Agregar a pantalla principal" o "Instalar".', 'info');
    }
  }

  function onNetworkOffline() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.remove('hidden');
  }

  function onNetworkOnline() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.add('hidden');
    showToast('Conexión a internet restablecida.', 'success');
    refreshAll();
  }

  // ============================================================
  // GOOGLE SHEETS SINCRONIZACIÓN
  // ============================================================

  async function openGoogleSheetsModal() {
    try {
      const info = await apiRequest('/api/gsheets/info');
      const idEl = document.getElementById('gsheet-id-display');
      const openBtn = document.getElementById('btn-open-gsheet');
      const lastSyncEl = document.getElementById('gsheet-last-sync-display');
      const statusPill = document.getElementById('gsheet-status-pill');

      if (idEl) idEl.textContent = info.spreadsheetId;
      if (openBtn) openBtn.href = info.url;

      if (lastSyncEl) {
        if (info.lastSync) {
          const syncDate = new Date(info.lastSync);
          lastSyncEl.textContent = syncDate.toLocaleString('es-PE', { timeZone: 'America/Lima' });
        } else {
          lastSyncEl.textContent = 'Aún no sincronizado';
        }
      }

      if (statusPill) {
        if (info.lastError) {
          statusPill.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-error-container/20 text-error border border-error/30';
          statusPill.textContent = 'Error en última sincronización';
        } else if (info.lastSync) {
          statusPill.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
          statusPill.textContent = 'Conectado & Sincronizado';
        } else {
          statusPill.className = 'px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30';
          statusPill.textContent = 'Pendiente de sincronizar';
        }
      }
    } catch (e) {
      console.warn('No se pudo cargar info de gsheets:', e);
    }
    openModal('modal-gsheets');
  }

  async function syncGoogleSheetsNow() {
    const btn = document.getElementById('btn-sync-gsheet');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Sincronizando...';
    btn.disabled = true;

    try {
      const res = await apiRequest('/api/gsheets/sync', 'POST');
      showToast(`¡Sincronizado! ${res.servicesCount} servicios y ${res.historyCount} pagos enviados a Google Sheets.`, 'success');
      const openBtn = document.getElementById('btn-open-gsheet');
      if (openBtn) openBtn.href = res.url;
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  async function importGoogleSheetsNow() {
    const btn = document.getElementById('btn-import-gsheet');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> Importando...';
    btn.disabled = true;

    try {
      const res = await apiRequest('/api/gsheets/import', 'POST');
      showToast(`Importación completada: ${res.importedCount} clientes nuevos importados.`, 'success');
      await refreshAll();
      closeModal('modal-gsheets');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  async function changeConnectedSpreadsheet() {
    const input = document.getElementById('custom-gsheet-id');
    let raw = input ? input.value.trim() : '';
    if (!raw) {
      showToast('Por favor ingrese un ID o enlace de Google Sheet válido.', 'warning');
      return;
    }

    // Extraer ID si pegó la URL completa
    const match = raw.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const sheetId = match ? match[1] : raw;

    try {
      showToast('Vinculando y sincronizando con la nueva hoja...', 'info');
      const res = await apiRequest('/api/gsheets/sync', 'POST', { spreadsheetId: sheetId });
      showToast('¡Hoja vinculada y sincronizada exitosamente!', 'success');
      document.getElementById('gsheet-id-display').textContent = sheetId;
      document.getElementById('btn-open-gsheet').href = res.url;
      if (input) input.value = '';
    } catch (err) {
      showToast('Error vinculando hoja: ' + err.message, 'error');
    }
  }

  // ============================================================
  // AUTENTICACIÓN Y SEGURIDAD
  // ============================================================

  async function checkAuthStatus() {
    try {
      const headers = {};
      if (state.authToken) {
        headers['Authorization'] = `Bearer ${state.authToken}`;
      }
      const res = await fetch('/api/auth/status', { headers });
      const data = await res.json().catch(() => ({}));

      state.authRequired = !!data.requireAuth;
      state.isAuthenticated = !!data.authenticated;

      const lockIcon = document.getElementById('btn-auth-lock-icon');
      if (lockIcon) {
        lockIcon.textContent = state.isAuthenticated ? 'lock_open' : 'lock';
      }

      if (state.authRequired && !state.isAuthenticated) {
        openModal('modal-auth');
      }
    } catch (e) {
      console.warn('Error verificando estado de auth:', e);
    }
  }

  async function submitLogin() {
    const pwdInput = document.getElementById('auth-password');
    const errorMsg = document.getElementById('auth-error-msg');
    const btn = document.getElementById('btn-submit-auth');
    const pwd = pwdInput ? pwdInput.value : '';

    if (!pwd) return;

    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> Verificando...';
    btn.disabled = true;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (errorMsg) {
          errorMsg.textContent = data.error || 'Contraseña incorrecta';
          errorMsg.classList.remove('hidden');
        }
        return;
      }

      state.isAuthenticated = true;
      if (data.token) {
        state.authToken = data.token;
        localStorage.setItem('darkman_auth_token', data.token);
      }

      closeModal('modal-auth');
      if (errorMsg) errorMsg.classList.add('hidden');
      if (pwdInput) pwdInput.value = '';

      const lockIcon = document.getElementById('btn-auth-lock-icon');
      if (lockIcon) lockIcon.textContent = 'lock_open';

      showToast('Sesión de administrador desbloqueada.', 'success');
      refreshAll();
    } catch (err) {
      showToast('Error de conexión al iniciar sesión', 'error');
    } finally {
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  function toggleAuth() {
    if (state.isAuthenticated && state.authRequired) {
      // Bloquear sesión actual
      state.isAuthenticated = false;
      state.authToken = null;
      localStorage.removeItem('darkman_auth_token');
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});

      const lockIcon = document.getElementById('btn-auth-lock-icon');
      if (lockIcon) lockIcon.textContent = 'lock';

      openModal('modal-auth');
      showToast('Sesión bloqueada.', 'info');
    } else {
      openModal('modal-auth');
    }
  }

  function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  }

  function getInitials(name) {
    if (!name) return 'DM';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // Inicializar al cargar el DOM
  document.addEventListener('DOMContentLoaded', init);

  // Exponer interfaz pública
  return {
    navigate,
    goBackFromDetail,
    filterByStatusAndGo,
    refreshAll,
    openModal,
    closeModal,
    openNewClientModal,
    openEditClientModal,
    onInitialStartDateChange,
    checkDuplicatePhone,
    submitClientForm,
    openAddServiceModal,
    onAddServiceStartDateChange,
    submitAddServiceForm,
    openRenewalModal,
    onRenewalStartDateChange,
    onRenewalDatesChange,
    submitRenewal,
    openWhatsAppReminder,
    openWhatsAppPromo,
    openWhatsAppReminderForClient,
    setWhatsAppMode,
    launchWhatsAppDirect,
    copyWhatsAppText,
    confirmDeleteCurrentClient,
    confirmDeleteService,
    onFilterChange,
    clearSearch,
    resetFilters,
    onClientsSearch,
    toggleDataMenu,
    loadDemoData,
    promptClearData,
    openGoogleSheetsModal,
    syncGoogleSheetsNow,
    importGoogleSheetsNow,
    changeConnectedSpreadsheet,
    promptInstallPWA,
    updateAppNow,
    checkAuthStatus,
    submitLogin,
    toggleAuth,
    togglePasswordVisibility,
    showToast
  };

})();

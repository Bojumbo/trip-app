/* =========================================================
   Trip Tracker — клієнт
   Авторизація: httpOnly cookie (без токена в localStorage).
   Події: делеговані через data-action (без inline-обробників → працює CSP).
   ========================================================= */

'use strict';

// ---------- Стан ----------
let userCoords = '';
let currentOffset = 0;
let totalRecords = 0;
let lastKnownOdometer = null;
let actionsList = [];
let activeTripId = null;
const recordsCache = new Map();
let searchDebounceTimeout = null;
let isSyncingOffline = false;
let chartMileageInstance = null;
let chartActionsInstance = null;
let chartShiftsDurationInstance = null;
let chartLocationsInstance = null;
let analyticsCurrentPeriod = '30d';
let pendingDeleteId = null;
let lastFocusedElement = null;

const OFFLINE_KEY = 'trip_offline_queue';
const THEME_KEY = 'app_theme';
const MAX_OFFLINE_ATTEMPTS = 10;
const MAX_DAILY_KM = 2000;

// ---------- Утиліти ----------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('uk-UA');
}

function $(id) { return document.getElementById(id); }
function val(id) { const el = $(id); return el ? el.value : ''; }

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------- Мережа ----------
async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  init.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError('Немає зв’язку з сервером', 0);
  }

  if (res.status === 401) {
    showLogin();
    throw new ApiError('Не авторизовано', 401);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Помилка ${res.status}`, res.status);
  }
  return data;
}

// ---------- Повідомлення ----------
let toastTimer = null;
function showToast(text, type = 'success', duration = 3500) {
  const host = $('toastHost');
  if (!host) return;
  host.innerHTML = '';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = text;
  host.appendChild(el);

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('toast-hide');
    setTimeout(() => { if (el.parentNode) el.remove(); }, 250);
  }, duration);
}

// ---------- Тема ----------
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const preferred = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  setTheme(preferred, false);
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setTheme(isDark ? 'light' : 'dark');
}
function setTheme(t, reload = true) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  const btn = $('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  const meta = $('themeMeta');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1e293b' : '#2563eb');
  const analyticsTab = $('tabAnalytics');
  if (reload && analyticsTab && analyticsTab.style.display !== 'none') loadAnalytics();
}

// ---------- Модальні вікна ----------
function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  lastFocusedElement = document.activeElement;
  modal.style.display = 'flex';
  const focusable = modal.querySelector('input:not([type="hidden"]), select, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 50);
}
function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.style.display = 'none';
  if (lastFocusedElement && lastFocusedElement.focus) lastFocusedElement.focus();
}
function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
}

// ---------- Авторизація ----------
function showLogin() {
  closeAllModals();
  const login = $('loginScreen');
  const app = $('appScreen');
  if (login) login.style.display = 'flex';
  if (app) app.style.display = 'none';
}

async function handleLogin() {
  const errDiv = $('loginError');
  const loginBtn = $('loginBtn');
  const pwd = val('loginPassword').trim();
  if (errDiv) errDiv.style.display = 'none';

  if (!pwd) {
    if (errDiv) { errDiv.textContent = 'Введіть пароль'; errDiv.style.display = 'block'; }
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Вхід...';

  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: pwd }) });
    loginBtn.disabled = false;
    loginBtn.textContent = 'Увійти';
    $('loginPassword').value = '';
    showApp();
  } catch (e) {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Увійти';
    if (errDiv) {
      errDiv.textContent = e.status === 429 ? e.message : (e.message || 'Невірний пароль');
      errDiv.style.display = 'block';
    }
  }
}

async function handleLogout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (e) {
    // ігноруємо — все одно виходимо локально
  }
  location.reload();
}

function showApp() {
  const login = $('loginScreen');
  const app = $('appScreen');
  if (login) login.style.display = 'none';
  if (app) app.style.display = 'block';
  initApp();
}

// ---------- Ініціалізація ----------
function initApp() {
  initTheme();
  updateNetworkStatus();
  setNowDateTime();
  fetchGPS();
  loadActions();
  loadLastOdometer();
  updateOfflineQueueBadge();
  syncOfflineQueue();
  loadActiveTripBanner();
  populateTripSelectors();
}

function setNowDateTime() {
  const now = new Date();
  const fmt = (n) => String(n).padStart(2, '0');
  if ($('dateInput')) $('dateInput').value = `${now.getFullYear()}-${fmt(now.getMonth() + 1)}-${fmt(now.getDate())}`;
  if ($('timeInput')) $('timeInput').value = `${fmt(now.getHours())}:${fmt(now.getMinutes())}`;
}

function updateNetworkStatus() {
  const banner = $('offlineBanner');
  if (banner) banner.classList.toggle('active', !navigator.onLine);
}

// ---------- GPS ----------
function fetchGPS() {
  const txt = $('geoStatusText');
  const dot = $('geoDot');
  const retryBtn = $('geoRetryBtn');

  if (dot) dot.className = 'dot';
  if (txt) txt.textContent = 'Визначення координат...';
  if (retryBtn) retryBtn.style.display = 'none';

  if (!navigator.geolocation) {
    if (txt) txt.textContent = 'GPS не підтримується цим браузером';
    return;
  }

  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    if (txt) txt.textContent = 'Увага: GPS вимагає HTTPS для роботи на смартфонах';
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userCoords = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      const cInp = $('coords');
      if (cInp) cInp.value = userCoords;
      if (txt) txt.textContent = `GPS: ${userCoords}`;
      if (dot) dot.className = 'dot active';
    },
    (err) => {
      if (txt) txt.textContent = `GPS недоступний: ${err.message}`;
      if (retryBtn) retryBtn.style.display = 'inline-block';
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

// ---------- Довідник дій ----------
async function loadActions() {
  try {
    actionsList = await api('/api/actions');
    const s1 = $('action');
    const s2 = $('editAction');
    if (s1) s1.innerHTML = '<option value="" disabled selected>Оберіть дію...</option>';
    if (s2) s2.innerHTML = '';
    actionsList.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      if (s1) s1.appendChild(opt.cloneNode(true));
      if (s2) s2.appendChild(opt);
    });
  } catch (e) {
    console.warn('Не вдалося завантажити довідник дій', e.message);
  }
}

// ---------- Одометр ----------
async function loadLastOdometer() {
  try {
    const data = await api('/api/odometer/last');
    const inp = $('odometer');
    const hint = $('lastOdoHint');
    if (data.lastOdometer !== undefined && data.lastOdometer !== '') {
      lastKnownOdometer = Number(data.lastOdometer);
      if (inp && !inp.value) inp.value = data.lastOdometer;
      if (hint) hint.textContent = `Попередній: ${fmtNum(data.lastOdometer)} км`;
    } else {
      lastKnownOdometer = null;
      if (hint) hint.textContent = '';
    }
  } catch (e) {
    console.warn('Не вдалося отримати останній одометр', e.message);
  }
}

function checkOdometerInput() {
  const inp = $('odometer');
  const alertBox = $('odoAlert');
  if (!inp || !alertBox) return;

  const current = inp.value !== '' ? Number(inp.value) : null;
  if (current !== null && lastKnownOdometer !== null && current < lastKnownOdometer) {
    alertBox.textContent = `⚠️ Пробіг (${fmtNum(current)}) менший за попередній (${fmtNum(lastKnownOdometer)} км)`;
    alertBox.style.display = 'block';
  } else {
    alertBox.style.display = 'none';
  }
}

// ---------- Вкладки ----------
function switchTab(t) {
  ['form', 'report', 'table', 'analytics'].forEach(x => {
    const tabEl = $(`tab${capitalize(x)}`);
    const tabBtn = $(`tab${capitalize(x)}Btn`);
    if (tabEl) tabEl.style.display = (x === t ? 'block' : 'none');
    if (tabBtn) {
      tabBtn.classList.toggle('active', x === t);
      tabBtn.setAttribute('aria-selected', x === t ? 'true' : 'false');
    }
  });

  if (t === 'form') { loadLastOdometer(); loadActiveTripBanner(); }
  if (t === 'report') loadTripsReport();
  if (t === 'table') reloadTable(true);
  if (t === 'analytics') {
    if (!$('analyticsDateFrom')?.value && !$('analyticsDateTo')?.value) {
      setAnalyticsPeriod('30d');
    } else {
      loadAnalytics();
    }
  }
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- Перемикачі статусу звіту ----------
function toggleFormReportStatus() {
  const chk = $('formIsReported');
  if (!chk) return;
  chk.checked = !chk.checked;
  updateFormReportUI(chk.checked);
}
function updateFormReportUI(isChecked) {
  const card = $('formReportCard');
  const text = $('formReportText');
  if (!card || !text) return;
  card.classList.toggle('checked', isChecked);
  card.setAttribute('aria-checked', isChecked ? 'true' : 'false');
  text.textContent = isChecked ? '✅ Звіт ЗДАНО' : '⏳ Звіт НЕ здано';
  text.style.color = isChecked ? 'var(--success-text)' : 'var(--warning)';
}

function toggleEditReportStatus() {
  const chk = $('editIsReported');
  if (!chk) return;
  chk.checked = !chk.checked;
  updateEditReportUI(chk.checked);
}
function updateEditReportUI(isChecked) {
  const card = $('editReportCard');
  const text = $('editReportText');
  if (!card || !text) return;
  card.classList.toggle('checked', isChecked);
  card.setAttribute('aria-checked', isChecked ? 'true' : 'false');
  text.textContent = isChecked ? '✅ Звіт ЗДАНО' : '⏳ Звіт НЕ здано';
  text.style.color = isChecked ? 'var(--success-text)' : 'var(--warning)';
}

// ---------- Офлайн-черга ----------
function getOfflineQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(OFFLINE_KEY) || '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function saveOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_KEY, JSON.stringify(queue));
  updateOfflineQueueBadge();
}
function updateOfflineQueueBadge() {
  const badge = $('offlineCountBadge');
  if (!badge) return;
  const len = getOfflineQueue().length;
  badge.textContent = String(len);
  badge.style.display = len > 0 ? 'block' : 'none';
}

function makeUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function enqueueOffline(payload) {
  const queue = getOfflineQueue();
  queue.push({ uuid: makeUuid(), payload, attempts: 0, created_at: new Date().toISOString() });
  saveOfflineQueue(queue);
}

async function syncOfflineQueue() {
  if (isSyncingOffline || !navigator.onLine) return;
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  isSyncingOffline = true;
  let synced = 0;
  let dropped = 0;
  const remaining = [];

  for (const item of queue) {
    try {
      const payload = { ...item.payload, client_uuid: item.uuid };
      await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
      synced++;
    } catch (e) {
      if (e.status === 401) {
        remaining.push(item);
        break;
      }
      const retriable = e.status === 0 || e.status === 429 || e.status >= 500;
      const attempts = (item.attempts || 0) + 1;
      if (!retriable && e.status >= 400 && e.status < 500) {
        dropped++; // некоректний запис — далі не має сенсу повторювати
        continue;
      }
      if (attempts >= MAX_OFFLINE_ATTEMPTS) { dropped++; continue; }
      remaining.push({ ...item, attempts });
    }
  }

  saveOfflineQueue(remaining);
  isSyncingOffline = false;

  if (synced > 0) {
    showToast(`✅ Синхронізовано офлайн-записів: ${synced}`, 'success');
    loadLastOdometer();
  }
  if (dropped > 0) {
    showToast(`⚠️ ${dropped} офлайн-запис(ів) відхилено сервером і видалено з черги`, 'error', 6000);
  }
  if (remaining.length > 0 && synced === 0 && dropped === 0) {
    showToast('Не вдалося синхронізувати чергу. Спробуйте пізніше.', 'warning');
  }
}

// ---------- Форма нового запису ----------
async function submitRecordForm(e) {
  e.preventDefault();
  const btn = $('submitBtn');
  if (btn.disabled) return;
  btn.disabled = true;

  const odoRaw = val('odometer').trim();
  const payload = {
    date: val('dateInput'),
    time: val('timeInput'),
    odometer: odoRaw !== '' ? Number(odoRaw) : null,
    action: val('action'),
    location: val('location'),
    comment: val('comment'),
    coords: userCoords || val('coords'),
    is_reported: $('formIsReported')?.checked ? 1 : 0,
    cargo: ($('cargoInput')?.value || '').trim(),
    delivery_id: $('unloadDeliverySelect')?.value || null,
    trip_id: activeTripId || null
  };

  const resetFormAfterSave = () => {
    $('comment').value = '';
    if ($('formIsReported')) $('formIsReported').checked = false;
    updateFormReportUI(false);
    setNowDateTime();
    fetchGPS();
    if ($('cargoInput')) $('cargoInput').value = '';
    if ($('cargoFieldWrap')) $('cargoFieldWrap').style.display = 'none';
    if ($('unloadDeliveryFieldWrap')) $('unloadDeliveryFieldWrap').style.display = 'none';
  };

  if (!navigator.onLine) {
    enqueueOffline(payload);
    btn.disabled = false;
    resetFormAfterSave();
    showToast('📡 Збережено офлайн. Запис відправиться автоматично.', 'warning', 4500);
    return;
  }

  try {
    const data = await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
    btn.disabled = false;
    resetFormAfterSave();
    if (data.warning) {
      showToast(`Запис збережено. ${data.warning}`, 'warning', 5000);
    } else {
      showToast('Запис збережено в базі', 'success');
    }
    loadLastOdometer();
    loadActiveTripBanner();
  } catch (err) {
    btn.disabled = false;
    if (err.status === 0 || err.status === 429 || err.status >= 500) {
      enqueueOffline(payload);
      resetFormAfterSave();
      showToast('Немає зв’язку із сервером. Запис збережено локально.', 'warning', 4500);
    } else {
      showToast(`Помилка: ${err.message}`, 'error', 5000);
    }
  }
}

// ---------- Фільтри таблиці ----------
function getFilterParams() {
  const params = new URLSearchParams();
  const search = ($('tableSearch')?.value || '').trim();
  const dateFrom = val('filterDateFrom');
  const dateTo = val('filterDateTo');
  const isReported = val('filterReportStatus');
  const tripId = val('filterTrip');

  if (search) params.set('search', search);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (isReported !== '') params.set('is_reported', isReported);
  if (tripId) params.set('trip_id', tripId);
  return params;
}

function onSearchInputChanged() {
  clearTimeout(searchDebounceTimeout);
  searchDebounceTimeout = setTimeout(() => reloadTable(true), 300);
}

function resetTableFilters() {
  ['tableSearch', 'filterDateFrom', 'filterDateTo', 'filterReportStatus', 'filterTrip'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });
  reloadTable(true);
}

async function reloadTable(reset = true) {
  if (reset) {
    currentOffset = 0;
    const tb = $('tableBody');
    if (tb) tb.innerHTML = '';
    recordsCache.clear();
  }
  await loadMoreRecords(30);
}

async function loadMoreRecords(limitCount) {
  const tbody = $('tableBody');
  try {
    const params = getFilterParams();
    params.set('limit', limitCount);
    params.set('offset', currentOffset);

    const data = await api(`/api/records?${params.toString()}`);
    totalRecords = data.total;
    if ($('totalRecordsCount')) $('totalRecordsCount').textContent = String(totalRecords);

    if (tbody) {
      if (currentOffset === 0 && data.records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:30px; color:var(--text-muted);">Записів не знайдено</td></tr>';
      } else {
        const frag = document.createDocumentFragment();
        data.records.forEach(r => {
          recordsCache.set(r.id, r);
          frag.appendChild(renderTableRowEl(r));
        });
        tbody.appendChild(frag);
      }
    }

    currentOffset += data.records.length;
    if ($('tableLoadedStatus')) {
      $('tableLoadedStatus').textContent = `Показано ${Math.min(currentOffset, totalRecords)} із ${fmtNum(totalRecords)} записів`;
    }
    if ($('loadMoreSection')) {
      $('loadMoreSection').style.display = (currentOffset >= totalRecords ? 'none' : 'flex');
    }
  } catch (e) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:30px; color:var(--danger);">${escapeHtml(e.message)}</td></tr>`;
    }
  }
}

function renderTableRowEl(r) {
  const tr = document.createElement('tr');
  tr.id = `row_${r.id}`;

  const isReported = Number(r.is_reported) === 1;
  const tripLabel = r.trip_name
    ? `#${escapeHtml(r.trip_id)} ${escapeHtml(r.trip_name)}`
    : '<span style="color:var(--text-muted);">без рейсу</span>';
  const deliveryLabel = r.delivery_cargo
    ? `<div style="font-size:0.75rem; color:var(--text-muted);">📦 ${escapeHtml(r.delivery_cargo)}</div>`
    : '';

  const gps = r.coords && String(r.coords).includes(',')
    ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(r.coords)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary); text-decoration:none;">🗺️ GPS</a>`
    : '-';

  tr.innerHTML = `
    <td><b>#${escapeHtml(r.id)}</b></td>
    <td>${escapeHtml(r.date)}</td>
    <td>${escapeHtml(r.time)}</td>
    <td>${r.odometer ? `${fmtNum(r.odometer)} км` : '-'}</td>
    <td><span style="font-weight:600; color:var(--primary);">${escapeHtml(r.action)}</span></td>
    <td>${escapeHtml(r.location) || '-'}</td>
    <td>${tripLabel}${deliveryLabel}</td>
    <td style="white-space: pre-line;">${escapeHtml(r.comment) || '-'}</td>
    <td>${gps}</td>
    <td>
      <button class="btn-report-toggle ${isReported ? 'badge-reported-yes' : 'badge-reported-no'}"
              data-action="toggle-report-status" data-id="${escapeHtml(r.id)}" data-next="${isReported ? 0 : 1}"
              title="Змінити статус звіту">
        ${isReported ? '✅ Так' : '⏳ Ні'}
      </button>
    </td>
    <td>
      <div style="display:flex; gap:4px;">
        <button class="btn btn-secondary" style="padding:4px 8px; font-size:0.8rem;"
                data-action="open-edit" data-id="${escapeHtml(r.id)}" title="Редагувати" aria-label="Редагувати запис #${escapeHtml(r.id)}">✏️</button>
        <button class="btn btn-secondary" style="padding:4px 8px; font-size:0.8rem; color:var(--danger);"
                data-action="confirm-delete" data-id="${escapeHtml(r.id)}" title="Видалити" aria-label="Видалити запис #${escapeHtml(r.id)}">🗑️</button>
      </div>
    </td>
  `;
  return tr;
}

async function toggleReportStatus(id, newStatus) {
  try {
    await api(`/api/records/${id}/report-status`, {
      method: 'PATCH',
      body: JSON.stringify({ is_reported: newStatus })
    });

    const rec = recordsCache.get(Number(id));
    if (rec) rec.is_reported = newStatus;

    const row = $(`row_${id}`);
    if (row && rec) {
      const replacement = renderTableRowEl(rec);
      row.replaceWith(replacement);
    }

    const itemBadge = $(`report_item_badge_${id}`);
    if (itemBadge) {
      const isRep = newStatus === 1;
      itemBadge.className = `btn-report-toggle ${isRep ? 'badge-reported-yes' : 'badge-reported-no'}`;
      itemBadge.textContent = isRep ? 'Звіт: ✅' : 'Звіт: ⏳';
      itemBadge.dataset.next = isRep ? '0' : '1';
    }

    // Оновити агреговані бейджі у звіті без повного перезавантаження
    const reportTab = $('tabReport');
    if (reportTab && reportTab.style.display !== 'none') loadTripsReport();
  } catch (e) {
    showToast(`Не вдалося змінити статус: ${e.message}`, 'error');
  }
}

async function bulkSetReportStatus(ids, newStatus) {
  if (!ids || ids.length === 0) return;
  try {
    const data = await api('/api/records/bulk-report-status', {
      method: 'POST',
      body: JSON.stringify({ ids, is_reported: newStatus })
    });
    ids.forEach(id => {
      const r = recordsCache.get(Number(id));
      if (r) r.is_reported = newStatus;
    });
    showToast(`Оновлено записів: ${data.count}`, 'success');
    const reportTab = $('tabReport');
    if (reportTab && reportTab.style.display !== 'none') loadTripsReport();
    const tableTab = $('tabTable');
    if (tableTab && tableTab.style.display !== 'none') reloadTable(true);
  } catch (e) {
    showToast(`Помилка масового оновлення: ${e.message}`, 'error');
  }
}

// ---------- Редагування ----------
function openEditModalById(id) {
  const numId = Number(id);
  const record = recordsCache.get(numId);

  if (!record) {
    showToast('Запис не знайдено. Оновіть вкладку та спробуйте ще раз.', 'error');
    return;
  }

  $('editId').value = record.id;
  $('editDate').value = record.date;
  $('editTime').value = record.time;
  $('editOdometer').value = record.odometer || '';
  $('editLocation').value = record.location || '';
  $('editComment').value = record.comment || '';
  $('editCoords').value = record.coords || '';

  const actionSelect = $('editAction');
  if (actionSelect) {
    if (![...actionSelect.options].some(o => o.value === record.action)) {
      const opt = document.createElement('option');
      opt.value = record.action;
      opt.textContent = record.action;
      actionSelect.appendChild(opt);
    }
    actionSelect.value = record.action;
  }

  const tripSelect = $('editTrip');
  if (tripSelect) {
    fillTripSelect(tripSelect, record.trip_id);
  }

  const isReported = Number(record.is_reported) === 1;
  $('editIsReported').checked = isReported;
  updateEditReportUI(isReported);

  openModal('editModal');

  // Якщо список рейсів ще не завантажений — підтягуємо у фоні
  if (reportTripsCache.size === 0) {
    api('/api/trips').then(trips => {
      const sel = $('editTrip');
      if (!sel || sel.options.length > 1) return;
      sel.innerHTML = '<option value="">Без рейсу</option>';
      trips.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `#${t.id} ${t.name}`;
        sel.appendChild(opt);
      });
      sel.value = record.trip_id ? String(record.trip_id) : '';
    }).catch(() => {});
  }
}

function fillTripSelect(select, selectedTripId) {
  select.innerHTML = '<option value="">Без рейсу</option>';
  const trips = [...reportTripsCache.values()];
  trips.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `#${t.id} ${t.name}`;
    select.appendChild(opt);
  });
  select.value = selectedTripId ? String(selectedTripId) : '';
  if (selectedTripId && select.value !== String(selectedTripId)) {
    const opt = document.createElement('option');
    opt.value = selectedTripId;
    opt.textContent = `#${selectedTripId}`;
    select.appendChild(opt);
    select.value = String(selectedTripId);
  }
}

async function saveEdit() {
  const id = val('editId');
  if (!id) return;
  const odo = val('editOdometer').trim();
  const tripValue = val('editTrip');

  const payload = {
    date: val('editDate'),
    time: val('editTime'),
    odometer: odo !== '' ? Number(odo) : null,
    action: val('editAction'),
    location: val('editLocation'),
    comment: val('editComment'),
    coords: val('editCoords').trim(),
    is_reported: $('editIsReported')?.checked ? 1 : 0,
    trip_id: tripValue ? Number(tripValue) : null
    // delivery_id НЕ передаємо — сервер збереже поточне значення
  };

  try {
    await api(`/api/records/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    closeModal('editModal');
    showToast('Зміни збережено', 'success');
    recordsCache.delete(Number(id));
    reloadTable(true);
    loadLastOdometer();
    const reportTab = $('tabReport');
    if (reportTab && reportTab.style.display !== 'none') loadTripsReport();
  } catch (e) {
    showToast(`Помилка збереження: ${e.message}`, 'error', 5000);
  }
}

// ---------- Видалення ----------
function confirmDeleteRecord(id) {
  pendingDeleteId = Number(id);
  const text = $('deleteConfirmText');
  if (text) text.textContent = `Ви дійсно бажаєте видалити запис #${id}? Дію не можна скасувати.`;
  openModal('deleteModal');
}

async function executeDeleteRecord() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  pendingDeleteId = null;
  closeModal('deleteModal');

  try {
    await api(`/api/records/${id}`, { method: 'DELETE' });
    recordsCache.delete(id);
    showToast('Запис видалено', 'success');
    reloadTable(true);
    loadLastOdometer();
    const reportTab = $('tabReport');
    if (reportTab && reportTab.style.display !== 'none') loadTripsReport();
  } catch (e) {
    showToast(`Помилка видалення: ${e.message}`, 'error');
  }
}

function deleteFromModal() {
  const id = Number(val('editId'));
  if (!id) return;
  closeModal('editModal');
  confirmDeleteRecord(id);
}

// ---------- Імпорт ----------
function openImportModal() {
  openModal('importModal');
}
async function sendBulkImport() {
  const text = $('importRawText')?.value || '';
  if (!text.trim()) {
    showToast('Вставте текст із таблиці', 'warning');
    return;
  }

  const btn = $('importBtn');
  btn.disabled = true;
  btn.textContent = 'Імпортування...';

  try {
    const data = await api('/api/records/bulk-import', {
      method: 'POST',
      body: JSON.stringify({ rawText: text })
    });
    btn.disabled = false;
    btn.textContent = 'Завантажити';

    let msg = `Додано записів: ${data.count}`;
    if (data.skipped) msg += `, пропущено дублікатів: ${data.skipped}`;
    showToast(msg, 'success', 5000);
    if (data.errors && data.errors.length) {
      console.warn('Помилки імпорту:', data.errors);
      showToast(`${msg}. Помилок: ${data.errors.length} (деталі в консолі)`, 'warning', 6000);
    }
    closeModal('importModal');
    $('importRawText').value = '';
    reloadTable(true);
    loadLastOdometer();
    populateTripSelectors();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Завантажити';
    showToast(`Помилка імпорту: ${e.message}`, 'error', 6000);
  }
}

// ---------- CSV ----------
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Захист від CSV-ін'єкції: Excel/Sheets не мають виконувати формули
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportToCSV() {
  try {
    const records = await api('/api/records/all');
    if (!Array.isArray(records) || records.length === 0) {
      showToast('Немає записів для експорту', 'warning');
      return;
    }

    const headers = ['ID', 'Дата', 'Час', 'Одометр', 'Дія', 'Локація', 'Коментар', 'GPS', 'Звіт здано'];
    const lines = [headers.join(';')];

    records.forEach(r => {
      lines.push([
        r.id,
        csvCell(r.date),
        csvCell(r.time),
        r.odometer !== null ? r.odometer : '',
        csvCell(r.action),
        csvCell(r.location),
        csvCell(r.comment),
        csvCell(r.coords),
        Number(r.is_reported) === 1 ? 'Так' : 'Ні'
      ].join(';'));
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trip_records_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Експортовано записів: ${records.length}`, 'success');
  } catch (e) {
    showToast(`Помилка експорту: ${e.message}`, 'error');
  }
}

// ---------- Активний рейс ----------
async function loadActiveTripBanner() {
  const container = $('activeTripContainer');
  if (!container) return;

  try {
    const { activeTrip, activeDeliveries } = await api('/api/trips/active');
    activeTripId = activeTrip ? activeTrip.id : null;

    if (!activeTrip) {
      container.innerHTML = `
        <div class="no-trip-banner">
          <span style="font-size:0.85rem; color:var(--text-muted);">Активного рейсу немає — нові записи не прив’язуватимуться до рейсу</span>
          <button class="btn btn-primary" style="padding:5px 10px; font-size:0.8rem;" data-action="open-new-trip">+ Почати рейс</button>
        </div>`;
      return;
    }

    const count = activeDeliveries.length;
    const delText = count > 0
      ? `<span style="font-size:0.8rem;">▲ ${count} відкрит${count === 1 ? 'а' : 'их'} доставк${count === 1 ? 'а' : 'и'}</span>`
      : '<span style="font-size:0.8rem; opacity:0.8;">Немає активних доставок</span>';

    container.innerHTML = `
      <div class="active-trip-banner">
        <div class="active-trip-info">
          <span class="active-trip-label">🚛 Активний рейс:</span>
          <span class="active-trip-name" title="${escapeHtml(activeTrip.name)}">${escapeHtml(activeTrip.name)}</span>
          <span style="font-size:0.78rem; opacity:0.9;">з ${escapeHtml(activeTrip.start_date)} ${escapeHtml(activeTrip.start_time)}</span>
          ${delText}
        </div>
        <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.8rem; flex-shrink:0;"
                data-action="open-complete-trip" data-trip-id="${escapeHtml(activeTrip.id)}"
                data-trip-name="${escapeHtml(activeTrip.name)}">🏁 Завершити</button>
      </div>`;
  } catch (e) {
    container.innerHTML = '';
  }
}

async function populateTripSelectors() {
  try {
    const trips = await api('/api/trips');
    ['filterTrip', 'analyticsTripSelect', 'reportTripSelect'].forEach(id => {
      const sel = $(id);
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">Всі рейси</option>';
      trips.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `#${t.id} ${t.name}${t.status === 'active' ? ' 🟢' : ''}`;
        sel.appendChild(opt);
      });
      if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
    });
  } catch (e) {
    console.warn('Не вдалося завантажити список рейсів', e.message);
  }
}

function onActionChanged() {
  const action = (val('action') || '').toLowerCase();
  const cargoWrap = $('cargoFieldWrap');
  const unloadWrap = $('unloadDeliveryFieldWrap');

  const isLoad = action.includes('загруз') || action.includes('завантаж');
  const isUnload = action.includes('вигруз') || action.includes('розвантаж');

  if (cargoWrap) cargoWrap.style.display = isLoad ? 'block' : 'none';
  if (unloadWrap) {
    unloadWrap.style.display = isUnload ? 'block' : 'none';
    if (isUnload) loadOpenDeliveries();
  }
}

async function loadOpenDeliveries() {
  const sel = $('unloadDeliverySelect');
  if (!sel) return;
  try {
    const { activeDeliveries } = await api('/api/trips/active');
    sel.innerHTML = '<option value="">Авто: остання відкрита доставка</option>';
    (activeDeliveries || []).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `#${d.id} ${d.cargo || 'Вантаж'} (з ${d.load_location || '?'}, ${d.load_date || ''})`;
      sel.appendChild(opt);
    });
  } catch (e) {
    sel.innerHTML = '<option value="">Авто: остання відкрита доставка</option>';
  }
}

// ---------- Рейси: модалки ----------
function openNewTripModal() {
  const now = new Date();
  const fmt = (n) => String(n).padStart(2, '0');
  if ($('newTripDate')) $('newTripDate').value = `${now.getFullYear()}-${fmt(now.getMonth() + 1)}-${fmt(now.getDate())}`;
  if ($('newTripTime')) $('newTripTime').value = `${fmt(now.getHours())}:${fmt(now.getMinutes())}`;
  if ($('newTripName')) $('newTripName').value = '';
  if ($('newTripOdometer')) $('newTripOdometer').value = lastKnownOdometer || '';
  if ($('newTripNotes')) $('newTripNotes').value = '';
  openModal('newTripModal');
}

async function submitNewTrip(e) {
  e.preventDefault();
  const btn = $('newTripSubmitBtn');
  const name = (val('newTripName') || '').trim();
  if (!name) return;

  btn.disabled = true;
  btn.textContent = 'Збереження...';

  try {
    await api('/api/trips', {
      method: 'POST',
      body: JSON.stringify({
        name,
        start_date: val('newTripDate'),
        start_time: val('newTripTime'),
        start_odometer: val('newTripOdometer') || null,
        notes: val('newTripNotes')
      })
    });
    btn.disabled = false;
    btn.textContent = 'Почати рейс';
    closeModal('newTripModal');
    showToast('🚀 Новий рейс відкрито', 'success');
    await loadActiveTripBanner();
    await populateTripSelectors();
    loadTripsReport();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Почати рейс';
    showToast(`Помилка: ${e.message}`, 'error', 5000);
  }
}

function openCompleteTripModal(tripId, tripName) {
  const now = new Date();
  const fmt = (n) => String(n).padStart(2, '0');
  if ($('completeTripId')) $('completeTripId').value = tripId;
  if ($('completeTripPrompt')) $('completeTripPrompt').textContent = `Завершити рейс «${tripName || ''}»?`;
  if ($('completeTripDate')) $('completeTripDate').value = `${now.getFullYear()}-${fmt(now.getMonth() + 1)}-${fmt(now.getDate())}`;
  if ($('completeTripTime')) $('completeTripTime').value = `${fmt(now.getHours())}:${fmt(now.getMinutes())}`;
  if ($('completeTripOdometer')) $('completeTripOdometer').value = lastKnownOdometer || '';
  if ($('completeTripNotes')) $('completeTripNotes').value = '';
  openModal('completeTripModal');
}

async function submitCompleteTrip(e) {
  e.preventDefault();
  const btn = $('completeTripSubmitBtn');
  const id = val('completeTripId');
  if (!id) return;

  btn.disabled = true;
  btn.textContent = 'Завершення...';

  try {
    const data = await api(`/api/trips/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        end_date: val('completeTripDate'),
        end_time: val('completeTripTime'),
        end_odometer: val('completeTripOdometer') || null,
        notes: val('completeTripNotes')
      })
    });
    btn.disabled = false;
    btn.textContent = 'Завершити рейс';
    closeModal('completeTripModal');

    let msg = '🏁 Рейс завершено';
    if (data.closedDeliveries > 0) msg += `. Незавершених доставок: ${data.closedDeliveries}`;
    showToast(msg, 'success', 5000);

    await loadActiveTripBanner();
    await populateTripSelectors();
    loadTripsReport();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Завершити рейс';
    showToast(`Помилка: ${e.message}`, 'error', 5000);
  }
}

function openEditTripModal(tripId) {
  const trip = reportTripsCache.get(Number(tripId));
  if (!trip) return;
  $('editTripId').value = trip.id;
  $('editTripName').value = trip.name || '';
  $('editTripDate').value = trip.start_date || '';
  $('editTripTime').value = trip.start_time || '';
  $('editTripOdometer').value = trip.start_odometer || '';
  $('editTripNotes').value = trip.notes || '';
  openModal('editTripModal');
}

async function submitEditTrip(e) {
  e.preventDefault();
  const id = val('editTripId');
  if (!id) return;
  try {
    await api(`/api/trips/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: val('editTripName'),
        start_date: val('editTripDate'),
        start_time: val('editTripTime'),
        start_odometer: val('editTripOdometer') || null,
        notes: val('editTripNotes')
      })
    });
    closeModal('editTripModal');
    showToast('Рейс оновлено', 'success');
    await populateTripSelectors();
    loadTripsReport();
  } catch (e) {
    showToast(`Помилка: ${e.message}`, 'error', 5000);
  }
}

async function deleteTrip() {
  const id = val('editTripId');
  if (!id) return;
  const trip = reportTripsCache.get(Number(id));
  const withRecords = window.confirm(
    `Видалити рейс «${trip ? trip.name : id}»?\n\nOK — видалити разом із записами рейсу\nСкасувати — залишити записи (вони стануть «без рейсу»)`
  );

  try {
    await api(`/api/trips/${id}?with_records=${withRecords ? 1 : 0}`, { method: 'DELETE' });
    closeModal('editTripModal');
    showToast('Рейс видалено', 'success');
    await loadActiveTripBanner();
    await populateTripSelectors();
    loadTripsReport();
  } catch (e) {
    showToast(`Помилка видалення: ${e.message}`, 'error');
  }
}

async function deleteDelivery(id) {
  if (!window.confirm('Видалити цю доставку? Записи залишаться, але без прив’язки до доставки.')) return;
  try {
    await api(`/api/deliveries/${id}`, { method: 'DELETE' });
    showToast('Доставку видалено', 'success');
    loadTripsReport();
  } catch (e) {
    showToast(`Помилка: ${e.message}`, 'error');
  }
}

// ---------- Ієрархічний звіт ----------
const reportTripsCache = new Map();

async function loadTripsReport() {
  const container = $('tripsReportContainer');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Завантаження рейсів...</div>';

  try {
    const tripFilter = val('reportTripSelect');
    const query = tripFilter ? `?trip_id=${encodeURIComponent(tripFilter)}` : '';
    const data = await api(`/api/report${query}`);

    // Кешуємо всі записи, щоб редагування працювало з будь-якої вкладки
    data.records.forEach(r => recordsCache.set(r.id, r));
    data.unassigned.forEach(r => recordsCache.set(r.id, r));

    reportTripsCache.clear();
    const byTrip = new Map();
    data.trips.forEach(t => {
      const item = { ...t, deliveries: [], allRecords: [] };
      reportTripsCache.set(t.id, item);
      byTrip.set(t.id, item);
    });
    data.deliveries.forEach(d => {
      const trip = byTrip.get(d.trip_id);
      if (trip) trip.deliveries.push(d);
    });
    data.records.forEach(r => {
      const trip = byTrip.get(r.trip_id);
      if (trip) trip.allRecords.push(r);
    });

    renderTripsReport(data.trips.map(t => byTrip.get(t.id)), data.unassigned);
  } catch (e) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--danger);">${escapeHtml(e.message)}</div>`;
  }
}

function renderTripsReport(trips, unassigned) {
  const container = $('tripsReportContainer');
  if (!container) return;

  const unassignedHtml = (unassigned && unassigned.length > 0) ? `
    <div class="trip-card expanded" style="border-color: var(--warning);">
      <div class="trip-card-header" data-action="toggle-collapse" data-target="unassigned_card" role="button" tabindex="0">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px;">
            <strong style="font-size:1rem;">⚠️ Записи без рейсу</strong>
            <span class="badge badge-open">${unassigned.length}</span>
          </div>
          <div style="font-size:0.82rem; color:var(--text-muted);">
            Створені, коли активного рейсу не було. Натисніть ✏️, щоб прив’язати до рейсу.
          </div>
        </div>
        <span style="font-size:1rem; color:var(--text-muted);">▼</span>
      </div>
      <div class="trip-card-body" id="unassigned_card">
        ${unassigned.map(r => `
          <div class="shift-event-row">
            <div style="flex:1; min-width:0;">
              <b>${escapeHtml(r.date)} ${escapeHtml(r.time)}</b> — ${escapeHtml(r.action)}
              ${r.odometer ? ` · ${fmtNum(r.odometer)} км` : ''}
              ${r.location ? ` · ${escapeHtml(r.location)}` : ''}
            </div>
            <button class="btn btn-secondary" style="padding:3px 7px; font-size:0.78rem;"
                    data-action="open-edit" data-id="${escapeHtml(r.id)}" title="Прив’язати до рейсу" aria-label="Редагувати запис">✏️</button>
          </div>
        `).join('')}
      </div>
    </div>` : '';

  if (!trips || trips.length === 0) {
    container.innerHTML = unassignedHtml + `
      <div style="text-align:center; padding:60px 20px;">
        <div style="font-size:3rem; margin-bottom:12px;">🚛</div>
        <p style="color:var(--text-muted); margin-bottom:16px;">Рейсів ще немає. Почніть перший рейс!</p>
        <button class="btn btn-primary" data-action="open-new-trip">+ Новий рейс</button>
      </div>`;
    return;
  }

  let html = '';
  trips.forEach((trip) => {
    const records = trip.allRecords || [];
    const deliveries = trip.deliveries || [];
    const isActive = trip.status === 'active';

    let tripKm = '';
    if (trip.start_odometer && trip.end_odometer) {
      const km = Number(trip.end_odometer) - Number(trip.start_odometer);
      if (km > 0) tripKm = `<span style="font-weight:600; color:var(--primary);">🛣️ ${fmtNum(km)} км</span>`;
    }

    const tripBadge = isActive
      ? '<span class="badge badge-open">🟢 Активний</span>'
      : '<span class="badge badge-closed">✅ Завершений</span>';

    const unassignedInTrip = records.filter(r => !r.delivery_id);
    const unassignedShifts = groupIntoShifts(unassignedInTrip);

    const totalRec = records.length;
    const reportedRec = records.filter(r => Number(r.is_reported) === 1).length;
    const reportBadge = totalRec > 0 && reportedRec === totalRec
      ? `<span class="badge badge-reported-yes">Звіт: ✅ ${reportedRec}/${totalRec}</span>`
      : `<span class="badge badge-reported-no">Звіт: ⏳ ${reportedRec}/${totalRec}</span>`;

    html += `
      <div class="trip-card" id="trip_card_${trip.id}">
        <div class="trip-card-header" data-action="toggle-collapse" data-target="trip_body_${trip.id}" role="button" tabindex="0">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:4px;">
              <strong style="font-size:1rem;">#${escapeHtml(trip.id)} — ${escapeHtml(trip.name)}</strong>
              ${tripBadge}
              ${reportBadge}
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted); display:flex; flex-wrap:wrap; gap:10px;">
              <span>📅 ${escapeHtml(trip.start_date)} ${escapeHtml(trip.start_time)}${trip.end_date ? ` → ${escapeHtml(trip.end_date)} ${escapeHtml(trip.end_time || '')}` : ''}</span>
              ${tripKm}
              <span>📦 ${deliveries.length} доставок | 📝 ${totalRec} записів</span>
            </div>
            ${trip.notes ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:3px; font-style:italic;">${escapeHtml(trip.notes)}</div>` : ''}
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            ${isActive ? `<button class="btn btn-secondary" style="padding:5px 10px; font-size:0.8rem;"
                data-action="open-complete-trip" data-trip-id="${escapeHtml(trip.id)}">🏁 Завершити</button>` : ''}
            <button class="btn btn-secondary" style="padding:5px 8px; font-size:0.8rem;"
                    data-action="open-edit-trip" data-trip-id="${escapeHtml(trip.id)}" title="Редагувати рейс" aria-label="Редагувати рейс">✏️</button>
            <span style="font-size:1rem; color:var(--text-muted);">▼</span>
          </div>
        </div>

        <div class="trip-card-body" id="trip_body_${trip.id}">
          ${deliveries.length === 0 && unassignedShifts.length === 0
            ? '<div style="padding:20px; text-align:center; color:var(--text-muted);">Записів у цьому рейсі ще немає</div>'
            : ''}

          ${deliveries.map((del) => {
            const delRecords = records.filter(r => r.delivery_id === del.id);
            const isDelivered = del.status === 'delivered';
            const isIncomplete = del.status === 'incomplete';
            const delRep = delRecords.filter(r => Number(r.is_reported) === 1).length;
            const delShifts = groupIntoShifts(delRecords);
            const delKm = del.load_odometer && del.unload_odometer
              ? ` | 🛣️ ${fmtNum(Number(del.unload_odometer) - Number(del.load_odometer))} км`
              : '';

            const statusBadge = isDelivered
              ? '<span class="badge badge-closed">✅ Доставлено</span>'
              : isIncomplete
                ? '<span class="badge badge-reported-no">⚠️ Не завершено</span>'
                : '<span class="badge badge-open">🚚 В дорозі</span>';

            return `
              <div class="delivery-card" id="delivery_${del.id}">
                <div class="delivery-header" data-action="toggle-collapse" data-target="delivery_body_${del.id}" role="button" tabindex="0">
                  <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-bottom:2px;">
                      <span style="font-weight:600;">📦 ${escapeHtml(del.cargo || 'Вантаж')}</span>
                      ${statusBadge}
                      ${delRecords.length > 0 && delRep === delRecords.length
                        ? '<span class="badge badge-reported-yes">Звіт: ✅</span>'
                        : `<span class="badge badge-reported-no">Звіт: ⏳ ${delRep}/${delRecords.length}</span>`}
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted);">
                      ${del.load_location ? `📍 З: ${escapeHtml(del.load_location)}` : ''}
                      ${del.load_date ? `(${escapeHtml(del.load_date)} ${escapeHtml(del.load_time || '')})` : ''}
                      ${del.unload_location ? ` → ${escapeHtml(del.unload_location)}` : ''}
                      ${del.unload_date ? `(${escapeHtml(del.unload_date)})` : ''}
                      ${delKm}
                    </div>
                  </div>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <button class="btn btn-secondary" style="padding:3px 7px; font-size:0.75rem; color:var(--danger);"
                            data-action="delete-delivery" data-delivery-id="${escapeHtml(del.id)}" title="Видалити доставку" aria-label="Видалити доставку">🗑️</button>
                    <span style="font-size:0.9rem; color:var(--text-muted);">▼</span>
                  </div>
                </div>

                <div class="delivery-body" id="delivery_body_${del.id}">
                  ${delShifts.length === 0
                    ? '<div style="padding:10px; color:var(--text-muted); font-size:0.85rem;">Записів немає</div>'
                    : delShifts.map((sh, si) => renderShiftBlock(sh, `d${del.id}_s${si}`)).join('')
                  }
                </div>
              </div>`;
          }).join('')}

          ${unassignedShifts.length > 0 ? `
            <div style="margin-top: 10px;">
              <div style="font-size:0.82rem; color:var(--text-muted); padding: 6px 4px; border-top: 1px solid var(--border); margin-bottom:6px;">⚙️ Записи поза доставками (зміни, паузи тощо)</div>
              ${unassignedShifts.map((sh, si) => renderShiftBlock(sh, `t${trip.id}_u${si}`)).join('')}
            </div>` : ''}
        </div>
      </div>`;
  });

  container.innerHTML = unassignedHtml + html;

  const firstCard = container.querySelector('.trip-card');
  if (firstCard) firstCard.classList.add('expanded');
}

function groupIntoShifts(records) {
  const items = [];
  let currentShift = null;

  function addStandalone(r) {
    const existing = items.find(it => it.type === 'day' && it.date === r.date);
    if (existing) existing.events.push(r);
    else items.push({ type: 'day', date: r.date, events: [r] });
  }

  records.forEach(r => {
    const act = (r.action || '').toLowerCase();

    if (act.includes('відкрив зміну')) {
      if (currentShift) items.push(currentShift);
      currentShift = { type: 'shift', open: r, close: null, events: [r] };
      return;
    }
    if (act.includes('закрив зміну')) {
      if (currentShift) {
        currentShift.close = r;
        currentShift.events.push(r);
        items.push(currentShift);
        currentShift = null;
      } else {
        addStandalone(r);
      }
      return;
    }

    // Захист від «безкінечної» зміни: подія іншого дня закриває попередню
    if (currentShift && r.date !== currentShift.open.date) {
      items.push(currentShift);
      currentShift = null;
    }

    if (currentShift) currentShift.events.push(r);
    else addStandalone(r);
  });

  if (currentShift) items.push(currentShift);
  return items.reverse();
}

function renderShiftBlock(item, uid) {
  const eventIds = item.events.map(e => e.id);
  const reportedCount = item.events.filter(e => Number(e.is_reported) === 1).length;
  const totalCount = item.events.length;
  const isAllReported = totalCount > 0 && reportedCount === totalCount;

  let title = '';
  let badgeClass = '';
  let badgeText = '';
  let metaText = '';

  const shiftReportBadge = isAllReported
    ? '<span class="badge badge-reported-yes">Звіт: ✅</span>'
    : `<span class="badge badge-reported-no">Звіт: ⏳ ${reportedCount}/${totalCount}</span>`;

  if (item.type === 'shift') {
    if (item.open && item.close) {
      title = `${escapeHtml(item.open.date)} (${escapeHtml(item.open.time)} – ${escapeHtml(item.close.time)})`;
      badgeClass = 'badge-closed';
      badgeText = 'Закрита зміна';
      let odoDiff = '';
      if (item.open.odometer && item.close.odometer) {
        const diff = Number(item.close.odometer) - Number(item.open.odometer);
        if (!isNaN(diff) && diff >= 0) odoDiff = ` | Пробіг: <b>${fmtNum(diff)} км</b>`;
      }
      metaText = `Записів: ${totalCount}${odoDiff}`;
    } else {
      title = `Зміна від ${escapeHtml(item.open.date)} ${escapeHtml(item.open.time)}`;
      badgeClass = 'badge-open';
      badgeText = '⏳ В процесі';
      metaText = `Записів: ${totalCount}`;
    }
  } else {
    title = `📅 ${escapeHtml(item.date)}`;
    badgeClass = 'badge-day';
    badgeText = 'Поза зміною';
    metaText = `Записів: ${totalCount}`;
  }

  return `
    <div class="shift-card" id="shift_${uid}">
      <div class="shift-header" data-action="toggle-collapse" data-target="shift_body_${uid}" role="button" tabindex="0">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-bottom:3px;">
            <strong>${title}</strong>
            <span class="badge ${badgeClass}">${badgeText}</span>
            ${shiftReportBadge}
          </div>
          <div style="font-size:0.8rem; color:var(--text-muted);">${metaText}</div>
        </div>
        <span style="font-size:0.9rem; color:var(--text-muted); padding-left:6px;">▼</span>
      </div>
      <div class="shift-body" id="shift_body_${uid}">
        <div class="shift-bulk-actions">
          <button class="btn btn-secondary" style="padding:5px 9px; font-size:0.78rem;"
                  data-action="bulk-report" data-ids="${eventIds.join(',')}" data-status="1">✅ Здати звіт за зміну</button>
          <button class="btn btn-secondary" style="padding:5px 9px; font-size:0.78rem;"
                  data-action="bulk-report" data-ids="${eventIds.join(',')}" data-status="0">⏳ Зняти позначку</button>
        </div>
        ${item.events.map(ev => {
          const evReported = Number(ev.is_reported) === 1;
          return `
            <div class="shift-event-row">
              <div style="flex:1; min-width:0;">
                <b>${escapeHtml(ev.action)}</b> <span style="color:var(--text-muted);">(${escapeHtml(ev.time)})</span>
                ${ev.odometer ? ` — <span style="color:var(--primary);">${fmtNum(ev.odometer)} км</span>` : ''}
                ${ev.location ? ` | ${escapeHtml(ev.location)}` : ''}
                ${ev.comment ? `<div style="color:var(--text-muted); font-size:0.8rem; white-space:pre-line; margin-top:2px;">${escapeHtml(ev.comment)}</div>` : ''}
                ${ev.coords && String(ev.coords).includes(',') ? `<div style="margin-top:2px;"><a href="https://www.google.com/maps?q=${encodeURIComponent(ev.coords)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary); font-size:0.78rem;">🗺️ GPS (${escapeHtml(ev.coords)})</a></div>` : ''}
              </div>
              <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                <button id="report_item_badge_${ev.id}" class="btn-report-toggle ${evReported ? 'badge-reported-yes' : 'badge-reported-no'}"
                        data-action="toggle-report-status" data-id="${escapeHtml(ev.id)}" data-next="${evReported ? 0 : 1}"
                        title="Змінити статус звіту">${evReported ? 'Звіт: ✅' : 'Звіт: ⏳'}</button>
                <button class="btn btn-secondary" style="padding:3px 7px; font-size:0.78rem;"
                        data-action="open-edit" data-id="${escapeHtml(ev.id)}" title="Редагувати" aria-label="Редагувати запис">✏️</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ---------- Аналітика ----------
function setAnalyticsPeriod(period, btnElement) {
  analyticsCurrentPeriod = period;
  const pills = document.querySelectorAll('.period-pills .pill-btn');
  pills.forEach(p => {
    p.classList.remove('active');
    if (p.dataset.period === period) p.classList.add('active');
  });
  if (btnElement) btnElement.classList.add('active');

  const now = new Date();
  const formatDate = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  const from = new Date(now);
  if (period === '7d') {
    from.setDate(now.getDate() - 6);
    if ($('analyticsDateFrom')) $('analyticsDateFrom').value = formatDate(from);
    if ($('analyticsDateTo')) $('analyticsDateTo').value = formatDate(now);
  } else if (period === '30d') {
    from.setDate(now.getDate() - 29);
    if ($('analyticsDateFrom')) $('analyticsDateFrom').value = formatDate(from);
    if ($('analyticsDateTo')) $('analyticsDateTo').value = formatDate(now);
  } else if (period === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    if ($('analyticsDateFrom')) $('analyticsDateFrom').value = formatDate(first);
    if ($('analyticsDateTo')) $('analyticsDateTo').value = formatDate(now);
  } else {
    if ($('analyticsDateFrom')) $('analyticsDateFrom').value = '';
    if ($('analyticsDateTo')) $('analyticsDateTo').value = '';
  }

  loadAnalytics();
}

function applyCustomAnalyticsDates() {
  document.querySelectorAll('.period-pills .pill-btn').forEach(p => p.classList.remove('active'));
  const from = val('analyticsDateFrom');
  const to = val('analyticsDateTo');
  if (from && to && from > to) {
    showToast('Дата «від» більша за дату «до»', 'warning');
    return;
  }
  loadAnalytics();
}

function getChartThemeColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    textColor: isDark ? '#94a3b8' : '#64748b',
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
    cardBg: isDark ? '#1e293b' : '#ffffff',
    tooltipBg: isDark ? '#0f172a' : '#1e293b'
  };
}

function showAnalyticsMessage(text) {
  const el = $('analyticsMessage');
  if (!el) return;
  if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = text;
  el.style.display = 'block';
}

async function loadAnalytics() {
  const hasChart = typeof Chart !== 'undefined';
  if (!hasChart) {
    showAnalyticsMessage('Бібліотека графіків не завантажилась. Перезавантажте сторінку.');
  } else {
    showAnalyticsMessage('');
  }

  const params = new URLSearchParams();
  const dateFrom = val('analyticsDateFrom');
  const dateTo = val('analyticsDateTo');
  const tripId = val('analyticsTripSelect');
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (tripId) params.set('trip_id', tripId);

  try {
    const records = await api(`/api/records/all?${params.toString()}`);
    if (!Array.isArray(records)) {
      showAnalyticsMessage(records && records.error ? records.error : 'Не вдалося отримати дані');
      return;
    }
    if (!hasChart) return;
    renderAnalyticsDashboard(records);
  } catch (err) {
    showAnalyticsMessage(`Не вдалося завантажити аналітику: ${err.message}`);
  }
}

function renderAnalyticsDashboard(records) {
  const theme = getChartThemeColors();

  let totalMileage = 0;
  const dailyMileageMap = {};
  const actionsCountMap = {};
  const locationsCountMap = {};
  let reportedCount = 0;
  let cargoLoads = 0;
  let cargoUnloads = 0;

  const odoRecords = records
    .filter(r => r.odometer !== null && r.odometer !== '' && !isNaN(r.odometer) && Number(r.odometer) > 0)
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const shifts = groupIntoShifts(records);
  const closedShiftsList = shifts.filter(s => s.type === 'shift' && s.open && s.close);
  let totalShiftHours = 0;
  const shiftDurations = [];
  const shiftLabels = [];

  closedShiftsList.forEach(s => {
    if (s.open.odometer && s.close.odometer) {
      const diff = Number(s.close.odometer) - Number(s.open.odometer);
      if (diff > 0 && diff <= MAX_DAILY_KM) {
        dailyMileageMap[s.open.date] = (dailyMileageMap[s.open.date] || 0) + diff;
        totalMileage += diff;
      }
    }
    const start = new Date(`${s.open.date}T${s.open.time}:00`);
    const end = new Date(`${s.close.date}T${s.close.time}:00`);
    const diffHrs = (end - start) / 3600000;
    if (diffHrs > 0 && diffHrs < 48) {
      totalShiftHours += diffHrs;
      shiftDurations.push(parseFloat(diffHrs.toFixed(1)));
      shiftLabels.push(`${s.open.date.slice(5)} (${s.open.time})`);
    }
  });

  // Фолбек: якщо змін немає — рахуємо за послідовними показаннями одометра
  const hasShifts = closedShiftsList.length > 0;
  if (!hasShifts && odoRecords.length > 1) {
    for (let i = 1; i < odoRecords.length; i++) {
      const diff = Number(odoRecords[i].odometer) - Number(odoRecords[i - 1].odometer);
      if (diff > 0 && diff <= MAX_DAILY_KM) {
        dailyMileageMap[odoRecords[i].date] = (dailyMileageMap[odoRecords[i].date] || 0) + diff;
        totalMileage += diff;
      }
    }
  }

  records.forEach(r => {
    if (Number(r.is_reported) === 1) reportedCount++;
    const act = (r.action || 'Інше').trim();
    actionsCountMap[act] = (actionsCountMap[act] || 0) + 1;
    const actLower = act.toLowerCase();
    if (actLower.includes('загруз') || actLower.includes('завантаж')) cargoLoads++;
    if (actLower.includes('вигруз') || actLower.includes('розвантаж')) cargoUnloads++;
    if (r.location && r.location.trim()) {
      const loc = r.location.trim();
      locationsCountMap[loc] = (locationsCountMap[loc] || 0) + 1;
    }
  });

  if ($('kpiMileage')) $('kpiMileage').textContent = `${fmtNum(totalMileage)} км`;
  if ($('kpiShifts')) $('kpiShifts').textContent = String(shifts.length);
  if ($('kpiShiftsSub')) $('kpiShiftsSub').textContent = `${closedShiftsList.length} закритих змін`;
  if ($('kpiCargo')) $('kpiCargo').textContent = String(cargoLoads + cargoUnloads);
  if ($('kpiCargoSub')) $('kpiCargoSub').textContent = `${cargoLoads} заг / ${cargoUnloads} виг`;

  const reportRate = records.length > 0 ? Math.round((reportedCount / records.length) * 100) : 0;
  if ($('kpiReportRate')) $('kpiReportRate').textContent = `${reportRate}%`;
  if ($('kpiReportRateSub')) $('kpiReportRateSub').textContent = `${reportedCount} із ${records.length} записів`;

  const avgShiftHours = closedShiftsList.length > 0 ? (totalShiftHours / closedShiftsList.length).toFixed(1) : '0';
  if ($('shiftsAvgSubtitle')) $('shiftsAvgSubtitle').textContent = `середнє: ${avgShiftHours} год`;

  const sortedDates = Object.keys(dailyMileageMap).sort();
  const mileageValues = sortedDates.map(d => dailyMileageMap[d]);
  const formattedDates = sortedDates.map(d => d.slice(5));

  const ctxMileage = $('chartMileage');
  if (ctxMileage) {
    if (chartMileageInstance) chartMileageInstance.destroy();
    chartMileageInstance = new Chart(ctxMileage, {
      type: 'bar',
      data: {
        labels: formattedDates.length > 0 ? formattedDates : ['Немає даних'],
        datasets: [{
          label: 'Пробіг (км)',
          data: mileageValues.length > 0 ? mileageValues : [0],
          backgroundColor: 'rgba(37, 99, 235, 0.75)',
          hoverBackgroundColor: 'rgba(37, 99, 235, 1)',
          borderColor: '#2563eb',
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 36
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: theme.tooltipBg, callbacks: { label: (ctx) => `Пробіг: ${ctx.parsed.y} км` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: theme.textColor, font: { size: 11 } } },
          y: {
            grid: { color: theme.gridColor },
            ticks: { color: theme.textColor, font: { size: 11 }, callback: v => `${v} км` },
            beginAtZero: true
          }
        }
      }
    });
  }

  const actionLabels = Object.keys(actionsCountMap);
  const actionValues = actionLabels.map(k => actionsCountMap[k]);
  const actionColors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#64748b'];

  const ctxActions = $('chartActions');
  if (ctxActions) {
    if (chartActionsInstance) chartActionsInstance.destroy();
    chartActionsInstance = new Chart(ctxActions, {
      type: 'doughnut',
      data: {
        labels: actionLabels.length > 0 ? actionLabels : ['Немає записів'],
        datasets: [{
          data: actionValues.length > 0 ? actionValues : [1],
          backgroundColor: actionColors.slice(0, Math.max(actionLabels.length, 1)),
          borderWidth: 2,
          borderColor: theme.cardBg
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { color: theme.textColor, font: { size: 11 }, boxWidth: 14 } },
          tooltip: { backgroundColor: theme.tooltipBg }
        }
      }
    });
  }

  const ctxDurations = $('chartShiftsDuration');
  if (ctxDurations) {
    if (chartShiftsDurationInstance) chartShiftsDurationInstance.destroy();
    const last12Durations = shiftDurations.slice(-12);
    const last12Labels = shiftLabels.slice(-12);

    chartShiftsDurationInstance = new Chart(ctxDurations, {
      type: 'bar',
      data: {
        labels: last12Labels.length > 0 ? last12Labels : ['Немає закритих змін'],
        datasets: [{
          label: 'Тривалість (год)',
          data: last12Durations.length > 0 ? last12Durations : [0],
          backgroundColor: 'rgba(16, 185, 129, 0.75)',
          hoverBackgroundColor: 'rgba(16, 185, 129, 1)',
          borderColor: '#10b981',
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 32
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: theme.tooltipBg, callbacks: { label: (ctx) => `Тривалість: ${ctx.parsed.y} год` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: theme.textColor, font: { size: 10 } } },
          y: {
            grid: { color: theme.gridColor },
            ticks: { color: theme.textColor, font: { size: 11 }, callback: v => `${v} год` },
            beginAtZero: true
          }
        }
      }
    });
  }

  const sortedLocations = Object.entries(locationsCountMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const ctxLoc = $('chartLocations');
  if (ctxLoc) {
    if (chartLocationsInstance) chartLocationsInstance.destroy();
    chartLocationsInstance = new Chart(ctxLoc, {
      type: 'bar',
      data: {
        labels: sortedLocations.length > 0 ? sortedLocations.map(e => e[0]) : ['Немає збережених локацій'],
        datasets: [{
          label: 'Візитів',
          data: sortedLocations.length > 0 ? sortedLocations.map(e => e[1]) : [0],
          backgroundColor: 'rgba(139, 92, 246, 0.75)',
          hoverBackgroundColor: 'rgba(139, 92, 246, 1)',
          borderColor: '#8b5cf6',
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: 24
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: theme.tooltipBg, callbacks: { label: (ctx) => `Кількість подій: ${ctx.parsed.x}` } }
        },
        scales: {
          x: {
            grid: { color: theme.gridColor },
            ticks: { color: theme.textColor, font: { size: 11 }, precision: 0 },
            beginAtZero: true
          },
          y: { grid: { display: false }, ticks: { color: theme.textColor, font: { size: 11 } } }
        }
      }
    });
  }
}

// =========================================================
// ДЕЛЕГОВАНІ ПОДІЇ
// =========================================================
const clickActions = {
  'switch-tab': (el) => switchTab(el.dataset.tab),
  'sync-offline': () => syncOfflineQueue(),
  'toggle-theme': () => toggleTheme(),
  'logout': () => handleLogout(),
  'gps-retry': () => fetchGPS(),
  'toggle-form-report': () => toggleFormReportStatus(),
  'toggle-edit-report': () => toggleEditReportStatus(),
  'reset-filters': () => resetTableFilters(),
  'export-csv': () => exportToCSV(),
  'open-import': () => openImportModal(),
  'send-import': () => sendBulkImport(),
  'reload-table': () => reloadTable(true),
  'load-more': (el) => loadMoreRecords(Number(el.dataset.limit) || 30),
  'period': (el) => setAnalyticsPeriod(el.dataset.period, el),
  'custom-period': () => applyCustomAnalyticsDates(),
  'load-analytics': () => loadAnalytics(),
  'load-report': () => loadTripsReport(),
  'open-new-trip': () => openNewTripModal(),
  'open-complete-trip': (el) => {
    const id = Number(el.dataset.tripId);
    const trip = reportTripsCache.get(id);
    const name = el.dataset.tripName || (trip ? trip.name : '');
    openCompleteTripModal(id, name);
  },
  'open-edit-trip': (el) => openEditTripModal(el.dataset.tripId),
  'delete-trip': () => deleteTrip(),
  'delete-delivery': (el) => deleteDelivery(Number(el.dataset.deliveryId)),
  'open-edit': (el) => openEditModalById(el.dataset.id),
  'save-edit': () => saveEdit(),
  'delete-from-modal': () => deleteFromModal(),
  'confirm-delete': (el) => confirmDeleteRecord(el.dataset.id),
  'execute-delete': () => executeDeleteRecord(),
  'toggle-report-status': (el) => toggleReportStatus(Number(el.dataset.id), Number(el.dataset.next)),
  'bulk-report': (el) => {
    const ids = (el.dataset.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
    bulkSetReportStatus(ids, Number(el.dataset.status));
  },
  'close-modal': (el) => closeModal(el.dataset.modal),
  'toggle-collapse': (el) => {
    const target = $(el.dataset.target);
    if (!target) return;
    const card = target.classList.contains('trip-card-body')
      ? target.parentElement
      : target.closest('.trip-card, .delivery-card, .shift-card') || target;
    card.classList.toggle('expanded');
  }
};

const changeActions = {
  'reload-table': () => reloadTable(true),
  'load-report': () => loadTripsReport(),
  'load-analytics': () => loadAnalytics(),
  'custom-period': () => applyCustomAnalyticsDates(),
  'action-changed': () => onActionChanged()
};

const inputActions = {
  'table-search': () => onSearchInputChanged(),
  'odometer-input': () => checkOdometerInput()
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // Поля вводу обробляємо через change/input, а не click
  if (['SELECT', 'INPUT', 'TEXTAREA'].includes(el.tagName)) return;
  const handler = clickActions[el.dataset.action];
  if (!handler) return;
  e.preventDefault();
  e.stopPropagation();
  handler(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = changeActions[el.dataset.action];
  if (handler) handler(el, e);
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = inputActions[el.dataset.action];
  if (handler) handler(el, e);
});

// Клавіатурна доступність для рольових елементів
document.addEventListener('keydown', (e) => {
  const el = e.target.closest('[role="switch"], [role="button"]');
  if (!el) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.click();
  }
});

// Закриття модалок: Esc + клік по фону
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal')].find(m => m.style.display === 'flex');
  if (open) closeModal(open.id);
});
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal')) {
    closeModal(e.target.id);
  }
});

// Форми
document.addEventListener('submit', (e) => {
  if (e.target.id === 'loginForm') {
    e.preventDefault();
    handleLogin();
  } else if (e.target.id === 'tripForm') {
    submitRecordForm(e);
  } else if (e.target.id === 'newTripForm') {
    submitNewTrip(e);
  } else if (e.target.id === 'completeTripForm') {
    submitCompleteTrip(e);
  } else if (e.target.id === 'editTripForm') {
    submitEditTrip(e);
  }
});

// Онлайн/офлайн
window.addEventListener('online', () => { updateNetworkStatus(); syncOfflineQueue(); });
window.addEventListener('offline', () => { updateNetworkStatus(); });

// Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('ServiceWorker не зареєстровано:', err.message);
    });
  });
}

// ---------- Старт ----------
(async function boot() {
  initTheme();
  updateNetworkStatus();

  try {
    await api('/api/session');
    showApp();
  } catch (e) {
    showLogin();
  }
})();

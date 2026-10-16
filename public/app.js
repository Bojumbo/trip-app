// State
let token = localStorage.getItem('trip_token');
let userCoords = '';
let currentOffset = 0;
let totalRecords = 0;
let lastKnownOdometer = null;
let actionsList = [];
const recordsCache = new Map();
let searchDebounceTimeout = null;
let isSyncingOffline = false;
let chartMileageInstance = null;
let chartActionsInstance = null;
let chartShiftsDurationInstance = null;
let chartLocationsInstance = null;
let analyticsCurrentPeriod = '30d';

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('ServiceWorker зареєстровано:', reg.scope))
      .catch((err) => console.log('ServiceWorker помилка:', err));
  });
}

// Online/Offline Listeners
window.addEventListener('online', () => {
  updateNetworkStatus();
  syncOfflineQueue();
});
window.addEventListener('offline', () => {
  updateNetworkStatus();
});

function updateNetworkStatus() {
  const banner = document.getElementById('offlineBanner');
  if (banner) {
    if (!navigator.onLine) {
      banner.classList.add('active');
    } else {
      banner.classList.remove('active');
    }
  }
}

// Escape HTML utility
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token
  };
}

// Theme handling
function initTheme() {
  const saved = localStorage.getItem('app_theme') || 'light';
  setTheme(saved);
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setTheme(isDark ? 'light' : 'dark');
}
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('app_theme', t);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerText = t === 'dark' ? '☀️' : '🌙';
  const meta = document.getElementById('themeMeta');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1e293b' : '#2563eb');
  if (document.getElementById('tabAnalytics') && document.getElementById('tabAnalytics').style.display !== 'none') {
    loadAnalytics();
  }
}

// Authentication
async function handleLogin() {
  const pwdInput = document.getElementById('loginPassword');
  const errDiv = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');
  errDiv.style.display = 'none';

  const pwd = pwdInput ? pwdInput.value.trim() : '';
  if (!pwd) {
    errDiv.innerText = 'Введіть пароль';
    errDiv.style.display = 'block';
    return;
  }

  loginBtn.disabled = true;
  loginBtn.innerText = 'Вхід...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();
    loginBtn.disabled = false;
    loginBtn.innerText = 'Увійти';

    if (data.success) {
      localStorage.setItem('trip_token', data.token);
      token = data.token;
      showApp();
    } else {
      errDiv.innerText = data.error || 'Невірний пароль';
      errDiv.style.display = 'block';
    }
  } catch (err) {
    loginBtn.disabled = false;
    loginBtn.innerText = 'Увійти';
    errDiv.innerText = 'Помилка зв’язку з сервером';
    errDiv.style.display = 'block';
  }
}

function handleLogout() {
  localStorage.removeItem('trip_token');
  location.reload();
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  initApp();
}

// Initialize Application
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
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dateInp = document.getElementById('dateInput');
  const timeInp = document.getElementById('timeInput');
  if (dateInp) dateInp.value = `${y}-${m}-${d}`;
  if (timeInp) timeInp.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// GPS Geolocation with HTTP warning and retry
function fetchGPS() {
  const txt = document.getElementById('geoStatusText');
  const dot = document.getElementById('geoDot');
  const retryBtn = document.getElementById('geoRetryBtn');

  if (dot) dot.className = 'dot';
  if (txt) txt.innerText = 'Визначення координат...';
  if (retryBtn) retryBtn.style.display = 'none';

  if (!navigator.geolocation) {
    if (txt) txt.innerText = 'GPS не підтримується цим браузером';
    return;
  }

  // Попередження для небезпечного протоколу HTTP на віддаленому сервері
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    if (txt) txt.innerText = 'Увага: GPS вимагає HTTPS для роботи на смартфонах';
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userCoords = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
      const cInp = document.getElementById('coords');
      if (cInp) cInp.value = userCoords;
      if (txt) txt.innerText = `GPS: ${userCoords}`;
      if (dot) dot.className = 'dot active';
      if (retryBtn) retryBtn.style.display = 'none';
    },
    (err) => {
      if (txt) txt.innerText = `GPS помилка: ${err.message}`;
      if (retryBtn) retryBtn.style.display = 'inline-block';
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// Load Actions Directory
async function loadActions() {
  try {
    const res = await fetch('/api/actions', { headers: authHeaders() });
    if (res.status === 401) return handleLogout();
    actionsList = await res.json();

    const s1 = document.getElementById('action');
    const s2 = document.getElementById('editAction');
    if (s1) s1.innerHTML = '<option value="" disabled selected>Оберіть дію...</option>';
    if (s2) s2.innerHTML = '';
    actionsList.forEach(a => {
      const opt = `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`;
      if (s1) s1.innerHTML += opt;
      if (s2) s2.innerHTML += opt;
    });
  } catch (e) {
    console.warn('Не вдалося завантажити довідник дій (можливо, офлайн)');
  }
}

// Load Last Odometer
async function loadLastOdometer() {
  try {
    const res = await fetch('/api/odometer/last', { headers: authHeaders() });
    if (res.status === 401) return handleLogout();
    const data = await res.json();
    const inp = document.getElementById('odometer');
    const hint = document.getElementById('lastOdoHint');
    if (data.lastOdometer !== undefined && data.lastOdometer !== '') {
      lastKnownOdometer = Number(data.lastOdometer);
      if (inp && !inp.value) inp.value = data.lastOdometer;
      if (hint) hint.innerText = `Попередній: ${escapeHtml(data.lastOdometer)} км`;
    } else {
      lastKnownOdometer = null;
      if (hint) hint.innerText = '';
    }
  } catch (e) {
    console.warn('Помилка оновлення останнього одометра');
  }
}

// Check Odometer Warning
function checkOdometerInput() {
  const inp = document.getElementById('odometer');
  const alertBox = document.getElementById('odoAlert');
  if (!inp || !alertBox) return;

  const currentVal = inp.value !== '' ? Number(inp.value) : null;
  if (currentVal !== null && lastKnownOdometer !== null && currentVal < lastKnownOdometer) {
    alertBox.innerText = `⚠️ Зверніть увагу: поточний пробіг (${currentVal}) менший за останній (${lastKnownOdometer} км)!`;
    alertBox.style.display = 'block';
  } else {
    alertBox.style.display = 'none';
  }
}

// Tabs switching
function switchTab(t) {
  ['form', 'report', 'table', 'analytics'].forEach(x => {
    const tabEl = document.getElementById(`tab${capitalize(x)}`);
    const tabBtn = document.getElementById(`tab${capitalize(x)}Btn`);
    if (tabEl) tabEl.style.display = (x === t ? 'block' : 'none');
    if (tabBtn) tabBtn.classList.toggle('active', x === t);
  });
  if (t === 'form') { loadLastOdometer(); loadActiveTripBanner(); }
  if (t === 'report') loadTripsReport();
  if (t === 'table') reloadTable(true);
  if (t === 'analytics') {
    if (!document.getElementById('analyticsDateFrom')?.value && !document.getElementById('analyticsDateTo')?.value) {
      setAnalyticsPeriod('30d');
    } else {
      loadAnalytics();
    }
  }
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// UI Toggles
function toggleFormReportStatus() {
  const chk = document.getElementById('formIsReported');
  chk.checked = !chk.checked;
  updateFormReportUI(chk.checked);
}
function updateFormReportUI(isChecked) {
  const card = document.getElementById('formReportCard');
  const text = document.getElementById('formReportText');
  if (card && text) {
    if (isChecked) {
      card.classList.add('checked');
      text.innerText = '✅ Звіт ЗДАНО';
      text.style.color = 'var(--success-text)';
    } else {
      card.classList.remove('checked');
      text.innerText = '⏳ Звіт НЕ здано';
      text.style.color = 'var(--warning)';
    }
  }
}

function toggleEditReportStatus() {
  const chk = document.getElementById('editIsReported');
  chk.checked = !chk.checked;
  updateEditReportUI(chk.checked);
}
function updateEditReportUI(isChecked) {
  const card = document.getElementById('editReportCard');
  const text = document.getElementById('editReportText');
  if (card && text) {
    if (isChecked) {
      card.classList.add('checked');
      text.innerText = '✅ Звіт ЗДАНО';
      text.style.color = 'var(--success-text)';
    } else {
      card.classList.remove('checked');
      text.innerText = '⏳ Звіт НЕ здано';
      text.style.color = 'var(--warning)';
    }
  }
}

// Offline Queue Management
function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem('trip_offline_queue') || '[]');
  } catch {
    return [];
  }
}
function saveOfflineQueue(queue) {
  localStorage.setItem('trip_offline_queue', JSON.stringify(queue));
  updateOfflineQueueBadge();
}
function updateOfflineQueueBadge() {
  const q = getOfflineQueue();
  const badge = document.getElementById('offlineCountBadge');
  if (badge) {
    if (q.length > 0) {
      badge.innerText = q.length;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }
}

async function syncOfflineQueue() {
  if (isSyncingOffline || !navigator.onLine || !token) return;
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  isSyncingOffline = true;
  let synced = 0;
  const remaining = [];

  for (const item of queue) {
    try {
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(item)
      });
      if (res.ok) {
        synced++;
      } else {
        remaining.push(item);
      }
    } catch (e) {
      remaining.push(item);
    }
  }

  saveOfflineQueue(remaining);
  isSyncingOffline = false;

  if (synced > 0) {
    showToast(`✅ Успішно синхронізовано ${synced} офлайн запис(ів)!`, 'success');
    loadLastOdometer();
  }
}

function showToast(text, type = 'success', duration = 3500) {
  const msg = document.getElementById('msg');
  if (!msg) return;
  msg.className = `toast ${type}`;
  msg.innerText = text;
  msg.style.display = 'block';
  setTimeout(() => { msg.style.display = 'none'; }, duration);
}

// Form Submission (Online with Offline Fallback)
document.getElementById('tripForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;

  const odoRaw = document.getElementById('odometer').value.trim();
  const payload = {
    date: document.getElementById('dateInput').value,
    time: document.getElementById('timeInput').value,
    odometer: odoRaw !== '' ? Number(odoRaw) : null,
    action: document.getElementById('action').value,
    location: document.getElementById('location').value,
    comment: document.getElementById('comment').value,
    coords: userCoords || document.getElementById('coords').value || '',
    is_reported: document.getElementById('formIsReported').checked ? 1 : 0,
    cargo: document.getElementById('cargoInput')?.value.trim() || '',
    delivery_id: document.getElementById('unloadDeliverySelect')?.value || null
  };

  function resetFormAfterSave() {
    document.getElementById('comment').value = '';
    document.getElementById('formIsReported').checked = false;
    updateFormReportUI(false);
    setNowDateTime();
    fetchGPS();
    // Reset delivery dynamic fields
    const cargoInp = document.getElementById('cargoInput');
    const cargoWrap = document.getElementById('cargoFieldWrap');
    const unloadWrap = document.getElementById('unloadDeliveryFieldWrap');
    if (cargoInp) cargoInp.value = '';
    if (cargoWrap) cargoWrap.style.display = 'none';
    if (unloadWrap) unloadWrap.style.display = 'none';
  }

  // Якщо пристрій офлайн — відразу зберігаємо в чергу
  if (!navigator.onLine) {
    const queue = getOfflineQueue();
    queue.push(payload);
    saveOfflineQueue(queue);
    btn.disabled = false;
    resetFormAfterSave();
    showToast('📡 Збережено офлайн! Запис відправиться автоматично при появі зв’язку.', 'warning', 4500);
    return;
  }

  try {
    const res = await fetch('/api/records', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    btn.disabled = false;

    if (data.success) {
      showToast('Запис успішно збережено в базі!', 'success');
      resetFormAfterSave();
      loadLastOdometer();
    } else {
      showToast('Помилка: ' + (data.error || 'Не вдалося зберегти'), 'error');
    }
  } catch (err) {
    // Мережева помилка при спробі відправки — зберігаємо в офлайн чергу
    btn.disabled = false;
    const queue = getOfflineQueue();
    queue.push(payload);
    saveOfflineQueue(queue);
    resetFormAfterSave();
    showToast('📡 Немає зв\'язку із сервером. Запис збережено локально для синхронізації.', 'warning', 4500);
  }
});

// Table Filtering and Pagination
function getFilterParams() {
  const search = document.getElementById('tableSearch')?.value.trim() || '';
  const dateFrom = document.getElementById('filterDateFrom')?.value || '';
  const dateTo = document.getElementById('filterDateTo')?.value || '';
  const isReported = document.getElementById('filterReportStatus')?.value || '';
  const tripId = document.getElementById('filterTrip')?.value || '';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (isReported !== '') params.set('is_reported', isReported);
  if (tripId) params.set('trip_id', tripId);
  return params;
}

function onSearchInputChanged() {
  clearTimeout(searchDebounceTimeout);
  searchDebounceTimeout = setTimeout(() => {
    reloadTable(true);
  }, 300);
}

function resetTableFilters() {
  if (document.getElementById('tableSearch')) document.getElementById('tableSearch').value = '';
  if (document.getElementById('filterDateFrom')) document.getElementById('filterDateFrom').value = '';
  if (document.getElementById('filterDateTo')) document.getElementById('filterDateTo').value = '';
  if (document.getElementById('filterReportStatus')) document.getElementById('filterReportStatus').value = '';
  reloadTable(true);
}

async function reloadTable(reset = true) {
  if (reset) {
    currentOffset = 0;
    const tb = document.getElementById('tableBody');
    if (tb) tb.innerHTML = '';
    recordsCache.clear();
  }
  await loadMoreRecords(30);
}

async function loadMoreRecords(limitCount) {
  try {
    const params = getFilterParams();
    params.set('limit', limitCount);
    params.set('offset', currentOffset);

    const res = await fetch(`/api/records?${params.toString()}`, { headers: authHeaders() });
    if (res.status === 401) return handleLogout();
    const data = await res.json();

    totalRecords = data.total;
    const cnt = document.getElementById('totalRecordsCount');
    if (cnt) cnt.innerText = totalRecords;

    const tbody = document.getElementById('tableBody');
    if (tbody) {
      if (currentOffset === 0 && data.records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:30px; color:var(--text-muted);">Записів не знайдено</td></tr>';
      } else {
        data.records.forEach(r => {
          recordsCache.set(r.id, r);
          tbody.innerHTML += renderTableRow(r);
        });
      }
    }

    currentOffset += data.records.length;
    const st = document.getElementById('tableLoadedStatus');
    if (st) st.innerText = `Показано ${Math.min(currentOffset, totalRecords)} із ${totalRecords} записів`;
    const lm = document.getElementById('loadMoreSection');
    if (lm) lm.style.display = (currentOffset >= totalRecords ? 'none' : 'flex');
  } catch (e) {
    console.error('Помилка завантаження таблиці', e);
  }
}

function renderTableRow(r) {
  const isReported = Number(r.is_reported) === 1;
  const reportedBadgeClass = isReported ? 'badge-reported-yes' : 'badge-reported-no';
  const reportedText = isReported ? '✅ Так' : '⏳ Ні';

  return `
    <tr id="row_${r.id}">
      <td><b>#${r.id}</b></td>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.time)}</td>
      <td>${r.odometer ? escapeHtml(r.odometer) + ' км' : '-'}</td>
      <td><span style="font-weight:600; color:var(--primary);">${escapeHtml(r.action)}</span></td>
      <td>${escapeHtml(r.location) || '-'}</td>
      <td style="white-space: pre-line;">${escapeHtml(r.comment) || '-'}</td>
      <td>
        ${r.coords && r.coords.includes(',') 
          ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(r.coords)}" target="_blank" rel="noopener" style="color:var(--primary); text-decoration:none;">🗺️ GPS</a>` 
          : '-'}
      </td>
      <td>
        <button class="btn-report-toggle ${reportedBadgeClass}" onclick="toggleReportStatus(${r.id}, ${isReported ? 0 : 1})" title="Натисніть для зміни">
          ${reportedText}
        </button>
      </td>
      <td>
        <div style="display:flex; gap:4px;">
          <button class="btn btn-secondary" style="padding:4px 8px; font-size:0.8rem;" onclick="openEditModalById(${r.id})" title="Редагувати">✏️</button>
          <button class="btn btn-secondary" style="padding:4px 8px; font-size:0.8rem; color:var(--danger);" onclick="confirmDeleteRecord(${r.id})" title="Видалити">🗑️</button>
        </div>
      </td>
    </tr>
  `;
}

// Single Report Status Toggle
async function toggleReportStatus(id, newStatus) {
  try {
    const res = await fetch(`/api/records/${id}/report-status`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ is_reported: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      const rec = recordsCache.get(id);
      if (rec) rec.is_reported = newStatus;

      const row = document.getElementById(`row_${id}`);
      if (row && rec) {
        row.outerHTML = renderTableRow(rec);
      }

      const itemBadge = document.getElementById(`report_item_badge_${id}`);
      if (itemBadge) {
        const isRep = newStatus === 1;
        itemBadge.className = `btn-report-toggle ${isRep ? 'badge-reported-yes' : 'badge-reported-no'}`;
        itemBadge.innerText = isRep ? 'Звіт: ✅' : 'Звіт: ⏳';
        itemBadge.onclick = () => toggleReportStatus(id, isRep ? 0 : 1);
      }
    } else {
      alert('Не вдалося оновити статус: ' + data.error);
    }
  } catch (e) {
    alert('Помилка оновлення статусу');
  }
}

// Bulk Report Status Toggle
async function bulkSetReportStatus(ids, newStatus) {
  if (!ids || ids.length === 0) return;
  try {
    const res = await fetch('/api/records/bulk-report-status', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ids, is_reported: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      ids.forEach(id => {
        const r = recordsCache.get(id);
        if (r) r.is_reported = newStatus;
      });
      // Оновити звіт рейсів, якщо вкладка звіту активна
      const reportTab = document.getElementById('tabReport');
      if (reportTab && reportTab.style.display !== 'none') {
        loadTripsReport();
      }
    } else {
      alert('Помилка масового оновлення: ' + data.error);
    }
  } catch (e) {
    alert('Помилка зв’язку з сервером');
  }
}

// Edit Modal
function openEditModalById(id) {
  const record = recordsCache.get(id);
  if (!record) return;

  document.getElementById('editId').value = record.id;
  document.getElementById('editDate').value = record.date;
  document.getElementById('editTime').value = record.time;
  document.getElementById('editOdometer').value = record.odometer || '';
  document.getElementById('editAction').value = record.action;
  document.getElementById('editLocation').value = record.location || '';
  document.getElementById('editComment').value = record.comment || '';
  document.getElementById('editCoords').value = record.coords || '';

  const isReported = Number(record.is_reported) === 1;
  document.getElementById('editIsReported').checked = isReported;
  updateEditReportUI(isReported);

  document.getElementById('editModal').style.display = 'flex';
}

function closeEditModal() {
  document.getElementById('editModal').style.display = 'none';
}

async function saveEdit() {
  const id = document.getElementById('editId').value;
  const odo = document.getElementById('editOdometer').value.trim();
  const payload = {
    date: document.getElementById('editDate').value,
    time: document.getElementById('editTime').value,
    odometer: odo !== '' ? Number(odo) : null,
    action: document.getElementById('editAction').value,
    location: document.getElementById('editLocation').value,
    comment: document.getElementById('editComment').value,
    coords: document.getElementById('editCoords').value.trim(),
    is_reported: document.getElementById('editIsReported').checked ? 1 : 0
  };

  try {
    const res = await fetch(`/api/records/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeEditModal();
      reloadTable(true);
      loadLastOdometer();
    } else {
      alert('Помилка збереження: ' + (data.error || 'Невідома помилка'));
    }
  } catch (e) {
    alert('Помилка підключення до сервера');
  }
}

// Deletion Confirmation Modal
let pendingDeleteId = null;
function confirmDeleteRecord(id) {
  pendingDeleteId = id;
  const text = document.getElementById('deleteConfirmText');
  if (text) text.innerText = `Ви дійсно бажаєте видалити запис #${id}?`;
  document.getElementById('deleteModal').style.display = 'flex';
}
function closeDeleteModal() {
  pendingDeleteId = null;
  document.getElementById('deleteModal').style.display = 'none';
}
async function executeDeleteRecord() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  closeDeleteModal();

  try {
    const res = await fetch(`/api/records/${id}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    const data = await res.json();
    if (data.success) {
      recordsCache.delete(id);
      reloadTable(true);
      loadLastOdometer();
    } else {
      alert('Помилка видалення: ' + data.error);
    }
  } catch (e) {
    alert('Помилка підключення до сервера');
  }
}

function deleteFromModal() {
  const id = Number(document.getElementById('editId').value);
  if (id) {
    closeEditModal();
    confirmDeleteRecord(id);
  }
}

// Bulk Import Modal
function openImportModal() {
  document.getElementById('importModal').style.display = 'flex';
  document.getElementById('importRawText').focus();
}
function closeImportModal() {
  document.getElementById('importModal').style.display = 'none';
  document.getElementById('importRawText').value = '';
}

async function sendBulkImport() {
  const text = document.getElementById('importRawText').value;
  if (!text.trim()) { alert('Будь ласка, вставте текст із таблиці'); return; }

  const btn = document.getElementById('importBtn');
  btn.disabled = true;
  btn.innerText = 'Імпортування...';

  try {
    const res = await fetch('/api/records/bulk-import', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ rawText: text })
    });
    const data = await res.json();

    btn.disabled = false;
    btn.innerText = 'Завантажити';

    if (data.success) {
      alert(`✅ Успішно додано ${data.count} записів!`);
      closeImportModal();
      reloadTable(true);
      loadLastOdometer();
    } else {
      alert('❌ Помилка: ' + data.error);
    }
  } catch (e) {
    btn.disabled = false;
    btn.innerText = 'Завантажити';
    alert('Помилка передачі даних для імпорту');
  }
}

// Shifts Report
async function loadShiftsReport() {
  const container = document.getElementById('shiftsContainer');
  container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">Завантаження звіту...</div>';

  try {
    const res = await fetch('/api/records/all', { headers: authHeaders() });
    if (res.status === 401) return handleLogout();
    const records = await res.json();
    records.forEach(r => recordsCache.set(r.id, r));
    renderShifts(groupIntoShifts(records));
  } catch (e) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--danger);">Помилка завантаження звіту</div>';
  }
}

function groupIntoShifts(records) {
  const items = [];
  let currentShift = null;

  function addStandalone(r) {
    const existing = items.find(it => it.type === 'day' && it.date === r.date);
    if (existing) {
      existing.events.push(r);
    } else {
      items.push({
        type: 'day',
        date: r.date,
        events: [r]
      });
    }
  }

  records.forEach(r => {
    const act = (r.action || '').toLowerCase();

    if (act.includes('відкрив зміну')) {
      if (currentShift) items.push(currentShift);
      currentShift = { type: 'shift', open: r, close: null, events: [r] };
    } else if (act.includes('закрив зміну')) {
      if (currentShift) {
        currentShift.close = r;
        currentShift.events.push(r);
        items.push(currentShift);
        currentShift = null;
      } else {
        addStandalone(r);
      }
    } else {
      if (currentShift) {
        currentShift.events.push(r);
      } else {
        addStandalone(r);
      }
    }
  });

  if (currentShift) items.push(currentShift);
  // Найновіші зміни показуємо вгорі
  return items.reverse();
}

function renderShifts(items) {
  const container = document.getElementById('shiftsContainer');
  if (items.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 40px;">Записів ще немає</div>';
    return;
  }

  let html = '';
  items.forEach((item, idx) => {
    let title = '';
    let badgeClass = '';
    let badgeText = '';
    let metaText = '';

    const eventIds = item.events.map(e => e.id);
    const reportedCount = item.events.filter(e => Number(e.is_reported) === 1).length;
    const totalCount = item.events.length;
    const isAllReported = totalCount > 0 && reportedCount === totalCount;

    const shiftReportStatusBadge = isAllReported 
      ? `<span class="badge badge-reported-yes">Звіт: ✅ Так</span>` 
      : `<span class="badge badge-reported-no">Звіт: ⏳ Ні (${reportedCount}/${totalCount})</span>`;

    if (item.type === 'shift') {
      const isOpen = item.open !== null;
      const isClosed = item.close !== null;

      if (isOpen && isClosed) {
        title = `${escapeHtml(item.open.date)} (${escapeHtml(item.open.time)} - ${escapeHtml(item.close.time)})`;
        badgeClass = 'badge-closed';
        badgeText = 'Закрита';
        let odoDiff = '';
        if (item.open.odometer && item.close.odometer) {
          const diff = Number(item.close.odometer) - Number(item.open.odometer);
          if (!isNaN(diff)) odoDiff = `| Пробіг: <b>${diff} км</b>`;
        }
        metaText = `Записів: ${totalCount} ${odoDiff}`;
      } else {
        title = `Зміна від ${escapeHtml(item.open.date)} ${escapeHtml(item.open.time)}`;
        badgeClass = 'badge-open';
        badgeText = 'В процесі ⏳';
        metaText = `Записів: ${totalCount}`;
      }
    } else {
      title = `📅 ${escapeHtml(item.date)}`;
      badgeClass = 'badge-day';
      badgeText = 'Поза зміною';
      metaText = `Записів: ${totalCount}`;
    }

    const idsJson = JSON.stringify(eventIds);

    html += `
      <div class="shift-card" id="shift_${idx}">
        <div class="shift-header" onclick="document.getElementById('shift_${idx}').classList.toggle('expanded')">
          <div style="flex: 1; min-width: 0;">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:4px;">
              <strong>${title}</strong> 
              <span class="badge ${badgeClass}">${badgeText}</span>
              ${shiftReportStatusBadge}
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted);">
              ${metaText}
            </div>
          </div>
          <div style="font-size: 1rem; color: var(--text-muted); padding-left: 6px;">▼</div>
        </div>
        <div class="shift-body">
          <div class="shift-bulk-actions">
            <button class="btn btn-secondary" style="padding:6px 10px; font-size:0.8rem;" onclick='event.stopPropagation(); bulkSetReportStatus(${idsJson}, 1)'>
              ✅ Здати звіт за зміну
            </button>
            <button class="btn btn-secondary" style="padding:6px 10px; font-size:0.8rem;" onclick='event.stopPropagation(); bulkSetReportStatus(${idsJson}, 0)'>
              ⏳ Зняти позначку здачі
            </button>
          </div>

          ${item.events.map(ev => {
            const evReported = Number(ev.is_reported) === 1;
            const evBadgeClass = evReported ? 'badge-reported-yes' : 'badge-reported-no';
            const evText = evReported ? 'Звіт: ✅' : 'Звіт: ⏳';

            return `
              <div style="padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 0.88rem; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                  <b>${escapeHtml(ev.action)}</b> (${escapeHtml(ev.time)}) — ${ev.odometer ? escapeHtml(ev.odometer) + ' км' : ''} ${ev.location ? '| ' + escapeHtml(ev.location) : ''}
                  ${ev.comment ? `<div style="color:var(--text-muted); font-size:0.82rem; white-space:pre-line; margin-top:2px;">${escapeHtml(ev.comment)}</div>` : ''}
                  ${ev.coords && ev.coords.includes(',') ? `
                    <div style="margin-top: 3px;">
                      <a href="https://www.google.com/maps?q=${encodeURIComponent(ev.coords)}" target="_blank" rel="noopener" style="color:var(--primary); text-decoration:none; font-size:0.78rem;">
                        🗺️ Мапа (${escapeHtml(ev.coords)})
                      </a>
                    </div>
                  ` : ''}
                </div>
                <div style="display:flex; align-items:center; gap:4px; flex-shrink: 0;">
                  <button id="report_item_badge_${ev.id}" class="btn-report-toggle ${evBadgeClass}" onclick="toggleReportStatus(${ev.id}, ${evReported ? 0 : 1})" title="Змінити статус">
                    ${evText}
                  </button>
                  <button class="btn btn-secondary" style="padding:4px 7px; font-size:0.8rem;" onclick="openEditModalById(${ev.id})" title="Редагувати">✏️</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

// CSV Export with UTF-8 BOM
async function exportToCSV() {
  try {
    const res = await fetch('/api/records/all', { headers: authHeaders() });
    const records = await res.json();
    if (!records || records.length === 0) {
      alert('Немає записів для експорту');
      return;
    }

    const headers = ['ID', 'Дата', 'Час', 'Одометр', 'Дія', 'Локація', 'Коментар', 'GPS', 'Звіт здано'];
    const csvRows = [headers.join(';')];

    records.forEach(r => {
      const row = [
        r.id,
        `"${(r.date || '').replace(/"/g, '""')}"`,
        `"${(r.time || '').replace(/"/g, '""')}"`,
        r.odometer !== null ? r.odometer : '',
        `"${(r.action || '').replace(/"/g, '""')}"`,
        `"${(r.location || '').replace(/"/g, '""')}"`,
        `"${(r.comment || '').replace(/"/g, '""')}"`,
        `"${(r.coords || '').replace(/"/g, '""')}"`,
        Number(r.is_reported) === 1 ? 'Так' : 'Ні'
      ];
      csvRows.push(row.join(';'));
    });

    const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trip_records_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Помилка експорту даних: ' + e.message);
  }
}

// ==========================================
// КЕРУВАННЯ РЕЙСАМИ — UI
// ==========================================

// Завантаження активного рейсу і відображення банера
async function loadActiveTripBanner() {
  const container = document.getElementById('activeTripContainer');
  if (!container) return;
  try {
    const res = await fetch('/api/trips/active', { headers: authHeaders() });
    if (res.status === 401) return handleLogout();
    const { activeTrip, activeDeliveries } = await res.json();

    if (!activeTrip) {
      container.innerHTML = '';
      return;
    }

    const delCount = activeDeliveries.length;
    const delText = delCount > 0
      ? `<span style="font-size:0.8rem; color:var(--warning);">▲ ${delCount} відкрит${delCount === 1 ? 'а' : 'их'} доставк${delCount === 1 ? 'а' : 'и'}</span>`
      : '<span style="font-size:0.8rem; color:var(--text-muted);">Немає активних доставок</span>';

    container.innerHTML = `
      <div class="active-trip-banner">
        <div class="active-trip-info">
          <span class="active-trip-label">🚛 Активний рейс:</span>
          <span class="active-trip-name">${escapeHtml(activeTrip.name)}</span>
          <span style="font-size:0.78rem; color:var(--text-muted);">з ${escapeHtml(activeTrip.start_date)} ${escapeHtml(activeTrip.start_time)}</span>
          ${delText}
        </div>
        <button class="btn btn-secondary" style="padding:5px 10px; font-size:0.8rem; flex-shrink:0;" onclick="openCompleteTripModal(${activeTrip.id}, '${escapeHtml(activeTrip.name).replace(/'/g, "\\'")}')">🏁 Завершити</button>
      </div>
    `;
  } catch (e) {
    console.warn('Помилка завантаження активного рейсу');
  }
}

// Заповнення селекторів рейсів (фільтри таблиці, аналітика, звіт)
async function populateTripSelectors() {
  try {
    const res = await fetch('/api/trips', { headers: authHeaders() });
    if (!res.ok) return;
    const trips = await res.json();

    const selectors = [
      document.getElementById('filterTrip'),
      document.getElementById('analyticsTripSelect'),
      document.getElementById('reportTripSelect')
    ];

    selectors.forEach(sel => {
      if (!sel) return;
      // Зберігаємо поточне значення
      const current = sel.value;
      sel.innerHTML = '<option value="">Всі рейси</option>';
      trips.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.text = `#${t.id} ${t.name}${t.status === 'active' ? ' 🟢' : ''}`;
        sel.appendChild(opt);
      });
      // Відновлюємо попереднє значення якщо воно ще існує
      if (current && sel.querySelector(`option[value="${current}"]`)) {
        sel.value = current;
      }
    });
  } catch (e) {
    console.warn('Помилка завантаження списку рейсів');
  }
}

// Дія 'onActionChanged' — показ/приховання полів вантажу і доставки
async function onActionChanged() {
  const action = (document.getElementById('action')?.value || '').toLowerCase();
  const cargoWrap = document.getElementById('cargoFieldWrap');
  const unloadWrap = document.getElementById('unloadDeliveryFieldWrap');

  const isLoad = action.includes('загруз') || action.includes('завантаж');
  const isUnload = action.includes('вигруз') || action.includes('розвантаж');

  if (cargoWrap) cargoWrap.style.display = isLoad ? 'block' : 'none';
  if (unloadWrap) {
    if (isUnload) {
      unloadWrap.style.display = 'block';
      await loadOpenDeliveries();
    } else {
      unloadWrap.style.display = 'none';
    }
  }
}

async function loadOpenDeliveries() {
  const sel = document.getElementById('unloadDeliverySelect');
  if (!sel) return;
  try {
    const res = await fetch('/api/trips/active', { headers: authHeaders() });
    const { activeDeliveries } = await res.json();
    sel.innerHTML = '<option value="">Автовизначення (перша відкрита)</option>';
    (activeDeliveries || []).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.text = `#${d.id} ${d.cargo || 'Вантаж'} (з ${d.load_location || '?'}, ${d.load_date || ''})`;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

// ==========================================
// РЕЙСИ — МОДАЛЬНІ ВІКНА
// ==========================================

function openNewTripModal() {
  const now = new Date();
  const fmt = (n) => String(n).padStart(2, '0');
  const todayDate = `${now.getFullYear()}-${fmt(now.getMonth() + 1)}-${fmt(now.getDate())}`;
  const todayTime = `${fmt(now.getHours())}:${fmt(now.getMinutes())}`;

  const nd = document.getElementById('newTripDate');
  const nt = document.getElementById('newTripTime');
  const nm = document.getElementById('newTripName');
  const no = document.getElementById('newTripOdometer');
  const nn = document.getElementById('newTripNotes');

  if (nd) nd.value = todayDate;
  if (nt) nt.value = todayTime;
  if (nm) nm.value = '';
  if (no) no.value = '';
  if (nn) nn.value = '';

  // Підтягнути поточний одометр як рекомендацію
  const hint = document.getElementById('lastOdoHint');
  if (hint && hint.innerText && no) {
    const match = hint.innerText.match(/(\d+)/);
    if (match) no.placeholder = `Попередній: ${match[1]} км`;
  }

  document.getElementById('newTripModal').style.display = 'flex';
  if (nm) nm.focus();
}

function closeNewTripModal() {
  document.getElementById('newTripModal').style.display = 'none';
}

async function submitNewTrip() {
  const btn = document.getElementById('newTripSubmitBtn');
  const name = document.getElementById('newTripName')?.value.trim();
  if (!name) return;

  btn.disabled = true;
  btn.innerText = 'Збереження...';

  try {
    const res = await fetch('/api/trips', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name,
        start_date: document.getElementById('newTripDate')?.value,
        start_time: document.getElementById('newTripTime')?.value,
        start_odometer: document.getElementById('newTripOdometer')?.value || null,
        notes: document.getElementById('newTripNotes')?.value || ''
      })
    });
    const data = await res.json();
    btn.disabled = false;
    btn.innerText = 'Почати рейс';

    if (data.success || data.id) {
      closeNewTripModal();
      showToast('🚀 Новий рейс відкрито!', 'success');
      await loadActiveTripBanner();
      await populateTripSelectors();
      loadTripsReport();
    } else {
      showToast('Помилка: ' + (data.error || 'Не вдалося відкрити рейс'), 'error', 4000);
    }
  } catch (e) {
    btn.disabled = false;
    btn.innerText = 'Почати рейс';
    showToast('Помилка підключення до сервера', 'error');
  }
}

function openCompleteTripModal(tripId, tripName) {
  const now = new Date();
  const fmt = (n) => String(n).padStart(2, '0');
  const todayDate = `${now.getFullYear()}-${fmt(now.getMonth() + 1)}-${fmt(now.getDate())}`;
  const todayTime = `${fmt(now.getHours())}:${fmt(now.getMinutes())}`;

  const idEl = document.getElementById('completeTripId');
  const pEl = document.getElementById('completeTripPrompt');
  const cd = document.getElementById('completeTripDate');
  const ct = document.getElementById('completeTripTime');
  const co = document.getElementById('completeTripOdometer');
  const cn = document.getElementById('completeTripNotes');

  if (idEl) idEl.value = tripId;
  if (pEl) pEl.innerText = `Завершити рейс: "${tripName}"?`;
  if (cd) cd.value = todayDate;
  if (ct) ct.value = todayTime;
  if (co) co.value = '';
  if (cn) cn.value = '';

  // Підтягнути поточний одометр
  const hint = document.getElementById('lastOdoHint');
  if (hint && hint.innerText && co) {
    const match = hint.innerText.match(/(\d+)/);
    if (match) co.placeholder = `Попередній: ${match[1]} км`;
  }

  document.getElementById('completeTripModal').style.display = 'flex';
}

function closeCompleteTripModal() {
  document.getElementById('completeTripModal').style.display = 'none';
}

async function submitCompleteTrip() {
  const btn = document.getElementById('completeTripSubmitBtn');
  const id = document.getElementById('completeTripId')?.value;
  if (!id) return;

  btn.disabled = true;
  btn.innerText = 'Завершення...';

  try {
    const res = await fetch(`/api/trips/${id}/complete`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        end_date: document.getElementById('completeTripDate')?.value,
        end_time: document.getElementById('completeTripTime')?.value,
        end_odometer: document.getElementById('completeTripOdometer')?.value || null,
        notes: document.getElementById('completeTripNotes')?.value || ''
      })
    });
    const data = await res.json();
    btn.disabled = false;
    btn.innerText = 'Завершити рейс';

    if (data.success) {
      closeCompleteTripModal();
      showToast('🏁 Рейс успішно завершено!', 'success');
      await loadActiveTripBanner();
      await populateTripSelectors();
      loadTripsReport();
    } else {
      showToast('Помилка: ' + (data.error || 'Не вдалося завершити рейс'), 'error', 4000);
    }
  } catch (e) {
    btn.disabled = false;
    btn.innerText = 'Завершити рейс';
    showToast('Помилка підключення до сервера', 'error');
  }
}

// ==========================================
// ІЄРАРХІЧНИЙ ЗВІТ: РЕЙСИ → ДОСТАВКИ → ЗМІНИ
// ==========================================

async function loadTripsReport() {
  const container = document.getElementById('tripsReportContainer');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Завантаження рейсів...</div>';

  try {
    const filterTripId = document.getElementById('reportTripSelect')?.value || '';

    // Завантажуємо список рейсів (або конкретний)
    let tripsRes;
    if (filterTripId) {
      // Деталі одного рейсу
      tripsRes = await fetch(`/api/trips/${filterTripId}/details`, { headers: authHeaders() });
      if (tripsRes.status === 401) return handleLogout();
      const detail = await tripsRes.json();
      if (detail.error) throw new Error(detail.error);
      renderTripsReport([{ ...detail.trip, deliveries: detail.deliveries, allRecords: detail.records }]);
    } else {
      // Усі рейси
      tripsRes = await fetch('/api/trips', { headers: authHeaders() });
      if (tripsRes.status === 401) return handleLogout();
      const trips = await tripsRes.json();

      // Деталі для кожного рейсу паралельно
      const details = await Promise.all(
        trips.map(t =>
          fetch(`/api/trips/${t.id}/details`, { headers: authHeaders() })
            .then(r => r.json())
            .then(d => ({ ...d.trip, deliveries: d.deliveries, allRecords: d.records }))
            .catch(() => ({ ...t, deliveries: [], allRecords: [] }))
        )
      );
      renderTripsReport(details);
    }
  } catch (e) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--danger);">Помилка завантаження: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTripsReport(trips) {
  const container = document.getElementById('tripsReportContainer');
  if (!trips || trips.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:60px 20px;">
        <div style="font-size:3rem; margin-bottom:12px;">🚛</div>
        <p style="color:var(--text-muted); margin-bottom:16px;">Рейсів ще немає. Почніть перший рейс!</p>
        <button class="btn btn-primary" onclick="openNewTripModal()">+ Новий рейс</button>
      </div>`;
    return;
  }

  let html = '';

  trips.forEach((trip, ti) => {
    const records = trip.allRecords || [];
    const deliveries = trip.deliveries || [];
    const isActive = trip.status === 'active';

    // Кілометраж рейсу
    let tripKm = '';
    if (trip.start_odometer && trip.end_odometer) {
      const km = Number(trip.end_odometer) - Number(trip.start_odometer);
      if (km > 0) tripKm = `<span style="font-weight:600; color:var(--primary);">🛣️ ${km.toLocaleString('uk-UA')} км</span>`;
    }

    const tripBadge = isActive
      ? '<span class="badge badge-open">🟢 Активний</span>'
      : '<span class="badge badge-closed">✅ Завершений</span>';

    // Знаходимо записи, що не належать жодній доставці
    const deliveryRecordIds = new Set();
    deliveries.forEach(d => {
      if (d.load_record_id) deliveryRecordIds.add(d.load_record_id);
      if (d.unload_record_id) deliveryRecordIds.add(d.unload_record_id);
    });
    // Всі записи що належать доставкам (за delivery_id)
    const recordsInDeliveries = new Set(records.filter(r => r.delivery_id).map(r => r.id));
    const unassignedRecords = records.filter(r => !r.delivery_id);

    // Групуємо незакріплені записи в зміни
    const unassignedShifts = groupIntoShifts(unassignedRecords);

    // Загальна кількість звіт
    const totalRec = records.length;
    const reportedRec = records.filter(r => Number(r.is_reported) === 1).length;
    const reportBadge = totalRec > 0 && reportedRec === totalRec
      ? `<span class="badge badge-reported-yes">Звіт: ✅ ${reportedRec}/${totalRec}</span>`
      : `<span class="badge badge-reported-no">Звіт: ⏳ ${reportedRec}/${totalRec}</span>`;

    html += `
      <div class="trip-card" id="trip_card_${trip.id}">
        <div class="trip-card-header" onclick="document.getElementById('trip_card_${trip.id}').classList.toggle('expanded')">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:4px;">
              <strong style="font-size:1rem;">#${trip.id} — ${escapeHtml(trip.name)}</strong>
              ${tripBadge}
              ${reportBadge}
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted); display:flex; flex-wrap:wrap; gap:10px;">
              <span>📅 ${escapeHtml(trip.start_date)} ${escapeHtml(trip.start_time)}${trip.end_date ? ' → ' + escapeHtml(trip.end_date) + ' ' + escapeHtml(trip.end_time) : ''}</span>
              ${tripKm}
              <span>📦 ${deliveries.length} доставок | 📝 ${totalRec} записів</span>
            </div>
            ${trip.notes ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:3px; font-style:italic;">${escapeHtml(trip.notes)}</div>` : ''}
          </div>
          <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
            ${isActive ? `<button class="btn btn-secondary" style="padding:5px 10px; font-size:0.8rem;" onclick="event.stopPropagation(); openCompleteTripModal(${trip.id}, '${escapeHtml(trip.name).replace(/'/g, "\\'")}')">🏁 Завершити</button>` : ''}
            <span style="font-size:1rem; color:var(--text-muted);">▼</span>
          </div>
        </div>

        <div class="trip-card-body">
          ${ deliveries.length === 0 && unassignedShifts.length === 0
            ? '<div style="padding:20px; text-align:center; color:var(--text-muted);">Записів у цьому рейсі ще немає</div>'
            : ''
          }

          <!-- ДОСТАВКИ -->
          ${deliveries.map((del, di) => {
            const delRecords = records.filter(r => r.delivery_id === del.id);
            const isDelivered = del.status === 'delivered';
            const delRep = delRecords.filter(r => Number(r.is_reported) === 1).length;

            // Групуємо записи доставки у зміни
            const delShifts = groupIntoShifts(delRecords);

            const delKm = del.load_odometer && del.unload_odometer
              ? ` | 🛣️ ${Number(del.unload_odometer) - Number(del.load_odometer)} км`
              : '';

            return `
              <div class="delivery-card" id="delivery_${del.id}">
                <div class="delivery-header" onclick="document.getElementById('delivery_${del.id}').classList.toggle('expanded')">
                  <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-bottom:2px;">
                      <span style="font-weight:600;">📦 ${escapeHtml(del.cargo || 'Вантаж')}</span>
                      <span class="badge ${isDelivered ? 'badge-closed' : 'badge-open'}">${isDelivered ? '✅ Доставлено' : '🚚 В дорозі'}</span>
                      ${delRep === delRecords.length && delRecords.length > 0
                        ? `<span class="badge badge-reported-yes">Звіт: ✅</span>`
                        : `<span class="badge badge-reported-no">Звіт: ⏳ ${delRep}/${delRecords.length}</span>`}
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted);">
                      ${del.load_location ? '📍 З: ' + escapeHtml(del.load_location) : ''}
                      ${del.load_date ? '(' + escapeHtml(del.load_date) + ' ' + escapeHtml(del.load_time || '') + ')' : ''}
                      ${del.unload_location ? ' → ' + escapeHtml(del.unload_location) : ''}
                      ${del.unload_date ? '(' + escapeHtml(del.unload_date) + ')' : ''}
                      ${delKm}
                    </div>
                  </div>
                  <span style="font-size:0.9rem; color:var(--text-muted);">▼</span>
                </div>

                <div class="delivery-body">
                  ${delShifts.length === 0
                    ? '<div style="padding:10px; color:var(--text-muted); font-size:0.85rem;">Записів немає</div>'
                    : delShifts.map((sh, si) => renderShiftBlock(sh, `d${del.id}_s${si}`)).join('')
                  }
                </div>
              </div>
            `;
          }).join('')}

          <!-- НЕЗАКРІПЛЕНІ ЗМІНИ (не в жодній доставці) -->
          ${unassignedShifts.length > 0 ? `
            <div style="margin-top: 10px;">
              <div style="font-size:0.82rem; color:var(--text-muted); padding: 6px 4px; border-top: 1px solid var(--border); margin-bottom:6px;">⚙️ Записи поза доставками (зміни, паузи тощо)</div>
              ${unassignedShifts.map((sh, si) => renderShiftBlock(sh, `t${trip.id}_u${si}`)).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // Автоматично розгортаємо перший (найновіший) рейс
  const firstCard = container.querySelector('.trip-card');
  if (firstCard) firstCard.classList.add('expanded');
}

function renderShiftBlock(item, uid) {
  const eventIds = item.events.map(e => e.id);
  const reportedCount = item.events.filter(e => Number(e.is_reported) === 1).length;
  const totalCount = item.events.length;
  const isAllReported = totalCount > 0 && reportedCount === totalCount;
  const idsJson = JSON.stringify(eventIds);

  let title = '';
  let badgeClass = '';
  let badgeText = '';
  let metaText = '';

  const shiftReportBadge = isAllReported
    ? `<span class="badge badge-reported-yes">Звіт: ✅</span>`
    : `<span class="badge badge-reported-no">Звіт: ⏳ ${reportedCount}/${totalCount}</span>`;

  if (item.type === 'shift') {
    const isClosed = item.close !== null;
    if (item.open && isClosed) {
      title = `${escapeHtml(item.open.date)} (${escapeHtml(item.open.time)} – ${escapeHtml(item.close.time)})`;
      badgeClass = 'badge-closed';
      badgeText = 'Закрита зміна';
      let odoDiff = '';
      if (item.open.odometer && item.close.odometer) {
        const diff = Number(item.close.odometer) - Number(item.open.odometer);
        if (!isNaN(diff) && diff >= 0) odoDiff = ` | Пробіг: <b>${diff} км</b>`;
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
      <div class="shift-header" onclick="document.getElementById('shift_${uid}').classList.toggle('expanded')">
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
      <div class="shift-body">
        <div class="shift-bulk-actions">
          <button class="btn btn-secondary" style="padding:5px 9px; font-size:0.78rem;" onclick='event.stopPropagation(); bulkSetReportStatus(${idsJson}, 1)'>✅ Здати звіт за зміну</button>
          <button class="btn btn-secondary" style="padding:5px 9px; font-size:0.78rem;" onclick='event.stopPropagation(); bulkSetReportStatus(${idsJson}, 0)'>⏳ Зняти позначку</button>
        </div>
        ${item.events.map(ev => {
          const evReported = Number(ev.is_reported) === 1;
          return `
            <div style="padding:8px 0; border-bottom:1px solid var(--border); font-size:0.87rem; display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
              <div style="flex:1; min-width:0;">
                <b>${escapeHtml(ev.action)}</b> <span style="color:var(--text-muted);">(${escapeHtml(ev.time)})</span>
                ${ev.odometer ? ` — <span style="color:var(--primary);">${escapeHtml(ev.odometer)} км</span>` : ''}
                ${ev.location ? ` | ${escapeHtml(ev.location)}` : ''}
                ${ev.comment ? `<div style="color:var(--text-muted); font-size:0.8rem; white-space:pre-line; margin-top:2px;">${escapeHtml(ev.comment)}</div>` : ''}
                ${ev.coords && ev.coords.includes(',') ? `<div style="margin-top:2px;"><a href="https://www.google.com/maps?q=${encodeURIComponent(ev.coords)}" target="_blank" rel="noopener" style="color:var(--primary); font-size:0.78rem;">🗺️ GPS (${escapeHtml(ev.coords)})</a></div>` : ''}
              </div>
              <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                <button id="report_item_badge_${ev.id}" class="btn-report-toggle ${evReported ? 'badge-reported-yes' : 'badge-reported-no'}" onclick="toggleReportStatus(${ev.id}, ${evReported ? 0 : 1})" title="Змінити статус">${evReported ? 'Звіт: ✅' : 'Звіт: ⏳'}</button>
                <button class="btn btn-secondary" style="padding:3px 7px; font-size:0.78rem;" onclick="openEditModalById(${ev.id})" title="Редагувати">✏️</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ==========================================
// АНАЛІТИКА ТА ГРАФІЧНИЙ ДАШБОРД (Chart.js)
// ==========================================

function setAnalyticsPeriod(period, btnElement) {
  analyticsCurrentPeriod = period;
  const pills = document.querySelectorAll('.period-pills .pill-btn');
  pills.forEach(p => p.classList.remove('active'));
  if (btnElement) {
    btnElement.classList.add('active');
  } else {
    const defaultBtn = document.querySelector(`.period-pills button[onclick*="'${period}'"]`);
    if (defaultBtn) defaultBtn.classList.add('active');
  }

  const now = new Date();
  const dateToInp = document.getElementById('analyticsDateTo');
  const dateFromInp = document.getElementById('analyticsDateFrom');

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  if (period === '7d') {
    const from = new Date(now);
    from.setDate(now.getDate() - 7);
    if (dateFromInp) dateFromInp.value = formatDate(from);
    if (dateToInp) dateToInp.value = formatDate(now);
  } else if (period === '30d') {
    const from = new Date(now);
    from.setDate(now.getDate() - 30);
    if (dateFromInp) dateFromInp.value = formatDate(from);
    if (dateToInp) dateToInp.value = formatDate(now);
  } else if (period === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    if (dateFromInp) dateFromInp.value = formatDate(from);
    if (dateToInp) dateToInp.value = formatDate(now);
  } else if (period === 'all') {
    if (dateFromInp) dateFromInp.value = '';
    if (dateToInp) dateToInp.value = '';
  }

  loadAnalytics();
}

function applyCustomAnalyticsDates() {
  const pills = document.querySelectorAll('.period-pills .pill-btn');
  pills.forEach(p => p.classList.remove('active'));
  loadAnalytics();
}

function getChartThemeColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    isDark,
    textColor: isDark ? '#94a3b8' : '#64748b',
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
    cardBg: isDark ? '#1e293b' : '#ffffff',
    tooltipBg: isDark ? '#0f172a' : '#1e293b'
  };
}

async function loadAnalytics() {
  if (typeof Chart === 'undefined') {
    console.warn('Очікування завантаження Chart.js...');
    return;
  }

  const dateFrom = document.getElementById('analyticsDateFrom')?.value || '';
  const dateTo = document.getElementById('analyticsDateTo')?.value || '';
  const tripId = document.getElementById('analyticsTripSelect')?.value || '';

  const params = new URLSearchParams();
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (tripId) params.set('trip_id', tripId);

  try {
    const res = await fetch(`/api/records/all?${params.toString()}`, { headers: authHeaders() });
    if (res.status === 401) return handleLogout();
    const records = await res.json();
    renderAnalyticsDashboard(records);
  } catch (err) {
    console.error('Помилка завантаження даних для аналітики:', err);
  }
}

function renderAnalyticsDashboard(records) {
  const theme = getChartThemeColors();

  // 1. РОЗРАХУНОК МЕТРИК
  let totalMileage = 0;
  const dailyMileageMap = {};
  const actionsCountMap = {};
  const locationsCountMap = {};
  let reportedCount = 0;
  let cargoLoads = 0;
  let cargoUnloads = 0;

  // Відсортовані хронологічно записи з одометром
  const odoRecords = records
    .filter(r => r.odometer !== null && r.odometer !== '' && !isNaN(r.odometer) && Number(r.odometer) > 0)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // Групуємо зміни
  const shifts = groupIntoShifts(records);
  let closedShifts = 0;
  let totalShiftHours = 0;
  const shiftDurations = [];
  const shiftLabels = [];

  shifts.forEach(s => {
    if (s.type === 'shift' && s.open && s.close) {
      closedShifts++;
      // Різниця одометра в зміні
      if (s.open.odometer && s.close.odometer) {
        const diff = Number(s.close.odometer) - Number(s.open.odometer);
        if (diff > 0 && diff < 3500) {
          const d = s.open.date;
          dailyMileageMap[d] = (dailyMileageMap[d] || 0) + diff;
          totalMileage += diff;
        }
      }
      // Тривалість зміни в годинах
      try {
        const dStart = new Date(`${s.open.date}T${s.open.time}:00`);
        const dEnd = new Date(`${s.close.date}T${s.close.time}:00`);
        let diffHrs = (dEnd - dStart) / (1000 * 60 * 60);
        if (diffHrs < 0) diffHrs += 24; // якщо перехід через північ
        if (diffHrs > 0 && diffHrs < 48) {
          totalShiftHours += diffHrs;
          shiftDurations.push(parseFloat(diffHrs.toFixed(1)));
          shiftLabels.push(`${s.open.date.slice(5)} (${s.open.time})`);
        }
      } catch (e) {}
    }
  });

  // Якщо змін не було або водій веде прості записи (без дій відкрив/закрив зміну)
  if (totalMileage === 0 && odoRecords.length > 1) {
    for (let i = 1; i < odoRecords.length; i++) {
      const diff = Number(odoRecords[i].odometer) - Number(odoRecords[i - 1].odometer);
      if (diff > 0 && diff < 3500) {
        const d = odoRecords[i].date;
        dailyMileageMap[d] = (dailyMileageMap[d] || 0) + diff;
        totalMileage += diff;
      }
    }
  }

  // Обробка кожної події
  records.forEach(r => {
    // Звіти
    if (Number(r.is_reported) === 1) reportedCount++;

    // Дії
    const act = (r.action || 'Інше').trim();
    actionsCountMap[act] = (actionsCountMap[act] || 0) + 1;

    const actLower = act.toLowerCase();
    if (actLower.includes('загруз') || actLower.includes('завантаж')) cargoLoads++;
    if (actLower.includes('вигруз') || actLower.includes('розвантаж')) cargoUnloads++;

    // Локації
    if (r.location && r.location.trim()) {
      const loc = r.location.trim();
      locationsCountMap[loc] = (locationsCountMap[loc] || 0) + 1;
    }
  });

  // 2. ОНОВЛЕННЯ KPI КАРТОК
  const kpiMilEl = document.getElementById('kpiMileage');
  if (kpiMilEl) kpiMilEl.innerText = `${totalMileage.toLocaleString('uk-UA')} км`;

  const kpiShiftsEl = document.getElementById('kpiShifts');
  const kpiShiftsSubEl = document.getElementById('kpiShiftsSub');
  if (kpiShiftsEl) kpiShiftsEl.innerText = shifts.length;
  if (kpiShiftsSubEl) kpiShiftsSubEl.innerText = `${closedShifts} закритих змін`;

  const kpiCargoEl = document.getElementById('kpiCargo');
  const kpiCargoSubEl = document.getElementById('kpiCargoSub');
  if (kpiCargoEl) kpiCargoEl.innerText = cargoLoads + cargoUnloads;
  if (kpiCargoSubEl) kpiCargoSubEl.innerText = `${cargoLoads} заг / ${cargoUnloads} виг`;

  const reportRate = records.length > 0 ? Math.round((reportedCount / records.length) * 100) : 0;
  const kpiRepEl = document.getElementById('kpiReportRate');
  const kpiRepSubEl = document.getElementById('kpiReportRateSub');
  if (kpiRepEl) kpiRepEl.innerText = `${reportRate}%`;
  if (kpiRepSubEl) kpiRepSubEl.innerText = `${reportedCount} із ${records.length} записів`;

  const avgShiftHours = closedShifts > 0 ? (totalShiftHours / closedShifts).toFixed(1) : 0;
  const avgShiftSub = document.getElementById('shiftsAvgSubtitle');
  if (avgShiftSub) avgShiftSub.innerText = `середнє: ${avgShiftHours} год`;

  // 3. ПОБУДОВА ГРАФІКІВ

  // ГРАФІК 1: Пробіг за днями (Bar/Line)
  const sortedDates = Object.keys(dailyMileageMap).sort();
  const mileageValues = sortedDates.map(d => dailyMileageMap[d]);
  const formattedDates = sortedDates.map(d => d.slice(5)); // MM-DD

  const ctxMileage = document.getElementById('chartMileage');
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
          tooltip: {
            backgroundColor: theme.tooltipBg,
            callbacks: {
              label: (ctx) => `Пробіг: ${ctx.parsed.y} км`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: theme.textColor, font: { size: 11 } }
          },
          y: {
            grid: { color: theme.gridColor },
            ticks: { color: theme.textColor, font: { size: 11 }, callback: v => v + ' км' },
            beginAtZero: true
          }
        }
      }
    });
  }

  // ГРАФІК 2: Розподіл дій (Doughnut)
  const actionLabels = Object.keys(actionsCountMap);
  const actionValues = actionLabels.map(k => actionsCountMap[k]);
  const actionColors = [
    '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
    '#ef4444', '#06b6d4', '#ec4899', '#64748b'
  ];

  const ctxActions = document.getElementById('chartActions');
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
          legend: {
            position: 'right',
            labels: { color: theme.textColor, font: { size: 11 }, boxWidth: 14 }
          },
          tooltip: {
            backgroundColor: theme.tooltipBg
          }
        }
      }
    });
  }

  // ГРАФІК 3: Тривалість змін (Bar)
  const ctxDurations = document.getElementById('chartShiftsDuration');
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
          tooltip: {
            backgroundColor: theme.tooltipBg,
            callbacks: {
              label: (ctx) => `Тривалість: ${ctx.parsed.y} год`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: theme.textColor, font: { size: 10 } }
          },
          y: {
            grid: { color: theme.gridColor },
            ticks: { color: theme.textColor, font: { size: 11 }, callback: v => v + ' год' },
            beginAtZero: true
          }
        }
      }
    });
  }

  // ГРАФІК 4: Топ локацій (Horizontal Bar)
  const sortedLocations = Object.entries(locationsCountMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const locLabels = sortedLocations.map(e => e[0]);
  const locValues = sortedLocations.map(e => e[1]);

  const ctxLoc = document.getElementById('chartLocations');
  if (ctxLoc) {
    if (chartLocationsInstance) chartLocationsInstance.destroy();
    chartLocationsInstance = new Chart(ctxLoc, {
      type: 'bar',
      data: {
        labels: locLabels.length > 0 ? locLabels : ['Немає збережених локацій'],
        datasets: [{
          label: 'Візитів',
          data: locValues.length > 0 ? locValues : [0],
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
          tooltip: {
            backgroundColor: theme.tooltipBg,
            callbacks: {
              label: (ctx) => `Кількість подій: ${ctx.parsed.x}`
            }
          }
        },
        scales: {
          x: {
            grid: { color: theme.gridColor },
            ticks: { color: theme.textColor, font: { size: 11 }, precision: 0 },
            beginAtZero: true
          },
          y: {
            grid: { display: false },
            ticks: { color: theme.textColor, font: { size: 11 } }
          }
        }
      }
    });
  }
}

// Initialize on page load if token exists
if (token) {
  showApp();
} else {
  initTheme();
}

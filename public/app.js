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
  ['form', 'report', 'table'].forEach(x => {
    const tabEl = document.getElementById(`tab${capitalize(x)}`);
    const tabBtn = document.getElementById(`tab${capitalize(x)}Btn`);
    if (tabEl) tabEl.style.display = (x === t ? 'block' : 'none');
    if (tabBtn) tabBtn.classList.toggle('active', x === t);
  });
  if (t === 'form') loadLastOdometer();
  if (t === 'report') loadShiftsReport();
  if (t === 'table') reloadTable(true);
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
    is_reported: document.getElementById('formIsReported').checked ? 1 : 0
  };

  function resetFormAfterSave() {
    document.getElementById('comment').value = '';
    document.getElementById('formIsReported').checked = false;
    updateFormReportUI(false);
    setNowDateTime();
    fetchGPS();
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

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (isReported !== '') params.set('is_reported', isReported);
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
      loadShiftsReport();
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

// Initialize on page load if token exists
if (token) {
  showApp();
} else {
  initTheme();
}

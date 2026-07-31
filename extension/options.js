// Cookie Share — Options Page (Management Panel)

const $ = (sel) => document.querySelector(sel);

// ============================================================
// Init
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  // Load settings (project id falls back to the gitignored local-config.json
  // so the committed source carries no private values).
  const { settings = {} } = await chrome.storage.local.get('settings');
  let localCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL('local-config.json'));
    if (r.ok) localCfg = await r.json();
  } catch {}
  $('#input-project').value = settings.gcpProjectId || localCfg.gcpProjectId || '';
  $('#input-interval').value = settings.periodicSyncMinutes || 15;
  $('#input-capture-incognito').checked = settings.captureIncognito === true;

  // Check auth status
  try {
    const token = await sendMessage({ type: 'authenticate' });
    if (!token.success) showAuthBanner();
  } catch {
    showAuthBanner();
  }

  // Event listeners
  $('#btn-add').addEventListener('click', handleAddDomain);
  $('#input-domain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddDomain();
  });
  $('#btn-sync-all').addEventListener('click', handleSyncAll);
  $('#btn-auth').addEventListener('click', handleAuth);
  $('#btn-save-settings').addEventListener('click', handleSaveSettings);
  $('#btn-export').addEventListener('click', handleExport);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', handleImport);
});

// ============================================================
// Refresh table
// ============================================================

async function refresh() {
  const { domains } = await sendMessage({ type: 'getDomains' });
  const { statuses } = await sendMessage({ type: 'getStatus' });

  const tbody = $('#domains-body');
  const empty = $('#empty-state');

  if (domains.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  tbody.innerHTML = domains.map(domain => {
    const s = statuses[domain] || {};
    const cookieCount = s.cookieCount ?? '—';
    const storageKeys = ((s.localStorageKeys || 0) + (s.sessionStorageKeys || 0)) || '—';
    const lastSync = s.lastSync ? timeAgo(s.lastSync) : 'never';
    const statusClass = s.error ? 'status-error' : s.lastSync ? 'status-ok' : 'status-pending';
    const statusText = s.error ? 'error' : s.lastSync ? 'ok' : 'pending';

    return `
      <tr>
        <td class="domain-cell">${escapeHtml(domain)}</td>
        <td>${cookieCount}</td>
        <td>${storageKeys}</td>
        <td>${lastSync}</td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>
          <button class="btn-icon" data-action="sync" data-domain="${escapeHtml(domain)}" title="Sync now">&#x21bb;</button>
          <button class="btn-danger" data-action="remove" data-domain="${escapeHtml(domain)}" title="Remove">&#x2715;</button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach action listeners
  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const domain = btn.dataset.domain;

      if (action === 'sync') {
        setButtonSpinner(btn);
        await sendMessage({ type: 'syncDomain', domain });
        await refresh();
      } else if (action === 'remove') {
        await sendMessage({ type: 'removeDomain', domain });
        await refresh();
      }
    });
  });
}

// ============================================================
// Actions
// ============================================================

async function handleAddDomain() {
  const input = $('#input-domain');
  const domain = input.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!domain) return;

  const btn = $('#btn-add');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    // Request host permission here (options page) — must be in user gesture context
    const granted = await chrome.permissions.request({
      origins: [`*://*.${domain}/*`, `*://${domain}/*`],
    });
    if (!granted) {
      alert('Permission denied by user');
      btn.disabled = false;
      btn.textContent = 'Add';
      return;
    }

    const resp = await sendMessage({ type: 'addDomain', domain });
    if (resp.error) {
      alert(resp.error);
    } else {
      input.value = '';
    }
  } catch (e) {
    alert('Failed to add domain: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = 'Add';
  await refresh();
}

async function handleSyncAll() {
  const btn = $('#btn-sync-all');
  setButtonSpinner(btn, 'Syncing...');
  btn.disabled = true;

  await sendMessage({ type: 'syncAll' });
  await refresh();

  btn.textContent = 'Sync All';
  btn.disabled = false;
}

async function handleAuth() {
  try {
    await sendMessage({ type: 'authenticate' });
    $('#auth-banner').classList.add('hidden');
  } catch (e) {
    alert('Authentication failed: ' + e.message);
  }
}

async function handleSaveSettings() {
  const settings = {
    gcpProjectId: $('#input-project').value.trim(),
    periodicSyncMinutes: parseInt($('#input-interval').value, 10) || 15,
    captureIncognito: $('#input-capture-incognito').checked,
  };
  await chrome.storage.local.set({ settings });
  await sendMessage({ type: 'settingsUpdated' }); // recreate the periodic alarm

  const btn = $('#btn-save-settings');
  btn.textContent = 'Saved';
  setTimeout(() => { btn.textContent = 'Save Settings'; }, 1500);
}

// Portable backup so a reinstall (which gets a new extension id and empty
// storage) doesn't lose the watched-domain list + settings.
async function handleExport() {
  const { state } = await sendMessage({ type: 'exportState' });
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cookie-share-state.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function handleImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const state = JSON.parse(await file.text());
    await sendMessage({ type: 'importState', state });
    await refresh();
    alert('Imported. Re-grant host permissions from the popup on each site if prompted.');
  } catch (err) {
    alert('Import failed: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

// ============================================================
// Helpers
// ============================================================

function showAuthBanner() {
  $('#auth-banner').classList.remove('hidden');
}

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function setButtonSpinner(btn, text) {
  btn.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  btn.appendChild(spinner);
  if (text) btn.appendChild(document.createTextNode(' ' + text));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

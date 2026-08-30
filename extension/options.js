// Cookie Share — Options Page (Management Panel)

const $ = (sel) => document.querySelector(sel);

let syncIntervalMin = 15;
const pendingRemoval = new Set(); // domains armed for a confirming second click

// ============================================================
// Init
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Project id falls back to the gitignored local-config.json so the committed
  // source carries no private values.
  const { settings = {} } = await chrome.storage.local.get('settings');
  let localCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL('local-config.json'));
    if (r.ok) localCfg = await r.json();
  } catch {}
  $('#input-project').value = settings.gcpProjectId || localCfg.gcpProjectId || '';
  syncIntervalMin = settings.periodicSyncMinutes || 15;
  $('#input-interval').value = syncIntervalMin;
  $('#input-capture-incognito').checked = settings.captureIncognito === true;

  await refresh();
  await refreshSetupState();

  $('#btn-add').addEventListener('click', handleAddDomain);
  $('#input-domain').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddDomain();
  });
  $('#input-domain').addEventListener('input', () => toggle('#add-error', false));
  $('#btn-sync-all').addEventListener('click', handleSyncAll);
  $('#btn-auth').addEventListener('click', handleAuth);
  $('#btn-auth-2').addEventListener('click', handleAuth);
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
    tbody.replaceChildren();
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Expiry per domain, so the table can warn about it too. The popup could
  // already show this; the page for managing many domains could not.
  const expiries = {};
  await Promise.all(domains.map(async (d) => {
    try { expiries[d] = await sendMessage({ type: 'getDomainExpiry', domain: d }); } catch {}
  }));

  tbody.replaceChildren(...domains.map(domain => {
    const s = statuses[domain] || {};
    const storageKeys = (s.localStorageKeys || 0) + (s.sessionStorageKeys || 0) + (s.indexedDBKeys || 0);
    const { cls, text } = statusFor(s, expiries[domain]);

    const tr = document.createElement('tr');
    tr.append(
      cell(domain, 'domain-cell'),
      cell(s.lastSync === undefined ? '—' : String(s.cookieCount ?? 0)),
      cell(s.lastSync === undefined ? '—' : String(storageKeys)),
      cell(s.lastSync === undefined ? '—' : String(s.authTokenCount ?? 0)),
      // "Last upload", not "last sync": an unchanged sync writes nothing.
      cell(s.lastSuccess ? timeAgo(s.lastSuccess) : (s.lastSync ? 'never uploaded' : 'never')),
    );

    const statusTd = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `status-pill ${cls}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    pill.append(dot, document.createTextNode(text));
    if (s.error) pill.title = s.error;
    statusTd.append(pill);
    tr.append(statusTd);

    const actions = document.createElement('td');
    actions.className = 'actions';
    actions.append(
      iconButton('↻', `Sync ${domain} now`, () => onSync(domain)),
      iconButton(pendingRemoval.has(domain) ? 'Confirm?' : '✕',
        pendingRemoval.has(domain) ? `Click again to stop syncing ${domain}` : `Stop syncing ${domain}`,
        () => onRemove(domain), pendingRemoval.has(domain) ? 'danger confirming' : 'danger'),
    );
    tr.append(actions);
    return tr;
  }));
}

function statusFor(s, expiry) {
  if (s.error) return { cls: 'error', text: 'failing' };
  if (!s.lastSync) return { cls: 'pending', text: 'pending' };
  if (expiry?.earliestExpiryMs && (expiry.earliestExpiryMs - expiry.nowMs) < expiry.warningThresholdMs) {
    return { cls: 'warn', text: 'expiring' };
  }
  const ageMin = (Date.now() - new Date(s.lastSync).getTime()) / 60000;
  if (ageMin > syncIntervalMin * 2 + 1) return { cls: 'warn', text: 'stale' };
  return { cls: 'ok', text: 'ok' };
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

// Icon-only controls need an accessible name; `title` alone is not one.
function iconButton(glyph, label, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.className = `btn-icon ${extraClass}`.trim();
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

async function onSync(domain) {
  clearStatus();
  await sendMessage({ type: 'syncDomain', domain });
  await refresh();
  const { statuses } = await sendMessage({ type: 'getStatus' });
  const s = statuses[domain] || {};
  setStatus(s.error ? `${domain}: ${s.error}` : `${domain} synced.`, s.error ? 'error' : 'ok');
}

// Two-step. Removal revokes permissions and cannot be undone, and it
// deliberately does NOT delete the stored secret — so say so.
async function onRemove(domain) {
  if (!pendingRemoval.has(domain)) {
    pendingRemoval.add(domain);
    await refresh();
    setStatus(`Click ✕ again to stop syncing ${domain}. The secret stored in Google will be kept.`, 'warn');
    return;
  }
  pendingRemoval.delete(domain);
  await sendMessage({ type: 'removeDomain', domain });
  await refresh();
  await refreshSetupState();
  setStatus(`Stopped syncing ${domain}. Its secret in Google was kept.`, 'ok');
}

// ============================================================
// Actions
// ============================================================

async function handleAddDomain() {
  const input = $('#input-domain');
  const raw = input.value.trim();
  if (!raw) return;

  const btn = $('#btn-add');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  toggle('#add-error', false);

  try {
    // Ask the background for the permission scope so both entry points request
    // the same thing. The popup used to walk every parent suffix here and could
    // request "*://*.co.uk/*"; this stops at the registrable domain.
    const scope = await sendMessage({ type: 'getOrigins', domain: raw });
    if (scope.error || !scope.origins) {
      showAddError(`"${raw}" is not a valid domain.`);
      return;
    }
    const granted = await chrome.permissions.request({ origins: scope.origins });
    if (!granted) {
      showAddError('Permission denied — the site was not added.');
      return;
    }
    const resp = await sendMessage({ type: 'addDomain', domain: scope.domain });
    if (resp.error) {
      showAddError(resp.error);
      return;
    }
    input.value = '';
    setStatus(`Now syncing ${resp.domain || scope.domain}.`, 'ok');
  } catch (e) {
    showAddError('Failed to add domain: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
    await refresh();
    await refreshSetupState();
  }
}

async function handleSyncAll() {
  const btn = $('#btn-sync-all');
  setButtonSpinner(btn, 'Syncing...');
  btn.disabled = true;
  clearStatus();

  // syncAll now reports real counts. It used to return {ok:true} no matter
  // what, so a run where every domain failed looked like a clean one.
  const res = await sendMessage({ type: 'syncAll' });
  await refresh();

  btn.textContent = 'Sync All';
  btn.disabled = false;

  if (!res || typeof res.total !== 'number') return;
  if (res.total === 0) setStatus('No domains to sync.', 'warn');
  else if (res.failed === 0) setStatus(`Synced ${res.ok} of ${res.total}.`, 'ok');
  else {
    const first = res.errors?.[0];
    setStatus(`${res.failed} of ${res.total} failed${first ? ` — ${first.domain}: ${first.error}` : ''}.`, 'error');
  }
}

async function handleAuth() {
  clearStatus();
  // The response carries {success:false} on failure and does NOT throw, so the
  // old catch-only check hid the banner even when sign-in had failed.
  const resp = await sendMessage({ type: 'authenticate' }).catch(e => ({ success: false, error: e.message }));
  if (resp?.success) {
    toggle('#auth-banner', false);
    setStatus('Signed in to Google.', 'ok');
  } else {
    $('#auth-banner-text').textContent = `Sign-in failed: ${resp?.error || 'unknown error'}`;
    toggle('#auth-banner', true);
    setStatus(resp?.error || 'Sign-in failed.', 'error');
  }
  await refreshSetupState();
}

async function handleSaveSettings() {
  const settings = {
    gcpProjectId: $('#input-project').value.trim(),
    periodicSyncMinutes: parseInt($('#input-interval').value, 10) || 15,
    captureIncognito: $('#input-capture-incognito').checked,
  };
  await chrome.storage.local.set({ settings });
  await sendMessage({ type: 'settingsUpdated' }); // recreate the periodic alarm
  syncIntervalMin = settings.periodicSyncMinutes;

  const btn = $('#btn-save-settings');
  btn.textContent = 'Saved';
  setTimeout(() => { btn.textContent = 'Save Settings'; }, 1500);
  await refresh();
  await refreshSetupState();
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
    const resp = await sendMessage({ type: 'importState', state });
    await refresh();
    await refreshSetupState();
    const skipped = resp?.rejected?.length
      ? ` ${resp.rejected.length} entry(s) skipped: ${resp.rejected.map(r => `${r.entry} (${r.reason})`).join(', ')}.`
      : '';
    setStatus(`Imported.${skipped} Re-grant host permissions from the popup on each site if prompted.`,
      resp?.rejected?.length ? 'warn' : 'ok');
  } catch (err) {
    setStatus('Import failed: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
}

// ============================================================
// Setup checklist
// ============================================================

async function refreshSetupState() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  let localCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL('local-config.json'));
    if (r.ok) localCfg = await r.json();
  } catch {}
  const hasProject = !!(settings.gcpProjectId || localCfg.gcpProjectId);
  const { domains } = await sendMessage({ type: 'getDomains' });
  const hasDomain = domains.length > 0;

  mark('#step-project', hasProject);
  mark('#step-domain', hasDomain);
  // Auth is not probed here: a silent check would either prompt or lie. It is
  // marked once the user signs in from this page.
  toggle('#setup-section', !(hasProject && hasDomain));
}

function mark(sel, done) {
  const li = $(sel);
  if (!li) return;
  li.classList.toggle('done', done);
  li.querySelector('.check').textContent = done ? '●' : '○';
}

// ============================================================
// Status line
// ============================================================

function setStatus(text, kind) {
  const el = $('#status-line');
  el.textContent = text;
  el.classList.remove('hidden', 'ok', 'error', 'warn');
  if (kind) el.classList.add(kind);
}
function clearStatus() {
  const el = $('#status-line');
  el.textContent = '';
  el.classList.add('hidden');
}
function showAddError(msg) {
  const el = $('#add-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// Helpers
// ============================================================

function toggle(sel, on) { $(sel).classList.toggle('hidden', !on); }

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

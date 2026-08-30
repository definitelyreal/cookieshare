// Cookie Share — Popup
// One-click domain add, honest status, and the command to read the session back.

const $ = (sel) => document.querySelector(sel);

let currentDomain = null;
let cachedOrigins = null;   // fetched at load so no await sits inside the click
let syncIntervalMin = 15;
let stopArmed = false;

// ============================================================
// Init
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentDomain = extractDomain(tab?.url);

  const [{ domains }, { statuses }, settings] = await Promise.all([
    sendMessage({ type: 'getDomains' }),
    sendMessage({ type: 'getStatus' }),
    chrome.storage.local.get('settings'),
  ]);
  syncIntervalMin = settings?.settings?.periodicSyncMinutes || 15;

  $('#domain-count').textContent = domains.length;

  if (currentDomain) {
    // Pre-fetch the permission scope now. chrome.permissions.request needs a
    // user gesture, and an await between the click and the call can lose it.
    const resp = await sendMessage({ type: 'getOrigins', domain: currentDomain }).catch(() => null);
    if (resp?.origins) cachedOrigins = resp.origins;
  }

  if (!currentDomain) {
    show('no-site-section');
  } else if (domains.includes(currentDomain)) {
    await showWatchedState(currentDomain, statuses[currentDomain]);
  } else {
    showAddState(currentDomain);
  }

  checkAuth();

  $('#btn-sync-site').addEventListener('click', handleAddDomain);
  $('#btn-sync-now').addEventListener('click', handleSyncNow);
  $('#btn-stop').addEventListener('click', handleStop);
  $('#btn-delete-secret').addEventListener('click', handleDeleteSecret);
  $('#btn-refresh-now').addEventListener('click', handleRefreshNow);
  $('#btn-signin').addEventListener('click', handleSignIn);
  $('#btn-copy-pull').addEventListener('click', handleCopyPull);
  $('#btn-copy-error').addEventListener('click', handleCopyError);
  $('#link-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });
});

// ============================================================
// UI states
// ============================================================

function show(sectionId) {
  ['add-section', 'status-section', 'no-site-section'].forEach(id => {
    $(`#${id}`).classList.add('hidden');
  });
  $(`#${sectionId}`).classList.remove('hidden');
}

function showAddState(domain) {
  $('#current-domain').textContent = domain;
  show('add-section');
  resetStopConfirm();
}

async function showWatchedState(domain, status) {
  $('#watched-domain').textContent = domain;
  status = status || {};

  // "Last upload" means a version was actually written. A sync whose content
  // was unchanged is a real success but not an upload, and the old UI showed
  // its timestamp as if data had been sent.
  const uploaded = status.lastSuccess;
  $('#last-upload').textContent = uploaded ? timeAgo(uploaded) : (status.lastSync ? 'never uploaded' : '—');

  $('#cookie-count').textContent = fmtCount(status.cookieCount);
  const storageKeys = (status.localStorageKeys || 0) + (status.sessionStorageKeys || 0) + (status.indexedDBKeys || 0);
  $('#storage-count').textContent = status.lastSync === undefined ? '—' : String(storageKeys);

  const tokens = status.authTokenCount || 0;
  const headerOnly = status.authHeaderOnlyCount || 0;
  $('#auth-count').textContent = status.lastSync === undefined
    ? '—'
    : (headerOnly ? `${tokens} (+${headerOnly} header-only)` : String(tokens));

  toggle('#trimmed-note', !!status.trimmed);

  if (status.error) {
    $('#sync-error').textContent = status.error;
    toggle('#error-box', true);
  } else {
    toggle('#error-box', false);
  }

  setFreshness(status);
  await loadSecretInfo(domain);

  show('status-section');
  resetStopConfirm();
  refreshExpiryBanner(domain);
}

// The badge and this pill now agree, and both judge age against the configured
// interval instead of printing a bare timestamp the user has to interpret.
function setFreshness(status) {
  const pill = $('#status-pill');
  const text = $('#status-pill-text');
  pill.classList.remove('ok', 'stale', 'error', 'pending');

  if (status.error) { pill.classList.add('error'); text.textContent = 'failing'; return; }
  if (!status.lastSync) { pill.classList.add('pending'); text.textContent = 'pending'; return; }

  const ageMin = (Date.now() - new Date(status.lastSync).getTime()) / 60000;
  // Two missed cycles (plus a grace minute) before calling it stale.
  if (ageMin > syncIntervalMin * 2 + 1) { pill.classList.add('stale'); text.textContent = 'stale'; }
  else { pill.classList.add('ok'); text.textContent = 'synced'; }
}

async function loadSecretInfo(domain) {
  try {
    const info = await sendMessage({ type: 'getSecretInfo', domain });
    $('#secret-id').textContent = info.secretId;
    $('#btn-copy-pull').dataset.cmd = info.project
      ? `./scripts/pull-cookies.sh ${domain} --project ${info.project}`
      : `./scripts/pull-cookies.sh ${domain} --project <your-gcp-project>`;
  } catch {
    $('#secret-id').textContent = '—';
  }
}

async function checkAuth() {
  // Only reports signed-out; it must not trigger an interactive prompt on open.
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const local = await fetch(chrome.runtime.getURL('local-config.json')).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    if (!settings.gcpProjectId && !local.gcpProjectId) {
      setStatus('No GCP project set. Open Options to finish setup.', 'warn');
    }
  } catch { /* non-fatal */ }
}

async function refreshExpiryBanner(domain) {
  const banner = $('#expiry-banner');
  if (!banner) return;
  try {
    const info = await sendMessage({ type: 'getDomainExpiry', domain });
    if (!info || !info.earliestExpiryMs) return toggle('#expiry-banner', false);
    const remainingMs = info.earliestExpiryMs - info.nowMs;
    if (remainingMs >= info.warningThresholdMs) return toggle('#expiry-banner', false);
    $('#expiry-detail').textContent = remainingMs <= 0
      ? 'Expired — refresh to re-sync'
      : `expires in ${formatDuration(remainingMs)}`;
    toggle('#expiry-banner', true);
  } catch (e) {
    toggle('#expiry-banner', false);
  }
}

// ============================================================
// Actions
// ============================================================

async function handleAddDomain() {
  const btn = $('#btn-sync-site');
  setButtonSpinner(btn, 'Adding...');
  btn.disabled = true;
  clearStatus();

  try {
    const origins = cachedOrigins || [`*://${currentDomain}/*`, `*://*.${currentDomain}/*`];
    // Record intent BEFORE the prompt: the Chrome permission dialog closes this
    // popup, so the background finishes the add via permissions.onAdded if we
    // don't survive the await. No re-click needed.
    await chrome.storage.local.set({ pendingAdd: currentDomain });
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      await chrome.storage.local.remove('pendingAdd');
      setStatus('Permission denied — the site was not added.', 'error');
      restore(btn, 'Sync This Site');
      return;
    }

    const resp = await sendMessage({ type: 'addDomain', domain: currentDomain });
    if (resp.error) {
      setStatus(resp.error, 'error');
      restore(btn, 'Sync This Site');
      return;
    }

    $('#domain-count').textContent = resp.domains.length;
    restore(btn, 'Sync This Site');
    await showWatchedState(currentDomain, {});
    await pollForStatus(currentDomain);
  } catch (e) {
    setStatus(e.message, 'error');
    restore(btn, 'Sync This Site');
  }
}

// The old code polled exactly once at 3s and gave up, leaving the popup blank
// whenever the first sync ran long.
async function pollForStatus(domain, attempts = 10, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    const { statuses } = await sendMessage({ type: 'getStatus' });
    const s = statuses[domain];
    if (s && (s.lastSync || s.error)) { await showWatchedState(domain, s); return; }
  }
}

async function handleSyncNow() {
  const btn = $('#btn-sync-now');
  setButtonSpinner(btn);
  btn.disabled = true;
  clearStatus();

  const origins = cachedOrigins || [`*://${currentDomain}/*`, `*://*.${currentDomain}/*`];
  let granted = await chrome.permissions.contains({ origins }).catch(() => false);
  if (!granted) granted = await chrome.permissions.request({ origins }).catch(() => false);
  if (!granted) {
    setStatus('Host permission is needed to read this site’s cookies.', 'error');
    restore(btn, 'Sync Now');
    return;
  }

  await sendMessage({ type: 'syncDomain', domain: currentDomain });
  const { statuses } = await sendMessage({ type: 'getStatus' });
  await showWatchedState(currentDomain, statuses[currentDomain]);
  restore(btn, 'Sync Now');
  const s = statuses[currentDomain] || {};
  if (!s.error) setStatus(s.skipped ? 'Already up to date — nothing to upload.' : 'Uploaded.', 'ok');
}

// Two-step, because this is destructive and there is no undo: revoked
// permissions cannot be silently restored.
async function handleStop() {
  const btn = $('#btn-stop');
  if (!stopArmed) {
    stopArmed = true;
    btn.textContent = 'Click again to confirm';
    toggle('#stop-explain', true);
    return;
  }
  const resp = await sendMessage({ type: 'removeDomain', domain: currentDomain });
  $('#domain-count').textContent = resp.domains.length;
  resetStopConfirm();
  showAddState(currentDomain);
  setStatus('Stopped syncing. The secret stored in Google was kept.', 'ok');
  $('#btn-delete-secret').classList.remove('hidden');
}

async function handleDeleteSecret() {
  const btn = $('#btn-delete-secret');
  setButtonSpinner(btn, 'Deleting...');
  btn.disabled = true;
  const resp = await sendMessage({ type: 'deleteCloudSecret', domain: currentDomain });
  btn.disabled = false;
  btn.textContent = 'Delete cloud secret';
  if (resp.ok) {
    btn.classList.add('hidden');
    setStatus(resp.alreadyGone ? 'No secret was stored in Google.' : `Deleted ${resp.secretId} from Google.`, 'ok');
  } else {
    setStatus(resp.error || 'Delete failed.', 'error');
  }
}

function resetStopConfirm() {
  stopArmed = false;
  const btn = $('#btn-stop');
  if (btn) btn.textContent = 'Stop syncing';
  toggle('#stop-explain', false);
}

async function handleRefreshNow() {
  const btn = $('#btn-refresh-now');
  setButtonSpinner(btn);
  btn.disabled = true;
  try {
    await sendMessage({ type: 'syncDomain', domain: currentDomain });
    const { statuses } = await sendMessage({ type: 'getStatus' });
    await showWatchedState(currentDomain, statuses[currentDomain]);
  } catch (e) {
    setStatus(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}

async function handleSignIn() {
  const btn = $('#btn-signin');
  setButtonSpinner(btn);
  btn.disabled = true;
  const resp = await sendMessage({ type: 'authenticate' });
  btn.disabled = false;
  btn.textContent = 'Sign in';
  if (resp?.success) {
    toggle('#auth-banner', false);
    setStatus('Signed in.', 'ok');
  } else {
    setStatus(resp?.error || 'Sign-in failed.', 'error');
  }
}

async function handleCopyPull() {
  const cmd = $('#btn-copy-pull').dataset.cmd;
  if (!cmd) return;
  await navigator.clipboard.writeText(cmd);
  setStatus('Command copied.', 'ok');
}

async function handleCopyError() {
  await navigator.clipboard.writeText($('#sync-error').textContent || '');
  setStatus('Error copied.', 'ok');
}

// ============================================================
// Status line — persistent, cleared by the next action, never on a timer
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

// ============================================================
// Helpers
// ============================================================

function toggle(sel, on) { $(sel).classList.toggle('hidden', !on); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtCount(n) { return (n === undefined || n === null) ? '—' : String(n); }
function restore(btn, label) { btn.disabled = false; btn.textContent = label; }

function extractDomain(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    if (!hostname || hostname === 'newtab' || url.startsWith('chrome://')) return null;
    return hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function setButtonSpinner(btn, text) {
  btn.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  btn.appendChild(spinner);
  if (text) btn.appendChild(document.createTextNode(' ' + text));
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hr}h ${rem}m` : `${hr}h`;
}

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

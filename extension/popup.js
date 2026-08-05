// Cookie Share — Popup
// Two-click domain add + quick status view

const $ = (sel) => document.querySelector(sel);

let currentDomain = null;

// ============================================================
// Init
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[CookieShare:popup] Initializing...');
  // Get current tab's domain
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentDomain = extractDomain(tab?.url);
  console.log(`[CookieShare:popup] Current domain: ${currentDomain} (from ${tab?.url})`);

  // Get watched domains and statuses
  const { domains } = await sendMessage({ type: 'getDomains' });
  const { statuses } = await sendMessage({ type: 'getStatus' });
  console.log(`[CookieShare:popup] Watched domains:`, domains, 'Statuses:', statuses);

  // Update footer
  $('#domain-count').textContent = domains.length;

  if (!currentDomain) {
    show('no-site-section');
  } else if (domains.includes(currentDomain)) {
    showWatchedState(currentDomain, statuses[currentDomain]);
  } else {
    showAddState(currentDomain);
  }

  // Event listeners
  $('#btn-sync-site').addEventListener('click', handleAddDomain);
  $('#btn-sync-now').addEventListener('click', handleSyncNow);
  $('#btn-remove').addEventListener('click', handleRemove);
  $('#btn-refresh-now').addEventListener('click', handleRefreshNow);
  $('#link-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });
});

// ============================================================
// UI States
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
}

function showWatchedState(domain, status) {
  $('#watched-domain').textContent = domain;

  if (status) {
    $('#last-sync').textContent = status.lastSync ? timeAgo(status.lastSync) : '—';
    $('#cookie-count').textContent = status.cookieCount ?? '—';
    const storageKeys = (status.localStorageKeys || 0) + (status.sessionStorageKeys || 0);
    $('#storage-count').textContent = storageKeys || '—';
    $('#bearer-count').textContent = status.bearerTokenCount ?? '—';

    if (status.error) {
      $('#error-row').style.display = 'flex';
      $('#sync-error').textContent = status.error;
    } else {
      $('#error-row').style.display = 'none';
      $('#sync-error').textContent = '';
    }
  }

  show('status-section');
  refreshExpiryBanner(domain);
}

async function refreshExpiryBanner(domain) {
  const banner = $('#expiry-banner');
  if (!banner) return;
  try {
    const info = await sendMessage({ type: 'getDomainExpiry', domain });
    if (!info || !info.earliestExpiryMs) {
      banner.classList.add('hidden');
      return;
    }
    const remainingMs = info.earliestExpiryMs - info.nowMs;
    if (remainingMs >= info.warningThresholdMs) {
      banner.classList.add('hidden');
      return;
    }
    $('#expiry-detail').textContent = remainingMs <= 0
      ? 'Expired — refresh to re-sync'
      : `expires in ${formatDuration(remainingMs)}`;
    banner.classList.remove('hidden');
  } catch (e) {
    console.warn('[CookieShare:popup] expiry check failed:', e.message);
    banner.classList.add('hidden');
  }
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

// ============================================================
// Actions
// ============================================================

async function handleAddDomain() {
  const btn = $('#btn-sync-site');
  setButtonSpinner(btn, 'Adding...');
  btn.disabled = true;

  try {
    // Build origins list including parent domains for cookie access
    const origins = getOriginsForDomain(currentDomain);
    // Record intent BEFORE the prompt: the Chrome permission dialog closes this
    // popup, so the background finishes the add via permissions.onAdded if we
    // don't survive the await. No re-click needed.
    await chrome.storage.local.set({ pendingAdd: currentDomain });
    console.log(`[CookieShare:popup] Requesting host permissions for: ${origins.join(', ')}`);
    const granted = await chrome.permissions.request({ origins });
    console.log(`[CookieShare:popup] Permission granted: ${granted}`);
    if (!granted) {
      await chrome.storage.local.remove('pendingAdd');
      btn.textContent = 'Permission denied';
      setTimeout(() => {
        btn.textContent = 'Sync This Site';
        btn.disabled = false;
      }, 2000);
      return;
    }

    // Popup survived (permission already held, or Chrome kept it open) — finish here too.
    console.log(`[CookieShare:popup] Sending addDomain message`);
    const resp = await sendMessage({ type: 'addDomain', domain: currentDomain });
    console.log(`[CookieShare:popup] addDomain response:`, resp);
    if (resp.error) {
      btn.textContent = resp.error;
      setTimeout(() => {
        btn.textContent = 'Sync This Site';
        btn.disabled = false;
      }, 2000);
      return;
    }

    // Refresh status after a moment (initial sync may still be running)
    $('#domain-count').textContent = resp.domains.length;
    showWatchedState(currentDomain, { lastSync: null });

    // Poll for sync completion
    setTimeout(async () => {
      const { statuses } = await sendMessage({ type: 'getStatus' });
      if (statuses[currentDomain]) {
        showWatchedState(currentDomain, statuses[currentDomain]);
      }
    }, 3000);
  } catch (e) {
    console.error(`[CookieShare:popup] handleAddDomain error:`, e);
    btn.textContent = 'Error — try again';
    btn.disabled = false;
  }
}

async function handleSyncNow() {
  const btn = $('#btn-sync-now');
  setButtonSpinner(btn);
  btn.disabled = true;

  // Ensure we have permissions for parent domains (for cookie access). If the
  // user declines, don't silently sync with missing access — tell them.
  const origins = getOriginsForDomain(currentDomain);
  let granted = await chrome.permissions.contains({ origins });
  if (!granted) {
    console.log(`[CookieShare:popup] Missing parent domain permissions, requesting...`);
    granted = await chrome.permissions.request({ origins }).catch(() => false);
  }
  if (!granted) {
    btn.textContent = 'Permission needed';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Sync Now'; }, 2000);
    return;
  }

  await sendMessage({ type: 'syncDomain', domain: currentDomain });

  const { statuses } = await sendMessage({ type: 'getStatus' });
  showWatchedState(currentDomain, statuses[currentDomain]);
  btn.textContent = 'Sync Now';
  btn.disabled = false;
}

async function handleRemove() {
  const resp = await sendMessage({ type: 'removeDomain', domain: currentDomain });
  $('#domain-count').textContent = resp.domains.length;
  showAddState(currentDomain);
}

async function handleRefreshNow() {
  const btn = $('#btn-refresh-now');
  setButtonSpinner(btn, 'Refreshing...');
  btn.disabled = true;
  try {
    await sendMessage({ type: 'syncDomain', domain: currentDomain });
    const { statuses } = await sendMessage({ type: 'getStatus' });
    showWatchedState(currentDomain, statuses[currentDomain]);
  } catch (e) {
    btn.textContent = 'Failed — retry';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
}

// ============================================================
// Helpers
// ============================================================

function getOriginsForDomain(domain) {
  const origins = [`*://*.${domain}/*`, `*://${domain}/*`];
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    origins.push(`*://*.${parent}/*`, `*://${parent}/*`);
  }
  return origins;
}

function extractDomain(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    // Skip browser internal pages
    if (!hostname || hostname === 'newtab' || url.startsWith('chrome://')) return null;
    // Extract registrable domain (drop www. prefix, keep rest)
    return hostname.replace(/^www\./, '');
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

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

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

    if (status.error) {
      $('#error-row').style.display = 'flex';
      $('#sync-error').textContent = status.error;
    }
  }

  show('status-section');
}

// ============================================================
// Actions
// ============================================================

async function handleAddDomain() {
  const btn = $('#btn-sync-site');
  setButtonSpinner(btn, 'Adding...');
  btn.disabled = true;

  try {
    console.log(`[CookieShare:popup] Requesting host permission for ${currentDomain}`);
    // Request host permission here (popup) — must be in user gesture context
    const granted = await chrome.permissions.request({
      origins: [`*://*.${currentDomain}/*`, `*://${currentDomain}/*`],
    });
    console.log(`[CookieShare:popup] Permission granted: ${granted}`);
    if (!granted) {
      btn.textContent = 'Permission denied';
      setTimeout(() => {
        btn.textContent = 'Sync This Site';
        btn.disabled = false;
      }, 2000);
      return;
    }

    // Permission granted — tell background to add domain and start syncing
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

// ============================================================
// Helpers
// ============================================================

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

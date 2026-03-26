// Cookie Share — Background Service Worker
// Watches cookies for authorized domains and syncs to Google Secret Manager

const DEFAULT_CONFIG = {
  gcpProjectId: '',  // Set via Options page — your GCP project ID
  syncDebounceMinutes: 1,
  periodicSyncMinutes: 15,
  tokenCacheMinutes: 50,
  keepVersions: 5,
};

// ============================================================
// Config (loaded from storage, falls back to defaults)
// ============================================================

async function getConfig() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_CONFIG,
    ...settings,
  };
}

// ============================================================
// Domain Management
// ============================================================

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isValidDomain(domain) {
  return DOMAIN_REGEX.test(domain) && domain.length <= 253;
}

async function getWatchedDomains() {
  const { watchedDomains = [] } = await chrome.storage.local.get('watchedDomains');
  return watchedDomains;
}

async function addWatchedDomain(domain) {
  if (!isValidDomain(domain)) throw new Error(`Invalid domain: ${domain}`);
  const domains = await getWatchedDomains();
  if (!domains.includes(domain)) {
    domains.push(domain);
    await chrome.storage.local.set({ watchedDomains: domains });
  }
  return domains;
}

async function removeWatchedDomain(domain) {
  let domains = await getWatchedDomains();
  domains = domains.filter(d => d !== domain);
  await chrome.storage.local.set({ watchedDomains: domains });
  await chrome.storage.local.remove(`syncStatus_${domain}`);
  return domains;
}

// ============================================================
// OAuth via launchWebAuthFlow (works for unpacked extensions)
// Token stored in chrome.storage.session (encrypted, survives SW restart)
// ============================================================

async function getAuthToken(interactive = true) {
  console.log(`[CookieShare] getAuthToken(interactive=${interactive})`);
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    console.log(`[CookieShare] getAuthToken result type: ${typeof result}`, JSON.stringify(result).substring(0, 100));
    // Chrome 128+ returns { token: "...", grantedScopes: [...] }
    if (result?.token) return result.token;
    // Older Chrome returns string directly
    if (typeof result === 'string' && result) return result;
    console.warn(`[CookieShare] No token in result`);
    return null;
  } catch (e) {
    console.error(`[CookieShare] Auth error:`, e);
    if (!interactive) return null;
    throw e;
  }
}

// ============================================================
// Google Secret Manager API
// ============================================================

function secretIdForDomain(domain) {
  // Validate the domain produces a safe secret ID
  const sid = `cookie-share-${domain.replace(/\./g, '-')}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(sid)) {
    throw new Error(`Invalid secret ID derived from domain: ${domain}`);
  }
  return sid;
}

async function gsmRequest(method, path, token, body) {
  const config = await getConfig();
  const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(config.gcpProjectId)}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

async function ensureSecretExists(token, sid) {
  const encodedSid = encodeURIComponent(sid);
  const resp = await gsmRequest('GET', `/secrets/${encodedSid}`, token);
  if (resp.status === 404) {
    const createResp = await gsmRequest(
      'POST',
      `/secrets?secretId=${encodedSid}`,
      token,
      { replication: { automatic: {} } }
    );
    if (!createResp.ok && createResp.status !== 409) {
      throw new Error(`Failed to create secret ${sid}: ${createResp.status}`);
    }
  } else if (!resp.ok) {
    throw new Error(`Failed to check secret ${sid}: ${resp.status}`);
  }
}

async function pushSecretVersion(token, sid, data) {
  const encodedSid = encodeURIComponent(sid);

  // Log sizes to understand what's big
  const jsonStr = JSON.stringify(data);
  const cookiesSize = JSON.stringify(data.cookies).length;
  const lsSize = JSON.stringify(data.localStorage).length;
  const ssSize = JSON.stringify(data.sessionStorage).length;
  console.log(`[CookieShare] Payload sizes for ${sid}: cookies=${cookiesSize}, localStorage=${lsSize}, sessionStorage=${ssSize}, total=${jsonStr.length}`);

  // Compress with gzip (CompressionStream API available in service workers)
  const compressed = await compressData(jsonStr);
  console.log(`[CookieShare] Compressed: ${jsonStr.length} → ${compressed.byteLength} bytes (${Math.round(compressed.byteLength / jsonStr.length * 100)}%)`);

  // Wrap compressed data with a marker so consumers know to decompress
  const wrapper = JSON.stringify({ compressed: 'gzip', data: arrayBufferToBase64(new Uint8Array(compressed)) });
  const wrapperBytes = new TextEncoder().encode(wrapper);

  if (wrapperBytes.byteLength > 65536) {
    // Still too big even compressed — strip large localStorage keys
    console.warn(`[CookieShare] Still too big (${wrapperBytes.byteLength}), stripping large localStorage values`);
    const trimmed = trimLargeValues(data);
    const trimmedJson = JSON.stringify(trimmed);
    const trimmedCompressed = await compressData(trimmedJson);
    const trimmedWrapper = JSON.stringify({ compressed: 'gzip', data: arrayBufferToBase64(new Uint8Array(trimmedCompressed)) });
    const trimmedBytes = new TextEncoder().encode(trimmedWrapper);
    console.log(`[CookieShare] After trimming: ${trimmedBytes.byteLength} bytes`);

    if (trimmedBytes.byteLength > 65536) {
      throw new Error(`Payload still too large after compression and trimming (${trimmedBytes.byteLength} bytes). Max is 65536.`);
    }
    return await pushPayload(token, encodedSid, trimmedWrapper);
  }

  return await pushPayload(token, encodedSid, wrapper);
}

async function pushPayload(token, encodedSid, jsonString) {
  const base64 = btoa(jsonString);
  const resp = await gsmRequest('POST', `/secrets/${encodedSid}:addVersion`, token, {
    payload: { data: base64 },
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[CookieShare] Push failed:`, resp.status, body);
    throw new Error(`Failed to push version: ${resp.status} — ${body}`);
  }
  return resp.json();
}

async function compressData(str) {
  const blob = new Blob([str]);
  const cs = new CompressionStream('gzip');
  const stream = blob.stream().pipeThrough(cs);
  return new Response(stream).arrayBuffer();
}

function trimLargeValues(data) {
  const MAX_VALUE_SIZE = 4096;
  const trimmed = { ...data };

  // Trim localStorage — keep keys but truncate huge values
  trimmed.localStorage = {};
  for (const [key, value] of Object.entries(data.localStorage)) {
    if (typeof value === 'string' && value.length > MAX_VALUE_SIZE) {
      trimmed.localStorage[key] = value.substring(0, MAX_VALUE_SIZE) + `...[truncated from ${value.length}]`;
    } else {
      trimmed.localStorage[key] = value;
    }
  }

  // Same for sessionStorage
  trimmed.sessionStorage = {};
  for (const [key, value] of Object.entries(data.sessionStorage)) {
    if (typeof value === 'string' && value.length > MAX_VALUE_SIZE) {
      trimmed.sessionStorage[key] = value.substring(0, MAX_VALUE_SIZE) + `...[truncated from ${value.length}]`;
    } else {
      trimmed.sessionStorage[key] = value;
    }
  }

  return trimmed;
}

function arrayBufferToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function cleanupOldVersions(token, sid, keepCount = 5) {
  const encodedSid = encodeURIComponent(sid);
  try {
    const resp = await gsmRequest('GET', `/secrets/${encodedSid}/versions?filter=state:ENABLED`, token);
    if (!resp.ok) return;
    const data = await resp.json();
    const versions = data.versions || [];

    // Sort by create time descending, destroy all beyond keepCount
    versions.sort((a, b) => (b.createTime || '').localeCompare(a.createTime || ''));
    const toDestroy = versions.slice(keepCount);

    for (const v of toDestroy) {
      await gsmRequest('POST', `/${v.name}:destroy`, token);
    }
  } catch (e) {
    // Non-critical — log and continue
    console.warn(`[CookieSync] Version cleanup failed for ${sid}:`, e.message);
  }
}

// ============================================================
// Bearer Token Capture (via webRequest)
// ============================================================

// Stores captured bearer tokens per domain: { "mail.superhuman.com": { token, capturedAt } }
const capturedTokens = {};

// Listen for requests to watched domains and capture Authorization headers
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'authorization'
    );
    if (authHeader?.value?.startsWith('Bearer ')) {
      try {
        const host = new URL(details.url).hostname;
        const token = authHeader.value.substring(7); // strip "Bearer "

        // Also capture x-superhuman-* headers
        const extraHeaders = {};
        for (const h of details.requestHeaders || []) {
          if (h.name.toLowerCase().startsWith('x-superhuman-')) {
            extraHeaders[h.name] = h.value;
          }
        }

        capturedTokens[host] = {
          token,
          capturedAt: new Date().toISOString(),
          extraHeaders,
        };
        console.log(`[CookieShare] Captured bearer token for ${host} (${token.substring(0, 20)}...)`);
      } catch {}
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// ============================================================
// Data Collection
// ============================================================

async function collectDomainData(domain) {
  const cookies = await chrome.cookies.getAll({ domain });

  let localStorageData = {};
  let sessionStorageData = {};

  try {
    const tabs = await chrome.tabs.query({});
    const matchingTab = tabs.find(t => {
      try {
        const host = new URL(t.url).hostname;
        return host === domain || host.endsWith('.' + domain);
      } catch { return false; }
    });

    if (matchingTab) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: matchingTab.id },
        func: () => {
          const ls = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            ls[key] = localStorage.getItem(key);
          }
          const ss = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            ss[key] = sessionStorage.getItem(key);
          }
          return { localStorage: ls, sessionStorage: ss };
        },
      });
      if (results?.[0]?.result) {
        localStorageData = results[0].result.localStorage;
        sessionStorageData = results[0].result.sessionStorage;
      }
    }
  } catch (e) {
    console.warn(`[CookieSync] Could not read storage from ${domain} tab:`, e.message);
  }

  // Collect any captured bearer tokens for this domain
  const bearerTokens = {};
  for (const [host, data] of Object.entries(capturedTokens)) {
    if (host === domain || host.endsWith('.' + domain)) {
      bearerTokens[host] = data;
    }
  }

  const result = {
    domain,
    timestamp: new Date().toISOString(),
    cookies,
    localStorage: localStorageData,
    sessionStorage: sessionStorageData,
  };

  if (Object.keys(bearerTokens).length > 0) {
    result.bearerTokens = bearerTokens;
    console.log(`[CookieShare] Including ${Object.keys(bearerTokens).length} bearer tokens for ${domain}`);
  }

  return result;
}

// ============================================================
// Sync Logic
// ============================================================

async function syncDomain(domain, interactive = false) {
  const statusKey = `syncStatus_${domain}`;
  console.log(`[CookieShare] syncDomain started: ${domain} (interactive=${interactive})`);

  // Check that GCP project is configured
  const config = await getConfig();
  if (!config.gcpProjectId) {
    const msg = 'GCP Project ID not configured. Open extension Options to set it.';
    console.error(`[CookieShare] ${msg}`);
    await chrome.storage.local.set({
      [statusKey]: { error: msg, syncing: false },
    });
    return false;
  }

  // Mark as syncing
  await chrome.storage.local.set({
    [statusKey]: { syncing: true, lastAttempt: new Date().toISOString() },
  });

  try {
    console.log(`[CookieShare] Collecting data for ${domain}...`);
    const data = await collectDomainData(domain);
    console.log(`[CookieShare] Collected: ${data.cookies.length} cookies, ${Object.keys(data.localStorage).length} localStorage keys, ${Object.keys(data.sessionStorage).length} sessionStorage keys`);

    console.log(`[CookieShare] Getting auth token (interactive=${interactive})...`);
    const token = await getAuthToken(interactive);
    if (!token) {
      const msg = `No auth token for ${domain} — need interactive login first`;
      console.warn(`[CookieShare] ${msg}`);
      await chrome.storage.local.set({
        [statusKey]: { error: msg, syncing: false },
      });
      return false;
    }
    console.log(`[CookieShare] Got auth token`);

    const sid = secretIdForDomain(domain);
    console.log(`[CookieShare] Ensuring secret exists: ${sid}`);
    await ensureSecretExists(token, sid);

    console.log(`[CookieShare] Pushing secret version...`);
    const result = await pushSecretVersion(token, sid, data);
    console.log(`[CookieShare] Pushed: ${result.name}`);

    const config = await getConfig();
    await cleanupOldVersions(token, sid, config.keepVersions);

    await chrome.storage.local.set({
      [statusKey]: {
        lastSync: new Date().toISOString(),
        cookieCount: data.cookies.length,
        localStorageKeys: Object.keys(data.localStorage).length,
        sessionStorageKeys: Object.keys(data.sessionStorage).length,
        secretVersion: result.name,
        error: null,
        syncing: false,
      },
    });
    console.log(`[CookieShare] Sync complete for ${domain}`);
    return true;
  } catch (e) {
    console.error(`[CookieShare] Sync failed for ${domain}:`, e);
    await chrome.storage.local.set({
      [statusKey]: {
        lastSync: new Date().toISOString(),
        error: e.message,
        syncing: false,
      },
    });
    return false;
  }
}

async function syncAllDomains() {
  const domains = await getWatchedDomains();
  const results = {};
  for (const domain of domains) {
    results[domain] = await syncDomain(domain);
  }
  return results;
}

// ============================================================
// Event Listeners (top-level for MV3 service worker)
// ============================================================

// Cookie change → debounced sync
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const domains = await getWatchedDomains();
  const cookieDomain = changeInfo.cookie.domain.replace(/^\./, '');

  const matched = domains.find(
    d => cookieDomain === d || cookieDomain.endsWith('.' + d)
  );

  if (matched) {
    const config = await getConfig();
    chrome.alarms.create(`sync_${matched}`, {
      delayInMinutes: config.syncDebounceMinutes,
    });
  }
});

// Alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('sync_')) {
    const domain = alarm.name.substring(5);
    await syncDomain(domain);
  } else if (alarm.name === 'periodic_sync') {
    await syncAllDomains();
  }
});

// Set up periodic sync
chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  chrome.alarms.create('periodic_sync', {
    periodInMinutes: config.periodicSyncMinutes,
  });
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  chrome.alarms.create('periodic_sync', {
    periodInMinutes: config.periodicSyncMinutes,
  });
});

// Message handler — only accepts messages from our own extension pages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Security: reject messages not from our extension
  if (sender.id !== chrome.runtime.id) return;
  // Security: reject messages from content scripts (tabs)
  if (sender.tab) return;

  const handler = messageHandlers[msg.type];
  if (handler) {
    handler(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

const messageHandlers = {
  async addDomain({ domain }) {
    console.log(`[CookieShare] addDomain: ${domain}`);
    if (!isValidDomain(domain)) {
      console.warn(`[CookieShare] Invalid domain: ${domain}`);
      return { error: 'Invalid domain name' };
    }
    // Permission request happens in popup/options (requires user gesture context)
    const domains = await addWatchedDomain(domain);
    console.log(`[CookieShare] Domain added, triggering interactive sync`);
    // First sync is interactive (may need OAuth login)
    syncDomain(domain, true);
    return { domains };
  },

  async removeDomain({ domain }) {
    const domains = await removeWatchedDomain(domain);
    chrome.permissions.remove({
      origins: [`*://*.${domain}/*`, `*://${domain}/*`],
    }).catch(() => {});
    return { domains };
  },

  async syncDomain({ domain }) {
    console.log(`[CookieShare] Manual sync requested for ${domain}`);
    const success = await syncDomain(domain, true);
    return { success };
  },

  async syncAll() {
    const results = await syncAllDomains();
    return { results };
  },

  async getDomains() {
    const domains = await getWatchedDomains();
    return { domains };
  },

  async getStatus() {
    const all = await chrome.storage.local.get(null);
    const statuses = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('syncStatus_')) {
        statuses[key.substring(11)] = value;
      }
    }
    return { statuses };
  },

  async authenticate() {
    const token = await getAuthToken(true);
    return { success: !!token };
  },
};

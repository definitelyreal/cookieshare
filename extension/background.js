// Cookie Share — Background Service Worker
// Watches cookies for authorized domains, syncs session data to Google Secret Manager.
//
// Reliability model (why the code looks the way it does):
//   * The OAuth token is invalidated and re-minted on any 401/403, so a stale
//     Chrome-cached token can never wedge sync (the "click Sync a few times" bug).
//   * A sync never pushes a payload that is emptier than the last-known-good for
//     that domain (a tab-less or cold-start read merges over LKG), so closing a
//     tab can never destroy a captured session / Firebase refresh token.
//   * Per-domain status keys + per-domain in-flight locks remove the write races
//     that made sync "feel unreliable".

const DEBOUNCE_MS = 60_000;            // cookie-change debounce
const NAV_REFRESH_DELAY_MS = 5_000;   // short delay after page load so post-load token capture lands
const PERIODIC_ALARM = 'periodic-sync';
const ACTIVE_TAB_ALARM = 'active-tab-refresh';
const ACTIVE_TAB_PERIOD_MIN = 5;
const SECRET_MAX_BYTES = 65536;
const VERSIONS_TO_KEEP = 3;
const EXPIRY_WARNING_MS = 60 * 60_000; // 1 hour
const EXPIRY_BADGE_TEXT = '!';
const EXPIRY_BADGE_COLOR = '#ff6b6b';

// ============================================================
// Local (gitignored) config: GCP project id lives here so the committed
// source carries no private values. Falls back to storage settings.
// ============================================================

const localConfigPromise = (async () => {
  try {
    const resp = await fetch(chrome.runtime.getURL('local-config.json'));
    if (resp.ok) return await resp.json();
  } catch { /* file absent in the public checkout — fine */ }
  return {};
})();

// ============================================================
// State
// ============================================================

// OAuth token cache (in-memory; invalidated on 401/403).
let cachedToken = null;
let cachedTokenExpiry = 0;
let tokenPromise = null; // in-flight de-dup so concurrent syncs mint once

// Captured auth headers, keyed by host. Mirrored to storage.local so they
// survive service-worker teardown.
const capturedBearerTokens = {};
const CAPTURED_AUTH_STORAGE_KEY = 'capturedBearerTokens';

// In-memory copy of the watched-domain list for the hot webRequest path.
let watchedDomainsCache = [];

// Per-domain in-flight sync locks.
const syncInFlight = new Map();

// Hydrate captured tokens + domain cache on boot. Everything that reads either
// awaits this promise, so a sync racing a cold start can't see empty state.
const hydrationDone = (async () => {
  // Must never reject — every read path awaits this; a rejection would wedge
  // the whole worker for its lifetime.
  try {
    const { [CAPTURED_AUTH_STORAGE_KEY]: stored = {}, domains = [] } =
      await chrome.storage.local.get([CAPTURED_AUTH_STORAGE_KEY, 'domains']);
    Object.assign(capturedBearerTokens, stored);
    watchedDomainsCache = domains;
    const n = Object.keys(stored).length;
    if (n) console.log(`[CookieShare:bg] Hydrated ${n} captured auth entries`);
  } catch (e) {
    console.warn('[CookieShare:bg] Hydration failed:', e.message);
  }
})();

async function persistCapturedTokens() {
  try {
    await chrome.storage.local.set({ [CAPTURED_AUTH_STORAGE_KEY]: capturedBearerTokens });
  } catch (e) {
    console.warn('[CookieShare:bg] Failed to persist captured tokens:', e.message);
  }
}

// ============================================================
// Domain matching (longest suffix wins, so a watched subdomain is never
// shadowed by a watched parent)
// ============================================================

function matchDomain(hostname, domains) {
  let best = null;
  for (const d of domains) {
    if (hostname === d || hostname.endsWith('.' + d)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

// ============================================================
// Domain normalization / validation
// ============================================================

// Accepts what a user might actually paste (a full URL, a trailing path, a
// port, mixed case, a "www." prefix) and returns a bare lowercase hostname, or
// null if it could never be one. Every entry point — popup, options, import —
// now goes through this. Previously each did its own partial cleanup and
// import did none, so a malformed entry became a permanently broken watch.
function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^/@]*@/, '');                // userinfo
  s = s.replace(/[/?#].*$/, '');                // path / query / fragment
  s = s.replace(/:\d+$/, '');                   // port
  s = s.replace(/^www\./, '');
  s = s.replace(/\.$/, '');                     // trailing root dot
  return isValidDomain(s) ? s : null;
}

function isValidDomain(s) {
  if (!s || s.length > 253) return false;
  if (!s.includes('.')) return false; // a dotless host has no cookie scope worth syncing
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s);
}

// Secret Manager ids allow [A-Za-z0-9_-] only, so dots become dashes. That map
// is NOT injective — "a-b.com" and "a.b-com" both yield "a-b-com" — so two
// watched domains could silently overwrite each other's credentials. The name
// scheme is kept (renaming would orphan every existing secret); callers check
// for a collision before adding instead.
function secretIdForDomain(domain) {
  return 'cookie-share-' + domain.replace(/\./g, '-');
}

function secretIdCollision(domain, existingDomains) {
  const id = secretIdForDomain(domain);
  return (existingDomains || []).find(d => d !== domain && secretIdForDomain(d) === id) || null;
}

// ============================================================
// Host permission scope
// ============================================================

// Multi-label public suffixes common enough to matter here. Not the full Public
// Suffix List — the only job is to stop the parent walk before it reaches
// something nobody should ever hold permission over.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za', 'web.za',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'go.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.pl',
  'co.in', 'net.in', 'org.in', 'gov.in',
  'com.es', 'com.pt', 'com.ua', 'co.il', 'com.my', 'co.id', 'co.th',
  'github.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'firebaseapp.com', 'web.app', 'appspot.com',
]);

// The shortest ancestor of `host` that a person could actually register, e.g.
// app.example.co.uk -> example.co.uk. Returns host itself when it is already at
// or below that boundary.
function registrableDomain(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return parts.slice(-take).join('.');
}

// Host permissions needed to read a domain's cookies. A session cookie may be
// set on the parent (".example.com") while we watch "app.example.com", so the
// registrable parent is included — but the walk STOPS there. The old version
// walked every suffix and, for app.example.co.uk, asked the user for
// "*://*.co.uk/*": permission over an entire public suffix.
function originsForDomain(domain) {
  const origins = [`*://${domain}/*`, `*://*.${domain}/*`];
  const parent = registrableDomain(domain);
  if (parent && parent !== domain && parent.includes('.')) {
    origins.push(`*://${parent}/*`, `*://*.${parent}/*`);
  }
  return origins;
}

// ============================================================
// JWT helpers (no token values are ever logged)
// ============================================================

function parseJwtExpMs(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64));
    if (typeof payload.exp === 'number' && isFinite(payload.exp)) return payload.exp * 1000;
  } catch { return null; }
  return null;
}

function annotateExpiry(entry) {
  const expMs = parseJwtExpMs(entry.token);
  if (expMs) {
    entry.expiresAt = new Date(expMs).toISOString();
    entry.expiresInSeconds = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
  } else {
    entry.expiresAt = null;
    entry.expiresInSeconds = null;
  }
}

function earliestExpiryForDomain(domain) {
  let earliest = null;
  for (const [host, data] of Object.entries(capturedBearerTokens)) {
    if (host === domain || host.endsWith('.' + domain)) {
      const t = data.expiresAt ? Date.parse(data.expiresAt) : null;
      if (t && (earliest === null || t < earliest)) earliest = t;
    }
  }
  return earliest;
}

// ============================================================
// Message handler
// ============================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    console.error('[CookieShare:bg] Message error:', msg.type, err);
    sendResponse({ error: err.message });
  });
  return true; // async response
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'getDomains':
      return { domains: await getDomains() };

    case 'getStatus':
      return { statuses: await getStatuses() };

    // The UI fetches this BEFORE the click that calls permissions.request, so
    // no await sits between the user gesture and the request.
    case 'getOrigins': {
      const d = normalizeDomain(msg.domain);
      return d ? { domain: d, origins: originsForDomain(d) } : { error: 'invalid domain' };
    }

    case 'getSecretInfo': {
      const settings = await getSettings();
      const d = normalizeDomain(msg.domain) || msg.domain;
      return { secretId: secretIdForDomain(d), project: settings.gcpProjectId || '' };
    }

    case 'addDomain': {
      await chrome.storage.local.remove('pendingAdd'); // we're completing it now
      const domain = normalizeDomain(msg.domain);
      if (!domain) return { error: `Not a valid domain: ${String(msg.domain).slice(0, 60)}`, domains: await getDomains() };

      const existing = await getDomains();
      const clash = secretIdCollision(domain, existing);
      if (clash) {
        // Two domains mapping to one secret id would silently overwrite each
        // other's credentials in the cloud. Refuse rather than corrupt.
        return {
          error: `"${domain}" and the already-watched "${clash}" both map to the secret ${secretIdForDomain(domain)}. Remove one first.`,
          domains: existing,
        };
      }

      const domains = await withDomainsLock(async () => {
        const list = await getDomains();
        if (!list.includes(domain)) {
          list.push(domain);
          await chrome.storage.local.set({ domains: list });
          watchedDomainsCache = list;
        }
        return list;
      });
      registerWebRequestForWatched().catch(() => {});
      // Manual add is a user gesture → interactive auth allowed.
      syncDomain(domain, { interactive: true }).catch(err =>
        console.error('[CookieShare:bg] Initial sync failed:', domain, err));
      ensurePeriodicAlarm();
      ensureActiveTabAlarm();
      return { domains, domain };
    }

    case 'removeDomain': {
      const domains = await withDomainsLock(async () => {
        let list = await getDomains();
        list = list.filter(d => d !== msg.domain);
        await chrome.storage.local.set({ domains: list });
        watchedDomainsCache = list;
        return list;
      });
      // Purge all per-domain state so nothing lingers.
      await chrome.storage.local.remove([`syncStatus_${msg.domain}`, `lkg_${msg.domain}`, `pushHash_${msg.domain}`]);
      // Cancel any pending debounced sync so it can't resurrect the domain.
      await Promise.all(syncAlarmNames(msg.domain).map(n => chrome.alarms.clear(n)));
      // Revoke this domain's own host permissions (least privilege). Only the
      // domain's own origins — never parent origins a sibling might still need.
      chrome.permissions.remove({ origins: [`*://*.${msg.domain}/*`, `*://${msg.domain}/*`] }).catch(() => {});
      await purgeCapturedAuthForDomain(msg.domain);
      return { domains };
    }

    // Delete the Secret Manager secret itself. Deliberately a separate verb
    // from removeDomain: stopping a sync and destroying the stored credential
    // are different decisions, and conflating them is how "Remove" used to
    // imply a deletion it never performed.
    case 'deleteCloudSecret': {
      const settings = await getSettings();
      if (!settings.gcpProjectId) return { ok: false, error: 'GCP project not configured — set it in Options.' };
      const secretId = secretIdForDomain(msg.domain);
      const url = `https://secretmanager.googleapis.com/v1/projects/${settings.gcpProjectId}/secrets/${secretId}`;
      try {
        const resp = await gsmFetch(url, { method: 'DELETE' }, { interactive: true });
        if (!resp.ok && resp.status !== 404) {
          return { ok: false, error: `Delete failed (${resp.status}): ${(await resp.text()).slice(0, 300)}` };
        }
        await chrome.storage.local.remove(`pushHash_${msg.domain}`);
        return { ok: true, secretId, alreadyGone: resp.status === 404 };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'syncDomain':
      // Manual sync from the popup/options → interactive auth allowed.
      await syncDomain(msg.domain, { interactive: true });
      return { ok: true };

    case 'syncAll': {
      // Report what actually happened. This used to return {ok:true}
      // unconditionally while allSettled swallowed every rejection, so a run in
      // which all domains failed looked identical to a clean one.
      const summary = await syncAll({ interactive: true });
      return { ok: summary.failed === 0, ...summary };
    }

    case 'authenticate':
      // Force a real re-mint so the "Authenticate" button actually recovers
      // from a bad cached token instead of returning it again.
      try {
        await getToken({ interactive: true, forceRefresh: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }

    case 'settingsUpdated':
      // Recreate the periodic alarm so a changed interval takes effect.
      await ensurePeriodicAlarm(true);
      return { ok: true };

    case 'exportState': {
      // Portable backup so a reinstall (new extension id) doesn't lose setup.
      const { domains = [], settings = {} } = await chrome.storage.local.get(['domains', 'settings']);
      return { state: { version: 1, domains, settings } };
    }

    case 'importState': {
      const state = msg.state || {};
      const rejected = [];
      if (Array.isArray(state.domains)) {
        // Import used to write the list through unchecked, so one malformed
        // entry in a backup became a permanently broken watch.
        const clean = [];
        for (const raw of state.domains) {
          const d = normalizeDomain(raw);
          if (!d) { rejected.push({ entry: String(raw).slice(0, 60), reason: 'not a valid domain' }); continue; }
          if (clean.includes(d)) continue;
          const clash = secretIdCollision(d, clean);
          if (clash) { rejected.push({ entry: d, reason: `collides with ${clash}` }); continue; }
          clean.push(d);
        }
        await chrome.storage.local.set({ domains: clean });
        watchedDomainsCache = clean;
      }
      if (state.settings && typeof state.settings === 'object') {
        await chrome.storage.local.set({ settings: state.settings });
      }
      await ensurePeriodicAlarm(true);
      await ensureActiveTabAlarm();
      registerWebRequestForWatched().catch(() => {});
      return { ok: true, domains: await getDomains(), rejected };
    }

    case 'getDomainExpiry': {
      const earliest = earliestExpiryForDomain(msg.domain);
      const tokens = await getBearerTokensForDomain(msg.domain);
      return {
        domain: msg.domain,
        earliestExpiryMs: earliest,
        nowMs: Date.now(),
        warningThresholdMs: EXPIRY_WARNING_MS,
        authTokenCount: countAuthTokens(tokens),
      };
    }

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ============================================================
// Domain + status management
// ============================================================

async function getDomains() {
  const { domains = [] } = await chrome.storage.local.get('domains');
  return domains;
}

// Tiny serializer for the shared `domains` key so concurrent add/remove
// (e.g. popup + options at once) can't lose an update.
let domainsChain = Promise.resolve();
function withDomainsLock(fn) {
  const run = domainsChain.then(fn, fn);
  domainsChain = run.catch(() => {});
  return run;
}

// Per-domain status keys — no shared object, so concurrent syncAll writes
// can't clobber each other.
async function getStatuses() {
  const all = await chrome.storage.local.get(null);
  const statuses = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('syncStatus_')) statuses[key.slice('syncStatus_'.length)] = value;
  }
  return statuses;
}

async function updateStatus(domain, updates) {
  const key = `syncStatus_${domain}`;
  const { [key]: current = {} } = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: { ...current, ...updates } });
}

// ============================================================
// Settings
// ============================================================

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const local = await localConfigPromise;
  return {
    gcpProjectId: settings.gcpProjectId || local.gcpProjectId || '',
    periodicSyncMinutes: settings.periodicSyncMinutes || 15,
    captureIncognito: settings.captureIncognito === true,
  };
}

// ============================================================
// Auth header capture from network requests
// ============================================================

// Register a webRequest listener scoped to exactly the watched domains we hold
// host permission for. A static <all_urls> listener warns "You need to request
// host permissions" because the extension only holds per-domain optional grants
// (and would observe nothing until one is granted anyway).
let webRequestListener = null;
async function registerWebRequestForWatched() {
  if (webRequestListener) {
    chrome.webRequest.onBeforeSendHeaders.removeListener(webRequestListener);
    webRequestListener = null;
  }
  const domains = await getDomains();
  const urls = [];
  for (const d of domains) {
    const origins = [`*://${d}/*`, `*://*.${d}/*`];
    try { if (await chrome.permissions.contains({ origins })) urls.push(...origins); } catch {}
  }
  if (!urls.length) return;
  // Capture failures used to be swallowed silently, so a domain could quietly
  // stop yielding auth headers with nothing anywhere to say so.
  webRequestListener = (details) => {
    captureFromRequest(details).catch(err =>
      console.warn('[CookieShare:bg] auth capture failed:', err?.message || err));
  };
  chrome.webRequest.onBeforeSendHeaders.addListener(
    webRequestListener, { urls }, ['requestHeaders', 'extraHeaders']
  );
  console.log(`[CookieShare:bg] webRequest capture armed for ${urls.length / 2} domain(s)`);
}

// Re-arm whenever host permissions or the watched set change.
if (chrome.permissions?.onAdded) chrome.permissions.onAdded.addListener(() => {
  // The permission dialog closes the popup, so finish the pending add here — no
  // re-click. Then re-arm capture for the now-granted domain.
  completePendingAdd().catch(() => {}).finally(() => registerWebRequestForWatched().catch(() => {}));
});
if (chrome.permissions?.onRemoved) chrome.permissions.onRemoved.addListener(() => registerWebRequestForWatched().catch(() => {}));
// Arm capture as early as possible rather than waiting on hydration —
// registerWebRequestForWatched reads storage itself, and every request that
// arrives before the listener is attached is auth we never see.
registerWebRequestForWatched().catch(err =>
  console.warn('[CookieShare:bg] initial capture arming failed:', err?.message || err));

// When the user grants host permission from the popup, the popup is torn down by
// the dialog before it can add the domain. Finish the job here.
async function completePendingAdd() {
  const { pendingAdd } = await chrome.storage.local.get('pendingAdd');
  if (!pendingAdd) return;
  const origins = [`*://${pendingAdd}/*`, `*://*.${pendingAdd}/*`];
  if (!(await chrome.permissions.contains({ origins }))) return; // not the domain that was granted
  await chrome.storage.local.remove('pendingAdd');
  await withDomainsLock(async () => {
    const list = await getDomains();
    if (!list.includes(pendingAdd)) {
      list.push(pendingAdd);
      await chrome.storage.local.set({ domains: list });
      watchedDomainsCache = list;
    }
  });
  await ensurePeriodicAlarm();
  await ensureActiveTabAlarm();
  console.log(`[CookieShare:bg] Auto-added ${pendingAdd} after permission grant`);
  syncDomain(pendingAdd, { interactive: false }).catch(err =>
    console.warn('[CookieShare:bg] Auto-sync after grant failed:', pendingAdd, err.message));
}

async function captureFromRequest(details) {
  if (details.incognito) {
    const settings = await getSettings();
    if (!settings.captureIncognito) return;
  }
  await hydrationDone;

  let hostname;
  try { hostname = new URL(details.url).hostname; } catch { return; }
  if (!matchDomain(hostname, watchedDomainsCache)) return;

  const headers = details.requestHeaders || [];
  const entry = capturedBearerTokens[hostname] || {};
  let changed = false;
  let tokenChanged = false;

  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === 'authorization' && h.value) {
      // Capture any Authorization scheme, not just Bearer (e.g. Discord sends
      // the raw token with no scheme prefix).
      const raw = h.value;
      if (entry.raw !== raw) {
        const m = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+(.+)$/);
        entry.scheme = m ? m[1] : null;
        entry.token = m ? m[2] : raw;
        entry.raw = raw;
        entry.capturedAt = new Date().toISOString();
        changed = true;
        tokenChanged = true;
      }
    }
    // App-specific headers (e.g. x-superhuman-*).
    if (name.startsWith('x-') && !name.startsWith('x-chrome-')) {
      if (!entry.extraHeaders) entry.extraHeaders = {};
      if (entry.extraHeaders[h.name] !== h.value) {
        entry.extraHeaders[h.name] = h.value;
        changed = true;
      }
    }
  }

  // Persist on any change — extra headers are kept even before an Authorization
  // header has been seen for this host.
  if (changed) {
    if (tokenChanged) annotateExpiry(entry);
    capturedBearerTokens[hostname] = entry;
    console.log(`[CookieShare:bg] Captured auth for ${hostname} (scheme=${entry.scheme || 'none'})`);
    await persistCapturedTokens();
    updateBadgeForActiveTab();
  }
}

// ============================================================
// Cookie watching
// ============================================================

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  await hydrationDone;
  const domain = changeInfo.cookie.domain.replace(/^\./, '');
  const matched = matchDomain(domain, watchedDomainsCache);
  if (!matched) return;
  await chrome.alarms.create(`sync-cookie-${matched}`, { delayInMinutes: DEBOUNCE_MS / 60_000 });
});

// ============================================================
// Alarms
// ============================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  // Never let a sync rejection escape the listener as an uncaught rejection —
  // background sync failures (auth, network) are logged, not thrown.
  runAlarm(alarm).catch(err => console.warn(`[CookieShare:bg] Alarm ${alarm.name} failed:`, err.message));
});

// The cookie debounce (60s) and the post-navigation refresh (5s) used to share
// one "sync-<domain>" alarm, so whichever fired create() last replaced the
// other's schedule — a cookie change could push out an imminent nav refresh.
// They get separate names now; the bare "sync-" prefix is still recognised so
// an alarm scheduled by a previous version is not orphaned.
const SYNC_ALARM_PREFIXES = ['sync-cookie-', 'sync-nav-', 'sync-'];
function syncAlarmNames(domain) {
  return SYNC_ALARM_PREFIXES.map(p => p + domain);
}
function domainFromSyncAlarm(name) {
  for (const p of SYNC_ALARM_PREFIXES) if (name.startsWith(p)) return name.slice(p.length);
  return null;
}

async function runAlarm(alarm) {
  if (alarm.name === PERIODIC_ALARM) return syncAll();
  if (alarm.name === ACTIVE_TAB_ALARM) return refreshActiveWatchedDomains();
  const domain = domainFromSyncAlarm(alarm.name);
  if (domain) return syncDomain(domain); // background context → non-interactive auth
}

// ============================================================
// Tab listeners: post-load refresh + badge
// ============================================================

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || !tab.url) return;
  if (tab.incognito) {
    const settings = await getSettings();
    if (!settings.captureIncognito) return;
  }
  await hydrationDone;
  let hostname;
  try { hostname = new URL(tab.url).hostname; } catch { return; }
  const matched = matchDomain(hostname, watchedDomainsCache);
  if (!matched) return;
  await chrome.alarms.create(`sync-nav-${matched}`, { delayInMinutes: NAV_REFRESH_DELAY_MS / 60_000 });
  updateBadgeForActiveTab();
});

chrome.tabs.onActivated.addListener(() => { updateBadgeForActiveTab(); });

async function refreshActiveWatchedDomains() {
  await hydrationDone;
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const seen = new Set();
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (tab.incognito && !settings.captureIncognito) continue;
    let hostname;
    try { hostname = new URL(tab.url).hostname; } catch { continue; }
    const m = matchDomain(hostname, watchedDomainsCache);
    if (m && !seen.has(m)) {
      seen.add(m);
      try { await syncDomain(m); } catch (err) {
        console.warn(`[CookieShare:bg] active-tab refresh failed for ${m}:`, err.message);
      }
    }
  }
}

// ============================================================
// Badge: warn when the active tab's captured token is expiring
// ============================================================

const BADGE_OK_COLOR = '#2e9e5b';   // green: synced
async function updateBadgeForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const clear = () => chrome.action.setBadgeText({ text: '' });
    if (!tab || !tab.url) return clear();
    let hostname;
    try { hostname = new URL(tab.url).hostname; } catch { return clear(); }
    await hydrationDone;
    const matched = matchDomain(hostname, watchedDomainsCache);
    if (!matched) return clear();

    const { [`syncStatus_${matched}`]: status = {} } = await chrome.storage.local.get(`syncStatus_${matched}`);
    const earliest = earliestExpiryForDomain(matched);
    const expiringSoon = earliest && earliest - Date.now() < EXPIRY_WARNING_MS;

    // Priority: error / expiring token → red "!";  synced ok → green "✓".
    if (status.error || expiringSoon) {
      chrome.action.setBadgeText({ text: EXPIRY_BADGE_TEXT });
      chrome.action.setBadgeBackgroundColor({ color: EXPIRY_BADGE_COLOR });
    } else if (status.lastSuccess || status.lastSync) {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: BADGE_OK_COLOR });
    } else {
      clear();
    }
  } catch (err) {
    console.warn('[CookieShare:bg] badge update failed:', err.message);
  }
}

// ============================================================
// Sync
// ============================================================

async function syncAll(opts = {}) {
  await hydrationDone;
  const domains = await getDomains();
  const results = await Promise.allSettled(domains.map(d => syncDomain(d, opts)));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const message = r.reason?.message || String(r.reason);
      console.error(`[CookieShare:bg] Sync failed for ${domains[i]}:`, r.reason);
      errors.push({ domain: domains[i], error: message });
    }
  });
  return { total: domains.length, failed: errors.length, ok: domains.length - errors.length, errors };
}

// Per-domain in-flight lock: overlapping triggers for one domain coalesce into
// a single sync instead of racing two GSM writes + two status updates. An
// interactive request (user clicked Sync) never rides a background sync's
// promise — it chains after so its interactive auth intent isn't lost.
function syncDomain(domain, opts = {}) {
  const existing = syncInFlight.get(domain);
  if (existing) {
    if (!opts.interactive) return existing;
    const chained = existing.catch(() => {}).then(() => doSyncDomain(domain, opts));
    const tracked = chained.finally(() => { if (syncInFlight.get(domain) === tracked) syncInFlight.delete(domain); });
    syncInFlight.set(domain, tracked);
    return tracked;
  }
  const run = doSyncDomain(domain, opts).finally(() => { if (syncInFlight.get(domain) === run) syncInFlight.delete(domain); });
  syncInFlight.set(domain, run);
  return run;
}

async function doSyncDomain(domain, { interactive = false } = {}) {
  console.log(`[CookieShare:bg] Syncing ${domain} (interactive=${interactive})...`);
  await hydrationDone;
  // Bail if the domain was removed after this sync was scheduled (e.g. a
  // debounce alarm that fired after "Remove").
  if (!(await getDomains()).includes(domain)) {
    console.log(`[CookieShare:bg] ${domain} no longer watched, skipping sync`);
    return false;
  }
  try {
    // Collect fresh data, then merge over last-known-good so a read we could
    // not perform never pushes a field emptier than what we already have.
    const { cookies, readable: cookiesReadable } = await getCookiesForDomain(domain);
    const storage = await getStorageForDomain(domain);
    const fresh = {
      cookies,
      localStorage: storage.localStorage,
      sessionStorage: storage.sessionStorage,
      indexedDB: storage.indexedDB,
      bearerTokens: await getBearerTokensForDomain(domain),
    };
    const lkg = await getLkg(domain);

    // Logout detection: we could read cookies, we used to have some, and now
    // there are none. Keyed on the transition, not on emptiness — a site that
    // never sets cookies (localStorage-only session) must not look logged out.
    // Without this the LKG guard, which exists so a closed tab can't wipe a
    // captured session, also made logging out invisible: the old authenticated
    // session stayed synced to the cloud indefinitely.
    const loggedOut = cookiesReadable
      && fresh.cookies.length === 0
      && Array.isArray(lkg.cookies) && lkg.cookies.length > 0;

    let merged;
    if (loggedOut) {
      console.log(`[CookieShare:bg] ${domain} looks logged out — clearing the captured session`);
      await purgeCapturedAuthForDomain(domain);
      merged = { cookies: [], localStorage: {}, sessionStorage: {}, indexedDB: {}, bearerTokens: {} };
    } else {
      merged = mergeSnapshot(fresh, lkg, { cookies: cookiesReadable, storage: storage.readable });
    }
    await setLkg(domain, merged);

    const earliestExpMs = (() => {
      let earliest = null;
      for (const entry of Object.values(merged.bearerTokens)) {
        if (entry.expiresAt) {
          const t = Date.parse(entry.expiresAt);
          if (!isNaN(t) && (earliest === null || t < earliest)) earliest = t;
        }
      }
      return earliest;
    })();

    const payload = {
      domain,
      timestamp: new Date().toISOString(),
      cookies: merged.cookies,
      localStorage: merged.localStorage,
      sessionStorage: merged.sessionStorage,
      indexedDB: merged.indexedDB,
      bearerTokens: merged.bearerTokens,
      auth_expires_at: earliestExpMs ? new Date(earliestExpMs).toISOString() : null,
    };

    const result = await pushToSecretManager(domain, payload, { interactive });

    const status = {
      lastSync: payload.timestamp,
      cookieCount: merged.cookies.length,
      localStorageKeys: countOriginKeys(merged.localStorage),
      sessionStorageKeys: countOriginKeys(merged.sessionStorage),
      indexedDBKeys: countIdbKeys(merged.indexedDB),
      // Hosts we hold an Authorization header for, kept separate from hosts
      // where only extra x-* headers were captured. The old single
      // "bearerTokenCount" counted both and labelled them all bearer tokens.
      authTokenCount: countAuthTokens(merged.bearerTokens),
      authHeaderOnlyCount: countHeaderOnlyHosts(merged.bearerTokens),
      authExpiresAt: payload.auth_expires_at,
      skipped: !result.pushed,
      trimmed: !!result.trimmed,
      secretId: secretIdForDomain(domain),
      error: null,
    };
    // Set lastSuccess only on a real upload. updateStatus merges with a spread,
    // so passing `undefined` OVERWRITES the previous value — which is exactly
    // how the last-upload time got wiped on every skipped sync.
    if (result.pushed) status.lastSuccess = payload.timestamp;
    await updateStatus(domain, status);
    updateBadgeForActiveTab();
    console.log(`[CookieShare:bg] Synced ${domain}: ${merged.cookies.length} cookies${result.pushed ? '' : ' (unchanged, skipped push)'}`);
    return true;
  } catch (err) {
    console.error(`[CookieShare:bg] Sync error for ${domain}:`, err);
    await updateStatus(domain, { error: err.message, syncing: false });
    throw err;
  }
}

function countOriginKeys(byOrigin) {
  return Object.values(byOrigin || {}).reduce((a, m) => a + Object.keys(m || {}).length, 0);
}
function countIdbKeys(idb) {
  let n = 0;
  for (const dbs of Object.values(idb || {}))
    for (const stores of Object.values(dbs || {}))
      for (const keys of Object.values(stores || {})) n += Object.keys(keys || {}).length;
  return n;
}

// ============================================================
// Last-known-good merge (the data-loss guard)
// ============================================================

function lkgKey(domain) { return `lkg_${domain}`; }
async function getLkg(domain) {
  const k = lkgKey(domain);
  const { [k]: lkg = {} } = await chrome.storage.local.get(k);
  return lkg;
}
async function setLkg(domain, snapshot) {
  await chrome.storage.local.set({ [lkgKey(domain)]: snapshot });
}

// Merge fresh over lkg: a field is only replaced when the fresh read carries
// data. A tab-less / cold-start read (which yields empties) therefore preserves
// the previously-captured session rather than wiping it.
// `readable` says which fresh reads actually happened. A field we genuinely
// read wins even when it came back empty (that is real data — the user cleared
// or logged out); a field we could not read falls back to LKG. Omitting
// `readable` keeps the original conservative behavior: empty never overwrites.
function mergeSnapshot(fresh, lkg = {}, readable = {}) {
  const freshCookies = fresh.cookies || [];
  return {
    cookies: (freshCookies.length || readable.cookies) ? freshCookies : (lkg.cookies || []),
    localStorage: mergeByOrigin(fresh.localStorage, lkg.localStorage, readable.storage),
    sessionStorage: mergeByOrigin(fresh.sessionStorage, lkg.sessionStorage, readable.storage),
    indexedDB: mergeByOrigin(fresh.indexedDB, lkg.indexedDB, readable.storage),
    bearerTokens: mergeBearer(fresh.bearerTokens, lkg.bearerTokens),
  };
}
// Only origins the fresh read actually visited can be cleared. An LKG origin
// the read never saw (no tab for it) is always carried forward.
function mergeByOrigin(fresh = {}, lkg = {}, readable = false) {
  const out = { ...lkg };
  for (const [origin, val] of Object.entries(fresh)) {
    if (val && Object.keys(val).length) out[origin] = val; // fresh wins when non-empty
    else if (readable) out[origin] = val || {};            // read it, genuinely empty → clear
  }
  return out;
}
function mergeBearer(fresh = {}, lkg = {}) {
  const out = { ...lkg };
  for (const [host, val] of Object.entries(fresh)) {
    if (val && (val.token || val.raw || val.extraHeaders)) out[host] = val;
  }
  return out;
}

// ============================================================
// Bearer token collection
// ============================================================

async function getBearerTokensForDomain(domain) {
  await hydrationDone;
  const result = {};
  for (const [host, data] of Object.entries(capturedBearerTokens)) {
    if (host !== domain && !host.endsWith('.' + domain)) continue;
    // A host that matches a MORE specific watched domain belongs to that one.
    // Plain suffix matching put a token captured on app.example.com into both
    // the app.example.com secret and the example.com secret whenever both were
    // watched, leaking the child's credentials into the parent's.
    if (matchDomain(host, watchedDomainsCache) !== domain) continue;
    result[host] = data;
  }
  return result;
}

// Drop every captured auth entry belonging to a domain. Used on removal and on
// logout; without it captured headers lived forever, and the LKG merge then
// kept re-publishing a token the site had already invalidated.
async function purgeCapturedAuthForDomain(domain) {
  let purged = false;
  for (const host of Object.keys(capturedBearerTokens)) {
    if (host === domain || host.endsWith('.' + domain)) {
      delete capturedBearerTokens[host];
      purged = true;
    }
  }
  if (purged) await persistCapturedTokens();
  return purged;
}

// An entry can hold a real Authorization value, or only extra x-* headers.
// Reporting both as "bearer tokens" overstated what was captured.
function countAuthTokens(byHost) {
  return Object.values(byHost || {}).filter(e => e && (e.token || e.raw)).length;
}
function countHeaderOnlyHosts(byHost) {
  return Object.values(byHost || {}).filter(
    e => e && !e.token && !e.raw && e.extraHeaders && Object.keys(e.extraHeaders).length
  ).length;
}

// ============================================================
// Cookie collection
// ============================================================

// Returns { cookies, readable }. `readable` distinguishes "we looked and there
// are none" (an authoritative empty — the user logged out) from "the read
// failed" (permission revoked / API error). Without that distinction an empty
// result was always treated as unreadable, so a logout could never propagate.
async function getCookiesForDomain(domain) {
  const urls = [`https://${domain}`, `http://${domain}`, `https://www.${domain}`];
  const allCookies = [];
  const seen = new Set();
  let readable = false;
  const push = (cookies) => {
    for (const c of cookies) {
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (!seen.has(key)) { seen.add(key); allCookies.push(c); }
    }
  };
  // getAll({domain}) also catches host-only cookies on subdomains.
  try { push(await chrome.cookies.getAll({ domain })); readable = true; }
  catch (e) { console.warn(`[CookieShare:bg] cookie read failed for ${domain}:`, e.message); }
  for (const url of urls) {
    try { push(await chrome.cookies.getAll({ url })); readable = true; } catch { /* ignore */ }
  }
  return { cookies: allCookies, readable };
}

// ============================================================
// localStorage / sessionStorage / IndexedDB collection
// ============================================================

async function getStorageForDomain(domain) {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter(t => {
    if (!t.url) return false;
    if (t.incognito && !settings.captureIncognito) return false;
    try {
      const hostname = new URL(t.url).hostname;
      return hostname === domain || hostname.endsWith('.' + domain);
    } catch { return false; }
  });

  if (matchingTabs.length === 0) {
    // No tab open → we couldn't read storage. `readable: false` tells the merge
    // to preserve whatever we captured last time rather than treat these
    // empties as an authoritative "the site has no storage".
    return { localStorage: {}, sessionStorage: {}, indexedDB: {}, readable: false };
  }

  const localStorageByOrigin = {};
  const sessionStorageByOrigin = {};
  const indexedDBByOrigin = {};

  for (const tab of matchingTabs) {
    let origin;
    try { origin = new URL(tab.url).origin; } catch { continue; }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractStorageContent,
      });
      const data = results[0]?.result;
      if (!data) continue;
      localStorageByOrigin[origin] = { ...(localStorageByOrigin[origin] || {}), ...(data.localStorage || {}) };
      sessionStorageByOrigin[origin] = { ...(sessionStorageByOrigin[origin] || {}), ...(data.sessionStorage || {}) };
      if (data.indexedDB && Object.keys(data.indexedDB).length) {
        indexedDBByOrigin[origin] = { ...(indexedDBByOrigin[origin] || {}), ...data.indexedDB };
      }
    } catch (err) {
      console.warn(`[CookieShare:bg] Could not inject into tab ${tab.id} for ${domain}:`, err.message);
    }
  }
  return {
    localStorage: localStorageByOrigin,
    sessionStorage: sessionStorageByOrigin,
    indexedDB: indexedDBByOrigin,
    readable: true,
  };
}

// Injected into the page. Auth-related keys are captured regardless of size;
// other keys only when small. Also reads the Firebase IndexedDB auth store so
// consumers can refresh access tokens with the captured refresh token.
async function extractStorageContent() {
  const AUTH_KEY_RE = /token|auth|jwt|session/i;
  const FIREBASE_RE = /^firebase:/i;
  const SUPABASE_RE = /^sb-.+-auth-token$/i;
  const MAX_VALUE_LEN = 4096;
  const MAX_AUTH_VALUE_LEN = 32768;
  const isAuthKey = (k) => AUTH_KEY_RE.test(k) || FIREBASE_RE.test(k) || SUPABASE_RE.test(k);

  function snapshotStore(store) {
    const out = {};
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      const val = store.getItem(key);
      if (val == null) continue;
      const cap = isAuthKey(key) ? MAX_AUTH_VALUE_LEN : MAX_VALUE_LEN;
      if (val.length <= cap) out[key] = val;
    }
    return out;
  }

  const IDB_TARGETS = [
    { dbName: 'firebaseLocalStorageDb', storeName: 'firebaseLocalStorage', keyPattern: /^firebase:authUser:/ },
  ];

  function readIDBStore(dbName, storeName, keyPattern) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      try {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) { db.close(); finish({}); return; }
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const out = {};
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = (event) => {
            const c = event.target.result;
            if (c) {
              const keyStr = String(c.key);
              if (!keyPattern || keyPattern.test(keyStr)) {
                try { out[keyStr] = JSON.parse(JSON.stringify(c.value)); } catch {}
              }
              c.continue();
            } else { db.close(); finish(out); }
          };
          cursorReq.onerror = () => { db.close(); finish({}); };
        };
        req.onerror = () => finish({});
        req.onblocked = () => finish({});
      } catch { finish({}); }
    });
  }

  let idbExists = new Set();
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      idbExists = new Set((dbs || []).map(d => d.name).filter(Boolean));
    }
  } catch { /* still attempt opens */ }

  const idbResult = {};
  for (const target of IDB_TARGETS) {
    if (idbExists.size && !idbExists.has(target.dbName)) continue;
    try {
      const data = await readIDBStore(target.dbName, target.storeName, target.keyPattern);
      if (data && Object.keys(data).length) {
        idbResult[target.dbName] = { ...(idbResult[target.dbName] || {}), [target.storeName]: data };
      }
    } catch { /* ignore */ }
  }

  // Slack: the per-workspace API token (xoxc-) lives inside localConfig_v2,
  // whose key matches no auth pattern and whose value is far over the 4KB cap —
  // so it was always dropped and Slack sessions synced as cookie-only (the `d`
  // cookie alone gets `not_authed` from Slack's API). Extract just the tokens
  // rather than storing the whole multi-KB config blob.
  function slackTokens() {
    const out = {};
    try {
      if (!/(^|\.)slack\.com$/.test(location.hostname)) return out;
      const raw = localStorage.getItem('localConfig_v2');
      if (!raw) return out;
      const teams = (JSON.parse(raw) || {}).teams || {};
      for (const t of Object.values(teams)) {
        if (t && typeof t.token === 'string' && t.token.startsWith('xox')) {
          out[t.domain || t.name || t.id || 'unknown'] = t.token;
        }
      }
    } catch { /* malformed config — leave empty */ }
    return out;
  }

  const ls = snapshotStore(localStorage);
  const slack = slackTokens();
  if (Object.keys(slack).length) ls.__cookieshare_slack_tokens__ = JSON.stringify(slack);

  return { localStorage: ls, sessionStorage: snapshotStore(sessionStorage), indexedDB: idbResult };
}

// ============================================================
// Google Secret Manager
// ============================================================

async function pushToSecretManager(domain, payload, { interactive = false } = {}) {
  const settings = await getSettings();
  const project = settings.gcpProjectId;
  if (!project) throw new Error('GCP project not configured — set it in Options.');
  const secretId = secretIdForDomain(domain);
  const base = `https://secretmanager.googleapis.com/v1/projects/${project}`;

  // Encode (gzip when large) BEFORE hashing. Trimming happens here, so the
  // skip-check must hash what the cloud actually receives — hashing the
  // untrimmed payload let a trimmed push masquerade as a complete one, and
  // reported full counts for truncated cloud data.
  const { timestamp, auth_expires_at, ...content } = payload;
  let effective = content;
  let trimmed = false;
  let secretData = await encodePayload(payload);
  if (decodedBytes(secretData) > SECRET_MAX_BYTES) {
    console.warn(`[CookieShare:bg] Payload over cap for ${domain}, trimming large values`);
    const trimmedPayload = trimLargeValues(payload);
    secretData = await encodePayload(trimmedPayload);
    if (decodedBytes(secretData) > SECRET_MAX_BYTES) {
      throw new Error(`Payload still too large after trimming (${decodedBytes(secretData)} > ${SECRET_MAX_BYTES}).`);
    }
    const { timestamp: _ts, auth_expires_at: _exp, ...trimmedContent } = trimmedPayload;
    effective = trimmedContent;
    trimmed = true;
  }

  // Skip the push (and the billable version) only when the destination AND the
  // content are both unchanged. The destination is part of the hash: without
  // it, switching GCP project (or deleting the secret in the console) left
  // every later sync skipping before ensureSecret ever ran — reporting healthy
  // syncs to a secret that did not exist.
  const hash = await sha256Hex(JSON.stringify({ project, secretId, content: effective }));
  const hashKey = `pushHash_${domain}`;
  const { [hashKey]: prevHash } = await chrome.storage.local.get(hashKey);
  if (prevHash === hash) return { pushed: false, trimmed, unchanged: true };

  await ensureSecret(base, secretId, { interactive });

  const resp = await gsmFetch(`${base}/secrets/${secretId}:addVersion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: secretData } }),
  }, { interactive });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`addVersion failed (${resp.status}): ${body}`);
  }

  await chrome.storage.local.set({ [hashKey]: hash });
  console.log(`[CookieShare:bg] Pushed to ${secretId}${trimmed ? ' (trimmed)' : ''}`);
  await destroyOldVersions(base, secretId, VERSIONS_TO_KEEP, { interactive });
  return { pushed: true, trimmed, bytes: decodedBytes(secretData) };
}

async function encodePayload(payload) {
  const jsonStr = JSON.stringify(payload);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  if (jsonBytes.length > SECRET_MAX_BYTES / 2) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(jsonBytes);
    writer.close();
    const compressedBuf = await new Response(cs.readable).arrayBuffer();
    const envelope = JSON.stringify({ compressed: 'gzip', data: base64FromBytes(new Uint8Array(compressedBuf)) });
    return base64FromString(envelope);
  }
  return base64FromString(jsonStr);
}

// Chunked base64 — never spreads a large typed array into function args.
function base64FromBytes(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
function base64FromString(str) {
  return base64FromBytes(new TextEncoder().encode(str));
}

// Bytes Secret Manager will store = the base64 payload decoded. This, not the
// base64 length, is what the 64 KiB cap applies to.
function decodedBytes(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length / 4) * 3 - pad;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Last-resort size reduction (payload still over cap after gzip). Deep-truncate
// every large string across storage, IndexedDB and captured headers — graceful
// degradation instead of a hard, permanent sync failure for a heavy domain.
function trimLargeValues(payload) {
  const MAX = 4096;
  const deepTrim = (val) => {
    if (typeof val === 'string') {
      return val.length > MAX ? val.slice(0, MAX) + `...[truncated from ${val.length}]` : val;
    }
    if (Array.isArray(val)) return val.map(deepTrim);
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = deepTrim(v);
      return out;
    }
    return val;
  };
  return {
    ...payload,
    localStorage: deepTrim(payload.localStorage),
    sessionStorage: deepTrim(payload.sessionStorage),
    indexedDB: deepTrim(payload.indexedDB),
    bearerTokens: deepTrim(payload.bearerTokens),
  };
}

async function ensureSecret(base, secretId, { interactive = false } = {}) {
  const check = await gsmFetch(`${base}/secrets/${secretId}`, {}, { interactive });
  if (check.ok) return;
  if (check.status === 404) {
    const createResp = await gsmFetch(`${base}/secrets?secretId=${secretId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replication: { automatic: {} } }),
    }, { interactive });
    if (!createResp.ok && createResp.status !== 409) {
      throw new Error(`Create secret failed (${createResp.status}): ${await createResp.text()}`);
    }
    return;
  }
  throw new Error(`Check secret failed (${check.status}): ${await check.text()}`);
}

// Enforce the "keep only N versions" promise. The previous implementation
// failed three ways at once: it filtered to state:ENABLED, so DISABLED versions
// (which still hold the credential) were never destroyed; it read a single
// 100-item page; and it never checked the destroy response, logging attempted
// destruction as completed. Returns counts so callers can tell.
async function destroyOldVersions(base, secretId, keep, { interactive = false } = {}) {
  const versions = [];
  let pageToken = '';
  // Bounded so a pathological secret can't spin forever.
  for (let page = 0; page < 20; page++) {
    const url = `${base}/secrets/${secretId}/versions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const listResp = await gsmFetch(url, {}, { interactive });
    if (!listResp.ok) {
      console.warn(`[CookieShare:bg] list versions failed for ${secretId}: ${listResp.status}`);
      return { destroyed: 0, failed: 0, listed: versions.length, incomplete: true };
    }
    const data = await listResp.json();
    versions.push(...(data.versions || []));
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }

  // DESTROYED versions are already gone. Keep the newest N ENABLED ones; every
  // other live version — enabled surplus or disabled — still stores the
  // credential and must go.
  const live = versions.filter(v => v.state === 'ENABLED' || v.state === 'DISABLED');
  const byNewest = (a, b) => new Date(b.createTime) - new Date(a.createTime);
  const enabled = live.filter(v => v.state === 'ENABLED').sort(byNewest);
  const keepSet = new Set(enabled.slice(0, keep).map(v => v.name));
  const toDestroy = live.filter(v => !keepSet.has(v.name)).sort(byNewest);

  let destroyed = 0, failed = 0;
  for (const v of toDestroy) {
    try {
      const resp = await gsmFetch(`https://secretmanager.googleapis.com/v1/${v.name}:destroy`, { method: 'POST' }, { interactive });
      if (resp.ok) destroyed++;
      else { failed++; console.warn(`[CookieShare:bg] destroy ${v.name} failed: ${resp.status}`); }
    } catch (e) {
      failed++;
      console.warn(`[CookieShare:bg] destroy ${v.name} failed:`, e.message);
    }
  }
  if (destroyed || failed) {
    console.log(`[CookieShare:bg] ${secretId}: destroyed ${destroyed}, failed ${failed}, kept ${keepSet.size}`);
  }
  return { destroyed, failed, listed: versions.length, incomplete: false };
}

// ============================================================
// OAuth — invalidate-and-retry on 401/403
// ============================================================

async function getToken({ interactive = false, forceRefresh = false } = {}) {
  if (forceRefresh) await invalidateToken();
  if (cachedToken && Date.now() < cachedTokenExpiry - 60_000) return cachedToken;
  // Reuse an in-flight mint only when NOT forcing a refresh — a retry after a
  // 401 must not ride a promise that is minting the same stale token.
  if (tokenPromise && !forceRefresh) return tokenPromise;
  tokenPromise = (async () => {
    const result = await chrome.identity.getAuthToken({ interactive });
    const tok = (result && typeof result === 'object') ? result.token : result;
    if (!tok) {
      throw new Error(interactive
        ? 'No access token from chrome.identity'
        : 'Not signed in — open the extension and click Sync to authorize.');
    }
    cachedToken = tok;
    cachedTokenExpiry = Date.now() + 55 * 60_000;
    return tok;
  })();
  try { return await tokenPromise; }
  finally { tokenPromise = null; }
}

async function invalidateToken() {
  if (cachedToken) {
    try { await chrome.identity.removeCachedAuthToken({ token: cachedToken }); } catch {}
  }
  cachedToken = null;
  cachedTokenExpiry = 0;
}

// GSM fetch wrapper: a 401/403 invalidates the token and retries once, so a
// stale Chrome-cached token can never wedge sync.
async function gsmFetch(url, options = {}, { interactive = false } = {}) {
  let token = await getToken({ interactive });
  let resp = await fetch(url, withAuth(options, token));
  if (resp.status === 401 || resp.status === 403) {
    await invalidateToken();
    token = await getToken({ interactive, forceRefresh: true });
    resp = await fetch(url, withAuth(options, token));
  }
  return resp;
}
function withAuth(options, token) {
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } };
}

// ============================================================
// Alarm setup
// ============================================================

async function ensurePeriodicAlarm(force = false) {
  const settings = await getSettings();
  const existing = await chrome.alarms.get(PERIODIC_ALARM);
  if (force || !existing) {
    await chrome.alarms.clear(PERIODIC_ALARM);
    await chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: settings.periodicSyncMinutes });
    console.log(`[CookieShare:bg] Periodic alarm every ${settings.periodicSyncMinutes}m`);
  }
}

async function ensureActiveTabAlarm() {
  const existing = await chrome.alarms.get(ACTIVE_TAB_ALARM);
  if (!existing) {
    await chrome.alarms.create(ACTIVE_TAB_ALARM, { periodInMinutes: ACTIVE_TAB_PERIOD_MIN });
  }
}

// ============================================================
// Startup
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log('[CookieShare:bg] Installed');
  ensurePeriodicAlarm();
  ensureActiveTabAlarm();
  updateBadgeForActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[CookieShare:bg] Startup');
  ensurePeriodicAlarm();
  ensureActiveTabAlarm();
  updateBadgeForActiveTab();
});

// Exposed for the Node test harness (no-op in the extension environment).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchDomain, mergeSnapshot, mergeByOrigin, mergeBearer, trimLargeValues, base64FromBytes, base64FromString, countOriginKeys, countIdbKeys, parseJwtExpMs, encodePayload, sha256Hex, getToken, invalidateToken, gsmFetch, handleMessage, syncDomain, completePendingAdd, normalizeDomain, isValidDomain, secretIdForDomain, secretIdCollision, countAuthTokens, countHeaderOnlyHosts, syncAlarmNames, domainFromSyncAlarm, destroyOldVersions, getBearerTokensForDomain, purgeCapturedAuthForDomain, registrableDomain, originsForDomain, syncAll };
}

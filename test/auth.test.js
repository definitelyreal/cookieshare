// Cookie Share — auth retry tests (B2: the "click Sync a few times" bug).
// Proves a 401 invalidates the stale token and retries once with a fresh one.
// Run: node test/auth.test.js

const assert = require('assert');

// Stateful chrome.identity + fetch mock, rebuilt per test.
let chromeCache, removed, fetchCalls, mint;
function resetMock({ firstStatus }) {
  chromeCache = 'STALE';
  removed = [];
  fetchCalls = [];
  mint = 0;
  global.chrome.identity.getAuthToken = async ({ interactive } = {}) => {
    if (chromeCache) return { token: chromeCache };  // Chrome returns its cached token
    chromeCache = 'FRESH' + (++mint);                // …until it's removed, then re-mints
    return { token: chromeCache };
  };
  global.chrome.identity.removeCachedAuthToken = async ({ token }) => { removed.push(token); chromeCache = null; };
  global.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url, auth: (opts.headers || {}).Authorization });
    const status = fetchCalls.length === 1 ? firstStatus : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => '' };
  };
}

const noop = () => {};
const listener = { addListener: noop };
global.chrome = {
  runtime: { getURL: (p) => p, onMessage: listener, onInstalled: listener, onStartup: listener, id: 'test' },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  webRequest: { onBeforeSendHeaders: listener },
  cookies: { onChanged: listener, getAll: async () => [] },
  tabs: { onUpdated: listener, onActivated: listener, query: async () => [] },
  alarms: { onAlarm: listener, get: async () => null, create: noop, clear: noop },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  identity: {}, scripting: {},
};
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const bg = require('../extension/background.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

(async () => {
  await test('B2: a 401 invalidates the stale token and retries once with a fresh token', async () => {
    await bg.invalidateToken();                         // clear any token left by a prior test
    resetMock({ firstStatus: 401 });                    // fresh mock + empty removed/fetchCalls
    const resp = await bg.gsmFetch('https://secretmanager.googleapis.com/v1/x', { method: 'GET' });
    assert.strictEqual(fetchCalls.length, 2, 'exactly one retry');
    assert.strictEqual(fetchCalls[0].auth, 'Bearer STALE', 'first attempt used the stale token');
    assert.ok(fetchCalls[1].auth.startsWith('Bearer FRESH'), 'retry used a freshly minted token');
    assert.deepStrictEqual(removed, ['STALE'], 'the stale token was removed from Chrome cache exactly once');
    assert.ok(resp.ok, 'final response is OK');
  });

  await test('B2: a healthy 200 does not invalidate or retry', async () => {
    await bg.invalidateToken();
    resetMock({ firstStatus: 200 });
    const resp = await bg.gsmFetch('https://secretmanager.googleapis.com/v1/x', { method: 'GET' });
    assert.strictEqual(fetchCalls.length, 1, 'no retry on success');
    assert.deepStrictEqual(removed, [], 'no token invalidation on success');
    assert.ok(resp.ok);
  });

  await test('B5: concurrent getToken calls mint the token only once (in-flight de-dup)', async () => {
    await bg.invalidateToken();
    resetMock({ firstStatus: 200 });
    let mintCount = 0;
    global.chrome.identity.getAuthToken = async () => { mintCount++; return { token: 'T' }; };
    const [a, b, c] = await Promise.all([bg.getToken(), bg.getToken(), bg.getToken()]);
    assert.strictEqual(a, 'T'); assert.strictEqual(b, 'T'); assert.strictEqual(c, 'T');
    assert.strictEqual(mintCount, 1, 'three concurrent callers minted exactly one token');
  });

  await test('B2: non-interactive background sync gives a clear "not signed in" error', async () => {
    await bg.invalidateToken();
    resetMock({ firstStatus: 200 });
    global.chrome.identity.getAuthToken = async () => null; // Chrome returns nothing when signed out
    await assert.rejects(() => bg.getToken({ interactive: false }), /Not signed in/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

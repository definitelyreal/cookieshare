// Cookie Share — logic tests for the reliability/data-loss fixes.
// Pure-function tests (no browser). Run: node test/logic.test.js
//
// Loads the exported helpers from background.js under a minimal chrome/fetch
// stub so the module's top-level listener registrations don't crash Node.

const assert = require('assert');

// --- Minimal environment stubs so requiring the service worker doesn't throw ---
const noop = () => {};
const listener = { addListener: noop };
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
global.chrome = {
  runtime: { getURL: (p) => p, onMessage: listener, onInstalled: listener, onStartup: listener, id: 'test' },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  webRequest: { onBeforeSendHeaders: listener },
  cookies: { onChanged: listener, getAll: async () => [] },
  tabs: { onUpdated: listener, onActivated: listener, query: async () => [] },
  alarms: { onAlarm: listener, get: async () => null, create: noop, clear: noop },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  identity: {},
  scripting: {},
};

const bg = require('../extension/background.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

// ============================================================
// B7 — longest-match domain resolution
// ============================================================
test('B7: watched subdomain is not shadowed by watched parent', () => {
  assert.strictEqual(bg.matchDomain('app.corp.com', ['corp.com', 'app.corp.com']), 'app.corp.com');
  assert.strictEqual(bg.matchDomain('app.corp.com', ['app.corp.com', 'corp.com']), 'app.corp.com');
});
test('B7: plain and www match the registrable domain; non-match is null', () => {
  assert.strictEqual(bg.matchDomain('www.corp.com', ['corp.com']), 'corp.com');
  assert.strictEqual(bg.matchDomain('corp.com', ['corp.com']), 'corp.com');
  assert.strictEqual(bg.matchDomain('evil.com', ['corp.com']), null);
});

// ============================================================
// B1 — data-loss guard: a tab-less/cold sync must not wipe captured session
// ============================================================
const FIREBASE = {
  firebaseLocalStorageDb: {
    firebaseLocalStorage: {
      'firebase:authUser:key:[DEFAULT]': { stsTokenManager: { refreshToken: 'REFRESH_abc123' } },
    },
  },
};
const lkgGood = {
  cookies: [{ domain: '.partiful.com', name: 'sess', path: '/' }],
  localStorage: { 'https://partiful.com': { token: 'ls-token' } },
  sessionStorage: {},
  indexedDB: FIREBASE,
  bearerTokens: { 'api.partiful.com': { token: 'BEARER_xyz', raw: 'Bearer BEARER_xyz' } },
};

test('B1: OLD behavior (no merge) would drop the Firebase refresh token', () => {
  // Reproduce the bug: syncDomain used payload.indexedDB = fresh.indexedDB || {}
  const freshNoTab = { cookies: [], localStorage: {}, sessionStorage: {}, indexedDB: {}, bearerTokens: {} };
  const buggyPayloadIdb = freshNoTab.indexedDB || {};
  assert.strictEqual(Object.keys(buggyPayloadIdb).length, 0, 'reproduces the empty-idb push');
});

test('B1: merge preserves refresh token, cookies, localStorage, bearer when tab is closed', () => {
  const freshNoTab = { cookies: [], localStorage: {}, sessionStorage: {}, indexedDB: {}, bearerTokens: {} };
  const merged = bg.mergeSnapshot(freshNoTab, lkgGood);
  assert.strictEqual(
    merged.indexedDB.firebaseLocalStorageDb.firebaseLocalStorage['firebase:authUser:key:[DEFAULT]'].stsTokenManager.refreshToken,
    'REFRESH_abc123', 'refresh token survives');
  assert.strictEqual(merged.cookies.length, 1, 'cookies preserved');
  assert.strictEqual(merged.localStorage['https://partiful.com'].token, 'ls-token', 'localStorage preserved');
  assert.strictEqual(merged.bearerTokens['api.partiful.com'].token, 'BEARER_xyz', 'bearer preserved');
});

test('B1: fresh non-empty data overrides LKG for that field/origin', () => {
  const fresh = {
    cookies: [{ domain: '.partiful.com', name: 'sess', path: '/' }, { domain: '.partiful.com', name: 'new', path: '/' }],
    localStorage: { 'https://partiful.com': { token: 'ls-token-NEW' } },
    sessionStorage: {},
    indexedDB: {},
    bearerTokens: { 'api.partiful.com': { token: 'BEARER_NEW', raw: 'Bearer BEARER_NEW' } },
  };
  const merged = bg.mergeSnapshot(fresh, lkgGood);
  assert.strictEqual(merged.cookies.length, 2, 'fresh cookies win');
  assert.strictEqual(merged.localStorage['https://partiful.com'].token, 'ls-token-NEW', 'fresh ls wins');
  assert.strictEqual(merged.bearerTokens['api.partiful.com'].token, 'BEARER_NEW', 'fresh bearer wins');
  // but the Firebase IDB (absent from fresh) is still carried forward
  assert.ok(merged.indexedDB.firebaseLocalStorageDb, 'idb carried forward');
});

test('B1: an empty per-origin object does not wipe a good LKG origin', () => {
  const fresh = { localStorage: { 'https://partiful.com': {} } };
  const out = bg.mergeByOrigin(fresh.localStorage, lkgGood.localStorage);
  assert.strictEqual(out['https://partiful.com'].token, 'ls-token', 'empty read did not wipe');
});

test('B1: merging preserves LKG origins the fresh read did not see at all', () => {
  const fresh = { 'https://a.com': { k: '1' } };
  const lkg = { 'https://b.com': { k: '2' } };
  const out = bg.mergeByOrigin(fresh, lkg);
  assert.strictEqual(out['https://a.com'].k, '1');
  assert.strictEqual(out['https://b.com'].k, '2');
});

// ============================================================
// B6 — base64 must not blow the stack on a large buffer, and must round-trip
// ============================================================
test('B6: naive spread throws on a large array (reproduces the bug)', () => {
  const big = new Uint8Array(300_000).fill(65);
  assert.throws(() => String.fromCharCode(...big), RangeError);
});
test('B6: chunked base64 handles a large buffer and round-trips exactly', () => {
  const big = new Uint8Array(300_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  const b64 = bg.base64FromBytes(big);           // must not throw
  const back = Buffer.from(b64, 'base64');
  assert.strictEqual(back.length, big.length, 'length round-trips');
  assert.ok(back.equals(Buffer.from(big)), 'bytes round-trip exactly');
});
test('B6: base64FromString round-trips unicode', () => {
  const s = JSON.stringify({ hi: 'héllo — 世界', n: 42 });
  const decoded = Buffer.from(bg.base64FromString(s), 'base64').toString('utf-8');
  assert.strictEqual(decoded, s);
});

// ============================================================
// B6/size — trimLargeValues bounds oversized values
// ============================================================
test('trimLargeValues truncates values over the cap and marks them', () => {
  const payload = { localStorage: { 'https://x.com': { big: 'A'.repeat(10_000), small: 'ok' } }, sessionStorage: {} };
  const trimmed = bg.trimLargeValues(payload);
  const v = trimmed.localStorage['https://x.com'].big;
  assert.ok(v.length < 10_000 && v.includes('truncated from 10000'), 'large value truncated');
  assert.strictEqual(trimmed.localStorage['https://x.com'].small, 'ok', 'small value untouched');
});

// ============================================================
// JWT expiry parsing (drives the badge/banner)
// ============================================================
test('parseJwtExpMs reads exp; rejects malformed', () => {
  const body = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url');
  const jwt = `h.${body}.sig`;
  assert.strictEqual(bg.parseJwtExpMs(jwt), 2000000000 * 1000);
  assert.strictEqual(bg.parseJwtExpMs('not-a-jwt'), null);
  assert.strictEqual(bg.parseJwtExpMs(''), null);
});

// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

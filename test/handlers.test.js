// Cookie Share — message-handler tests (covers the removeDomain purge/permission
// /alarm regressions VERIFY flagged, the still-watched sync guard, and
// export/import). Run: node test/handlers.test.js

const assert = require('assert');

// Stateful in-memory chrome.storage.local + spies.
const store = {};
const spies = { alarmsCleared: [], permsRemoved: [], fetches: [] };
const noop = () => {};
const listener = { addListener: noop };
global.fetch = async (url, opts) => { spies.fetches.push(url); return { ok: true, status: 200, json: async () => ({ versions: [] }), text: async () => '' }; };
global.chrome = {
  runtime: { getURL: (p) => p, onMessage: listener, onInstalled: listener, onStartup: listener, id: 'test' },
  storage: { local: {
    get: async (keys) => {
      if (keys == null) return { ...store };
      const ks = Array.isArray(keys) ? keys : [keys];
      const out = {}; for (const k of ks) if (k in store) out[k] = store[k]; return out;
    },
    set: async (obj) => { Object.assign(store, obj); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },
  } },
  webRequest: { onBeforeSendHeaders: listener },
  cookies: { onChanged: listener, getAll: async () => [] },
  tabs: { onUpdated: listener, onActivated: listener, query: async () => [] },
  alarms: { onAlarm: listener, get: async () => null, create: noop, clear: async (n) => { spies.alarmsCleared.push(n); } },
  permissions: { remove: async (o) => { spies.permsRemoved.push(o); return true; }, contains: async () => true, onAdded: listener, onRemoved: listener },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  identity: { getAuthToken: async () => ({ token: 'T' }), removeCachedAuthToken: async () => {} },
  scripting: {},
};

const bg = require('../extension/background.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

(async () => {
  await test('removeDomain purges per-domain state, clears the alarm, revokes host permissions', async () => {
    // Seed state as if the domain had been synced.
    Object.assign(store, {
      domains: ['partiful.com', 'other.com'],
      syncStatus_: undefined,
      'syncStatus_partiful.com': { lastSync: 'x' },
      'lkg_partiful.com': { cookies: [1] },
      'pushHash_partiful.com': 'abc',
    });
    spies.alarmsCleared = []; spies.permsRemoved = [];

    const res = await bg.handleMessage({ type: 'removeDomain', domain: 'partiful.com' });
    assert.deepStrictEqual(res.domains, ['other.com'], 'domain removed from list');
    assert.ok(!('syncStatus_partiful.com' in store), 'syncStatus purged');
    assert.ok(!('lkg_partiful.com' in store), 'lkg purged');
    assert.ok(!('pushHash_partiful.com' in store), 'pushHash purged');
    assert.ok(spies.alarmsCleared.includes('sync-partiful.com'), 'pending debounce alarm cleared');
    assert.strictEqual(spies.permsRemoved.length, 1, 'host permissions revoked');
    assert.deepStrictEqual(spies.permsRemoved[0].origins, ['*://*.partiful.com/*', '*://partiful.com/*'], 'only the domain’s own origins');
  });

  await test('a sync for a domain removed after scheduling bails without pushing', async () => {
    store.domains = ['stillwatched.com'];             // "gone.com" is NOT watched
    spies.fetches = [];
    const result = await bg.syncDomain('gone.com');   // e.g. a stale debounce alarm
    assert.strictEqual(result, false, 'sync returns false');
    assert.strictEqual(spies.fetches.length, 0, 'no GSM request was made');
  });

  await test('exportState / importState round-trips domains + settings', async () => {
    store.domains = ['a.com', 'b.com'];
    store.settings = { gcpProjectId: 'proj', periodicSyncMinutes: 30, captureIncognito: true };
    const { state } = await bg.handleMessage({ type: 'exportState' });
    // Simulate a fresh install: wipe, then import.
    delete store.domains; delete store.settings;
    const res = await bg.handleMessage({ type: 'importState', state });
    assert.deepStrictEqual(res.domains, ['a.com', 'b.com'], 'domains restored');
    assert.strictEqual(store.settings.periodicSyncMinutes, 30, 'settings restored');
  });

  await test('completePendingAdd adds the pending domain + syncs after a permission grant (no re-click)', async () => {
    for (const k of Object.keys(store)) delete store[k];
    store.domains = [];
    store.pendingAdd = 'newsite.org';
    await bg.completePendingAdd();
    assert.deepStrictEqual(store.domains, ['newsite.org'], 'domain auto-added');
    assert.ok(!('pendingAdd' in store), 'pending flag cleared');
  });

  await test('completePendingAdd is a no-op when there is no pending add', async () => {
    for (const k of Object.keys(store)) delete store[k];
    store.domains = ['a.com'];
    await bg.completePendingAdd();
    assert.deepStrictEqual(store.domains, ['a.com'], 'nothing added');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

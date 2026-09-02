// Cookie Share — regression tests for the defects found in the 2026-08-29
// adversarial review (build/26-08-29-icon-and-ui/UI-BRAINSTORM.md).
// Each test names the defect it locks down. Run: node test/regressions.test.js

const assert = require('assert');

// Seeded BEFORE require so the worker's hydration sees it.
const store = {
  domains: ['example.com', 'app.example.com'],
  capturedBearerTokens: {
    'api.app.example.com': { token: 'CHILD', raw: 'Bearer CHILD' },
    'api.example.com': { token: 'PARENT', raw: 'Bearer PARENT' },
    'headers.example.com': { extraHeaders: { 'x-thing': '1' } },
  },
  settings: { gcpProjectId: 'proj-1' },
};

const spies = { fetches: [], destroyed: [], alarmsCleared: [], alarmsCreated: [], permsRemoved: [] };
let identityShouldFail = false;
let heldPermissions = null; // what chrome.permissions.getAll() reports
let openTabs = [];          // what chrome.tabs.query() reports
let tabStorage = {};        // per-tabId storage the injected script "returns"
const noop = () => {};
const listener = { addListener: noop, removeListener: noop };

let cookieResponse = [{ domain: '.example.com', name: 'sess', path: '/' }];
let cookiesThrow = false;
let cookiesThrowOnDomainQueryOnly = false; // authoritative query fails, URL queries succeed
let versionPages = [{ versions: [] }];

global.fetch = async (url, opts = {}) => {
  spies.fetches.push({ url, method: opts.method || 'GET' });
  if (url.includes(':destroy')) {
    spies.destroyed.push(url);
    // One destroy target fails, so the failure path is exercised. The destroy
    // URL is built from the version's `name`, so match on that.
    const ok = !url.includes('FAILME');
    return { ok, status: ok ? 200 : 403, json: async () => ({}), text: async () => 'denied' };
  }
  if (url.includes('/versions?')) {
    const page = versionPages.shift() || { versions: [] };
    return { ok: true, status: 200, json: async () => page, text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

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
  cookies: {
    onChanged: listener,
    getAll: async (q = {}) => {
      if (cookiesThrow) throw new Error('no permission');
      // The {domain} form is the authoritative enumeration; {url} forms are
      // supplementary. This lets a test fail only the authoritative one.
      if (cookiesThrowOnDomainQueryOnly && q.domain) throw new Error('no permission');
      if (cookiesThrowOnDomainQueryOnly) return [];
      return cookieResponse;
    },
  },
  tabs: { onUpdated: listener, onActivated: listener, query: async () => openTabs },
  scripting: { executeScript: async ({ target }) => [{ result: tabStorage[target.tabId] || { localStorage: {}, sessionStorage: {}, indexedDB: {} } }] },
  alarms: {
    onAlarm: listener,
    get: async () => null,
    create: async (n, o) => { spies.alarmsCreated.push({ n, o }); },
    clear: async (n) => { spies.alarmsCleared.push(n); return true; },
  },
  permissions: {
    remove: async (o) => {
      spies.permsRemoved.push(o);
      if (heldPermissions) {
        heldPermissions.origins = heldPermissions.origins.filter(x => !o.origins.includes(x));
      }
      return true;
    },
    contains: async () => true,
    getAll: async () => heldPermissions || { origins: [] },
    onAdded: listener,
    onRemoved: listener,
  },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  identity: {
    getAuthToken: async () => {
      if (identityShouldFail) throw new Error('The user is not signed in.');
      return { token: 'T' };
    },
    removeCachedAuthToken: async () => {},
  },
};

const bg = require('../extension/background.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

(async () => {
  // ==========================================================
  // 0.2 — secret-name collisions
  // ==========================================================
  await test('0.2: distinct domains that map to one secret id are detected', () => {
    assert.strictEqual(bg.secretIdForDomain('a-b.com'), bg.secretIdForDomain('a.b-com'),
      'precondition: the dash mapping really does collide');
    assert.strictEqual(bg.secretIdCollision('a.b-com', ['a-b.com']), 'a-b.com');
    assert.strictEqual(bg.secretIdCollision('other.com', ['a-b.com']), null);
  });

  // ==========================================================
  // 0.4 — retention actually enforced
  // ==========================================================
  await test('0.4: DISABLED versions are destroyed, not just surplus ENABLED ones', async () => {
    spies.destroyed = [];
    versionPages = [{
      versions: [
        { name: 'v/5', state: 'ENABLED', createTime: '2026-08-05T00:00:00Z' },
        { name: 'v/4', state: 'ENABLED', createTime: '2026-08-04T00:00:00Z' },
        { name: 'v/3', state: 'ENABLED', createTime: '2026-08-03T00:00:00Z' },
        { name: 'v/2', state: 'ENABLED', createTime: '2026-08-02T00:00:00Z' },
        { name: 'v/1', state: 'DISABLED', createTime: '2026-08-01T00:00:00Z' },
        { name: 'v/0', state: 'DESTROYED', createTime: '2026-07-31T00:00:00Z' },
      ],
    }];
    const res = await bg.destroyOldVersions('https://sm/v1/projects/p', 'sec', 3, {});
    assert.strictEqual(res.destroyed, 2, 'surplus enabled v/2 AND disabled v/1');
    assert.ok(spies.destroyed.some(u => u.includes('v/1')), 'the DISABLED version was destroyed');
    assert.ok(spies.destroyed.some(u => u.includes('v/2')), 'the surplus ENABLED version was destroyed');
    assert.ok(!spies.destroyed.some(u => u.includes('v/0')), 'an already-DESTROYED version is left alone');
    assert.ok(!spies.destroyed.some(u => u.includes('v/5')), 'the newest kept version survives');
  });

  await test('0.4: paginates past the first page', async () => {
    spies.destroyed = [];
    versionPages = [
      { versions: [{ name: 'v/9', state: 'ENABLED', createTime: '2026-08-09T00:00:00Z' }], nextPageToken: 'tok' },
      { versions: [{ name: 'v/8', state: 'ENABLED', createTime: '2026-08-08T00:00:00Z' }] },
    ];
    const res = await bg.destroyOldVersions('https://sm/v1/projects/p', 'sec', 1, {});
    assert.strictEqual(res.listed, 2, 'both pages were listed');
    assert.strictEqual(res.destroyed, 1);
    assert.ok(spies.destroyed.some(u => u.includes('v/8')), 'second-page version destroyed');
  });

  await test('0.4: a failed destroy is counted as failed, not reported as success', async () => {
    spies.destroyed = [];
    versionPages = [{
      versions: [
        { name: 'v/2', state: 'ENABLED', createTime: '2026-08-02T00:00:00Z' },
        { name: 'v/FAILME', state: 'ENABLED', createTime: '2026-08-01T00:00:00Z' },
      ],
    }];
    const res = await bg.destroyOldVersions('https://sm/v1/projects/p', 'sec', 1, {});
    assert.strictEqual(res.failed, 1);
    assert.strictEqual(res.destroyed, 0);
  });

  // ==========================================================
  // 0.5 — logout propagates, but a closed tab still cannot wipe data
  // ==========================================================
  await test('0.5: an unreadable empty read still preserves LKG (the data-loss guard)', () => {
    const lkg = { cookies: [{ name: 'sess' }], localStorage: { 'https://a': { k: '1' } } };
    const merged = bg.mergeSnapshot({ cookies: [], localStorage: {} }, lkg, { cookies: false, storage: false });
    assert.strictEqual(merged.cookies.length, 1, 'cookies preserved when the read failed');
    assert.strictEqual(merged.localStorage['https://a'].k, '1', 'storage preserved with no tab open');
  });

  await test('0.5: a readable empty cookie read clears cookies (logout is visible)', () => {
    const lkg = { cookies: [{ name: 'sess' }] };
    const merged = bg.mergeSnapshot({ cookies: [] }, lkg, { cookies: true, storage: false });
    assert.strictEqual(merged.cookies.length, 0, 'an authoritative empty read wins');
  });

  await test('0.5: a readable empty origin clears that origin only', () => {
    const lkg = { 'https://a': { k: '1' }, 'https://b': { k: '2' } };
    const out = bg.mergeByOrigin({ 'https://a': {} }, lkg, true);
    assert.deepStrictEqual(out['https://a'], {}, 'the origin we read and found empty is cleared');
    assert.strictEqual(out['https://b'].k, '2', 'an origin we never read is carried forward');
  });

  await test('0.5: omitting the readable argument keeps the old conservative behavior', () => {
    const out = bg.mergeByOrigin({ 'https://a': {} }, { 'https://a': { k: '1' } });
    assert.strictEqual(out['https://a'].k, '1');
  });

  // ==========================================================
  // 0.6 — overlapping domains, counts, alarms, validation
  // ==========================================================
  await test('0.6: a child domain token does not leak into the parent secret', async () => {
    const parent = await bg.getBearerTokensForDomain('example.com');
    const child = await bg.getBearerTokensForDomain('app.example.com');
    assert.ok(!('api.app.example.com' in parent), 'child host must not appear under the parent');
    assert.ok('api.app.example.com' in child, 'child host belongs to the child domain');
    assert.ok('api.example.com' in parent, 'a host with no more-specific match stays with the parent');
  });

  await test('0.6: auth tokens and header-only hosts are counted separately', () => {
    const byHost = {
      a: { token: 'X', raw: 'Bearer X' },
      b: { extraHeaders: { 'x-y': '1' } },
      c: { raw: 'raw-token' },
    };
    assert.strictEqual(bg.countAuthTokens(byHost), 2);
    assert.strictEqual(bg.countHeaderOnlyHosts(byHost), 1);
  });

  await test('0.6: cookie and navigation syncs use separate alarms', () => {
    const names = bg.syncAlarmNames('example.com');
    assert.ok(names.includes('sync-cookie-example.com'));
    assert.ok(names.includes('sync-nav-example.com'));
    assert.ok(names.includes('sync-example.com'), 'legacy name still cleared');
    assert.strictEqual(bg.domainFromSyncAlarm('sync-cookie-example.com'), 'example.com');
    assert.strictEqual(bg.domainFromSyncAlarm('sync-nav-example.com'), 'example.com');
    assert.strictEqual(bg.domainFromSyncAlarm('sync-example.com'), 'example.com');
    assert.strictEqual(bg.domainFromSyncAlarm('periodic-sync'), null);
  });

  await test('0.6: domain input is normalized, and junk is rejected', () => {
    assert.strictEqual(bg.normalizeDomain('  HTTPS://WWW.Example.com:8443/path?q=1 '), 'example.com');
    assert.strictEqual(bg.normalizeDomain('user@example.com'), 'example.com');
    assert.strictEqual(bg.normalizeDomain('example.com.'), 'example.com');
    assert.strictEqual(bg.normalizeDomain('not a domain'), null);
    assert.strictEqual(bg.normalizeDomain('localhost'), null, 'dotless host has no cookie scope');
    assert.strictEqual(bg.normalizeDomain('-bad.com'), null);
    assert.strictEqual(bg.normalizeDomain(''), null);
    assert.strictEqual(bg.normalizeDomain(null), null);
  });

  // ==========================================================
  // 1.4 — permission scope never reaches a public suffix
  // ==========================================================
  await test('1.4: the parent walk stops at the registrable domain', () => {
    assert.strictEqual(bg.registrableDomain('app.example.co.uk'), 'example.co.uk');
    assert.strictEqual(bg.registrableDomain('a.b.example.com'), 'example.com');
    assert.strictEqual(bg.registrableDomain('example.com'), 'example.com');
  });

  await test('1.4: originsForDomain never requests a public suffix', () => {
    const origins = bg.originsForDomain('app.example.co.uk');
    assert.ok(origins.includes('*://*.example.co.uk/*'), 'registrable parent included for parent cookies');
    assert.ok(!origins.some(o => o.includes('*.co.uk/*') && !o.includes('example')),
      'must never ask for the co.uk public suffix');
    assert.deepStrictEqual(bg.originsForDomain('example.com'),
      ['*://example.com/*', '*://*.example.com/*'], 'no parent walk when already registrable');
  });

  // ==========================================================
  // Handler-level: validation, collisions, honest syncAll
  // ==========================================================
  await test('addDomain rejects a malformed domain instead of storing it', async () => {
    const before = (await bg.handleMessage({ type: 'getDomains' })).domains.slice();
    const resp = await bg.handleMessage({ type: 'addDomain', domain: 'not a domain' });
    assert.ok(resp.error, 'an error is returned');
    const after = (await bg.handleMessage({ type: 'getDomains' })).domains;
    assert.deepStrictEqual(after, before, 'the watched list is unchanged');
  });

  await test('addDomain refuses a domain that would share a secret with an existing one', async () => {
    store.domains = ['a-b.com'];
    const resp = await bg.handleMessage({ type: 'addDomain', domain: 'a.b-com' });
    assert.ok(resp.error && /a-b\.com/.test(resp.error), 'names the conflicting domain');
    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, ['a-b.com']);
  });

  await test('importState drops invalid entries instead of storing them', async () => {
    const resp = await bg.handleMessage({
      type: 'importState',
      state: { domains: ['Good.com', 'not a domain', 'WWW.Other.com'] },
    });
    assert.deepStrictEqual(resp.domains, ['good.com', 'other.com'], 'normalized and filtered');
    assert.strictEqual(resp.rejected.length, 1);
  });

  await test('0.3: syncAll reports failures instead of always claiming success', async () => {
    store.domains = ['fails.com'];
    store.settings = {}; // no project → syncDomain throws inside pushToSecretManager
    const resp = await bg.handleMessage({ type: 'syncAll' });
    assert.strictEqual(resp.total, 1);
    assert.strictEqual(resp.failed, 1, 'the failure is counted');
    assert.strictEqual(resp.succeeded, 0);
    assert.strictEqual(resp.ok, false, 'the handler flag reflects the failure');
    assert.strictEqual(resp.errors.length, 1);
    assert.ok(/project/i.test(resp.errors[0].error), 'the real reason is surfaced');
  });

  // ==========================================================
  // 0.1 / 1.2 — destination in the hash, and lastSuccess survives a skip
  // ==========================================================
  await test('0.1 + 1.2: unchanged content skips the push, keeps lastSuccess, and re-pushes on project change', async () => {
    store.domains = ['example.com'];
    store.settings = { gcpProjectId: 'proj-1' };
    delete store['pushHash_example.com'];
    delete store['lkg_example.com'];
    delete store['syncStatus_example.com'];
    cookieResponse = [{ domain: '.example.com', name: 'sess', path: '/' }];
    versionPages = [{ versions: [] }, { versions: [] }, { versions: [] }];

    await bg.syncDomain('example.com', {});
    const first = store['syncStatus_example.com'];
    assert.ok(first.lastSuccess, 'first sync records an upload');
    assert.strictEqual(first.skipped, false);

    // Same content, same project → skip. lastSuccess must survive: updateStatus
    // merges with a spread, and passing `undefined` used to erase it.
    versionPages = [{ versions: [] }];
    await bg.syncDomain('example.com', {});
    const second = store['syncStatus_example.com'];
    assert.strictEqual(second.skipped, true, 'unchanged content is not re-uploaded');
    assert.strictEqual(second.lastSuccess, first.lastSuccess, 'lastSuccess was not clobbered by the skip');

    // Same content, DIFFERENT project → must push, or the new project silently
    // never receives the secret at all.
    store.settings = { gcpProjectId: 'proj-2' };
    versionPages = [{ versions: [] }];
    await bg.syncDomain('example.com', {});
    assert.strictEqual(store['syncStatus_example.com'].skipped, false,
      'a changed destination forces a real push');
  });

  await test('0.5 end-to-end: a readable empty cookie read after having cookies clears the session', async () => {
    store.domains = ['example.com'];
    store.settings = { gcpProjectId: 'proj-1' };
    store['lkg_example.com'] = {
      cookies: [{ domain: '.example.com', name: 'sess', path: '/' }],
      localStorage: { 'https://example.com': { tok: 'x' } },
      sessionStorage: {}, indexedDB: {}, bearerTokens: {},
    };
    delete store['pushHash_example.com'];
    cookieResponse = [];          // logged out, and the read succeeded
    // Corroboration: a tab IS open and its storage is genuinely empty too.
    openTabs = [{ id: 1, url: 'https://example.com/', incognito: false }];
    tabStorage = { 1: { localStorage: {}, sessionStorage: {}, indexedDB: {} } };
    versionPages = [{ versions: [] }];

    await bg.syncDomain('example.com', {});
    openTabs = []; tabStorage = {};
    const lkg = store['lkg_example.com'];
    assert.strictEqual(lkg.cookies.length, 0, 'cookies cleared');
    assert.deepStrictEqual(lkg.localStorage, {}, 'stale storage cleared on logout');
  });

  await test('0.5: cookies expiring does NOT wipe a session that still lives in localStorage', async () => {
    store.domains = ['example.com'];
    bg._setWatchedDomainsCache(['example.com']);
    store.settings = { gcpProjectId: 'proj-1' };
    store['lkg_example.com'] = {
      cookies: [{ domain: '.example.com', name: 'sess', path: '/' }],
      localStorage: { 'https://example.com': { token: 'still-valid' } },
      sessionStorage: {}, indexedDB: {}, bearerTokens: {},
    };
    delete store['pushHash_example.com'];
    cookieResponse = [];   // cookies gone...
    // ...but the tab still holds an auth token. Declaring logout here would
    // destroy a working session.
    openTabs = [{ id: 1, url: 'https://example.com/', incognito: false }];
    tabStorage = { 1: { localStorage: { token: 'still-valid' }, sessionStorage: {}, indexedDB: {} } };
    versionPages = [{ versions: [] }];

    await bg.syncDomain('example.com', {});
    openTabs = []; tabStorage = {};
    const lkg = store['lkg_example.com'];
    assert.ok(Object.keys(lkg.localStorage).length > 0,
      'storage-borne credentials must survive the cookies expiring');
  });

  await test('0.5 end-to-end: a FAILED cookie read does not clear anything', async () => {
    store.domains = ['example.com'];
    store['lkg_example.com'] = {
      cookies: [{ domain: '.example.com', name: 'sess', path: '/' }],
      localStorage: { 'https://example.com': { tok: 'x' } },
      sessionStorage: {}, indexedDB: {}, bearerTokens: {},
    };
    delete store['pushHash_example.com'];
    cookiesThrow = true;
    versionPages = [{ versions: [] }];

    await bg.syncDomain('example.com', {});
    cookiesThrow = false;
    assert.strictEqual(store['lkg_example.com'].cookies.length, 1,
      'a permission failure must never be mistaken for a logout');
  });

  // ==========================================================
  // Findings from the fresh-verifier pass on a0056bf
  // ==========================================================
  await test('V1: a PARTIAL cookie-read failure is not treated as a logout', async () => {
    store.domains = ['example.com'];
    store.settings = { gcpProjectId: 'proj-1' };
    store['lkg_example.com'] = {
      cookies: [{ domain: '.example.com', name: 'sess', path: '/' }],
      localStorage: { 'https://example.com': { tok: 'x' } },
      sessionStorage: {}, indexedDB: {}, bearerTokens: {},
    };
    delete store['pushHash_example.com'];
    // Authoritative {domain} query fails; the supplementary {url} queries
    // succeed and return nothing. Marking that readable would wipe a live
    // session — which is exactly what the first implementation did.
    cookiesThrowOnDomainQueryOnly = true;
    versionPages = [{ versions: [] }];
    await bg.syncDomain('example.com', {});
    cookiesThrowOnDomainQueryOnly = false;

    assert.strictEqual(store['lkg_example.com'].cookies.length, 1, 'cookies survive a partial read failure');
    assert.ok(store['lkg_example.com'].localStorage['https://example.com'], 'storage survives too');
  });

  await test('V2: completePendingAdd normalizes and enforces collisions', async () => {
    store.domains = ['a-b.com'];
    store.pendingAdd = 'a.b-com';   // collides with a-b.com
    await bg.completePendingAdd();
    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, ['a-b.com'],
      'the colliding domain was refused on the popup path too');

    store.domains = [];
    store.pendingAdd = 'HTTPS://WWW.Example.com/path';
    await bg.completePendingAdd();
    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, ['example.com'],
      'the popup path normalizes before storing');

    store.domains = [];
    store.pendingAdd = 'not a domain';
    await bg.completePendingAdd();
    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, [],
      'junk is discarded, not stored');
  });

  await test('V3: a public suffix cannot be added, so its origins are never requested', () => {
    assert.strictEqual(bg.normalizeDomain('co.uk'), null);
    assert.strictEqual(bg.normalizeDomain('com.au'), null);
    assert.strictEqual(bg.isValidDomain('co.uk'), false);
    assert.strictEqual(bg.normalizeDomain('example.co.uk'), 'example.co.uk', 'a real domain under it still works');
  });

  await test('V4: child auth already stored in a parent LKG is retired, not re-uploaded', async () => {
    // completePendingAdd (used in V2) kicks off a sync it does not await, and
    // syncDomain deliberately coalesces concurrent non-interactive calls — so
    // drain that first, or this test silently measures the earlier sync.
    await bg.syncDomain('example.com', { interactive: true }).catch(() => {});

    store.domains = ['example.com', 'app.example.com'];
    // The in-memory watch cache is what ownership is judged against, and it is
    // only refreshed through handlers — set it explicitly.
    bg._setWatchedDomainsCache(['example.com', 'app.example.com']);
    store.settings = { gcpProjectId: 'proj-1' };
    store['lkg_example.com'] = {
      cookies: [{ domain: '.example.com', name: 'sess', path: '/' }],
      localStorage: {}, sessionStorage: {}, indexedDB: {},
      // Leaked there by an older build.
      bearerTokens: {
        'api.example.com': { token: 'PARENT', raw: 'Bearer PARENT' },
        'api.app.example.com': { token: 'CHILD', raw: 'Bearer CHILD' },
      },
    };
    delete store['pushHash_example.com'];
    cookieResponse = [{ domain: '.example.com', name: 'sess', path: '/' }];
    versionPages = [{ versions: [] }];

    // interactive: true chains after any in-flight sync instead of reusing it.
    await bg.syncDomain('example.com', { interactive: true });
    const tokens = store['lkg_example.com'].bearerTokens;
    assert.ok(!('api.app.example.com' in tokens), 'the child token was retired from the parent');
    assert.ok('api.example.com' in tokens, 'the parent keeps its own token');
  });

  await test('V5: logging out of a parent keeps a watched child\'s captured auth', async () => {
    store.domains = ['example.com', 'app.example.com'];
    bg._setWatchedDomainsCache(['example.com', 'app.example.com']);
    // Re-seed: earlier tests in this file legitimately purge these.
    Object.assign(bg._capturedBearerTokens, {
      'api.app.example.com': { token: 'CHILD', raw: 'Bearer CHILD' },
      'api.example.com': { token: 'PARENT', raw: 'Bearer PARENT' },
    });

    await bg.purgeCapturedAuthForDomain('example.com');

    const child = await bg.getBearerTokensForDomain('app.example.com');
    assert.ok('api.app.example.com' in child, 'the separately-watched child was not collaterally purged');
    const parent = await bg.getBearerTokensForDomain('example.com');
    assert.ok(!('api.example.com' in parent), 'the parent\'s own token WAS purged');
  });

  await test('V6: destroyOldVersions reports an incomplete sweep instead of a clean one', async () => {
    // Every page returns a nextPageToken, so the cap is hit with work outstanding.
    versionPages = Array.from({ length: 25 }, () => ({
      versions: [{ name: 'v/x', state: 'ENABLED', createTime: '2026-08-01T00:00:00Z' }],
      nextPageToken: 'more',
    }));
    const res = await bg.destroyOldVersions('https://sm/v1/projects/p', 'sec', 1, {});
    assert.strictEqual(res.incomplete, true, 'a truncated listing is reported as incomplete');
  });

  await test('V7: syncAll summary does not overwrite the handler\'s boolean ok', async () => {
    store.domains = [];
    const resp = await bg.handleMessage({ type: 'syncAll' });
    assert.strictEqual(resp.ok, true, 'a zero-domain run is ok:true, not ok:0');
    assert.strictEqual(resp.succeeded, 0);
    assert.strictEqual(typeof resp.ok, 'boolean');
  });

  // ==========================================================
  // Findings from the SECOND verification round (on 079c70e)
  // ==========================================================
  await test('W1: logging out of a CHILD retires the child\'s own captured auth', async () => {
    const watched = ['example.com', 'app.example.com'];
    bg._setWatchedDomainsCache(watched);
    Object.assign(bg._capturedBearerTokens, {
      'api.app.example.com': { token: 'CHILD', raw: 'Bearer CHILD' },
      'api.example.com': { token: 'PARENT', raw: 'Bearer PARENT' },
    });

    await bg.purgeCapturedAuthForDomain('app.example.com', watched);

    const child = await bg.getBearerTokensForDomain('app.example.com');
    assert.ok(!('api.app.example.com' in child),
      'the child\'s own token must be retired — a watched parent is not another owner');
    const parent = await bg.getBearerTokensForDomain('example.com');
    assert.ok('api.example.com' in parent, 'the parent keeps its own, untouched');
  });

  await test('W1b: parent logout still spares a separately-watched child (both directions hold)', async () => {
    const watched = ['example.com', 'app.example.com'];
    bg._setWatchedDomainsCache(watched);
    Object.assign(bg._capturedBearerTokens, {
      'api.app.example.com': { token: 'CHILD', raw: 'Bearer CHILD' },
      'api.example.com': { token: 'PARENT', raw: 'Bearer PARENT' },
    });

    await bg.purgeCapturedAuthForDomain('example.com', watched);

    assert.ok('api.app.example.com' in await bg.getBearerTokensForDomain('app.example.com'),
      'child survives a parent logout');
    assert.ok(!('api.example.com' in await bg.getBearerTokensForDomain('example.com')),
      'parent retires its own');
  });

  await test('W2: an unknown watch set never discards stored auth', () => {
    const stored = { 'api.example.com': { token: 'X' }, 'api.app.example.com': { token: 'Y' } };
    // Hydration swallows its own errors; an empty cache must not be read as
    // "nothing is watched, so delete everything".
    assert.deepStrictEqual(bg.ownedBearerTokens(stored, 'example.com', []), stored);
    assert.deepStrictEqual(bg.ownedBearerTokens(stored, 'example.com', undefined), stored);
    // With a real list, filtering resumes.
    const filtered = bg.ownedBearerTokens(stored, 'example.com', ['example.com', 'app.example.com']);
    assert.ok('api.example.com' in filtered);
    assert.ok(!('api.app.example.com' in filtered));
  });

  await test('W3: a refused collision hands back the permission and surfaces the reason', async () => {
    spies.permsRemoved = [];
    store.domains = ['a-b.com'];
    bg._setWatchedDomainsCache(['a-b.com']);
    store.pendingAdd = 'a.b-com';
    delete store.lastAddError;

    await bg.completePendingAdd();

    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, ['a-b.com'],
      'still refused');
    assert.ok(spies.permsRemoved.length > 0, 'the just-granted host permission was handed back');
    const taken = await bg.handleMessage({ type: 'takeLastAddError' });
    assert.ok(taken.error && /a-b\.com/.test(taken.error), 'the reason is retrievable by the popup');
    const again = await bg.handleMessage({ type: 'takeLastAddError' });
    assert.strictEqual(again.error, null, 'and is cleared once read');
  });

  await test('W4: private-registry suffixes are refused too', () => {
    for (const s of ['uk.com', 'blogspot.com', 'cloudfront.net', 'com.de']) {
      assert.strictEqual(bg.normalizeDomain(s), null, `${s} must not be watchable`);
    }
    assert.strictEqual(bg.normalizeDomain('mysite.uk.com'), 'mysite.uk.com', 'a real domain under one still works');
    assert.ok(!bg.originsForDomain('mysite.uk.com').includes('*://*.uk.com/*'),
      'and its parent walk stops before the registry');
  });

  await test('W5: authStatus reads Chrome directly, not the in-memory token cache', async () => {
    identityShouldFail = true;
    const out = await bg.handleMessage({ type: 'authStatus' });
    identityShouldFail = false;
    assert.strictEqual(out.signedIn, false,
      'a signed-out browser reports signed-out even though getToken has a cached token');
  });

  // ==========================================================
  // Findings from the THIRD verification round (on a752434)
  // ==========================================================
  await test('X1: three-label suffixes work, so no registry-wide wildcard is requested', () => {
    // Matching only the last two labels made every three-label entry dead.
    assert.strictEqual(bg.registrableDomain('tenant.s3.amazonaws.com'), 'tenant.s3.amazonaws.com');
    assert.ok(!bg.originsForDomain('tenant.s3.amazonaws.com').includes('*://*.amazonaws.com/*'),
      'must never ask for the whole of amazonaws.com');
    // Two-label suffixes still behave.
    assert.strictEqual(bg.registrableDomain('app.example.co.uk'), 'example.co.uk');
    assert.strictEqual(bg.registrableDomain('a.b.example.com'), 'example.com');
  });

  await test('X2: a legitimate subdomain is still watchable (the suffix guard is not overzealous)', () => {
    assert.strictEqual(bg.normalizeDomain('app.example.com'), 'app.example.com');
    assert.strictEqual(bg.normalizeDomain('deep.a.b.example.co.uk'), 'deep.a.b.example.co.uk');
    assert.deepStrictEqual(bg.originsForDomain('app.example.com'),
      ['*://app.example.com/*', '*://*.app.example.com/*', '*://example.com/*', '*://*.example.com/*'],
      'the registrable parent is still included, so parent cookies remain readable');
  });

  await test('X3: removal hands back the registrable-parent grant too', async () => {
    spies.permsRemoved = [];
    store.domains = ['app.example.com'];
    bg._setWatchedDomainsCache(['app.example.com']);
    await bg.handleMessage({ type: 'removeDomain', domain: 'app.example.com' });
    const removed = spies.permsRemoved.flatMap(o => o.origins);
    assert.ok(removed.includes('*://*.example.com/*'),
      'the parent origin the add requested must not be left behind');
    assert.ok(removed.includes('*://app.example.com/*'));
  });

  await test('X4: removal keeps origins another watched domain still needs', async () => {
    spies.permsRemoved = [];
    // example.com stays watched, so its origins must survive removing the child.
    await bg.handleMessage({ type: 'importState', state: { domains: ['app.example.com', 'example.com'] } });
    await bg.handleMessage({ type: 'removeDomain', domain: 'app.example.com' });
    const removed = spies.permsRemoved.flatMap(o => o.origins || []);
    assert.ok(!removed.includes('*://*.example.com/*'),
      'the still-watched parent keeps its own grant');
    assert.ok(removed.includes('*://app.example.com/*'), 'the child\'s own origins still go back');
  });

  await test('X5: a refused collision hands back the FULL grant, parent included', async () => {
    spies.permsRemoved = [];
    store.domains = ['a-b.com'];
    bg._setWatchedDomainsCache(['a-b.com']);
    const resp = await bg.handleMessage({ type: 'addDomain', domain: 'a.b-com' });
    assert.ok(resp.error, 'still refused');
    assert.ok(spies.permsRemoved.length > 0, 'the grant obtained for the refused domain is returned');
  });

  await test('X6: a grant for a PARENT does not silently adopt a pending child intent', async () => {
    // Intent is recorded when the popup opens, so it can outlive the popup.
    // permissions.contains() does pattern subsumption — granting
    // *://*.example.com/* for example.com would also "contain" the child's
    // origins and start watching a domain the user never chose.
    store.domains = [];
    bg._setWatchedDomainsCache([]);
    store.pendingAdd = 'app.example.com';

    await bg.completePendingAdd({ origins: ['*://example.com/*', '*://*.example.com/*'] });

    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, [],
      'the child must NOT be adopted by the parent\'s grant');
    assert.strictEqual(store.pendingAdd, 'app.example.com', 'and the intent is left standing');

    // The child's own grant still completes it.
    await bg.completePendingAdd({ origins: ['*://app.example.com/*', '*://*.app.example.com/*'] });
    assert.deepStrictEqual((await bg.handleMessage({ type: 'getDomains' })).domains, ['app.example.com']);
  });

  await test('X7: an upgrade reclaims over-broad grants an older build requested', async () => {
    // Set up the watch list FIRST: import now reclaims strays itself, so
    // seeding the legacy grants before it would let import consume them and
    // leave this test asserting against an already-cleaned state.
    await bg.handleMessage({ type: 'importState', state: { domains: ['app.example.com'] } });

    // Old builds walked every parent suffix and never gave the grants back.
    heldPermissions = {
      origins: [
        '*://app.example.com/*', '*://*.app.example.com/*',
        '*://example.com/*', '*://*.example.com/*',
        '*://*.co.uk/*',            // public-suffix grant from an older build
        '*://*.amazonaws.com/*',    // registry-wide grant from an older build
        '*://unrelated.org/*',      // for a domain no longer watched
      ],
    };
    spies.permsRemoved = [];

    const res = await bg.reclaimStrayOrigins();
    assert.ok(res.removed.includes('*://*.co.uk/*'), 'public-suffix grant reclaimed');
    assert.ok(res.removed.includes('*://*.amazonaws.com/*'), 'registry-wide grant reclaimed');
    assert.ok(res.removed.includes('*://unrelated.org/*'), 'grant for an unwatched domain reclaimed');
    assert.ok(!res.removed.includes('*://*.example.com/*'),
      'the registrable parent the watched subdomain needs is kept');
    assert.ok(!res.removed.includes('*://app.example.com/*'), 'the watched domain keeps its own');
  });

  await test('X8: revocation re-reads the watch list, so a concurrent add is not stripped', async () => {
    spies.permsRemoved = [];
    await bg.handleMessage({ type: 'importState', state: { domains: ['app.example.com', 'api.example.com'] } });
    // Both need *://*.example.com/*; removing one must not take it away.
    await bg.handleMessage({ type: 'removeDomain', domain: 'app.example.com' });
    const removed = spies.permsRemoved.flatMap(o => o.origins || []);
    assert.ok(!removed.includes('*://*.example.com/*'),
      'the parent scope the remaining sibling needs must survive');
    assert.ok(removed.includes('*://app.example.com/*'));
  });

  // ==========================================================
  // Findings from the FIFTH verification round (on 914fa53)
  // ==========================================================
  await test('Y1: a watched child\'s storage does not land in the parent\'s secret', async () => {
    const watched = ['example.com', 'app.example.com'];
    store.domains = watched;
    bg._setWatchedDomainsCache(watched);
    openTabs = [
      { id: 1, url: 'https://example.com/', incognito: false },
      { id: 2, url: 'https://app.example.com/', incognito: false },   // owned by the child
    ];
    tabStorage = {
      1: { localStorage: { parent: 'p' }, sessionStorage: {}, indexedDB: {} },
      2: { localStorage: { childSecret: 'c' }, sessionStorage: {}, indexedDB: {} },
    };

    const parent = await bg.getStorageForDomain('example.com', watched);
    const child = await bg.getStorageForDomain('app.example.com', watched);
    openTabs = []; tabStorage = {};

    assert.ok(!JSON.stringify(parent.localStorage).includes('childSecret'),
      'the child tab\'s storage must not be collected for the parent');
    assert.ok(JSON.stringify(parent.localStorage).includes('parent'), 'the parent still gets its own');
    assert.ok(JSON.stringify(child.localStorage).includes('childSecret'), 'the child gets its own');
  });

  await test('Y2: an unwatched subdomain\'s storage still belongs to its parent', async () => {
    const watched = ['example.com'];
    store.domains = watched;
    bg._setWatchedDomainsCache(watched);
    openTabs = [{ id: 3, url: 'https://cdn.example.com/', incognito: false }];
    tabStorage = { 3: { localStorage: { sub: 's' }, sessionStorage: {}, indexedDB: {} } };

    const parent = await bg.getStorageForDomain('example.com', watched);
    openTabs = []; tabStorage = {};
    assert.ok(JSON.stringify(parent.localStorage).includes('sub'),
      'with no more-specific watch, the subdomain is part of the parent session');
  });

  await test('Y3: a child-scoped cookie does not land in the parent\'s secret', async () => {
    const watched = ['example.com', 'app.example.com'];
    store.domains = watched;
    bg._setWatchedDomainsCache(watched);
    cookieResponse = [
      { domain: '.example.com', name: 'shared', path: '/' },
      { domain: '.app.example.com', name: 'childonly', path: '/' },
      { domain: 'app.example.com', name: 'childhostonly', path: '/' },
    ];

    const parent = await bg.getCookiesForDomain('example.com', watched);
    const child = await bg.getCookiesForDomain('app.example.com', watched);
    cookieResponse = [{ domain: '.example.com', name: 'sess', path: '/' }];

    const names = (r) => r.cookies.map(c => c.name).sort();
    assert.deepStrictEqual(names(parent), ['shared'], 'parent keeps only what it owns');
    assert.deepStrictEqual(names(child), ['childhostonly', 'childonly'], 'child keeps its own');
  });

  await test('Y4: import purges state for domains it drops', async () => {
    await bg.handleMessage({ type: 'importState', state: { domains: ['example.com', 'gone.com'] } });
    store['lkg_gone.com'] = { cookies: [{ name: 'x' }] };
    store['syncStatus_gone.com'] = { lastSync: 'x' };
    Object.assign(bg._capturedBearerTokens, { 'api.gone.com': { token: 'G' } });

    await bg.handleMessage({ type: 'importState', state: { domains: ['example.com'] } });

    assert.ok(!('lkg_gone.com' in store), 'dropped domain\'s last-known-good is purged');
    assert.ok(!('syncStatus_gone.com' in store), 'and its status');
    assert.ok(!('api.gone.com' in bg._capturedBearerTokens), 'and its captured auth');
  });

  await test('Y5: revocation uses the watch list as of revoke time, not a stale snapshot', async () => {
    // Simulate a concurrent add landing between the lock and the revoke: the
    // sibling that needs the shared parent scope appears only on the later read.
    await bg.handleMessage({ type: 'importState', state: { domains: ['app.example.com'] } });
    spies.permsRemoved = [];
    const realGet = chrome.storage.local.get;
    let reads = 0;
    chrome.storage.local.get = async (keys) => {
      const out = await realGet(keys);
      const wantsDomains = keys === 'domains' || (Array.isArray(keys) && keys.includes('domains'));
      if (wantsDomains && ++reads >= 2) out.domains = ['api.example.com']; // added concurrently
      return out;
    };
    await bg.handleMessage({ type: 'removeDomain', domain: 'app.example.com' });
    chrome.storage.local.get = realGet;

    const removed = spies.permsRemoved.flatMap(o => o.origins || []);
    assert.ok(!removed.includes('*://*.example.com/*'),
      'the concurrently-added sibling keeps the parent scope it needs');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

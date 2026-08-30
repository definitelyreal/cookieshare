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

const spies = { fetches: [], destroyed: [], alarmsCleared: [], alarmsCreated: [] };
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
  tabs: { onUpdated: listener, onActivated: listener, query: async () => [] },
  alarms: {
    onAlarm: listener,
    get: async () => null,
    create: async (n, o) => { spies.alarmsCreated.push({ n, o }); },
    clear: async (n) => { spies.alarmsCleared.push(n); return true; },
  },
  permissions: { remove: async () => true, contains: async () => true, onAdded: listener, onRemoved: listener },
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
    versionPages = [{ versions: [] }];

    await bg.syncDomain('example.com', {});
    const lkg = store['lkg_example.com'];
    assert.strictEqual(lkg.cookies.length, 0, 'cookies cleared');
    assert.deepStrictEqual(lkg.localStorage, {}, 'stale storage cleared on logout');
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

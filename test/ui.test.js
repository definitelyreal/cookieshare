// Cookie Share — UI smoke tests for popup.js / options.js.
//
// The popup and options scripts had no coverage at all, and three real bugs
// were found in them by reading (a banner that was never shown, a button
// inside a container that gets hidden, an await that costs the user gesture).
// This exercises the actual scripts against a hand-rolled DOM, in the same
// dependency-free style as the chrome mock in the other test files.
//
// Run: node test/ui.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');

// ============================================================
// Minimal DOM: an id-addressed element map built from the real HTML.
// Not a tree — enough to run the scripts and catch missing ids, bad property
// use, and exceptions escaping the handlers.
// ============================================================

class El {
  constructor(id = '') {
    this.id = id;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.href = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attrs = {};
    this._classes = new Set();
    this._listeners = {};
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c); else self._classes.delete(c);
        return on;
      },
    };
  }
  get hidden() { return this._classes.has('hidden'); }
  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); }
  async fire(ev, arg) {
    for (const fn of (this._listeners[ev] || [])) await fn(arg || { preventDefault() {}, target: this });
  }
  append(...kids) { this.children.push(...kids); }
  appendChild(k) { this.children.push(k); return k; }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  click() { return this.fire('click'); }
}

function buildDom(htmlFile) {
  const html = read(htmlFile);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const byId = new Map(ids.map(id => [id, new El(id)]));
  const doc = {
    _ready: [],
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') doc._ready.push(fn); },
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        // A missing id is a bug in the page, not something to paper over.
        if (!byId.has(id)) throw new Error(`popup/options script referenced #${id}, absent from ${htmlFile}`);
        return byId.get(id);
      }
      return new El();
    },
    createElement: () => new El(),
    createTextNode: (t) => { const e = new El(); e.textContent = String(t); return e; },
    body: new El(),
  };
  return { doc, byId, html };
}

// ============================================================
// Script runner
// ============================================================

function runScript(file, { doc, chrome, extras = {} }) {
  const ctx = {
    document: doc,
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    navigator: { clipboard: { writeText: async () => {} } },
    window: { close() {} },
    // Must be the real URL constructor — the scripts parse tab URLs with it.
    // A bare object stub here silently made every page look unparseable.
    URL: Object.assign(class extends URL {}, {
      createObjectURL: () => 'blob:x',
      revokeObjectURL() {},
    }),
    Blob: class { constructor(p) { this.p = p; } },
    Promise, Object, Array, JSON, Date, String, Number, Math, Error, Set, Map,
    ...extras,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read(file), ctx, { filename: file });
  return ctx;
}

function makeChrome({ responses = {}, settings = {}, signedIn = true, domains = ['example.com'], statuses = {} } = {}) {
  const sent = [];
  return {
    sent,
    api: {
      runtime: {
        getURL: (p) => p,
        openOptionsPage() {},
        sendMessage: async (msg) => {
          sent.push(msg);
          if (msg.type in responses) return responses[msg.type];
          switch (msg.type) {
            case 'getDomains': return { domains };
            case 'getStatus': return { statuses };
            case 'authStatus': return { signedIn };
            case 'takeLastAddError': return { error: null };
            case 'getOrigins': return { domain: msg.domain, origins: [`*://${msg.domain}/*`] };
            case 'getSecretInfo': return { secretId: 'cookie-share-example-com', project: 'proj-1' };
            case 'getDomainExpiry': return { earliestExpiryMs: null, nowMs: Date.now(), warningThresholdMs: 1000 };
            case 'removeDomain': return { domains: [] };
            case 'deleteCloudSecret': return { ok: true, secretId: 'cookie-share-example-com' };
            case 'syncDomain': return { ok: true };
            case 'authenticate': return { success: true };
            default: return {};
          }
        },
      },
      storage: { local: { get: async () => ({ settings }), set: async () => {}, remove: async () => {} } },
      tabs: { query: async () => [{ url: 'https://example.com/page' }] },
      permissions: { contains: async () => true, request: async () => true },
      identity: {},
    },
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
// Several handlers deliberately fire-and-forget (so the popup paints before
// slow probes land), so drain a few macrotask turns, not just one.
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// Does an await sit between the click and permissions.request? Exclude the
// request's own `await`, which is expected.
function awaitBeforeRequest(src, fnName) {
  const start = src.indexOf(`async function ${fnName}`);
  const end = src.indexOf('permissions.request', start);
  const lines = src.slice(start, end).split('\n');
  lines.pop(); // the request's own line, whose `await` is fine
  return lines.some(l => /\bawait\b/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
}

(async () => {
  // ==========================================================
  // Popup
  // ==========================================================
  await test('popup: initializes on a watched site without throwing', async () => {
    const { doc, byId } = buildDom('popup.html');
    const ch = makeChrome({ statuses: { 'example.com': { lastSync: new Date().toISOString(), lastSuccess: new Date().toISOString(), cookieCount: 3, localStorageKeys: 2, indexedDBKeys: 1, authTokenCount: 1 } } });
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();

    assert.ok(!byId.get('status-section').hidden, 'watched state is shown');
    assert.ok(byId.get('add-section').hidden, 'add state is hidden');
    assert.strictEqual(byId.get('watched-domain').textContent, 'example.com');
    assert.strictEqual(byId.get('secret-id').textContent, 'cookie-share-example-com');
    // Storage total must include IndexedDB — it was captured but never shown.
    assert.strictEqual(byId.get('storage-count').textContent, '3', '2 storage keys + 1 indexedDB key');
  });

  await test('popup: shows "never uploaded" when synced but never actually pushed', async () => {
    const { doc, byId } = buildDom('popup.html');
    const ch = makeChrome({ statuses: { 'example.com': { lastSync: new Date().toISOString(), cookieCount: 1 } } });
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    assert.strictEqual(byId.get('last-upload').textContent, 'never uploaded',
      'a skipped-only history must not read as a recent upload');
  });

  await test('popup: signed-out shows the banner, even with no GCP project set', async () => {
    const { doc, byId } = buildDom('popup.html');
    // No project configured — the case the early return used to skip entirely.
    const ch = makeChrome({ signedIn: false, settings: {} });
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    assert.ok(!byId.get('auth-banner').hidden, 'the signed-out banner is visible');
  });

  await test('popup: signed-in hides the banner', async () => {
    const { doc, byId } = buildDom('popup.html');
    const ch = makeChrome({ signedIn: true, settings: { gcpProjectId: 'p' } });
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    assert.ok(byId.get('auth-banner').hidden);
  });

  await test('popup: a background add-refusal is surfaced on next open', async () => {
    const { doc, byId } = buildDom('popup.html');
    const ch = makeChrome({ responses: { takeLastAddError: { error: 'collides with a-b.com' } } });
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    assert.ok(/collides/.test(byId.get('status-line').textContent),
      'the refusal reason reaches the user instead of only the console');
  });

  await test('popup: Stop syncing takes two clicks, then reveals the cloud delete', async () => {
    const { doc, byId } = buildDom('popup.html');
    const ch = makeChrome({ statuses: { 'example.com': { lastSync: new Date().toISOString() } } });
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();

    const stop = byId.get('btn-stop');
    await stop.fire('click');
    assert.ok(/again/i.test(stop.textContent), 'first click only arms the confirmation');
    assert.ok(!ch.sent.some(m => m.type === 'removeDomain'), 'nothing removed on the first click');

    await stop.fire('click');
    await flush();
    assert.ok(ch.sent.some(m => m.type === 'removeDomain'), 'second click performs the removal');
    assert.ok(!byId.get('btn-delete-secret').hidden, 'the cloud-delete action becomes available');
    assert.ok(/kept/i.test(byId.get('status-line').textContent),
      'and the user is told the Google secret was kept');
  });

  await test('popup: the cloud-delete button is not inside a section that Stop hides', () => {
    const html = read('popup.html');
    const statusEnd = html.indexOf('id="no-site-section"');
    assert.ok(html.indexOf('id="btn-delete-secret"') > statusEnd,
      'btn-delete-secret must live outside #status-section or it is unreachable after Stop');
  });

  await test('popup: no await sits between the Add click and permissions.request', () => {
    assert.ok(!awaitBeforeRequest(read('popup.js'), 'handleAddDomain'),
      'an await before permissions.request can cost the user gesture');
  });

  // ==========================================================
  // Options
  // ==========================================================
  await test('options: renders a row per watched domain without throwing', async () => {
    const { doc, byId } = buildDom('options.html');
    const ch = makeChrome({
      domains: ['example.com', 'other.com'],
      statuses: {
        'example.com': { lastSync: new Date().toISOString(), lastSuccess: new Date().toISOString(), cookieCount: 2, authTokenCount: 1 },
        'other.com': { error: 'boom' },
      },
      settings: { gcpProjectId: 'p' },
    });
    runScript('options.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    assert.strictEqual(byId.get('domains-body').children.length, 2, 'one row per domain');
    assert.ok(byId.get('empty-state').hidden);
  });

  await test('options: Sync All surfaces a partial failure instead of claiming success', async () => {
    const { doc, byId } = buildDom('options.html');
    const ch = makeChrome({
      settings: { gcpProjectId: 'p' },
      responses: { syncAll: { ok: false, total: 2, succeeded: 1, failed: 1, errors: [{ domain: 'other.com', error: 'denied' }] } },
    });
    runScript('options.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    await byId.get('btn-sync-all').fire('click');
    await flush();
    const line = byId.get('status-line').textContent;
    assert.ok(/1 of 2 failed/.test(line) && /denied/.test(line), `expected a real failure report, got: ${line}`);
  });

  await test('options: a failed sign-in keeps the banner and reports why', async () => {
    const { doc, byId } = buildDom('options.html');
    const ch = makeChrome({
      settings: { gcpProjectId: 'p' },
      responses: { authenticate: { success: false, error: 'user declined' } },
    });
    runScript('options.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();
    await byId.get('btn-auth').fire('click');
    await flush();
    assert.ok(!byId.get('auth-banner').hidden, 'the banner must NOT be hidden on failure');
    assert.ok(/declined/.test(byId.get('status-line').textContent), 'the reason is shown');
  });

  await test('options: the Add click does not await a message before requesting permission', () => {
    assert.ok(!awaitBeforeRequest(read('options.js'), 'handleAddDomain'),
      'scope must come from the prefetch cache or a synchronous fallback');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

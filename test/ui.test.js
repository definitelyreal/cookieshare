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
  const byId = new Map();
  // Seed each element's real starting classes from the markup. Without this
  // every element began visible, so a test asserting "the banner is shown"
  // passed whether or not production code ever revealed it.
  for (const tag of html.match(/<[a-z][^>]*id="[^"]+"[^>]*>/g) || []) {
    const id = tag.match(/id="([^"]+)"/)[1];
    const el = new El(id);
    const cls = tag.match(/class="([^"]*)"/);
    if (cls) cls[1].split(/\s+/).filter(Boolean).forEach(c => el._classes.add(c));
    byId.set(id, el);
  }
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

// Text scanning proved unreliable here twice (it stopped at a comment, then it
// flagged an await sitting in a branch that returns before the request). These
// checks are behavioral instead: they record the real order of async calls and
// assert nothing was awaited between the click and permissions.request, which
// is the property that actually protects the user gesture.

// Is `id` nested inside the element with id `containerId`? Depth-counted, so
// it cannot be fooled by mere string position the way an indexOf check was.
function isNestedIn(html, id, containerId) {
  const open = html.indexOf(`id="${containerId}"`);
  if (open < 0) return false;
  let i = html.indexOf('>', open) + 1, depth = 1;
  const tagRe = /<(\/?)div\b[^>]*>/g;
  tagRe.lastIndex = i;
  let m;
  while ((m = tagRe.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      return html.slice(open, m.index).includes(`id="${id}"`);
    }
  }
  return false;
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

  await test('popup: the cloud-delete button is not inside any section that Stop hides', () => {
    const html = read('popup.html');
    for (const section of ['status-section', 'add-section', 'no-site-section']) {
      assert.ok(!isNestedIn(html, 'btn-delete-secret', section),
        `btn-delete-secret must not be inside #${section}, or it is unreachable when that section hides`);
    }
  });

  await test('popup: nothing is awaited between the Add click and permissions.request', async () => {
    const { doc, byId } = buildDom('popup.html');
    const ch = makeChrome({ domains: [] }); // current site not yet watched
    const log = [];
    const realSend = ch.api.runtime.sendMessage;
    ch.api.runtime.sendMessage = async (m) => { log.push(`msg:${m.type}`); return realSend(m); };
    ch.api.storage.local.set = async () => { log.push('storage.set'); };
    ch.api.permissions.request = async () => { log.push('permissions.request'); return true; };
    runScript('popup.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();

    log.length = 0; // everything above is popup-open work, not click work
    await byId.get('btn-sync-site').fire('click');
    await flush();

    const reqAt = log.indexOf('permissions.request');
    assert.ok(reqAt >= 0, 'the click did reach permissions.request');
    assert.deepStrictEqual(log.slice(0, reqAt), [],
      `nothing may be awaited before the permission prompt; saw: ${log.slice(0, reqAt).join(', ')}`);
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

  await test('options: an unvalidated scope never reaches a permission prompt', async () => {
    const { doc, byId } = buildDom('options.html');
    const ch = makeChrome({ settings: { gcpProjectId: 'p' }, domains: [] });
    let requested = null;
    ch.api.permissions.request = async ({ origins }) => { requested = origins; return true; };
    runScript('options.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();

    // Click immediately, before any prefetch has run for this value.
    byId.get('input-domain').value = 'co.uk';
    await byId.get('btn-add').fire('click');
    await flush();
    assert.strictEqual(requested, null,
      'a scope we have not validated must never be turned into a permission prompt');
    assert.ok(!ch.sent.some(m => m.type === 'addDomain'), 'and nothing was added');
  });

  await test('options: once validated, the click prompts with the full scope and awaits nothing first', async () => {
    const { doc, byId } = buildDom('options.html');
    const ch = makeChrome({ settings: { gcpProjectId: 'p' }, domains: [] });
    const log = [];
    const realSend = ch.api.runtime.sendMessage;
    ch.api.runtime.sendMessage = async (m) => {
      log.push(`msg:${m.type}`);
      if (m.type === 'getOrigins') {
        // Full scope: own origins plus the registrable parent.
        return { domain: m.domain, origins: [`*://${m.domain}/*`, `*://*.${m.domain}/*`, '*://example.com/*', '*://*.example.com/*'] };
      }
      return realSend(m);
    };
    ch.api.permissions.request = async ({ origins }) => { log.push('permissions.request'); return true; };
    runScript('options.js', { doc, chrome: ch.api });
    for (const fn of doc._ready) await fn();
    await flush();

    const input = byId.get('input-domain');
    input.value = 'app.example.com';
    await input.fire('input', { target: input });   // prefetch resolves the scope
    await flush();

    log.length = 0;
    await byId.get('btn-add').fire('click');
    await flush();

    const reqAt = log.indexOf('permissions.request');
    assert.ok(reqAt >= 0, 'the validated click reaches the prompt');
    assert.deepStrictEqual(log.slice(0, reqAt), [],
      `nothing may be awaited before the prompt; saw: ${log.slice(0, reqAt).join(', ')}`);
    assert.ok(log.includes('msg:addDomain'), 'and the add proceeds afterwards');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

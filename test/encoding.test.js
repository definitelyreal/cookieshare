// Cookie Share — encoding round-trip tests.
// Proves the on-the-wire format is unchanged so the consumer scripts
// (pull-cookies.sh, shared/cookieshare/*.py) still decode secrets.
// Run: node test/encoding.test.js

const assert = require('assert');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- stubs so requiring the service worker doesn't crash Node ---
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
  identity: {}, scripting: {},
};

const bg = require('../extension/background.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

(async () => {
  // How Secret Manager stores what we send: it base64-decodes payload.data and
  // stores the resulting bytes; `gcloud secrets versions access` returns them.
  const decodeStored = (secretData) => Buffer.from(secretData, 'base64').toString('utf-8');

  await test('uncompressed payload round-trips to plain JSON (consumer sees it directly)', async () => {
    const small = { domain: 'x.com', cookies: [{ name: 'a', value: '1' }], n: 42 };
    const secretData = await bg.encodePayload(small);
    const stored = decodeStored(secretData);
    assert.deepStrictEqual(JSON.parse(stored), small);
  });

  await test('large payload uses the {compressed:gzip,data} envelope and round-trips', async () => {
    const big = { domain: 'x.com', localStorage: { 'https://x.com': { blob: 'A'.repeat(200_000) } } };
    const secretData = await bg.encodePayload(big);
    const stored = decodeStored(secretData);
    const env = JSON.parse(stored);
    assert.strictEqual(env.compressed, 'gzip', 'envelope marks gzip');
    // Exactly what pull-cookies.sh does: .data | base64 -d | gunzip
    const inner = zlib.gunzipSync(Buffer.from(env.data, 'base64')).toString('utf-8');
    assert.deepStrictEqual(JSON.parse(inner), big);
    // Emit the stored envelope so a shell step can decode it with the real tools.
    const out = path.join(__dirname, '..', 'build', 'CURRENT', 'roundtrip-envelope.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, stored);
  });

  await test('unicode survives the round-trip (UTF-8, not latin1)', async () => {
    const p = { domain: 'x.com', note: 'héllo 世界 — ok', cookies: [] };
    const stored = decodeStored(await bg.encodePayload(p));
    assert.deepStrictEqual(JSON.parse(stored), p);
  });

  await test('sha256Hex is deterministic and matches Node crypto (drives skip-unchanged)', async () => {
    const h1 = await bg.sha256Hex('cookie-share');
    const h2 = await bg.sha256Hex('cookie-share');
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, await bg.sha256Hex('cookie-shark'));
    assert.strictEqual(h1, crypto.createHash('sha256').update('cookie-share').digest('hex'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

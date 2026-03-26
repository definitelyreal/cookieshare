/**
 * Example: Use cookieshare to log into a website with Playwright.
 *
 * This script pulls fresh session data from Google Secret Manager
 * (synced by the cookieshare Chrome extension) and injects the cookies
 * into a Playwright browser context. The result: you're logged in
 * without ever touching a login form.
 *
 * Prerequisites:
 *   npm install playwright
 *   gcloud auth login
 *   # Make sure you've synced the target domain with the extension
 *
 * Usage:
 *   node examples/playwright-login.js <domain> --project <gcp-project-id>
 *
 * Example:
 *   node examples/playwright-login.js github.com --project my-gcp-project
 */

const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const domain = args.find(a => !a.startsWith('--'));
const projectIdx = args.indexOf('--project');
const project = projectIdx !== -1 ? args[projectIdx + 1] : process.env.COOKIESHARE_GCP_PROJECT;

if (!domain) {
  console.error('Usage: node playwright-login.js <domain> --project <gcp-project-id>');
  process.exit(1);
}

if (!project) {
  console.error('Error: --project flag or COOKIESHARE_GCP_PROJECT env var required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Pull cookies from Secret Manager
// ---------------------------------------------------------------------------

const pullScript = path.join(__dirname, '..', 'scripts', 'pull-cookies.sh');

console.log(`Pulling session data for ${domain}...`);

let session;
try {
  const raw = execSync(`bash "${pullScript}" "${domain}" --project "${project}"`, {
    encoding: 'utf-8',
  });
  session = JSON.parse(raw);
} catch (err) {
  console.error(`Failed to pull cookies for ${domain}:`, err.message);
  process.exit(1);
}

console.log(`Got ${session.cookies.length} cookies, ${Object.keys(session.localStorage || {}).length} localStorage keys`);

// ---------------------------------------------------------------------------
// Launch browser with injected session
// ---------------------------------------------------------------------------

(async () => {
  const browser = await chromium.launch({ headless: false }); // Set to true for CI
  const context = await browser.newContext();

  // Inject cookies
  const playwrightCookies = session.cookies
    .filter(c => c.name && c.value) // Skip empty cookies
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure || false,
      httpOnly: c.httpOnly || false,
      expires: c.expirationDate || -1,
      sameSite: c.sameSite === 'no_restriction' ? 'None'
        : c.sameSite === 'lax' ? 'Lax'
        : c.sameSite === 'strict' ? 'Strict'
        : 'Lax',
    }));

  await context.addCookies(playwrightCookies);
  console.log(`Injected ${playwrightCookies.length} cookies`);

  // Inject localStorage (if the domain has a matching page open)
  const page = await context.newPage();

  // Navigate first, then inject localStorage
  const url = `https://${domain}`;
  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Inject localStorage values
  if (session.localStorage && Object.keys(session.localStorage).length > 0) {
    await page.evaluate((data) => {
      for (const [key, value] of Object.entries(data)) {
        try {
          localStorage.setItem(key, value);
        } catch (e) {
          // Some keys may fail (quota, etc.) — skip them
        }
      }
    }, session.localStorage);
    console.log(`Injected ${Object.keys(session.localStorage).length} localStorage keys`);

    // Reload to let the site pick up the localStorage values
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  console.log(`\nDone! Browser is open and logged into ${domain}`);
  console.log('Press Ctrl+C to close.\n');

  // Keep the browser open for interactive use
  // In a real automation script, you'd do your work here and then close:
  //
  //   await page.click('#some-button');
  //   const data = await page.textContent('.result');
  //   await browser.close();
})();

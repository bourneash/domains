// End-to-end smoke test. Run: npm run build && npx vite preview --port 4791 &&
// node tests/smoke.mjs  — proves the wasm ABI actually works in a real page,
// which unit tests cannot.
import { chromium } from 'playwright';

const errors = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

const shot = (n) => page.screenshot({ path: `./test-output/${n}.png`, fullPage: false });

// 1. Landing
await page.goto('http://localhost:4791/', { waitUntil: 'networkidle' });
console.log('landing h1:', (await page.locator('h1').first().innerText()).replace(/\n/g,' | '));
await shot('landing');

// 2. Trainer — the real test: does the wasm ABI work in a page?
await page.goto('http://localhost:4791/train', { waitUntil: 'networkidle' });
await page.waitForSelector('.ask', { timeout: 15000 });
console.log('trainer loaded. question:', (await page.locator('.ask__q').first().innerText()).slice(0,110));
const cards = await page.locator('.pcard:not(.pcard--empty):not(.pcard--back)').count();
console.log('cards rendered:', cards);
await shot('trainer-drill');

// 3. Answer a spot and confirm grading + equity come back from the engine
await page.locator('.tbtn').first().click();
await page.waitForSelector('.verdict', { timeout: 10000 });
console.log('verdict:', (await page.locator('.verdict__head').innerText()));
console.log('detail :', (await page.locator('.verdict__detail').first().innerText()).slice(0,140));
await shot('trainer-verdict');

// 4. Equity slider drill
await page.getByRole('button', { name: 'Read the equity' }).click();
await page.waitForSelector('input[type=range]');
await page.locator('.tbtn--primary').first().click();
await page.waitForSelector('.verdict');
console.log('equity drill verdict:', await page.locator('.verdict__head').innerText());

// 5. Play mode
await page.getByRole('button', { name: 'Play', exact: true }).click();
await page.waitForSelector('.pot', { timeout: 15000 });
console.log('play pot:', await page.locator('.pot').innerText());
await page.getByRole('button', { name: /^Bet/ }).click();
await page.waitForTimeout(1500);
console.log('log tail:', (await page.locator('.log').innerText()).split('\n').slice(-3).join(' / '));
await shot('trainer-play');

// 6. Leaks
await page.getByRole('button', { name: 'Leaks' }).click();
await page.waitForTimeout(500);
console.log('leaks:', (await page.locator('.ask').innerText()).split('\n').slice(0,6).join(' / '));
await shot('trainer-leaks');

// 7. Static pages
for (const p of ['/help','/opponents','/about','/privacy','/terms','/nope']) {
  await page.goto('http://localhost:4791' + p, { waitUntil: 'networkidle' });
  console.log(p, '->', (await page.locator('h1').first().innerText()));
}

await browser.close();
console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno console errors');

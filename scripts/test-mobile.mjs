import {chromium, devices} from 'playwright';
import path from 'path';

const port = 3470;
const password = '123';
const outDir = '/tmp/culater-mobile-test';

import fs from 'fs';
fs.mkdirSync(outDir, {recursive: true});

const browser = await chromium.launch({headless: true});

// Test on iPhone 14 Pro Max (large phone) and Pixel 7 (Android)
const phoneConfigs = [
  {name: 'iphone14promax', device: devices['iPhone 14 Pro Max']},
  {name: 'pixel7', device: devices['Pixel 7']},
  {name: 'iphone-se', device: devices['iPhone SE']}, // small screen
];

for (const {name, device} of phoneConfigs) {
  console.log(`\nTesting ${name}...`);
  const context = await browser.newContext({
    ...device,
    locale: 'en-US',
    colorScheme: 'dark',
  });

  const page = await context.newPage();

  // 1. Login page
  await page.goto(`http://127.0.0.1:${port}`, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(outDir, `${name}-login.png`)});
  console.log(`  Saved ${name}-login.png`);

  // 2. Login page with keyboard open (focus on input)
  await page.focus('input[name="password"]');
  await page.waitForTimeout(300);
  await page.screenshot({path: path.join(outDir, `${name}-login-focused.png`)});
  console.log(`  Saved ${name}-login-focused.png`);

  // 3. Login and go to terminal
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForNavigation({waitUntil: 'load', timeout: 15000}),
    page.click('button[type="submit"]'),
  ]);

  await page.waitForFunction(() => typeof term !== 'undefined' && typeof connect === 'function', {timeout: 15000});
  await page.waitForSelector('#start-overlay.open', {timeout: 5000});
  await page.screenshot({path: path.join(outDir, `${name}-start-overlay.png`)});
  console.log(`  Saved ${name}-start-overlay.png`);

  // 4. Click start shell
  const recent = page.locator('.recent-dir').first();
  if (await recent.count()) {
    await recent.click();
  }
  await page.waitForTimeout(200);
  await page.click('#start-shell');
  await page.waitForTimeout(1500);

  // Wait for WebSocket
  await page.waitForFunction(() => {
    return typeof ws !== 'undefined' && ws && ws.readyState === 1;
  }, {timeout: 10000});
  await page.waitForTimeout(2000);

  // Send a command
  await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'ls\r'})));
  await page.waitForTimeout(800);

  await page.screenshot({path: path.join(outDir, `${name}-terminal.png`)});
  console.log(`  Saved ${name}-terminal.png`);

  // 5. Try to simulate keyboard open by clicking on xterm area
  await page.click('#terminal');
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(outDir, `${name}-terminal-active.png`)});
  console.log(`  Saved ${name}-terminal-active.png`);

  await context.close();
}

await browser.close();
console.log(`\nAll screenshots saved to ${outDir}`);

import {chromium, devices} from 'playwright';
import path from 'path';
import fs from 'fs';

const port = process.env.PORT || 3456;
const password = '123';
const outDir = '/tmp/culater-mobile-headed';
fs.mkdirSync(outDir, {recursive: true});

const browser = await chromium.launch({headless: false, args: ['--auto-open-devtools-for-tabs']});

const phoneConfigs = [
  {name: 'iphone-se', device: devices['iPhone SE']},
  {name: 'pixel7', device: devices['Pixel 7']},
  {name: 'iphone14promax', device: devices['iPhone 14 Pro Max']},
];

for (const {name, device} of phoneConfigs) {
  console.log(`\n=== Testing ${name} (${device.viewport.width}x${device.viewport.height}) ===`);
  const context = await browser.newContext({
    ...device,
    locale: 'en-US',
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  // 1. Login page
  await page.goto(`http://127.0.0.1:${port}`, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(800);
  await page.screenshot({path: path.join(outDir, `${name}-01-login.png`)});
  console.log(`  01 login`);

  // 2. Login
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForNavigation({waitUntil: 'load', timeout: 15000}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForFunction(() => typeof term !== 'undefined' && typeof connect === 'function', {timeout: 15000});
  await page.waitForSelector('#start-overlay.open', {timeout: 5000});
  await page.screenshot({path: path.join(outDir, `${name}-02-start-overlay.png`)});
  console.log(`  02 start overlay`);

  // 3. Start shell
  const recent = page.locator('.recent-dir').first();
  if (await recent.count()) await recent.click();
  await page.waitForTimeout(200);
  await page.click('#start-shell');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, {timeout: 10000});
  await page.waitForTimeout(2000);
  await page.screenshot({path: path.join(outDir, `${name}-03-terminal-empty.png`)});
  console.log(`  03 terminal empty`);

  // 4. Run some commands
  await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'ls -la\r'})));
  await page.waitForTimeout(1000);
  await page.screenshot({path: path.join(outDir, `${name}-04-ls-output.png`)});
  console.log(`  04 ls output`);

  // 5. Open cursor pad
  await page.click('#cursor-toggle');
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(outDir, `${name}-05-cursor-pad.png`)});
  console.log(`  05 cursor pad open`);

  // 6. Close cursor pad
  await page.click('#cursor-toggle');
  await page.waitForTimeout(300);

  // 7. Test scroll with lots of output
  await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'for i in $(seq 1 80); do echo "Line $i: scrolling test output"; done\r'})));
  await page.waitForTimeout(2000);
  await page.screenshot({path: path.join(outDir, `${name}-06-scroll-output.png`)});
  console.log(`  06 scroll output`);

  // 8. Toggle scroll lock
  await page.click('#scroll-lock');
  await page.waitForTimeout(300);
  await page.screenshot({path: path.join(outDir, `${name}-07-scroll-locked.png`)});
  console.log(`  07 scroll locked`);

  // 9. Click scroll lock again to go back to AUTO
  await page.click('#scroll-lock');
  await page.waitForTimeout(300);

  // 10. Test buttons row overflow
  await page.screenshot({path: path.join(outDir, `${name}-08-buttons-row.png`), fullPage: false});
  console.log(`  08 buttons row`);

  // 11. Run a colorful command
  await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'echo -e "\\033[31mRed\\033[32mGreen\\033[34mBlue\\033[0m Normal"\r'})));
  await page.waitForTimeout(800);
  await page.screenshot({path: path.join(outDir, `${name}-09-colors.png`)});
  console.log(`  09 ANSI colors`);

  // 12. Test with a simulated smaller viewport (keyboard open)
  await page.setViewportSize({width: device.viewport.width, height: Math.floor(device.viewport.height * 0.5)});
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(outDir, `${name}-10-keyboard-open.png`)});
  console.log(`  10 keyboard open (half height)`);

  // Restore viewport
  await page.setViewportSize(device.viewport);
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(outDir, `${name}-11-keyboard-closed.png`)});
  console.log(`  11 keyboard closed (restored)`);

  await context.close();
  console.log(`  Done with ${name}`);
}

await browser.close();
console.log(`\nAll screenshots saved to ${outDir}`);
console.log(`Open: open ${outDir}`);

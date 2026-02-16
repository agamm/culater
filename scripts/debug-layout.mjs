import {chromium, devices} from 'playwright';

const port = process.env.PORT || 3456;
const password = '123';

const browser = await chromium.launch({headless: false});
const ctx = await browser.newContext({...devices['Pixel 7'], colorScheme: 'dark'});
const page = await ctx.newPage();

// Login
await page.goto(`http://127.0.0.1:${port}`, {waitUntil: 'domcontentloaded'});
await page.waitForTimeout(500);
await page.fill('input[name="password"]', password);
await Promise.all([
  page.waitForNavigation({waitUntil: 'load', timeout: 15000}),
  page.click('button[type="submit"]'),
]);
await page.waitForFunction(() => typeof term !== 'undefined' && typeof connect === 'function', {timeout: 15000});
await page.waitForSelector('#start-overlay.open', {timeout: 5000});

const recent = page.locator('.recent-dir').first();
if (await recent.count()) await recent.click();
await page.waitForTimeout(200);
await page.click('#start-shell');
await page.waitForTimeout(1500);
await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, {timeout: 10000});
await page.waitForTimeout(2000);

// Send scroll output
await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'for i in $(seq 1 80); do echo "Line $i: scrolling test output"; done\r'})));
await page.waitForTimeout(2000);

// Debug layout positions
const layout = await page.evaluate(() => {
  const vh = window.innerHeight;
  const termEl = document.getElementById('terminal');
  const xtermEl = document.querySelector('.xterm');
  const viewportEl = document.querySelector('.xterm-viewport');
  const rowsEl = document.querySelector('.xterm-rows');
  const dockEl = document.getElementById('input-dock');
  const actionBtns = document.getElementById('action-btns');

  const termRect = termEl.getBoundingClientRect();
  const xtermRect = xtermEl.getBoundingClientRect();
  const vpRect = viewportEl.getBoundingClientRect();
  const rowsRect = rowsEl.getBoundingClientRect();
  const dockRect = dockEl.getBoundingClientRect();
  const btnRect = actionBtns.getBoundingClientRect();

  const termStyle = getComputedStyle(termEl);
  const xtermStyle = getComputedStyle(xtermEl);

  return {
    viewportHeight: vh,
    terminal: {
      top: termRect.top,
      bottom: termRect.bottom,
      height: termRect.height,
      paddingTop: termStyle.paddingTop,
      paddingBottom: termStyle.paddingBottom,
      overflow: termStyle.overflow,
    },
    xterm: {
      top: xtermRect.top,
      bottom: xtermRect.bottom,
      height: xtermRect.height,
      padding: xtermStyle.padding,
    },
    xtermViewport: {
      top: vpRect.top,
      bottom: vpRect.bottom,
      height: vpRect.height,
      scrollHeight: viewportEl.scrollHeight,
      scrollTop: viewportEl.scrollTop,
    },
    xtermRows: {
      top: rowsRect.top,
      bottom: rowsRect.bottom,
      height: rowsRect.height,
    },
    dock: {
      top: dockRect.top,
      bottom: dockRect.bottom,
      height: dockRect.height,
    },
    buttons: {
      top: btnRect.top,
      bottom: btnRect.bottom,
      height: btnRect.height,
    },
    gap: dockRect.top - xtermRect.bottom,
    xtermCols: term.cols,
    xtermRows_count: term.rows,
  };
});

console.log(JSON.stringify(layout, null, 2));

await ctx.close();
await browser.close();

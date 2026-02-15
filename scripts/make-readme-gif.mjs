import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';

import {bundle} from '@remotion/bundler';
import {getCompositions, openBrowser, renderStill} from '@remotion/renderer';
import gifencPkg from 'gifenc';
import {PNG} from 'pngjs';
import {chromium, devices} from 'playwright';

const {GIFEncoder, quantize, applyPalette} = gifencPkg;

const port = Number(process.env.DEMO_PORT || 3470);
const password = process.env.DEMO_PASSWORD || '123';
const cwd = process.env.DEMO_WORKDIR || process.cwd();
const outGif = path.resolve(process.env.DEMO_GIF || 'assets/culater-demo.gif');
const remotionEntry = path.resolve('remotion/index.jsx');
const remotionPublicDir = path.resolve('remotion/public');
const phoneAssetDir = path.join(remotionPublicDir, 'demo');
const tempRoot = path.resolve('.context/remotion-demo');
const frameDir = path.join(tempRoot, 'frames');

const compositionId = 'CulaterReadmeDemo';
const fps = 30;
const frameDelay = Math.round(1000 / fps);
const renderScale = Number(process.env.DEMO_SCALE || 0.7);
const everyNthFrame = Math.max(1, Number(process.env.DEMO_GIF_EVERY_NTH || 2));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resetDir(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
}

async function waitForHealth(timeoutMs = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {cache: 'no-store'});
      const text = (await res.text()).trim();
      if (res.status === 200 && text === 'ok') return;
    } catch {}
    await sleep(120);
  }
  throw new Error(`Timed out waiting for http://127.0.0.1:${port}/healthz`);
}

function startDemoServer() {
  const env = {
    ...process.env,
    PORT: String(port),
    REMOTE_PASSWORD: password,
    WORK_DIR: cwd,
    RECENT_DIRS: JSON.stringify([cwd]),
    NTFY_TOPIC: '',
    DISABLE_TUNNEL: '1',
    CLAUDECODE: '',
  };

  return spawn(process.execPath, [path.resolve('lib/server.js')], {
    env,
    cwd: process.cwd(),
    stdio: 'ignore',
  });
}

async function stopDemoServer(child) {
  if (!child || child.killed) return;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    child.once('exit', finish);
    child.kill('SIGINT');

    setTimeout(() => {
      if (!done) {
        child.kill('SIGKILL');
      }
    }, 1500);

    setTimeout(finish, 2500);
  });
}

async function capturePhoneScreens() {
  resetDir(phoneAssetDir);

  const server = startDemoServer();
  try {
    await waitForHealth();

    const browser = await chromium.launch({headless: true});
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      locale: 'en-US',
      colorScheme: 'dark',
    });

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`, {waitUntil: 'domcontentloaded'});
    await page.screenshot({path: path.join(phoneAssetDir, 'phone-login.png'), fullPage: true});

    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForNavigation({waitUntil: 'load', timeout: 15000}),
      page.click('button[type="submit"]'),
    ]);

    // Wait for the terminal page JS to fully initialize (xterm.js from CDN)
    await page.waitForFunction(() => typeof term !== 'undefined' && typeof connect === 'function', {timeout: 15000});

    await page.waitForSelector('#start-overlay.open', {timeout: 5000});
    await page.screenshot({path: path.join(phoneAssetDir, 'phone-start.png'), fullPage: true});

    const recent = page.locator('.recent-dir').first();
    if (await recent.count()) {
      await recent.click();
    }
    await sleep(200);

    // Click Start to trigger connect() and dismiss overlay
    await page.click('#start-shell');
    await sleep(1000);

    // Wait for WebSocket to connect and shell to produce output
    await page.waitForFunction(() => {
      return typeof ws !== 'undefined' && ws && ws.readyState === 1;
    }, {timeout: 10000});
    await sleep(2000);

    // Send commands through the page's own WebSocket
    await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'pwd\r'})));
    await sleep(800);
    await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'ls\r'})));
    await sleep(800);
    // Run claude and wait for it to start
    await page.evaluate(() => ws.send(JSON.stringify({type: 'input', data: 'claude\r'})));
    await sleep(4000);

    await page.screenshot({path: path.join(phoneAssetDir, 'phone-live.png'), fullPage: true});

    await context.close();
    await browser.close();
  } finally {
    await stopDemoServer(server);
  }
}

async function renderWithRemotion() {
  resetDir(frameDir);

  const bundled = await bundle({
    entryPoint: remotionEntry,
    publicDir: remotionPublicDir,
  });

  const browser = await openBrowser('chrome', {logLevel: 'error'});
  try {
    const compositions = await getCompositions(bundled, {
      puppeteerInstance: browser,
      inputProps: {},
      logLevel: 'error',
    });

    const composition = compositions.find((c) => c.id === compositionId);
    if (!composition) {
      throw new Error(`Composition \"${compositionId}\" not found`);
    }

    for (let frame = 0; frame < composition.durationInFrames; frame++) {
      const output = path.join(frameDir, `${String(frame).padStart(4, '0')}.png`);
      await renderStill({
        serveUrl: bundled,
        composition,
        frame,
        output,
        imageFormat: 'png',
        inputProps: {},
        puppeteerInstance: browser,
        overwrite: true,
        scale: renderScale,
        logLevel: 'error',
      });

      if (frame % 24 === 0 || frame === composition.durationInFrames - 1) {
        process.stdout.write(`\rRendering Remotion frames: ${frame + 1}/${composition.durationInFrames}`);
      }
    }
    process.stdout.write('\n');
  } finally {
    await browser.close({silent: true});
  }
}

function encodeGif() {
  const frameFiles = fs.readdirSync(frameDir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .filter((_, idx) => idx % everyNthFrame === 0);

  if (frameFiles.length === 0) {
    throw new Error('No rendered frames found for GIF encoding.');
  }

  const first = PNG.sync.read(fs.readFileSync(path.join(frameDir, frameFiles[0])));
  const width = first.width;
  const height = first.height;

  const gif = GIFEncoder();

  for (const file of frameFiles) {
    const png = PNG.sync.read(fs.readFileSync(path.join(frameDir, file)));
    if (png.width !== width || png.height !== height) {
      throw new Error(`Frame size mismatch in ${file}`);
    }

    const palette = quantize(png.data, 96);
    const index = applyPalette(png.data, palette);

    gif.writeFrame(index, width, height, {
      palette,
      delay: frameDelay * everyNthFrame,
    });
  }

  gif.finish();
  fs.mkdirSync(path.dirname(outGif), {recursive: true});
  fs.writeFileSync(outGif, Buffer.from(gif.bytesView()));
}

async function run() {
  resetDir(tempRoot);

  console.log('Capturing phone screens...');
  await capturePhoneScreens();

  console.log('Rendering Remotion composition...');
  await renderWithRemotion();

  console.log('Encoding GIF...');
  encodeGif();

  console.log(`Wrote ${outGif}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

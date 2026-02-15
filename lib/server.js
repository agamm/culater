const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const pty = require('node-pty');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

// Fix node-pty spawn-helper permissions (needed for npx installs)
try {
  const ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
  const spawnHelper = path.join(ptyRoot, 'prebuilds', `${os.platform()}-${os.arch()}`, 'spawn-helper');
  if (fs.existsSync(spawnHelper)) {
    fs.chmodSync(spawnHelper, 0o755);
  }
} catch {}

const PASSWORD = process.env.REMOTE_PASSWORD || 'changeme';
const PORT = process.env.PORT || 3456;
const WORK_DIR = process.env.WORK_DIR || process.cwd();
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const DISABLE_TUNNEL = process.env.DISABLE_TUNNEL === '1';
const TUNNEL_REGISTRATION_WAIT_MS = Math.max(3000, Number(process.env.TUNNEL_REGISTRATION_WAIT_MS || 12000));
const RECENT_DIRS = (() => {
  try {
    const parsed = JSON.parse(process.env.RECENT_DIRS || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(dir => typeof dir === 'string' && dir.trim());
  } catch {
    return [];
  }
})();
const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS || 30 * 60 * 1000);
const OUTPUT_BUFFER_CHARS = Number(process.env.OUTPUT_BUFFER_CHARS || 250000);

const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
const SESSION_COOKIE = 'terminal_session';
const SESSION_ID_PATTERN = /^[a-f0-9]{24,64}$/;

// Detect shell
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
const SHELL_NAME = path.basename(SHELL).toLowerCase();
const sessions = new Map();

function getShellArgs() {
  if (os.platform() === 'win32') return [];
  if (SHELL_NAME === 'zsh' || SHELL_NAME === 'bash' || SHELL_NAME === 'fish') {
    return ['-il'];
  }
  return ['-l'];
}

const SHELL_ARGS = getShellArgs();

function createSessionId(size = 12) {
  return crypto.randomBytes(size).toString('hex');
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    if (key) out[key] = value;
  }
  return out;
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return SESSION_ID_PATTERN.test(normalized) ? normalized : null;
}

function checkAuth(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') === SESSION_TOKEN) return true;
  const cookies = parseCookies(req);
  return cookies.token === SESSION_TOKEN;
}

function getWsSessionId(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const fromQuery = normalizeSessionId(url.searchParams.get('sid'));
  if (fromQuery) return fromQuery;
  const cookies = parseCookies(req);
  const fromCookie = normalizeSessionId(cookies[SESSION_COOKIE]);
  return fromCookie || createSessionId();
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(session, payload) {
  for (const socket of session.sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

function appendOutput(session, data) {
  if (!data) return;
  session.lastSeq += 1;
  const chunk = { seq: session.lastSeq, data };
  session.outputBuffer.push(chunk);
  session.bufferChars += data.length;

  while (session.bufferChars > OUTPUT_BUFFER_CHARS && session.outputBuffer.length > 1) {
    const removed = session.outputBuffer.shift();
    session.bufferChars -= removed.data.length;
  }

  broadcast(session, JSON.stringify({ type: 'output', seq: chunk.seq, data: chunk.data }));
}

function bufferedOutputSince(session, lastSeq, maxSeq = session.lastSeq) {
  const safeSeq = Number.isFinite(lastSeq) ? lastSeq : 0;
  const chunks = session.outputBuffer.filter(chunk => chunk.seq > safeSeq && chunk.seq <= maxSeq);
  return chunks.map(chunk => chunk.data).join('');
}

function resolveCwd(rawCwd) {
  if (typeof rawCwd !== 'string') return null;
  const trimmed = rawCwd.trim();
  if (!trimmed) return null;
  const expanded = trimmed === '~' || trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
  const resolved = path.resolve(expanded);
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {}
  return null;
}

function startPty(session) {
  if (session.ptyProcess) return;

  try {
    session.ptyProcess = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color'
      }
    });

    session.ptyProcess.onData(data => {
      appendOutput(session, data);
    });

    session.ptyProcess.onExit(({ exitCode }) => {
      session.ptyProcess = null;
      appendOutput(session, `\r\n\x1b[33m[Exited: ${exitCode}] Press Enter to restart\x1b[0m\r\n`);
    });
  } catch (err) {
    appendOutput(session, `\x1b[31mFailed: ${err.message}\x1b[0m\r\n`);
  }
}

function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }
  if (session.ptyProcess) {
    session.ptyProcess.kill();
    session.ptyProcess = null;
  }
  sessions.delete(id);
}

function scheduleSessionCleanup(session) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }
  if (session.sockets.size > 0) return;

  session.cleanupTimer = setTimeout(() => {
    if (session.sockets.size === 0) {
      destroySession(session.id);
    }
  }, SESSION_IDLE_TTL_MS);
}

function getOrCreateSession(id) {
  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      cols: 80,
      rows: 24,
      ptyProcess: null,
      cwd: WORK_DIR,
      sockets: new Set(),
      outputBuffer: [],
      bufferChars: 0,
      lastSeq: 0,
      cleanupTimer: null
    };
    sessions.set(id, session);
  } else if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  return session;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/auth' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        const browserSessionId = createSessionId();
        res.writeHead(302, {
          'Set-Cookie': [
            `token=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
            `${SESSION_COOKIE}=${browserSessionId}; Path=/; HttpOnly; SameSite=Strict`
          ],
          'Location': '/'
        });
      } else {
        res.writeHead(302, { 'Location': '/?error=1' });
      }
      res.end();
    });
    return;
  }

  if (!checkAuth(req)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LOGIN_HTML);
    return;
  }

  const cookies = parseCookies(req);
  const browserSessionId = normalizeSessionId(cookies[SESSION_COOKIE]) || createSessionId();
  const headers = { 'Content-Type': 'text/html' };
  if (cookies[SESSION_COOKIE] !== browserSessionId) {
    headers['Set-Cookie'] = `${SESSION_COOKIE}=${browserSessionId}; Path=/; HttpOnly; SameSite=Strict`;
  }

  res.writeHead(200, headers);
  res.end(renderTerminalHtml(browserSessionId, WORK_DIR, RECENT_DIRS));
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const sessionId = getWsSessionId(req);
  const session = getOrCreateSession(sessionId);
  let attached = false;

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'attach') {
        const lastSeq = Number(data.lastSeq) || 0;

        if (!session.ptyProcess) {
          const requestedCwd = resolveCwd(data.cwd);
          if (requestedCwd) {
            session.cwd = requestedCwd;
          }
          startPty(session);
        }

        const currentSeq = session.lastSeq;
        const snapshot = bufferedOutputSince(session, lastSeq, currentSeq);
        if (!attached) {
          session.sockets.add(ws);
          attached = true;
        }
        sendJson(ws, { type: 'snapshot', seq: currentSeq, data: snapshot });
      } else if (data.type === 'input') {
        if (session.ptyProcess) {
          session.ptyProcess.write(data.data);
        } else if (data.data === '\r' || data.data === '\n') {
          appendOutput(session, '\x1b[2J\x1b[H');
          startPty(session);
        }
      } else if (data.type === 'run_claude') {
        if (!session.ptyProcess) startPty(session);
        if (session.ptyProcess) session.ptyProcess.write('claude\r');
      } else if (data.type === 'resize') {
        const nextCols = Math.max(20, Math.min(Number(data.cols) || session.cols, 500));
        const nextRows = Math.max(10, Math.min(Number(data.rows) || session.rows, 300));
        session.cols = nextCols;
        session.rows = nextRows;
        if (session.ptyProcess) session.ptyProcess.resize(nextCols, nextRows);
      } else if (data.type === 'stop') {
        if (session.ptyProcess) session.ptyProcess.kill();
      } else if (data.type === 'ping') {
        sendJson(ws, { type: 'pong' });
      }
    } catch {
      if (session.ptyProcess) session.ptyProcess.write(msg.toString());
    }
  });

  ws.on('close', () => {
    if (attached) {
      session.sockets.delete(ws);
    }
    scheduleSessionCleanup(session);
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 15000);
  ws.on('close', () => clearInterval(pingInterval));

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const aliveInterval = setInterval(() => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
  }, 30000);
  ws.on('close', () => clearInterval(aliveInterval));
});

async function sendNotification(url) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Title': 'culater', 'Click': url, 'Tags': 'computer' },
      body: url
    });
  } catch {}
}

let tunnelProcess = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createCliSpinner(initialLabel, color = '36') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const isTty = Boolean(process.stdout.isTTY);
  let timer = null;
  let frameIndex = 0;
  let started = false;
  let label = initialLabel;
  let startTime = null;

  const clearLine = () => {
    process.stdout.write('\r\x1b[2K');
  };

  const render = () => {
    const frame = frames[frameIndex % frames.length];
    frameIndex += 1;
    const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
    const sec = elapsed > 0 ? ` \x1b[90m${elapsed}s\x1b[0m` : '';
    process.stdout.write(`\r\x1b[2K\x1b[${color}m${frame}\x1b[0m ${label}${sec}`);
  };

  return {
    start() {
      if (started) return;
      started = true;
      startTime = Date.now();
      if (!isTty) {
        console.log(label);
        return;
      }
      render();
      timer = setInterval(render, 90);
    },
    update(newLabel) {
      label = newLabel;
    },
    stop(message = '') {
      if (!started) return;
      started = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (isTty) clearLine();
      if (message) console.log(message);
    }
  };
}

async function checkUrlReady(url, { timeoutMs = 3500, expectedStatus = 200, expectedBody = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal
    });

    if (res.status !== expectedStatus) return false;
    if (expectedBody == null) return true;
    const body = (await res.text()).trim();
    return body === expectedBody;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForReady(url, attempts = 25, delayMs = 300, options = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await checkUrlReady(url, options)) return true;
    await sleep(delayMs);
  }
  return false;
}

async function createTunnel() {
  const localReady = await waitForReady(`http://127.0.0.1:${PORT}/healthz`, 30, 200, {
    expectedStatus: 200,
    expectedBody: 'ok'
  });
  if (!localReady) {
    console.error('\x1b[31mLocal server failed health check, retrying tunnel startup...\x1b[0m');
    setTimeout(() => { void createTunnel(); }, 2000);
    return;
  }

  tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let tunnelUrl = null;
  let connectionRegistered = false;
  let announced = false;
  let fallbackTimer = null;
  let registrationSpinner = null;

  const announceReady = () => {
    if (announced || !tunnelUrl) return;
    announced = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (registrationSpinner) {
      registrationSpinner.stop();
      registrationSpinner = null;
    }

    console.log('');
    qrcode.generate(tunnelUrl, { small: true });
    console.log(`  \x1b[36m${tunnelUrl}\x1b[0m`);
    console.log(`  Password: \x1b[33m${PASSWORD}\x1b[0m\n`);

    void sendNotification(tunnelUrl);
  };

  const maybeAnnounceReady = () => {
    if (tunnelUrl && connectionRegistered) {
      announceReady();
    }
  };

  const onTunnelOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      registrationSpinner = createCliSpinner('Connecting');
      registrationSpinner.start();
      fallbackTimer = setTimeout(() => {
        if (!announced && registrationSpinner) {
          registrationSpinner.update('Still connecting to Cloudflare edge');
        }
      }, TUNNEL_REGISTRATION_WAIT_MS);
    }

    if (!connectionRegistered && text.includes('Registered tunnel connection')) {
      connectionRegistered = true;
      if (registrationSpinner) {
        registrationSpinner.stop('\x1b[32mConnected.\x1b[0m');
        registrationSpinner = null;
      }
    }

    maybeAnnounceReady();
  };

  tunnelProcess.stderr.on('data', data => { void onTunnelOutput(data); });
  tunnelProcess.stdout.on('data', data => { void onTunnelOutput(data); });

  tunnelProcess.on('close', code => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (registrationSpinner) {
      registrationSpinner.stop(code !== 0 ? '\x1b[31mTunnel disconnected, reconnecting...\x1b[0m' : '');
      registrationSpinner = null;
    }
    if (code !== 0) setTimeout(() => { void createTunnel(); }, 5000);
  });
}

server.listen(PORT, () => {
  if (DISABLE_TUNNEL) {
    console.log('\x1b[2mTunnel disabled (DISABLE_TUNNEL=1).\x1b[0m');
    return;
  }
  void createTunnel();
});

process.on('SIGINT', () => {
  if (tunnelProcess) tunnelProcess.kill();
  wss.clients.forEach(ws => ws.close());
  for (const id of sessions.keys()) {
    destroySession(id);
  }
  server.close();
  process.exit(0);
});

const LOGIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
  <title>culater</title>
  <style>
    :root{--bg0:#06080d;--bg1:#0f1522;--glass-border:rgba(255,255,255,0.14);--ink:#f1f5ff;--muted:#9ba5bd;--danger:#ff839d}
    *{box-sizing:border-box;margin:0;padding:0}
    html{height:100%}
    body{
      font-family:'SF Pro Text','SF Pro Display','Avenir Next',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      min-height:100dvh;display:flex;align-items:center;justify-content:center;
      padding:24px;padding-top:calc(24px + env(safe-area-inset-top));padding-bottom:calc(24px + env(safe-area-inset-bottom));
      color:var(--ink);
      background:radial-gradient(1200px 900px at 15% -10%,#1d2c44 0%,transparent 46%),radial-gradient(900px 700px at 110% 0%,#1f3e39 0%,transparent 44%),linear-gradient(160deg,var(--bg0),var(--bg1) 62%,#091119)
    }
    body::before{
      content:'';position:fixed;inset:0;pointer-events:none;opacity:.32;
      background:radial-gradient(circle at 30% 20%,rgba(255,255,255,.08) 0,transparent 44%),radial-gradient(circle at 70% 60%,rgba(255,255,255,.06) 0,transparent 46%)
    }
    .box{
      position:relative;z-index:1;width:min(360px,100%);padding:28px 24px 24px;border-radius:24px;
      border:1px solid var(--glass-border);background:linear-gradient(180deg,rgba(17,24,37,.84),rgba(10,15,24,.82));
      backdrop-filter:blur(18px);box-shadow:0 20px 60px rgba(2,4,8,.5)
    }
    h1{font-size:34px;letter-spacing:.02em;font-weight:650;margin-bottom:6px}
    .sub{color:var(--muted);font-size:13px;line-height:1.5;margin-bottom:20px}
    .error{color:var(--danger);font-size:13px;min-height:18px;margin-bottom:8px}
    input{
      width:100%;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:14px;
      font-size:16px;background:rgba(7,11,17,.66);color:var(--ink);margin-bottom:14px;outline:none
    }
    input:focus{border-color:rgba(87,230,203,.75);box-shadow:0 0 0 2px rgba(87,230,203,.2)}
    input::placeholder{color:#7f899f}
    button{
      width:100%;padding:14px;border:none;border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;color:#041119;
      background:linear-gradient(160deg,#68f5d9,#3ad8bc);box-shadow:0 12px 26px rgba(46,197,168,.32)
    }
    button:active{transform:translateY(1px)}
  </style>
</head>
<body>
  <div class="box">
    <h1>culater</h1>
    <div class="sub">Remote shell from any phone browser</div>
    <div class="error" id="e"></div>
    <form action="/auth" method="POST">
      <input type="password" name="password" placeholder="Password" autofocus>
      <button type="submit">Enter</button>
    </form>
  </div>
  <script>
    if (location.search.includes('error')) {
      document.getElementById('e').textContent = 'Invalid password';
    }
  </script>
</body>
</html>`;

function renderTerminalHtml(sessionId, defaultWorkDir, recentDirs) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>culater</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
  <style>
    :root{--bg0:#04060b;--bg1:#0d131f;--glass:rgba(15,21,32,0.72);--glass-2:rgba(11,16,25,0.8);--edge:rgba(255,255,255,0.14);--ink:#ecf2ff;--muted:#95a0b8;--mint:#5df0d2;--danger:#ff7a97;--amber:#ffc07f;--kb-offset:0px}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{
      height:100%;overflow:hidden;color:var(--ink);
      font-family:'SF Pro Text','SF Pro Display','Avenir Next',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:radial-gradient(1200px 900px at 14% -8%,#1d2e49 0%,transparent 44%),radial-gradient(800px 700px at 110% 0%,#1f4239 0%,transparent 42%),linear-gradient(150deg,var(--bg0) 6%,var(--bg1) 56%,#08111a 100%)
    }
    body::before{
      content:'';position:fixed;inset:0;pointer-events:none;opacity:.28;
      background:radial-gradient(circle at 15% 18%,rgba(255,255,255,.1) 0,transparent 38%),radial-gradient(circle at 80% 62%,rgba(255,255,255,.08) 0,transparent 44%)
    }
    #start-overlay{
      position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center;padding:16px;
      background:rgba(4,8,14,.66);backdrop-filter:blur(6px)
    }
    #start-overlay.open{display:flex}
    #start-card{
      width:min(520px,100%);padding:18px;border-radius:18px;border:1px solid var(--edge);
      background:rgba(11,16,25,.92);box-shadow:0 20px 60px rgba(0,0,0,.45)
    }
    #start-card h2{font-size:18px;margin-bottom:10px}
    #start-card .hint{font-size:12px;color:var(--muted);margin-bottom:12px}
    #recent-dir-list{
      display:flex;gap:8px;flex-wrap:wrap;max-height:152px;overflow:auto;margin-top:10px;margin-bottom:12px
    }
    .recent-dir{
      max-width:100%;padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.14);
      background:rgba(255,255,255,.06);color:var(--ink);font-size:12px;cursor:pointer;
      white-space:nowrap;text-overflow:ellipsis;overflow:hidden
    }
    .recent-dir.selected{border-color:rgba(93,240,210,.75);color:#b7ffef;background:rgba(93,240,210,.16)}
    #start-actions{display:flex;gap:8px;margin-top:12px}
    #start-actions button{
      border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:var(--ink);
      height:42px;padding:0 14px;border-radius:12px;font-size:13px;cursor:pointer
    }
    #start-shell{
      background:linear-gradient(160deg,#68f5d9,#3ad8bc)!important;border-color:transparent!important;color:#041119!important;font-weight:640
    }
    #terminal{position:relative;z-index:1;height:100%;padding:58px 8px calc(96px + env(safe-area-inset-bottom) + var(--kb-offset))}
    .xterm{
      height:100%;padding:12px;border-radius:20px;border:1px solid var(--edge);
      background:linear-gradient(180deg,rgba(14,20,30,.84),rgba(10,14,21,.8));backdrop-filter:blur(24px);
      box-shadow:0 28px 80px rgba(1,4,10,.55),inset 0 1px 0 rgba(255,255,255,.06)
    }
    .xterm-viewport{overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;scroll-behavior:smooth}
    #status{
      position:fixed;top:calc(10px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);
      padding:7px 14px 7px 12px;border-radius:999px;font-size:12px;line-height:1;letter-spacing:.04em;text-transform:uppercase;
      border:1px solid var(--edge);background:var(--glass);backdrop-filter:blur(18px);z-index:120;display:flex;align-items:center;gap:8px
    }
    #status::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--mint);box-shadow:0 0 14px rgba(93,240,210,.65)}
    #status.disconnected{color:#ffdce4}
    #status.disconnected::before{background:var(--danger);box-shadow:0 0 12px rgba(255,122,151,.5)}
    #streaming{
      position:fixed;top:calc(10px + env(safe-area-inset-top));left:12px;padding:7px 11px;border-radius:999px;
      font-size:11px;line-height:1;text-transform:uppercase;letter-spacing:.04em;color:var(--ink);
      background:var(--glass-2);border:1px solid var(--edge);display:none;align-items:center;gap:5px;z-index:120
    }
    #streaming .dot{width:6px;height:6px;background:var(--mint);border-radius:50%;animation:pulse 1s infinite}
    #streaming .dot:nth-child(2){animation-delay:.2s}
    #streaming .dot:nth-child(3){animation-delay:.4s}
    @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
    #top-controls{
      position:fixed;top:calc(10px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right));
      display:flex;align-items:center;gap:6px;z-index:125;padding:4px;border-radius:14px;
      background:rgba(11,16,25,.76);border:1px solid var(--edge);backdrop-filter:blur(16px)
    }
    #stop,#scroll-lock,#run-claude-btn{
      height:30px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);
      color:var(--ink);font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;padding:0 9px;
      display:flex;align-items:center;justify-content:center
    }
    #scroll-lock{min-width:46px}
    #run-claude-btn{min-width:36px}
    #stop{min-width:30px;color:#ffd7e0}
    #stop:hover{border-color:rgba(255,122,151,.7);color:var(--danger)}
    #run-claude-btn:hover{border-color:rgba(93,240,210,.66);color:var(--mint)}
    #scroll-lock.locked{border-color:rgba(255,192,127,.75);color:var(--amber)}
    #reconnect{
      position:fixed;bottom:calc(90px + env(safe-area-inset-bottom) + var(--kb-offset));left:50%;transform:translateX(-50%);
      padding:10px 18px;border-radius:999px;border:1px solid var(--edge);background:var(--glass-2);color:var(--ink);
      font-size:13px;cursor:pointer;display:none;z-index:130;backdrop-filter:blur(14px)
    }
    #input-dock{
      position:fixed;left:0;right:0;bottom:calc(14px + env(safe-area-inset-bottom) + var(--kb-offset));
      display:flex;align-items:center;justify-content:center;gap:8px;z-index:130;
      padding:0 10px
    }
    #action-btns{
      display:flex;gap:6px;padding:7px;background:rgba(11,16,25,.78);border:1px solid var(--edge);border-radius:18px;
      backdrop-filter:blur(20px);box-shadow:0 16px 40px rgba(0,0,0,.35);flex-shrink:1;min-width:0
    }
    #action-btns button{
      min-width:40px;height:38px;padding:0 10px;border:1px solid rgba(255,255,255,.12);border-radius:11px;
      background:rgba(255,255,255,.06);color:var(--ink);font-size:15px;font-weight:560;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0
    }
    #action-btns button:active,#cursor-toggle:active,#cursor-pad button:active{transform:translateY(1px);background:rgba(255,255,255,.12)}
    #esc-btn{color:#ffd8ad;border-color:rgba(255,216,173,.34)}
    #enter-btn{color:#b8ffe9;border-color:rgba(184,255,233,.34)}
    #cursor-wrap{position:relative}
    #cursor-toggle{
      width:42px;height:42px;border-radius:50%;border:1px solid var(--edge);background:rgba(11,16,25,.82);
      color:var(--ink);font-size:20px;line-height:1;cursor:pointer;backdrop-filter:blur(20px);
      box-shadow:0 16px 40px rgba(0,0,0,.35);flex-shrink:0
    }
    #cursor-pad{
      position:absolute;right:0;bottom:52px;width:128px;height:128px;padding:10px;border-radius:18px;
      border:1px solid var(--edge);background:rgba(11,16,25,.9);backdrop-filter:blur(20px);display:none
    }
    #cursor-pad.open{display:block}
    #cursor-pad button{
      position:absolute;width:36px;height:36px;border-radius:10px;border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.06);color:var(--ink);font-size:18px;cursor:pointer;
      display:flex;align-items:center;justify-content:center
    }
    #arrow-up{left:46px;top:8px}
    #arrow-left{left:8px;top:46px}
    #arrow-right{right:8px;top:46px}
    #arrow-down{left:46px;bottom:8px}
    @media (min-width:860px){
      #terminal{padding:66px 18px calc(96px + env(safe-area-inset-bottom) + var(--kb-offset))}
      #action-btns button{min-width:62px}
    }
  </style>
</head>
<body>
  <div id="start-overlay" class="open">
    <div id="start-card">
      <h2>Start Shell</h2>
      <div class="hint">Choose from project folders you used before.</div>
      <div id="recent-dir-list"></div>
      <div id="start-actions">
        <button id="start-shell">Start</button>
      </div>
    </div>
  </div>
  <div id="status">Connected</div>
  <div id="top-controls">
    <button id="scroll-lock">AUTO</button>
    <button id="run-claude-btn" title="Run Claude">AI</button>
    <button id="stop" title="Stop Shell">■</button>
  </div>
  <div id="streaming"><span class="dot"></span><span class="dot"></span><span class="dot"></span>Live</div>
  <button id="reconnect">Reconnect</button>
  <div id="input-dock">
    <div id="action-btns">
      <button id="slash-btn" title="Send /">/</button>
      <button id="esc-btn" title="Send Escape">Esc</button>
      <button id="enter-btn" title="Send Enter">⏎</button>
    </div>
    <div id="cursor-wrap">
      <button id="cursor-toggle" title="Cursor controls">✣</button>
      <div id="cursor-pad">
        <button id="arrow-left" title="Send Left Arrow">←</button>
        <button id="arrow-up" title="Send Up Arrow">↑</button>
        <button id="arrow-down" title="Send Down Arrow">↓</button>
        <button id="arrow-right" title="Send Right Arrow">→</button>
      </div>
    </div>
  </div>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const terminalSessionId = ${JSON.stringify(sessionId)};
    const defaultWorkDir = ${JSON.stringify(defaultWorkDir)};
    const recentDirs = ${JSON.stringify(recentDirs)};
    const term = new Terminal({
      cursorBlink:true,
      fontSize:14,
      lineHeight:1.25,
      fontFamily:'SF Mono, ui-monospace, Menlo, Monaco, monospace',
      theme:{
        background:'#0c1119',
        foreground:'#ecf2ff',
        cursor:'#64efd2',
        cursorAccent:'#0b1018',
        selectionBackground:'rgba(159,181,222,0.28)'
      },
      scrollback:5000,
      smoothScrollDuration:100,
      fastScrollModifier:'none',
      fastScrollSensitivity:5,
      scrollSensitivity:3
    });
    const fit = new FitAddon.FitAddon();
    const statusEl = document.getElementById('status');
    const reconnectBtn = document.getElementById('reconnect');
    const streamingEl = document.getElementById('streaming');
    const scrollLockBtn = document.getElementById('scroll-lock');
    const runClaudeBtn = document.getElementById('run-claude-btn');
    const stopBtn = document.getElementById('stop');
    const startOverlay = document.getElementById('start-overlay');
    const recentDirList = document.getElementById('recent-dir-list');
    const startShellBtn = document.getElementById('start-shell');
    const cursorToggleBtn = document.getElementById('cursor-toggle');
    const cursorPad = document.getElementById('cursor-pad');
    const arrowLeftBtn = document.getElementById('arrow-left');
    const arrowUpBtn = document.getElementById('arrow-up');
    const arrowDownBtn = document.getElementById('arrow-down');
    const arrowRightBtn = document.getElementById('arrow-right');
    const enterBtn = document.getElementById('enter-btn');
    const escBtn = document.getElementById('esc-btn');
    const slashBtn = document.getElementById('slash-btn');
    const isLikelyMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    let ws;
    let lastSeq = 0;
    let reconnectTimer = null;
    let clientPing = null;
    let streamTimeout;
    let autoScroll = true;
    let userScrolling = false;
    let keyboardOffset = 0;
    let inputLineBuffer = '';
    let pendingFit = false;
    let startOptions = { cwd: defaultWorkDir };
    let hasSentInitialAttach = false;
    const START_PREFS_KEY = 'culater_start_' + terminalSessionId;

    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));
    fit.fit();

    // Mobile keyboards may rewrite words on space (autocorrect), which can duplicate input in terminals.
    // Force the hidden xterm textarea to plain/raw typing.
    function configureTerminalTextarea() {
      const textarea = document.querySelector('.xterm-helper-textarea');
      if (!textarea) return;
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'none');
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('aria-autocomplete', 'none');
      textarea.setAttribute('spellcheck', 'false');
      textarea.setAttribute('enterkeyhint', 'enter');
      textarea.setAttribute('data-lpignore', 'true');
      textarea.autocorrect = 'off';
      textarea.autocapitalize = 'none';
      textarea.autocomplete = 'off';
      textarea.spellcheck = false;
    }
    configureTerminalTextarea();
    const inputObserver = new MutationObserver(() => configureTerminalTextarea());
    inputObserver.observe(document.getElementById('terminal'), { childList: true, subtree: true });

    function loadStoredStartOptions() {
      try {
        const raw = localStorage.getItem(START_PREFS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
          cwd: typeof parsed.cwd === 'string' && parsed.cwd.trim() ? parsed.cwd.trim() : defaultWorkDir
        };
      } catch {
        return null;
      }
    }

    function saveStartOptions() {
      try {
        localStorage.setItem(START_PREFS_KEY, JSON.stringify(startOptions));
      } catch {}
    }

    function truncateMiddle(str, max = 40) {
      if (!str || str.length <= max) return str;
      const head = Math.ceil(max / 2) - 2;
      const tail = Math.floor(max / 2) - 1;
      return str.slice(0, head) + '...' + str.slice(str.length - tail);
    }

    function renderRecentDirs() {
      recentDirList.innerHTML = '';
      for (const dir of recentDirs.slice(0, 10)) {
        const btn = document.createElement('button');
        btn.className = 'recent-dir' + (dir === startOptions.cwd ? ' selected' : '');
        btn.textContent = truncateMiddle(dir, 46);
        btn.title = dir;
        btn.type = 'button';
        btn.onclick = () => {
          startOptions.cwd = dir;
          renderRecentDirs();
        };
        recentDirList.appendChild(btn);
      }
    }

    const hasRecentDirs = recentDirs.length > 0;
    const savedStartOptions = loadStoredStartOptions();
    if (savedStartOptions) {
      startOptions = savedStartOptions;
    }
    if (hasRecentDirs && !recentDirs.includes(startOptions.cwd)) {
      startOptions.cwd = recentDirs[0];
    }
    const shouldAutoStart = !hasRecentDirs || !!savedStartOptions;

    renderRecentDirs();

    const viewport = document.querySelector('.xterm-viewport');
    if (viewport) {
      viewport.addEventListener('scroll', () => {
        const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 50;
        if (!atBottom && !userScrolling) {
          userScrolling = true;
          autoScroll = false;
          updateScrollBtn();
        }
      });

      viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const multiplier = 6;
        viewport.scrollTop += e.deltaY * multiplier;
      }, {passive: false});

      let touchStartY = 0;
      let lastTouchY = 0;
      let velocity = 0;
      let momentumId = null;
      const termEl = document.getElementById('terminal');

      termEl.addEventListener('touchstart', (e) => {
        if (e.target.closest('button')) return;
        cancelAnimationFrame(momentumId);
        touchStartY = e.touches[0].clientY;
        lastTouchY = touchStartY;
        velocity = 0;
      }, {passive: true, capture: true});

      termEl.addEventListener('touchmove', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        const touchY = e.touches[0].clientY;
        const delta = (lastTouchY - touchY) * 6;
        velocity = lastTouchY - touchY;
        lastTouchY = touchY;
        viewport.scrollTop += delta;
      }, {passive: false, capture: true});

      termEl.addEventListener('touchend', (e) => {
        if (e.target.closest('button')) return;
        const decelerate = () => {
          velocity *= 0.9;
          if (Math.abs(velocity) > 0.5) {
            viewport.scrollTop += velocity * 5;
            momentumId = requestAnimationFrame(decelerate);
          }
        };
        momentumId = requestAnimationFrame(decelerate);
      }, {passive: true, capture: true});
    }

    function updateScrollBtn() {
      if (autoScroll) {
        scrollLockBtn.textContent = 'AUTO';
        scrollLockBtn.className = '';
      } else {
        scrollLockBtn.textContent = 'LOCK';
        scrollLockBtn.className = 'locked';
      }
    }

    scrollLockBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      autoScroll = !autoScroll;
      userScrolling = !autoScroll;
      updateScrollBtn();
      if (autoScroll && viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    };

    function showStreaming() {
      streamingEl.style.display = 'flex';
      clearTimeout(streamTimeout);
      streamTimeout = setTimeout(() => {
        streamingEl.style.display = 'none';
      }, 500);
    }

    function writeToTerminal(data) {
      if (!data) return;
      const scrollPos = viewport ? viewport.scrollTop : 0;
      term.write(data);
      requestAnimationFrame(() => {
        if (viewport) {
          if (autoScroll) {
            viewport.scrollTop = viewport.scrollHeight;
          } else {
            viewport.scrollTop = scrollPos;
          }
        }
      });
    }

    function scheduleFit(keepBottom = false) {
      if (pendingFit) return;
      pendingFit = true;
      requestAnimationFrame(() => {
        pendingFit = false;
        fit.fit();
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
        }
        if (viewport && (keepBottom || autoScroll)) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      });
    }

    function updateInputBuffer(data) {
      if (!data) return;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '\\r' || ch === '\\n') {
          inputLineBuffer = '';
          continue;
        }
        if (ch === '\\x7f') {
          inputLineBuffer = inputLineBuffer.slice(0, -1);
          continue;
        }
        if (ch === '\\x1b' || ch < ' ') continue;
        inputLineBuffer += ch;
      }
      if (inputLineBuffer.length > 512) {
        inputLineBuffer = inputLineBuffer.slice(-256);
      }
    }

    function maybeFixMobileDuplication(data) {
      if (!isLikelyMobile || typeof data !== 'string' || !data) return data;
      if (!data.includes(' ') || data.includes('\\x1b') || /[\\r\\n]/.test(data)) return data;

      const tailMatch = inputLineBuffer.match(/([a-zA-Z0-9_-]{4,})$/);
      if (!tailMatch) return data;

      const activeWord = tailMatch[1];
      const compactWord = activeWord.toLowerCase();
      const compactIncoming = data.toLowerCase().replace(/\s+/g, '');
      const nearMatch = compactIncoming.startsWith(compactWord) && compactIncoming.length <= compactWord.length + 5;
      if (!nearMatch) return data;

      return '\\x7f'.repeat(activeWord.length) + data;
    }

    function scheduleReconnect() {
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 3000);
    }

    function connect() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      const proto = location.protocol==='https:'?'wss:':'ws:';
      ws = new WebSocket(proto+'//'+location.host+'/?sid='+encodeURIComponent(terminalSessionId));

      ws.onopen = () => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        statusEl.textContent = 'Connected';
        statusEl.className = '';
        reconnectBtn.style.display = 'none';
        term.focus();
        ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
        const attachPayload = { type: 'attach', lastSeq };
        if (!hasSentInitialAttach) {
          attachPayload.cwd = startOptions.cwd;
          hasSentInitialAttach = true;
        }
        ws.send(JSON.stringify(attachPayload));
        if (clientPing) clearInterval(clientPing);
        clientPing = setInterval(() => {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({type:'ping'}));
          }
        }, 20000);
      };

      ws.onmessage = e => {
        let payload = null;
        try {
          payload = JSON.parse(e.data);
        } catch {}

        if (payload && payload.type === 'output') {
          if (typeof payload.seq === 'number') lastSeq = Math.max(lastSeq, payload.seq);
          showStreaming();
          writeToTerminal(payload.data);
          return;
        }

        if (payload && payload.type === 'snapshot') {
          if (typeof payload.seq === 'number') lastSeq = Math.max(lastSeq, payload.seq);
          if (payload.data) {
            showStreaming();
            writeToTerminal(payload.data);
          }
          return;
        }

        if (payload && payload.type === 'pong') {
          return;
        }

        showStreaming();
        writeToTerminal(e.data);
      };

      ws.onclose = () => {
        ws = null;
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'disconnected';
        reconnectBtn.style.display = 'block';
        streamingEl.style.display = 'none';
        if (clientPing) {
          clearInterval(clientPing);
          clientPing = null;
        }
        writeToTerminal('\\r\\n\\x1b[31m[Disconnected - auto-reconnecting...]\\x1b[0m\\r\\n');
        scheduleReconnect();
      };

      ws.onerror = () => ws.close();
    }

    reconnectBtn.onclick = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      writeToTerminal('\\x1b[2J\\x1b[H\\x1b[32mReconnecting...\\x1b[0m\\r\\n');
      if (ws && ws.readyState === WebSocket.CONNECTING) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      connect();
    };

    stopBtn.onclick = () => {
      if(ws && ws.readyState===1 && confirm('Stop shell process?')) {
        ws.send(JSON.stringify({type:'stop'}));
      }
    };

    runClaudeBtn.onclick = () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'run_claude' }));
      }
    };

    cursorToggleBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = cursorPad.classList.toggle('open');
      cursorToggleBtn.textContent = isOpen ? '✕' : '✣';
    };

    arrowDownBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        ws.send(JSON.stringify({type:'input',data:'\\x1b[B'}));
      }
    };

    arrowUpBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        ws.send(JSON.stringify({type:'input',data:'\\x1b[A'}));
      }
    };

    arrowLeftBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        ws.send(JSON.stringify({type:'input',data:'\\x1b[D'}));
      }
    };

    arrowRightBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        ws.send(JSON.stringify({type:'input',data:'\\x1b[C'}));
      }
    };

    function bindArrowHold(button, seq) {
      let repeatTimer = null;
      let repeatInterval = null;
      const send = () => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data: seq }));
        }
      };
      const start = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        send();
        repeatTimer = setTimeout(() => {
          repeatInterval = setInterval(send, 65);
        }, 280);
      };
      const stop = () => {
        if (repeatTimer) clearTimeout(repeatTimer);
        if (repeatInterval) clearInterval(repeatInterval);
        repeatTimer = null;
        repeatInterval = null;
      };

      button.addEventListener('mousedown', start);
      button.addEventListener('touchstart', start, { passive: false });
      button.addEventListener('mouseup', stop);
      button.addEventListener('mouseleave', stop);
      button.addEventListener('touchend', stop);
      button.addEventListener('touchcancel', stop);
    }

    bindArrowHold(arrowUpBtn, '\\x1b[A');
    bindArrowHold(arrowDownBtn, '\\x1b[B');
    bindArrowHold(arrowLeftBtn, '\\x1b[D');
    bindArrowHold(arrowRightBtn, '\\x1b[C');

    document.addEventListener('click', (e) => {
      if (!cursorPad.classList.contains('open')) return;
      if (e.target.closest('#cursor-wrap')) return;
      cursorPad.classList.remove('open');
      cursorToggleBtn.textContent = '✣';
    });

    enterBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        inputLineBuffer = '';
        ws.send(JSON.stringify({type:'input',data:'\\r'}));
      }
    };

    escBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        ws.send(JSON.stringify({type:'input',data:'\\x1b'}));
      }
    };

    slashBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        updateInputBuffer('/');
        ws.send(JSON.stringify({type:'input',data:'/'}));
      }
    };

    term.onData(data => {
      const outgoing = maybeFixMobileDuplication(data);
      updateInputBuffer(outgoing);
      if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'input',data:outgoing}));
    });

    window.addEventListener('resize',()=>{
      scheduleFit(true);
    });

    startShellBtn.onclick = () => {
      saveStartOptions();
      startOverlay.classList.remove('open');
      connect();
    };

    if (shouldAutoStart) {
      startOverlay.classList.remove('open');
      connect();
    } else {
      startOverlay.classList.add('open');
    }

    updateScrollBtn();

    const root = document.documentElement;
    if (window.visualViewport) {
      const adjustForKeyboard = () => {
        const vv = window.visualViewport;
        const offsetA = window.innerHeight - vv.height - vv.offsetTop;
        const offsetB = document.documentElement.clientHeight - vv.height - vv.offsetTop;
        const rawOffset = Math.max(0, offsetA, offsetB);
        const nextOffset = rawOffset > 0 ? rawOffset + 20 : 0;
        if (Math.abs(nextOffset - keyboardOffset) < 2) return;
        keyboardOffset = nextOffset;
        root.style.setProperty('--kb-offset', nextOffset + 'px');
        scheduleFit(nextOffset > 40);
      };
      window.visualViewport.addEventListener('resize', adjustForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustForKeyboard);
      adjustForKeyboard();
    }
  </script>
</body>
</html>`;
}

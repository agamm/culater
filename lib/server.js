const http = require('http');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
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

const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');

// Detect shell
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');

function checkAuth(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('token') === SESSION_TOKEN) return true;
  const cookies = req.headers.cookie || '';
  return cookies.includes(`token=${SESSION_TOKEN}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/auth' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('password') === PASSWORD) {
        res.writeHead(302, {
          'Set-Cookie': `token=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
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

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(TERMINAL_HTML);
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let ptyProcess = null;
  let cols = 80, rows = 24;

  function startPty() {
    try {
      ptyProcess = pty.spawn(SHELL, ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: WORK_DIR,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        }
      });

      ptyProcess.onData(data => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        ptyProcess = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('\r\n\x1b[33m[Exited: ' + exitCode + '] Press Enter to restart\x1b[0m\r\n');
        }
      });

      setTimeout(() => {
        if (ptyProcess) ptyProcess.write('claude\r');
      }, 200);

    } catch (err) {
      ws.send('\x1b[31mFailed: ' + err.message + '\x1b[0m\r\n');
    }
  }

  startPty();

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'input') {
        if (ptyProcess) {
          ptyProcess.write(data.data);
        } else if (data.data === '\r' || data.data === '\n') {
          ws.send('\x1b[2J\x1b[H');
          startPty();
        }
      } else if (data.type === 'resize') {
        cols = data.cols;
        rows = data.rows;
        if (ptyProcess) ptyProcess.resize(cols, rows);
      } else if (data.type === 'stop') {
        if (ptyProcess) ptyProcess.kill();
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({type:'pong'}));
      }
    } catch {
      if (ptyProcess) ptyProcess.write(msg.toString());
    }
  });

  ws.on('close', () => {
    if (ptyProcess) ptyProcess.kill();
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

async function createTunnel() {
  tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let urlFound = false;
  tunnelProcess.stderr.on('data', data => {
    const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !urlFound) {
      urlFound = true;
      const url = match[0];

      console.log('\n\x1b[1mculater\x1b[0m ready!\n');
      qrcode.generate(url, { small: true });
      console.log(`\n  \x1b[36m${url}\x1b[0m`);
      console.log(`  Password: \x1b[33m${PASSWORD}\x1b[0m\n`);

      setTimeout(async () => {
        try {
          await fetch(url, { method: 'HEAD' });
          sendNotification(url);
        } catch {
          setTimeout(() => sendNotification(url), 2000);
        }
      }, 1500);
    }
  });

  tunnelProcess.on('close', code => {
    if (code !== 0) setTimeout(createTunnel, 5000);
  });
}

server.listen(PORT, createTunnel);

process.on('SIGINT', () => {
  if (tunnelProcess) tunnelProcess.kill();
  wss.clients.forEach(ws => ws.close());
  server.close();
  process.exit(0);
});

const LOGIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>culater</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,sans-serif;height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1a2e}
    .box{background:#fff;padding:32px;border-radius:12px;width:90%;max-width:320px}
    h1{font-size:24px;margin-bottom:24px;text-align:center}
    input{width:100%;padding:14px;border:1px solid #ddd;border-radius:8px;font-size:16px;margin-bottom:16px}
    button{width:100%;padding:14px;background:#007AFF;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}
    .error{color:#c62828;text-align:center;margin-bottom:16px}
  </style>
</head>
<body>
  <div class="box">
    <h1>culater</h1>
    <div class="error" id="e"></div>
    <form action="/auth" method="POST">
      <input type="password" name="password" placeholder="Password" autofocus>
      <button type="submit">Enter</button>
    </form>
  </div>
  <script>if(location.search.includes('error'))document.getElementById('e').textContent='Invalid password'</script>
</body>
</html>`;

const TERMINAL_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>culater</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
  <style>
    *{margin:0;padding:0}
    html,body{height:100%;background:#1a1a2e;overflow:hidden}
    #terminal{height:100%}
    .xterm{height:100%;padding:8px}
    .xterm-viewport{overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;scroll-behavior:smooth}
    #reconnect{position:fixed;bottom:20px;right:60px;padding:12px 24px;background:#007AFF;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;display:none;z-index:100}
    #reconnect:active{background:#0056b3}
    #action-btns{position:fixed;bottom:16px;right:0;display:flex;flex-direction:column;gap:6px;z-index:100;padding-right:0}
    #action-btns button{width:54px;height:44px;color:#fff;border:none;border-radius:10px 0 0 10px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
    #action-btns button:active{opacity:0.6}
    #slash-btn{background:rgba(142,142,147,0.8)}
    #esc-btn{background:rgba(255,149,0,0.8)}
    #enter-btn{background:rgba(52,199,89,0.8)}
    #arrow-down{background:rgba(88,86,214,0.8)}
    #status{position:fixed;top:8px;right:70px;padding:4px 8px;border-radius:4px;font-size:12px;color:#fff;background:#2d5a27}
    #status.disconnected{background:#8b2635}
    #stop{position:fixed;top:6px;right:0;width:44px;height:32px;background:rgba(198,40,40,0.8);color:#fff;border:none;border-radius:6px 0 0 6px;font-size:18px;cursor:pointer;z-index:100;display:flex;align-items:center;justify-content:center}
    #stop:active{opacity:0.6}
    #streaming{position:fixed;top:8px;left:8px;padding:6px 12px;border-radius:4px;font-size:12px;color:#fff;background:#5c4d9a;display:none;align-items:center;gap:6px}
    #streaming .dot{width:6px;height:6px;background:#fff;border-radius:50%;animation:pulse 1s infinite}
    #streaming .dot:nth-child(2){animation-delay:0.2s}
    #streaming .dot:nth-child(3){animation-delay:0.4s}
    @keyframes pulse{0%,100%{opacity:0.3}50%{opacity:1}}
    #scroll-lock{position:fixed;top:44px;right:0;width:44px;height:32px;background:rgba(0,122,255,0.8);color:#fff;border:none;border-radius:6px 0 0 6px;font-size:16px;cursor:pointer;z-index:100;display:flex;align-items:center;justify-content:center}
    #scroll-lock.locked{background:rgba(255,149,0,0.8)}
    #scroll-lock:active{opacity:0.8}
  </style>
</head>
<body>
  <div id="status">Connected</div>
  <button id="stop" title="Stop Claude">■</button>
  <div id="streaming"><span class="dot"></span><span class="dot"></span><span class="dot"></span>Streaming</div>
  <button id="reconnect">Reconnect</button>
  <button id="scroll-lock">⇊</button>
  <div id="action-btns">
    <button id="slash-btn" title="Send /">/</button>
    <button id="esc-btn" title="Send Escape">Esc</button>
    <button id="arrow-down" title="Send Down Arrow">↓</button>
    <button id="enter-btn" title="Send Enter">⏎</button>
  </div>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const term = new Terminal({cursorBlink:true,fontSize:14,fontFamily:'Menlo,Monaco,monospace',theme:{background:'#1a1a2e'},scrollback:5000,smoothScrollDuration:100,fastScrollModifier:'none',fastScrollSensitivity:5,scrollSensitivity:3});
    const fit = new FitAddon.FitAddon();
    const statusEl = document.getElementById('status');
    const reconnectBtn = document.getElementById('reconnect');
    const streamingEl = document.getElementById('streaming');
    const scrollLockBtn = document.getElementById('scroll-lock');
    const stopBtn = document.getElementById('stop');
    const arrowDownBtn = document.getElementById('arrow-down');
    const enterBtn = document.getElementById('enter-btn');
    const escBtn = document.getElementById('esc-btn');
    const slashBtn = document.getElementById('slash-btn');
    let ws;
    let streamTimeout;
    let autoScroll = true;
    let userScrolling = false;

    term.loadAddon(fit);
    term.open(document.getElementById('terminal'));
    fit.fit();

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
        scrollLockBtn.textContent = '⇊';
        scrollLockBtn.className = '';
      } else {
        scrollLockBtn.textContent = '⏸';
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

    function connect() {
      const proto = location.protocol==='https:'?'wss:':'ws:';
      ws = new WebSocket(proto+'//'+location.host);

      ws.onopen = () => {
        statusEl.textContent = 'Connected';
        statusEl.className = '';
        reconnectBtn.style.display = 'none';
        term.focus();
        ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
      };

      ws.onmessage = e => {
        showStreaming();
        const scrollPos = viewport ? viewport.scrollTop : 0;
        term.write(e.data);
        requestAnimationFrame(() => {
          if (viewport) {
            if (autoScroll) {
              viewport.scrollTop = viewport.scrollHeight;
            } else {
              viewport.scrollTop = scrollPos;
            }
          }
        });
      };

      ws.onclose = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'disconnected';
        reconnectBtn.style.display = 'block';
        streamingEl.style.display = 'none';
        clearInterval(clientPing);
        term.write('\\r\\n\\x1b[31m[Disconnected - auto-reconnecting...]\\x1b[0m\\r\\n');
        setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();

      clientPing = setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({type:'ping'}));
        }
      }, 20000);
    }

    let clientPing;

    reconnectBtn.onclick = () => {
      term.write('\\x1b[2J\\x1b[H\\x1b[32mReconnecting...\\x1b[0m\\r\\n');
      connect();
    };

    stopBtn.onclick = () => {
      if(ws && ws.readyState===1 && confirm('Stop Claude process?')) {
        ws.send(JSON.stringify({type:'stop'}));
      }
    };

    arrowDownBtn.onclick = () => {
      if(ws && ws.readyState===1) {
        ws.send(JSON.stringify({type:'input',data:'\\x1b[B'}));
      }
    };

    enterBtn.onclick = () => {
      if(ws && ws.readyState===1) {
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
        ws.send(JSON.stringify({type:'input',data:'/'}));
      }
    };

    term.onData(data => {
      if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'input',data}));
    });

    window.addEventListener('resize',()=>{
      fit.fit();
      if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
    });

    connect();
    updateScrollBtn();

    const actionBtns = document.getElementById('action-btns');
    if (window.visualViewport) {
      const adjustForKeyboard = () => {
        const offset = window.innerHeight - visualViewport.height;
        actionBtns.style.bottom = (offset + 16) + 'px';
        if (offset > 50 && viewport) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      };
      window.visualViewport.addEventListener('resize', adjustForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustForKeyboard);
    }
  </script>
</body>
</html>`;

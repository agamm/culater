#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const path = require('path');

// Check for cloudflared
try {
  execSync('which cloudflared', { stdio: 'ignore' });
} catch {
  console.error('\x1b[31mError: cloudflared is not installed\x1b[0m\n');
  console.error('Install it with:');
  console.error('  \x1b[36mbrew install cloudflared\x1b[0m  (macOS)');
  console.error('  \x1b[36msudo apt install cloudflared\x1b[0m  (Linux)');
  console.error('\nOr visit: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/\n');
  process.exit(1);
}

// Generate random password
function randomPass() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 5; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

// Parse args
const args = process.argv.slice(2);
let password = randomPass();
let ntfyTopic = '';
let workDir = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-p' || args[i] === '--password') {
    password = args[++i];
  } else if (args[i] === '-n' || args[i] === '--ntfy') {
    ntfyTopic = args[++i];
  } else if (args[i] === '-d' || args[i] === '--dir') {
    workDir = args[++i];
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log(`
\x1b[1mculater\x1b[0m - Remote terminal for Claude Code

\x1b[1mUSAGE:\x1b[0m
  npx culater [options]

\x1b[1mOPTIONS:\x1b[0m
  -p, --password <pass>  Set password (default: random 5-char)
  -n, --ntfy <topic>     Enable ntfy.sh push notifications
  -d, --dir <path>       Working directory (default: current)
  -h, --help             Show this help

\x1b[1mEXAMPLES:\x1b[0m
  npx culater
  npx culater -p mysecret
  npx culater -p mysecret -n my-ntfy-topic
  npx culater -d ~/projects/myapp
`);
    process.exit(0);
  }
}

// Set env and run server
process.env.REMOTE_PASSWORD = password;
process.env.NTFY_TOPIC = ntfyTopic;
process.env.WORK_DIR = workDir;

require('../lib/server.js');

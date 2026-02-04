#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

const CONFIG_FILE = '/tmp/culater.json';

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

// Load saved config
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Save config
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {}
}

// Parse args
const args = process.argv.slice(2);
let password = null;
let ntfyTopic = null;
let workDir = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-n' || args[i] === '--ntfy') {
    ntfyTopic = args[++i];
  } else if (args[i] === '-d' || args[i] === '--dir') {
    workDir = args[++i];
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log(`
\x1b[1mculater\x1b[0m - Remote terminal for Claude Code

\x1b[1mUSAGE:\x1b[0m
  npx culater <password> [options]

\x1b[1mOPTIONS:\x1b[0m
  -n, --ntfy <topic>     ntfy.sh topic for push notifications (saved for next time)
  -d, --dir <path>       Working directory (default: current)
  -h, --help             Show this help

\x1b[1mEXAMPLES:\x1b[0m
  npx culater mysecret
  npx culater mysecret -n my-ntfy-topic
  npx culater mysecret -d ~/projects/myapp
`);
    process.exit(0);
  } else if (!args[i].startsWith('-') && !password) {
    password = args[i];
  }
}

if (!password) {
  console.error('\x1b[31mError: Password required\x1b[0m\n');
  console.error('Usage: npx culater <password>');
  process.exit(1);
}

// Load config and use saved ntfy if not provided
const config = loadConfig();
if (ntfyTopic) {
  // Save new ntfy topic
  config.ntfyTopic = ntfyTopic;
  saveConfig(config);
} else if (config.ntfyTopic) {
  // Use saved ntfy topic
  ntfyTopic = config.ntfyTopic;
}

// Set env and run server
process.env.REMOTE_PASSWORD = password;
process.env.NTFY_TOPIC = ntfyTopic || '';
process.env.WORK_DIR = workDir;

require('../lib/server.js');

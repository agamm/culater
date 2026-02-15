#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.culater');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_CONFIG_FILE = '/tmp/culater.json';
const MAX_RECENT_DIRS = 12;

// Check for cloudflared
try {
  execSync('which cloudflared', { stdio: 'ignore' });
} catch {
  console.error('\x1b[31mError:\x1b[0m cloudflared not found');
  console.error('Install: \x1b[36mbrew install cloudflared\x1b[0m (macOS) or \x1b[36mapt install cloudflared\x1b[0m (Linux)');
  process.exit(1);
}

// Load saved config
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
}

// Save config
function saveConfig(config) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
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

Usage: npx culater <password> [-d <dir>] [-n <ntfy-topic>]

Options:
  -d, --dir <path>    Working directory
  -n, --ntfy <topic>  Send ntfy.sh notification
  -h, --help          Show help
`);
    process.exit(0);
  } else if (!args[i].startsWith('-') && !password) {
    password = args[i];
  }
}

if (!password) {
  console.error('Usage: npx culater <password>');
  process.exit(1);
}

workDir = path.resolve(workDir);

// Load config and use saved ntfy if not provided
const config = loadConfig();
if (ntfyTopic) {
  // Save new ntfy topic
  config.ntfyTopic = ntfyTopic;
} else if (config.ntfyTopic) {
  // Use saved ntfy topic
  ntfyTopic = config.ntfyTopic;
}

const recentDirs = Array.isArray(config.recentDirs) ? config.recentDirs : [];
const normalizedRecent = recentDirs
  .filter(dir => typeof dir === 'string' && dir.trim())
  .map(dir => path.resolve(dir));
const previousRecentDirs = Array.from(new Set(normalizedRecent)).slice(0, MAX_RECENT_DIRS);
const nextRecentDirs = [workDir, ...previousRecentDirs.filter(dir => dir !== workDir)].slice(0, MAX_RECENT_DIRS);
config.recentDirs = nextRecentDirs;
saveConfig(config);

// Set env and run server
process.env.REMOTE_PASSWORD = password;
process.env.NTFY_TOPIC = ntfyTopic || '';
process.env.WORK_DIR = workDir;
process.env.RECENT_DIRS = JSON.stringify(previousRecentDirs);

require('../lib/server.js');

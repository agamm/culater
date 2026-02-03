#!/usr/bin/env node

const { execSync } = require('child_process');
const readline = require('readline');

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

// Parse args
const args = process.argv.slice(2);
let password = null;
let workDir = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-d' || args[i] === '--dir') {
    workDir = args[++i];
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log(`
\x1b[1mculater\x1b[0m - Remote terminal for Claude Code

\x1b[1mUSAGE:\x1b[0m
  npx culater <password> [options]

\x1b[1mOPTIONS:\x1b[0m
  -d, --dir <path>       Working directory (default: current)
  -h, --help             Show this help

\x1b[1mEXAMPLES:\x1b[0m
  npx culater mysecret
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

// Ask for ntfy topic
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('ntfy.sh topic (press Enter to skip): ', (ntfyTopic) => {
  rl.close();

  // Set env and run server
  process.env.REMOTE_PASSWORD = password;
  process.env.NTFY_TOPIC = ntfyTopic.trim();
  process.env.WORK_DIR = workDir;

  require('../lib/server.js');
});

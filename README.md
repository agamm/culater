# culater

**Your AI terminal, anywhere.**

`culater` gives you fast phone access to your local Claude Code shell through a secure Cloudflare tunnel, so you can check output, unblock an agent, and keep moving when you're away from your desk.

## Demo

![culater demo](assets/culater-demo.gif)

The flow starts on your computer (CLI + QR), then continues on your phone.

Regenerate the demo GIF:

```bash
node scripts/make-readme-gif.mjs
```

## Why culater

- Agent-first remote terminal workflow from any mobile browser
- Session survives refreshes and temporary network drops
- Project-aware startup (recent folders remembered in `~/.culater/config.json`)
- Manual `AI` launch when you want Claude, no forced auto-start
- One command to start, no account setup

## Quick Start

### 1) Install requirements

- Node.js 18+
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)

```bash
# macOS
brew install cloudflared

# Linux
sudo apt install cloudflared
```

### 2) Start culater

```bash
npx culater mypassword
```

### 3) Open it on your phone

- Scan the terminal QR code
- Enter the password
- Start shell (or auto-start if no previous project history exists)

## How It Works

1. `culater` starts a local PTY shell.
2. It creates a temporary Cloudflare tunnel URL.
3. Your phone connects to the web terminal and controls that shell in real time.

## Features

- Mobile-optimized terminal UI
- Touch scrolling with momentum
- Quick action buttons (`/`, `Esc`, `Enter`, cursor pad)
- Keyboard-aware controls that stay above the fold
- Auto-reconnect and persistent session resume
- Manual `AI` button to run Claude on demand
- Password gate before terminal access
- Optional ntfy push notifications for tunnel URL

## CLI Options

```txt
-n, --ntfy <topic>     ntfy.sh topic for push notifications (saved)
-d, --dir <path>       Working directory (default: current)
-h, --help             Show help
```

## Examples

```bash
# Start with password
npx culater mysecret

# Use a specific directory
npx culater mysecret -d ~/projects/myapp

# Enable ntfy notifications (saved for later runs)
npx culater mysecret -n my-ntfy-topic
```

## Notes

- Config is stored at `~/.culater/config.json`.
- First tunnel open can briefly show Cloudflare `1033` while edge registration finishes.

## License

MIT

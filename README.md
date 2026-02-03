# culater

Remote terminal for Claude Code - c(See) you later!

Access Claude Code from your phone via a secure tunnel.

## Quick Start

```bash
npx culater mypassword
```

You'll be prompted for an optional [ntfy.sh](https://ntfy.sh) topic to receive push notifications.

## Requirements

- Node.js 18+
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)

```bash
# macOS
brew install cloudflared

# Linux
sudo apt install cloudflared
```

## Options

```
-d, --dir <path>       Working directory (default: current)
-h, --help             Show help
```

## Examples

```bash
# Start with password
npx culater mysecret

# Specific directory
npx culater mysecret -d ~/projects/myapp
```

## Features

- Mobile-optimized terminal UI
- Touch scrolling with momentum
- Quick action buttons (/, Esc, ↓, Enter)
- Auto-reconnect on disconnect
- Keyboard-aware button positioning
- Streaming indicator
- Password protection
- Secure cloudflare tunnel
- Optional push notifications via ntfy.sh

## License

MIT

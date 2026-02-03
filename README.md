# culater

Remote terminal for Claude Code - c(See) you later!

Access Claude Code from your phone via a secure tunnel.

## Quick Start

```bash
npx culater
```

That's it! You'll get a URL and password to access from your phone.

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
-p, --password <pass>  Set password (default: random 5-char)
-n, --ntfy <topic>     Enable ntfy.sh push notifications
-d, --dir <path>       Working directory (default: current)
-h, --help             Show help
```

## Examples

```bash
# Random password, current directory
npx culater

# Custom password
npx culater -p mysecret

# With push notification
npx culater -n my-ntfy-topic

# Specific directory
npx culater -d ~/projects/myapp
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

## License

MIT

# culater

Remote terminal for Claude Code - c(See) you later!

Access Claude Code from your phone via a secure tunnel.

## Quick Start

```bash
npx culater mypassword
```

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
-n, --ntfy <topic>     ntfy.sh topic for push notifications (saved for next time)
-d, --dir <path>       Working directory (default: current)
-h, --help             Show help
```

## Examples

```bash
# Start with password
npx culater mysecret

# With push notifications (saved to /tmp/culater.json)
npx culater mysecret -n my-ntfy-topic

# Subsequent runs use saved ntfy topic automatically
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
- Push notifications via ntfy.sh (remembers your topic)

## License

MIT

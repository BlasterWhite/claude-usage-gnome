# Claude Usage — GNOME Shell extension

A small top-bar indicator for GNOME Shell that shows how much of your **Claude subscription limits** you have used, plus your **Claude Code token usage** for the day, read from local logs.

![Panel indicator](docs/panel.png)

The label `✻ 56% · 29%` reads as **current 5-hour session limit · weekly limit**. It turns yellow at 70% and red at 90%.

Click it to open the details:

![Dropdown menu](docs/menu.png)

## Features

- **Subscription limits**: usage percentage and reset time for the 5-hour session window, the weekly window, and the per-model weekly windows (Opus / Sonnet) when your plan has them. It also shows the weekly breakdown by product (Claude Code, Cowork, …).
- **Local Claude Code stats** (works offline): today's responses, output/input tokens, cache reads, output tokens over the last 5 hours, and tokens per model.
- Refreshes every 3 minutes, and on demand from the **Refresh** menu item.
- Falls back to today's output tokens in the panel label when the limits can't be fetched.

## How it works

| Part | Role |
|---|---|
| `claude-usage@perso/claude-usage.py` | Collects data and prints JSON. You can run it on its own: `python3 claude-usage@perso/claude-usage.py --limits` |
| `claude-usage@perso/extension.js` | The panel indicator. It runs the script asynchronously on each refresh. |

Data sources:

- **Local logs**: `~/.claude/projects/**/*.jsonl`, written by Claude Code. These are never sent anywhere.
- **Subscription limits**: the **undocumented** endpoint `https://api.anthropic.com/api/oauth/usage` (the one behind Claude Code's `/usage`). The extension authenticates with the OAuth token stored in `~/.claude/.credentials.json`, and that token is sent only to `api.anthropic.com`. The endpoint may change or break without notice. To stay fully offline, set `FETCH_LIMITS = false` at the top of `extension.js`.

## Requirements

- GNOME Shell 48, 49 or 50
- `python3` (standard library only)
- [Claude Code](https://claude.com/claude-code) logged in with a Claude subscription (needed for the limits; the local stats only need the logs)

## Installation

```sh
git clone https://github.com/BlasterWhite/claude-usage-gnome.git
cd claude-usage-gnome
./install.sh          # symlinks the extension into ~/.local/share/gnome-shell/extensions
```

On Wayland, log out and back in, then run:

```sh
gnome-extensions enable claude-usage@perso
```

To test in a nested shell without leaving your session (GNOME ≥ 49):

```sh
dbus-run-session gnome-shell --devkit --wayland
```

Logs: `journalctl -f -o cat /usr/bin/gnome-shell`

## Configuration

There is no preferences window yet. Edit the constants at the top of `extension.js`:

| Constant | Default | Meaning |
|---|---|---|
| `REFRESH_SECONDS` | `180` | Refresh interval |
| `FETCH_LIMITS` | `true` | `false` = local logs only, no network |

## Known limitations

- If the OAuth token has expired, the menu says so. Run Claude Code once so it refreshes the token.
- The limits endpoint is unofficial and may stop working at any time.

## License

[MIT](LICENSE)

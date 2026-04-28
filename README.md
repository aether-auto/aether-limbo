# aether-limbo

> A transparent wrapper around Claude Code that lets you doom-scroll while the
> agent is busy, and shames you when it isn't.

`limbo` runs in place of `claude`. While Claude is processing a long prompt, a
hotkey opens an in-terminal panel with Instagram / X / TikTok adapters; when
the response arrives, the panel auto-closes. Try to open it while Claude is
idle and limbo refuses with **"be productive, dumbass."**

## Status

See [PLAN.md](./PLAN.md) for the full roadmap.

| Phase | Status |
| --- | --- |
| §4.1 Project scaffolding | done |
| §4.2 Transparent PTY wrapper | done |
| §4.3 State detector | done |
| §4.4 Hotkey + guard | done |
| §4.5 Overlay shell | done |
| §4.6 Adapter layer | done |
| §4.7 Instagram adapter | done |
| §4.8 X / Twitter adapter | done |
| §4.9 TikTok adapter | done |
| §4.10 Auto-switch back | done |
| §4.11 Configuration | done |

## Install

> Requires Node ≥ 20 and an existing Claude Code install on `$PATH`.
> limbo never bundles or pins `claude` — updates flow through automatically.

Once published:

```sh
npm install -g @aether/limbo
limbo --version
```

For local development:

```sh
git clone <this repo>
cd aether-limbo
pnpm install
pnpm build
node packages/host/dist/cli.js --version
```

You can also override the resolved Claude binary:

```sh
CLAUDE_BIN=/path/to/claude limbo
```

## Hotkey

| Default | Action |
| --- | --- |
| `Ctrl+Shift+L` | Open the limbo overlay (only while Claude is `streaming`, `thinking`, or `tool_running`) |
| `Ctrl+Shift+L` (again) | Close the overlay and snap back to Claude |
| `q` (in overlay) | Close the overlay |
| `1`..`5` | Jump between overlay tabs (Reels • Feed • DMs • X • TikTok) |
| `h/j/k/l`, `g/G` | Vim-style navigation inside the overlay |

The hotkey is configurable via `~/.config/aether-limbo/config.toml` (see
[Config](#config) below).

If you press the hotkey while Claude is **idle**, you get:

```
be productive, dumbass.
```

## Config

### Config file location

`~/.config/aether-limbo/config.toml` (XDG_CONFIG_HOME-aware: uses
`$XDG_CONFIG_HOME/aether-limbo/config.toml` when the env var is set).

On first run, if the file does not exist, limbo writes the defaults silently.
To open the file in your editor directly:

```sh
limbo config edit    # writes defaults if missing, then opens $VISUAL / $EDITOR / nano / vi
limbo config show    # prints the resolved (merged) config as TOML to stdout
```

### Sections

```toml
[hotkey]
# Activation chord as a decoded byte string.
# TOML 1.0 requires \uXXXX escapes — \xXX is NOT accepted.
# Ctrl+L  = U+000C  → chord = ""
# F12     = ESC[24~ → chord = "[24~"
chord = ""

[guard]
message = "be productive, dumbass."
hold_ms = 1500
# Escalation copy after N consecutive idle attempts. 0 = disabled.
idle_attempts_before_escalation = 0
escalation_messages = [
  "seriously, stop.",
  "go do something useful.",
]

[snapback]
# Auto-close the overlay when Claude's response arrives.
enabled = true

[adapters]
# Tab display order (by adapter ID).
tab_order = ["instagram-reels", "instagram-feed", "instagram-dms", "twitter-home", "tiktok-foryou"]
# Keep sidecar processes alive across overlay close/open.
keep_warm = false

[adapters.instagram]
thumbnails = true
thumbnail_max_rows = 3

[adapters.twitter]
# "twikit" = cookie-based (default); "tweepy" = API-key bearer token.
auth = "twikit"
# Cache DM availability at session level (skip redundant probes).
cache_dms = true
language = "en"

[adapters.tiktok]
# Attempt a transparent session refresh once before showing the token form.
refresh_on_failure = true
keep_warm = false
```

### Chord syntax note

TOML 1.0 does not accept `\xXX` hex escapes. Use `\uXXXX` instead:

| Key | Bytes | TOML value |
| --- | --- | --- |
| Ctrl+L | `0x0C` | `""` |
| F12 | `ESC [ 2 4 ~` | `"[24~"` |

### Secrets

Credentials are stored separately in `~/.config/aether-limbo/secrets.toml`
(mode 0600, enforced on every write). The file is never created automatically;
credentials are only persisted when you opt in to "remember me" in the
in-overlay login form.

Env-var fallbacks (override secrets.toml when set):

| Variable | Purpose |
| --- | --- |
| `LIMBO_IG_USERNAME` / `LIMBO_IG_PASSWORD` | Instagram login |
| `LIMBO_TWITTER_USERNAME` / `LIMBO_TWITTER_PASSWORD` | X / twikit cookie login |
| `TWITTER_BEARER_TOKEN` | X / tweepy bearer token |
| `TWITTER_API_KEY` / `TWITTER_API_SECRET` | X / tweepy OAuth 1.0a |
| `TWITTER_ACCESS_TOKEN` / `TWITTER_ACCESS_SECRET` | X / tweepy OAuth 1.0a |
| `LIMBO_TIKTOK_MS_TOKEN` | TikTok ms_token |

Other escape-hatch env vars:

| Variable | Purpose |
| --- | --- |
| `LIMBO_PYTHON_EXE` | Override the Python interpreter used for sidecars |
| `LIMBO_GRAPHICS_PROTOCOL` | Override terminal graphics detection (`kitty`, `sixel`, `none`) |
| `LIMBO_CARBONYL_BIN` | Override path to the carbonyl binary |

### External system dependencies

- **chafa** — required for Instagram Feed thumbnails. If not installed, limbo
  degrades silently (thumbnails are skipped; text rows are still shown).
  Install: <https://hpjansson.org/chafa/>

## Develop

```sh
pnpm typecheck      # tsc --noEmit across all packages
pnpm lint           # biome check
pnpm test           # vitest run
pnpm build          # tsup
pnpm limbo          # run the bin from the workspace
```

## License

MIT — see [LICENSE](./LICENSE). Note the disclaimers in [PLAN.md §5](./PLAN.md):
the social-media adapters use unofficial third-party libraries and are
opt-in / use-at-your-own-risk.

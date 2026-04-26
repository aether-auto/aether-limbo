# aether-limbo

> A transparent wrapper around Claude Code that lets you doom-scroll while the
> agent is busy, and shames you when it isn't.

`limbo` runs in place of `claude`. While Claude is processing a long prompt, a
hotkey opens an in-terminal panel with Instagram / X / TikTok adapters; when
the response arrives, the panel auto-closes. Try to open it while Claude is
idle and limbo refuses with **"be productive, dumbass."**

## Status

Early scaffolding. See [PLAN.md](./PLAN.md) for the full roadmap.

| Phase | Status |
| --- | --- |
| §4.1 Project scaffolding | done |
| §4.2 Transparent PTY wrapper | not started |
| §4.3 State detector | not started |
| §4.4 Hotkey + guard | not started |
| §4.5–4.9 Overlay & adapters | not started |

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
PLAN.md §4.11).

If you press the hotkey while Claude is **idle**, you get:

```
be productive, dumbass.
```

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

# aether-limbo — Plan

> A transparent wrapper around Claude Code that lets you doom-scroll while the
> agent is busy, and shames you when it isn't.

---

## 1. Concept

`limbo` is a CLI you launch *instead of* `claude`. It spawns the real `claude`
binary in a pseudo-terminal (PTY) and proxies all I/O so behaviour is
indistinguishable from running Claude Code directly. While Claude is processing
a long prompt, a hotkey opens an in-terminal "limbo" panel: Instagram (reels /
feed / DMs), X/Twitter, and TikTok, powered by existing third-party libraries.
When the response arrives the panel auto-closes and focus snaps back to Claude.
Trying to open the panel while Claude is idle prints **"be productive,
dumbass."** and refuses.

### Hard requirements (non-negotiable)
- Pure pass-through. Any flag, env var, plugin, MCP server, hook,
  slash-command, or future Claude Code update must work without limbo changes.
- Never bundle or pin `claude` — resolve it from `PATH` at runtime.
- Detector and overlay must add **zero** characters to Claude's render.

---

## 2. Architecture (one paragraph)

A Node.js + TypeScript host process spawns `claude` via `node-pty`, attaches
the host TTY in raw mode, and pipes bytes both ways. A passive **state
detector** *tees* the PTY output (does not filter it) and classifies Claude as
`idle | thinking | streaming | tool_running` from prompt-marker / spinner
heuristics. A **hotkey interceptor** sits in the input path, swallows the
configured chord, and toggles a **limbo overlay** rendered on the terminal
alt-screen. The overlay hosts pluggable adapters that shell out to Python
processes (`instagrapi`, `twikit`, `TikTokApi`) over JSON-RPC on stdio. A
**state watcher** force-closes the overlay the instant Claude returns to idle.
A **guard** blocks overlay open when state is `idle`.

---

## 3. Tech stack (committed choices)

- **Runtime:** Node.js ≥ 20, TypeScript strict, ESM
- **PTY:** `node-pty`
- **TUI:** `blessed` (true alt-screen, raw input, no React render-loop conflict)
- **Adapter sidecars:** Python 3.11 venv, vendored on first run
  - Instagram: `instagrapi`
  - X / Twitter: `twikit` (anonymous) + optional `tweepy` (with API keys)
  - TikTok: `TikTokApi` (with `playwright` browser context)
- **Video / rich rendering fallback:** `carbonyl` (Chromium-in-TTY), launched
  in a sub-pane for reels and TikTok video playback
- **Packaging:** npm, single `bin: limbo`
- **Config:** `~/.config/aether-limbo/config.toml`

---

## 4. Tasks

### 4.1 Project scaffolding
- [x] `npm init`, TypeScript strict, ESM, `tsup` build, `bin: limbo`
- [x] `pnpm` workspace with `packages/host` (TS) and `packages/sidecars` (Python)
- [x] CI: typecheck + lint + smoke test (`limbo --version` resolves & runs `claude --version`)
- [x] `README.md` with install + hotkey docs

### 4.2 Transparent PTY wrapper (the "pure wrapper" core)
- [x] Resolve `claude` from `PATH`; clear error if missing
- [x] `pty.spawn(claudeBin, process.argv.slice(2), { env: process.env, cwd, cols, rows })`
- [x] Set host stdin to raw, no echo; restore on exit / signal / panic
- [x] Bidirectional pipe (host stdin → child stdin, child stdout → host stdout)
- [x] Forward `SIGWINCH` → `pty.resize(cols, rows)`
- [x] Forward `SIGINT`, `SIGTERM`, `SIGHUP` to child; propagate exit code
- [x] Acceptance: a project with custom hooks, MCP servers, plugins, and
      slash-commands behaves identically under `limbo` vs `claude` *(automated in `test/acceptance.test.ts`: byte-equivalent under `\r`-collapse normalization, exit-code parity verified for both success and failure paths against the live `claude` install)*

### 4.3 Claude state detector ✓ done
- [x] Tee child stdout: one branch to TTY, one to detector (no buffering delay) *(synchronous fan-out inside the single `pty.onData` in `wrapper.ts`; detector.feed wrapped in try/catch so it can never affect pass-through)*
- [x] States: `idle`, `thinking`, `streaming`, `tool_running` *(`src/detector/types.ts`)*
- [x] ANSI heuristics: prompt sigil match, spinner-frame detection, streaming
      end marker; debounce 150 ms *(`src/detector/heuristics.ts` via `strip-ansi`; precedence tool > spinner > streaming; 150 ms when prompt sigil visible, 600 ms otherwise)*
- [x] Emit on internal `EventEmitter`; expose `getState()` for the guard *(`ClaudeStateDetector` in `src/detector/detector.ts`; `on('state', …)` returns disposables)*
- [x] Replay-test harness: record real PTY sessions, assert classification *(harness in `test/detector-replay.test.ts` reads `.bin` + timeline `.json` and parameterises by scenario name; `scripts/record-pty-fixture.mjs` captures real PTY sessions into the fixture format; `scenario-1` is synthetic, `scenario-2` is a real `claude --help` capture; long-running interactive recording is queued for 4.13)*

### 4.4 Hotkey interceptor & guard
- [ ] Default chord `Ctrl+Shift+L`, configurable
- [ ] Intercept in stdin → child path; never forward chord to Claude
- [ ] Second press while overlay open → close overlay
- [ ] Guard: if `state === 'idle'` on open attempt → print
      **"be productive, dumbass."** centred, hold ~1.2 s, clear, abort open
- [ ] Optional escalation copy after N idle attempts (off by default)

### 4.5 Limbo overlay (TUI shell)
- [ ] Enter alt-screen on open; restore main screen on close (no leftover bytes)
- [ ] Top tab bar: Reels • Feed • DMs • X • TikTok (order from config)
- [ ] Bottom status line: Claude state + "press <chord> to return"
- [ ] Vim nav: `h/j/k/l`, `g/G`, `q` to close, `1..5` jump to tab
- [ ] Sub-pane host for `carbonyl` when an adapter requests video playback

### 4.6 Adapter layer (Node ↔ Python sidecars)
- [ ] Define `Adapter` interface: `mount(pane)`, `unmount()`, `handleKey(k)`
- [ ] JSON-RPC over stdio between Node host and Python sidecar processes
- [ ] First-run bootstrap: create venv at `~/.local/share/aether-limbo/venv`,
      install pinned requirements
- [ ] Per-adapter feature flag in config

### 4.7 Instagram adapter (`instagrapi`)
- [ ] Login flow: username/password with 2FA prompt; persist session JSON
- [ ] Reels view → list of media; `Enter` opens carbonyl on the IG web URL
- [ ] Feed view → infinite scroll with text + thumbnail (sixel/kitty graphics)
- [ ] DMs → thread list, message view, send-reply input

### 4.8 X / Twitter adapter (`twikit`, optional `tweepy`)
- [ ] Auth: `twikit` cookie auth (no API key) by default; `tweepy` path if
      keys are configured
- [ ] Home timeline view; `r` to reply, `l` to like, `Enter` opens thread
- [ ] DMs (paid-tier only — degrade gracefully when unavailable)

### 4.9 TikTok adapter (`TikTokApi`)
- [ ] Bootstrap a Playwright browser context once; reuse session
- [ ] For-You feed view; `Enter` plays video in carbonyl sub-pane
- [ ] Comments view (read-only is fine for v1)

### 4.10 Auto-switch back on response
- [ ] State watcher: `streaming|tool_running → idle` AND overlay open
      → fire `snap_back`
- [ ] Snap-back: unmount adapter, exit alt-screen, force redraw
- [ ] Toast in a non-PTY status region: "✓ response ready"
- [ ] Acceptance: snap-back happens within 250 ms of state transition

### 4.11 Configuration
- [ ] `~/.config/aether-limbo/config.toml`:
      `[hotkey]`, `[adapters]`, `[guard]`, `[snapback]`
- [ ] `limbo config edit` → opens in `$EDITOR`
- [ ] First-run wizard if config missing

### 4.12 Distribution & update story
- [ ] Publish `@aether/limbo` on npm with `bin: limbo`
- [ ] **No** dependency on `@anthropic-ai/claude-code` — resolve `claude` at
      runtime so user updates flow through automatically
- [ ] README: "limbo wraps your existing Claude Code install; update Claude
      Code the way you always have"

### 4.13 Manual verification
- [ ] Long-running prompt → hotkey → scroll reels → response arrives →
      overlay closes automatically
- [ ] Idle Claude → hotkey → shame message → overlay does not open
- [ ] Project with custom hooks/MCP/plugins behaves identically vs `claude`
- [ ] Resize terminal mid-stream — output stays clean
- [ ] `Ctrl+C` during streaming cancels the Claude turn, not limbo
- [ ] Capture a long-running interactive `claude` session (≥1 thinking
      cycle, ≥1 tool call, idle return) via
      `node packages/host/scripts/record-pty-fixture.mjs scenario-3 -- claude`,
      annotate `expectAfter` per chunk (`thinking` / `tool_running` /
      `streaming` / `idle`), and add `scenario-3` to the parameter list
      in `test/detector-replay.test.ts` — replaces the synthetic
      `scenario-1` as the load-bearing detector regression net

---

## 5. Risks & deferrals

- **ToS.** Instagram, X, TikTok all forbid unofficial clients to varying
  degrees. Ship a clear disclaimer; treat all integrations as best-effort,
  opt-in, and use-at-your-own-risk.
- **Detector drift.** Claude Code render output may change between releases.
  The replay harness in 4.3 is the regression net.
- **Out of scope (v1):** posting/uploading from limbo, cross-device sync,
  telemetry, Windows support (PTY semantics differ — defer).

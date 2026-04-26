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
- [x] Default chord `Ctrl+L` (`\x0c`), configurable via `RunWrapperOptions.chord` *(`Ctrl+Shift+L` is indistinguishable from `Ctrl+L` in default raw stdin without the Kitty keyboard protocol; default lands on the byte that actually arrives. `ChordMatcher` in `src/hotkey/chord-matcher.ts` handles arbitrary single- or multi-byte chord strings with cross-chunk prefix buffering — F12 / Alt+L / multi-key sequences all work when configured)*
- [x] Intercept in stdin → child path; never forward chord to Claude *(`HotkeyInterceptor.feed` in `src/hotkey/interceptor.ts` runs every stdin chunk through the matcher and returns only the passthrough; `wrapper.ts` calls `pty.write` only when passthrough is non-empty. Verified by the new wrapper integration tests and by §4.2 byte-parity acceptance still passing for non-chord traffic)*
- [x] Second press while overlay open → close overlay *(`handleChord` checks `overlay.isOpen()` first; two chord presses in one chunk are handled as open-then-close. Real overlay TUI lands in 4.5 — for now `NullOverlayController` is the seam)*
- [x] Guard: if `state === 'idle'` on open attempt → print **"be productive, dumbass."** centred, hold ~1.2 s, clear, abort open *(`ShameFlash` in `src/hotkey/shame-flash.ts` enters alt-screen `\x1b[?1049h`, hides cursor, paints the message at `floor(rows/2)` centred horizontally, holds 1200 ms via injected `Clock`, then restores. Reentrancy-guarded: concurrent shame triggers coalesce. Fired non-blockingly so the user can keep typing into Claude during the flash — being productive is the actual escape from being shamed)*
- [ ] Optional escalation copy after N idle attempts (off by default) *(deferred — design intentionally off-by-default; will land alongside 4.11 config so the threshold and copy live in `config.toml` rather than as a code constant)*

### 4.5 Limbo overlay (TUI shell)
- [x] Enter alt-screen on open; restore main screen on close (no leftover bytes) *(`LimboOverlay.open` writes `\x1b[?1049h` + `\x1b[?25l` then paints chrome; `close` writes `\x1b[?25h` + `\x1b[?1049l`. Asserted byte-exact in `src/overlay/overlay.test.ts`)*
- [x] Top tab bar: Reels • Feed • DMs • X • TikTok (order from config) *(`renderTabBar` in `src/overlay/tab-bar.ts` highlights the active tab via SGR invert and pads to full column width. Tab order is `OverlayDeps.tabs` defaulting to `DEFAULT_TABS`; the config plumbing for `[adapters]` order lands in §4.11 and feeds the same constructor arg)*
- [x] Bottom status line: Claude state + "press <chord> to return" *(`renderStatusLine` in `src/overlay/status-line.ts` with `describeChord` for human-readable chord names — Ctrl+L, F12, etc. Repaints on detector `state` events while open; falls back to a single dim line when columns are too narrow for both halves)*
- [x] Vim nav: `h/j/k/l`, `g/G`, `q` to close, `1..5` jump to tab *(`OverlayKeymap` in `src/overlay/keymap.ts` with cross-chunk `gg` partial-sequence buffer that resets on `close`. `j/k/g/G` are wired but no-op until adapters mount in §4.6+; `h/l` cycle the active tab with wrap; `1..5` jump to a zero-indexed tab)*
- [ ] Sub-pane host for `carbonyl` when an adapter requests video playback *(deferred — body region currently fills the whole inter-chrome area. Will land alongside §4.7 / §4.9 when an adapter actually requests video; the painter just needs to reserve a sub-rect and forward to a child carbonyl process)*
- [x] **Carry-over from 4.4:** replace `NullOverlayController` (in `src/hotkey/overlay-stub.ts`) with the real overlay implementing `IOverlayController` (`isOpen` / `open` / `close`); inject it through `RunWrapperOptions.interceptor` (or extend the default-construction in `wrapper.ts` to wire the real overlay). The hotkey interceptor seam is already in place — the only remaining work in §4.4's column is swapping the stub for the real thing. *(done — `wrapper.ts` default-constructs `LimboOverlay({ stdout, detector, chord? })` and threads it into the `HotkeyInterceptor`. `RunWrapperOptions.overlay` + `onOverlay` give tests the same injection seam the interceptor and detector already have. `IOverlayController` gained `handleInput(chunk)`; `NullOverlayController` is kept as the unit-test stub with a recording buffer)*
- [x] **Carry-over from 4.4:** when the overlay opens via the chord, it must redirect stdin away from the PTY for the duration it is open (input goes to the overlay's TUI, not Claude). Today the wrapper still pipes all non-chord bytes through to Claude unconditionally; §4.5 needs to teach the interceptor (or the wrapper) to route input to the overlay while `overlay.isOpen()` is true. *(done in `wrapper.ts`: after `interceptor.feed`, the wrapper forks on `overlay.isOpen()` — open → `overlay.handleInput(passthrough)`; closed → `pty.write(passthrough)`. Verified by two new tests in `wrapper.test.ts` covering both directions of the toggle, plus a teardown test that the overlay is force-closed if the PTY exits while still open. Known minor edge: bytes batched in the same chunk as the chord toggle all go to the post-toggle target — acceptable for §4.5 since real chord presses arrive solo)*

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
- [ ] **Carry-over from 4.4 — `[hotkey]`:** wire the loaded chord into `RunWrapperOptions.chord` (already plumbed through `wrapper.ts` → `HotkeyInterceptor` → `ChordMatcher`; arbitrary single- or multi-byte byte strings are accepted today). Recommend the config syntax names the chord by escape (e.g. `chord = "\\x0c"` or `chord = "\\x1b[24~"`).
- [ ] **Carry-over from 4.4 — `[guard]`:** implement the optional escalation copy after N idle attempts (deferred from §4.4 line 5). Threshold and copy lines belong in `[guard]`, e.g. `idle_attempts_before_escalation = 5`, `escalation_messages = [..]`. Off by default. The hotkey interceptor (`src/hotkey/interceptor.ts`) is the place to count idle-attempt firings and ask the shame renderer for an alternate message.
- [ ] **Carry-over from 4.4 — `[guard]`:** the shame banner's hold duration and copy are already constructor-configurable on `ShameFlash` (`message`, `holdMs`); plumb them from `[guard]` into `wrapper.ts`'s default `ShameFlash` construction.

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

### 5.1 Deferred work items (single source of truth)

Each row is a piece of work that is intentionally NOT done yet. The "blocked on" column says exactly what unblocks it — anything with no blocker is fair game for an early-pickup.

| # | Item | Origin | Target section | Blocked on | Rationale |
|---|------|--------|----------------|------------|-----------|
| D1 | Optional escalation copy after N idle attempts to the chord guard | §4.4 | §4.11 (`[guard]` config) | Config layer existing | The threshold and copy lines belong in `config.toml` — hard-coding them now would require a second migration when §4.11 lands. The seam is in `HotkeyInterceptor` (`src/hotkey/interceptor.ts`) — count idle-attempt firings and ask `ShameFlash` for an alternate `message`. `ShameFlash` already accepts `message` and `holdMs` constructor args. |
| D2 | Carbonyl sub-pane host for video playback inside the overlay | §4.5 | §4.7 (Reels), §4.9 (TikTok) | An adapter actually asking for video | Until an adapter requests playback there is no URL to render. The painter in `LimboOverlay.paintBody` would need to reserve a sub-rect and spawn `carbonyl` as a child process. Revisit when the first adapter that needs it (Reels or TikTok) is wired. |
| D3 | Same-chunk chord-toggle byte routing (`"abc\x0cdef"` routes all bytes to the post-toggle target) | §4.5 | None (edge case) | A user actually reporting it | Real raw-mode keystrokes arrive as separate `data` events, so chord bytes never batch with adjacent typing in practice. Fix would require a segmented `IHotkeyInterceptor.feed` return type — `Array<{destination: 'pty' \| 'overlay'; bytes: string}>` — touching the chord matcher, the interceptor, and the wrapper. Cost > benefit until this fires. |
| D4 | Wire loaded chord byte string into `RunWrapperOptions.chord` | §4.4 | §4.11 (`[hotkey]`) | Config layer existing | All plumbing is already in place — `wrapper.ts` → `HotkeyInterceptor` → `ChordMatcher` accept arbitrary single- or multi-byte chords. Only the config-loader call is missing. Recommended TOML form: `chord = "\\x0c"` or `chord = "\\x1b[24~"`. |
| D5 | Plumb `[guard].hold_ms` and `[guard].message` into `ShameFlash` constructor | §4.4 | §4.11 (`[guard]`) | Config layer existing | `ShameFlash` constructor already takes `holdMs` and `message`. `wrapper.ts` constructs `ShameFlash` with defaults — just needs to read from config. |
| D6 | Tab order driven by `[adapters]` config | §4.5 | §4.11 (`[adapters]`) | Config layer existing | `LimboOverlay` constructor accepts `tabs?: readonly TabDefinition[]`; defaults to `DEFAULT_TABS`. The config-loader call is the only missing piece. |
| D7 | `j/k/g/G` scroll actions wired but no-op | §4.5 | §4.6+ (adapter content) | Adapters mounting scrollable content into the body region | The keymap emits `scroll-*` `KeyAction`s today; `LimboOverlay.applyAction` returns `false` for them. When adapters arrive, the overlay will route these to the active adapter's `handleKey(action)`. |
| D8 | scenario-3: long-running interactive `claude` PTY capture for the detector replay regression net | §4.13 | None (manual capture step) | Manual run with a real `claude` install | `node packages/host/scripts/record-pty-fixture.mjs scenario-3 -- claude`, exercise ≥1 thinking cycle + ≥1 tool call + an idle return, annotate `expectAfter` per chunk, add `scenario-3` to the parameter list in `test/detector-replay.test.ts`. Replaces the synthetic `scenario-1` as the load-bearing detector regression net. |
| D9 | Optional escalation copy *count* persistence | §4.4 / §4.11 | §4.11 (`[guard]`) | D1 landing | Currently the interceptor would count in-process; if we want the escalation to span sessions, the count needs persistence. Punted as part of D1's design conversation — the spec calls it "off by default", so persistence isn't required for v1. |

**Pickup ordering when §4.11 lands.** D4 → D5 → D6 are mechanical wiring. D1 is a small design choice (copy + threshold). D9 is only relevant if D1 picks the persistent-count variant. D2 / D7 / D8 unblock independently of §4.11.

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
- [x] Sub-pane host for `carbonyl` when an adapter requests video playback *(landed in §4.9 — `CarbonylSubpane` in `packages/host/src/adapters/carbonyl-subpane.ts` spawns carbonyl via the project `PtyFactory` in a sized PTY child, rewrites absolute-cursor ANSI sequences (CUP / HVP / VPA / bare CUP / CSI 2J) so they offset into a sub-rect, brackets each chunk with `\x1b[s` / `\x1b[u` so the host cursor is preserved, and forwards resize / kill / onExit. `IPane` gained `readonly topRow` so adapters can compute screen-absolute sub-rect coordinates without coupling to `OverlayPane` internals)*
- [x] **Carry-over from 4.4:** replace `NullOverlayController` (in `src/hotkey/overlay-stub.ts`) with the real overlay implementing `IOverlayController` (`isOpen` / `open` / `close`); inject it through `RunWrapperOptions.interceptor` (or extend the default-construction in `wrapper.ts` to wire the real overlay). The hotkey interceptor seam is already in place — the only remaining work in §4.4's column is swapping the stub for the real thing. *(done — `wrapper.ts` default-constructs `LimboOverlay({ stdout, detector, chord? })` and threads it into the `HotkeyInterceptor`. `RunWrapperOptions.overlay` + `onOverlay` give tests the same injection seam the interceptor and detector already have. `IOverlayController` gained `handleInput(chunk)`; `NullOverlayController` is kept as the unit-test stub with a recording buffer)*
- [x] **Carry-over from 4.4:** when the overlay opens via the chord, it must redirect stdin away from the PTY for the duration it is open (input goes to the overlay's TUI, not Claude). Today the wrapper still pipes all non-chord bytes through to Claude unconditionally; §4.5 needs to teach the interceptor (or the wrapper) to route input to the overlay while `overlay.isOpen()` is true. *(done in `wrapper.ts`: after `interceptor.feed`, the wrapper forks on `overlay.isOpen()` — open → `overlay.handleInput(passthrough)`; closed → `pty.write(passthrough)`. Verified by two new tests in `wrapper.test.ts` covering both directions of the toggle, plus a teardown test that the overlay is force-closed if the PTY exits while still open. Known minor edge: bytes batched in the same chunk as the chord toggle all go to the post-toggle target — acceptable for §4.5 since real chord presses arrive solo)*

### 4.6 Adapter layer (Node ↔ Python sidecars) ✓ done
- [x] Define `Adapter` interface: `mount(pane)`, `unmount()`, `handleKey(action)` *(`packages/host/src/adapters/types.ts`. `IPane` exposes `cols`, `rows`, `setLines(readonly string[])`, and `on('resize')`. `AdapterDescriptor` is the registry entry — `{id, extras, enabled, create()}` — and `AdapterLifecycleEvent` enumerates the lifecycle states for the future error/observability path)*
- [x] JSON-RPC over stdio between Node host and Python sidecar processes *(`packages/host/src/adapters/rpc/codec.ts` does encode/decode + `NdjsonDecoder` line buffering with CRLF tolerance and a structural guard requiring `method`/`result`/`error`; `client.ts` is the bidirectional client with promise-correlated numeric ids, fire-and-forget notifications, per-handler throw isolation, and inbound notification dispatch via `on(method, handler)`. Wire format is JSON-RPC 2.0 framed as one envelope per `\n` line. Python side is `packages/sidecars/src/limbo_sidecars/jsonrpc.py` — stdlib only, ~70 lines, mirrors the same protocol byte-for-byte)*
- [x] First-run bootstrap: create venv at `~/.local/share/aether-limbo/venv`, install pinned requirements *(`packages/host/src/adapters/sidecar/venv.ts` — lazy `ensure(extras)`: detects venv via `bin/python` presence, hashes `{pythonVersion, sorted(extras)}` into `.limbo-manifest.json`, short-circuits when the manifest matches, runs `python -m venv` + `pip install -e <pkg>[extras]` otherwise. All filesystem and process operations injected for hermetic unit tests; one opt-in real-python integration test in `test/adapter-roundtrip.test.ts` gated by `LIMBO_RUN_PYTHON_TESTS=1` exercises the production `ChildProcessTransport` against a real `python3 -m limbo_sidecars echo`. Unix-only by design — Windows out of scope per §5)*
- [x] Per-adapter feature flag in config *(today: `AdapterDescriptor.enabled: boolean` filtered by `BuiltinAdapterRegistry.get`. Tab-order + per-adapter `enabled` wiring lands in §4.11 — the seam is already in place)*
- [x] **Demo adapter:** echo sidecar wired into a hidden `__echo` tab gated by `LIMBO_DEBUG_ECHO=1`. Proves the wire format end-to-end: `mount` paints the sidecar's `body/update` notification, `j` (scroll-down) issues `ping` and increments a host-owned `round-trips: N` counter rendered as the final body line, `unmount` kills the sidecar via `SIGTERM`. `EchoAdapter` in `src/adapters/echo-adapter.ts`; Python side in `packages/sidecars/src/limbo_sidecars/echo.py`. The counter lives entirely on the host so it updates on every keypress regardless of when the sidecar last spoke.
- [x] **Lifecycle:** lazy spawn on tab activation; force-unmount on overlay close *(seam in `LimboOverlay.mountActive` / `unmountActive` — adapter teardown failures are swallowed so they cannot block close. `wrapper.ts` constructs the default `BuiltinAdapterRegistry` with `ChildProcessTransport` + `node:child_process.spawn` + `python3 -m limbo_sidecars <name>`. The full host suite stays hermetic — 194 passing + 2 skipped on the default `pnpm test`; the gated run brings the contract tests in for 196 total)*

### 4.7 Instagram adapter (`instagrapi`) ✓ done
- [x] Login flow: username/password with 2FA prompt; persist session JSON *(`packages/sidecars/src/limbo_sidecars/instagram/session.py` — `IGSession` with `Client` injected for tests; load/save via `dump_settings`/`load_settings` to `~/.local/share/aether-limbo/sessions/instagram.json`. `instagrapi.exceptions.TwoFactorRequired` is also injected; on 2FA, sidecar returns `{status:"2fa_required"}` and the host's `LoginForm` adds a code field. Form lives in-overlay via `IAdapter.captureInput?(chunk)` (§4.7 T1) — no separate prompt screen)*
- [x] Reels view → list of media; `Enter` opens carbonyl on the IG web URL *(`InstagramReelsAdapter` + `instagram-reels` sidecar. `Enter` routes through new `KeyAction { kind:"enter" }` (§4.7 T7) → `IAdapter.onEnter?()` → `runDetached({url, overlay, spawn, carbonylBin})` in `packages/host/src/adapters/carbonyl.ts`. `runDetached` closes the overlay, spawns `carbonyl` with `stdio:"inherit"`, re-opens the overlay on exit/error. True sub-pane carbonyl host stays deferred to §4.9, where TikTok's video playback drives the requirement)*
- [x] Feed view → infinite scroll with text + thumbnail (sixel/kitty graphics) *(`InstagramFeedAdapter` + `instagram-feed` sidecar — text-only ships now: each post renders as `@author: caption` with the IG `/p/<code>/` URL passed to `runDetached` on Enter. Sixel/kitty thumbnail rendering is deferred to §4.11: requires terminal-capability detection + image bytes streamed from the sidecar + `IPane.write(bytes)` for raw passthrough — none of which are pulling weight today)*
- [x] DMs → thread list, message view, send-reply input *(`InstagramDmsAdapter` + `instagram-dms` sidecar. Five modes (`loading`/`login`/`threads`/`messages`/`input`); `i` in messages mode flips to input, `Esc` cancels. Reply send uses `direct_send(text, thread_ids=[id])` and refreshes the message list on `{ok:true}`. The new `IAdapter.captureInput?` seam (§4.7 T1) is what lets the input mode steal raw bytes without the keymap interpreting `q` / `h` / `l`)*

### 4.8 X / Twitter adapter (`twikit`, optional `tweepy`) ✓ done
- [x] Auth: `twikit` cookie auth (no API key) by default; `tweepy` path if
      keys are configured *(`packages/sidecars/src/limbo_sidecars/twitter/session.py` — `TwitterSession` mirrors `IGSession` but persists a cookie jar via `save_cookies` / `load_cookies` (twikit), not `dump_settings` / `load_settings` (instagrapi). Sync surface; async work is wrapped via an injected `runner: Callable[[Awaitable[Any]], Any]` defaulting to `asyncio.run`. Tests pass a coroutine driver instead. 2FA detection is heuristic (`verification` / `two-factor` / `totp` substrings on the exception message) since twikit lacks a discrete `TwoFactorRequired` exception. Tweepy path deferred — see §4.8 deferrals below.)*
- [x] Home timeline view; `r` to reply, `l` to like, `Enter` opens thread *(`packages/host/src/adapters/twitter/home-adapter.ts` — single `twitter-home` adapter with modes `loading | login | timeline | reply | dms_threads | dms_messages`; sidecar `packages/sidecars/src/limbo_sidecars/twitter/home.py` exposes `validate`, `login`, `login_2fa`, `timeline/list`, `timeline/like`, `timeline/reply`, `dms/threads`, `dms/messages`. `Enter` reuses the §4.7 `runDetached` carbonyl seam on `https://x.com/<author>/status/<id>`; `r` enters an in-overlay reply input mirroring the IG DMs pattern; `l` fires `timeline/like` and writes a one-line status to the body. The X tab in `DEFAULT_TABS` now carries `adapterId: "twitter-home"`)*
- [x] DMs (paid-tier only — degrade gracefully when unavailable) *(both `dms/threads` and `dms/messages` handlers wrap their twikit call in try/except and return `{available: false, items: [], message: <reason>}` on rejection. The host renders a single-line "DMs require X Premium — unavailable on this account." banner when `available: false`; the timeline view stays reachable via `t`. tweepy auth path and DMs availability caching land in §4.11; twikit method-name verification lands in §4.13.)*

### 4.9 TikTok adapter (`TikTokApi`) ✓ done
- [x] Bootstrap a Playwright browser context once; reuse session *(`packages/sidecars/src/limbo_sidecars/tiktok/session.py` — `TikTokSession` wraps an injected `TikTokApi` and persists `ms_token` to `~/.local/share/aether-limbo/sessions/tiktok.json` at mode 0600 (`os.open` with `O_CREAT | O_TRUNC, 0o600` to keep the perms guarantee on overwrite). `validate()` exercises `create_sessions(ms_tokens=[token], num_sessions=1)` as the smoke check; the wrapper Playwright context is reused for the lifetime of the sidecar process. TikTokApi is never imported at module level so the stdlib-only unit tests stay portable.)*
- [x] For-You feed view; `Enter` plays video in carbonyl sub-pane *(`TikTokForYouAdapter` in `packages/host/src/adapters/tiktok/foryou-adapter.ts` — five modes (`loading | token | feed | comments | playing`). Sidecar `feed/list` calls `api.user.feed()` (personalised) and serialises to `{id, author, caption, url}` with the canonical `https://www.tiktok.com/@<author>/video/<id>` URL. `Enter` mounts a `CarbonylSubpane` covering the bottom 60% of the body region (top 40% reserved for the playback header / `q: stop` cue); `q` while playing kills the sub-pane and returns to feed. The same return path fires automatically when the underlying carbonyl process exits — single source of truth for "playback ended".)*
- [x] Comments view (read-only is fine for v1) *(`c` from feed mode fires `feed/comments({video_id})` and switches to `comments` mode rendering `<from> text` rows. `Esc` returns to feed without an extra RPC. The sidecar's `feed/comments` wraps the iteration in a degrade try/except — on rate-limit / auth failure it returns `{available:false, items:[], message}` and the host renders the `(comments unavailable: …)` banner. Mirrors the §4.8 X-DMs degrade pattern.)*
- [ ] **Deferral — ms_token rotation:** the cookie rotates server-side; on first 401-shaped failure the adapter currently re-renders the token form via the `failed` validate path. Persistent re-auth (refresh the cookie automatically, or surface a recoverable banner over the still-mounted feed) lives at §4.11 alongside the secrets store. Tracked as a new `[adapters.tiktok]` carry-over below.
- [ ] **Deferral — ANSI rewriter coverage:** `CarbonylSubpane.relayChunk` rewrites CUP / HVP / VPA / bare CUP / CSI 2J. Carbonyl might emit other absolute-cursor sequences (DECSCURSCNTR, OSC, scrolling-region settings); the worst-case bleed is one frame painting outside the sub-rect (cursor save/restore still bounds the host's main cursor). Patch on first observed bleed; not blocking on the happy path.
- [ ] **Deferral — TikTokApi method-shape verification:** handler tests use hand-rolled fakes matching v7.1 conventions (`api.user.feed()`, `api.video(id=…).comments()`, `api.create_sessions(ms_tokens=…)`). Real-account verification is queued under §4.13 as a carry-over, mirroring the instagrapi / twikit precedent.

### 4.10 Auto-switch back on response
- [x] State watcher: `streaming|tool_running → idle` AND overlay open
      → fire `snap_back` *(trigger generalised to "any non-idle → idle" — `t.from !== "idle" && t.to === "idle"` — covering `thinking → idle` as well as `streaming|tool_running → idle`. Wired inside the existing `this.deps.detector.on("state", …)` handler in `LimboOverlay.open()` in `packages/host/src/overlay/overlay.ts`. `OverlayDeps.onSnapBack?: () => void` added to `packages/host/src/overlay/types.ts`.)*
- [x] Snap-back: unmount adapter, exit alt-screen, force redraw *(private `snapBack()` in `LimboOverlay` calls `onSnapBack?.()` then `close()` — `close()` already runs `unmountActive()` + writes `\x1b[?25h\x1b[?1049l`. Force redraw implemented as `pty.resize(cols, rows)` SIGWINCH-equivalent in `packages/host/src/wrapper.ts` `onSnapBack` callback; best-effort, relies on Claude TUI repainting on SIGWINCH (it does in current versions). Reentrancy guard `snappingBack_` prevents double-fire; field is reset in `open()`.)*
- [ ] Toast in a non-PTY status region: "✓ response ready"
  - [ ] **Deferral — toast suppressed per user direction at §4.10 implementation:** implementing a status-region toast requires a persistent non-PTY draw surface that survives alt-screen exit; no such surface exists in the current architecture. Deferred until a dedicated status-bar layer is introduced (likely §4.11 or later). The snap-back itself is fully functional without it.
- [x] Acceptance: snap-back happens within 250 ms of state transition *(satisfied trivially — the snap-back path is fully synchronous from the detector `state` event through `onSnapBack` → `pty.resize` and `close()`. No timer, no microtask hop. Total wall time ≪ 1 ms in unit tests.)*

### 4.11 Configuration ✓ done
- [x] `~/.config/aether-limbo/config.toml`:
      `[hotkey]`, `[adapters]`, `[guard]`, `[snapback]` *(schema in `packages/host/src/config/schema.ts`; four top-level sections with typed interfaces `HotkeyConfig`, `GuardConfig`, `SnapbackConfig`, `AdaptersConfig` — the last nesting `[adapters.instagram]`, `[adapters.twitter]`, `[adapters.tiktok]` sub-tables. Path resolution in `packages/host/src/config/paths.ts`: XDG_CONFIG_HOME-aware, defaults to `~/.config/aether-limbo/config.toml`. TOML loaded and deep-merged against defaults in `packages/host/src/config/loader.ts`. Chord values must use `\u00XX` escapes — TOML 1.0 does not accept `\xXX`.)*
- [x] `limbo config edit` → opens in `$EDITOR` *(`packages/host/src/cli/config-edit.ts` — editor resolution chain `$VISUAL → $EDITOR → nano → vi`; if config file is absent, calls `ensureConfig()` first to write defaults before opening. Wired as `limbo config edit` in `packages/host/src/cli/argv.ts`.)*
- [x] First-run wizard if config missing *(`packages/host/src/cli/wizard.ts` — `runWizard({ tty: false })` silent default-write path fires on passthrough when no config exists; `runWizard({ tty: true })` interactive readline prompts fire when invoked via `limbo config edit` against a missing file.)*
  - [ ] **Deferral — interactive wizard at passthrough first-run.** Today: silent default-write on passthrough (`tty: false` path in `packages/host/src/cli/wizard.ts`), interactive prompts only when invoked via `limbo config edit` against missing file. Reason: PTY raw mode immediately follows `runWrapper`; competing readline against raw stdin would deadlock. A future TTY hand-off layer (drain stdin → readline → re-attach raw mode) would unblock this. Tracked here under §4.11.
- [x] **Carry-over from §4.4 — `[hotkey]`:** wire the loaded chord into `RunWrapperOptions.chord` *(loaded chord passed from `packages/host/src/config/loader.ts` through `packages/host/src/wrapper.ts` into `HotkeyInterceptor` / `ChordMatcher`. Chord values in TOML must use `\u00XX` escapes, e.g. `chord = ""` for Ctrl+L, `chord = "[24~"` for F12. Defaults written by `packages/host/src/config/defaults.ts`.)*
- [x] **Carry-over from §4.4 — `[guard]`:** implement the optional escalation copy after N idle attempts *(`packages/host/src/hotkey/interceptor.ts` — `EscalationOptions` struct with `threshold` and `messages`; interceptor counts idle-attempt firings and calls `shame.showShame(escalationMessage)` once threshold is crossed. Off by default (`idleAttemptsBeforeEscalation = 0`). Config field `guard.idle_attempts_before_escalation` / `guard.escalation_messages` mapped in `packages/host/src/config/loader.ts`.)*
- [x] **Carry-over from §4.4 — `[guard]`:** shame banner hold duration and copy plumbed from `[guard]` *(`guard.message` and `guard.holdMs` loaded from config in `packages/host/src/config/loader.ts` and forwarded to `ShameFlash` construction in `packages/host/src/wrapper.ts`.)*
- [x] **Carry-over from §4.4 — `[guard]`:** persistent count across sessions *(in-process count only — escalation is off by default and `guard.idle_attempts_before_escalation = 0` leaves the per-session counter unused. No persistent storage added; spec calls this "not required for v1".)*
- [x] **Carry-over from §4.5 / §4.6 — `[adapters]`:** tab order and per-adapter `enabled` flag driven by `[adapters]` config *(`adapters.tabOrder` and `adapters.enabled` read in `packages/host/src/config/loader.ts`; `packages/host/src/wrapper.ts` maps them to `TabDefinition[]` passed to `LimboOverlay` and to `AdapterDescriptor.enabled` in the registry.)*
- [x] **Carry-over from §4.6 — `[adapters]`:** sidecar process kept warm across overlay close/open *(`AdapterDescriptor.keepWarm` added to `packages/host/src/adapters/types.ts`; `packages/host/src/adapters/registry.ts` retains the adapter instance in a warm cache when `keepWarm: true` instead of calling `unmount()`. Wired from `adapters.keepWarm` / per-adapter `keepWarm` in `packages/host/src/wrapper.ts` via the default registry builder.)*
  - [ ] **Deferral — verify reuse against a real Playwright context.** Today: TikTok descriptor is `keepWarm: true` when `[adapters.tiktok].keep_warm` or `[adapters].keep_warm` is set; the warm cache (`packages/host/src/adapters/registry.ts`) keeps the adapter instance and the underlying child process alive; the underlying `TikTokSession` reuses the Playwright context within that process. Real-account verification queued under §4.13.
- [x] **Carry-over from §4.7 — `[adapters.instagram]`:** chafa thumbnail rendering for the Feed view *(`packages/host/src/adapters/instagram/feed-adapter.ts` requests `feed/thumbnail` per visible row; sidecar handler in `packages/sidecars/src/limbo_sidecars/instagram/bundle.py` fetches `thumbnail_url` via `urllib.request` and shells out to `chafa --format <kitty|sixel|symbols> --align top,left -s <cols>x<rows>`, returning base64-encoded bytes; host's `OverlayPane.writeRaw` paints into a fixed 12-col × 3-row rect with absolute-cursor sequences rewritten via `packages/host/src/terminal/cursor-rewriter.ts`. Terminal capability detected by `packages/host/src/terminal/graphics-cap.ts` (KITTY_WINDOW_ID → kitty, iTerm/WezTerm → sixel, else symbols). Graceful degrade when chafa is not installed — `{ok:false}` response silently skips the thumbnail, text rows still shown.)*
  - [ ] **Deferral — adaptive thumbnail layout.** Today: fixed 12-col × 3-row rect per item; no aspect-ratio honouring beyond chafa's auto-fit; no overlap detection with the text rect. Patch on first observed visual bug; not blocking on the happy path.
- [x] **Carry-over from §4.7 — `[adapters.instagram]`:** Instagram session sharing across `instagram-reels` / `-feed` / `-dms` *(collapsed into one bundle sidecar process in `packages/sidecars/src/limbo_sidecars/instagram/bundle.py`; single `instagrapi.Client` shared across reels, feed, and DMs handlers via module-level session object. `packages/host/src/adapters/instagram/shared-sidecar.ts` routes all three adapter RPC calls through one `SidecarTransport` to the same process.)*
- [x] **Carry-over from §4.7 — config layer:** credentials sourced from `~/.config/aether-limbo/secrets.toml` *(`packages/host/src/config/secrets.ts` — `loadSecrets` / `writeSecrets` with mode 0600 enforcement via `fs.chmod`; `secretsToEnv()` exports as env vars for sidecar processes. Remember-me opt-in flow in `packages/host/src/adapters/instagram/login-form.ts`. Env-var fallbacks: `LIMBO_IG_USERNAME` / `LIMBO_IG_PASSWORD`, `LIMBO_TWITTER_USERNAME` / `LIMBO_TWITTER_PASSWORD`, `TWITTER_BEARER_TOKEN` / `TWITTER_API_KEY` / `TWITTER_API_SECRET` / `TWITTER_ACCESS_TOKEN` / `TWITTER_ACCESS_SECRET`, `LIMBO_TIKTOK_MS_TOKEN`.)*
  - [ ] **Deferral — auto-relogin on cookie expiry for twikit.** Today: `LIMBO_TWITTER_USERNAME` / `LIMBO_TWITTER_PASSWORD` env vars are exported by `secretsToEnv` in `packages/host/src/config/secrets.ts` but `packages/sidecars/src/limbo_sidecars/twitter/session.py` does not yet consume them as an auto-relogin path. Triggered only on a cookie-expiry observation in a real session (verify in §4.13). Patch in the sidecar when first seen.
- [x] **Carry-over from §4.7 — first-run UX:** sidecar progress notifications during venv bootstrap *(`packages/host/src/adapters/bootstrap-panel.ts` — `BootstrapPanel.append(line)` paints progress lines into the overlay pane as `VenvBootstrap` emits them; wired in `packages/host/src/adapters/instagram/reels-adapter.ts` so the user sees `installing instagrapi…` on first Reels open instead of an apparent freeze.)*
- [x] **Carry-over from §4.8 — `[adapters.twitter]`:** `tweepy` (API-key) auth path *(`packages/sidecars/src/limbo_sidecars/twitter/tweepy_session.py` — `TweepySession` implements the `TwitterClientProtocol` interface using `tweepy.Client`; runtime backend selector reads `[adapters.twitter].auth` (or env `TWITTER_BEARER_TOKEN` presence) in `packages/sidecars/src/limbo_sidecars/twitter/home.py`. Handler shape (`timeline/list`, `timeline/like`, `timeline/reply`, `dms/*`) is identical between backends.)*
  - [ ] **Deferral — tweepy DMs availability.** Today: tweepy DM handlers wrap in try/except and degrade with `{available: false}`; v1.1 DM endpoints have known restrictions on the tweepy side that mirror the twikit restriction (paid X tier). Behaviour is identical to twikit in this regard.
- [x] **Carry-over from §4.8 — `[adapters.twitter]`:** cache X DMs availability at the session level *(`packages/sidecars/src/limbo_sidecars/twitter/home.py` — `cache_dms` bool parameter; a module-level `dms_cache` dict stores `{"available": bool | None}` and is checked before each `dms/threads` or `dms/messages` call; re-probed only on session restart. Driven from `adapters.twitter.cache_dms` in config, forwarded via env in `packages/host/src/config/secrets.ts`.)*
- [x] **Carry-over from §4.9 — `[adapters.tiktok]`:** ms_token rotation / `refresh_on_failure` *(sidecar `packages/sidecars/src/limbo_sidecars/tiktok/session.py` — `TikTokSession.store(token)` persists token to disk at mode 0600; `validate()` calls `create_sessions(ms_tokens=[token])` as smoke-check. `refresh_on_failure = true` in `[adapters.tiktok]` causes the sidecar to attempt one transparent `create_sessions` retry before surfacing the token form. Token also stored in `secrets.toml` alongside IG / X creds via `packages/host/src/config/secrets.ts`.)*
- [x] **Carry-over from §4.9 — `[adapters.tiktok]`:** Playwright context warm-keep across sidecar respawn *(`AdapterDescriptor.keepWarm` in `packages/host/src/adapters/types.ts`; registry warm cache in `packages/host/src/adapters/registry.ts` keeps the `TikTokForYouAdapter` instance alive when `[adapters.tiktok].keep_warm` or `[adapters].keep_warm` is set, preserving the underlying sidecar child process and its Playwright context.)*

### 4.12 Distribution & update story
- [ ] Publish `@aether/limbo` on npm with `bin: limbo`
- [ ] **No** dependency on `@anthropic-ai/claude-code` — resolve `claude` at
      runtime so user updates flow through automatically
- [ ] README: "limbo wraps your existing Claude Code install; update Claude
      Code the way you always have"
- [ ] **Carry-over from §4.6 — CI:** Python contract test on CI. `test/adapter-roundtrip.test.ts` is gated by `LIMBO_RUN_PYTHON_TESTS=1`; CI must set this and ensure `python3 ≥ 3.11` is on `PATH`. Add to the §4.1 CI workflow when distribution work picks up the workflow file. The existing pytest suite covers handler shapes without needing instagrapi/twikit installed; full real-library contract tests stay in this gated path.

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
- [ ] **Carry-over from §4.5:** watch for the same-chunk chord-toggle byte-routing edge case during smoke. If `"abc\x0cdef"` (chord bytes batched with adjacent typing) ever routes all bytes to the post-toggle target, the fix is a segmented `IHotkeyInterceptor.feed` return type — `Array<{destination: 'pty' | 'overlay'; bytes: string}>` — touching the chord matcher, the interceptor, and the wrapper. Real raw-mode keystrokes arrive as separate `data` events, so this should not fire in practice; cost > benefit until it does.
- [ ] **Carry-over from §4.7:** verify instagrapi method names against a real Instagram account — `user_clips` (Reels), `user_feed` (Feed), `direct_threads` / `direct_messages` / `direct_send` (DMs). Tasks 5/8/9 in §4.7 used instagrapi 2.x convention names without context7 cross-check (quota was exhausted at implementation time). Handler tests pass with hand-rolled fakes; the real-instagrapi shape may differ. Wrong names surface as empty lists or RPC errors — patch on first divergence.
- [ ] **Carry-over from §4.8:** verify twikit method names against a real X account — `get_home_timeline`, `favorite_tweet`, `create_tweet(reply_to=…)`, `get_dm_threads`, `get_dm_messages`. Same precedent as the instagrapi verification above. The DM handlers also exercise the try-and-degrade path, so wrong DM method names fall into the "DMs unavailable" branch silently — note this when validating.
- [ ] **Carry-over from §4.9:** verify TikTokApi v7.x method shapes against a real account — `api.create_sessions(ms_tokens=[token], num_sessions=1)`, `api.user.feed()` (async iterator → `{id, author.username, desc}` per item), `api.video(id=…).comments()` (async iterator → `{author.username, text}` per comment). Handler tests pass with hand-rolled fakes matching v7.1 conventions; the real-TikTokApi shape may have moved. Wrong method names surface as either an empty `feed/list` response or the comments-degrade banner — patch on first divergence.

---

## 5. Risks

- **ToS.** Instagram, X, TikTok all forbid unofficial clients to varying
  degrees. Ship a clear disclaimer; treat all integrations as best-effort,
  opt-in, and use-at-your-own-risk.
- **Detector drift.** Claude Code render output may change between releases.
  The replay harness in 4.3 is the regression net.
- **Out of scope (v1):** posting/uploading from limbo, cross-device sync,
  telemetry, Windows support (PTY semantics differ — defer).

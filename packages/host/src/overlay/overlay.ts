import { OverlayPane } from "../adapters/pane.js";
import type { IAdapter, IAdapterRegistry } from "../adapters/types.js";
import { DEFAULT_CHORD, type HotkeyChord, type IOverlayController } from "../hotkey/types.js";
import type { IDisposable } from "../pty/types.js";
import { OverlayKeymap } from "./keymap.js";
import { renderStatusLine } from "./status-line.js";
import { renderTabBar } from "./tab-bar.js";
import { DEFAULT_TABS, type KeyAction, type OverlayDeps, type TabDefinition } from "./types.js";

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const HOME = "\x1b[H";
const SGR_RESET = "\x1b[0m";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

interface MountedAdapter {
  readonly adapter: IAdapter;
  readonly pane: OverlayPane;
}

export class LimboOverlay implements IOverlayController {
  private open_ = false;
  private activeIndex = 0;
  private readonly tabs: readonly TabDefinition[];
  private readonly chord: HotkeyChord;
  private readonly registry: IAdapterRegistry | undefined;
  private readonly keymap = new OverlayKeymap();
  private stateSub: IDisposable | undefined;
  private mounted: MountedAdapter | undefined;

  constructor(private readonly deps: OverlayDeps) {
    this.tabs = deps.tabs ?? DEFAULT_TABS;
    this.chord = deps.chord ?? DEFAULT_CHORD;
    this.registry = deps.registry;
  }

  isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.activeIndex = 0;
    this.keymap.reset();
    const { stdout } = this.deps;
    stdout.write(ALT_SCREEN_ENTER);
    stdout.write(HIDE_CURSOR);
    stdout.write(CLEAR_SCREEN);
    stdout.write(HOME);
    this.paint();
    this.stateSub = this.deps.detector.on("state", () => {
      if (this.open_) this.paintStatus();
    });
    void this.mountActive();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.stateSub?.dispose();
    this.stateSub = undefined;
    void this.unmountActive();
    const { stdout } = this.deps;
    stdout.write(SHOW_CURSOR);
    stdout.write(ALT_SCREEN_EXIT);
  }

  handleInput(chunk: string): void {
    if (!this.open_ || chunk.length === 0) return;
    if (this.mounted?.adapter.captureInput?.(chunk) === true) return;
    const actions = this.keymap.feed(chunk);
    if (actions.length === 0) return;
    let needsFullRepaint = false;
    let shouldClose = false;
    let tabChanged = false;
    for (const action of actions) {
      if (this.applyAction(action)) {
        needsFullRepaint = true;
        if (
          action.kind === "tab-prev" ||
          action.kind === "tab-next" ||
          action.kind === "tab-jump"
        ) {
          tabChanged = true;
        }
      } else if (
        action.kind === "scroll-up" ||
        action.kind === "scroll-down" ||
        action.kind === "scroll-top" ||
        action.kind === "scroll-bottom"
      ) {
        this.mounted?.adapter.handleKey(action);
      }
      if (action.kind === "close") {
        shouldClose = true;
        break;
      }
    }
    if (shouldClose) {
      this.close();
      return;
    }
    if (tabChanged) {
      void this.unmountActive().then(() => this.mountActive());
    }
    if (needsFullRepaint) this.paint();
  }

  handleResize(_cols: number, _rows: number): void {
    if (!this.open_) return;
    this.paint();
  }

  private applyAction(action: KeyAction): boolean {
    switch (action.kind) {
      case "tab-prev":
        if (this.tabs.length === 0) return false;
        this.activeIndex = (this.activeIndex - 1 + this.tabs.length) % this.tabs.length;
        return true;
      case "tab-next":
        if (this.tabs.length === 0) return false;
        this.activeIndex = (this.activeIndex + 1) % this.tabs.length;
        return true;
      case "tab-jump":
        if (action.index < 0 || action.index >= this.tabs.length) return false;
        if (this.activeIndex === action.index) return false;
        this.activeIndex = action.index;
        return true;
      case "scroll-up":
      case "scroll-down":
      case "scroll-top":
      case "scroll-bottom":
      case "close":
        return false;
    }
  }

  private paint(): void {
    const { stdout } = this.deps;
    const cols = stdout.columns ?? DEFAULT_COLS;
    const rows = stdout.rows ?? DEFAULT_ROWS;
    stdout.write(HOME);
    stdout.write(CLEAR_SCREEN);
    stdout.write(moveCursor(1, 1));
    stdout.write(renderTabBar({ tabs: this.tabs, activeIndex: this.activeIndex, cols }));
    if (this.mounted === undefined) this.paintBody(cols, rows);
    this.paintStatus();
  }

  private paintBody(cols: number, rows: number): void {
    const { stdout } = this.deps;
    const tab = this.tabs[this.activeIndex];
    const bodyTopRow = 3;
    const bodyBottomRow = Math.max(bodyTopRow, rows - 1);
    for (let r = bodyTopRow; r < bodyBottomRow; r++) {
      stdout.write(moveCursor(r, 1));
      stdout.write(" ".repeat(cols));
    }
    if (tab !== undefined) {
      const lines = [`[ ${tab.label} ]`, "", `adapter not yet implemented (${tab.placeholderRef})`];
      const startRow = Math.max(
        bodyTopRow,
        Math.floor((bodyTopRow + bodyBottomRow - lines.length) / 2),
      );
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const col = Math.max(1, Math.floor((cols - line.length) / 2) + 1);
        stdout.write(moveCursor(startRow + i, col));
        stdout.write(line);
      }
    }
    stdout.write(SGR_RESET);
  }

  private paintStatus(): void {
    const { stdout } = this.deps;
    const cols = stdout.columns ?? DEFAULT_COLS;
    const rows = stdout.rows ?? DEFAULT_ROWS;
    const state = this.deps.detector.getState();
    stdout.write(moveCursor(rows, 1));
    stdout.write(renderStatusLine({ state, chord: this.chord, cols }));
  }

  private async mountActive(): Promise<void> {
    if (this.mounted !== undefined) return;
    if (!this.registry) return;
    const tab = this.tabs[this.activeIndex];
    if (!tab?.adapterId) return;
    const adapter = this.registry.get(tab.adapterId);
    if (!adapter) return;
    const rows = this.deps.stdout.rows ?? DEFAULT_ROWS;
    const pane = new OverlayPane({
      stdout: this.deps.stdout,
      topRow: 3,
      bottomRow: Math.max(3, rows - 1),
    });
    this.mounted = { adapter, pane };
    try {
      await adapter.mount(pane);
    } catch {
      this.mounted = undefined;
      return;
    }
    // If close() ran while we were awaiting mount, the overlay is no longer
    // visible — tear the adapter back down so the child process is not orphaned.
    if (!this.open_) {
      const m = this.mounted;
      this.mounted = undefined;
      try {
        await m?.adapter.unmount();
      } catch {
        // teardown failures during close-race recovery must not throw
      }
    }
  }

  private async unmountActive(): Promise<void> {
    const m = this.mounted;
    if (!m) return;
    this.mounted = undefined;
    try {
      await m.adapter.unmount();
    } catch {
      // adapter teardown failures must not block the overlay lifecycle
    }
  }
}

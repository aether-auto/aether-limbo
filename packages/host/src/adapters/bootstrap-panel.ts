import type { IPane } from "./types.js";

// ---------------------------------------------------------------------------
// BootstrapPanel
//
// Pure UI helper that renders venv-bootstrap progress lines into an IPane.
// Keeps the last MAX_LINES visible so the pane never overflows with pip output.
// The adapter holds a reference and calls start/update/error; this class is
// stateless from the adapter's perspective — create one per mount() call.
// ---------------------------------------------------------------------------

const MAX_VISIBLE_LINES = 5;
const HEADER = "[ Bootstrapping ]";

export class BootstrapPanel {
  private lines: string[] = [];
  private pane: IPane | undefined;

  /** Attach to a pane. Must be called before start/update/error. */
  attach(pane: IPane): void {
    this.pane = pane;
    this.lines = [];
  }

  /** Clear pane and paint the bootstrap header plus the first message. */
  start(message: string): void {
    this.lines = [message];
    this.flush();
  }

  /**
   * Append a progress line. When the visible window is full the oldest line
   * scrolls out so the pane never grows past MAX_VISIBLE_LINES + header + footer.
   */
  update(message: string): void {
    this.lines.push(message);
    if (this.lines.length > MAX_VISIBLE_LINES) {
      this.lines = this.lines.slice(this.lines.length - MAX_VISIBLE_LINES);
    }
    this.flush();
  }

  /** Paint the pane with an error state. The adapter should NOT proceed to RPC mount. */
  error(message: string): void {
    this.lines.push(`error: ${message}`);
    if (this.lines.length > MAX_VISIBLE_LINES) {
      this.lines = this.lines.slice(this.lines.length - MAX_VISIBLE_LINES);
    }
    this.flushError();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private flush(): void {
    if (!this.pane) return;
    this.pane.setLines([HEADER, "", ...this.lines, "", "preparing… q/h/l: navigate away"]);
  }

  private flushError(): void {
    if (!this.pane) return;
    this.pane.setLines([HEADER, "", ...this.lines, "", "bootstrap failed   q/h/l: navigate away"]);
  }
}

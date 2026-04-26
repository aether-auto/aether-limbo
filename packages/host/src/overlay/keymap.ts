import type { KeyAction } from "./types.js";

export class OverlayKeymap {
  private pendingG = false;

  feed(chunk: string): KeyAction[] {
    const actions: KeyAction[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === undefined) continue;
      if (this.pendingG) {
        this.pendingG = false;
        if (ch === "g") {
          actions.push({ kind: "scroll-top" });
          continue;
        }
        // pending g + non-g: drop the buffered g (vim does the same)
      }
      switch (ch) {
        case "q":
          actions.push({ kind: "close" });
          break;
        case "h":
          actions.push({ kind: "tab-prev" });
          break;
        case "l":
          actions.push({ kind: "tab-next" });
          break;
        case "j":
          actions.push({ kind: "scroll-down" });
          break;
        case "k":
          actions.push({ kind: "scroll-up" });
          break;
        case "g":
          this.pendingG = true;
          break;
        case "G":
          actions.push({ kind: "scroll-bottom" });
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          actions.push({ kind: "tab-jump", index: Number(ch) - 1 });
          break;
        default:
          // Unmapped keys are deliberately silent — overlay ignores noise.
          break;
      }
    }
    return actions;
  }

  reset(): void {
    this.pendingG = false;
  }
}

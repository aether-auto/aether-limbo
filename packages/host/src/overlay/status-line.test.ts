import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { describeChord, renderStatusLine } from "./status-line.js";

describe("describeChord", () => {
  it("names ASCII control codes by their human label", () => {
    expect(describeChord("\x0c")).toBe("Ctrl+L");
    expect(describeChord("\x1b")).toBe("Esc");
    expect(describeChord("\x09")).toBe("Tab");
  });

  it("falls back to hex for unprintable multi-byte chords", () => {
    expect(describeChord("\x1b[24~")).toContain("\\x1b");
  });
});

describe("renderStatusLine", () => {
  it("renders state on the left and chord hint on the right with a gap", () => {
    const out = renderStatusLine({ state: "streaming", chord: "\x0c", cols: 60 });
    const visible = stripAnsi(out);
    expect(visible.length).toBe(60);
    expect(visible).toMatch(/^state: streaming\s+press Ctrl\+L to return$/);
  });

  it("degrades gracefully when the column count is too small for both halves", () => {
    const out = renderStatusLine({ state: "thinking", chord: "\x0c", cols: 8 });
    const visible = stripAnsi(out);
    expect(visible.length).toBe(8);
  });
});

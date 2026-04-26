import { describe, expect, it, vi } from "vitest";
import { OverlayPane } from "./pane.js";

interface FakeStdout {
  columns: number;
  rows: number;
  buffer: string[];
  write(c: string): boolean;
}
function makeStdout(cols = 80, rows = 24): FakeStdout {
  const buffer: string[] = [];
  return {
    columns: cols,
    rows,
    buffer,
    write(c) {
      buffer.push(c);
      return true;
    },
  };
}

describe("OverlayPane", () => {
  it("reports cols and rows from the body rect", () => {
    const stdout = makeStdout(100, 30);
    const pane = new OverlayPane({ stdout, topRow: 3, bottomRow: 28 });
    expect(pane.cols).toBe(100);
    expect(pane.rows).toBe(25);
  });

  it("setLines paints each line at consecutive rows starting at topRow", () => {
    const stdout = makeStdout(20, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 9 });
    pane.setLines(["alpha", "beta"]);
    const out = stdout.buffer.join("");
    expect(out).toContain("\x1b[2;1H");
    expect(out).toContain("alpha");
    expect(out).toContain("\x1b[3;1H");
    expect(out).toContain("beta");
  });

  it("setLines clears rows beyond the supplied lines", () => {
    const stdout = makeStdout(10, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    pane.setLines(["x"]);
    const out = stdout.buffer.join("");
    expect(out).toContain("\x1b[3;1H");
    expect(out).toContain(" ".repeat(10));
  });

  it("setLines truncates lines longer than cols", () => {
    const stdout = makeStdout(5, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    pane.setLines(["abcdefgh"]);
    const out = stdout.buffer.join("");
    expect(out).toContain("abcde");
    expect(out).not.toContain("abcdefgh");
  });

  it("on('resize') fires when handleResize is called", () => {
    const stdout = makeStdout(10, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    const cb = vi.fn();
    pane.on("resize", cb);
    pane.handleResize(20, 30, { topRow: 2, bottomRow: 25 });
    expect(cb).toHaveBeenCalledWith(20, 23);
  });

  it("on('resize') returns a disposable that detaches the listener", () => {
    const stdout = makeStdout(10, 10);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 5 });
    const cb = vi.fn();
    const sub = pane.on("resize", cb);
    sub.dispose();
    pane.handleResize(20, 30, { topRow: 2, bottomRow: 25 });
    expect(cb).not.toHaveBeenCalled();
  });
});

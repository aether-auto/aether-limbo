import { describe, expect, it, vi } from "vitest";
import { OverlayPane } from "./pane.js";
import type { ThumbnailRect } from "./types.js";

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

// ---------------------------------------------------------------------------
// OverlayPane.writeRaw
// ---------------------------------------------------------------------------

describe("OverlayPane.writeRaw", () => {
  function enc(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  it("wraps output in cursor-save and cursor-restore", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 1, bottomRow: 20 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 1, rows: 3, cols: 12 };
    pane.writeRaw(enc("hello"), rect);
    const out = stdout.buffer.join("");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/^\x1b\[s/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/\x1b\[u$/);
  });

  it("rewrites CUP (1;1) to absolute screen position matching topRow+rect", () => {
    const stdout = makeStdout(80, 24);
    // pane starts at screen row 5
    const pane = new OverlayPane({ stdout, topRow: 5, bottomRow: 20 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 1, rows: 3, cols: 12 };
    // chafa-like: moves to (1,1) then writes text
    pane.writeRaw(enc("\x1b[1;1Hhi"), rect);
    const out = stdout.buffer.join("");
    // logical (1,1) → screen (5,1) because pane.topRow_=5, rect.topRow=1, absTop = 5+1-1=5
    expect(out).toContain("\x1b[5;1H");
    expect(out).toContain("hi");
  });

  it("rewrites CUP with pane offset applied — rect.topRow=2 shifts down by 1", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 3, bottomRow: 20 });
    const rect: ThumbnailRect = { topRow: 2, leftCol: 5, rows: 3, cols: 10 };
    pane.writeRaw(enc("\x1b[1;1Hx"), rect);
    const out = stdout.buffer.join("");
    // absTop = 3 + 2 - 1 = 4; absLeft = 5
    expect(out).toContain("\x1b[4;5H");
  });

  it("prepends initial position when input has no absolute CUP", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 20 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 3, rows: 3, cols: 10 };
    pane.writeRaw(enc("plain text"), rect);
    const out = stdout.buffer.join("");
    // Should prepend \x1b[s\x1b[<absTop>;<absLeft>H
    // absTop = 2+1-1=2, absLeft=3
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape boundary
    expect(out).toMatch(/\x1b\[s\x1b\[2;3H/);
  });

  it("silently drops rect when topRow is out of bounds (> pane rows)", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 1, bottomRow: 4 }); // 3 rows
    const rect: ThumbnailRect = { topRow: 10, leftCol: 1, rows: 3, cols: 12 };
    pane.writeRaw(enc("\x1b[1;1Hx"), rect);
    // Nothing should be written
    expect(stdout.buffer).toHaveLength(0);
  });

  it("silently drops rect when leftCol is out of bounds (> pane cols)", () => {
    const stdout = makeStdout(20, 24);
    const pane = new OverlayPane({ stdout, topRow: 1, bottomRow: 10 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 100, rows: 3, cols: 12 };
    pane.writeRaw(enc("x"), rect);
    expect(stdout.buffer).toHaveLength(0);
  });

  it("silently drops rect when rows <= 0", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 1, bottomRow: 10 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 1, rows: 0, cols: 12 };
    pane.writeRaw(enc("x"), rect);
    expect(stdout.buffer).toHaveLength(0);
  });

  it("silently drops rect when cols <= 0", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 1, bottomRow: 10 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 1, rows: 3, cols: 0 };
    pane.writeRaw(enc("x"), rect);
    expect(stdout.buffer).toHaveLength(0);
  });

  it("rewrites CSI 2J to blank rows within the rect", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 1, bottomRow: 10 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 1, rows: 2, cols: 5 };
    pane.writeRaw(enc("\x1b[2J"), rect);
    const out = stdout.buffer.join("");
    expect(out).not.toContain("\x1b[2J");
    expect(out).toContain(`\x1b[1;1H${" ".repeat(5)}`);
    expect(out).toContain(`\x1b[2;1H${" ".repeat(5)}`);
  });

  it("rewrites bare CSI H to absolute origin of rect", () => {
    const stdout = makeStdout(80, 24);
    const pane = new OverlayPane({ stdout, topRow: 2, bottomRow: 10 });
    const rect: ThumbnailRect = { topRow: 1, leftCol: 4, rows: 3, cols: 10 };
    pane.writeRaw(enc("\x1b[H"), rect);
    const out = stdout.buffer.join("");
    // absTop=2, absLeft=4
    expect(out).toContain("\x1b[2;4H");
  });
});

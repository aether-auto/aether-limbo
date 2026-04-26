import { describe, expect, it } from "vitest";
import { ChordMatcher } from "./chord-matcher.js";

describe("ChordMatcher (single-byte chord)", () => {
  it("matches the chord at the start of a chunk and consumes it", () => {
    const m = new ChordMatcher("\x0c");
    expect(m.feed("\x0c")).toEqual({ passthrough: "", matched: 1 });
  });

  it("passes through bytes that are not the chord", () => {
    const m = new ChordMatcher("\x0c");
    expect(m.feed("abc")).toEqual({ passthrough: "abc", matched: 0 });
  });

  it("plucks the chord byte out of the middle of a chunk", () => {
    const m = new ChordMatcher("\x0c");
    expect(m.feed("ab\x0ccd")).toEqual({ passthrough: "abcd", matched: 1 });
  });

  it("counts repeated presses inside a single chunk", () => {
    const m = new ChordMatcher("\x0c");
    expect(m.feed("\x0c\x0c")).toEqual({ passthrough: "", matched: 2 });
  });

  it("returns no match for an empty chunk", () => {
    const m = new ChordMatcher("\x0c");
    expect(m.feed("")).toEqual({ passthrough: "", matched: 0 });
  });
});

describe("ChordMatcher (multi-byte chord, F12 = ESC [ 2 4 ~)", () => {
  const F12 = "\x1b[24~";

  it("matches the chord when fully contained in a single chunk", () => {
    const m = new ChordMatcher(F12);
    expect(m.feed(`hi${F12}there`)).toEqual({ passthrough: "hithere", matched: 1 });
  });

  it("buffers a partial prefix across chunks and matches when completed", () => {
    const m = new ChordMatcher(F12);
    expect(m.feed("\x1b[24")).toEqual({ passthrough: "", matched: 0 });
    expect(m.feed("~done")).toEqual({ passthrough: "done", matched: 1 });
  });

  it("flushes a false prefix as passthrough when the next byte breaks the chord", () => {
    const m = new ChordMatcher(F12);
    expect(m.feed("\x1b[24x")).toEqual({ passthrough: "\x1b[24x", matched: 0 });
  });

  it("recovers from an embedded false prefix and matches a later chord", () => {
    const m = new ChordMatcher(F12);
    expect(m.feed(`\x1b[2${F12}`)).toEqual({ passthrough: "\x1b[2", matched: 1 });
  });

  it("holds a single ESC across feeds without forwarding it", () => {
    const m = new ChordMatcher(F12);
    expect(m.feed("\x1b")).toEqual({ passthrough: "", matched: 0 });
    expect(m.feed("[24~")).toEqual({ passthrough: "", matched: 1 });
  });
});

describe("ChordMatcher housekeeping", () => {
  it("flush() returns and clears any held prefix", () => {
    const m = new ChordMatcher("\x1b[24~");
    m.feed("\x1b[2");
    expect(m.flush()).toBe("\x1b[2");
    expect(m.flush()).toBe("");
  });

  it("reset() drops the held prefix without returning it", () => {
    const m = new ChordMatcher("\x1b[24~");
    m.feed("\x1b[2");
    m.reset();
    expect(m.flush()).toBe("");
  });

  it("rejects an empty chord at construction", () => {
    expect(() => new ChordMatcher("")).toThrow(/non-empty/);
  });
});

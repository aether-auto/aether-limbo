import { describe, expect, it } from "vitest";
import { OverlayKeymap } from "./keymap.js";

describe("OverlayKeymap", () => {
  it("maps single vim keys to nav actions", () => {
    const km = new OverlayKeymap();
    expect(km.feed("h")).toEqual([{ kind: "tab-prev" }]);
    expect(km.feed("l")).toEqual([{ kind: "tab-next" }]);
    expect(km.feed("j")).toEqual([{ kind: "scroll-down" }]);
    expect(km.feed("k")).toEqual([{ kind: "scroll-up" }]);
    expect(km.feed("G")).toEqual([{ kind: "scroll-bottom" }]);
    expect(km.feed("q")).toEqual([{ kind: "close" }]);
  });

  it("requires gg for scroll-top — a lone g is a partial sequence", () => {
    const km = new OverlayKeymap();
    expect(km.feed("g")).toEqual([]);
    expect(km.feed("g")).toEqual([{ kind: "scroll-top" }]);
  });

  it("composes multiple keys in a single chunk", () => {
    const km = new OverlayKeymap();
    expect(km.feed("hhh")).toEqual([
      { kind: "tab-prev" },
      { kind: "tab-prev" },
      { kind: "tab-prev" },
    ]);
  });

  it("g followed by a non-g drops the buffered g (vim parity)", () => {
    const km = new OverlayKeymap();
    expect(km.feed("g")).toEqual([]);
    expect(km.feed("l")).toEqual([{ kind: "tab-next" }]);
    expect(km.feed("g")).toEqual([]);
    expect(km.feed("g")).toEqual([{ kind: "scroll-top" }]);
  });

  it("maps 1..5 to zero-indexed tab jumps and ignores 0/6+", () => {
    const km = new OverlayKeymap();
    expect(km.feed("1")).toEqual([{ kind: "tab-jump", index: 0 }]);
    expect(km.feed("5")).toEqual([{ kind: "tab-jump", index: 4 }]);
    expect(km.feed("0")).toEqual([]);
    expect(km.feed("6")).toEqual([]);
    expect(km.feed("9")).toEqual([]);
  });

  it("silently drops unmapped keys", () => {
    const km = new OverlayKeymap();
    expect(km.feed("xyz!?")).toEqual([]);
  });

  it("emits {kind:'enter'} on \\r", () => {
    const k = new OverlayKeymap();
    expect(k.feed("\r")).toEqual([{ kind: "enter" }]);
  });

  it("emits {kind:'enter'} on \\n", () => {
    const k = new OverlayKeymap();
    expect(k.feed("\n")).toEqual([{ kind: "enter" }]);
  });

  it("multiple enters in one chunk emit multiple enter actions", () => {
    const k = new OverlayKeymap();
    expect(k.feed("\r\n\r")).toEqual([{ kind: "enter" }, { kind: "enter" }, { kind: "enter" }]);
  });

  it("reset() clears the pending-g buffer", () => {
    const km = new OverlayKeymap();
    km.feed("g");
    km.reset();
    expect(km.feed("g")).toEqual([]);
  });
});

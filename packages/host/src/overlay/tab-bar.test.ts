import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { renderTabBar } from "./tab-bar.js";
import { DEFAULT_TABS } from "./types.js";

describe("renderTabBar", () => {
  it("highlights only the active tab via SGR invert", () => {
    const out = renderTabBar({ tabs: DEFAULT_TABS, activeIndex: 1, cols: 80 });
    const invertCount = out.split("\x1b[7m").length - 1;
    expect(invertCount).toBe(1);
    expect(out).toContain("\x1b[7m Feed \x1b[0m");
    expect(out).toContain(" Reels ");
    expect(out).not.toContain("\x1b[7m Reels ");
  });

  it("pads to the full column width so the bar covers row 1 completely", () => {
    const cols = 100;
    const out = renderTabBar({ tabs: DEFAULT_TABS, activeIndex: 0, cols });
    expect(stripAnsi(out).length).toBe(cols);
  });

  it("never emits invert when activeIndex is out of bounds", () => {
    const out = renderTabBar({ tabs: DEFAULT_TABS, activeIndex: 99, cols: 80 });
    expect(out.includes("\x1b[7m")).toBe(false);
  });
});

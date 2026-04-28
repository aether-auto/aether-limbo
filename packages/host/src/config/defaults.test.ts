import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";

describe("DEFAULT_CONFIG", () => {
  it("has the correct shape with all required sections", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      hotkey: expect.objectContaining({ chord: expect.any(String) }),
      guard: expect.objectContaining({
        message: expect.any(String),
        holdMs: expect.any(Number),
        idleAttemptsBeforeEscalation: expect.any(Number),
        escalationMessages: expect.any(Array),
      }),
      snapback: expect.objectContaining({ enabled: expect.any(Boolean) }),
      adapters: expect.objectContaining({
        tabOrder: expect.any(Array),
        enabled: expect.any(Object),
        keepWarm: expect.any(Boolean),
        instagram: expect.any(Object),
        twitter: expect.any(Object),
        tiktok: expect.any(Object),
      }),
    });
  });

  it("chord is exactly \\x0c (Ctrl+L) and is 1 byte long", () => {
    expect(DEFAULT_CONFIG.hotkey.chord).toBe("\x0c");
    expect(DEFAULT_CONFIG.hotkey.chord.length).toBe(1);
    expect(DEFAULT_CONFIG.hotkey.chord.charCodeAt(0)).toBe(0x0c);
  });

  it("guard defaults match SHAME_MESSAGE and SHAME_HOLD_MS", () => {
    expect(DEFAULT_CONFIG.guard.message).toBe("be productive, dumbass.");
    expect(DEFAULT_CONFIG.guard.holdMs).toBe(1200);
    expect(DEFAULT_CONFIG.guard.idleAttemptsBeforeEscalation).toBe(0);
    expect(DEFAULT_CONFIG.guard.escalationMessages).toEqual([]);
  });

  it("snapback is enabled by default", () => {
    expect(DEFAULT_CONFIG.snapback.enabled).toBe(true);
  });

  it("tabOrder matches DEFAULT_TABS order", () => {
    expect(DEFAULT_CONFIG.adapters.tabOrder).toEqual(["reels", "feed", "dms", "x", "tiktok"]);
  });

  it("all standard tabs are enabled by default", () => {
    const { enabled } = DEFAULT_CONFIG.adapters;
    expect(enabled.reels).toBe(true);
    expect(enabled.feed).toBe(true);
    expect(enabled.dms).toBe(true);
    expect(enabled.x).toBe(true);
    expect(enabled.tiktok).toBe(true);
  });

  it("keepWarm is false by default", () => {
    expect(DEFAULT_CONFIG.adapters.keepWarm).toBe(false);
  });

  it("instagram defaults are correct", () => {
    expect(DEFAULT_CONFIG.adapters.instagram).toEqual({
      thumbnails: true,
      thumbnailMaxRows: 6,
    });
  });

  it("twitter defaults are correct", () => {
    expect(DEFAULT_CONFIG.adapters.twitter).toEqual({
      auth: "twikit",
      cacheDms: false,
      language: "en-US",
    });
  });

  it("tiktok defaults are correct", () => {
    expect(DEFAULT_CONFIG.adapters.tiktok).toEqual({
      refreshOnFailure: false,
      keepWarm: false,
    });
  });
});

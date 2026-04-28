import { describe, expect, it } from "vitest";
import { detectGraphicsProtocol, thumbnailMaxRows, thumbnailsDisabled } from "./graphics-cap.js";

// ---------------------------------------------------------------------------
// detectGraphicsProtocol
// ---------------------------------------------------------------------------

describe("detectGraphicsProtocol", () => {
  it("returns 'kitty' when KITTY_WINDOW_ID is set", () => {
    expect(detectGraphicsProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
  });

  it("returns 'kitty' when TERM=xterm-kitty", () => {
    expect(detectGraphicsProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
  });

  it("returns 'kitty' when TERM=kitty", () => {
    expect(detectGraphicsProtocol({ TERM: "kitty" })).toBe("kitty");
  });

  it("returns 'sixel' when TERM_PROGRAM=iTerm.app", () => {
    expect(detectGraphicsProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("sixel");
  });

  it("returns 'sixel' when TERM_PROGRAM=WezTerm", () => {
    expect(detectGraphicsProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("sixel");
  });

  it("returns 'symbols' when TERM=xterm-256color", () => {
    expect(detectGraphicsProtocol({ TERM: "xterm-256color" })).toBe("symbols");
  });

  it("returns 'symbols' when TERM=screen-256color", () => {
    expect(detectGraphicsProtocol({ TERM: "screen-256color" })).toBe("symbols");
  });

  it("returns 'symbols' when TERM=tmux-256color", () => {
    expect(detectGraphicsProtocol({ TERM: "tmux-256color" })).toBe("symbols");
  });

  it("returns 'symbols' for unknown terminal", () => {
    expect(detectGraphicsProtocol({})).toBe("symbols");
  });

  it("LIMBO_GRAPHICS_PROTOCOL=kitty overrides everything", () => {
    expect(
      detectGraphicsProtocol({ LIMBO_GRAPHICS_PROTOCOL: "kitty", TERM: "xterm-256color" }),
    ).toBe("kitty");
  });

  it("LIMBO_GRAPHICS_PROTOCOL=sixel overrides everything", () => {
    expect(detectGraphicsProtocol({ LIMBO_GRAPHICS_PROTOCOL: "sixel", KITTY_WINDOW_ID: "1" })).toBe(
      "sixel",
    );
  });

  it("LIMBO_GRAPHICS_PROTOCOL=symbols returns symbols", () => {
    expect(detectGraphicsProtocol({ LIMBO_GRAPHICS_PROTOCOL: "symbols" })).toBe("symbols");
  });

  it("LIMBO_GRAPHICS_PROTOCOL=none returns symbols (caller gates on 'none' separately)", () => {
    expect(detectGraphicsProtocol({ LIMBO_GRAPHICS_PROTOCOL: "none" })).toBe("symbols");
  });

  it("KITTY_WINDOW_ID takes priority over TERM_PROGRAM=iTerm.app", () => {
    expect(detectGraphicsProtocol({ KITTY_WINDOW_ID: "2", TERM_PROGRAM: "iTerm.app" })).toBe(
      "kitty",
    );
  });
});

// ---------------------------------------------------------------------------
// thumbnailsDisabled
// ---------------------------------------------------------------------------

describe("thumbnailsDisabled", () => {
  it("returns false when no special env vars are set", () => {
    expect(thumbnailsDisabled({})).toBe(false);
  });

  it("returns true when LIMBO_GRAPHICS_PROTOCOL=none", () => {
    expect(thumbnailsDisabled({ LIMBO_GRAPHICS_PROTOCOL: "none" })).toBe(true);
  });

  it("returns true when LIMBO_IG_THUMBNAILS=0", () => {
    expect(thumbnailsDisabled({ LIMBO_IG_THUMBNAILS: "0" })).toBe(true);
  });

  it("returns false when LIMBO_IG_THUMBNAILS=1", () => {
    expect(thumbnailsDisabled({ LIMBO_IG_THUMBNAILS: "1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// thumbnailMaxRows
// ---------------------------------------------------------------------------

describe("thumbnailMaxRows", () => {
  it("defaults to 6 when nothing is set", () => {
    expect(thumbnailMaxRows({})).toBe(6);
  });

  it("returns 0 when thumbnails are disabled via LIMBO_IG_THUMBNAILS=0", () => {
    expect(thumbnailMaxRows({ LIMBO_IG_THUMBNAILS: "0" })).toBe(0);
  });

  it("returns 0 when LIMBO_GRAPHICS_PROTOCOL=none", () => {
    expect(thumbnailMaxRows({ LIMBO_GRAPHICS_PROTOCOL: "none" })).toBe(0);
  });

  it("parses LIMBO_IG_THUMBNAIL_MAX_ROWS correctly", () => {
    expect(thumbnailMaxRows({ LIMBO_IG_THUMBNAIL_MAX_ROWS: "10" })).toBe(10);
  });

  it("returns 6 for invalid LIMBO_IG_THUMBNAIL_MAX_ROWS value", () => {
    expect(thumbnailMaxRows({ LIMBO_IG_THUMBNAIL_MAX_ROWS: "abc" })).toBe(6);
  });

  it("returns 0 when LIMBO_IG_THUMBNAIL_MAX_ROWS=0", () => {
    expect(thumbnailMaxRows({ LIMBO_IG_THUMBNAIL_MAX_ROWS: "0" })).toBe(0);
  });
});

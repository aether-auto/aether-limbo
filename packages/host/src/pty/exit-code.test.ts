import { describe, expect, it } from "vitest";
import { translateExit } from "./exit-code.js";

describe("translateExit", () => {
  it("returns the exitCode unchanged when the child exited normally", () => {
    expect(translateExit({ exitCode: 0 })).toBe(0);
    expect(translateExit({ exitCode: 1 })).toBe(1);
    expect(translateExit({ exitCode: 42 })).toBe(42);
  });

  it("returns 128 + signum when the child died by signal", () => {
    expect(translateExit({ exitCode: 0, signal: 2 })).toBe(130);
    expect(translateExit({ exitCode: 0, signal: 15 })).toBe(143);
    expect(translateExit({ exitCode: 0, signal: 1 })).toBe(129);
  });

  it("prefers signal over exitCode when both are present", () => {
    expect(translateExit({ exitCode: 1, signal: 2 })).toBe(130);
  });

  it("clamps to 255 on absurd signum values", () => {
    expect(translateExit({ exitCode: 0, signal: 200 })).toBe(255);
  });

  it("falls back to exitCode when signal is 0", () => {
    expect(translateExit({ exitCode: 7, signal: 0 })).toBe(7);
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeStateDetector } from "../src/detector/detector.js";
import type { ClaudeState, Clock } from "../src/detector/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface FixtureChunk {
  atMs: number;
  text: string;
  expectAfter?: ClaudeState;
}

interface Fixture {
  name: string;
  debounceMs: number;
  initialState: ClaudeState;
  chunks: FixtureChunk[];
  settleAfterMs: number;
  finalState: ClaudeState;
}

class FakeClock implements Clock {
  current = 0;
  private nextHandle = 1;
  private timers = new Map<NodeJS.Timeout, { fireAt: number; fn: () => void }>();
  now(): number {
    return this.current;
  }
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout {
    const handle = this.nextHandle++ as unknown as NodeJS.Timeout;
    this.timers.set(handle, { fireAt: this.current + ms, fn });
    return handle;
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.timers.delete(handle);
  }
  advanceTo(absMs: number): void {
    while (true) {
      let nextFire: number | undefined;
      for (const t of this.timers.values()) {
        if (t.fireAt > this.current && t.fireAt <= absMs) {
          nextFire = nextFire === undefined ? t.fireAt : Math.min(nextFire, t.fireAt);
        }
      }
      if (nextFire === undefined) break;
      this.current = nextFire;
      for (const [h, t] of [...this.timers]) {
        if (t.fireAt === nextFire) {
          this.timers.delete(h);
          t.fn();
        }
      }
    }
    this.current = absMs;
  }
}

function loadFixture(name: string): { fixture: Fixture; concatenated: Buffer } {
  const json = JSON.parse(
    readFileSync(resolve(HERE, "fixtures", "detector", `${name}.json`), "utf8"),
  ) as Fixture;
  const bin = readFileSync(resolve(HERE, "fixtures", "detector", `${name}.bin`));
  return { fixture: json, concatenated: bin };
}

const SCENARIOS = ["scenario-1", "scenario-2"] as const;

describe("detector replay", () => {
  it.each(SCENARIOS)("%s .bin matches the concatenation of .json chunks", (name) => {
    const { fixture, concatenated } = loadFixture(name);
    const expected = Buffer.from(fixture.chunks.map((c) => c.text).join(""), "utf8");
    expect(concatenated.equals(expected)).toBe(true);
  });

  it.each(SCENARIOS)("%s produces the expected state at each timeline checkpoint", (name) => {
    const { fixture } = loadFixture(name);
    const clock = new FakeClock();
    const detector = new ClaudeStateDetector({ clock, debounceMs: fixture.debounceMs });
    expect(detector.getState()).toBe(fixture.initialState);

    for (const c of fixture.chunks) {
      clock.advanceTo(c.atMs);
      detector.feed(c.text);
      if (c.expectAfter !== undefined) {
        expect(detector.getState(), `${name} after chunk @${c.atMs}ms`).toBe(c.expectAfter);
      }
    }
    const lastAt = fixture.chunks[fixture.chunks.length - 1]?.atMs ?? 0;
    clock.advanceTo(lastAt + fixture.settleAfterMs);
    expect(detector.getState(), `${name} final state after settle`).toBe(fixture.finalState);
    detector.dispose();
  });
});

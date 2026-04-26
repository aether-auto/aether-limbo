import { describe, expect, it } from "vitest";
import type { Clock } from "../detector/types.js";
import { ShameFlash } from "./shame-flash.js";
import { SHAME_MESSAGE, type StdoutView } from "./types.js";

interface FakeStdout extends StdoutView {
  readonly written: string[];
  joined(): string;
}

function makeStdout(cols = 80, rows = 24): FakeStdout {
  const written: string[] = [];
  return {
    columns: cols,
    rows,
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
    written,
    joined() {
      return written.join("");
    },
  };
}

interface FakeClock extends Clock {
  fire(): void;
  scheduled(): number;
}

function makeClock(): FakeClock {
  let pending: (() => void) | undefined;
  let scheduledMs: number | undefined;
  return {
    now: () => 0,
    setTimeout: (fn, ms): NodeJS.Timeout => {
      pending = fn;
      scheduledMs = ms;
      return 0 as unknown as NodeJS.Timeout;
    },
    clearTimeout: () => {
      pending = undefined;
      scheduledMs = undefined;
    },
    fire(): void {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    scheduled(): number {
      return scheduledMs ?? -1;
    },
  };
}

describe("ShameFlash", () => {
  it("enters alt-screen, paints the centred message, then exits alt-screen after the hold", async () => {
    const stdout = makeStdout(80, 24);
    const clock = makeClock();
    const flash = new ShameFlash({ stdout, clock });
    const done = flash.showShame();

    const beforeFire = stdout.joined();
    expect(beforeFire).toContain("\x1b[?1049h");
    expect(beforeFire).toContain("\x1b[?25l");
    expect(beforeFire).toContain(SHAME_MESSAGE);
    expect(beforeFire).not.toContain("\x1b[?1049l");
    expect(clock.scheduled()).toBe(1200);

    clock.fire();
    await done;

    const after = stdout.joined();
    expect(after).toContain("\x1b[?1049l");
    expect(after).toContain("\x1b[?25h");
  });

  it("centres the message vertically and horizontally based on stdout dims", async () => {
    const stdout = makeStdout(60, 20);
    const clock = makeClock();
    const flash = new ShameFlash({ stdout, clock });
    flash.showShame();
    const expectedRow = Math.floor(20 / 2);
    const expectedCol = Math.floor((60 - SHAME_MESSAGE.length) / 2) + 1;
    expect(stdout.joined()).toContain(`\x1b[${expectedRow};${expectedCol}H`);
  });

  it("ignores concurrent showShame calls while a flash is in flight", async () => {
    const stdout = makeStdout();
    const clock = makeClock();
    const flash = new ShameFlash({ stdout, clock });
    flash.showShame();
    const enters = stdout.written.filter((s) => s === "\x1b[?1049h").length;
    expect(enters).toBe(1);

    await flash.showShame();
    expect(stdout.written.filter((s) => s === "\x1b[?1049h").length).toBe(1);
  });

  it("becomes flashable again after the hold completes", async () => {
    const stdout = makeStdout();
    const clock = makeClock();
    const flash = new ShameFlash({ stdout, clock });
    const first = flash.showShame();
    clock.fire();
    await first;
    const second = flash.showShame();
    expect(stdout.written.filter((s) => s === "\x1b[?1049h").length).toBe(2);
    clock.fire();
    await second;
  });

  it("falls back to 80x24 when stdout reports no dimensions", () => {
    const stdout: StdoutView = { write: () => true };
    const captured: string[] = [];
    const wrapped: StdoutView = {
      write: (s) => {
        captured.push(s);
        return stdout.write(s);
      },
    };
    const clock = makeClock();
    new ShameFlash({ stdout: wrapped, clock }).showShame();
    const expectedRow = Math.floor(24 / 2);
    const expectedCol = Math.floor((80 - SHAME_MESSAGE.length) / 2) + 1;
    expect(captured.join("")).toContain(`\x1b[${expectedRow};${expectedCol}H`);
  });
});

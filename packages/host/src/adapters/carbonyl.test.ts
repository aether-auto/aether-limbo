import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IOverlayController } from "../hotkey/types.js";
import { runDetached } from "./carbonyl.js";

class FakeOverlay implements IOverlayController {
  open_ = true;
  open = vi.fn(() => {
    this.open_ = true;
  });
  close = vi.fn(() => {
    this.open_ = false;
  });
  isOpen = (): boolean => this.open_;
  handleInput = (): void => undefined;
  handleResize = (): void => undefined;
}

describe("runDetached", () => {
  it("happy path: spawns with correct args, close fires before spawn, exit→0 triggers open exactly once", async () => {
    const overlay = new FakeOverlay();
    const ee = new EventEmitter();
    const spawnFn = vi.fn((): ChildProcess => ee as unknown as ChildProcess);

    const promise = runDetached({
      url: "https://example.com",
      overlay,
      spawn: spawnFn,
      carbonylBin: "/usr/bin/carbonyl",
    });

    // overlay.close must have fired before spawn
    expect(overlay.close).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith("/usr/bin/carbonyl", ["https://example.com"], {
      stdio: "inherit",
    });
    // close is called before spawn (index order in mock)
    const closeOrder = overlay.close.mock.invocationCallOrder[0];
    const spawnOrder = spawnFn.mock.invocationCallOrder[0];
    expect(closeOrder).toBeDefined();
    expect(spawnOrder).toBeDefined();
    expect(closeOrder ?? -1).toBeLessThan(spawnOrder ?? -1);

    ee.emit("exit", 0);
    await promise;

    expect(overlay.open).toHaveBeenCalledTimes(1);
  });

  it("non-zero exit: child exits with code 1 → overlay.open fires once", async () => {
    const overlay = new FakeOverlay();
    const ee = new EventEmitter();
    const spawnFn = vi.fn((): ChildProcess => ee as unknown as ChildProcess);

    const promise = runDetached({
      url: "https://example.com",
      overlay,
      spawn: spawnFn,
      carbonylBin: "/usr/bin/carbonyl",
    });

    ee.emit("exit", 1);
    await promise;

    expect(overlay.open).toHaveBeenCalledTimes(1);
  });

  it("spawn error: child emits error(ENOENT) → overlay.open fires once, no double-open", async () => {
    const overlay = new FakeOverlay();
    const ee = new EventEmitter();
    // Prevent Node from throwing unhandled error — we attach a listener via runDetached
    const spawnFn = vi.fn((): ChildProcess => ee as unknown as ChildProcess);

    const promise = runDetached({
      url: "https://example.com",
      overlay,
      spawn: spawnFn,
      carbonylBin: "/usr/bin/carbonyl",
    });

    ee.emit("error", new Error("ENOENT"));
    await promise;

    expect(overlay.open).toHaveBeenCalledTimes(1);
  });
});

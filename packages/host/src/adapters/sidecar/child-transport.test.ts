import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ChildProcessTransport, type SpawnLike } from "./child-transport.js";

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killSignal: string | undefined;
  kill(sig?: string): void {
    this.killSignal = sig;
  }
}

describe("ChildProcessTransport", () => {
  it("spawns python with the configured args, env, and cwd", () => {
    const spawn: SpawnLike = vi.fn(() => new FakeChild() as unknown as ReturnType<SpawnLike>);
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: ["-m", "limbo_sidecars", "echo"],
      env: { LIMBO_TEST: "1" },
      cwd: "/repo",
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      "/v/bin/python",
      ["-m", "limbo_sidecars", "echo"],
      expect.objectContaining({ env: expect.objectContaining({ LIMBO_TEST: "1" }), cwd: "/repo" }),
    );
    t.close();
  });

  it("write() pipes the chunk to child stdin", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    t.write("hello\n");
    expect(child.stdin.write).toHaveBeenCalledWith("hello\n");
  });

  it("onData fires for each stdout 'data' event (buffer is decoded as utf-8)", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    const seen: string[] = [];
    t.onData((c) => seen.push(c));
    child.stdout.emit("data", Buffer.from("a"));
    child.stdout.emit("data", Buffer.from("b"));
    expect(seen).toEqual(["a", "b"]);
  });

  it("onExit fires once with the child's exit code+signal", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    t.onExit((e) => exits.push(e));
    child.emit("exit", 0, null);
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it("close() sends SIGTERM to the child", () => {
    const child = new FakeChild();
    const spawn: SpawnLike = () => child as unknown as ReturnType<SpawnLike>;
    const t = new ChildProcessTransport({
      pythonExe: "/v/bin/python",
      args: [],
      env: {},
      cwd: "/",
      spawn,
    });
    t.close();
    expect(child.killSignal).toBe("SIGTERM");
  });
});

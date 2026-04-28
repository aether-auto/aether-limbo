import { describe, expect, it, vi } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import type { JsonRpcClient } from "../rpc/client.js";
import { BootstrapRunner } from "../sidecar/bootstrap-runner.js";
import type { Filesystem, RunResult } from "../sidecar/venv.js";
import type { IPane } from "../types.js";
import { InstagramReelsAdapter } from "./reels-adapter.js";
import { SharedInstagramSidecar } from "./shared-sidecar.js";

function makeFs(): Filesystem {
  const files = new Map<string, string>();
  return {
    async exists(p) {
      return files.has(p);
    },
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async writeFile(p, c) {
      files.set(p, c);
    },
  };
}

function makePane(): { pane: IPane; allLines: string[][] } {
  const allLines: string[][] = [];
  const pane: IPane = {
    cols: 80,
    rows: 24,
    topRow: 0,
    setLines(l) {
      allLines.push([...l]);
    },
    on(_ev, _li): IDisposable {
      return { dispose: () => undefined };
    },
  };
  return { pane, allLines };
}

function makeClient(validateStatus = "ready"): JsonRpcClient {
  return {
    request: vi.fn().mockResolvedValue({ status: validateStatus, items: [] }),
    dispose: vi.fn(),
  } as unknown as JsonRpcClient;
}

function makeRunner(run?: () => Promise<RunResult>): BootstrapRunner {
  return new BootstrapRunner({
    venvDir: "/v",
    pythonExe: "python3",
    pythonVersion: "3.11.5",
    packagePath: "/repo/sidecars",
    fs: makeFs(),
    run: run ?? (async () => ({ code: 0 })),
  });
}

describe("InstagramReelsAdapter — bootstrap path", () => {
  it("shows bootstrap panel during first-run install, then proceeds to validate", async () => {
    const runner = makeRunner();
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });

    const client = makeClient("login_required");
    const adapter = new InstagramReelsAdapter({
      client,
      runDetached: vi.fn(),
      igSidecar: sidecar,
    });

    const { pane, allLines } = makePane();
    await adapter.mount(pane);

    // At least one frame should contain the bootstrap header
    const bootstrapFrames = allLines.filter((l) => l.includes("[ Bootstrapping ]"));
    expect(bootstrapFrames.length).toBeGreaterThan(0);

    // After bootstrap, validate was called
    expect(client.request).toHaveBeenCalledWith("validate", undefined);
  });

  it("skips bootstrap panel when runner is already ready", async () => {
    const runner = makeRunner();
    // Pre-run bootstrap so status is 'ready'
    await runner.ensure([]);

    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });

    const client = makeClient("login_required");
    const adapter = new InstagramReelsAdapter({
      client,
      runDetached: vi.fn(),
      igSidecar: sidecar,
    });

    const { pane, allLines } = makePane();
    await adapter.mount(pane);

    // No bootstrap panel should be shown
    const bootstrapFrames = allLines.filter((l) => l.includes("[ Bootstrapping ]"));
    expect(bootstrapFrames.length).toBe(0);

    // validate was still called
    expect(client.request).toHaveBeenCalledWith("validate", undefined);
  });

  it("stays on error screen when bootstrap fails", async () => {
    const runner = makeRunner(async () => ({ code: 1, stderr: "pip exploded" }));
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });

    const client = makeClient("ready");
    const adapter = new InstagramReelsAdapter({
      client,
      runDetached: vi.fn(),
      igSidecar: sidecar,
    });

    const { pane, allLines } = makePane();
    await adapter.mount(pane);

    // Last frame should show error state
    const last = allLines[allLines.length - 1]!;
    expect(last.some((l) => l.includes("error:"))).toBe(true);
    expect(last.some((l) => l.includes("bootstrap failed"))).toBe(true);

    // validate must NOT have been called
    expect(client.request).not.toHaveBeenCalled();
  });

  it("shows progress messages during install", async () => {
    const runner = makeRunner();
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });

    const client = makeClient("ready");
    const adapter = new InstagramReelsAdapter({
      client,
      runDetached: vi.fn(),
      igSidecar: sidecar,
    });

    const progressMessages: string[] = [];
    runner.onProgress((p) => progressMessages.push(p.phase));

    const { pane } = makePane();
    await adapter.mount(pane);

    expect(progressMessages).toContain("creating-venv");
    expect(progressMessages).toContain("installing-package");
    expect(progressMessages).toContain("done");
  });

  it("skips bootstrap entirely when no igSidecar provided", async () => {
    const client = makeClient("login_required");
    const adapter = new InstagramReelsAdapter({
      client,
      runDetached: vi.fn(),
    });

    const { pane, allLines } = makePane();
    await adapter.mount(pane);

    // No bootstrap frames
    expect(allLines.some((l) => l.includes("[ Bootstrapping ]"))).toBe(false);
    // validate was called directly
    expect(client.request).toHaveBeenCalledWith("validate", undefined);
  });
});

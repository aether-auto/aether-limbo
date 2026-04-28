import { describe, expect, it, vi } from "vitest";
import { BootstrapRunner } from "../sidecar/bootstrap-runner.js";
import type { Filesystem, RunResult } from "../sidecar/venv.js";
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

describe("SharedInstagramSidecar — bootstrap wiring", () => {
  it("runner is undefined when no bootstrapRunner provided", () => {
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
    });
    expect(sidecar.runner).toBeUndefined();
  });

  it("runner matches the provided BootstrapRunner", () => {
    const runner = makeRunner();
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });
    expect(sidecar.runner).toBe(runner);
  });

  it("ensureBootstrap() resolves immediately when no runner", async () => {
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
    });
    await expect(sidecar.ensureBootstrap()).resolves.toBeUndefined();
  });

  it("ensureBootstrap() runs the runner with bootstrapExtras", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0 }));
    const runner = makeRunner(run);
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
      bootstrapExtras: ["instagram"],
    });
    await sidecar.ensureBootstrap();
    expect(runner.status).toBe("ready");
    // run is called as run(file, args) — c[1] is the args array
    const allCalls = run.mock.calls as unknown as Array<[string, string[]]>;
    const installCall = allCalls.find((c) => c[1].includes("install"));
    expect(installCall).toBeDefined();
    // find the install target arg that has bracket notation
    const target = installCall?.[1].find((a) => a.includes("[")) ?? "";
    expect(target).toContain("instagram");
  });

  it("all three adapters subscribing to progress see the same events", async () => {
    const runner = makeRunner();
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });

    const phases1: string[] = [];
    const phases2: string[] = [];
    const phases3: string[] = [];

    runner.onProgress((p) => phases1.push(p.phase));
    runner.onProgress((p) => phases2.push(p.phase));
    runner.onProgress((p) => phases3.push(p.phase));

    await sidecar.ensureBootstrap();

    // All three subscribers should see the same phases
    expect(phases1).toContain("done");
    expect(phases2).toEqual(phases1);
    expect(phases3).toEqual(phases1);
  });

  it("ensureBootstrap() is idempotent — runner.ensure() only runs once", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0 }));
    const runner = makeRunner(run);
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });

    await sidecar.ensureBootstrap();
    const callsAfterFirst = run.mock.calls.length;
    await sidecar.ensureBootstrap();
    expect(run.mock.calls.length).toBe(callsAfterFirst);
  });

  it("ensureBootstrap() rejects when runner fails", async () => {
    const runner = makeRunner(async () => ({ code: 1, stderr: "pip exploded" }));
    const sidecar = new SharedInstagramSidecar({
      env: {},
      cwd: "/",
      spawn: vi.fn() as never,
      bootstrapRunner: runner,
    });
    await expect(sidecar.ensureBootstrap()).rejects.toThrow();
  });
});

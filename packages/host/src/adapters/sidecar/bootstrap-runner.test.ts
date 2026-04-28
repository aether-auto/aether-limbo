import { describe, expect, it, vi } from "vitest";
import { BootstrapRunner } from "./bootstrap-runner.js";
import type { BootstrapRunnerOptions } from "./bootstrap-runner.js";
import type { Filesystem, RunResult } from "./venv.js";

function makeFs(initial: Record<string, string> = {}): Filesystem {
  const files = new Map<string, string>(Object.entries(initial));
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

function makeOpts(overrides: Partial<BootstrapRunnerOptions> = {}): BootstrapRunnerOptions {
  return {
    venvDir: "/v",
    pythonExe: "python3",
    pythonVersion: "3.11.5",
    packagePath: "/repo/sidecars",
    fs: makeFs(),
    run: async (): Promise<RunResult> => ({ code: 0 }),
    ...overrides,
  };
}

describe("BootstrapRunner", () => {
  it("starts with status 'idle'", () => {
    const runner = new BootstrapRunner(makeOpts());
    expect(runner.status).toBe("idle");
  });

  it("transitions to 'ready' after a successful ensure()", async () => {
    const runner = new BootstrapRunner(makeOpts());
    await runner.ensure(["echo"]);
    expect(runner.status).toBe("ready");
  });

  it("is idempotent — second ensure() is a no-op", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0 }));
    const runner = new BootstrapRunner(makeOpts({ run }));
    await runner.ensure(["echo"]);
    const callsAfterFirst = run.mock.calls.length;
    await runner.ensure(["echo"]);
    expect(run.mock.calls.length).toBe(callsAfterFirst); // no new calls
    expect(runner.status).toBe("ready");
  });

  it("concurrent ensure() calls share the same promise (run called only once)", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0 }));
    const runner = new BootstrapRunner(makeOpts({ run }));
    await Promise.all([runner.ensure(["echo"]), runner.ensure(["echo"]), runner.ensure(["echo"])]);
    // VenvBootstrap is constructed once per _run(); pip install called once.
    const installCalls = (run.mock.calls as unknown as Array<[string, string[]]>).filter((c) =>
      c[1].includes("install"),
    );
    expect(installCalls.length).toBe(1);
  });

  it("broadcasts progress events to subscribers", async () => {
    const runner = new BootstrapRunner(makeOpts());
    const phases: string[] = [];
    runner.onProgress((p) => phases.push(p.phase));
    await runner.ensure([]);
    expect(phases).toContain("creating-venv");
    expect(phases).toContain("installing-package");
    expect(phases).toContain("done");
  });

  it("unsubscribe stops receiving events", async () => {
    const runner = new BootstrapRunner(makeOpts());
    const phases: string[] = [];
    const unsub = runner.onProgress((p) => phases.push(p.phase));
    unsub();
    await runner.ensure([]);
    expect(phases).toHaveLength(0);
  });

  it("transitions to 'error' on pip failure and throws", async () => {
    const failRun = async (): Promise<RunResult> => ({ code: 1, stderr: "exploded" });
    const runner = new BootstrapRunner(makeOpts({ run: failRun }));
    await expect(runner.ensure([])).rejects.toThrow(/pip|venv/);
    expect(runner.status).toBe("error");
    expect(runner.error).toBeDefined();
  });

  it("re-throws on subsequent ensure() after error without re-running", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stderr: "fail" }));
    const runner = new BootstrapRunner(makeOpts({ run }));
    await expect(runner.ensure([])).rejects.toThrow();
    const callsAfterFirst = run.mock.calls.length;
    await expect(runner.ensure([])).rejects.toThrow();
    // run should NOT have been called again
    expect(run.mock.calls.length).toBe(callsAfterFirst);
  });
});

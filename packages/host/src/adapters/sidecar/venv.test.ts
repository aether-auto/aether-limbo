import { describe, expect, it, vi } from "vitest";
import { type Filesystem, type RunCommand, VenvBootstrap, computeManifestHash } from "./venv.js";

function fakeFs(initial: Record<string, string> = {}): Filesystem {
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
    async mkdir() {
      /* no-op for in-memory fs */
    },
  };
}

function fakeRun(): { calls: string[][]; run: RunCommand } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0 };
    },
  };
}

describe("computeManifestHash", () => {
  it("is stable across orderings of extras", () => {
    expect(computeManifestHash({ pythonVersion: "3.11.5", extras: ["a", "b"] })).toBe(
      computeManifestHash({ pythonVersion: "3.11.5", extras: ["b", "a"] }),
    );
  });

  it("changes when pythonVersion changes", () => {
    expect(computeManifestHash({ pythonVersion: "3.11.5", extras: [] })).not.toBe(
      computeManifestHash({ pythonVersion: "3.12.0", extras: [] }),
    );
  });
});

describe("VenvBootstrap.ensure", () => {
  it("creates the venv and installs the package on a cold start", async () => {
    const fs = fakeFs();
    const { run, calls } = fakeRun();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress: vi.fn(),
    });
    await v.ensure(["echo"]);
    expect(calls[0]).toEqual(["python3", "-m", "venv", "/v"]);
    expect(calls[1]?.[0]).toBe("/v/bin/pip");
    expect(calls[1]).toContain("install");
  });

  it("emits progress events for each phase", async () => {
    const fs = fakeFs();
    const { run } = fakeRun();
    const onProgress = vi.fn();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress,
    });
    await v.ensure([]);
    const phases = onProgress.mock.calls.map((c) => c[0].phase);
    expect(phases).toContain("creating-venv");
    expect(phases).toContain("installing-package");
    expect(phases).toContain("done");
  });

  it("is idempotent when manifest already matches", async () => {
    const expected = computeManifestHash({ pythonVersion: "3.11.5", extras: ["echo"] });
    const fs = fakeFs({
      "/v/bin/python": "",
      "/v/.limbo-manifest.json": JSON.stringify({
        pythonVersion: "3.11.5",
        extras: ["echo"],
        hash: expected,
      }),
    });
    const { run, calls } = fakeRun();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress: vi.fn(),
    });
    await v.ensure(["echo"]);
    expect(calls).toEqual([]);
  });

  it("re-installs when an extra is requested that is not in the manifest", async () => {
    const expected = computeManifestHash({ pythonVersion: "3.11.5", extras: ["echo"] });
    const fs = fakeFs({
      "/v/bin/python": "",
      "/v/.limbo-manifest.json": JSON.stringify({
        pythonVersion: "3.11.5",
        extras: ["echo"],
        hash: expected,
      }),
    });
    const { run, calls } = fakeRun();
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run,
      onProgress: vi.fn(),
    });
    await v.ensure(["echo", "instagram"]);
    const installArgs = calls.find((c) => c.includes("install"));
    expect(installArgs).toBeDefined();
    const target = installArgs?.find((a) => a.includes("[")) ?? "";
    expect(target).toContain("echo");
    expect(target).toContain("instagram");
  });

  it("propagates a non-zero pip exit as an error", async () => {
    const fs = fakeFs();
    const failingRun: RunCommand = async () => ({ code: 1, stderr: "pip exploded" });
    const v = new VenvBootstrap({
      venvDir: "/v",
      pythonExe: "python3",
      pythonVersion: "3.11.5",
      packagePath: "/repo/packages/sidecars",
      fs,
      run: failingRun,
      onProgress: vi.fn(),
    });
    await expect(v.ensure(["echo"])).rejects.toThrow(/pip|venv/);
  });
});

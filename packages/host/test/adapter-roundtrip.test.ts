import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonRpcClient } from "../src/adapters/rpc/client.js";
import { ChildProcessTransport } from "../src/adapters/sidecar/child-transport.js";

const enabled = process.env.LIMBO_RUN_PYTHON_TESTS === "1";
const desc = enabled ? describe : describe.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_SRC = path.resolve(HERE, "..", "..", "sidecars", "src");

desc("real python sidecar contract", () => {
  it("echo: ping -> pong", async () => {
    const transport = new ChildProcessTransport({
      pythonExe: "python3",
      args: ["-m", "limbo_sidecars", "echo"],
      env: { ...process.env, PYTHONPATH: SIDECAR_SRC },
      cwd: process.cwd(),
      spawn,
    });
    const client = new JsonRpcClient(transport);
    try {
      const result = await client.request("ping", undefined);
      expect(result).toBe("pong");
    } finally {
      client.dispose();
    }
  }, 10_000);

  it("echo: emits a body/update notification on startup", async () => {
    const transport = new ChildProcessTransport({
      pythonExe: "python3",
      args: ["-m", "limbo_sidecars", "echo"],
      env: { ...process.env, PYTHONPATH: SIDECAR_SRC },
      cwd: process.cwd(),
      spawn,
    });
    const client = new JsonRpcClient(transport);
    const seen = await new Promise<unknown>((resolve) => {
      client.on("body/update", (params) => resolve(params));
    });
    expect(seen).toMatchObject({ lines: expect.any(Array) });
    client.dispose();
  }, 10_000);
});

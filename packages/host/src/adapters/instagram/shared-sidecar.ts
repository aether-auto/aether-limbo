import { spawn as nodeSpawn } from "node:child_process";
import { JsonRpcClient } from "../rpc/client.js";
import type { SpawnLike } from "../sidecar/child-transport.js";
import { ChildProcessTransport } from "../sidecar/child-transport.js";

// ---------------------------------------------------------------------------
// SharedInstagramSidecar
//
// Lazily spawns exactly one `python3 -m limbo_sidecars instagram` child
// process and exposes its JsonRpcClient to all three IG adapter descriptors.
// The transport+client pair is created on first access and torn down by
// dispose(), which is called by BuiltinAdapterRegistry.dispose() when the
// registry is shut down (i.e. on wrapper exit).
// ---------------------------------------------------------------------------

export interface SharedInstagramSidecarOptions {
  readonly pythonExe?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly spawn?: SpawnLike;
}

export class SharedInstagramSidecar {
  private _client: JsonRpcClient | undefined;
  private readonly opts: Required<SharedInstagramSidecarOptions>;

  constructor(opts: SharedInstagramSidecarOptions) {
    this.opts = {
      pythonExe: opts.pythonExe ?? "python3",
      env: opts.env,
      cwd: opts.cwd,
      spawn: opts.spawn ?? nodeSpawn,
    };
  }

  /** Returns the shared client, lazily creating the child process on first call. */
  get client(): JsonRpcClient {
    if (this._client === undefined) {
      const transport = new ChildProcessTransport({
        pythonExe: this.opts.pythonExe,
        args: ["-m", "limbo_sidecars", "instagram"],
        env: this.opts.env,
        cwd: this.opts.cwd,
        spawn: this.opts.spawn,
      });
      this._client = new JsonRpcClient(transport);
    }
    return this._client;
  }

  /**
   * Dispose the shared client and terminate the child process.
   * Called once by the registry's dispose() path — not by individual adapters.
   */
  dispose(): void {
    if (this._client !== undefined) {
      this._client.dispose();
      this._client = undefined;
    }
  }
}

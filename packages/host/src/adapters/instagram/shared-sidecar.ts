import { spawn as nodeSpawn } from "node:child_process";
import { JsonRpcClient } from "../rpc/client.js";
import type { BootstrapRunner } from "../sidecar/bootstrap-runner.js";
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
//
// Bootstrap wiring (Phase 8):
//   If a BootstrapRunner is supplied, whichever IG adapter mounts first calls
//   ensureBootstrap(); the runner deduplicates concurrent callers so bootstrap
//   runs exactly once. All three adapters subscribe via runner.onProgress()
//   before calling ensureBootstrap() so they each see progress lines.
// ---------------------------------------------------------------------------

export interface SharedInstagramSidecarOptions {
  readonly pythonExe?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly spawn?: SpawnLike;
  /**
   * Optional pre-built BootstrapRunner. When provided the first IG adapter to
   * mount triggers venv bootstrap; the rest await the same promise.
   * Extras to pass to runner.ensure() default to ["instagram"].
   */
  readonly bootstrapRunner?: BootstrapRunner;
  /** Extras forwarded to bootstrapRunner.ensure(); defaults to ["instagram"]. */
  readonly bootstrapExtras?: readonly string[];
}

export class SharedInstagramSidecar {
  private _client: JsonRpcClient | undefined;
  private readonly opts: Required<
    Omit<SharedInstagramSidecarOptions, "bootstrapRunner" | "bootstrapExtras">
  > & {
    readonly bootstrapRunner: BootstrapRunner | undefined;
    readonly bootstrapExtras: readonly string[];
  };

  /** Exposed so IG adapters can subscribe to progress events. */
  readonly runner: BootstrapRunner | undefined;

  constructor(opts: SharedInstagramSidecarOptions) {
    this.opts = {
      pythonExe: opts.pythonExe ?? "python3",
      env: opts.env,
      cwd: opts.cwd,
      spawn: opts.spawn ?? nodeSpawn,
      bootstrapRunner: opts.bootstrapRunner,
      bootstrapExtras: opts.bootstrapExtras ?? ["instagram"],
    };
    this.runner = opts.bootstrapRunner;
  }

  /**
   * Ensure the venv is bootstrapped. No-op when no runner was provided.
   * Concurrent callers share the same promise — bootstrap runs exactly once.
   */
  async ensureBootstrap(): Promise<void> {
    if (!this.opts.bootstrapRunner) return;
    return this.opts.bootstrapRunner.ensure(this.opts.bootstrapExtras);
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

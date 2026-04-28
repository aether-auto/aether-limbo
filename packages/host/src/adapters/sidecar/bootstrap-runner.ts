import { type BootstrapProgress, VenvBootstrap, type VenvBootstrapOptions } from "./venv.js";

// ---------------------------------------------------------------------------
// BootstrapRunner
//
// Thin wrapper around VenvBootstrap that:
//   1. Accepts a subscribable progress listener set (adapters call onProgress()
//      to register; the runner unsubscribes them automatically after ensure()).
//   2. Deduplicates concurrent ensure() calls — multiple adapters awaiting the
//      same runner share one promise.
//   3. Short-circuits on repeated calls when already "ready".
//
// Usage (wrapper.ts):
//   const runner = new BootstrapRunner({ ...venvOpts });
//   // In adapter options:
//   adapter.bootstrapRunner = runner;
//
// Usage (adapter.mount):
//   if (runner && runner.status !== "ready") {
//     const panel = new BootstrapPanel();
//     panel.attach(pane);
//     panel.start("Preparing…");
//     const unsub = runner.onProgress((p) => panel.update(…));
//     try { await runner.ensure(extras); } catch { panel.error(…); return; }
//     unsub();
//   }
// ---------------------------------------------------------------------------

export type BootstrapRunnerStatus = "idle" | "running" | "ready" | "error";

export type BootstrapRunnerOptions = Omit<VenvBootstrapOptions, "onProgress">;

export class BootstrapRunner {
  private readonly venvOpts: BootstrapRunnerOptions;
  private _status: BootstrapRunnerStatus = "idle";
  private _error: Error | undefined;
  private _promise: Promise<void> | undefined;

  private readonly _progressListeners = new Set<(p: BootstrapProgress) => void>();

  constructor(opts: BootstrapRunnerOptions) {
    this.venvOpts = opts;
  }

  get status(): BootstrapRunnerStatus {
    return this._status;
  }

  get error(): Error | undefined {
    return this._error;
  }

  /** Subscribe to progress events. Returns an unsubscribe function. */
  onProgress(listener: (p: BootstrapProgress) => void): () => void {
    this._progressListeners.add(listener);
    return () => {
      this._progressListeners.delete(listener);
    };
  }

  /**
   * Run the bootstrap with the given extras. Concurrent callers share the same
   * promise. Short-circuits immediately when status is already "ready".
   * Throws if the bootstrap fails.
   */
  async ensure(extras: readonly string[]): Promise<void> {
    if (this._status === "ready") return;
    if (this._status === "error") {
      throw this._error ?? new Error("bootstrap failed");
    }
    if (this._promise !== undefined) {
      return this._promise;
    }

    this._status = "running";
    this._promise = this._run(extras);
    return this._promise;
  }

  private async _run(extras: readonly string[]): Promise<void> {
    const bootstrap = new VenvBootstrap({
      ...this.venvOpts,
      onProgress: (p: BootstrapProgress) => {
        for (const l of this._progressListeners) l(p);
      },
    });
    try {
      await bootstrap.ensure(extras);
      this._status = "ready";
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._status = "error";
      this._error = error;
      throw error;
    }
  }
}

import type { KeyAction } from "../overlay/types.js";
import type { IDisposable } from "../pty/types.js";

export type AdapterLifecycleEvent = "mounting" | "mounted" | "unmounting" | "unmounted" | "errored";

export interface IPane {
  readonly cols: number;
  readonly rows: number;
  readonly topRow: number;
  setLines(lines: readonly string[]): void;
  on(event: "resize", listener: (cols: number, rows: number) => void): IDisposable;
}

export interface IAdapter {
  readonly id: string;
  mount(pane: IPane): Promise<void>;
  unmount(): Promise<void>;
  handleKey(action: KeyAction): void;
  /**
   * Called with the raw stdin chunk before the overlay's keymap processes it.
   * Return `true` to consume the chunk; `false` to fall through to the overlay's keymap.
   * Adapters that do not implement this method receive unchanged keymap behaviour.
   */
  captureInput?(chunk: string): boolean;
  /** Called when the user presses Enter while this adapter is mounted. */
  onEnter?(): void;
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly extras: readonly string[];
  readonly enabled: boolean;
  /**
   * When true the registry keeps the adapter alive across overlay close/open cycles.
   * On `release()` the adapter is detached from its pane but NOT unmounted — the underlying
   * sidecar process stays running. The next `get()` call returns the same instance and
   * `adapter.mount(newPane)` is called again with a fresh pane. Adapter implementations
   * MUST tolerate being re-mounted after a release: they should reset any visible-state
   * from RPC on each `mount()` call.
   * When false (default) `release()` calls `adapter.unmount()` immediately and discards
   * the instance; the next `get()` creates a new one via `create()`.
   */
  readonly keepWarm: boolean;
  create(): IAdapter;
}

export interface IAdapterRegistry {
  get(id: string): IAdapter | undefined;
  list(): readonly AdapterDescriptor[];
  /**
   * Called by the overlay when it is done with an adapter for the current open/close cycle.
   * If the descriptor has `keepWarm: true` the adapter is cached and NOT unmounted.
   * If `keepWarm: false` the adapter is unmounted and discarded.
   * Errors from `unmount()` are swallowed; this method never rejects.
   */
  release(adapter: IAdapter): Promise<void>;
  /**
   * Called by the wrapper on pty exit. Unmounts all cached (keep-warm) adapters and clears
   * the cache. Idempotent — subsequent calls are no-ops. Errors from individual unmounts are
   * swallowed so all adapters are attempted.
   */
  dispose(): Promise<void>;
}

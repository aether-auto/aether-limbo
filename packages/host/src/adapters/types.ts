import type { KeyAction } from "../overlay/types.js";
import type { IDisposable } from "../pty/types.js";

export type AdapterLifecycleEvent = "mounting" | "mounted" | "unmounting" | "unmounted" | "errored";

export interface IPane {
  readonly cols: number;
  readonly rows: number;
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
  create(): IAdapter;
}

export interface IAdapterRegistry {
  get(id: string): IAdapter | undefined;
  list(): readonly AdapterDescriptor[];
}

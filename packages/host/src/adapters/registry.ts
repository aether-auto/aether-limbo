import type { AdapterDescriptor, IAdapter, IAdapterRegistry } from "./types.js";

export class BuiltinAdapterRegistry implements IAdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();
  private readonly cache = new Map<string, IAdapter>();
  private readonly produced = new WeakMap<IAdapter, AdapterDescriptor>();
  private disposed = false;

  constructor(private readonly descriptors: readonly AdapterDescriptor[]) {
    for (const d of descriptors) this.byId.set(d.id, d);
  }

  get(id: string): IAdapter | undefined {
    const d = this.byId.get(id);
    if (!d || !d.enabled) return undefined;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const adapter = d.create();
    this.produced.set(adapter, d);
    return adapter;
  }

  list(): readonly AdapterDescriptor[] {
    return this.descriptors;
  }

  async release(adapter: IAdapter): Promise<void> {
    const d = this.produced.get(adapter);
    if (d === undefined) {
      // Unknown adapter — fall back to a direct unmount, swallow errors.
      try {
        await adapter.unmount();
      } catch {
        // swallow
      }
      return;
    }
    if (d.keepWarm) {
      this.cache.set(d.id, adapter);
    } else {
      try {
        await adapter.unmount();
      } catch {
        // adapter teardown failures must not propagate
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const adapter of this.cache.values()) {
      try {
        await adapter.unmount();
      } catch {
        // swallow individual failures so all adapters are attempted
      }
    }
    this.cache.clear();
  }
}

import type { AdapterDescriptor, IAdapter, IAdapterRegistry } from "./types.js";

export class BuiltinAdapterRegistry implements IAdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();

  constructor(private readonly descriptors: readonly AdapterDescriptor[]) {
    for (const d of descriptors) this.byId.set(d.id, d);
  }

  get(id: string): IAdapter | undefined {
    const d = this.byId.get(id);
    if (!d || !d.enabled) return undefined;
    return d.create();
  }

  list(): readonly AdapterDescriptor[] {
    return this.descriptors;
  }
}

import { describe, expect, it, vi } from "vitest";
import { BuiltinAdapterRegistry } from "./registry.js";
import type { AdapterDescriptor, IAdapter } from "./types.js";

function makeDescriptor(id: string, enabled = true): AdapterDescriptor {
  return {
    id,
    extras: [],
    enabled,
    create: vi.fn(
      () =>
        ({
          id,
          mount: async () => undefined,
          unmount: async () => undefined,
          handleKey: () => undefined,
        }) as IAdapter,
    ),
  };
}

describe("BuiltinAdapterRegistry", () => {
  it("get(id) returns an adapter for an enabled descriptor", () => {
    const r = new BuiltinAdapterRegistry([makeDescriptor("echo")]);
    const a = r.get("echo");
    expect(a?.id).toBe("echo");
  });

  it("get(id) returns undefined for a disabled descriptor", () => {
    const r = new BuiltinAdapterRegistry([makeDescriptor("echo", false)]);
    expect(r.get("echo")).toBeUndefined();
  });

  it("get(id) returns undefined for an unknown id", () => {
    const r = new BuiltinAdapterRegistry([makeDescriptor("echo")]);
    expect(r.get("nope")).toBeUndefined();
  });

  it("list() returns all descriptors regardless of enabled", () => {
    const r = new BuiltinAdapterRegistry([
      makeDescriptor("echo", true),
      makeDescriptor("instagram", false),
    ]);
    expect(r.list()).toHaveLength(2);
  });

  it("create() is invoked once per get() call (no caching)", () => {
    const desc = makeDescriptor("echo");
    const r = new BuiltinAdapterRegistry([desc]);
    r.get("echo");
    r.get("echo");
    expect(desc.create).toHaveBeenCalledTimes(2);
  });
});

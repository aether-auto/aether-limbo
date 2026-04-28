import { describe, expect, it, vi } from "vitest";
import { BuiltinAdapterRegistry } from "./registry.js";
import type { AdapterDescriptor, IAdapter } from "./types.js";

function makeAdapter(id: string): IAdapter {
  return {
    id,
    mount: vi.fn(async () => undefined),
    unmount: vi.fn(async () => undefined),
    handleKey: vi.fn(() => undefined),
  };
}

function makeDescriptor(id: string, enabled = true, keepWarm = false): AdapterDescriptor {
  return {
    id,
    extras: [],
    enabled,
    keepWarm,
    create: vi.fn(() => makeAdapter(id)),
  };
}

function assertDefined<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
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

  it("create() is invoked once per get() call when not cached (keepWarm=false)", () => {
    const desc = makeDescriptor("echo", true, false);
    const r = new BuiltinAdapterRegistry([desc]);
    r.get("echo");
    r.get("echo");
    expect(desc.create).toHaveBeenCalledTimes(2);
  });
});

describe("BuiltinAdapterRegistry keep-warm caching", () => {
  it("release with keepWarm=true caches adapter; next get() returns same instance, create() called once", async () => {
    const desc = makeDescriptor("echo", true, true);
    const r = new BuiltinAdapterRegistry([desc]);
    const a1 = assertDefined(r.get("echo"), "a1");
    await r.release(a1);
    const a2 = r.get("echo");
    expect(a2).toBe(a1);
    expect(desc.create).toHaveBeenCalledTimes(1);
  });

  it("release with keepWarm=true does NOT call unmount", async () => {
    const desc = makeDescriptor("echo", true, true);
    const r = new BuiltinAdapterRegistry([desc]);
    const a = assertDefined(r.get("echo"), "a");
    await r.release(a);
    expect(a.unmount).not.toHaveBeenCalled();
  });

  it("release with keepWarm=false calls unmount and discards; next get() creates a new instance", async () => {
    const desc = makeDescriptor("echo", true, false);
    const r = new BuiltinAdapterRegistry([desc]);
    const a1 = assertDefined(r.get("echo"), "a1");
    await r.release(a1);
    expect(a1.unmount).toHaveBeenCalledOnce();
    const a2 = r.get("echo");
    expect(a2).not.toBe(a1);
    expect(desc.create).toHaveBeenCalledTimes(2);
  });

  it("dispose() calls unmount on all cached adapters and clears cache", async () => {
    const desc = makeDescriptor("echo", true, true);
    const r = new BuiltinAdapterRegistry([desc]);
    const a = assertDefined(r.get("echo"), "a");
    await r.release(a); // caches it
    await r.dispose();
    expect(a.unmount).toHaveBeenCalledOnce();
    // cache is cleared: next get() creates a new instance
    const a2 = r.get("echo");
    expect(a2).not.toBe(a);
    expect(desc.create).toHaveBeenCalledTimes(2);
  });

  it("dispose() is idempotent — second call is a no-op and does not re-unmount", async () => {
    const desc = makeDescriptor("echo", true, true);
    const r = new BuiltinAdapterRegistry([desc]);
    const a = assertDefined(r.get("echo"), "a");
    await r.release(a);
    await r.dispose();
    await r.dispose(); // second call must not throw or re-unmount
    expect(a.unmount).toHaveBeenCalledOnce();
  });

  it("release() swallows unmount errors (keepWarm=false)", async () => {
    const desc: AdapterDescriptor = {
      id: "boom",
      extras: [],
      enabled: true,
      keepWarm: false,
      create: vi.fn(() => ({
        id: "boom",
        mount: vi.fn(async () => undefined),
        unmount: vi.fn(async () => {
          throw new Error("unmount failed");
        }),
        handleKey: vi.fn(() => undefined),
      })),
    };
    const r = new BuiltinAdapterRegistry([desc]);
    const a = assertDefined(r.get("boom"), "a");
    await expect(r.release(a)).resolves.toBeUndefined();
  });

  it("dispose() swallows individual unmount errors and continues to next adapter", async () => {
    const boomDesc: AdapterDescriptor = {
      id: "boom",
      extras: [],
      enabled: true,
      keepWarm: true,
      create: vi.fn(() => ({
        id: "boom",
        mount: vi.fn(async () => undefined),
        unmount: vi.fn(async () => {
          throw new Error("unmount boom");
        }),
        handleKey: vi.fn(() => undefined),
      })),
    };
    const okDesc = makeDescriptor("ok", true, true);
    const r = new BuiltinAdapterRegistry([boomDesc, okDesc]);

    const boomAdapter = assertDefined(r.get("boom"), "boomAdapter");
    const okAdapter = assertDefined(r.get("ok"), "okAdapter");

    await r.release(boomAdapter); // caches boomAdapter
    await r.release(okAdapter); // caches okAdapter

    await expect(r.dispose()).resolves.toBeUndefined();
    // okAdapter unmount was still called even though boomAdapter threw
    expect(okAdapter.unmount).toHaveBeenCalledOnce();
  });
});

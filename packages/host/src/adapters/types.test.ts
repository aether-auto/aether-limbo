import { describe, expectTypeOf, it } from "vitest";
import type { KeyAction } from "../overlay/types.js";
import type { IDisposable } from "../pty/types.js";
import type {
  AdapterDescriptor,
  AdapterLifecycleEvent,
  IAdapter,
  IAdapterRegistry,
  IPane,
} from "./types.js";

describe("adapter contract types", () => {
  it("IAdapter exposes id, mount, unmount, handleKey", () => {
    expectTypeOf<IAdapter["id"]>().toBeString();
    expectTypeOf<IAdapter["mount"]>().parameters.toEqualTypeOf<[IPane]>();
    expectTypeOf<IAdapter["mount"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<IAdapter["unmount"]>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<IAdapter["unmount"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<IAdapter["handleKey"]>().parameters.toEqualTypeOf<[KeyAction]>();
    expectTypeOf<IAdapter["handleKey"]>().returns.toEqualTypeOf<void>();
  });

  it("IPane.setLines accepts readonly string[]", () => {
    expectTypeOf<IPane["setLines"]>().parameters.toEqualTypeOf<[readonly string[]]>();
  });

  it("IPane.on('resize') returns IDisposable", () => {
    expectTypeOf<ReturnType<IPane["on"]>>().toEqualTypeOf<IDisposable>();
  });

  it("AdapterDescriptor binds an adapter id to a factory + extras list", () => {
    expectTypeOf<AdapterDescriptor["id"]>().toBeString();
    expectTypeOf<AdapterDescriptor["extras"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<AdapterDescriptor["create"]>().toBeFunction();
    expectTypeOf<AdapterDescriptor["enabled"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdapterDescriptor["keepWarm"]>().toEqualTypeOf<boolean>();
  });

  it("IAdapterRegistry.get returns IAdapter | undefined", () => {
    expectTypeOf<IAdapterRegistry["get"]>().returns.toEqualTypeOf<IAdapter | undefined>();
  });

  it("IAdapterRegistry.release and dispose return Promise<void>", () => {
    expectTypeOf<IAdapterRegistry["release"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<IAdapterRegistry["dispose"]>().returns.toEqualTypeOf<Promise<void>>();
  });

  it("AdapterLifecycleEvent enumerates the lifecycle states", () => {
    expectTypeOf<AdapterLifecycleEvent>().toEqualTypeOf<
      "mounting" | "mounted" | "unmounting" | "unmounted" | "errored"
    >();
  });
});

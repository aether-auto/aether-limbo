import { describe, expectTypeOf, it } from "vitest";
import type { IDisposable } from "../../pty/types.js";
import type { ITransport } from "./transport.js";

describe("ITransport", () => {
  it("exposes write, onData, onExit, close", () => {
    expectTypeOf<ITransport["write"]>().parameters.toEqualTypeOf<[string]>();
    expectTypeOf<ITransport["onData"]>().returns.toEqualTypeOf<IDisposable>();
    expectTypeOf<ITransport["onExit"]>().returns.toEqualTypeOf<IDisposable>();
    expectTypeOf<ITransport["close"]>().returns.toEqualTypeOf<void>();
  });
});

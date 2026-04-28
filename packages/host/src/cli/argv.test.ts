import { describe, expect, it } from "vitest";
import { parseArgv } from "./argv.js";

describe("parseArgv", () => {
  it("returns version for --version alone", () => {
    expect(parseArgv(["--version"])).toEqual({ kind: "version" });
  });

  it("returns version for -v alone", () => {
    expect(parseArgv(["-v"])).toEqual({ kind: "version" });
  });

  it("does NOT return version for --version with extra args", () => {
    expect(parseArgv(["--version", "extra"])).toEqual({
      kind: "wrap",
      argv: ["--version", "extra"],
    });
  });

  it("returns config-edit for 'config edit'", () => {
    expect(parseArgv(["config", "edit"])).toEqual({ kind: "config-edit" });
  });

  it("returns config-show for 'config show'", () => {
    expect(parseArgv(["config", "show"])).toEqual({ kind: "config-show" });
  });

  it("returns config-unknown for unrecognised subcommand", () => {
    expect(parseArgv(["config", "foo"])).toEqual({ kind: "config-unknown", sub: "foo" });
  });

  it("returns config-missing-sub for 'config' alone", () => {
    expect(parseArgv(["config"])).toEqual({ kind: "config-missing-sub" });
  });

  it("ignores config-like flags — passes them as wrap", () => {
    expect(parseArgv(["--config"])).toEqual({ kind: "wrap", argv: ["--config"] });
    expect(parseArgv(["--config-edit"])).toEqual({
      kind: "wrap",
      argv: ["--config-edit"],
    });
  });

  it("returns wrap with empty argv for no args", () => {
    expect(parseArgv([])).toEqual({ kind: "wrap", argv: [] });
  });

  it("passes arbitrary claude args through as wrap", () => {
    expect(parseArgv(["--foo", "bar", "baz"])).toEqual({
      kind: "wrap",
      argv: ["--foo", "bar", "baz"],
    });
  });

  it("treats 'config edit' with trailing args as wrap (only exact 2-element match)", () => {
    // "config edit extra" — still a config-edit; the extra args after are ignored.
    // The spec only checks argv[0] === "config" and argv[1] === "edit".
    expect(parseArgv(["config", "edit", "--extra"])).toEqual({ kind: "config-edit" });
  });
});

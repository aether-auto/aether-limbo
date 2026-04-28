import { describe, expect, it } from "vitest";
import { getConfigDir, getConfigPath, getDataDir, getSecretsPath } from "./paths.js";

const HOME = "/home/user";

describe("getConfigDir", () => {
  it("defaults to ~/.config/aether-limbo when XDG_CONFIG_HOME is unset", () => {
    expect(getConfigDir({}, HOME)).toBe("/home/user/.config/aether-limbo");
  });

  it("respects XDG_CONFIG_HOME when set", () => {
    expect(getConfigDir({ XDG_CONFIG_HOME: "/custom/cfg" }, HOME)).toBe("/custom/cfg/aether-limbo");
  });

  it("ignores empty string XDG_CONFIG_HOME and falls back to default", () => {
    // Empty string is falsy — ?? only triggers on null/undefined, so empty string
    // would be used as-is. This documents that behaviour explicitly.
    expect(getConfigDir({ XDG_CONFIG_HOME: "" }, HOME)).toBe("/aether-limbo");
  });
});

describe("getConfigPath", () => {
  it("appends config.toml to the config dir", () => {
    expect(getConfigPath({}, HOME)).toBe("/home/user/.config/aether-limbo/config.toml");
  });

  it("respects XDG_CONFIG_HOME", () => {
    expect(getConfigPath({ XDG_CONFIG_HOME: "/x" }, HOME)).toBe("/x/aether-limbo/config.toml");
  });
});

describe("getSecretsPath", () => {
  it("appends secrets.toml to the config dir", () => {
    expect(getSecretsPath({}, HOME)).toBe("/home/user/.config/aether-limbo/secrets.toml");
  });

  it("respects XDG_CONFIG_HOME", () => {
    expect(getSecretsPath({ XDG_CONFIG_HOME: "/x" }, HOME)).toBe("/x/aether-limbo/secrets.toml");
  });
});

describe("getDataDir", () => {
  it("defaults to ~/.local/share/aether-limbo when XDG_DATA_HOME is unset", () => {
    expect(getDataDir({}, HOME)).toBe("/home/user/.local/share/aether-limbo");
  });

  it("respects XDG_DATA_HOME when set", () => {
    expect(getDataDir({ XDG_DATA_HOME: "/custom/data" }, HOME)).toBe("/custom/data/aether-limbo");
  });
});

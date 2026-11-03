import { describe, expect, it } from "bun:test";

import { parseCommand } from "./cli.ts";
import { LauncherUsageError } from "./launcher.ts";

describe("command parsing", () => {
  it.each(["--help", "-h", "help"])("accepts the top-level help alias %s", (alias) => {
    expect(parseCommand([alias])).toEqual({ kind: "help" });
    expect(() => parseCommand([alias, "extra"])).toThrow("Run claudex --help for command usage.");
  });

  it.each(["serve", "login", "doctor", "models"])(
    "accepts help only as the sole option for %s",
    (command) => {
      expect(parseCommand([command, "--help"])).toEqual({ kind: "help" });
      expect(parseCommand([command, "-h"])).toEqual({ kind: "help" });
      expect(() => parseCommand([command, "--help", "extra"])).toThrow(LauncherUsageError);
    },
  );

  it.each(["--version", "-v"])("accepts the version alias %s without options", (alias) => {
    expect(parseCommand([alias])).toEqual({ kind: "version" });
    expect(() => parseCommand([alias, "extra"])).toThrow("--version does not accept arguments.");
  });

  it.each(["doctor", "models"])("accepts only the JSON option for %s", (command) => {
    expect(parseCommand([command])).toEqual({ kind: command, json: false });
    expect(parseCommand([command, "--json"])).toEqual({ kind: command, json: true });
    expect(() => parseCommand([command, "--json=true"])).toThrow(
      "Invalid command options. Run claudex --help.",
    );
    expect(() => parseCommand([command, "--json", "--json"])).toThrow(
      "Invalid command options. Run claudex --help.",
    );
  });

  it.each([
    { args: [], port: 8788 },
    { args: ["-p", "1"], port: 1 },
    { args: ["--port", "65535"], port: 65535 },
    { args: ["--port=00080"], port: 80 },
  ])("accepts serve port syntax %j", ({ args, port }) => {
    expect(parseCommand(["serve", ...args])).toEqual({ kind: "serve", port });
  });

  it.each(["", "0", "65536", "1.5", "1e3", "+80", " 80", "80 ", "-1"])(
    "rejects invalid serve port values without changing the error: %j",
    (value) => {
      expect(() => parseCommand(["serve", `--port=${value}`])).toThrow(
        "--port must be an integer from 1 to 65535.",
      );
    },
  );

  it.each([
    { args: ["--port"] },
    { args: ["-p=80"] },
    { args: ["--port=80", "extra"] },
    { args: ["--host", "0.0.0.0"] },
  ])("rejects malformed serve options with the usage error: %j", ({ args }) => {
    expect(() => parseCommand(["serve", ...args])).toThrow("Use claudex serve [--port <1-65535>].");
  });

  it("forwards unknown command names and their options unchanged", () => {
    const args = ["unknown-command", "--help", "--version", "--", "--settings"];
    const command = parseCommand(args);
    expect(command).toEqual({ kind: "claude", args });
    if (command.kind === "claude") expect(command.args).toBe(args);
  });
});

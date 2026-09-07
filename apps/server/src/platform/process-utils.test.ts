import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ExecutableNotFoundError,
  getProcessCommandLine,
  isProcessAlive,
  killProcessTree,
  resolveCommandPath,
  resolveExecutableForSpawn,
} from "./process-utils.js";

const isAlive = isProcessAlive;

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

test("resolveExecutableForSpawn: passthrough on non-Windows", () => {
  withPlatform("linux", () => {
    const result = resolveExecutableForSpawn("claude");
    assert.deepEqual(result, { command: "claude", prependArgs: [] });
  });
});

test("resolveExecutableForSpawn: unwraps a .cmd shim that forwards to node.exe + a .js entrypoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-shim-js-"));
  try {
    fs.writeFileSync(path.join(dir, "node.exe"), "stub");
    fs.mkdirSync(path.join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    const jsPath = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.writeFileSync(jsPath, "// stub");
    const shimPath = path.join(dir, "codex.cmd");
    fs.writeFileSync(
      shimPath,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        "  SET _prog=node",
        ")",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
        "",
      ].join("\r\n"),
    );

    const result = withPlatform("win32", () => resolveExecutableForSpawn(shimPath));
    assert.equal(result.command, path.join(dir, "node.exe"));
    assert.deepEqual(result.prependArgs, [jsPath]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveExecutableForSpawn: unwraps a .cmd shim that forwards directly to a .exe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-shim-exe-"));
  try {
    fs.mkdirSync(path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin"), { recursive: true });
    const exePath = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    fs.writeFileSync(exePath, "stub");
    const shimPath = path.join(dir, "claude.cmd");
    fs.writeFileSync(
      shimPath,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
        "",
      ].join("\r\n"),
    );

    const result = withPlatform("win32", () => resolveExecutableForSpawn(shimPath));
    assert.deepEqual(result, { command: exePath, prependArgs: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveExecutableForSpawn: unwraps a .cmd shim that forwards to node.exe + an extensionless shebang bin script (observed: openclaude.cmd -> bin/openclaude)", () => {
  // Regression coverage for the qwythos-runner integration: openclaude's
  // real installed npm shim points at "bin\\openclaude" with NO file
  // extension (a shebang-style entrypoint, not "bin\\openclaude.js"), which
  // the original .exe|.js-only regex rejected outright as an "unrecognized
  // .cmd shim format" -- verified live against the actual installed shim
  // before this fix existed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-shim-noext-"));
  try {
    fs.writeFileSync(path.join(dir, "node.exe"), "stub");
    fs.mkdirSync(path.join(dir, "node_modules", "@gitlawb", "openclaude", "bin"), { recursive: true });
    const binPath = path.join(dir, "node_modules", "@gitlawb", "openclaude", "bin", "openclaude");
    fs.writeFileSync(binPath, "#!/usr/bin/env node\n// stub");
    const shimPath = path.join(dir, "openclaude.cmd");
    fs.writeFileSync(
      shimPath,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@gitlawb\\openclaude\\bin\\openclaude" %*',
        "",
      ].join("\r\n"),
    );

    const result = withPlatform("win32", () => resolveExecutableForSpawn(shimPath));
    assert.equal(result.command, path.join(dir, "node.exe"));
    assert.deepEqual(result.prependArgs, [binPath]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveExecutableForSpawn: still fails closed on a shim target with a genuinely unrecognized extension (e.g. .ps1)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-shim-badext-"));
  try {
    const shimPath = path.join(dir, "weird.cmd");
    fs.writeFileSync(
      shimPath,
      ["@ECHO off", "SETLOCAL", 'CALL :find_dp0', '"%dp0%\\node_modules\\weird\\bin\\weird.ps1"   %*', ""].join("\r\n"),
    );
    assert.throws(
      () => withPlatform("win32", () => resolveExecutableForSpawn(shimPath)),
      ExecutableNotFoundError,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveExecutableForSpawn: fails closed (throws) on an unrecognized shim shape rather than falling back to a shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-shim-bad-"));
  try {
    const shimPath = path.join(dir, "mystery.cmd");
    fs.writeFileSync(shimPath, "@ECHO off\r\necho this shim does not match any known pattern\r\n");
    assert.throws(
      () => withPlatform("win32", () => resolveExecutableForSpawn(shimPath)),
      ExecutableNotFoundError,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveExecutableForSpawn: throws (does not silently fall back) when the command cannot be found at all", () => {
  assert.throws(
    () => withPlatform("win32", () => resolveExecutableForSpawn("definitely-not-a-real-command-xyz")),
    ExecutableNotFoundError,
  );
});

test("killProcessTree: terminates a real process AND a grandchild it spawned", async () => {
  const grandchildScript = "setInterval(() => {}, 1000);";
  const parentScript = `
    const { spawn } = require('node:child_process');
    const gc = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
    console.log('GRANDCHILD_PID:' + gc.pid);
    setInterval(() => {}, 1000);
  `;

  const parent = spawn(process.execPath, ["-e", parentScript], { stdio: ["ignore", "pipe", "ignore"] });
  assert.ok(parent.pid, "parent process must have a pid");

  const grandchildPid: number = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for grandchild pid")), 5000);
    parent.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const match = buf.match(/GRANDCHILD_PID:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });

  assert.ok(isAlive(parent.pid!), "parent should be alive before kill");
  assert.ok(isAlive(grandchildPid), "grandchild should be alive before kill");

  killProcessTree(parent.pid, "SIGKILL");

  // Termination is not instantaneous (especially taskkill on Windows) --
  // poll briefly rather than asserting immediately.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (isAlive(parent.pid!) || isAlive(grandchildPid))) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(isAlive(parent.pid!), false, "parent must be terminated");
  assert.equal(isAlive(grandchildPid), false, "grandchild must be terminated too -- this is the process-tree cleanup guarantee");
});

test("killProcessTree: a non-existent pid is a safe no-op", () => {
  assert.doesNotThrow(() => killProcessTree(999999, "SIGKILL"));
});

test("killProcessTree: null/undefined/zero pid is a safe no-op", () => {
  assert.doesNotThrow(() => killProcessTree(null, "SIGKILL"));
  assert.doesNotThrow(() => killProcessTree(undefined, "SIGKILL"));
  assert.doesNotThrow(() => killProcessTree(0, "SIGKILL"));
});

test("resolveCommandPath + resolveExecutableForSpawn: real Codex CLI on this machine resolves to a genuinely spawnable target", { skip: process.platform !== "win32" }, async () => {
  const resolvedPath = resolveCommandPath("codex");
  assert.ok(resolvedPath, "codex must be found on PATH for this runtime-verification test to be meaningful");

  const { command, prependArgs } = resolveExecutableForSpawn(resolvedPath);
  assert.ok(fs.existsSync(command), `resolved command must exist on disk: ${command}`);

  const child = spawn(command, [...prependArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(exitCode, 0, "codex --version must exit cleanly via the resolved executable (no ENOENT)");
});

test("resolveCommandPath + resolveExecutableForSpawn: real Claude Code CLI on this machine resolves to a genuinely spawnable target", { skip: process.platform !== "win32" }, async () => {
  const resolvedPath = resolveCommandPath("claude");
  assert.ok(resolvedPath, "claude must be found on PATH for this runtime-verification test to be meaningful");

  const { command, prependArgs } = resolveExecutableForSpawn(resolvedPath);
  assert.ok(fs.existsSync(command), `resolved command must exist on disk: ${command}`);

  const child = spawn(command, [...prependArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(exitCode, 0, "claude --version must exit cleanly via the resolved executable (no ENOENT)");
});

test("resolveCommandPath + resolveExecutableForSpawn: real openclaude CLI on this machine resolves to a genuinely spawnable target", { skip: process.platform !== "win32" }, async () => {
  const resolvedPath = resolveCommandPath("openclaude");
  assert.ok(resolvedPath, "openclaude must be found on PATH for this runtime-verification test to be meaningful");

  const { command, prependArgs } = resolveExecutableForSpawn(resolvedPath);
  assert.ok(fs.existsSync(command), `resolved command must exist on disk: ${command}`);

  const child = spawn(command, [...prependArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(exitCode, 0, "openclaude --version must exit cleanly via the resolved executable (no ENOENT)");
});

test("isProcessAlive: true for this process's own pid, false for a definitely-dead one", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);
});

test("isProcessAlive: null/undefined/0/negative are all treated as not alive, not errors", () => {
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-5), false);
});

test("getProcessCommandLine: a real live process's command line contains an identifying marker, and reads null once it's gone", async () => {
  const marker = `luma-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", marker], {
    stdio: "ignore",
  });
  assert.ok(child.pid, "child must have a pid");

  // Give the OS a moment to make the command line queryable.
  await new Promise((r) => setTimeout(r, 300));

  const commandLine = getProcessCommandLine(child.pid!);
  assert.ok(commandLine, "must be able to read the command line of a real live process");
  assert.ok(
    commandLine!.includes(marker),
    `command line should contain the marker argument; got: ${commandLine}`,
  );

  killProcessTree(child.pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(child.pid!)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(isProcessAlive(child.pid!), false, "child must actually be dead before checking the null case");
  assert.equal(getProcessCommandLine(child.pid!), null, "a dead pid must read as null, not throw or return stale data");
});

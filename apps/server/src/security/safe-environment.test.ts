import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSafeBaseEnv } from "./safe-environment.js";

test("pickSafeBaseEnv: excludes secret-shaped variables even though they are present in the source env", () => {
  const source = {
    PATH: "/usr/bin",
    PASSWORD: "hunter2",
    JWT_SECRET: "topsecret",
    TASK_MANAGER_JWT_SECRET: "alsosecret",
    TELEGRAM_BOT_TOKEN: "123456:abc",
    ANTHROPIC_API_KEY: "sk-ant-xyz",
    RANDOM_APP_SPECIFIC_SECRET_NAME_NOBODY_ANTICIPATED: "still-excluded-by-allowlist-shape",
  };
  const result = pickSafeBaseEnv(source);
  assert.equal(result.PASSWORD, undefined);
  assert.equal(result.JWT_SECRET, undefined);
  assert.equal(result.TASK_MANAGER_JWT_SECRET, undefined);
  assert.equal(result.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.RANDOM_APP_SPECIFIC_SECRET_NAME_NOBODY_ANTICIPATED, undefined);
});

test("pickSafeBaseEnv: includes what a process actually needs to function", () => {
  const source = { PATH: "/usr/bin:/bin", TEMP: "/tmp", USERPROFILE: "C:\\Users\\test", NODE_ENV: "production" };
  const result = pickSafeBaseEnv(source);
  assert.equal(result.PATH, "/usr/bin:/bin");
  assert.equal(result.TEMP, "/tmp");
  assert.equal(result.USERPROFILE, "C:\\Users\\test");
  assert.equal(result.NODE_ENV, "production");
});

test("pickSafeBaseEnv: never mutates the source object", () => {
  const source = { PATH: "/usr/bin", PASSWORD: "hunter2" };
  const before = { ...source };
  pickSafeBaseEnv(source);
  assert.deepEqual(source, before);
});

test("pickSafeBaseEnv: defaults to this process's real env and is safe to call with no arguments", () => {
  const result = pickSafeBaseEnv();
  assert.ok(typeof result === "object");
  // Whatever this real process's PATH is, it must survive the allowlist.
  if (process.env.PATH) assert.equal(result.PATH, process.env.PATH);
});

test("pickSafeBaseEnv: an empty source env produces an empty result, not an error", () => {
  const result = pickSafeBaseEnv({});
  assert.deepEqual(result, {});
});

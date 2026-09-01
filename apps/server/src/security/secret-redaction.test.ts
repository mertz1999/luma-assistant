import { test } from "node:test";
import assert from "node:assert/strict";
import { redactKnownSecretValues } from "./secret-redaction.js";

test("redactKnownSecretValues: replaces every occurrence of a known secret value with [REDACTED]", () => {
  const text = "DATABASE_PASSWORD=my-real-secret\nsome other line\nmy-real-secret appears again";
  const result = redactKnownSecretValues(text, ["my-real-secret"]);
  assert.equal(result, "DATABASE_PASSWORD=[REDACTED]\nsome other line\n[REDACTED] appears again");
  assert.ok(!result.includes("my-real-secret"));
});

test("redactKnownSecretValues: redacts multiple distinct known values in the same text", () => {
  const text = "A=value-a B=value-b unrelated=safe";
  const result = redactKnownSecretValues(text, ["value-a", "value-b"]);
  assert.equal(result, "A=[REDACTED] B=[REDACTED] unrelated=safe");
});

test("redactKnownSecretValues: text with no matching secret is returned unchanged", () => {
  const text = "nothing sensitive here";
  assert.equal(redactKnownSecretValues(text, ["some-secret"]), text);
});

test("redactKnownSecretValues: empty secret list is a no-op", () => {
  const text = "some text";
  assert.equal(redactKnownSecretValues(text, []), text);
});

test("redactKnownSecretValues: ignores empty-string secret values (would otherwise corrupt every character boundary)", () => {
  const text = "hello world";
  assert.equal(redactKnownSecretValues(text, ["", "unrelated"]), text);
});

test("redactKnownSecretValues: does not reveal length/prefix/suffix -- the whole value becomes exactly '[REDACTED]' regardless of original length", () => {
  const short = redactKnownSecretValues("x=ab", ["ab"]);
  const long = redactKnownSecretValues("x=abcdefghijklmnopqrstuvwxyz", ["abcdefghijklmnopqrstuvwxyz"]);
  assert.equal(short, "x=[REDACTED]");
  assert.equal(long, "x=[REDACTED]");
});

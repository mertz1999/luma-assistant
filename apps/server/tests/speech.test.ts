import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicSpeechAddress, transcriptionEndpoint } from "../src/speech.js";

test("transcription appends the OpenAI-compatible route to a provider's full base path", () => {
  assert.equal(transcriptionEndpoint("https://ai.liara.ir/api/example/v1/").href,
    "https://ai.liara.ir/api/example/v1/audio/transcriptions");
  assert.throws(() => transcriptionEndpoint("http://example.com/v1"), /HTTPS/);
  assert.throws(() => transcriptionEndpoint("https://user:password@example.com/v1"), /credentials/);
  assert.throws(() => transcriptionEndpoint("https://example.com/v1?ignored=1"), /query/);
});

test("transcription rejects private and loopback destinations, including mapped IPv6", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "::1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe"]) {
    assert.equal(isPublicSpeechAddress(address), false, address);
  }
  assert.equal(isPublicSpeechAddress("8.8.8.8"), true);
  assert.equal(isPublicSpeechAddress("2606:4700:4700::1111"), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  resolveQwythosEndpoint,
  resolveQwythosExecutable,
  buildQwythosEnvironment,
  checkQwythosEndpointReachable,
  DEFAULT_QWYTHOS_MODEL,
} from "./qwythos-config.js";

// -- resolveQwythosEndpoint ---------------------------------------------------

test("resolveQwythosEndpoint: defaults to the local llama-server endpoint when QWYTHOS_ENDPOINT is unset", () => {
  const original = process.env.QWYTHOS_ENDPOINT;
  delete process.env.QWYTHOS_ENDPOINT;
  try {
    assert.equal(resolveQwythosEndpoint(), "http://127.0.0.1:8080/v1");
  } finally {
    if (original === undefined) delete process.env.QWYTHOS_ENDPOINT;
    else process.env.QWYTHOS_ENDPOINT = original;
  }
});

test("resolveQwythosEndpoint: respects an explicit QWYTHOS_ENDPOINT override, trimmed", () => {
  const original = process.env.QWYTHOS_ENDPOINT;
  process.env.QWYTHOS_ENDPOINT = "  http://127.0.0.1:9090/v1  ";
  try {
    assert.equal(resolveQwythosEndpoint(), "http://127.0.0.1:9090/v1");
  } finally {
    if (original === undefined) delete process.env.QWYTHOS_ENDPOINT;
    else process.env.QWYTHOS_ENDPOINT = original;
  }
});

test("resolveQwythosEndpoint: a whitespace-only override still falls back to the local default, never resolving to a blank endpoint", () => {
  // Regression coverage for a real bug found during hardening review: the
  // original `(process.env.QWYTHOS_ENDPOINT || default).trim()` trimmed
  // AFTER the fallback check, so a whitespace-only value (truthy, so it
  // survives the `||`) trimmed down to "" -- handing
  // buildQwythosEnvironment() a blank OPENAI_BASE_URL instead of the local
  // default. That is exactly the "resolves to nothing" failure mode this
  // module's Phase 10 guarantee exists to prevent.
  const original = process.env.QWYTHOS_ENDPOINT;
  process.env.QWYTHOS_ENDPOINT = "   ";
  try {
    assert.equal(resolveQwythosEndpoint(), "http://127.0.0.1:8080/v1");
  } finally {
    if (original === undefined) delete process.env.QWYTHOS_ENDPOINT;
    else process.env.QWYTHOS_ENDPOINT = original;
  }
});

// -- buildQwythosEnvironment: no-cloud-fallback guarantee --------------------
// Phase 10 of the qwythos-runner task explicitly calls out "a generic
// OpenAI-compatible client that defaults to OpenAI when base_url is missing"
// as unacceptable. These tests pin that the four OpenAI-compat vars are
// always set explicitly, and that a cloud key already sitting in
// process.env is never inherited into the built environment.

test("buildQwythosEnvironment: sets OPENAI_BASE_URL to the local endpoint, never blank/unset", () => {
  const env = buildQwythosEnvironment("qwythos-9b-q6", "http://127.0.0.1:8080/v1");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:8080/v1");
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, "1");
  assert.equal(env.OPENAI_MODEL, "qwythos-9b-q6");
  assert.equal(env.OPENAI_API_KEY, "not-needed-local");
});

test("buildQwythosEnvironment: never inherits a real ANTHROPIC_API_KEY or OPENAI_API_KEY from process.env, even if one is set", () => {
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-leak";
  process.env.OPENAI_API_KEY = "sk-openai-should-never-leak";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  try {
    const env = buildQwythosEnvironment(DEFAULT_QWYTHOS_MODEL, "http://127.0.0.1:8080/v1");
    assert.equal(env.OPENAI_API_KEY, "not-needed-local", "must use the local placeholder key, never a real inherited cloud key");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:8080/v1", "must use the explicit local endpoint, never the inherited cloud base URL");
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "the safe-base allowlist must not carry ANTHROPIC_API_KEY through at all");
  } finally {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBaseUrl;
  }
});

test("buildQwythosEnvironment: with no explicit endpoint argument, falls through to resolveQwythosEndpoint()'s local default", () => {
  const original = process.env.QWYTHOS_ENDPOINT;
  delete process.env.QWYTHOS_ENDPOINT;
  try {
    const env = buildQwythosEnvironment("qwythos-9b-q6");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:8080/v1");
  } finally {
    if (original === undefined) delete process.env.QWYTHOS_ENDPOINT;
    else process.env.QWYTHOS_ENDPOINT = original;
  }
});

// -- checkQwythosEndpointReachable -------------------------------------------
// This is what makes a run fail as QWYTHOS_LOCAL_UNAVAILABLE (in index.ts's
// startQwythosExecution) instead of silently hanging or falling back.

test("checkQwythosEndpointReachable: connection-refused endpoint reports ok:false with a clear reason", async () => {
  // Nothing is listening on this high, unlikely-to-be-bound local port.
  const result = await checkQwythosEndpointReachable("http://127.0.0.1:8099/v1", 2000);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /connection failed/);
  }
});

test("checkQwythosEndpointReachable: a non-responsive listener reports ok:false with a timeout reason", async () => {
  // A raw TCP server that accepts the connection but never responds with
  // HTTP -- forces the fetch to hang until the AbortController timeout.
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      /* deliberately never respond */
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  try {
    const result = await checkQwythosEndpointReachable(`http://127.0.0.1:${port}/v1`, 500);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /timeout/);
    }
  } finally {
    server.close();
  }
});

test("checkQwythosEndpointReachable: a listener that responds with a non-2xx status reports ok:false with the status in the reason", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "model still loading" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  try {
    const result = await checkQwythosEndpointReachable(`http://127.0.0.1:${port}/v1`, 2000);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /503/);
    }
  } finally {
    server.close();
  }
});

test("checkQwythosEndpointReachable: a real, healthy HTTP endpoint reports ok:true", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwythos-9b-q6" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  try {
    const result = await checkQwythosEndpointReachable(`http://127.0.0.1:${port}/v1`, 2000);
    assert.equal(result.ok, true);
  } finally {
    server.close();
  }
});

// -- resolveQwythosExecutable -------------------------------------------------

test("resolveQwythosExecutable: an explicit configured path is returned as-is, trimmed", () => {
  assert.equal(resolveQwythosExecutable("  C:\\tools\\openclaude.cmd  "), "C:\\tools\\openclaude.cmd");
});

test("resolveQwythosExecutable: a whitespace-only configured value is treated as unconfigured, falling back to PATH resolution", () => {
  assert.doesNotThrow(() => resolveQwythosExecutable("   "));
});

test("resolveQwythosExecutable: with nothing configured, falls back to PATH resolution and never throws", () => {
  // Whether or not `openclaude` is actually on PATH in this environment,
  // resolution must not throw -- resolveExecutableForSpawn (in index.ts) is
  // what's responsible for surfacing a clear failure later, not this step.
  assert.doesNotThrow(() => resolveQwythosExecutable(undefined));
});

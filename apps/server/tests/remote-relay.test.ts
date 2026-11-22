import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { RemoteRelay } from "../src/remote-relay.js";

test("pairs one Mac per code and relays only allowed requests to a live device", async () => {
  const relay = new RemoteRelay(":memory:", "fixture-secret");
  const app = express().use(express.json());
  app.use("/api/remote/device", relay.pairing);
  app.use((req, res, next) => {
    if (req.headers.authorization === "Bearer browser-fixture") res.locals.cloudSessionToken = "fixture";
    next();
  });
  app.use("/api/remote", relay.devices);
  const server = app.listen(0, "127.0.0.1");
  relay.attach(server);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/remote`;
  const call = (route: string, method = "GET", body?: object, token = "browser-fixture") => fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let mac: WebSocket | undefined;
  try {
    assert.equal((await call("/pair", "POST", undefined, "anonymous")).status, 401);
    const { data: { code } } = await (await call("/pair", "POST")).json();
    const redeem = { code, name: "Fixture Mac" };
    const pair = await call("/device/redeem", "POST", redeem, "anonymous");
    assert.equal(pair.status, 200);
    const { data: { id, token } } = await pair.json();
    assert.equal((await call("/device/redeem", "POST", redeem)).status, 403);
    assert.equal((await call("/devices", "GET", undefined, token)).status, 401);
    const devicePath = `/devices/${id}`;
    const sessions = { kind: "sessions" };
    const followup = { kind: "send", text: "A follow-up", clientMessageId: randomUUID(), sessionId: "session-1" };
    assert.equal((await call(`${devicePath}/request`, "POST", sessions)).status, 503);
    mac = new WebSocket(base.replace("http:", "ws:") + "/connect", { headers: { Authorization: `Bearer ${token}` } });
    await once(mac, "open");
    mac.send(JSON.stringify({ kind: "ready", canControl: false }));
    await waitForControl(false);
    assert.equal((await call(`${devicePath}/request`, "POST", followup)).status, 403);
    const view = call(`${devicePath}/request`, "POST", sessions);
    const [viewCommand] = await once(mac, "message");
    const viewFrame = JSON.parse(viewCommand.toString());
    assert.equal(viewFrame.command.kind, "sessions");
    mac.send(JSON.stringify({ kind: "result", id: viewFrame.id, ok: true, data: { items: [], nextCursor: null } }));
    assert.deepEqual(await (await view).json(), { ok: true, data: { items: [], nextCursor: null } });

    mac.send(JSON.stringify({ kind: "ready", canControl: true }));
    await waitForControl(true);
    const invalid = await call(`${devicePath}/request`, "POST", { ...followup, workspace: "/not-shared" });
    assert.equal(invalid.status, 400);
    const sending = call(`${devicePath}/request`, "POST", followup);
    const [sendCommand] = await once(mac, "message");
    const sendFrame = JSON.parse(sendCommand.toString());
    assert.deepEqual(sendFrame.command, followup);
    mac.send(JSON.stringify({ kind: "result", id: sendFrame.id, ok: true, data: { accepted: true } }));
    assert.deepEqual(await (await sending).json(), { ok: true, data: { accepted: true } });

    const pending = call(`${devicePath}/request`, "POST", sessions);
    await once(mac, "message");
    const closed = once(mac, "close");
    assert.equal((await call(devicePath, "DELETE")).status, 200);
    assert.equal((await pending).status, 503);
    assert.equal((await closed)[0], 4003);
    assert.equal((await call("/device/self", "DELETE", undefined, token)).status, 401);
  } finally {
    mac?.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  async function waitForControl(value: boolean): Promise<void> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const { data: { devices } } = await (await call("/devices")).json();
      if (devices[0]?.online && devices[0].canControl === value) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Device did not announce its access mode");
  }
});

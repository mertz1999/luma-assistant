import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelCatalogService, discoverCliModels, parseClaudeModels, parseCodexModels } from "../src/model-catalog.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luma-catalog-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    options: {
      cwd: root, cachePath: path.join(root, "models.json"),
      codex: { executable: "codex", defaultModel: "configured-codex", env: () => ({ HOME: root }) },
      claude: { executable: "claude", defaultModel: "sonnet", env: () => ({ HOME: root }) },
    },
    cli(body: string) {
      const file = path.join(root, "fake-cli.cjs");
      fs.writeFileSync(file, `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');\n${body}`, { mode: 0o700 });
      return { executable: file, defaultModel: "unused", env: () => ({ ...process.env }) };
    },
  };
}

test("parsers retain capabilities, filter hidden entries, and deduplicate IDs", () => {
  assert.deepEqual(parseCodexModels([
    { model: "future-model", displayName: "Future", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }, { reasoningEffort: "invalid" }], defaultReasoningEffort: "ultra" },
    { model: "secret", hidden: true }, { unrelated: true },
  ]), [{ id: "future-model", displayName: "Future", supportedEfforts: ["ultra"], supportsEffort: true, defaultEffort: "ultra" }]);
  const claude = parseClaudeModels([{ value: "fable", resolvedModel: "claude-fable-new", displayName: "Fable", supportedEffortLevels: ["max"], supportsEffort: true }, { value: "fable" }]);
  assert.equal(claude.length, 1);
  assert.throws(() => parseClaudeModels({}), /invalid/);
});

test("concurrent refreshes coalesce; failures retain last successful catalog across restart", async t => {
  const { options } = setup(t);
  let calls = 0;
  let fail = false;
  const service = new ModelCatalogService({ ...options, discover: async runner => {
    calls++;
    await new Promise(r => setTimeout(r, 5));
    if (fail) throw new Error("offline");
    return { models: [{ id: `${runner}-new`, displayName: "New" }], cliVersion: "1.2.3" };
  } });
  await Promise.all([service.refresh(true), service.refresh(true)]);
  assert.equal(calls, 2);
  assert.equal(service.snapshot().claude.source, "live");
  const updatedAt = service.snapshot().claude.updatedAt;
  await service.refresh();
  assert.equal(calls, 2, "fresh reads do not respawn CLIs");
  fail = true;
  await service.refresh(true, "claude");
  assert.equal(service.snapshot().claude.source, "cache");
  assert.equal(service.snapshot().claude.updatedAt, updatedAt);
  assert.equal(service.snapshot().claude.error, "offline");
  const reloaded = new ModelCatalogService(options);
  assert.equal(reloaded.snapshot().claude.source, "cache");
  assert.equal(reloaded.snapshot().claude.models[0].id, "claude-new");
  const changed = new ModelCatalogService({ ...options, claude: { ...options.claude, executable: "different-claude" } });
  assert.equal(changed.snapshot().claude.source, "fallback", "cache is scoped to runner executable and config home");
});

test("corrupt cache and unavailable runner do not remove fallback or block the other runner", async t => {
  const { options } = setup(t);
  fs.writeFileSync(options.cachePath, "not json");
  const service = new ModelCatalogService({ ...options, discover: async runner => {
    if (runner === "claude") throw new Error("not installed");
    return { models: [{ id: "new-codex", displayName: "New Codex" }], cliVersion: null };
  } });
  await service.refresh();
  assert.equal(service.snapshot().codex.source, "live");
  assert.equal(service.snapshot().claude.source, "fallback");
  assert.equal(service.snapshot().claude.models[0].id, "sonnet");
  assert.equal(service.snapshot().claude.refreshing, false);
});

test("Codex handshake pages through catalog without creating a thread or turn", async t => {
  const { root, cli } = setup(t);
  const config = cli(`rl.on('line', l=>{const m=JSON.parse(l);if(m.method==='initialize')send({id:m.id,result:{}});else if(m.method==='initialized'){}else if(m.method==='model/list'){send({id:m.id,result:{data:[{model:m.params.cursor?'second':'first',displayName:'Model'}],nextCursor:m.params.cursor?null:'page2'}});}else process.exit(9);});`);
  const result = await discoverCliModels("codex", config, root, 10000);
  assert.deepEqual(result.map(m => m.id), ["first", "second"]);
});

test("Claude initialize reads resolved aliases and never sends a user prompt", async t => {
  const { root, cli } = setup(t);
  const config = cli(`rl.on('line',l=>{const m=JSON.parse(l);if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(9);send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'sonnet',resolvedModel:'claude-sonnet-new',displayName:'Sonnet',supportedEffortLevels:['high']}]}}});});`);
  const result = await discoverCliModels("claude", config, root, 10000);
  assert.equal(result[0].resolvedModel, "claude-sonnet-new");
  assert.deepEqual(result[0].supportedEfforts, ["high"]);
});

test("timeout, missing executable, and CLI protocol errors produce useful failures", async t => {
  const { root, cli, options } = setup(t);
  await assert.rejects(discoverCliModels("claude", { ...options.claude, executable: path.join(root, "missing") }, root, 200), /ENOENT/);
  await assert.rejects(discoverCliModels("codex", cli("setInterval(()=>{},1000);"), root, 100), /timed out/);
  await assert.rejects(discoverCliModels("codex", cli("rl.on('line',l=>send({id:JSON.parse(l).id,error:{code:-1}}));"), root, 10000), /rejected initialization/);
});

test("repeated pagination cursor is rejected rather than looping forever", async t => {
  const { root, cli } = setup(t);
  const config = cli(`rl.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='model/list')send({id:m.id,result:{data:[{model:'a'}],nextCursor:'same'}});});`);
  await assert.rejects(discoverCliModels("codex", config, root, 10000), /pagination/);
});

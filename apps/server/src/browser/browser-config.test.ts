import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrowserConfigText, resolveProjectBrowserPermission } from "./browser-config.js";

test("no browser: block at all -> fully disabled, safe default", () => {
  const config = parseBrowserConfigText("default_workspace: C:\\projects\\luma-assistant\n\nrepos:\n  dalilfinance: C:\\Dalilfinance\n");
  assert.equal(config.enabled, false);
  assert.equal(config.defaultPermission, "READ_ONLY_BROWSER");
  assert.equal(config.projectPermissions.size, 0);
});

test("browser: block with enabled: true and per-project permissions parses correctly", () => {
  const text = [
    "default_workspace: C:\\projects\\luma-assistant",
    "",
    "browser:",
    "  enabled: true",
    "  provider: browseract",
    "  default_permission: read_only",
    "  project_permissions:",
    "    dalilfinance: read_only",
    "    botolaiq: read_only",
    "",
    "repos:",
    "  dalilfinance: C:\\Dalilfinance",
  ].join("\n");
  const config = parseBrowserConfigText(text);
  assert.equal(config.enabled, true);
  assert.equal(config.provider, "browseract");
  assert.equal(config.defaultPermission, "READ_ONLY_BROWSER");
  assert.equal(config.projectPermissions.get("dalilfinance"), "READ_ONLY_BROWSER");
  assert.equal(config.projectPermissions.get("botolaiq"), "READ_ONLY_BROWSER");
});

test("project name lookup is case-insensitive", () => {
  const text = "browser:\n  enabled: true\n  project_permissions:\n    dalilfinance: authenticated_read\n";
  const config = parseBrowserConfigText(text);
  assert.equal(config.projectPermissions.get("dalilfinance"), "AUTHENTICATED_READ");
});

test("a malformed permission value is ignored, not defaulted to a permissive tier", () => {
  const text = "browser:\n  enabled: true\n  default_permission: nonsense\n";
  const config = parseBrowserConfigText(text);
  assert.equal(config.defaultPermission, "READ_ONLY_BROWSER");
});

test("resolveProjectBrowserPermission returns null (deny) when the browser capability is disabled entirely", () => {
  const config = parseBrowserConfigText("browser:\n  enabled: false\n  project_permissions:\n    dalilfinance: browser_write\n");
  assert.equal(resolveProjectBrowserPermission(config, "dalilfinance"), null);
});

test("resolveProjectBrowserPermission returns the project's explicit tier when enabled", () => {
  const config = parseBrowserConfigText("browser:\n  enabled: true\n  default_permission: read_only\n  project_permissions:\n    dalilfinance: authenticated_read\n");
  assert.equal(resolveProjectBrowserPermission(config, "dalilfinance"), "AUTHENTICATED_READ");
  assert.equal(resolveProjectBrowserPermission(config, "dalilfinance"), "AUTHENTICATED_READ");
});

test("resolveProjectBrowserPermission falls back to default_permission for a project with no explicit entry", () => {
  const config = parseBrowserConfigText("browser:\n  enabled: true\n  default_permission: read_only\n");
  assert.equal(resolveProjectBrowserPermission(config, "some-other-project"), "READ_ONLY_BROWSER");
});

test("a second top-level block after browser: correctly ends parsing of the browser: section", () => {
  const text = "browser:\n  enabled: true\n  project_permissions:\n    dalilfinance: browser_write\nrepos:\n  dalilfinance: C:\\Dalilfinance\n";
  const config = parseBrowserConfigText(text);
  assert.equal(config.enabled, true);
  assert.equal(config.projectPermissions.get("dalilfinance"), "BROWSER_WRITE");
});

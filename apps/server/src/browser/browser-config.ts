import fs from "node:fs";
import type { BrowserPermissionTier } from "./browser-policy.js";

/**
 * Minimal, additive parser for an optional `browser:` block in
 * config.yaml, following the exact hand-rolled line-scanning style
 * index.ts's resolveConfigWorkspaces() already uses for `repos:` (no
 * YAML library dependency introduced for this). Deliberately a separate
 * function reading the same file rather than a change to
 * resolveConfigWorkspaces itself -- that function is already covered by
 * existing behavior other code depends on; this only adds a new,
 * independent read path so it cannot regress anything there.
 *
 * Expected shape (all keys optional; absence is a safe, fully-disabled
 * default):
 *
 *   browser:
 *     enabled: false
 *     provider: browseract
 *     default_permission: read_only
 *     project_permissions:
 *       dalilfinance: read_only
 *       botolaiq: read_only
 *
 * project_permissions is keyed by the SAME project name used in
 * config.yaml's repos: map (lowercased for lookup), not a second,
 * parallel project registry -- there is exactly one place a project name
 * is defined in this file.
 */

export interface BrowserConfig {
  enabled: boolean;
  provider: string;
  defaultPermission: BrowserPermissionTier;
  /** Keyed by lowercased project name (matches index.ts's projectRegistry() keying convention). */
  projectPermissions: Map<string, BrowserPermissionTier>;
}

const SAFE_DEFAULT: BrowserConfig = {
  enabled: false,
  provider: "browseract",
  defaultPermission: "READ_ONLY_BROWSER",
  projectPermissions: new Map(),
};

function parsePermissionValue(raw: string): BrowserPermissionTier | null {
  switch (raw.trim().toLowerCase()) {
    case "read_only":
    case "read-only":
    case "read_only_browser":
      return "READ_ONLY_BROWSER";
    case "authenticated_read":
    case "authenticated-read":
      return "AUTHENTICATED_READ";
    case "browser_write":
    case "browser-write":
    case "write":
      return "BROWSER_WRITE";
    default:
      return null;
  }
}

/** Parses already-loaded config.yaml text. Exported separately from parseBrowserConfigFile so tests never need a real file on disk. */
export function parseBrowserConfigText(text: string): BrowserConfig {
  const lines = text.split(/\r?\n/);
  const result: BrowserConfig = {
    enabled: SAFE_DEFAULT.enabled,
    provider: SAFE_DEFAULT.provider,
    defaultPermission: SAFE_DEFAULT.defaultPermission,
    projectPermissions: new Map(),
  };

  let inBrowser = false;
  let inProjectPermissions = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const top = /^\S/.test(line) && line.trim().length > 0;

    if (top) {
      inBrowser = line.trim() === "browser:";
      inProjectPermissions = false;
      continue;
    }
    if (!inBrowser) continue;

    // A line indented by exactly 2 spaces is a direct child of `browser:`.
    const childMatch = line.match(/^\s{2}(\S[^:]*):\s*(.*)$/);
    if (childMatch) {
      const key = childMatch[1].trim();
      const value = childMatch[2].trim().replace(/^['"]|['"]$/g, "");
      inProjectPermissions = key === "project_permissions" && value === "";
      if (inProjectPermissions) continue;

      if (key === "enabled") result.enabled = value.toLowerCase() === "true";
      else if (key === "provider" && value) result.provider = value;
      else if (key === "default_permission" && value) {
        const parsed = parsePermissionValue(value);
        if (parsed) result.defaultPermission = parsed;
      }
      continue;
    }

    if (!inProjectPermissions) continue;
    // A line indented by 4 spaces under project_permissions: is one project's tier.
    const projectMatch = line.match(/^\s{4}([^:]+):\s*(.+)$/);
    if (!projectMatch) continue;
    const name = projectMatch[1].trim().toLowerCase();
    const parsed = parsePermissionValue(projectMatch[2].trim().replace(/^['"]|['"]$/g, ""));
    if (parsed) result.projectPermissions.set(name, parsed);
  }

  return result;
}

export function parseBrowserConfigFile(configPath: string): BrowserConfig {
  if (!fs.existsSync(configPath)) return SAFE_DEFAULT;
  try {
    return parseBrowserConfigText(fs.readFileSync(configPath, "utf8"));
  } catch {
    // A malformed/unreadable config must never crash server startup or
    // silently grant access -- fail closed to the fully-disabled default.
    return SAFE_DEFAULT;
  }
}

/**
 * Resolves the effective permission tier for one project: its own
 * explicit entry if present, else the block's default_permission, and
 * null (never a tier) when the whole browser capability is disabled --
 * evaluateBrowserActionPolicy already treats null as deny, so disabling
 * the feature and "no permission configured" both fail closed the same
 * way, by construction, without a second disabled-check at every call
 * site.
 */
export function resolveProjectBrowserPermission(config: BrowserConfig, projectName: string): BrowserPermissionTier | null {
  if (!config.enabled) return null;
  return config.projectPermissions.get(projectName.trim().toLowerCase()) ?? config.defaultPermission;
}

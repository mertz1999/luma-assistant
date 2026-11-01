import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = process.cwd();
const fixture =
  process.env.PI_BROWSER_FIXTURE_DIR ||
  (process.env.PI_BROWSER_FIXTURE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "luma-pi-browser-"),
  ));
fs.cpSync(path.join(root, "agents"), path.join(fixture, "agents"), {
  recursive: true,
});
export default defineConfig({
  testDir: "tests/pi",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:19175",
    viewport: { width: 1440, height: 1000 },
    channel: process.env.PI_BROWSER_CHANNEL || "chromium",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx apps/server/src/index.ts",
      url: "http://127.0.0.1:19191/api/cowork/pi-clarification/status",
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        INIT_CWD: fixture,
        HOST: "127.0.0.1",
        API_PORT: "19191",
        WEB_PORT: "19175",
        PASSWORD: "pi-browser-test-only",
        APP_PASSWORD: "pi-browser-test-only",
        PI_CLARIFICATION_ENABLED: "false",
        PI_CLARIFICATION_SEND_LOCK: "true",
        PI_CLARIFICATION_MODE: "draft_only",
        PI_GMAIL_MAILBOX: "admin@proimagetx.ai",
        PI_GMAIL_REFRESH_TOKEN: "",
        PI_CREDENTIAL_ENCRYPTION_KEY: "",
        PI_REASONER_URL: "",
        PI_INVESTIGATOR_URL: "",
      },
    },
    {
      command: "npm run dev -w @luma/web -- --host 127.0.0.1",
      url: "http://127.0.0.1:19175",
      reuseExistingServer: false,
      timeout: 60000,
      env: { API_PORT: "19191", WEB_PORT: "19175" },
    },
  ],
});

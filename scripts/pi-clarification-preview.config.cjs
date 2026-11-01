const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const configured = dotenv.parse(
  fs.existsSync(envPath) ? fs.readFileSync(envPath) : "",
);
const safeKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "CODEX_PATH",
  "CLAUDE_CODE_EXECUTABLE",
];
const inherited = Object.fromEntries(
  safeKeys
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
const env = {
  ...inherited,
  ...configured,
  INIT_CWD: root,
  NODE_ENV: "production",
};
module.exports = {
  apps: [
    {
      name: "luma-pi-test-server",
      cwd: root,
      script: path.join(root, "apps/server/dist/index.js"),
      env,
      autorestart: true,
      restart_delay: 2000,
      time: true,
      out_file: path.join(root, "data/logs/pi-test-server.out.log"),
      error_file: path.join(root, "data/logs/pi-test-server.err.log"),
    },
    {
      name: "luma-pi-test-web",
      cwd: path.join(root, "apps/web"),
      script: path.join(root, "node_modules/vite/bin/vite.js"),
      args: "preview --host 0.0.0.0 --port 19075 --strictPort",
      env,
      autorestart: true,
      restart_delay: 2000,
      time: true,
      out_file: path.join(root, "data/logs/pi-test-web.out.log"),
      error_file: path.join(root, "data/logs/pi-test-web.err.log"),
    },
  ],
};

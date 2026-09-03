const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(root, '.env') });

const apiPort = String(process.env.API_PORT || '9001');
const webPort = String(process.env.WEB_PORT || '5175');
const telegramMcpPort = String(process.env.TELEGRAM_MCP_PORT || '9013');
const taskManagerMcpPort = String(process.env.TASK_MANAGER_MCP_PORT || '9014');
const imageMcpPort = String(process.env.IMAGE_MCP_PORT || '9015');
const host = process.env.HOST || '0.0.0.0';

function isEnabled(raw, defaultEnabled = false) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return defaultEnabled;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

// Opt-in: taskmanager MCP is heavy; keep off unless explicitly enabled.
const enableTaskManagerMcp = isEnabled(process.env.ENABLE_TASK_MANAGER_MCP, false);

// PM2's `script: 'npm', args: 'run ...'` pattern crash-loops on Windows:
// npm's own global entrypoint is `npm.cmd` (a batch/shim file), and PM2
// hands that path straight to Node's module loader, which tries to parse
// the batch script as JavaScript and fails immediately on `:: comment`
// syntax ("SyntaxError: Unexpected token ':'") -- observed directly on
// this machine, 11 restarts in seconds. This is the exact same class of
// bug as functions/../process-utils.ts's Windows .cmd-shim handling for
// Codex/Claude, just hitting PM2 itself instead. Fix: point every app at
// its real compiled entrypoint (or vite's own .js binary) and spawn node
// directly, bypassing npm/vite shims entirely -- also PM2's more typical
// usage pattern regardless of platform.
const nodeExe = process.execPath;
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const apps = [
  {
    name: 'luma-assistant-server',
    cwd: path.join(root, 'apps', 'server'),
    script: nodeExe,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      API_PORT: apiPort,
      WEB_PORT: webPort,
      HOST: host,
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1500,
    time: true,
    out_file: path.join(root, 'data', 'logs', 'server.out.log'),
    error_file: path.join(root, 'data', 'logs', 'server.err.log'),
  },
  {
    name: 'luma-assistant-web',
    cwd: path.join(root, 'apps', 'web'),
    script: nodeExe,
    args: [viteBin, 'preview', '--host', '0.0.0.0', '--port', webPort],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1500,
    time: true,
    out_file: path.join(root, 'data', 'logs', 'web.out.log'),
    error_file: path.join(root, 'data', 'logs', 'web.err.log'),
  },
  {
    name: 'luma-telegram-mcp',
    cwd: path.join(root, 'apps', 'telegram-mcp'),
    script: nodeExe,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TELEGRAM_MCP_PORT: telegramMcpPort,
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1500,
    time: true,
    out_file: path.join(root, 'data', 'logs', 'telegram-mcp.out.log'),
    error_file: path.join(root, 'data', 'logs', 'telegram-mcp.err.log'),
  },
  {
    name: 'luma-image-mcp',
    cwd: path.join(root, 'apps', 'image-mcp'),
    script: nodeExe,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      IMAGE_MCP_PORT: imageMcpPort,
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1500,
    time: true,
    out_file: path.join(root, 'data', 'logs', 'image-mcp.out.log'),
    error_file: path.join(root, 'data', 'logs', 'image-mcp.err.log'),
  },
];

if (enableTaskManagerMcp) {
  apps.splice(3, 0, {
    name: 'luma-taskmanager-mcp',
    cwd: path.join(root, 'apps', 'taskmanager-mcp'),
    script: nodeExe,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TASK_MANAGER_MCP_PORT: taskManagerMcpPort,
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1500,
    time: true,
    out_file: path.join(root, 'data', 'logs', 'taskmanager-mcp.out.log'),
    error_file: path.join(root, 'data', 'logs', 'taskmanager-mcp.err.log'),
  });
}

module.exports = { apps };

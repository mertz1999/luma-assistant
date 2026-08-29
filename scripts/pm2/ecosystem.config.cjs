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

const apps = [
  {
    name: 'luma-assistant-server',
    cwd: root,
    script: 'npm',
    args: 'run start -w @luma/server',
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
    cwd: root,
    script: 'npm',
    args: `run preview -w @luma/web -- --host 0.0.0.0 --port ${webPort}`,
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
    cwd: root,
    script: 'npm',
    args: 'run start -w @luma/telegram-mcp',
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
    cwd: root,
    script: 'npm',
    args: 'run start -w @luma/image-mcp',
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
    cwd: root,
    script: 'npm',
    args: 'run start -w @luma/taskmanager-mcp',
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

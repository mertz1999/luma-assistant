const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(root, '.env') });

const apiPort = String(process.env.API_PORT || '9001');
const webPort = String(process.env.WEB_PORT || '5175');
const telegramMcpPort = String(process.env.TELEGRAM_MCP_PORT || '9013');
const host = process.env.HOST || '0.0.0.0';

module.exports = {
  apps: [
    {
      name: 'agentic-cli-server',
      cwd: root,
      script: 'npm',
      args: 'run start -w @agentic/server',
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
      name: 'agentic-cli-web',
      cwd: root,
      script: 'npm',
      args: `run preview -w @agentic/web -- --host 0.0.0.0 --port ${webPort}`,
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
      name: 'agentic-telegram-mcp',
      cwd: root,
      script: 'npm',
      args: 'run start -w @agentic/telegram-mcp',
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
  ],
};

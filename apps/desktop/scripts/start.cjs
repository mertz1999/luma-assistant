const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { stage } = require('./paths.cjs');
if (!fs.existsSync(path.join(stage, 'desktop/main.cjs'))) {
  console.error('Build the desktop app first: npm run build -w @luma/desktop');
  process.exitCode = 1;
} else {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [stage], { stdio: 'inherit', env });
  child.on('exit', code => { process.exitCode = code || 0; });
}

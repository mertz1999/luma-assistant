const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const repo = path.resolve(__dirname, '../../..');
// Keep staging outside the monorepo: Electron's native rebuilder otherwise walks
// npm workspaces and attempts to rebuild the ordinary server's Node.js modules.
const stage = path.join(os.homedir(), 'Library/Caches/luma-desktop', `build-${createHash('sha256').update(repo).digest('hex').slice(0, 16)}`);
module.exports = { repo, stage, desktop: path.join(repo, 'apps/desktop') };

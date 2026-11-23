const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];

function normalizeCloudUrl(input) {
  const url = new URL(String(input).trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Enter your Luma HTTPS origin, for example https://luma.example.com (without a path or password).');
  }
  return url.origin;
}

function connectionHost(mode, cloudUrl) {
  return mode === 'cloud' ? `cloud-${createHash('sha256').update(normalizeCloudUrl(cloudUrl)).digest('hex').slice(0, 24)}` : 'local';
}

function readSettings(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cloudUrl = data.cloudUrl ? normalizeCloudUrl(data.cloudUrl) : '';
    const defaultSandbox = sandboxModes.includes(data.defaultSandbox) ? data.defaultSandbox : 'workspace-write';
    return { mode: data.mode === 'cloud' && cloudUrl ? 'cloud' : 'local', cloudUrl, defaultSandbox };
  } catch { return { mode: 'local', cloudUrl: '', defaultSandbox: 'workspace-write' }; }
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function canonicalFolder(folder) {
  const canonical = fs.realpathSync(folder);
  if (!fs.statSync(canonical).isDirectory()) throw new Error('Select a folder.');
  return canonical;
}

function readFolders(file) {
  try {
    const folders = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(folders)) return [];
    return [...new Set(folders.filter(folder => typeof folder === 'string').flatMap(folder => {
      try { return [canonicalFolder(folder)]; } catch { return []; }
    }))];
  } catch { return []; }
}

module.exports = { normalizeCloudUrl, connectionHost, readSettings, writePrivateJson, canonicalFolder, readFolders, sandboxModes };

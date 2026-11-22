const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCloudUrl, connectionHost, readSettings, writePrivateJson, readFolders } = require('../src/config.cjs');

test('cloud connections accept only an HTTPS origin without embedded credentials', () => {
  assert.equal(normalizeCloudUrl(' https://Luma.example.com/ '), 'https://luma.example.com');
  for (const url of ['http://luma.example.com', 'file:///tmp/cloud', 'https://user:secret@example.com', 'https://example.com/api', 'https://example.com?token=secret', 'https://example.com/#token']) {
    assert.throws(() => normalizeCloudUrl(url));
  }
});

test('connection origins keep cloud credentials and queues separate from local and other clouds', () => {
  assert.equal(connectionHost('local', ''), 'local');
  assert.equal(connectionHost('cloud', 'https://example.com'), connectionHost('cloud', 'https://EXAMPLE.com/'));
  assert.notEqual(connectionHost('cloud', 'https://one.example.com'), connectionHost('cloud', 'https://two.example.com'));
  assert.notEqual(connectionHost('local', ''), connectionHost('cloud', 'https://example.com'));
});

test('private settings persist, corrupt settings recover, and folders resolve symlinks', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-desktop-config-'));
  try {
    const file = path.join(temporary, 'settings.json');
    assert.deepEqual(readSettings(file), { mode: 'local', cloudUrl: '' });
    writePrivateJson(file, { mode: 'cloud', cloudUrl: 'https://example.com/' });
    assert.deepEqual(readSettings(file), { mode: 'cloud', cloudUrl: 'https://example.com' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{broken');
    assert.equal(readSettings(file).mode, 'local');
    const project = path.join(temporary, 'project');
    const link = path.join(temporary, 'alias');
    fs.mkdirSync(project);
    fs.symlinkSync(project, link);
    writePrivateJson(file, [project, link, path.join(temporary, 'missing')]);
    assert.deepEqual(readFolders(file), [fs.realpathSync(project)]);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

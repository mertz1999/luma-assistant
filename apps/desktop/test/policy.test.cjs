const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let temporary, workspace, outside, policy;
const saved = { ...process.env };
before(async () => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luma-policy-')));
  workspace = path.join(temporary, 'project');
  outside = path.join(temporary, 'private');
  for (const folder of [workspace, outside, ...['runner', 'claude', 'cursor', 'tmp'].map(name => path.join(temporary, name))]) fs.mkdirSync(folder);
  const folders = path.join(temporary, 'folders.json');
  fs.writeFileSync(folders, JSON.stringify([workspace]));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'test-private-content');
  fs.symlinkSync(outside, path.join(workspace, 'escape'));
  Object.assign(process.env, { LUMA_DESKTOP: '1', LUMA_DESKTOP_FOLDERS_FILE: folders, CODEX_HOME: path.join(temporary, 'runner'), TMPDIR: path.join(temporary, 'tmp'), PASSWORD: 'backend-secret', JWT_SECRET: 'signing-secret' });
  process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
  process.env.CURSOR_CONFIG_DIR = path.join(temporary, 'cursor');
  process.env.CURSOR_DATA_DIR = process.env.CURSOR_CONFIG_DIR;
  policy = await import('../../server/dist/desktop-policy.js');
});
after(() => { process.env = saved; fs.rmSync(temporary, { recursive: true, force: true }); });

test('workspace allowlist rejects outside folders and symlink escapes, including unwritten files', () => {
  assert.equal(policy.assertDesktopWorkspace(workspace), workspace);
  assert.throws(() => policy.assertDesktopWorkspace(outside));
  assert.throws(() => policy.assertDesktopWorkspace(path.join(workspace, 'escape')));
  assert.throws(() => policy.assertDesktopFile(workspace, path.join(workspace, 'escape/new-file')));
  assert.doesNotThrow(() => policy.assertDesktopFile(workspace, path.join(workspace, 'new/attachment.png')));
});

test('agent and terminal environments exclude backend authentication secrets', () => {
  const env = policy.desktopRunnerEnvironment();
  assert.equal(env.CODEX_HOME, process.env.CODEX_HOME);
  for (const key of ['PASSWORD', 'JWT_SECRET', 'LUMA_DESKTOP_FOLDERS_FILE']) assert.equal(env[key], undefined);
});

test('macOS sandbox allows workspace work and rejects reads and writes outside it', { skip: process.platform !== 'darwin' }, () => {
  const run = (executable, args, readOnly = false) => {
    const command = policy.desktopCommand(executable, args, workspace, readOnly);
    return spawnSync(command.executable, command.args, { encoding: 'utf8', cwd: workspace, env: policy.desktopRunnerEnvironment() });
  };
  const allowed = run('/bin/sh', ['-c', 'printf allowed > "$1/result.txt"; cat "$1/result.txt"', 'test', workspace]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, 'allowed');
  const deniedRead = run('/bin/cat', [path.join(outside, 'secret.txt')]);
  assert.notEqual(deniedRead.status, 0);
  assert.equal(deniedRead.stdout, '');
  const deniedWrite = run('/usr/bin/touch', [path.join(outside, 'new.txt')]);
  assert.notEqual(deniedWrite.status, 0);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  const deniedLink = run('/bin/cat', [path.join(workspace, 'escape/secret.txt')]);
  assert.notEqual(deniedLink.status, 0);
  const readOnly = run('/usr/bin/touch', [path.join(workspace, 'readonly.txt')], true);
  assert.notEqual(readOnly.status, 0);
  assert.equal(fs.existsSync(path.join(workspace, 'readonly.txt')), false);
});

test('installed Git can inspect a selected repository through the filesystem sandbox', { skip: process.platform !== 'darwin' }, () => {
  const initialized = spawnSync('/usr/bin/git', ['init', '-q', workspace], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const command = policy.desktopCommand('/usr/bin/git', ['status', '--porcelain'], workspace);
  const status = spawnSync(command.executable, command.args, { encoding: 'utf8', cwd: workspace, env: policy.desktopRunnerEnvironment() });
  assert.equal(status.status, 0, status.stderr);
});

test('Claude and Cursor can write their own profiles while other runner profiles stay private', { skip: process.platform !== 'darwin' }, () => {
  for (const [runner, key, otherKey] of [
    ['claude', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR'],
    ['cursor', 'CURSOR_CONFIG_DIR', 'CLAUDE_CONFIG_DIR'],
  ]) {
    const env = policy.desktopRunnerEnvironment(runner);
    assert.equal(env[key], process.env[key]);
    assert.equal(env[otherKey], undefined);
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.PASSWORD, undefined);
    assert.equal(env.CURSOR_DATA_DIR, runner === 'cursor' ? process.env.CURSOR_DATA_DIR : undefined);
    assert.equal(env.AGENT_CLI_CREDENTIAL_STORE, runner === 'cursor' ? 'file' : undefined);
    if (runner === 'cursor') assert.equal(env.HOME, process.env.CURSOR_CONFIG_DIR);
    assert.equal(env.CLAUDE_CODE_TMPDIR, runner === 'claude' ? process.env.TMPDIR : undefined);
    const ownFile = path.join(process.env[key], 'profile.txt');
    const otherFile = path.join(process.env[otherKey], 'profile.txt');
    fs.writeFileSync(otherFile, 'private');
    const command = policy.desktopProbeCommand(runner, '/bin/sh', [
      '-c', 'printf ready > "$1" && ! cat "$2" && ! touch "$3"', 'test',
      ownFile, otherFile, path.join(workspace, 'probe-write.txt'),
    ]);
    const probe = spawnSync(command.executable, command.args, { encoding: 'utf8', cwd: command.cwd, env });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, '');
    assert.equal(fs.readFileSync(ownFile, 'utf8'), 'ready');
    assert.equal(fs.existsSync(path.join(workspace, 'probe-write.txt')), false);
  }
});

test('desktop Claude can use the default CLI profile and only its run-specific memory file', { skip: process.platform !== 'darwin' }, () => {
  const home = path.join(temporary, 'home');
  const defaultProfile = path.join(home, '.claude');
  fs.mkdirSync(defaultProfile, { recursive: true });
  const config = path.join(home, '.claude.json');
  const unrelated = path.join(home, 'unrelated.txt');
  const memory = path.join(outside, 'run-mcp.json');
  fs.writeFileSync(config, 'cli-account');
  fs.writeFileSync(unrelated, 'private');
  fs.writeFileSync(memory, 'run-config');
  fs.writeFileSync(path.join(outside, 'other-mcp.json'), 'other-run');
  const previousHome = process.env.HOME;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const env = policy.desktopRunnerEnvironment('claude');
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.USER, os.userInfo().username);
    assert.equal(env.LOGNAME, env.USER);
    const probe = policy.desktopProbeCommand('claude', '/bin/cat', [config]);
    assert.equal(probe.cwd, defaultProfile);
    const readConfig = spawnSync(probe.executable, probe.args, { encoding: 'utf8', cwd: probe.cwd, env });
    assert.equal(readConfig.stdout, 'cli-account');
    const claudeTemp = path.join(env.CLAUDE_CODE_TMPDIR, `claude-${process.getuid()}`, 'test-workspace');
    const mkdir = policy.desktopCommand('/bin/mkdir', ['-p', claudeTemp], workspace, true, 'claude');
    const tempResult = spawnSync(mkdir.executable, mkdir.args, { encoding: 'utf8', cwd: workspace, env });
    assert.equal(tempResult.status, 0, tempResult.stderr);
    assert(fs.statSync(claudeTemp).isDirectory());
    const command = policy.desktopCommand('/bin/sh', [
      '-c', 'cat "$1" && ! cat "$2" && ! cat "$3" && ! touch "$4"', 'test',
      memory, path.join(outside, 'other-mcp.json'), unrelated, path.join(workspace, 'blocked-write'),
    ], workspace, true, 'claude', memory);
    const result = spawnSync(command.executable, command.args, { encoding: 'utf8', cwd: workspace, env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'run-config');
  } finally {
    process.env.HOME = previousHome;
    process.env.CLAUDE_CONFIG_DIR = previousClaude;
  }
});

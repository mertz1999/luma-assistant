const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell, systemPreferences, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { normalizeCloudUrl, connectionHost, readSettings, writePrivateJson, canonicalFolder, readFolders } = require('./config.cjs');
const { RemoteDesktop } = require('./remote.cjs');

app.setName('Luma Desktop');
if (process.env.LUMA_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.LUMA_DESKTOP_USER_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'luma', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const root = app.getAppPath();
const userData = app.getPath('userData');
const settingsFile = path.join(userData, 'connections.json');
const foldersFile = path.join(userData, 'enabled-folders.json');
const runtimeDir = path.join(userData, 'runtime');
const codexHome = path.join(runtimeDir, 'codex');
const legacyClaudeHome = path.join(runtimeDir, 'claude');
const claudeConfigOverride = process.env.CLAUDE_CONFIG_DIR;
const claudeHome = claudeConfigOverride || path.join(os.homedir(), '.claude');
const cursorHome = path.join(runtimeDir, 'cursor');
const temporaryDir = path.join(runtimeDir, 'tmp');
let settings = readSettings(settingsFile);
let window;
let engine;
let enginePromise;
let engineState = { status: 'stopped', error: null, codexPath: '', authAvailable: false };
let localOrigin = '';
let localAuth = null;
let localPassword = '';
let authPromise;
let quitting = false;
const allowedOrigins = new Set();
const remoteSecret = randomBytes(32).toString('hex');
const remote = new RemoteDesktop(path.join(userData, 'remote-pairing.json'), {
  safeStorage, fetch: (...args) => net.fetch(...args), startEngine,
  enabledFolders: () => readFolders(foldersFile),
  requestLocal: async (command, folders, canControl) => {
    const auth = await ensureLocalAuth();
    const response = await net.fetch(`${localOrigin}/api/remote/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}`, 'x-luma-remote-secret': remoteSecret },
      body: JSON.stringify({ command, folders, canControl }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error?.message || 'Local session request failed.');
    return payload.data;
  },
});

function appOrigin() { return `luma://${connectionHost(settings.mode, settings.cloudUrl)}`; }
function errorResponse(message, status = 502) {
  return new Response(JSON.stringify({ ok: false, error: { message } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function trustedFrame(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('/').slice(0, 3).join('/') !== appOrigin()) {
    throw new Error('Untrusted desktop request.');
  }
}

function publicState() {
  return { mode: settings.mode, cloudUrl: settings.cloudUrl, folders: readFolders(foldersFile), engine: engineState, remote: remote.state(), version: app.getVersion() };
}

function resolveRunner(executablePath, configured, names) {
  for (const name of configured ? [configured] : names) {
    const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', env: { ...process.env, PATH: executablePath } });
    if (result.status === 0) {
      try { return fs.realpathSync(result.stdout.trim()); } catch { /* Try the next CLI name. */ }
    }
  }
  return '';
}

function shortCursorDataPath() {
  // Cursor needs a stable, short path for its project sessions and Unix sockets.
  const uid = process.getuid();
  const root = path.join('/tmp', `luma-cursor-${uid}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('Luma cannot use its private Cursor runtime directory.');
  }
  const target = fs.realpathSync(cursorHome);
  const name = createHash('sha256').update(target).digest('hex').slice(0, 16);
  const link = path.join(root, name);
  try { fs.symlinkSync(target, link); }
  catch (error) {
    if (error.code !== 'EEXIST' || !fs.lstatSync(link).isSymbolicLink() || fs.readlinkSync(link) !== target) throw error;
  }
  return link;
}

function importClaudeSessions() {
  const source = path.join(legacyClaudeHome, 'projects');
  if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) return;
  if (fs.realpathSync(legacyClaudeHome) === fs.realpathSync(claudeHome)) return;
  fs.cpSync(source, path.join(claudeHome, 'projects'), {
    recursive: true,
    force: false,
    filter: (from, to) => {
      const entry = fs.lstatSync(from);
      const existing = fs.lstatSync(to, { throwIfNoEntry: false });
      return (entry.isDirectory() || entry.isFile()) && (!existing || (existing.isDirectory() && entry.isDirectory()));
    },
  });
}

async function ensureLocalAuth() {
  if (localAuth && localAuth.expiresAt > Date.now() + 60_000) return localAuth;
  if (!localOrigin || !localPassword) throw new Error('Local engine is not ready.');
  if (!authPromise) {
    authPromise = (async () => {
      const response = await net.fetch(`${localOrigin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: localPassword }), redirect: 'error' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error('Could not authenticate the local engine.');
      localAuth = payload.data;
      return localAuth;
    })().finally(() => { authPromise = null; });
  }
  return authPromise;
}

async function startEngine() {
  if (engineState.status === 'ready') return;
  if (enginePromise) return enginePromise;
  engineState = { ...engineState, status: 'starting', error: null };
  enginePromise = (async () => {
    for (const directory of [codexHome, cursorHome, temporaryDir]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(foldersFile)) writePrivateJson(foldersFile, []);
    // Import only login credentials. Global MCP/configuration cannot grant local tools extra access.
    const existingAuth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    const privateAuth = path.join(codexHome, 'auth.json');
    if (!fs.existsSync(privateAuth) && fs.existsSync(existingAuth)) {
      fs.copyFileSync(existingAuth, privateAuth);
      fs.chmodSync(privateAuth, 0o600);
    }
    const config = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(config)) fs.writeFileSync(config, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    const executablePath = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
    const codexPath = resolveRunner(executablePath, process.env.LUMA_DESKTOP_CODEX_PATH, ['codex']);
    const claudePath = resolveRunner(executablePath, process.env.LUMA_DESKTOP_CLAUDE_PATH, ['claude']);
    if (claudePath) {
      fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
      importClaudeSessions();
    }
    const cursorPath = resolveRunner(executablePath, process.env.LUMA_DESKTOP_CURSOR_PATH, ['cursor-agent', 'agent']);
    const cursorData = cursorPath ? shortCursorDataPath() : '';
    engineState = { ...engineState, codexPath, claudePath, cursorPath, claudeHome, cursorHome, cursorData, authAvailable: fs.existsSync(privateAuth) };
    const password = randomBytes(32).toString('hex');
    localPassword = password;
    const env = {
      HOME: os.homedir(), PATH: executablePath, LANG: process.env.LANG || 'en_US.UTF-8', SHELL: '/bin/zsh',
      TMPDIR: `${temporaryDir}/`, CODEX_HOME: codexHome, CURSOR_CONFIG_DIR: cursorHome, CURSOR_DATA_DIR: cursorData,
      ...(claudeConfigOverride ? { CLAUDE_CONFIG_DIR: claudeConfigOverride } : {}),
      LUMA_DESKTOP: '1', LUMA_DESKTOP_FOLDERS_FILE: foldersFile, LUMA_DESKTOP_REMOTE_SECRET: remoteSecret,
      LUMA_ROOT_DIR: root, LUMA_DATA_DIR: path.join(userData, 'data'),
      HOST: '127.0.0.1', API_PORT: '0', PASSWORD: password, JWT_SECRET: randomBytes(32).toString('hex'),
      CODEX_PATH: codexPath || 'codex', CLAUDE_CODE_EXECUTABLE: claudePath || 'claude', CURSOR_PATH: cursorPath || 'cursor-agent',
      DEFAULT_RUNNER: codexPath ? 'codex' : claudePath ? 'claude' : cursorPath ? 'cursor' : 'codex', DEFAULT_SANDBOX: 'workspace-write',
      AUTH_TOKEN_TTL_SECONDS: '604800', MAX_CONCURRENT_RUNS: '4',
    };
    const logDir = path.join(userData, 'logs');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, 'local-engine.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.previous`);
    engine = utilityProcess.fork(path.join(root, 'server/index.js'), [], { cwd: runtimeDir, env, stdio: 'pipe', serviceName: 'Luma Local Engine' });
    const startedEngine = engine;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { startedEngine.kill(); reject(new Error('Local engine did not start within 45 seconds. See local-engine.log.')); }, 45_000);
      let output = '';
      startedEngine.stdout.on('data', chunk => {
        fs.appendFileSync(logFile, chunk, { mode: 0o600 });
        output = (output + chunk.toString()).slice(-8000);
        const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); localOrigin = match[1]; resolve(); }
      });
      startedEngine.stderr.on('data', chunk => fs.appendFileSync(logFile, chunk, { mode: 0o600 }));
      startedEngine.once('exit', code => {
        clearTimeout(timer);
        if (engine === startedEngine) {
          engine = null;
          localOrigin = '';
          localAuth = null;
          localPassword = '';
          engineState = { ...engineState, status: 'error', error: `Local engine stopped (exit ${code}). Retry to restart it.` };
        }
        reject(new Error(`Local engine stopped during startup (exit ${code}). See local-engine.log.`));
      });
    });
    await ensureLocalAuth();
    engineState = { ...engineState, status: 'ready', error: null };
  })().catch(error => {
    engineState = { ...engineState, status: 'error', error: error.message };
    throw error;
  }).finally(() => { enginePromise = null; });
  return enginePromise;
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  const origin = `luma://${url.host}`;
  if (!allowedOrigins.has(origin)) return errorResponse('Unknown connection.', 403);
  if (url.pathname.startsWith('/api/')) {
    try {
      const local = url.hostname === 'local';
      if (local && (!localOrigin || !localAuth)) return errorResponse(engineState.error || 'Local engine is starting.', 503);
      const remoteHost = connectionHost('cloud', settings.cloudUrl || 'https://unconfigured.invalid');
      if (!local && url.hostname !== remoteHost) return errorResponse('This cloud connection is no longer active.', 409);
      const target = new URL(url.pathname + url.search, local ? localOrigin : settings.cloudUrl);
      const headers = new Headers(request.headers);
      for (const header of ['host', 'origin', 'referer', 'connection', 'cookie', 'x-luma-remote-secret']) headers.delete(header);
      if (local) {
        const auth = await ensureLocalAuth();
        headers.set('Authorization', `Bearer ${auth.token}`);
        target.searchParams.delete('token');
      }
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      const upstream = await net.fetch(target.href, { method: request.method, headers, body, redirect: 'manual', signal: request.signal });
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return errorResponse('Luma redirected this request. Enter the final HTTPS cloud URL.'); }
      const responseHeaders = new Headers(upstream.headers);
      for (const header of ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection']) responseHeaders.delete(header);
      responseHeaders.set('Cache-Control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (error) { return errorResponse(`Cannot reach ${url.hostname === 'local' ? 'the local engine' : 'Luma cloud'}: ${error.message}`); }
  }
  if (!['GET', 'HEAD'].includes(request.method)) return errorResponse('Method not allowed.', 405);
  const webRoot = path.join(root, 'web');
  let requested;
  try { requested = decodeURIComponent(url.pathname); } catch { return errorResponse('Invalid path.', 400); }
  const file = path.resolve(webRoot, `.${requested === '/' ? '/index.html' : requested}`);
  if (!file.startsWith(`${webRoot}${path.sep}`)) return errorResponse('Invalid path.', 403);
  try {
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, headers });
  } catch { return new Response('Not found', { status: 404 }); }
}

function installIpc() {
  const handle = (name, handler) => ipcMain.handle(name, async (event, ...args) => { trustedFrame(event); return handler(...args); });
  handle('luma:state', () => publicState());
  handle('luma:local-auth', () => settings.mode === 'local' ? ensureLocalAuth() : null);
  handle('luma:retry-local', async () => { await startEngine(); return publicState(); });
  handle('luma:remote-pair', input => remote.pair(input));
  handle('luma:remote-configure', input => remote.configure(input));
  handle('luma:remote-unpair', () => remote.unpair());
  handle('luma:switch', async input => {
    if (!input || !['local', 'cloud'].includes(input.mode)) throw new Error('Invalid connection.');
    const next = { mode: input.mode, cloudUrl: input.cloudUrl ? normalizeCloudUrl(input.cloudUrl) : settings.cloudUrl };
    if (next.mode === 'cloud' && !next.cloudUrl) throw new Error('Enter your Luma cloud URL.');
    settings = next;
    writePrivateJson(settingsFile, settings);
    allowedOrigins.add(appOrigin());
    if (settings.mode === 'local') void startEngine().catch(() => {});
    setImmediate(() => void window.loadURL(`${appOrigin()}/`));
    return true;
  });
  handle('luma:choose-folder', async () => {
    if (settings.mode !== 'local') throw new Error('Switch to This Mac to choose a local folder.');
    const result = await dialog.showOpenDialog(window, { title: 'Enable a folder for Luma sessions', buttonLabel: 'Enable folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    const folder = canonicalFolder(result.filePaths[0]);
    const folders = [...new Set([...readFolders(foldersFile), folder])];
    writePrivateJson(foldersFile, folders);
    return folder;
  });
  handle('luma:remove-folder', async folder => {
    if (settings.mode !== 'local' || typeof folder !== 'string') throw new Error('Invalid local folder.');
    // Revocation must stop active processes; a running sandbox retains its original grants.
    const response = await net.fetch(`${localOrigin}/api/runs`, { headers: { Authorization: `Bearer ${localAuth?.token || ''}` } });
    const result = await response.json();
    if (!result.ok) throw new Error('Cannot verify active sessions. Retry when the local engine is available.');
    if (result.data.runs.some(run => ['running', 'queued'].includes(run.status))) throw new Error('Stop running local sessions before removing a folder.');
    // Restart also closes any terminal that retains access to this folder.
    writePrivateJson(foldersFile, readFolders(foldersFile).filter(item => item !== folder));
    if (engine) { const stopped = engine; await new Promise(resolve => { stopped.once('exit', resolve); stopped.kill(); }); }
    await startEngine();
    return publicState();
  });
}

function createWindow() {
  allowedOrigins.add(appOrigin());
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 860, minHeight: 640, backgroundColor: '#151718', title: 'Luma Desktop',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (target.split('/').slice(0, 3).join('/') !== appOrigin()) event.preventDefault();
  });
  window.on('closed', () => { window = null; });
  void window.loadURL(`${appOrigin()}/`);
}

function permitMicrophone(contents, origin, isMainFrame) {
  if (!window || contents !== window.webContents || !isMainFrame || !origin) return false;
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}` === appOrigin();
  } catch {
    return false;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(() => {
    session.defaultSession.protocol.handle('luma', handleProtocol);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission !== 'media' || details.mediaTypes?.length !== 1 || details.mediaTypes[0] !== 'audio'
        || !permitMicrophone(contents, details.securityOrigin || details.requestingUrl, details.isMainFrame)) {
        callback(false);
        return;
      }
      void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => (
      permission === 'media' && details.mediaType === 'audio'
      && permitMicrophone(contents, details.securityOrigin || origin, details.isMainFrame)
      && systemPreferences.getMediaAccessStatus('microphone') === 'granted'
    ));
    installIpc();
    remote.restore();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    if (settings.mode === 'local') void startEngine().catch(() => {});
    createWindow();
  }).catch(error => { dialog.showErrorBox('Luma Desktop could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => { /* Keep local sessions and remote access running until Quit. */ });
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('before-quit', event => {
    remote.stop(true);
    if (!engine || quitting) return;
    event.preventDefault();
    quitting = true;
    engine.once('exit', () => app.quit());
    engine.kill();
    setTimeout(() => app.exit(), 5000).unref();
  });
}

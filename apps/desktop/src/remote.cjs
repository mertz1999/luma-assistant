const fs = require('node:fs');
const os = require('node:os');
const { WebSocket } = require('ws');
const { normalizeCloudUrl, writePrivateJson } = require('./config.cjs');

const pairCodePattern = /^[\w-]{22}$/;
const tokenPattern = /^luma_device_[\w-]{43}$/;
const requestIdPattern = /^[\da-f-]{36}$/i;

class RemoteDesktop {
  constructor(file, { safeStorage, fetch, startEngine, requestLocal, enabledFolders }) {
    this.file = file;
    this.safeStorage = safeStorage;
    this.fetch = fetch;
    this.startEngine = startEngine;
    this.requestLocal = requestLocal;
    this.enabledFolders = enabledFolders;
    this.pairing = null;
    this.socket = null;
    this.retry = null;
    this.backoff = 1000;
    this.status = 'unpaired';
    this.pairInProgress = false;
    this.shuttingDown = false;
  }

  restore() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const token = this.safeStorage.decryptString(Buffer.from(saved.encryptedToken, 'base64'));
      if (!tokenPattern.test(token) || typeof saved.id !== 'string' || typeof saved.name !== 'string'
        || !Array.isArray(saved.folders) || !saved.folders.every(folder => typeof folder === 'string')) {
        throw new Error('Invalid pairing settings.');
      }
      this.pairing = { ...saved, cloudUrl: normalizeCloudUrl(saved.cloudUrl), token };
      void this.connect();
    } catch (error) {
      if (error.code !== 'ENOENT') this.status = 'unavailable';
    }
  }

  state() {
    const pairing = this.pairing;
    const enabled = pairing ? this.enabledFolders() : [];
    return {
      paired: Boolean(pairing),
      status: this.status,
      cloudUrl: pairing?.cloudUrl || '',
      folders: pairing?.folders.filter(folder => enabled.includes(folder)) || [],
      canControl: pairing?.canControl === true,
    };
  }

  validateFolders(folders) {
    const enabled = this.enabledFolders();
    if (!Array.isArray(folders) || !folders.length || folders.length > enabled.length
      || !folders.every(folder => typeof folder === 'string' && enabled.includes(folder))) {
      throw new Error('Select at least one enabled folder to share.');
    }
    return [...new Set(folders)];
  }

  save(pairing) {
    const { token, ...settings } = pairing;
    writePrivateJson(this.file, settings);
    this.pairing = pairing;
  }

  async pair(input) {
    if (this.pairing || this.pairInProgress) throw new Error('Remove the existing pairing before pairing again.');
    const cloudUrl = normalizeCloudUrl(input?.cloudUrl);
    const code = typeof input?.code === 'string' ? input.code.trim() : '';
    if (!pairCodePattern.test(code)) throw new Error('Paste the pairing code shown in Luma Cloud.');
    const folders = this.validateFolders(input?.folders);
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Unlock the Mac Keychain before pairing.');
    const name = (typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : os.hostname()).slice(0, 80);
    this.pairInProgress = true;
    try {
      await this.startEngine();
      const response = await this.fetch(`${cloudUrl}/api/remote/device/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('This Luma Cloud server does not support Mac pairing yet.');
      }
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || 'Pairing failed.');
      const { id, token } = payload.data;
      if (typeof id !== 'string' || !tokenPattern.test(token)) throw new Error('Luma Cloud returned an invalid pairing response.');
      try {
        const encryptedToken = this.safeStorage.encryptString(token).toString('base64');
        this.save({ id, token, encryptedToken, cloudUrl, name, folders, canControl: false });
      } catch (error) {
        void this.revoke({ cloudUrl, token });
        throw error;
      }
      void this.connect();
      return this.state();
    } finally {
      this.pairInProgress = false;
    }
  }

  configure(input) {
    if (!this.pairing || this.status === 'revoked') throw new Error('Pair this Mac first.');
    if (typeof input?.canControl !== 'boolean') throw new Error('Choose the access allowed for this Mac.');
    this.save({ ...this.pairing, folders: this.validateFolders(input.folders), canControl: input.canControl });
    this.announceReady();
    return this.state();
  }

  async revoke(pairing) {
    try {
      await this.fetch(`${pairing.cloudUrl}/api/remote/device/self`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${pairing.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* The Mac stops sharing immediately, even without cloud connectivity. */ }
  }

  unpair() {
    if (this.pairInProgress) throw new Error('Wait for the pairing request to finish.');
    fs.rmSync(this.file, { force: true });
    const pairing = this.pairing;
    this.pairing = null;
    this.status = 'unpaired';
    this.stop();
    if (pairing) void this.revoke(pairing);
    return this.state();
  }

  stop(shuttingDown = false) {
    this.shuttingDown = shuttingDown;
    clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }

  scheduleRetry() {
    if (!this.pairing || this.retry || this.shuttingDown || this.status === 'revoked') return;
    this.status = 'offline';
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, this.backoff);
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  async connect() {
    const pairing = this.pairing;
    if (!pairing || this.socket || this.shuttingDown) return;
    this.status = 'connecting';
    try {
      await this.startEngine();
    } catch {
      if (this.pairing?.id === pairing.id) this.scheduleRetry();
      return;
    }
    if (this.pairing?.id !== pairing.id || this.socket || this.shuttingDown) return;
    const url = new URL('/api/remote/connect', pairing.cloudUrl);
    url.protocol = 'wss:';
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${pairing.token}` },
      handshakeTimeout: 8000,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.socket = socket;
    let watchdog;
    const refreshWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => socket.terminate(), 36_000);
    };
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.status = 'online';
      this.backoff = 1000;
      refreshWatchdog();
      this.announceReady();
    });
    socket.on('ping', refreshWatchdog);
    socket.on('error', () => socket.terminate());
    socket.on('unexpected-response', (request, response) => {
      if (this.socket === socket && response.statusCode === 401) this.status = 'revoked';
      response.resume();
      request.destroy();
      socket.terminate();
    });
    socket.on('close', code => {
      clearTimeout(watchdog);
      if (this.socket !== socket) return;
      this.socket = null;
      if (code === 4003) this.status = 'revoked';
      this.scheduleRetry();
    });
    socket.on('message', (raw, binary) => {
      if (!binary && this.socket === socket) void this.handleRequest(socket, raw);
    });
  }

  announceReady() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ kind: 'ready', canControl: this.pairing?.canControl === true }));
    }
  }

  async handleRequest(socket, raw) {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (!requestIdPattern.test(frame?.id) || !frame.command || !this.pairing) return;
    const { id, command } = frame;
    let reply;
    try {
      const data = await this.requestLocal(command, this.pairing.folders, this.pairing.canControl);
      reply = { kind: 'result', id, ok: true, data: command.kind === 'send' ? { accepted: true } : data };
    } catch (error) {
      reply = { kind: 'error', id, message: String(error.message || 'Local session request failed.').slice(0, 400) };
    }
    if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
  }
}

module.exports = { RemoteDesktop };

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumaDesktop', {
  isLocal: location.hostname === 'local',
  getState: () => ipcRenderer.invoke('luma:state'),
  setKeepScreenOn: enabled => ipcRenderer.invoke('luma:keep-screen-on', enabled),
  setDefaultSandbox: mode => ipcRenderer.invoke('luma:set-default-sandbox', mode),
  localAuth: () => ipcRenderer.invoke('luma:local-auth'),
  switchConnection: (mode, cloudUrl) => ipcRenderer.invoke('luma:switch', { mode, cloudUrl }),
  chooseFolder: () => ipcRenderer.invoke('luma:choose-folder'),
  removeFolder: folder => ipcRenderer.invoke('luma:remove-folder', folder),
  retryLocal: () => ipcRenderer.invoke('luma:retry-local'),
  pairRemote: input => ipcRenderer.invoke('luma:remote-pair', input),
  configureRemote: input => ipcRenderer.invoke('luma:remote-configure', input),
  unpairRemote: () => ipcRenderer.invoke('luma:remote-unpair'),
});

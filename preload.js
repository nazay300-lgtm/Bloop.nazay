const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  getLocalIPs: () => ipcRenderer.invoke('get-local-ips'),
  setDiscoveryProfile: (profile) => ipcRenderer.invoke('set-discovery-profile', profile),
  getLanPeers: () => ipcRenderer.invoke('get-lan-peers'),
  connectToPeer: (ip) => ipcRenderer.invoke('connect-to-peer', ip),
  disconnectFromPeer: (ip) => ipcRenderer.send('disconnect-from-peer', ip),
  sendWsMessage: (ip, msg) => ipcRenderer.send('send-ws-message', { ip, msg }),
  quitApp: () => ipcRenderer.send('quit-app'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (e, data) => cb(data)),
  writeClipboard: (text) => { try { clipboard.writeText(text); return true; } catch (e) { return false; } },
  saveMedia: (buffer, ext) => ipcRenderer.invoke('save-media', { buffer, ext }),
  onWsConnected: (cb) => ipcRenderer.on('ws-connected', (e, data) => cb(data)),
  onWsMessage: (cb) => ipcRenderer.on('ws-message', (e, data) => cb(data)),
  onWsError: (cb) => ipcRenderer.on('ws-error', (e, data) => cb(data)),
  onWsDisconnected: (cb) => ipcRenderer.on('ws-disconnected', (e, data) => cb(data)),
  onLanPeerFound: (cb) => ipcRenderer.on('lan-peer-found', (e, data) => cb(data)),
  onLanPeerLost: (cb) => ipcRenderer.on('lan-peer-lost', (e, data) => cb(data))
});
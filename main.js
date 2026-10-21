const { app, BrowserWindow, ipcMain, session, desktopCapturer, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const dgram = require('dgram');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (error) { console.warn('electron-updater is not installed yet. Run npm install.', error.message); }

let win;
let wss = null;
let discoverySocket = null;
let discoveryProfile = { nickname: '', friendCode: '', version: 1 };
const seenLanPeers = new Map();
const DISCOVERY_PORT = 45888;
const outgoingPeers = new Map();   // ip -> ws (мы подключились)
const incomingClients = new Map(); // ip -> ws (подключились к нам)

function normalizeIP(ip) {
  if (!ip) return '';
  return String(ip).replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const iface of (entries || [])) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        addresses.push({ name, address: iface.address, netmask: iface.netmask });
      }
    }
  }
  return addresses;
}

function getLocalIP() {
  // Сохраняем прежний API, но предпочитаем частные IPv4-адреса.
  const addresses = getLocalIPs();
  const preferred = addresses.find(({ address }) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
  );
  return (preferred || addresses[0] || {}).address || '127.0.0.1';
}

function validIPv4(value) {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
  );
}

function attachHeartbeat(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => console.warn('WebSocket error:', err.message));
}

function toRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// true, если с этим IP не осталось ни одного живого соединения
function noConnectionsLeft(ip) {
  return !outgoingPeers.has(ip) && !incomingClients.has(ip);
}

function startServer() {
  if (wss) { try { wss.close(); } catch (e) {} }
  wss = new WebSocket.Server({ host: '0.0.0.0', port: 8080, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });

  const heartbeat = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((client) => {
      if (client.isAlive === false) return client.terminate();
      client.isAlive = false;
      try { client.ping(); } catch (_) { client.terminate(); }
    });
  }, 15000);
  wss.once('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    const remoteIP = normalizeIP(req.socket.remoteAddress);
    attachHeartbeat(ws);
    const localIP = normalizeIP(req.socket.localAddress);

    // тот же друг переподключился — старое соединение тихо заменяем
    const old = incomingClients.get(remoteIP);
    if (old && old !== ws) { old._replaced = true; try { old.close(); } catch (e) {} }
    incomingClients.set(remoteIP, ws);

    toRenderer('ws-connected', { role: 'server', ip: remoteIP, local: localIP });

    ws.on('message', (message) => {
      toRenderer('ws-message', { ip: remoteIP, msg: message.toString() });
    });
    ws.on('close', () => {
      if (incomingClients.get(remoteIP) === ws) incomingClients.delete(remoteIP);
      if (!ws._replaced && noConnectionsLeft(remoteIP)) toRenderer('ws-disconnected', { ip: remoteIP });
    });
    ws.on('error', (err) => console.warn('incoming error:', err.message));
  });

  wss.on('error', (err) => {
    console.error('WS server error:', err.message);
    toRenderer('ws-error', { ip: '', msg: 'Сервер: ' + err.message });
  });
}


function startLanDiscovery() {
  if (discoverySocket) { try { discoverySocket.close(); } catch (_) {} }
  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket.on('error', (err) => console.warn('LAN discovery:', err.message));
  discoverySocket.on('message', (buffer, remote) => {
    let packet;
    try { packet = JSON.parse(buffer.toString('utf8')); } catch (_) { return; }
    if (!packet || packet.type !== 'bloop-discovery' || packet.version !== 1) return;
    if (!packet.friendCode || packet.friendCode === discoveryProfile.friendCode) return;
    const ip = normalizeIP(remote.address);
    if (!validIPv4(ip) || ip.startsWith('127.') || ip.startsWith('169.254.')) return;
    const peer = {
      ip,
      nickname: String(packet.nickname || 'Пользователь').slice(0, 32),
      friendCode: String(packet.friendCode).slice(0, 40),
      lastSeen: Date.now()
    };
    seenLanPeers.set(peer.friendCode, peer);
    toRenderer('lan-peer-found', peer);
  });
  discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    try { discoverySocket.setBroadcast(true); } catch (_) {}
    announceLanPresence();
  });
  const timer = setInterval(() => {
    if (!discoverySocket) return clearInterval(timer);
    announceLanPresence();
    const cutoff = Date.now() - 15000;
    for (const [code, peer] of seenLanPeers) {
      if (peer.lastSeen < cutoff) {
        seenLanPeers.delete(code);
        toRenderer('lan-peer-lost', { friendCode: code, ip: peer.ip });
      }
    }
  }, 4000);
}

function announceLanPresence() {
  if (!discoverySocket || !discoveryProfile.friendCode) return;
  const payload = Buffer.from(JSON.stringify({
    type: 'bloop-discovery', version: 1,
    nickname: discoveryProfile.nickname || 'Пользователь',
    friendCode: discoveryProfile.friendCode
  }));
  const targets = new Set(['255.255.255.255']);
  for (const iface of getLocalIPs()) {
    const ip = iface.address.split('.').map(Number);
    const mask = iface.netmask.split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4) continue;
    const broadcast = ip.map((v, i) => (v & mask[i]) | (255 ^ mask[i])).join('.');
    targets.add(broadcast);
  }
  for (const target of targets) {
    try { discoverySocket.send(payload, DISCOVERY_PORT, target, () => {}); } catch (_) {}
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true,
    backgroundColor: '#04090e'
  });
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // У приложения нет системного меню: Alt и Shift+Alt не должны раскрывать пункты меню.
  Menu.setApplicationMenu(null);

  // микрофон и показ экрана разрешаем, остальное — нет
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(wc.getURL().startsWith('file://') && ['media', 'display-capture'].includes(permission));
  });

  // В Electron getDisplayMedia без этого обработчика не работает вообще.
  // Отдаём основной экран.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  });

  startServer();
  startLanDiscovery();
  createWindow();

  // Auto-updates are available only in the installed/packaged build. The GitHub
  // owner/repo placeholders in package.json must be replaced before publishing.
  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = true;
    autoUpdater.on('checking-for-update', () => toRenderer('update-status', { status: 'checking' }));
    autoUpdater.on('update-available', (info) => toRenderer('update-status', { status: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => toRenderer('update-status', { status: 'not-available' }));
    autoUpdater.on('download-progress', (progress) => toRenderer('update-status', { status: 'downloading', percent: progress.percent }));
    autoUpdater.on('update-downloaded', (info) => toRenderer('update-status', { status: 'downloaded', version: info.version }));
    autoUpdater.on('error', (error) => toRenderer('update-status', { status: 'error', message: error.message }));
    ipcMain.handle('check-for-updates', async () => {
      if (!app.isPackaged) return { status: 'unavailable', message: 'В режиме разработки автообновление отключено. Проверьте его в установленной сборке.' };
      if (!autoUpdater) return { status: 'unavailable', message: 'Не установлен electron-updater. Выполните npm install.' };
      try { await autoUpdater.checkForUpdates(); return { status: 'checking' }; }
      catch (error) { return { status: 'unavailable', message: error.message }; }
    });
    if (app.isPackaged) setTimeout(() => { autoUpdater.checkForUpdates().catch((error) => console.warn('Update check failed:', error.message)); }, 7000);
  } else {
    ipcMain.handle('check-for-updates', () => ({ status: 'unavailable', message: 'Модуль обновлений не установлен. Выполните npm install.' }));
  }

  ipcMain.handle('set-discovery-profile', (event, profile) => {
    discoveryProfile = {
      nickname: String(profile?.nickname || '').slice(0, 32),
      friendCode: String(profile?.friendCode || '').slice(0, 40),
      version: 1
    };
    announceLanPresence();
    return { ok: true };
  });
  ipcMain.handle('get-lan-peers', () => Array.from(seenLanPeers.values()).filter(p => Date.now() - p.lastSeen < 15000));

  ipcMain.handle('get-local-ip', () => getLocalIP());
  ipcMain.handle('get-local-ips', () => getLocalIPs());

  ipcMain.handle('connect-to-peer', (event, ip) => {
    const normIP = normalizeIP(ip);
    if (!validIPv4(normIP)) return { error: 'Введите корректный IPv4-адрес устройства в локальной сети или VPN.' };
    if (normIP === '0.0.0.0') return { error: 'Адрес 0.0.0.0 нельзя использовать для подключения.' };
    // уже есть соединение в любую сторону — второе не нужно
    if (outgoingPeers.has(normIP) || incomingClients.has(normIP)) return { already: true };
    try {
      const ws = new WebSocket(`ws://${normIP}:8080`, { handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
      attachHeartbeat(ws);
      outgoingPeers.set(normIP, ws);

      let opened = false;
      const connectTimer = setTimeout(() => {
        if (!opened && ws.readyState !== WebSocket.OPEN) {
          try { ws.terminate(); } catch (_) {}
          toRenderer('ws-error', { ip: normIP, msg: 'Истекло время подключения. Проверьте IP, VPN/LAN и правило брандмауэра для TCP-порта 8080.' });
        }
      }, 6500);
      ws.on('open', () => {
        opened = true;
        clearTimeout(connectTimer);
        const local = normalizeIP(ws._socket && ws._socket.localAddress);
        toRenderer('ws-connected', { role: 'client', ip: normIP, local });
      });
      ws.on('close', () => clearTimeout(connectTimer));
      ws.on('message', (message) => {
        toRenderer('ws-message', { ip: normIP, msg: message.toString() });
      });
      ws.on('error', (err) => {
        toRenderer('ws-error', { ip: normIP, msg: 'Не удалось подключиться: ' + err.message });
      });
      ws.on('close', () => {
        if (outgoingPeers.get(normIP) === ws) outgoingPeers.delete(normIP);
        if (noConnectionsLeft(normIP)) toRenderer('ws-disconnected', { ip: normIP });
      });
      return { ok: true };
    } catch (e) {
      toRenderer('ws-error', { ip: normIP, msg: e.message });
      return { error: e.message };
    }
  });

  ipcMain.on('send-ws-message', (event, { ip, msg }) => {
    const normIP = normalizeIP(ip);
    const target = outgoingPeers.get(normIP) || incomingClients.get(normIP);
    if (target && target.readyState === WebSocket.OPEN) {
      try { target.send(msg); } catch (e) { console.warn('send error:', e); }
    }
  });

  ipcMain.on('disconnect-from-peer', (event, ip) => {
    const normIP = normalizeIP(ip);
    [outgoingPeers.get(normIP), incomingClients.get(normIP)].forEach((ws) => {
      if (ws) { try { ws.close(); } catch (e) {} }
    });
  });

  // СОХРАНЕНИЕ МЕДИАФАЙЛОВ НА ДИСК
  ipcMain.handle('save-media', async (event, { buffer, ext }) => {
    const mediaDir = path.join(app.getPath('userData'), 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    // расширение приходит от собеседника — оставляем только буквы/цифры
    const safeExt = String(ext || '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const filename = Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.' + safeExt;
    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return pathToFileURL(filePath).href;
  });

  ipcMain.on('quit-app', () => {
    if (wss) try { wss.close(); } catch (e) {}
    if (discoverySocket) { try { discoverySocket.close(); } catch (e) {} discoverySocket = null; }
    outgoingPeers.forEach(ws => { try { ws.close(); } catch (e) {} });
    incomingClients.forEach(ws => { try { ws.close(); } catch (e) {} });
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (wss) try { wss.close(); } catch (e) {}
  if (discoverySocket) { try { discoverySocket.close(); } catch (e) {} discoverySocket = null; }
  if (process.platform !== 'darwin') app.quit();
});
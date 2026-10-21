window.onerror = function(message, source, lineno, colno, error) {
  console.error('JS ERROR:', message, 'at', source, ':', lineno, error);
  if (typeof showToast === 'function') showToast('Ошибка: ' + message);
  return false;
};

// НАСТОЯЩЕЕ ШИФРОВАНИЕ (AES-GCM + PBKDF2)
const E2EE = {
  getKey: async (password) => {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('bloop-salt-v1'), iterations: 100000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },
  encrypt: async (text, key) => {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
      const buf = new Uint8Array(iv.length + ciphertext.byteLength);
      buf.set(iv, 0);
      buf.set(new Uint8Array(ciphertext), iv.length);
      return btoa(String.fromCharCode(...buf));
    } catch (e) { return text; }
  },
  decrypt: async (hash, key) => {
    try {
      const buf = new Uint8Array(atob(hash).split('').map(c => c.charCodeAt(0)));
      const iv = buf.slice(0, 12);
      const ciphertext = buf.slice(12);
      const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(dec);
    } catch (e) {
      try { return decodeURIComponent(escape(atob(hash))); } catch (err) { return hash; }
    }
  }
};

const defaultAvatar = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%238ca2b3'><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
const defaultBanner = "linear-gradient(135deg, #1f3040, #17212b)";
const CHUNK_SIZE = 16 * 1024;

let appState = {
  user: { nickname: '', desc: '', avatar: defaultAvatar, banner: '', friendCode: '', isRegistered: false },
  contacts: [],
  incomingRequests: [],
  activeContactId: null,
  activeTab: 'contacts'
};

const peers = new Map();
const nearbyUsers = new Map();
const pendingFriendAdds = new Map();
const pendingPeerActions = new Map();
let groupCall = null;

// Все пользовательские сессии формируются из контактов. Отдельных комнат подключения нет.

let callTimerInterval = null;
let callSeconds = 0;
let cropperInstance = null;
let currentAvatarTarget = '';
let cropType = 'avatar';
let localStream = null;
let screenStream = null;
let isMuted = false;
let isInCall = false;
let cameraStream = null;
let incomingOfferData = null;
let callTitle = 'Звонок';

let callSettings = { masterVolume: 1.0, mutedPeers: new Set() };
let callChatMessages = [];
let userBinds = { muteMic: null };
let isCapturingBind = false;
let capturingBindName = null;
let captureCodes = [];
let keysDown = new Set();
let contextMenuTarget = null;
let messageMenuTarget = null;
let incomingFriendQueue = [];
let editingMsgId = null;

let typingTimeout = null;
let lastTypingTime = 0;

let confirmResolve = null;
let promptResolve = null;

function generateFriendCode() {
  return 'BLOOP-' + Math.random().toString(36).substring(2, 6).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}
function safeParse(str) { try { return JSON.parse(str); } catch (e) { return null; } }
function $(id) { return document.getElementById(id); }
function ipToNum(ip) { return String(ip).split('.').reduce((a, b) => a * 256 + (+b || 0), 0); }
function genMsgId() { return Date.now() + '_' + Math.random().toString(36).substring(2, 9); }

function getPeerByFriendCode(fc) {
  const c = appState.contacts.find(x => x.type === 'peer' && x.friendCode === fc);
  if (c && c.ip) return peers.get(c.ip);
  return null;
}

/* ============================================================
   КАСТОМНЫЕ ДИАЛОГИ
   ============================================================ */
function showCustomConfirm(text, title = 'ПОДТВЕРЖДЕНИЕ') {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    openModal('custom-confirm-modal');
  });
}

function showCustomPrompt(text, defaultValue = '', title = 'ВВОД') {
  return new Promise((resolve) => {
    promptResolve = resolve;
    $('prompt-title').textContent = title;
    $('prompt-input').value = defaultValue;
    openModal('custom-prompt-modal');
    setTimeout(() => $('prompt-input').focus(), 100);
  });
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  ['stage-1','stage-2','stage-3'].forEach(id => $(id)?.classList.remove('active'));
  loadStateFromStorage();
  loadBinds();
  setupEventListeners();
  setupMiniCallDrag();
  setupGlobalKeyHandlers();
  setupContextMenuHandlers();
  renderActiveTab();
  setupNetworkListeners();
  publishDiscoveryProfile();
  setInterval(publishDiscoveryProfile, 5000);

  if (window.api?.getLocalIP) {
    try {
      const myIP = await window.api.getLocalIP();
      if ($('my-ip-display')) $('my-ip-display').textContent = myIP;
    } catch (e) {}
  }

  const isReg = appState.user?.isRegistered;

  if (isReg) {
    $('stage-1').classList.add('passed');
    $('stage-2').classList.add('passed');
    $('stage-3').classList.add('active');
    updateProfileUI();
    if (appState.contacts.length > 0) switchChat(appState.contacts[0].id);
  } else {
    $('stage-1').classList.add('active');
    $('reg-avatar-preview').innerHTML = `<img src="${defaultAvatar}">`;
    $('main-player-avatar').innerHTML = `<img src="${defaultAvatar}">`;
  }

  BloopIntro.play({
    registered: !!isReg,
    onArrived: () => {
      if (!isReg) return;
      // Автоматическое переподключение убрано — коннект ручной через ПКМ → Подключиться
      const subC = $('submarine-container');
      if (subC) {
        subC.style.display = 'block';
        setTimeout(() => $('submarine').classList.add('animate'), 500);
        setTimeout(() => { subC.style.display = 'none'; }, 6000);
      }
    }
  });
});

/* ============================================================
   ПРОФИЛЬ
   ============================================================ */
function broadcastProfile() {
  peers.forEach(peer => {
    if (!peer.dataChannel || peer.dataChannel.readyState !== 'open') return;
    sendOverChannel(peer, {
      type: 'profile_update',
      nickname: appState.user.nickname,
      avatar: appState.user.avatar,
      banner: appState.user.banner,
      desc: appState.user.desc,
      friendCode: appState.user.friendCode
    });
  });
}

function handleProfileUpdate(peer, data) {
  peer.friendCode = data.friendCode || peer.friendCode;
  peer.friendName = data.nickname || peer.friendName;
  peer.friendAvatar = data.avatar || peer.friendAvatar;

  const contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.friendCode);
  if (contact) {
    contact.name = data.nickname || contact.name;
    contact.ip = peer.ip;
    contact.avatar = data.avatar || contact.avatar;
    contact.banner = data.banner || contact.banner;
    contact.desc = data.desc || contact.desc;
  }

  const req = appState.incomingRequests.find(r => r.friendCode === data.friendCode);
  if (req) {
    req.nickname = data.nickname || req.nickname;
    req.avatar = data.avatar || req.avatar;
    renderFriendRequests();
  }
  saveStateToStorage();
  renderActiveTab();
  if (isInCall) renderCallParticipants();
  if (contact && contact.id === appState.activeContactId) {
    $('chat-with-name').textContent = contact.name;
  }
}

/* ============================================================
   WS И СЕТЬ
   ============================================================ */
async function publishDiscoveryProfile() {
  if (!window.api?.setDiscoveryProfile || !appState.user?.isRegistered || !appState.user.friendCode) return;
  try { await window.api.setDiscoveryProfile({ nickname: appState.user.nickname, friendCode: appState.user.friendCode }); } catch (_) {}
}

function renderNearbyUsers() {
  const list = $('nearby-users-list');
  if (!list) return;
  const query = String($('nearby-search')?.value || '').trim().toLocaleLowerCase();
  const users = [...nearbyUsers.values()].filter(u => u.friendCode !== appState.user.friendCode && u.nickname.toLocaleLowerCase().includes(query));
  list.innerHTML = '';
  if (!users.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:#8ca2b3;font-size:.82rem;padding:8px';
    empty.textContent = query ? 'Совпадений нет' : 'Пока никого не видно. Проверьте, что оба устройства в одной LAN/VPN и Bloop разрешён в брандмауэре.';
    list.appendChild(empty); return;
  }
  users.sort((a,b) => a.nickname.localeCompare(b.nickname));
  users.forEach(user => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;border:1px solid rgba(125,211,252,.22);border-radius:10px;margin-bottom:7px;background:rgba(8,35,52,.55)';
    const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0';
    const name = document.createElement('strong'); name.textContent = user.nickname; name.style.cssText='display:block;overflow:hidden;text-overflow:ellipsis';
    const state = document.createElement('small'); state.textContent = 'В локальной сети'; state.style.color='#7dd3fc';
    info.append(name,state);
    const existing = appState.contacts.find(c => c.type === 'peer' && c.friendCode === user.friendCode);
    const button = document.createElement('button'); button.className='brutal-btn'; button.style.cssText='padding:8px 10px;font-size:.7rem;white-space:nowrap';
    button.textContent = existing ? 'УЖЕ В ДРУЗЬЯХ' : 'ДОБАВИТЬ'; button.disabled = !!existing;
    button.onclick = () => addNearbyFriend(user);
    row.append(info,button); list.appendChild(row);
  });
}

async function addNearbyFriend(user) {
  if (!user?.ip || !user.friendCode) return;
  if (appState.contacts.some(c => c.type === 'peer' && c.friendCode === user.friendCode)) return showToast('Этот пользователь уже в друзьях');
  pendingFriendAdds.set(user.ip, { target: user.friendCode });
  const result = await window.api.connectToPeer(user.ip);
  if (result?.error) { pendingFriendAdds.delete(user.ip); return showToast(result.error); }
  if (result?.already) {
    const peer = peers.get(user.ip);
    if (peer?.dataChannel?.readyState === 'open') {
      sendOverChannel(peer,{type:'friend_request',target:user.friendCode,nickname:appState.user.nickname,avatar:appState.user.avatar,friendCode:appState.user.friendCode});
      pendingFriendAdds.delete(user.ip);
    }
  }
  showToast('Подключаемся и отправляем запрос в друзья…');
}

function setupNetworkListeners() {
  if (!window.api) return;

  window.api.onLanPeerFound?.((user) => {
    if (!user || user.friendCode === appState.user.friendCode) return;
    nearbyUsers.set(user.friendCode, { ...user, seenAt: Date.now() });
    const contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === user.friendCode);
    if (contact) {
      contact.ip = user.ip;
      contact.online = true;
      saveStateToStorage();
      const existing = peers.get(user.ip);
      if (!existing || existing.dataChannel?.readyState !== 'open') window.api.connectToPeer(user.ip).catch(() => {});
      renderActiveTab();
    }
    renderNearbyUsers();
  });
  window.api.onLanPeerLost?.(({ friendCode }) => { nearbyUsers.delete(friendCode); const c = appState.contacts.find(x => x.type === 'peer' && x.friendCode === friendCode); if (c) { c.online = false; renderActiveTab(); } renderNearbyUsers(); });
  window.api.getLanPeers?.().then(users => { (users || []).forEach(user => nearbyUsers.set(user.friendCode, user)); renderNearbyUsers(); }).catch(() => {});

  window.api.onWsConnected(({ role, ip, local }) => {
    const peer = getOrCreatePeer(ip);
    if (!peer.wsAnnounced) {
      peer.wsAnnounced = true;
      showToast(role === 'server' ? `Подключение от ${ip}` : `Соединение с ${ip}`);
    }
    if (peer.negotiationStarted) return;
    peer.negotiationStarted = true;
    peer.isCaller = (local && local !== ip) ? ipToNum(local) > ipToNum(ip) : role === 'client';

    if (peer.isCaller) {
      createPeerPC(peer);
      peer.dataChannel = peer.pc.createDataChannel('chat');
      setupDataChannel(peer);
      (async () => {
        try {
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          window.api.sendWsMessage(ip, JSON.stringify({ type: 'offer', sdp: offer, isVideoCall: false, from: appState.user.friendCode }));
        } catch (e) { console.error(e); }
      })();
    }
  });

  window.api.onWsMessage(async ({ ip, msg }) => {
    const data = safeParse(msg);
    if (!data) return;
    const peer = getOrCreatePeer(ip);

    try {
      if (data.type === 'offer') {
        // Renegotiation (camera / screen share) is not a new incoming call.
        // Handle it before isVideoCall, otherwise a video update can trigger a bogus call modal.
        if (data.isRenegotiation) {
          if (!peer.pc) createPeerPC(peer);
          if (peer.pc.signalingState === 'have-local-offer') {
            // Resolve offer glare by rolling back our unaccepted local offer.
            await peer.pc.setLocalDescription({ type: 'rollback' });
          } else if (peer.pc.signalingState !== 'stable') {
            console.warn('Ignoring colliding renegotiation offer from', ip, peer.pc.signalingState);
            return;
          }
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await flushPendingCandidates(peer);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          window.api.sendWsMessage(ip, JSON.stringify({ type: 'answer', sdp: answer, isRenegotiation: true }));
        } else if (data.isVideoCall) {
          if (data.groupId && groupCall && groupCall.groupId === data.groupId) {
            if (!peer.pc) createPeerPC(peer);
            await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            await flushPendingCandidates(peer);
            await sendMediaToPeer(peer);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            window.api.sendWsMessage(ip, JSON.stringify({ type: 'answer', sdp: answer }));
          } else {
            peer.pendingOffer = data.sdp;
            peer.pendingOfferFrom = data.from;
            peer.pendingOfferKind = data.groupId ? 'group' : 'direct';
            peer.pendingGroupId = data.groupId || null;
            peer.pendingGroupName = data.groupName || null;
            peer.pendingInitiatorName = data.initiatorName || null;
            peer.pendingInitiatorAvatar = data.initiatorAvatar || null;
            peer.pendingInitiatorCode = data.from;
            showIncomingCall(peer);
          }
        } else {
          if (!peer.pc) createPeerPC(peer);
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await flushPendingCandidates(peer);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          window.api.sendWsMessage(ip, JSON.stringify({ type: 'answer', sdp: answer }));
        }
      } else if (data.type === 'answer') {
        if (!peer.pc || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushPendingCandidates(peer);
      } else if (data.type === 'candidate') {
        if (!peer.pc) return;
        if (peer.pc.remoteDescription?.type) {
          try { await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
        } else {
          if (!peer.pendingCandidates) peer.pendingCandidates = [];
          peer.pendingCandidates.push(data.candidate);
        }
      }
    } catch (e) { console.error('WS msg error:', e); }
  });

  window.api.onWsError(({ ip, msg }) => showToast(`${ip || 'Сеть'}: ${msg}`));
  window.api.onWsDisconnected(({ ip }) => {
    showToast(`Отключено: ${ip}`);
    const peer = peers.get(ip);
    if (peer) {
      if (peer.inCall) removeParticipantFromCall(peer);
      closePeer(ip);
    }
  });
}

function getOrCreatePeer(ip) {
  if (!peers.has(ip)) {
    peers.set(ip, {
      ip, pc: null, dataChannel: null,
      friendCode: null, friendName: null, friendAvatar: null,
      isCaller: false, pendingCandidates: [], pendingOffer: null,
      inCall: false, remoteStream: null, sharingScreen: false,
      remoteAudio: null,
      incomingFiles: new Map()
    });
  }
  return peers.get(ip);
}

function closePeer(ip) {
  const peer = peers.get(ip);
  if (!peer) return;
  try { peer.dataChannel?.close(); } catch (e) {}
  try { peer.pc?.close(); } catch (e) {}
  if (peer.remoteAudio) { try { peer.remoteAudio.remove(); } catch (e) {} peer.remoteAudio = null; }
  peers.delete(ip);
}

function createPeerPC(peer) {
  if (peer.pc) return;
  peer.pc = new RTCPeerConnection({
    // STUN используется только для определения внешнего сетевого маршрута.
    // В одной LAN/VPN WebRTC по-прежнему может соединяться напрямую; TURN-сервер не задан.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  peer.pendingCandidates = [];

  peer.pc.onicecandidate = (e) => {
    if (e.candidate) {
      window.api.sendWsMessage(peer.ip, JSON.stringify({ type: 'candidate', candidate: e.candidate, from: appState.user.friendCode }));
    }
  };
  peer.pc.ontrack = (e) => handleRemoteTrack(peer, e);
  peer.pc.ondatachannel = (e) => { peer.dataChannel = e.channel; setupDataChannel(peer); };
  peer.pc.onconnectionstatechange = () => {
    if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'disconnected') {
      if (peer.inCall) { showToast('Соединение потеряно'); removeParticipantFromCall(peer); }
    }
  };
}

async function flushPendingCandidates(peer) {
  if (!peer.pendingCandidates) return;
  while (peer.pendingCandidates.length > 0) {
    const c = peer.pendingCandidates.shift();
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
  }
}

function setupDataChannel(peer) {
  if (!peer.dataChannel) return;

  peer.dataChannel.onopen = () => {
    sendOverChannel(peer, {
      type: 'profile_update',
      nickname: appState.user.nickname,
      avatar: appState.user.avatar,
      banner: appState.user.banner,
      desc: appState.user.desc,
      friendCode: appState.user.friendCode
    });

    const pending = pendingFriendAdds.get(peer.ip);
    if (pending && appState.user.isRegistered) {
      sendOverChannel(peer, {
        type: 'friend_request',
        target: pending.target,
        nickname: appState.user.nickname,
        avatar: appState.user.avatar,
        friendCode: appState.user.friendCode
      });
      pendingFriendAdds.delete(peer.ip);
    }
    const queued = pendingPeerActions.get(peer.ip) || [];
    pendingPeerActions.delete(peer.ip);
    queued.forEach((action) => sendOverChannel(peer, action));
  };

  peer.dataChannel.onmessage = (e) => {
    const data = safeParse(e.data);
    if (data) handleChannelMessage(peer, data);
  };

  peer.dataChannel.onclose = () => {
    if (peer.inCall) removeParticipantFromCall(peer);
  };
}

function sendOverChannel(peer, obj) {
  if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
    try { peer.dataChannel.send(JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }
  return false;
}

function queuePeerAction(peer, action) {
  if (!peer) return false;
  if (sendOverChannel(peer, action)) return true;
  const queue = pendingPeerActions.get(peer.ip) || [];
  queue.push(action);
  pendingPeerActions.set(peer.ip, queue);
  return false;
}

async function ensureContactConnected(contact, action) {
  if (!contact || contact.type !== 'peer') return false;
  const nearby = nearbyUsers.get(contact.friendCode);
  if (nearby?.ip) contact.ip = nearby.ip;
  if (!contact.ip) return false;
  const peer = getOrCreatePeer(contact.ip);
  if (action) queuePeerAction(peer, action);
  if (peer.dataChannel?.readyState === 'open') return true;
  try {
    const result = await window.api.connectToPeer(contact.ip);
    if (result?.error) showToast(`Не удалось подключиться к ${contact.name}: ${result.error}`);
    return !result?.error;
  } catch (e) {
    console.warn('Auto-connect failed:', e);
    return false;
  }
}

async function handleChannelMessage(peer, data) {
  if (data.type === 'camera_state') {
    peer.remoteVideoEnabled = !!data.enabled;
    if (peer.inCall) renderCallParticipants();
    return;
  }
  if (data.type === 'profile_update') { handleProfileUpdate(peer, data); return; }

  if (data.type === 'typing') {
    const c = appState.contacts.find(x => x.id === appState.activeContactId);
    const same = c && ((data.groupId && c.id === data.groupId) || (!data.groupId && c.type === 'peer' && c.friendCode === data.from));
    if (same) showTypingIndicator();
    return;
  }

  if (data.type === 'chat_wallpaper') {
    const contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.from);
    if (contact) {
      contact.wallpaper = data.wallpaper;
      saveStateToStorage();
      if (contact.id === appState.activeContactId) applyWallpaperToChat(contact.wallpaper);
    }
    return;
  }

  /* -------- ДРУЗЬЯ -------- */
  if (data.type === 'friend_request') {
    if (data.target !== appState.user.friendCode) {
      sendOverChannel(peer, { type: 'friend_reject', reason: 'wrong_friend_code' });
      return;
    }
    peer.friendCode = data.friendCode;
    peer.friendName = data.nickname;
    peer.friendAvatar = data.avatar;

    const existingContact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.friendCode);

    if (existingContact) {
      existingContact.ip = peer.ip;
      existingContact.name = data.nickname || existingContact.name;
      existingContact.avatar = data.avatar || existingContact.avatar;
      saveStateToStorage();
      sendOverChannel(peer, {
        type: 'friend_accept',
        nickname: appState.user.nickname,
        avatar: appState.user.avatar,
        friendCode: appState.user.friendCode
      });
      showToast(`${data.nickname} теперь у вас в друзьях`);
      renderActiveTab();
      return;
    }

    if (incomingFriendQueue.some(r => r.friendCode === data.friendCode)) return;
    appState.incomingRequests.push({ nickname: data.nickname, avatar: data.avatar, friendCode: data.friendCode, ip: peer.ip });
    saveStateToStorage();
    renderFriendRequests();
    showIncomingFriendRequest({ nickname: data.nickname, avatar: data.avatar, friendCode: data.friendCode, ip: peer.ip });
    return;
  }

  if (data.type === 'friend_reject') {
    showToast('Ошибка: неверный френд-код для этого IP');
    window.api?.disconnectFromPeer(peer.ip);
    closePeer(peer.ip);
    return;
  }

  if (data.type === 'friend_accept') {
    peer.friendCode = data.friendCode;
    peer.friendName = data.nickname;
    peer.friendAvatar = data.avatar;

    const exists = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.friendCode);
    if (!exists) {
      appState.contacts.push({
        id: 'peer_' + (data.friendCode || Date.now()),
        name: data.nickname, avatar: data.avatar, type: 'peer', history: [],
        friendCode: data.friendCode, ip: peer.ip
      });
      saveStateToStorage();
      renderActiveTab();
      showToast(`Друг ${data.nickname} добавлен`);
    } else {
      exists.ip = peer.ip;
      exists.name = data.nickname;
      exists.avatar = data.avatar;
      saveStateToStorage();
      renderActiveTab();
    }

    return;
  }

  if (data.type === 'friend_removed') {
    const idx = appState.contacts.findIndex(c => c.type === 'peer' && c.friendCode === data.friendCode);
    if (idx !== -1) {
      const name = appState.contacts[idx].name;
      appState.contacts.splice(idx, 1);
      saveStateToStorage();
      renderActiveTab();
      showToast(`${name} удалил вас из друзей`);
    }
    return;
  }

  if (data.type === 'message_edit') {
    let contact = null;
    if (data.groupId) contact = appState.contacts.find(c => c.type === 'group' && c.id === data.groupId);
    else if (data.from) contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.from);
    if (!contact) return;
    const msg = contact.history.find(m => m.id === data.msgId);
    if (msg) {
      const pass = data.groupId ? data.groupId : [appState.user.friendCode, data.from].sort().join('');
      const key = await E2EE.getKey(pass);
      msg.text = await E2EE.decrypt(data.newText, key);
      msg.edited = true;
      saveStateToStorage();
      if (contact.id === appState.activeContactId) updateMessageUI(msg);
    }
    return;
  }

  if (data.type === 'message_delete') {
    let contact = null;
    if (data.groupId) contact = appState.contacts.find(c => c.type === 'group' && c.id === data.groupId);
    else if (data.from) contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.from);
    if (!contact) return;
    const idx = contact.history.findIndex(m => m.id === data.msgId);
    if (idx !== -1) {
      contact.history.splice(idx, 1);
      saveStateToStorage();
      if (contact.id === appState.activeContactId) {
        const el = document.querySelector(`[data-msg-id="${data.msgId}"]`);
        if (el) el.closest('.message-row').remove();
      }
    }
    return;
  }

  if (data.type === 'file_start') {
    if (!peer.incomingFiles) peer.incomingFiles = new Map();
    peer.incomingFiles.set(data.fileId, { chunks: new Array(data.totalChunks), mime: data.mime, filename: data.filename, sender: data.sender });
    return;
  }
  if (data.type === 'file_chunk') {
    const f = peer.incomingFiles?.get(data.fileId);
    if (f) {
      const binary = atob(data.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      f.chunks[data.index] = bytes;
    }
    return;
  }
  if (data.type === 'file_end') {
    const f = peer.incomingFiles?.get(data.fileId);
    if (f) {
      const blob = new Blob(f.chunks, { type: f.mime });
      let localUrl = URL.createObjectURL(blob);
      if (window.api?.saveMedia) {
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const ext = f.mime.split('/')[1] || 'bin';
          localUrl = await window.api.saveMedia(arrayBuffer, ext);
        } catch (e) { console.error('Ошибка сохранения файла на диск', e); }
      }
      const msgType = f.mime.startsWith('video') ? 'video' : 'image';

      let contact = null;
      if (data.groupId) contact = appState.contacts.find(c => c.type === 'group' && c.id === data.groupId);
      else if (data.from) contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.from);
      if (!contact && peer.friendCode) contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === peer.friendCode);
      if (!contact) return;

      const msg = { id: data.fileId, sender: 'them', text: localUrl, msgType };
      contact.history.push(msg);
      if (contact.id === appState.activeContactId) appendMessageToDOM(msg, contact);
      saveStateToStorage();
      peer.incomingFiles.delete(data.fileId);
    }
    return;
  }

  if (data.type === 'text') {
    const pass = data.groupId ? data.groupId : [appState.user.friendCode, data.from].sort().join('');
    const key = await E2EE.getKey(pass);
    const plain = await E2EE.decrypt(data.text, key);
    const msgType = data.msgType || 'text';

    if (data.groupId) {
      const group = appState.contacts.find(c => c.type === 'group' && c.id === data.groupId);
      if (group) {
        const msg = { id: data.id || genMsgId(), sender: 'them', text: plain, msgType };
        group.history.push(msg);
        if (group.id === appState.activeContactId) appendMessageToDOM(msg, group);
        else showToast(`Сообщение в ${group.name}`);
        saveStateToStorage();
      }
      return;
    }

    let contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === data.from);
    if (!contact && peer.friendCode) contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === peer.friendCode);
    if (!contact) return;
    const msg = { id: data.id || genMsgId(), sender: 'them', text: plain, msgType };
    contact.history.push(msg);
    if (contact.id === appState.activeContactId) appendMessageToDOM(msg, contact);
    else showToast(`Сообщение от ${contact.name}`);
    saveStateToStorage();
    return;
  }

  if (data.type === 'call_rejected') { showToast('Звонок отклонён'); removeParticipantFromCall(peer); return; }
  if (data.type === 'call_ended') { removeParticipantFromCall(peer); return; }

  if (data.type === 'call_chat_message') {
    if (!isInCall) return;
    callChatMessages.push({ id: data.id, sender: 'them', text: data.text, fromCode: data.fromCode, fromName: data.fromName, timestamp: data.timestamp });
    if (isCallChatOpen()) renderCallChatMessages();
    return;
  }

  if (data.type === 'screen_share_started') {
    peer.sharingScreen = true;
    if (peer.inCall) renderCallParticipants();
    return;
  }
  if (data.type === 'screen_share_stopped') {
    peer.sharingScreen = false;
    if (peer.inCall) renderCallParticipants();
    return;
  }

  if (data.type === 'group_call_invite') {
    peer.pendingOffer = null;
    peer.incomingGroupCall = {
      groupId: data.groupId, groupName: data.groupName,
      memberCodes: Array.isArray(data.memberCodes) ? data.memberCodes : [],
      initiatorCode: data.initiatorCode, initiatorName: data.initiatorName, initiatorAvatar: data.initiatorAvatar
    };
    showGroupCallInvite(peer);
    return;
  }

  if (data.type === 'group_call_join') {
    if (groupCall && groupCall.groupId === data.groupId) {
      peer.friendCode = data.friendCode || peer.friendCode;
      peer.friendName = data.nickname || peer.friendName;
      peer.friendAvatar = data.avatar || peer.friendAvatar;
      peer.inCall = true;
      if (!groupCall.participants.has(data.friendCode)) {
        groupCall.participants.add(data.friendCode);
        startMediaWithPeer(peer);
        renderCallParticipants();
      }
    }
    return;
  }
}

/* ============================================================
   ЛОГИКА ГРУППОВОГО ЗВОНКА (MESH)
   ============================================================ */
async function startGroupCall() {
  const contact = appState.contacts.find(c => c.id === appState.activeContactId);
  if (!contact || contact.type !== 'group') return showToast('Выберите группу');
  if (isInCall) return showToast('Уже в звонке');

  const members = contact.members
    .map(fc => appState.contacts.find(x => x.type === 'peer' && x.friendCode === fc))
    .filter(Boolean);
  const reachable = members.filter(c => c.ip || nearbyUsers.has(c.friendCode));
  if (reachable.length === 0) return showToast('Друзья пока не обнаружены в сети');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    groupCall = {
      groupId: contact.id, groupName: contact.name,
      initiatorCode: appState.user.friendCode,
      participants: new Set([appState.user.friendCode])
    };
    isInCall = true;
    isMuted = false;
    callChatMessages = [];
    setMuteUI(false);
    callTitle = `Групповой звонок: ${contact.name}`;
    openCallScreen();

    const invite = {
      type: 'group_call_invite',
      groupId: contact.id, groupName: contact.name,
      memberCodes: [appState.user.friendCode, ...contact.members],
      initiatorCode: appState.user.friendCode, initiatorName: appState.user.nickname, initiatorAvatar: appState.user.avatar
    };
    reachable.forEach(member => ensureContactConnected(member, invite));
    showToast(`Приглашения отправлены ${reachable.length} участникам`);
  } catch (e) {
    console.error('Group call start failed:', e);
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
    isInCall = false; groupCall = null;
    $('call-screen')?.classList.add('hidden');
    showToast(e?.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону' : 'Не удалось начать групповой звонок');
  }
}

async function acceptGroupInvite(info) {
  const { peer } = info;
  const g = peer.incomingGroupCall;
  if (!g) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    isInCall = true;
    isMuted = false;
    callChatMessages = [];
    setMuteUI(false);

    groupCall = {
      groupId: info.groupId,
      groupName: info.groupName,
      initiatorCode: g.initiatorCode,
      participants: new Set([g.initiatorCode, appState.user.friendCode])
    };

    callTitle = `Групповой звонок: ${info.groupName}`;
    openCallScreen();

    addParticipantToCall(peer, g.initiatorCode, g.initiatorName, g.initiatorAvatar);

    // Group IDs are local storage IDs and can differ across devices. The invite carries
    // stable friend codes so each participant can establish its own direct mesh links.
    const memberCodes = Array.isArray(g.memberCodes) ? g.memberCodes : [];
    memberCodes.forEach(fc => {
      if (fc === appState.user.friendCode) return;
      const member = appState.contacts.find(x => x.type === 'peer' && x.friendCode === fc);
      if (!member) return;
      ensureContactConnected(member, {
        type: 'group_call_join',
        groupId: info.groupId,
        friendCode: appState.user.friendCode,
        nickname: appState.user.nickname,
        avatar: appState.user.avatar
      });
    });
  } catch (e) {
    console.error('Accept group call failed:', e);
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
    isInCall = false; groupCall = null;
    $('call-screen')?.classList.add('hidden');
    showToast(e?.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону' : 'Не удалось подключиться к групповому звонку');
    sendOverChannel(peer, { type: 'call_rejected' });
  }
}

async function startMediaWithPeer(peer) {
  if (!peer.pc) createPeerPC(peer);
  if (peer.pc.signalingState !== 'stable') throw new Error('WebRTC signaling is not stable');

  if (localStream) {
    for (const track of localStream.getTracks()) {
      const sender = peer.pc.getSenders().find(item => item.track === track) || getSenderForKind(peer, track.kind);
      if (sender) await sender.replaceTrack(track);
      else peer.pc.addTrack(track, localStream);
    }
  }

  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    window.api.sendWsMessage(peer.ip, JSON.stringify({
      type: 'offer',
      sdp: offer,
      isVideoCall: true,
      from: appState.user.friendCode,
      groupId: groupCall?.groupId,
      groupName: groupCall?.groupName,
      initiatorName: appState.user.nickname,
      initiatorAvatar: appState.user.avatar
    }));
  } catch (e) {
    console.error('startMedia error', e);
    throw e;
  }
}

/* ============================================================
   ОСТАЛЬНОЙ КОД ЗВОНКОВ
   ============================================================ */
async function startCall() {
  const contact = appState.contacts.find(c => c.id === appState.activeContactId);
  if (!contact || contact.type !== 'peer') return showToast('Выберите друга');
  if (!contact.ip) return showToast('У контакта нет IP');
  if (isInCall) return showToast('Уже в звонке');
  const peer = peers.get(contact.ip);
  if (!peer || !peer.pc) return showToast('Нет соединения');
  if (!peer.dataChannel || peer.dataChannel.readyState !== 'open') return showToast('Канал не готов');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    isInCall = true;
    isMuted = false;
    callChatMessages = [];
    setMuteUI(false);
    callTitle = `Звонок: ${contact.name}`;
    openCallScreen();
    addParticipantToCall(peer, contact.friendCode, contact.name, contact.avatar);
    await startMediaWithPeer(peer);
    showToast('Идёт вызов...');
  } catch (e) {
    console.error('Outgoing call start failed:', e);
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
    isInCall = false; groupCall = null;
    const peer = contact?.ip ? peers.get(contact.ip) : null;
    if (peer) { peer.inCall = false; document.querySelector(`[data-peer-ip="${peer.ip}"]`)?.remove(); }
    $('call-screen')?.classList.add('hidden');
    showToast(e?.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону' : 'Не удалось начать звонок');
  }
}

async function acceptCall() {
  closeModal('incoming-call-modal');
  const info = incomingOfferData;
  incomingOfferData = null;
  if (!info) return;
  if (info.kind === 'group') return acceptGroupInvite(info);

  const { peer } = info;
  if (!peer.pc) createPeerPC(peer);

  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(peer.pendingOffer));
    await flushPendingCandidates(peer);
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const incomingContact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === peer.pendingOfferFrom);
    await sendMediaToPeer(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    window.api.sendWsMessage(peer.ip, JSON.stringify({ type: 'answer', sdp: answer }));

    isInCall = true;
    isMuted = false;
    callChatMessages = [];
    setMuteUI(false);

    const contact = appState.contacts.find(c => c.type === 'peer' && c.friendCode === peer.pendingOfferFrom);
    callTitle = `Звонок: ${contact?.name || peer.pendingInitiatorName || 'Собеседник'}`;
    openCallScreen();
    addParticipantToCall(peer, peer.pendingOfferFrom, contact?.name || peer.pendingInitiatorName, contact?.avatar || peer.pendingInitiatorAvatar);
  } catch (e) {
    console.error('accept error', e);
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
    isInCall = false;
    $('call-screen')?.classList.add('hidden');
    showToast('Не удалось подключить звонок. Проверьте сеть и разрешения.');
  }
}

function getSenderForKind(peer, kind) {
  if (!peer?.pc) return null;
  const active = peer.pc.getSenders().find(sender => sender.track?.kind === kind);
  if (active) return active;
  const transceiver = peer.pc.getTransceivers().find(item => item.receiver?.track?.kind === kind);
  return transceiver?.sender || null;
}

function getVideoSender(peer) {
  if (!peer?.pc) return null;
  return getSenderForKind(peer, 'video');
}

async function toggleCamera() {
  if (!isInCall) return showToast('Сначала начните звонок');
  const button = $('btn-camera');
  try {
    if (cameraStream) {
      const cameraTrack = cameraStream.getVideoTracks()[0];
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
      for (const peer of peers.values()) {
        if (!peer.inCall || !peer.pc) continue;
        // If screen sharing replaced the camera track, keep the screen live and
        // clear only the camera track that should be restored after sharing ends.
        if (peer.screenSender && peer.preScreenTrack === cameraTrack) {
          peer.preScreenTrack = null;
          continue;
        }
        const sender = peer.cameraSender || getVideoSender(peer);
        if (sender) await sender.replaceTrack(null).catch(() => {});
        peer.cameraTrack = null;
        peer.cameraSender = null;
        sendOverChannel(peer, { type: 'camera_state', enabled: false });
      }
      const selfVideo = $('self-tile')?.querySelector('video');
      if (selfVideo) selfVideo.remove();
      if (button) { button.classList.remove('active'); button.textContent = 'КАМЕРА'; button.title = 'Включить камеру'; }
      showToast('Камера выключена');
      return;
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      audio: false
    });
    const track = cameraStream.getVideoTracks()[0];
    for (const peer of peers.values()) {
      if (!peer.inCall || !peer.pc) continue;
      let sender = getVideoSender(peer);
      if (peer.screenSender && peer.screenSender === sender) {
        peer.preScreenTrack = track;
        peer.cameraTrack = track;
        peer.cameraSender = sender;
        sendOverChannel(peer, { type: 'camera_state', enabled: true });
        continue;
      }
      if (sender) await sender.replaceTrack(track);
      else {
        sender = peer.pc.addTrack(track, cameraStream);
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        window.api.sendWsMessage(peer.ip, JSON.stringify({ type: 'offer', sdp: offer, isRenegotiation: true, from: appState.user.friendCode }));
      }
      peer.cameraSender = sender;
      peer.cameraTrack = track;
      sendOverChannel(peer, { type: 'camera_state', enabled: true });
    }
    const selfTile = $('self-tile');
    if (selfTile) {
      let video = selfTile.querySelector('video');
      if (!video) { video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true; video.style.cssText = 'width:100%;height:100%;object-fit:cover;'; selfTile.prepend(video); }
      video.srcObject = cameraStream;
    }
    if (button) { button.classList.add('active'); button.textContent = 'КАМЕРА ВКЛ'; button.title = 'Выключить камеру'; }
    showToast('Камера включена');
  } catch (error) {
    console.error('Camera toggle failed:', error);
    if (cameraStream) { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; }
    showToast(error?.name === 'NotAllowedError' ? 'Разрешите доступ к камере' : 'Не удалось включить камеру. Проверьте разрешение на доступ.');
  }
}

async function sendMediaToPeer(peer) {
  if (!peer.pc || !localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  const existing = getSenderForKind(peer, 'audio');
  if (existing) await existing.replaceTrack(audioTrack);
  else peer.pc.addTrack(audioTrack, localStream);
}

function showIncomingCall(peer) {
  incomingOfferData = { peer, kind: 'direct' };
  $('incoming-call-subtitle').textContent = 'Индивидуальный звонок';
  $('incoming-caller-name').textContent = peer.pendingInitiatorName || 'Пользователь';
  openModal('incoming-call-modal');
}

function showGroupCallInvite(peer) {
  const g = peer.incomingGroupCall;
  incomingOfferData = { peer, kind: 'group', groupId: g.groupId, groupName: g.groupName };
  $('incoming-call-subtitle').textContent = `Группа: ${g.groupName || '—'}`;
  $('incoming-caller-name').textContent = `Звонок от ${g.initiatorName || 'Пользователя'}`;
  openModal('incoming-call-modal');
}

function declineCall() {
  closeModal('incoming-call-modal');
  const info = incomingOfferData;
  incomingOfferData = null;
  if (!info) return;
  const missedName = info.kind === 'group' ? (info.groupName || 'Групповой звонок') : (info.peer.pendingInitiatorName || 'Собеседник');
  sendOverChannel(info.peer, { type: 'call_rejected' });
  info.peer.pendingOffer = null;
}

function endCall(silent = false) {
  if (!silent) {
    peers.forEach(peer => {
      if (peer.inCall) sendOverChannel(peer, { type: 'call_ended' });
      if (peer.inCall && peer.sharingScreen) sendOverChannel(peer, { type: 'screen_share_stopped', from: appState.user.friendCode });
      if (peer.inCall) sendOverChannel(peer, { type: 'camera_state', enabled: false });
    });
  }

  if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
  if (cameraStream) { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(track => track.stop()); screenStream = null; }
  if ($('btn-camera')) { $('btn-camera').classList.remove('active'); $('btn-camera').textContent = 'КАМЕРА'; $('btn-camera').title = 'Включить камеру'; }
  if ($('btn-share-screen')) $('btn-share-screen').style.display = 'flex';
  if ($('btn-stop-share')) $('btn-stop-share').style.display = 'none';

  $('call-screen').classList.add('hidden');
  $('mini-call').classList.add('hidden');
  $('call-settings-panel').classList.add('hidden');
  $('call-chat-panel').classList.add('hidden');
  clearInterval(callTimerInterval);
  $('call-video-grid').innerHTML = '';
  $('my-screen-container')?.remove();

  peers.forEach(peer => {
    peer.inCall = false;
    // The RTCPeerConnection also owns the text-chat data channel. Stop only media
    // tracks; closing the whole PC here silently breaks messaging after the first call.
    if (peer.pc) {
      peer.pc.getSenders().forEach(sender => {
        if (sender.track && (sender.track.kind === 'audio' || sender.track.kind === 'video')) {
          sender.replaceTrack(null).catch(() => {});
        }
      });
    }
    peer.cameraSender = null;
    peer.cameraTrack = null;
    peer.screenSender = null;
    peer.screenTrack = null;
    peer.preScreenTrack = null;
    peer.sharingScreen = false;
    peer.remoteVideoEnabled = false;
    // Keep remoteStream and remoteAudio attached to the live peer connection. Reusing
    // the transceivers lets the next call resume without renegotiating the chat channel.
  });
  groupCall = null;
  callChatMessages = [];
  isInCall = false;
  isMuted = false;
  callSettings.mutedPeers.clear();
}

function openCallScreen() {
  $('call-screen').classList.remove('hidden');
  $('mini-call').classList.add('hidden');
  $('call-video-grid').innerHTML = '';
  $('call-title').textContent = callTitle || 'Звонок';
  $('mini-call-title').textContent = callTitle || 'Звонок';

  const selfTile = document.createElement('div');
  selfTile.className = 'video-container';
  selfTile.id = 'self-tile';
  selfTile.innerHTML = `
    <div class="call-avatar-large"><img src="${appState.user.avatar || defaultAvatar}"></div>
    <div class="participant-name">Вы</div>
  `;
  $('call-video-grid').appendChild(selfTile);

  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    const t = `${m}:${s}`;
    if ($('call-timer')) $('call-timer').textContent = t;
    if ($('mini-call-timer')) $('mini-call-timer').textContent = t;
  }, 1000);
}

function addParticipantToCall(peer, friendCode, name, avatar) {
  peer.inCall = true;
  peer.friendCode = friendCode || peer.friendCode;
  peer.friendName = name || peer.friendName;
  peer.friendAvatar = avatar || peer.friendAvatar;
  if (groupCall && friendCode) groupCall.participants.add(friendCode);
  renderCallParticipants();
  renderParticipantMuteList();
}

function fillTileWithAvatar(tile, peer) {
  tile.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'call-avatar-large';
  const img = document.createElement('img');
  img.src = peer.friendAvatar || defaultAvatar;
  img.onerror = () => { img.src = defaultAvatar; };
  wrap.appendChild(img);
  const name = document.createElement('div');
  name.className = 'participant-name';
  name.textContent = peer.friendName || 'Собеседник';
  tile.appendChild(wrap);
  tile.appendChild(name);
}

function renderCallParticipants() {
  const grid = $('call-video-grid');
  if (!grid) return;

  Array.from(grid.querySelectorAll('[data-peer-ip]')).forEach(el => {
    const p = peers.get(el.getAttribute('data-peer-ip'));
    if (!p || !p.inCall) el.remove();
  });

  peers.forEach(peer => {
    if (!peer.inCall) return;
    let tile = grid.querySelector(`[data-peer-ip="${peer.ip}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-container';
      tile.setAttribute('data-peer-ip', peer.ip);
      fillTileWithAvatar(tile, peer);

      tile.onclick = () => {
        const isFocused = tile.classList.contains('focused');
        document.querySelectorAll('.video-container').forEach(t => t.classList.remove('focused'));
        if (!isFocused) {
          tile.classList.add('focused');
          if (!tile.querySelector('.focus-close-btn')) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'focus-close-btn';
            closeBtn.textContent = '×';
            closeBtn.onclick = (e) => { e.stopPropagation(); tile.classList.remove('focused'); };
            tile.appendChild(closeBtn);
          }
        }
      };

      grid.appendChild(tile);
    }

    const existingVideo = tile.querySelector('video');
    if ((peer.remoteVideoEnabled !== false || peer.sharingScreen) && peer.remoteStream && peer.remoteStream.getVideoTracks().some(track => track.readyState === 'live')) {
      if (!existingVideo) {
        tile.textContent = '';
        const v = document.createElement('video');
        v.srcObject = peer.remoteStream;
        v.autoplay = true; v.playsInline = true;
        v.style.cssText = 'width:100%; height:100%; object-fit:contain; background:#000;';
        tile.appendChild(v);
        const name = document.createElement('div');
        name.className = 'participant-name';
        name.textContent = peer.friendName || 'Собеседник';
        tile.appendChild(name);
        tile.classList.add('active-speaker');
        tile.classList.toggle('screen-share', !!peer.sharingScreen);
        const shares = grid.querySelectorAll('.screen-share');
        if (peer.sharingScreen && shares.length === 1) {
          grid.querySelectorAll('.video-container').forEach(t => t.classList.remove('focused'));
          tile.classList.add('focused');
          if (!tile.querySelector('.focus-close-btn')) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'focus-close-btn';
            closeBtn.textContent = '×';
            closeBtn.onclick = (e) => { e.stopPropagation(); tile.classList.remove('focused'); };
            tile.appendChild(closeBtn);
          }
        }
      } else if (existingVideo.srcObject !== peer.remoteStream) {
        existingVideo.srcObject = peer.remoteStream;
      }
      tile.classList.toggle('screen-share', !!peer.sharingScreen);
    } else if (!peer.sharingScreen && existingVideo) {
      tile.classList.remove('active-speaker');
      tile.classList.remove('screen-share');
      fillTileWithAvatar(tile, peer);
    }
  });
}

function removeParticipantFromCall(peer) {
  peer.inCall = false;
  const tile = document.querySelector(`[data-peer-ip="${peer.ip}"]`);
  if (tile) tile.remove();
  if (groupCall) renderCallParticipants();
  renderParticipantMuteList();
  const anyone = Array.from(peers.values()).some(p => p.inCall);
  if (!anyone && isInCall) endCall(true);
}

function handleRemoteTrack(peer, event) {
  if (event.track.kind === 'video') {
    if (!peer.remoteStream) peer.remoteStream = new MediaStream();
    const incomingStream = event.streams?.[0];
    const tracks = incomingStream ? incomingStream.getVideoTracks() : [event.track];
    tracks.forEach(track => {
      if (!peer.remoteStream.getTracks().some(existing => existing.id === track.id)) peer.remoteStream.addTrack(track);
    });
    peer.remoteVideoEnabled = true;
    event.track.onended = () => {
      if (peer.remoteStream?.getTracks().some(track => track.id === event.track.id)) peer.remoteStream.removeTrack(event.track);
      if (!peer.remoteStream?.getVideoTracks().some(track => track.readyState === 'live')) peer.remoteVideoEnabled = false;
      if (peer.inCall) renderCallParticipants();
    };
    if (peer.inCall) renderCallParticipants();
    return;
  }

  if (event.track.kind === 'audio') {
    let audioEl = peer.remoteAudio;
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.setAttribute('data-peer-audio', peer.ip);
      document.body.appendChild(audioEl);
      peer.remoteAudio = audioEl;
    }
    const stream = event.streams[0] || new MediaStream([event.track]);
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
      audioEl.volume = 1.0;
      const p = audioEl.play();
      if (p && p.catch) p.catch(err => console.warn('play failed', err));
    }
    applyVolumeToPeer(peer);
  }
}

function applyVolumeToPeer(peer) {
  if (!peer.remoteAudio) return;
  const key1 = peer.friendCode;
  const key2 = peer.ip;
  const isMutedPeer = callSettings.mutedPeers.has(key1) || callSettings.mutedPeers.has(key2);
  peer.remoteAudio.volume = isMutedPeer ? 0 : Math.max(0, Math.min(1, callSettings.masterVolume));
}

function applyAudioSettings() { peers.forEach(p => applyVolumeToPeer(p)); }

function setMuteUI(muted) {
  $('btn-mute').style.display = muted ? 'none' : 'flex';
  $('btn-unmute').style.display = muted ? 'flex' : 'none';
  const miniBtn = $('mini-btn-mute');
  if (miniBtn) {
    miniBtn.querySelector('.icon-unmuted').style.display = muted ? 'none' : 'block';
    miniBtn.querySelector('.icon-muted').style.display = muted ? 'block' : 'none';
  }
}

function toggleMute() {
  if (!isInCall) return;
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  setMuteUI(isMuted);
}

function openCallSettings() {
  $('call-settings-panel').classList.remove('hidden');
  $('master-volume').value = String(Math.round(callSettings.masterVolume * 100));
  $('master-vol-label').textContent = Math.round(callSettings.masterVolume * 100) + '%';
  renderParticipantMuteList();
}
function closeCallSettings() { $('call-settings-panel').classList.add('hidden'); }

function renderParticipantMuteList() {
  const list = $('participant-mute-list');
  if (!list) return;
  list.innerHTML = '';
  const inCallPeers = Array.from(peers.values()).filter(p => p.inCall);
  if (inCallPeers.length === 0) {
    const e = document.createElement('p');
    e.style.cssText = 'color:#8ca2b3; font-size:0.8rem;';
    e.textContent = 'Пока никого нет';
    list.appendChild(e);
    return;
  }
  inCallPeers.forEach(p => {
    const row = document.createElement('label');
    row.className = 'participant-mute-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const key = p.friendCode || p.ip;
    cb.checked = callSettings.mutedPeers.has(key);
    cb.onchange = () => {
      if (cb.checked) callSettings.mutedPeers.add(key);
      else callSettings.mutedPeers.delete(key);
      applyVolumeToPeer(p);
    };
    const name = document.createElement('span');
    name.textContent = p.friendName || p.ip;
    const av = document.createElement('img');
    av.src = p.friendAvatar || defaultAvatar;
    av.className = 'participant-mute-avatar';
    row.appendChild(av); row.appendChild(name); row.appendChild(cb);
    list.appendChild(row);
  });
}

function minimizeCall() {
  $('call-screen').classList.add('hidden');
  $('mini-call').classList.remove('hidden');
  $('mini-call-title').textContent = callTitle || 'Звонок';
  $('mini-call-timer').textContent = $('call-timer').textContent || '00:00';
  setMuteUI(isMuted);
}
function expandCall() {
  $('mini-call').classList.add('hidden');
  $('call-screen').classList.remove('hidden');
}

function setupMiniCallDrag() {
  const mini = $('mini-call');
  const handle = $('mini-drag-handle');
  if (!mini || !handle) return;
  let dragging = false;
  let offset = { x: 0, y: 0 };
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = mini.getBoundingClientRect();
    offset.x = e.clientX - rect.left;
    offset.y = e.clientY - rect.top;
    mini.style.bottom = 'auto'; mini.style.right = 'auto';
    mini.style.left = rect.left + 'px'; mini.style.top = rect.top + 'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = mini.offsetWidth, h = mini.offsetHeight;
    mini.style.left = Math.max(0, Math.min(window.innerWidth - w, e.clientX - offset.x)) + 'px';
    mini.style.top = Math.max(0, Math.min(window.innerHeight - h, e.clientY - offset.y)) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

function isCallChatOpen() {
  const p = $('call-chat-panel');
  return p && !p.classList.contains('hidden');
}

function toggleCallChat() {
  const panel = $('call-chat-panel');
  if (!panel) return;
  if (isCallChatOpen()) panel.classList.add('hidden');
  else {
    panel.classList.remove('hidden');
    renderCallChatMessages();
    setTimeout(() => $('call-chat-input').focus(), 50);
  }
}

function renderCallChatMessages() {
  const list = $('call-chat-messages');
  if (!list) return;
  list.innerHTML = '';
  callChatMessages.forEach(m => {
    const row = document.createElement('div');
    row.className = `mini-chat-msg ${m.sender === 'me' ? 'mine' : ''}`;
    if (m.sender !== 'me' && m.fromName) {
      const sender = document.createElement('div');
      sender.className = 'mini-chat-sender';
      sender.textContent = m.fromName;
      row.appendChild(sender);
    }
    const txt = document.createElement('div');
    txt.textContent = m.text;
    row.appendChild(txt);
    list.appendChild(row);
  });
  list.scrollTop = list.scrollHeight;
}

function sendCallChatMessage() {
  const input = $('call-chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!isInCall) return;

  const msg = { id: genMsgId(), sender: 'me', text, fromCode: appState.user.friendCode, fromName: appState.user.nickname, timestamp: Date.now() };
  callChatMessages.push(msg);

  const payload = { type: 'call_chat_message', id: msg.id, text, fromCode: msg.fromCode, fromName: msg.fromName, timestamp: msg.timestamp };
  peers.forEach(p => { if (p.inCall && p.dataChannel?.readyState === 'open') sendOverChannel(p, payload); });

  input.value = '';
  renderCallChatMessages();
}

async function toggleScreenShare() {
  const btnShare = $('btn-share-screen');
  const btnStop = $('btn-stop-share');

  if (screenStream) {
    const oldStream = screenStream;
    for (const peer of peers.values()) {
      if (!peer.inCall || !peer.pc) continue;
      const sender = peer.screenSender || getVideoSender(peer);
      const restoreTrack = peer.preScreenTrack?.readyState === 'live' ? peer.preScreenTrack : null;
      if (sender) await sender.replaceTrack(restoreTrack).catch(() => {});
      peer.screenSender = null;
      peer.screenTrack = null;
      peer.preScreenTrack = null;
      sendOverChannel(peer, { type: 'screen_share_stopped', from: appState.user.friendCode });
      sendOverChannel(peer, { type: 'camera_state', enabled: !!restoreTrack });
    }
    oldStream.getTracks().forEach(track => track.stop());
    screenStream = null;
    btnShare.style.display = 'flex';
    btnStop.style.display = 'none';
    $('my-screen-container')?.remove();
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = screenStream.getVideoTracks()[0];

    const vc = document.createElement('div');
    vc.className = 'video-container active-speaker focused screen-share';
    vc.id = 'my-screen-container';
    const v = document.createElement('video');
    v.srcObject = screenStream;
    v.autoplay = true; v.playsInline = true; v.muted = true;
    v.style.cssText = 'width:100%; height:100%; object-fit:contain; background:#000;';
    vc.appendChild(v);
    const lbl = document.createElement('div');
    lbl.className = 'participant-name';
    lbl.textContent = 'Ваш экран';
    vc.appendChild(lbl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'focus-close-btn';
    closeBtn.textContent = '×';
    closeBtn.onclick = (e) => { e.stopPropagation(); vc.classList.remove('focused'); };
    vc.appendChild(closeBtn);
    $('call-video-grid').prepend(vc);

    btnShare.style.display = 'none';
    btnStop.style.display = 'flex';
    track.onended = () => { if (screenStream) toggleScreenShare(); };

    for (const peer of peers.values()) {
      if (!peer.inCall || !peer.pc) continue;
      let sender = getVideoSender(peer);
      const needsNegotiation = !sender;
      if (sender) {
        peer.preScreenTrack = sender.track?.kind === 'video' ? sender.track : null;
        peer.screenSender = sender;
        await sender.replaceTrack(track);
      } else {
        sender = peer.pc.addTrack(track, screenStream);
        peer.screenSender = sender;
      }
      peer.screenTrack = track;
      sendOverChannel(peer, { type: 'screen_share_started', from: appState.user.friendCode });
      sendOverChannel(peer, { type: 'camera_state', enabled: true });
      if (needsNegotiation) {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        window.api.sendWsMessage(peer.ip, JSON.stringify({ type: 'offer', sdp: offer, isRenegotiation: true, from: appState.user.friendCode }));
      }
    }
  } catch (e) {
    console.error('share error', e);
    if (screenStream) { screenStream.getTracks().forEach(track => track.stop()); screenStream = null; }
    $('my-screen-container')?.remove();
    btnShare.style.display = 'flex';
    btnStop.style.display = 'none';
    showToast(e?.name === 'NotAllowedError' ? 'Доступ к демонстрации экрана отменён' : 'Не удалось начать демонстрацию экрана');
  }
}

function copyCallLink() {
  const text = `bloop://call/${appState.user.friendCode}`;
  let ok = false;
  if (window.api?.writeClipboard) ok = window.api.writeClipboard(text);
  if (!ok && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  showToast('Ссылка скопирована');
}
window.copyCallLink = copyCallLink;

/* ============================================================
   ОБЫЧНЫЕ СООБЩЕНИЯ (E2EE)
   ============================================================ */
async function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const contact = appState.contacts.find(c => c.id === appState.activeContactId);
  if (!contact) return;

  if (editingMsgId) {
    const msg = contact.history.find(m => m.id === editingMsgId);
    if (msg) {
      msg.text = text;
      msg.edited = true;
      saveStateToStorage();
      updateMessageUI(msg);

      const pass = contact.type === 'group' ? contact.id : [appState.user.friendCode, contact.friendCode].sort().join('');
      const key = await E2EE.getKey(pass);
      const encText = await E2EE.encrypt(text, key);

      const payload = { type: 'message_edit', msgId: msg.id, newText: encText, from: appState.user.friendCode, groupId: contact.type === 'group' ? contact.id : null };
      if (contact.type === 'peer' && contact.ip) {
        const p = peers.get(contact.ip);
        if (p) sendOverChannel(p, payload);
      } else if (contact.type === 'group') {
        contact.members.forEach(fc => {
          const m = appState.contacts.find(x => x.type === 'peer' && x.friendCode === fc);
          if (m?.ip) { const p = peers.get(m.ip); if (p) sendOverChannel(p, payload); }
        });
      }
    }
    cancelEditMessage();
    return;
  }


  const msg = { id: genMsgId(), sender: 'me', text, msgType: 'text' };
  contact.history.push(msg);
  appendMessageToDOM(msg, contact);
  input.value = '';
  autoResizeInput();
  saveStateToStorage();

  if (contact.type === 'ai') { replyAI(contact); return; }

  const pass = contact.type === 'group' ? contact.id : [appState.user.friendCode, contact.friendCode].sort().join('');
  const key = await E2EE.getKey(pass);
  const encText = await E2EE.encrypt(text, key);

  const payload = { type: 'text', id: msg.id, text: encText, msgType: 'text', from: appState.user.friendCode, fromName: appState.user.nickname };
  if (contact.type === 'group') {
    payload.groupId = contact.id;
    // Сообщения группы отправляются каждому участнику, с которым уже есть прямое соединение.
    contact.members.forEach(fc => {
      const m = appState.contacts.find(c => c.type === 'peer' && c.friendCode === fc);
      if (!m || !m.ip) return;
      const peer = peers.get(m.ip);
      if (peer) sendOverChannel(peer, payload);
    });
  } else if (contact.type === 'peer' && contact.ip) {
    const peer = peers.get(contact.ip);
    if (!peer) return showToast('Нет соединения — сохранили локально');
    sendOverChannel(peer, payload);
  }
}

async function sendFile(file) {
  const contact = appState.contacts.find(c => c.id === appState.activeContactId);
  if (!contact) return;

  const msgType = file.type.startsWith('video') ? 'video' : 'image';
  const buffer = await file.arrayBuffer();

  let localUrl = URL.createObjectURL(file);
  if (window.api?.saveMedia) {
    try {
      const ext = file.name.split('.').pop() || 'bin';
      localUrl = await window.api.saveMedia(buffer, ext);
    } catch (e) { console.error('Ошибка сохранения файла на диск', e); }
  }

  const msg = { id: genMsgId(), sender: 'me', text: localUrl, msgType };
  contact.history.push(msg);
  appendMessageToDOM(msg, contact);
  saveStateToStorage();

  if (contact.type === 'ai') return;

  const fileId = msg.id;
  const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

  let targets = [];
  if (contact.type === 'group') {
    contact.members.forEach(fc => {
      const m = appState.contacts.find(c => c.type === 'peer' && c.friendCode === fc);
      if (m?.ip) { const p = peers.get(m.ip); if (p) targets.push(p); }
    });
  } else if (contact.type === 'peer' && contact.ip) {
    const p = peers.get(contact.ip);
    if (p) targets.push(p);
  }

  for (const peer of targets) {
    sendOverChannel(peer, { type: 'file_start', fileId, totalChunks, mime: file.type, filename: file.name, sender: appState.user.nickname, from: appState.user.friendCode, groupId: contact.type === 'group' ? contact.id : null });
  }

  for (let i = 0; i < totalChunks; i++) {
    const chunk = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    let binary = '';
    const bytes = new Uint8Array(chunk);
    for (let j = 0; j < bytes.byteLength; j++) binary += String.fromCharCode(bytes[j]);
    const base64 = btoa(binary);

    for (const peer of targets) {
      sendOverChannel(peer, { type: 'file_chunk', fileId, index: i, data: base64 });
      while (peer.dataChannel && peer.dataChannel.bufferedAmount > 512 * 1024) {
        await new Promise(r => setTimeout(r, 20));
      }
    }
  }

  for (const peer of targets) {
    sendOverChannel(peer, { type: 'file_end', fileId, from: appState.user.friendCode, groupId: contact.type === 'group' ? contact.id : null });
  }
}

/* ============================================================
   ОСТАЛЬНЫЕ УТИЛИТЫ И UI
   ============================================================ */
function replyAI(contact) {
  const a = ['Привет! Я Bloop AI.', 'Расскажи подробнее.', 'Понял 🎮', 'Круто!', 'Найди друга по нику и добавь его в контакты.'];
  const r = a[Math.floor(Math.random() * a.length)];
  setTimeout(() => {
    const msg = { id: genMsgId(), sender: 'them', text: r, msgType: 'text' };
    contact.history.push(msg);
    if (contact.id === appState.activeContactId) appendMessageToDOM(msg, contact);
    saveStateToStorage();
  }, 600);
}

function showToast(message) {
  const c = $('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function hardReset() {
  localStorage.removeItem('bloop_state');
  localStorage.removeItem('bloop_binds');
  localStorage.removeItem('bloop_theme');
  localStorage.removeItem('bloop_grad_color');
  sessionStorage.clear();
  window.location.reload();
}

function loadStateFromStorage() {
  const saved = localStorage.getItem('bloop_state');
  if (saved) {
    const parsed = safeParse(saved);
    if (parsed) {
      appState = parsed;
      const removedLegacyCallHistory = Object.prototype.hasOwnProperty.call(appState, 'callHistory');
      delete appState.callHistory; // История звонков не является отдельным разделом приложения.
      appState.activeTab = appState.activeTab === 'groups' ? 'groups' : 'contacts';
      if (!Array.isArray(appState.contacts)) appState.contacts = [];
      if (!Array.isArray(appState.incomingRequests)) appState.incomingRequests = [];
      if (!appState.user) appState.user = { nickname: '', desc: '', avatar: defaultAvatar, banner: '', friendCode: generateFriendCode(), isRegistered: false };
      if (!appState.user.friendCode) appState.user.friendCode = generateFriendCode();
      if (!appState.user.avatar) appState.user.avatar = defaultAvatar;
      // Плейсхолдеры не сохраняются, но на всякий случай вычистим
      appState.contacts = appState.contacts.filter(c => !c.isPlaceholder);
      appState.contacts.forEach(c => {
        if (!Array.isArray(c.history)) c.history = [];
        c.history.forEach(m => { if (!m.id) m.id = genMsgId(); });
      });
      if (removedLegacyCallHistory) saveStateToStorage();
    } else { hardReset(); return; }
  } else {
    appState.user.friendCode = generateFriendCode();
    appState.contacts = [{ id: 'ai_1', name: 'BLOOP AI', avatar: defaultAvatar, type: 'ai', history: [] }];
    saveStateToStorage();
  }
}

function saveStateToStorage() {
  try {
    const toSave = {
      ...appState,
      contacts: appState.contacts.filter(c => !c.isPlaceholder)
    };
    localStorage.setItem('bloop_state', JSON.stringify(toSave));
  } catch (e) {}
}

function updateProfileUI() {
  if ($('main-player-name')) $('main-player-name').textContent = appState.user.nickname || 'User';
  if ($('main-player-avatar')) $('main-player-avatar').innerHTML = `<img src="${appState.user.avatar || defaultAvatar}">`;
  renderFriendRequests();
}

function openModal(id) { $(id)?.classList.add('active'); }
function closeModal(id) { $(id)?.classList.remove('active'); }

function openCropper(imageSrc, target, type = 'avatar') {
  currentAvatarTarget = target;
  cropType = type;
  $('crop-image').src = imageSrc;
  openModal('avatar-crop-modal');
  if (cropperInstance) cropperInstance.destroy();
  if (typeof Cropper !== 'undefined') {
    const aspect = type === 'banner' ? 3 : (type === 'wallpaper' ? 16/9 : 1);
    cropperInstance = new Cropper($('crop-image'), { aspectRatio: aspect, viewMode: 1, background: false });
  }
}

const BLOOP_RELEASES = [
  { id: '1.0.0-beta', version: '1.0.0 Beta', label: 'Текущая', tag: 'BETA', title: 'Bloop 1.0.0 Beta', date: 'Первый публичный бета-релиз', summary: 'Базовая версия мессенджера для тестирования в локальной сети и общей VPN-сети.', changes: ['Чаты, контакты и группы.', 'Голосовые и видеозвонки, групповые звонки и демонстрация экрана.', 'Автоматическое обнаружение пользователей в локальной сети.', 'Добавлена страница истории обновлений и инфраструктура проверки релизов. Источник GitHub нужно настроить перед публикацией.'] }
];
function renderReleaseHistory() {
  const strip = $('release-strip');
  if (!strip) return;
  strip.innerHTML = '';
  BLOOP_RELEASES.forEach((release, index) => {
    const button = document.createElement('button');
    button.className = 'release-chip' + (index === 0 ? ' active' : '');
    button.dataset.release = release.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    const version = document.createElement('span'); version.textContent = release.version;
    const label = document.createElement('small'); label.textContent = release.label;
    button.append(version, label);
    button.addEventListener('click', () => selectRelease(release.id));
    strip.appendChild(button);
  });
  selectRelease(BLOOP_RELEASES[0].id);
}
function selectRelease(id) {
  const release = BLOOP_RELEASES.find(item => item.id === id);
  if (!release) return;
  document.querySelectorAll('.release-chip').forEach(button => {
    const active = button.dataset.release === id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const details = $('release-details');
  if (!details) return;
  details.replaceChildren();
  const meta = document.createElement('div'); meta.className = 'release-details-meta';
  const tag = document.createElement('span'); tag.className = 'release-tag'; tag.textContent = release.tag;
  const date = document.createElement('span'); date.textContent = release.date; meta.append(tag, date);
  const heading = document.createElement('h3'); heading.textContent = release.title;
  const summary = document.createElement('p'); summary.textContent = release.summary;
  const list = document.createElement('ul');
  release.changes.forEach(change => { const li = document.createElement('li'); li.textContent = change; list.appendChild(li); });
  details.append(meta, heading, summary, list);
}
function setUpdateStatus(text) {
  const el = $('updates-status'); if (el) el.textContent = text;
}
function switchSettingsTab(tabId) {
  document.querySelectorAll('.settings-tab').forEach(t => {
    if (t.dataset.tab === tabId) t.classList.add('active');
    else t.classList.remove('active');
  });
  document.querySelectorAll('.settings-pane').forEach(p => {
    if (p.id === `settings-tab-${tabId}`) p.classList.add('active');
    else p.classList.remove('active');
  });
}

function openUserProfile() {
  $('profile-nickname').textContent = appState.user.nickname || 'Гость';
  $('profile-description').textContent = appState.user.desc || 'Описание отсутствует';

  const bannerEl = $('profile-banner');
  if (appState.user.banner) {
    bannerEl.style.backgroundImage = `url(${appState.user.banner})`;
    bannerEl.style.backgroundSize = 'cover';
    bannerEl.style.backgroundPosition = 'center';
  } else {
    bannerEl.style.backgroundImage = 'none';
    bannerEl.style.background = defaultBanner;
  }

  $('profile-avatar').innerHTML = `<img src="${appState.user.avatar || defaultAvatar}">`;

  const friends = appState.contacts.filter(c => c.type === 'peer');
  $('profile-friends-count').textContent = friends.length;

  const grid = $('profile-friends-grid');
  grid.innerHTML = '';
  friends.forEach(f => {
    const img = document.createElement('img');
    img.src = f.avatar || defaultAvatar;
    img.title = f.name;
    grid.appendChild(img);
  });

  $('profile-nickname').classList.remove('hidden-input');
  $('profile-nickname-input').classList.add('hidden-input');
  $('profile-nickname-input').value = appState.user.nickname;

  $('profile-description').classList.remove('hidden-input');
  $('profile-description-input').classList.add('hidden-input');
  $('profile-description-input').value = appState.user.desc || '';

  $('btn-edit-banner').style.display = 'flex';
  $('btn-edit-avatar').style.display = 'flex';
  $('btn-profile-delete-account').style.display = 'block';
  if ($('profile-nickname')) $('profile-nickname').onclick = () => {
    $('profile-nickname').classList.add('hidden-input');
    $('profile-nickname-input').classList.remove('hidden-input');
    $('profile-nickname-input').focus();
  };
  if ($('profile-description')) $('profile-description').onclick = () => {
    $('profile-description').classList.add('hidden-input');
    $('profile-description-input').classList.remove('hidden-input');
    $('profile-description-input').focus();
  };

  openModal('user-profile-modal');
}

function openContactProfile(contact) {
  if (!contact) return;

  $('profile-nickname').textContent = contact.name || 'Собеседник';
  $('profile-description').textContent = contact.desc || 'Описание отсутствует';

  const bannerEl = $('profile-banner');
  if (contact.banner) {
    bannerEl.style.backgroundImage = `url(${contact.banner})`;
    bannerEl.style.backgroundSize = 'cover';
    bannerEl.style.backgroundPosition = 'center';
  } else {
    bannerEl.style.backgroundImage = 'none';
    bannerEl.style.background = defaultBanner;
  }

  $('profile-avatar').innerHTML = `<img src="${contact.avatar || defaultAvatar}">`;

  const friends = appState.contacts.filter(c => c.type === 'peer');
  $('profile-friends-count').textContent = friends.length;

  const grid = $('profile-friends-grid');
  grid.innerHTML = '';
  friends.forEach(f => {
    const img = document.createElement('img');
    img.src = f.avatar || defaultAvatar;
    img.title = f.name;
    grid.appendChild(img);
  });

  $('profile-nickname').classList.remove('hidden-input');
  $('profile-nickname-input').classList.add('hidden-input');

  $('profile-description').classList.remove('hidden-input');
  $('profile-description-input').classList.add('hidden-input');

  $('btn-edit-banner').style.display = 'none';
  $('btn-edit-avatar').style.display = 'none';
  $('btn-profile-delete-account').style.display = 'none';
  $('profile-nickname').onclick = null;
  $('profile-description').onclick = null;

  openModal('user-profile-modal');
}

function setupEventListeners() {
  if ($('btn-quit-app')) $('btn-quit-app').onclick = () => window.api?.quitApp();
  if ($('main-player-name')) $('main-player-name').onclick = openUserProfile;
  if ($('main-player-avatar')) $('main-player-avatar').onclick = openUserProfile;

  if ($('btn-confirm-yes')) $('btn-confirm-yes').onclick = () => { if (confirmResolve) confirmResolve(true); closeModal('custom-confirm-modal'); confirmResolve = null; };
  if ($('btn-confirm-no')) $('btn-confirm-no').onclick = () => { if (confirmResolve) confirmResolve(false); closeModal('custom-confirm-modal'); confirmResolve = null; };

  if ($('btn-prompt-yes')) $('btn-prompt-yes').onclick = () => { if (promptResolve) promptResolve($('prompt-input').value); closeModal('custom-prompt-modal'); promptResolve = null; };
  if ($('btn-prompt-no')) $('btn-prompt-no').onclick = () => { if (promptResolve) promptResolve(null); closeModal('custom-prompt-modal'); promptResolve = null; };
  if ($('prompt-input')) $('prompt-input').onkeydown = (e) => { if (e.key === 'Enter') $('btn-prompt-yes').click(); };

  document.querySelectorAll('.close-modal-btn').forEach(btn => {
    btn.onclick = () => {
      const modalId = btn.dataset.close;
      if (modalId) closeModal(modalId);
    };
  });

  if ($('btn-edit-banner')) $('btn-edit-banner').onclick = () => $('profile-banner-input').click();
  if ($('btn-edit-avatar')) $('btn-edit-avatar').onclick = () => $('profile-avatar-input').click();

  if ($('profile-banner-input')) $('profile-banner-input').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => openCropper(ev.target.result, 'profile', 'banner');
    r.readAsDataURL(f);
    e.target.value = '';
  };
  if ($('profile-avatar-input')) $('profile-avatar-input').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => openCropper(ev.target.result, 'profile', 'avatar');
    r.readAsDataURL(f);
    e.target.value = '';
  };

  if ($('profile-nickname-input')) $('profile-nickname-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) {
        appState.user.nickname = val;
        $('profile-nickname').textContent = val;
        saveStateToStorage();
        updateProfileUI();
        broadcastProfile();
      }
      $('profile-nickname-input').classList.add('hidden-input');
      $('profile-nickname').classList.remove('hidden-input');
    }
    if (e.key === 'Escape') {
      $('profile-nickname-input').classList.add('hidden-input');
      $('profile-nickname').classList.remove('hidden-input');
    }
  };
  if ($('profile-nickname-input')) $('profile-nickname-input').onblur = () => {
    $('profile-nickname-input').classList.add('hidden-input');
    $('profile-nickname').classList.remove('hidden-input');
  };

  if ($('profile-description-input')) $('profile-description-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      appState.user.desc = val;
      $('profile-description').textContent = val || 'Описание отсутствует';
      saveStateToStorage();
      broadcastProfile();
      $('profile-description-input').classList.add('hidden-input');
      $('profile-description').classList.remove('hidden-input');
    }
    if (e.key === 'Escape') {
      $('profile-description-input').classList.add('hidden-input');
      $('profile-description').classList.remove('hidden-input');
    }
  };
  if ($('profile-description-input')) $('profile-description-input').onblur = () => {
    $('profile-description-input').classList.add('hidden-input');
    $('profile-description').classList.remove('hidden-input');
  };

  if ($('btn-profile-delete-account')) $('btn-profile-delete-account').onclick = async () => {
    const confirmed = await showCustomConfirm('Вы уверены, что хотите удалить аккаунт? Все данные будут стёрты безвозвратно.');
    if (confirmed) hardReset();
  };

  if ($('btn-chat-settings')) $('btn-chat-settings').onclick = () => openModal('chat-wallpaper-modal');
  if ($('btn-set-wallpaper')) $('btn-set-wallpaper').onclick = () => $('chat-wallpaper-input').click();
  if ($('btn-reset-wallpaper')) $('btn-reset-wallpaper').onclick = () => {
    const contact = appState.contacts.find(c => c.id === appState.activeContactId);
    if (contact) {
      contact.wallpaper = '';
      saveStateToStorage();
      applyWallpaperToChat('');
      closeModal('chat-wallpaper-modal');
      if (contact.type === 'peer' && contact.ip) {
        const p = peers.get(contact.ip);
        if (p) sendOverChannel(p, { type: 'chat_wallpaper', from: appState.user.friendCode, wallpaper: '' });
      }
    }
  };
  if ($('chat-wallpaper-input')) $('chat-wallpaper-input').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => openCropper(ev.target.result, 'chat', 'wallpaper');
    r.readAsDataURL(f);
    e.target.value = '';
  };

  if ($('btn-accept-call')) $('btn-accept-call').onclick = acceptCall;
  if ($('btn-decline-call')) $('btn-decline-call').onclick = declineCall;
  if ($('btn-end-call')) $('btn-end-call').onclick = () => endCall(false);
  if ($('btn-call')) $('btn-call').onclick = startCall;
  if ($('btn-group-call')) $('btn-group-call').onclick = startGroupCall;
  if ($('btn-share-screen')) $('btn-share-screen').onclick = toggleScreenShare;
  if ($('btn-stop-share')) $('btn-stop-share').onclick = toggleScreenShare;
  if ($('btn-mute')) $('btn-mute').onclick = toggleMute;
  if ($('btn-unmute')) $('btn-unmute').onclick = toggleMute;

  if ($('btn-accept-incoming-friend')) $('btn-accept-incoming-friend').onclick = acceptIncomingFriend;
  if ($('btn-decline-incoming-friend')) $('btn-decline-incoming-friend').onclick = declineIncomingFriend;

  if ($('btn-call-minimize')) $('btn-call-minimize').onclick = minimizeCall;
  if ($('mini-btn-expand')) $('mini-btn-expand').onclick = expandCall;
  if ($('mini-btn-end')) $('mini-btn-end').onclick = () => endCall(false);
  if ($('mini-btn-mute')) $('mini-btn-mute').onclick = toggleMute;

  if ($('btn-call-settings')) $('btn-call-settings').onclick = openCallSettings;
  if ($('btn-close-call-settings')) $('btn-close-call-settings').onclick = closeCallSettings;
  if ($('master-volume')) $('master-volume').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    callSettings.masterVolume = v / 100;
    $('master-vol-label').textContent = v + '%';
    applyAudioSettings();
  });

  if ($('btn-call-messages')) $('btn-call-messages').onclick = toggleCallChat;
  if ($('btn-close-call-chat')) $('btn-close-call-chat').onclick = () => $('call-chat-panel').classList.add('hidden');
  if ($('btn-send-call-chat')) $('btn-send-call-chat').onclick = sendCallChatMessage;
  if ($('call-chat-input')) $('call-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendCallChatMessage(); }
  });

  if ($('btn-do-find')) $('btn-do-find').onclick = connectManualFriend;
  if ($('nearby-search')) $('nearby-search').addEventListener('input', renderNearbyUsers);
  if ($('btn-find-friends')) $('btn-find-friends').onclick = () => { closeModal('settings-modal'); renderNearbyUsers(); openModal('find-user-modal'); };
  if ($('btn-copy-local-address')) $('btn-copy-local-address').onclick = () => { const value = $('network-local-address')?.textContent || ''; if (value && value.includes('.')) { window.api?.writeClipboard(value); showToast('IP скопирован'); } else showToast('Сетевой IP не найден'); };
  refreshNetworkPanel();
  renderReleaseHistory();
  if ($('btn-check-updates')) $('btn-check-updates').onclick = async () => {
    setUpdateStatus('Проверяем наличие новой версии…');
    const result = await window.api?.checkForUpdates?.();
    if (result?.status === 'unavailable') setUpdateStatus(result.message || 'Автообновления недоступны в этой сборке.');
  };
  window.api?.onUpdateStatus?.((info) => {
    if (!info) return;
    const messages = {
      checking: 'Проверяем наличие обновлений…',
      available: `Найдена версия ${info.version || ''}. Загрузка началась автоматически.`,
      'not-available': 'Установлена последняя версия Bloop.',
      downloading: `Загрузка обновления: ${Math.round(info.percent || 0)}%`,
      downloaded: `Версия ${info.version || ''} загружена. Она установится после перезапуска Bloop.`,
      error: `Ошибка обновления: ${info.message || 'неизвестная ошибка'}`
    };
    setUpdateStatus(messages[info.status] || info.message || 'Состояние обновления изменилось.');
    if (info.status === 'downloaded') showToast('Обновление загружено. Перезапустите Bloop для установки.');
  });



  if ($('btn-create-group-inline')) $('btn-create-group-inline').onclick = (e) => { e.stopPropagation(); openCreateGroupModal(); };
  if ($('btn-do-create-group')) $('btn-do-create-group').onclick = createGroup;

  if ($('btn-settings')) $('btn-settings').onclick = () => {
    if ($('settings-friend-code')) $('settings-friend-code').value = appState.user.friendCode;
    switchSettingsTab('binds');
    renderFriendRequests();
    renderReleaseHistory();
    openModal('settings-modal');
  };

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      switchSettingsTab(tab.dataset.tab);
      if (tab.dataset.tab === 'notifications') renderFriendRequests();
      if (tab.dataset.tab === 'updates') { renderReleaseHistory(); window.api?.checkForUpdates?.(); }
      if (tab.dataset.tab === 'friends' && $('settings-friend-code')) $('settings-friend-code').value = appState.user.friendCode;
    };
  });

  if ($('btn-bind-mic')) $('btn-bind-mic').onclick = () => startBindCapture('muteMic');
  if ($('btn-clear-bind-mic')) $('btn-clear-bind-mic').onclick = () => {
    userBinds.muteMic = null;
    saveBinds();
    renderBindsUI();
    showToast('Бинд очищен');
  };

  if ($('btn-confirm-bind')) $('btn-confirm-bind').onclick = confirmBindCapture;
  if ($('btn-reset-bind')) $('btn-reset-bind').onclick = () => { captureCodes = []; updateCaptureUI(); };
  if ($('btn-cancel-bind')) $('btn-cancel-bind').onclick = cancelBindCapture;

  if ($('btn-to-profile')) $('btn-to-profile').onclick = () => {
    BloopIntro.dive(2);
    $('stage-1').classList.replace('active', 'passed');
    setTimeout(() => $('stage-2').classList.add('active'), 100);
  };

  if ($('btn-save-profile')) $('btn-save-profile').onclick = () => {
    const nick = $('input-nickname').value.trim();
    if (!nick) { $('nick-error').style.display = 'block'; return; }
    $('nick-error').style.display = 'none';
    appState.user.nickname = nick;
    appState.user.desc = $('input-desc').value.trim();
    appState.user.isRegistered = true;
    saveStateToStorage();
    updateProfileUI();
    broadcastProfile();
    BloopIntro.dive(3);
    $('stage-2').classList.replace('active', 'passed');
    setTimeout(() => {
      $('stage-3').classList.add('active');
      if (appState.contacts.length > 0) switchChat(appState.contacts[0].id);
    }, 100);
  };

  if ($('btn-copy-code')) $('btn-copy-code').onclick = () => {
    let ok = false;
    if (window.api?.writeClipboard) ok = window.api.writeClipboard(appState.user.friendCode);
    if (!ok && navigator.clipboard) navigator.clipboard.writeText(appState.user.friendCode).catch(() => {});
    showToast('Скопировано!');
  };

  const setSidebarTab = (tab) => {
    appState.activeTab = tab;
    ['contacts', 'groups'].forEach(name => {
      const button = $('tab-' + name);
      if (button) button.classList.toggle('active', name === tab);
    });
    if ($('btn-create-group-inline')) $('btn-create-group-inline').classList.toggle('visible', tab === 'groups');
    renderActiveTab();
  };
  if ($('tab-contacts')) $('tab-contacts').onclick = () => setSidebarTab('contacts');
  if ($('tab-groups')) $('tab-groups').onclick = () => setSidebarTab('groups');
  if ($('btn-camera')) $('btn-camera').onclick = toggleCamera;

  const input = $('chat-input');
  if ($('btn-send')) $('btn-send').onclick = sendMessage;
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', () => {
      autoResizeInput();
      sendTypingStatus();
    });
  }

  if ($('btn-cancel-edit')) $('btn-cancel-edit').onclick = cancelEditMessage;

  const fileInput = $('chat-file-input');
  if ($('btn-attach')) $('btn-attach').onclick = () => fileInput.click();
  if (fileInput) fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    sendFile(file);
    e.target.value = '';
  };

  if ($('reg-avatar-preview')) $('reg-avatar-preview').onclick = () => $('reg-avatar-input').click();
  if ($('reg-avatar-input')) $('reg-avatar-input').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => openCropper(ev.target.result, 'reg', 'avatar');
    r.readAsDataURL(f);
    e.target.value = '';
  };

  if ($('btn-cancel-crop')) $('btn-cancel-crop').onclick = () => { closeModal('avatar-crop-modal'); if (cropperInstance) cropperInstance.destroy(); };
  if ($('btn-save-crop')) $('btn-save-crop').onclick = () => {
    if (!cropperInstance) return;

    let w = 200, h = 200;
    if (cropType === 'banner') { w = 600; h = 200; }
    else if (cropType === 'wallpaper') { w = 800; h = 450; }

    const b64 = cropperInstance.getCroppedCanvas({ width: w, height: h, fillColor: '#1f3040' }).toDataURL('image/jpeg', 0.85);

    if (currentAvatarTarget === 'profile') {
      if (cropType === 'banner') {
        appState.user.banner = b64;
        $('profile-banner').style.backgroundImage = `url(${b64})`;
        $('profile-banner').style.backgroundSize = 'cover';
        $('profile-banner').style.backgroundPosition = 'center';
      } else {
        appState.user.avatar = b64;
        $('profile-avatar').innerHTML = `<img src="${b64}">`;
        updateProfileUI();
      }
      broadcastProfile();
    } else if (currentAvatarTarget === 'chat') {
      const contact = appState.contacts.find(c => c.id === appState.activeContactId);
      if (contact) {
        contact.wallpaper = b64;
        applyWallpaperToChat(b64);
        if (contact.type === 'peer' && contact.ip) {
          const p = peers.get(contact.ip);
          if (p) sendOverChannel(p, { type: 'chat_wallpaper', from: appState.user.friendCode, wallpaper: b64 });
        }
        closeModal('chat-wallpaper-modal');
      }
    } else if (currentAvatarTarget === 'reg' || currentAvatarTarget === 'settings') {
      appState.user.avatar = b64;
      if ($('reg-avatar-preview')) $('reg-avatar-preview').innerHTML = `<img src="${b64}">`;
      updateProfileUI();
      broadcastProfile();
    }

    saveStateToStorage();
    closeModal('avatar-crop-modal');
    cropperInstance.destroy();
  };
}

function updateMessageUI(msg) {
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (!el) return;
  if (msg.msgType === 'text') {
    el.textContent = msg.text;
    if (msg.edited) {
      const span = document.createElement('span');
      span.className = 'edited-mark';
      span.textContent = ' (изм.)';
      el.appendChild(span);
    }
  }
}
function cancelEditMessage() {
  editingMsgId = null;
  $('chat-input').value = '';
  $('edit-message-banner').classList.add('hidden');
  autoResizeInput();
}
function startEditMessage(msg, contact) {
  if (msg.msgType !== 'text') return showToast('Можно редактировать только текст');
  editingMsgId = msg.id;
  $('chat-input').value = msg.text;
  $('chat-input').focus();
  $('edit-message-banner').classList.remove('hidden');
  autoResizeInput();
}
function deleteMessage(msg, contact, forAll) {
  const idx = contact.history.findIndex(m => m.id === msg.id);
  if (idx === -1) return;
  contact.history.splice(idx, 1);
  saveStateToStorage();
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (el) el.closest('.message-row').remove();

  if (forAll) {
    const payload = { type: 'message_delete', msgId: msg.id, from: appState.user.friendCode, groupId: contact.type === 'group' ? contact.id : null };
    if (contact.type === 'peer' && contact.ip) {
      const p = peers.get(contact.ip);
      if (p) sendOverChannel(p, payload);
    } else if (contact.type === 'group') {
      contact.members.forEach(fc => {
        const m = appState.contacts.find(x => x.type === 'peer' && x.friendCode === fc);
        if (!m?.ip) return;
        const p = peers.get(m.ip);
        if (p) sendOverChannel(p, payload);
      });
    }
  }
}
function hideContextMenus() {
  $('contact-context-menu')?.classList.add('hidden');
  $('message-context-menu')?.classList.add('hidden');
  $('delete-message-menu')?.classList.add('hidden');
}
function setupContextMenuHandlers() {
  if ($('ctx-view-profile')) $('ctx-view-profile').onclick = (e) => {
    e.stopPropagation();
    if (contextMenuTarget) openContactProfile(contextMenuTarget);
    hideContextMenus();
  };

  if ($('ctx-reconnect')) $('ctx-reconnect').onclick = (e) => {
    e.stopPropagation();
    if (contextMenuTarget) {
      ensureContactConnected(contextMenuTarget);
      showToast(`Подключаемся к ${contextMenuTarget.name} автоматически`);
    }
    hideContextMenus();
  };

  if ($('ctx-remove-friend')) $('ctx-remove-friend').onclick = async (e) => {
    e.stopPropagation();
    if (contextMenuTarget) {
      const confirmed = await showCustomConfirm(`Удалить ${contextMenuTarget.name} из друзей?`);
      if (confirmed) removeFriend(contextMenuTarget);
    }
    hideContextMenus();
  };

  if ($('ctx-edit-message')) $('ctx-edit-message').onclick = (e) => { e.stopPropagation(); if (messageMenuTarget) startEditMessage(messageMenuTarget.msg, messageMenuTarget.contact); hideContextMenus(); };

  if ($('ctx-delete-message')) $('ctx-delete-message').onclick = (e) => {
    e.stopPropagation();
    if (messageMenuTarget) {
      const rect = $('message-context-menu').getBoundingClientRect();
      hideContextMenus();
      showDeleteMessageMenu(messageMenuTarget.msg, messageMenuTarget.contact, rect.left, rect.top);
    }
  };

  if ($('ctx-del-me')) $('ctx-del-me').onclick = (e) => { e.stopPropagation(); if (messageMenuTarget) deleteMessage(messageMenuTarget.msg, messageMenuTarget.contact, false); hideContextMenus(); };
  if ($('ctx-del-all')) $('ctx-del-all').onclick = (e) => { e.stopPropagation(); if (messageMenuTarget) deleteMessage(messageMenuTarget.msg, messageMenuTarget.contact, true); hideContextMenus(); };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) hideContextMenus();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.contact-item') && !e.target.closest('.message-bubble')) hideContextMenus();
  });
}
function showContactContextMenu(contact, x, y) {
  const menu = $('contact-context-menu');
  contextMenuTarget = contact;
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  menu.classList.remove('hidden');
}
function showMessageContextMenu(msg, contact, x, y) {
  const menu = $('message-context-menu');
  messageMenuTarget = { msg, contact };
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  menu.classList.remove('hidden');
}
function showDeleteMessageMenu(msg, contact, x, y) {
  const menu = $('delete-message-menu');
  messageMenuTarget = { msg, contact };
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  menu.classList.remove('hidden');
}
function removeFriend(contact) {
  if (!contact) return;
  const idx = appState.contacts.findIndex(c => c.id === contact.id);
  if (idx === -1) return;
  const name = contact.name;
  appState.contacts.splice(idx, 1);
  if (contact.ip) {
    const peer = peers.get(contact.ip);
    if (peer) sendOverChannel(peer, { type: 'friend_removed', friendCode: appState.user.friendCode });
  }
  if (appState.activeContactId === contact.id) {
    appState.activeContactId = null;
    $('chat-with-name').textContent = 'Выберите контакт';
    $('chat-messages').innerHTML = '';
    $('btn-chat-settings').style.display = 'none';
  }
  saveStateToStorage();
  renderActiveTab();
  showToast(`${name} удалён из друзей`);
}
function appendMessageToDOM(msg, contact) {
  const chat = $('chat-messages');
  if (!chat) return;
  const isMe = msg.sender === 'me';
  const row = document.createElement('div');
  row.className = `message-row ${isMe ? 'user-row' : 'bot-row'}`;

  if (!isMe) {
    const avC = document.createElement('div');
    avC.className = 'msg-avatar-container';
    const av = document.createElement('img');
    av.className = 'msg-avatar';
    av.src = contact.avatar || defaultAvatar;
    av.onerror = () => av.src = defaultAvatar;
    avC.appendChild(av);
    row.appendChild(avC);
  }
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${isMe ? 'user-bubble' : 'bot-bubble'}`;
  bubble.dataset.msgId = msg.id || '';

  if (isMe) {
    bubble.oncontextmenu = (e) => {
      e.preventDefault();
      showMessageContextMenu(msg, contact, e.clientX, e.clientY);
    };
  }

  if (msg.msgType === 'image') {
    const img = document.createElement('img');
    img.src = msg.text;
    img.style.cssText = 'max-width:100%; max-height: 400px; border-radius:6px; display:block;';
    bubble.appendChild(img);
  } else if (msg.msgType === 'video') {
    const v = document.createElement('video');
    v.src = msg.text; v.controls = true;
    v.style.cssText = 'max-width:100%; max-height: 400px; border-radius:6px; display:block;';
    bubble.appendChild(v);
  } else {
    bubble.textContent = msg.text;
    if (msg.edited) {
      const span = document.createElement('span');
      span.className = 'edited-mark';
      span.textContent = ' (изм.)';
      bubble.appendChild(span);
    }
  }
  row.appendChild(bubble);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}
function autoResizeInput() {
  const input = $('chat-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
function showTypingIndicator() {
  const ind = $('typing-indicator');
  if (!ind) return;
  ind.classList.remove('hidden');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    ind.classList.add('hidden');
  }, 2000);
}
function sendTypingStatus() {
  if (!appState.activeContactId) return;
  const contact = appState.contacts.find(c => c.id === appState.activeContactId);
  if (!contact || contact.type === 'ai' || contact.type === 'pending') return;

  const now = Date.now();
  if (now - lastTypingTime < 1000) return;
  lastTypingTime = now;

  const payload = { type: 'typing', from: appState.user.friendCode, groupId: contact.type === 'group' ? contact.id : null };
  if (contact.type === 'peer' && contact.ip) {
    const p = peers.get(contact.ip);
    if (p) sendOverChannel(p, payload);
  } else if (contact.type === 'group') {
    contact.members.forEach(fc => {
      const m = appState.contacts.find(x => x.type === 'peer' && x.friendCode === fc);
      if (m?.ip) { const p = peers.get(m.ip); if (p) sendOverChannel(p, payload); }
    });
  }
}
function applyWallpaperToChat(wallpaper) {
  const chat = $('chat-messages');
  if (!chat) return;
  if (wallpaper) {
    chat.style.backgroundImage = `url(${wallpaper})`;
    chat.style.backgroundSize = 'cover';
    chat.style.backgroundPosition = 'center';
    chat.style.boxShadow = 'inset 0 0 0 1000px rgba(10, 17, 24, 0.6)';
  } else {
    chat.style.backgroundImage = '';
    chat.style.boxShadow = '';
  }
}
function switchChat(contactId) {
  const contact = appState.contacts.find(c => c.id === contactId);
  if (!contact) { appState.activeContactId = null; return; }
  appState.activeContactId = contactId;
  cancelEditMessage();
  renderActiveTab();
  $('chat-with-name').textContent = contact.name;
  const chat = $('chat-messages');
  chat.innerHTML = '';
  if (contact.history) contact.history.forEach(m => appendMessageToDOM(m, contact));

  applyWallpaperToChat(contact.wallpaper);

  const callBtn = $('btn-call');
  const groupCallBtn = $('btn-group-call');
  const chatSettingsBtn = $('btn-chat-settings');

  if (contact.type === 'group') {
    callBtn.style.display = 'none';
    groupCallBtn.style.display = 'flex';
    chatSettingsBtn.style.display = 'flex';
  } else if (contact.type === 'peer') {
    callBtn.style.display = 'flex';
    groupCallBtn.style.display = 'none';
    chatSettingsBtn.style.display = 'flex';
  } else {
    callBtn.style.display = 'none';
    groupCallBtn.style.display = 'none';
    chatSettingsBtn.style.display = 'none';
  }
}
function renderActiveTab() {
  if (appState.activeTab === 'groups') renderGroups();
  else renderContacts();
}
function renderContacts() {
  const list = $('contact-list');
  if (!list) return;
  list.innerHTML = '';
  const filtered = appState.contacts.filter(c => c.type !== 'group');
  if (filtered.length === 0) {
    const e = document.createElement('div');
    e.style.cssText = 'color:#8ca2b3; font-size:0.75rem; padding:10px;';
    e.textContent = 'Нет контактов';
    list.appendChild(e);
    return;
  }
  filtered.forEach(c => {
    const el = document.createElement('div');
    el.className = `contact-item ${c.id === appState.activeContactId ? 'active' : ''}`;
    el.onclick = () => switchChat(c.id);
    el.oncontextmenu = (e) => {
      if (c.type !== 'peer') return;
      e.preventDefault();
      showContactContextMenu(c, e.clientX, e.clientY);
    };
    const img = document.createElement('img');
    img.src = c.avatar || defaultAvatar;
    img.className = 'avatar-ai';
    img.onerror = () => img.src = defaultAvatar;
    const s = document.createElement('span');
    s.textContent = c.name;
    el.appendChild(img); el.appendChild(s);
    list.appendChild(el);
  });
}
function renderGroups() {
  const list = $('contact-list');
  if (!list) return;
  list.innerHTML = '';
  const groups = appState.contacts.filter(c => c.type === 'group');
  if (groups.length === 0) {
    const e = document.createElement('div');
    e.style.cssText = 'color:#8ca2b3; font-size:0.75rem; padding:10px;';
    e.textContent = 'Групп пока нет';
    list.appendChild(e);
    return;
  }
  groups.forEach(g => {
    const el = document.createElement('div');
    el.className = `contact-item ${g.id === appState.activeContactId ? 'active' : ''}`;
    el.onclick = () => switchChat(g.id);
    const img = document.createElement('img');
    img.src = defaultAvatar;
    img.className = 'avatar-ai';
    const s = document.createElement('span');
    s.textContent = `👥 ${g.name}`;
    el.appendChild(img); el.appendChild(s);
    list.appendChild(el);
  });
}
function openCreateGroupModal() {
  groupSelectedMembers = new Set();
  $('group-name-input').value = '';
  $('group-error').style.display = 'none';
  renderGroupMemberList();
  openModal('create-group-modal');
}
function renderGroupMemberList() {
  const list = $('group-member-list');
  list.innerHTML = '';
  const friends = appState.contacts.filter(c => c.type === 'peer');
  if (friends.length === 0) {
    const e = document.createElement('div');
    e.style.cssText = 'color:#8ca2b3; font-size:0.75rem; padding:8px;';
    e.textContent = 'Сначала добавьте друзей';
    list.appendChild(e);
    return;
  }
  friends.forEach(f => {
    const el = document.createElement('div');
    el.className = `group-contact-item ${groupSelectedMembers.has(f.friendCode) ? 'selected' : ''}`;
    el.onclick = () => {
      if (groupSelectedMembers.has(f.friendCode)) groupSelectedMembers.delete(f.friendCode);
      else groupSelectedMembers.add(f.friendCode);
      renderGroupMemberList();
    };
    const left = document.createElement('div');
    left.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const img = document.createElement('img');
    img.src = f.avatar || defaultAvatar;
    img.style.cssText = 'width:24px; height:24px; border-radius:50%;';
    const n = document.createElement('span');
    n.textContent = f.name;
    left.appendChild(img); left.appendChild(n);
    el.appendChild(left);
    const check = document.createElement('span');
    check.className = 'check-icon';
    check.textContent = '✓';
    el.appendChild(check);
    list.appendChild(el);
  });
}
function createGroup() {
  const name = $('group-name-input').value.trim();
  if (!name || groupSelectedMembers.size < 2) { $('group-error').style.display = 'block'; return; }
  const group = {
    id: 'group_' + Date.now(), name, type: 'group',
    members: Array.from(groupSelectedMembers), history: []
  };
  appState.contacts.push(group);
  saveStateToStorage();
  closeModal('create-group-modal');
  appState.activeTab = 'groups';
  $('tab-contacts').classList.remove('active');
  $('tab-groups').classList.add('active');
  $('btn-create-group-inline')?.classList.add('visible');
  renderActiveTab();
  switchChat(group.id);
  showToast(`Группа «${name}» создана`);
}
function acceptIncomingFriend() {
  const req = incomingFriendQueue[0];
  if (!req) return;
  const peer = peers.get(req.ip);
  if (peer) sendOverChannel(peer, { type: 'friend_accept', nickname: appState.user.nickname, avatar: appState.user.avatar, friendCode: appState.user.friendCode });
  const exists = appState.contacts.find(c => c.type === 'peer' && c.friendCode === req.friendCode);
  if (!exists) {
    appState.contacts.push({ id: 'peer_' + (req.friendCode || Date.now()), name: req.nickname, avatar: req.avatar, type: 'peer', history: [], friendCode: req.friendCode, ip: req.ip });
  } else {
    exists.name = req.nickname; exists.avatar = req.avatar; exists.ip = req.ip;
  }
  const idx = appState.incomingRequests.findIndex(r => r.friendCode === req.friendCode);
  if (idx !== -1) appState.incomingRequests.splice(idx, 1);
  incomingFriendQueue.shift();
  saveStateToStorage();
  renderActiveTab();
  renderFriendRequests();
  showToast('Запрос принят');
  showNextIncomingFriend();
}
function declineIncomingFriend() {
  const req = incomingFriendQueue[0];
  if (!req) return;
  const peer = peers.get(req.ip);
  if (peer) sendOverChannel(peer, { type: 'friend_reject', reason: 'declined' });
  const idx = appState.incomingRequests.findIndex(r => r.friendCode === req.friendCode);
  if (idx !== -1) appState.incomingRequests.splice(idx, 1);
  incomingFriendQueue.shift();
  saveStateToStorage();
  renderFriendRequests();
  showNextIncomingFriend();
}
function showIncomingFriendRequest(req) {
  incomingFriendQueue.push(req);
  if (incomingFriendQueue.length === 1) showNextIncomingFriend();
  updateNotifBadge();
}
function showNextIncomingFriend() {
  if (incomingFriendQueue.length === 0) { closeModal('incoming-friend-modal'); return; }
  const req = incomingFriendQueue[0];
  $('incoming-friend-avatar').src = req.avatar || defaultAvatar;
  $('incoming-friend-name').textContent = req.nickname;
  openModal('incoming-friend-modal');
}
function acceptFriendRequest(index) {
  const req = appState.incomingRequests[index];
  if (!req) return;
  const peer = peers.get(req.ip);
  if (peer) sendOverChannel(peer, { type: 'friend_accept', nickname: appState.user.nickname, avatar: appState.user.avatar, friendCode: appState.user.friendCode });
  const exists = appState.contacts.find(c => c.type === 'peer' && c.friendCode === req.friendCode);
  if (!exists) {
    appState.contacts.push({ id: 'peer_' + (req.friendCode || Date.now()), name: req.nickname, avatar: req.avatar, type: 'peer', history: [], friendCode: req.friendCode, ip: req.ip });
  }
  appState.incomingRequests.splice(index, 1);
  saveStateToStorage();
  renderActiveTab();
  renderFriendRequests();
  showToast('Запрос принят!');
}
function renderFriendRequests() {
  const list = $('friend-requests-list');
  if (!list) return;
  list.innerHTML = '';
  updateNotifBadge();
  if (appState.incomingRequests.length === 0) {
    const e = document.createElement('div');
    e.style.color = '#8ca2b3'; e.style.fontSize = '0.85rem'; e.style.textAlign = 'center'; e.style.marginTop = '20px';
    e.textContent = 'Нет новых запросов';
    list.appendChild(e);
    return;
  }
  appState.incomingRequests.forEach((req, idx) => {
    const el = document.createElement('div');
    el.className = 'friend-request-item';

    const left = document.createElement('div');
    left.style.cssText = 'display:flex; align-items:center; gap:10px;';
    const img = document.createElement('img');
    img.src = req.avatar || defaultAvatar;
    img.style.cssText = 'width:32px; height:32px; border-radius:50%;';
    img.onerror = () => img.src = defaultAvatar;
    const name = document.createElement('span');
    name.textContent = req.nickname;
    name.style.fontWeight = '600';
    left.appendChild(img); left.appendChild(name);

    const btn = document.createElement('button');
    btn.textContent = 'ПРИНЯТЬ';
    btn.className = 'save-nick-btn';
    btn.onclick = () => acceptFriendRequest(idx);
    el.appendChild(left); el.appendChild(btn);
    list.appendChild(el);
  });
}
function updateNotifBadge() {
  const badge = $('notif-badge');
  if (!badge) return;
  const count = appState.incomingRequests.length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/* Сетевая панель: показываем реальный адрес интерфейса, не выдумываем статус соединения. */
async function refreshNetworkPanel() {
  const address = $('network-local-address');
  const status = $('network-state-label');
  if (!address || !status || !window.api?.getLocalIPs) return;
  try {
    const interfaces = await window.api.getLocalIPs();
    const preferred = interfaces.find(x => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address)) || interfaces[0];
    address.textContent = preferred ? preferred.address : 'Нет IPv4-адреса';
    status.textContent = preferred ? 'Сеть доступна' : 'Нет сетевого интерфейса';
    status.dataset.state = preferred ? 'online' : 'offline';
    if (preferred && interfaces.length > 1) address.title = interfaces.map(x => `${x.name}: ${x.address}`).join('\n');
  } catch (_) {
    address.textContent = 'Не удалось определить';
    status.textContent = 'Ошибка проверки';
    status.dataset.state = 'offline';
  }
}

/* Резервный способ подключения: IP и френд-код, если LAN discovery недоступен. */
async function connectManualFriend() {
  const ip = $('find-ip').value.trim();
  const hostCode = $('find-friend-code').value.trim().toUpperCase();
  if (!ip) return showToast('Введите IP устройства');
  if (!hostCode) return showToast('Введите френд-код друга');

  try {
    const myIP = await window.api.getLocalIP();
    if (myIP === ip) return showToast('Нельзя подключиться к себе');
  } catch (e) {}


  const peer = peers.get(ip);
  if (peer && peer.dataChannel && peer.dataChannel.readyState === 'open') {
    sendOverChannel(peer, {
      type: 'friend_request',
      target: hostCode,
      nickname: appState.user.nickname,
      avatar: appState.user.avatar,
      friendCode: appState.user.friendCode
    });
    $('find-ip').value = ''; $('find-friend-code').value = '';
    closeModal('find-user-modal');
    showToast('Запрос отправлен');
    return;
  }

  pendingFriendAdds.set(ip, { target: hostCode });
  if (window.api?.connectToPeer) await window.api.connectToPeer(ip);
  $('find-ip').value = ''; $('find-friend-code').value = '';
  closeModal('find-user-modal');
  showToast('Подключение...');
}

let groupSelectedMembers = new Set();

function loadBinds() {
  try {
    const saved = localStorage.getItem('bloop_binds');
    if (saved) {
      const p = JSON.parse(saved);
      if (p && typeof p === 'object') userBinds = { ...userBinds, ...p };
    }
  } catch (e) {}
}
function saveBinds() {
  try { localStorage.setItem('bloop_binds', JSON.stringify(userBinds)); } catch (e) {}
}
function normalizeCode(code) {
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Control';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'MetaLeft' || code === 'MetaRight') return 'Meta';
  return code;
}
function formatCode(code) {
  const map = { 'Control': 'Ctrl', 'Shift': 'Shift', 'Alt': 'Alt', 'Meta': 'Meta', 'Space': 'Space', 'Escape': 'Esc', 'Enter': 'Enter', 'Tab': 'Tab', 'Backspace': 'Backspace', 'Delete': 'Del' };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  if (code.startsWith('Arrow')) return code.slice(5);
  return code;
}
function formatBindLabel(bind) {
  if (!bind || !bind.codes || bind.codes.length === 0) return 'Не задан';
  return bind.codes.map(formatCode).join(' + ');
}
function renderBindsUI() {
  const lbl = formatBindLabel(userBinds.muteMic);
  if ($('bind-mic-display')) $('bind-mic-display').textContent = lbl;
}
function matchBind(keysSet, bind) {
  if (!bind || !bind.codes || bind.codes.length === 0) return false;
  const bindSet = new Set(bind.codes);
  for (const c of bindSet) if (!keysSet.has(c)) return false;
  const mods = ['Control', 'Shift', 'Alt', 'Meta'];
  for (const k of keysSet) {
    if (bindSet.has(k)) continue;
    if (!mods.includes(k)) return false;
  }
  return true;
}
function startBindCapture(name) {
  isCapturingBind = true;
  capturingBindName = name;
  captureCodes = [];
  updateCaptureUI();
  $('bind-capture-overlay').classList.remove('hidden');
  $('btn-confirm-bind').style.display = 'none';
  $('btn-reset-bind').style.display = 'none';
}
function updateCaptureUI() {
  if (captureCodes.length === 0) {
    $('bind-capture-text').textContent = 'Нажмите комбинацию клавиш...';
    $('btn-confirm-bind').style.display = 'none';
    $('btn-reset-bind').style.display = 'none';
  } else {
    $('bind-capture-text').textContent = captureCodes.map(formatCode).join(' + ');
    $('btn-confirm-bind').style.display = 'inline-block';
    $('btn-reset-bind').style.display = 'inline-block';
  }
}
function cancelBindCapture() {
  isCapturingBind = false;
  capturingBindName = null;
  captureCodes = [];
  $('bind-capture-overlay').classList.add('hidden');
}
function confirmBindCapture() {
  if (captureCodes.length === 0) return;
  if (capturingBindName === 'muteMic') {
    userBinds.muteMic = { codes: captureCodes.slice(), label: captureCodes.map(formatCode).join(' + ') };
    saveBinds();
    renderBindsUI();
  }
  cancelBindCapture();
  showToast('Бинд сохранён');
}
function setupGlobalKeyHandlers() {
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.altKey) { e.preventDefault(); e.stopPropagation(); }
    if (isCapturingBind) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { cancelBindCapture(); return; }
      const nc = normalizeCode(e.code);
      if (!captureCodes.includes(nc)) {
        captureCodes.push(nc);
        updateCaptureUI();
      }
      return;
    }

    keysDown.add(normalizeCode(e.code));
    if (userBinds.muteMic && matchBind(keysDown, userBinds.muteMic)) {
      e.preventDefault();
      if (isInCall) toggleMute();
    }
  });

  document.addEventListener('keyup', (e) => {
    keysDown.delete(normalizeCode(e.code));
  });
}
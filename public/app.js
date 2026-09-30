const $ = id => document.getElementById(id);
const desktop = window.petDesktop;
const panelKind = desktop?.panelKind || '';
const panelMode = panelKind === 'chat' || panelKind === 'settings';
const SESSION_KEY = 'dongdong-session-v3';
const senderId = localStorage.getItem('dongdong-sender-id-v3') || crypto.randomUUID();
localStorage.setItem('dongdong-sender-id-v3', senderId);

const state = {
  mode: 'host', url: '', key: '', token: '', name: '', socket: null,
  connected: false, expanded: false, pinned: true, view: 'chat', peerOnline: false,
  peerName: '对方', profile: {},
  reconnectTimer: null, idleTimer: null, hostStarted: false, walking: false, pose: 'idle',
  idleActions: JSON.parse(localStorage.getItem('dongdong-idle-actions') ?? 'true'),
  peeked: false, edgeHold: false, edgeAutoOuting: false,
  notifications: JSON.parse(localStorage.getItem('dongdong-notifications') ?? 'true')
};
const seenEvents = new Set();
let poseTimer;
let napTimer;
let blinkTimer;
let walkFrameTimer;
let peekTimer;
let peekOutingTimer;
let edgeHoldTimer;
let deliveryFinishTimer;
const pendingDeliveries = new Map();

if (panelMode) document.body.classList.add('panel-mode');

function speak(message, kind = 'normal') {
  $('speech').textContent = message;
  $('speech').classList.remove('speech-pop', 'speech-alert');
  void $('speech').offsetWidth;
  $('speech').classList.add(kind === 'alert' ? 'speech-alert' : 'speech-pop');
  clearTimeout(speak.timer);
  speak.timer = setTimeout(() => {
    $('speech').classList.remove('speech-pop', 'speech-alert');
    $('speech').textContent = '';
  }, 1800);
}

function setAutoLaunchToggles(value) {
  $('autoLaunchToggle').checked = Boolean(value);
  $('autoLaunchSetup').checked = Boolean(value);
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

function setPose(pose) {
  state.pose = pose;
  const pet = $('mainMascot');
  pet.classList.remove('wiggle', 'happy', 'jump', 'nap', 'pet', 'fish', 'sit', 'sleep', 'stretch', 'delivery', 'receive', 'speech-pop', 'hug', 'kiss', 'groom', 'purr');
  pet.style.backgroundImage = `url('./mascot${pose === 'idle' ? '' : `-${pose}`}.svg')`;
  if (pose === 'wave') pet.classList.add('wiggle');
  if (pose === 'happy') pet.classList.add('happy');
  if (pose === 'nap') pet.classList.add('nap');
  if (['pet', 'fish', 'sit', 'sleep', 'stretch', 'hug', 'kiss', 'groom', 'purr'].includes(pose)) pet.classList.add(pose);
}

function scheduleNap() {
  clearTimeout(napTimer);
  napTimer = setTimeout(() => {
    if (!state.connected) return;
    if (state.peerOnline) return scheduleIdleAction();
    setPose('nap');
  }, state.peerOnline ? 45000 : 250);
}

function schedulePeek() {
  clearTimeout(peekTimer);
  if (!state.connected || state.expanded || state.walking || state.peeked || state.edgeHold || state.edgeAutoOuting) return;
  peekTimer = setTimeout(() => {
    if (!state.connected || state.expanded || state.walking || state.peeked || state.edgeHold || state.edgeAutoOuting) return schedulePeek();
    state.peeked = true;
    clearTimeout(state.idleTimer);
    $('window').classList.add('peeked');
    desktop?.setPeeked(true);
    schedulePeekOuting();
  }, 70000 + Math.random() * 50000);
}

function schedulePeekOuting() {
  clearTimeout(peekOutingTimer);
  if (!state.connected || state.expanded || !state.peeked || state.edgeHold) return;
  peekOutingTimer = setTimeout(() => {
    if (!state.connected || state.expanded || !state.peeked || state.edgeHold) return;
    state.edgeAutoOuting = true;
    state.peeked = false;
    $('window').classList.remove('peeked');
    desktop?.setPeeked(false);
    const outings = desktop ? ['walk', 'sit', 'stretch', 'nap', 'happy'] : ['sit', 'stretch', 'nap', 'happy'];
    const outing = outings[Math.floor(Math.random() * outings.length)];
    if (outing === 'walk' && desktop) {
      desktop.startWalk().then(started => { if (!started) finishPeekOuting(); });
    }
    else {
      setPose(outing);
      setTimeout(finishPeekOuting, 2400);
    }
  }, 90000 + Math.random() * 90000);
}

function finishPeekOuting() {
  if (!state.edgeAutoOuting) return;
  state.edgeAutoOuting = false;
  if (!state.connected || state.expanded || state.edgeHold) return;
  state.peeked = true;
  clearTimeout(state.idleTimer);
  $('window').classList.add('peeked');
  desktop?.setPeeked(true);
  schedulePeekOuting();
}

function unpeek(userInitiated = false) {
  clearTimeout(peekTimer);
  clearTimeout(peekOutingTimer);
  const wasEdgeState = state.peeked || state.edgeAutoOuting;
  if (userInitiated && wasEdgeState) {
    state.edgeHold = true;
    state.edgeAutoOuting = false;
    clearTimeout(edgeHoldTimer);
    edgeHoldTimer = setTimeout(() => {
      state.edgeHold = false;
      schedulePeek();
    }, 180000);
    desktop?.stopWalk();
  }
  if (!state.peeked) return;
  state.peeked = false;
  $('window').classList.remove('peeked');
  desktop?.setPeeked(false);
  if (userInitiated) scheduleIdleAction();
  if (!userInitiated) schedulePeek();
}

function scheduleIdleAction() {
  clearTimeout(state.idleTimer);
  if (!state.connected || !state.peerOnline || state.walking || state.peeked || !state.idleActions) return;
  state.idleTimer = setTimeout(() => {
    if (!state.connected || !state.peerOnline || state.walking || state.peeked || state.edgeAutoOuting || state.pose !== 'idle') return scheduleIdleAction();
    const action = ['blink', 'happy', 'wiggle', 'sit', 'stretch', 'nap', 'walk'][Math.floor(Math.random() * 7)];
    if (action === 'blink') {
      setPose('blink');
      setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, 260);
    } else if (action === 'walk' && desktop) {
      desktop.startWalk();
    } else if (action === 'nap') {
      setPose('nap');
      setTimeout(() => { if (state.connected && state.pose === 'nap') setPose('idle'); }, 2600);
    } else if (['sit', 'stretch'].includes(action)) {
      setPose(action);
      setTimeout(() => { if (state.connected && state.pose === action) setPose('idle'); }, 1800);
    } else {
      animatePet(action);
    }
    scheduleIdleAction();
  }, 18000 + Math.random() * 18000);
}

function setPeerOnline(online) {
  const presence = typeof online === 'object' ? online : { online };
  state.peerOnline = Boolean(presence.online);
  state.peerName = presence.peerName || state.peerName || '对方';
  desktop?.setOnline(state.peerOnline);
  $('presenceText').textContent = state.peerOnline ? `${state.peerName} 在线` : `${state.peerName} 离线，小猫正在休息`;
  $('presenceDot').classList.toggle('online', state.peerOnline);
  $('presenceDot').classList.toggle('offline', !state.peerOnline);
  if (state.peerOnline) {
    if (state.pose === 'nap') setPose('idle');
    scheduleIdleAction();
  } else {
    clearTimeout(state.idleTimer);
    if (state.connected && !state.walking) scheduleNap();
  }
}

function animatePet(kind = 'happy') {
  clearTimeout(poseTimer);
  setPose(kind === 'wiggle' ? 'wave' : 'happy');
  const pet = $('mainMascot');
  pet.classList.remove('wiggle', 'happy', 'jump');
  void pet.offsetWidth;
  pet.classList.add(kind === 'jump' ? 'jump' : kind);
  poseTimer = setTimeout(() => setPose(state.peerOnline ? 'idle' : 'nap'), kind === 'jump' ? 2200 : 1500);
  if (state.peerOnline) scheduleNap();
}

function animateDelivery(progress = 1) {
  clearTimeout(poseTimer);
  clearTimeout(deliveryFinishTimer);
  const pet = $('mainMascot');
  setPose('idle');
  pet.classList.remove('delivery');
  void pet.offsetWidth;
  pet.style.setProperty('--delivery-progress', String(Math.max(0, Math.min(1, progress))));
  pet.classList.add('delivery');
  deliveryFinishTimer = setTimeout(() => { pet.classList.remove('delivery'); setPose(state.peerOnline ? 'idle' : 'nap'); }, 2600);
}

function animateReceive() {
  clearTimeout(poseTimer);
  clearTimeout(deliveryFinishTimer);
  const pet = $('mainMascot');
  setPose('idle');
  pet.classList.remove('receive');
  void pet.offsetWidth;
  pet.classList.add('receive');
  poseTimer = setTimeout(() => { pet.classList.remove('receive'); setPose(state.peerOnline ? 'idle' : 'nap'); }, 1600);
}

function animateRemoteAction(kind) {
  if (kind === 'sleep') {
    setPose('nap');
    return;
  }
  const pet = $('mainMascot');
  clearTimeout(poseTimer);
  setPose(kind);
  void pet.offsetWidth;
  pet.classList.add(kind);
  poseTimer = setTimeout(() => setPose(state.peerOnline ? 'idle' : 'nap'), kind === 'jump' ? 2200 : 1800);
}

function animateLocalAction(kind) {
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  clearTimeout(poseTimer);
  if (kind === 'walk') {
    const animateInPlace = () => {
      onWalkState(true);
      setTimeout(() => { if (state.walking) onWalkState(false); }, 1600);
    };
    if (desktop) Promise.resolve(desktop.startWalk()).then(started => { if (!started) animateInPlace(); }).catch(animateInPlace);
    else animateInPlace();
    return;
  }
  if (kind === 'wave') {
    animatePet('wiggle');
    return;
  }
  if (kind === 'care') {
    animatePet('happy');
    return;
  }
  animateRemoteAction(kind);
}

async function triggerAction(kind) {
  // The remote cat is the source of truth while connected. When the peer is
  // away, keep the interaction responsive locally without creating a server
  // event that cannot be delivered.
  unpeek(true);
  if (!state.connected || !state.peerOnline) {
    animateLocalAction(kind);
    toast(state.connected ? '对方当前不在线' : '还没有连接房间');
    return null;
  }
  if (kind === 'care') return sendEvent('message', '今天也要好好吃饭呀');
  return sendEvent(kind);
}

function setMode(mode) {
  state.mode = mode;
  $('hostTab').classList.toggle('selected', mode === 'host');
  $('joinTab').classList.toggle('selected', mode === 'join');
  $('hostTab').setAttribute('aria-selected', mode === 'host');
  $('joinTab').setAttribute('aria-selected', mode === 'join');
  $('hostForm').hidden = mode !== 'host';
  $('joinForm').hidden = mode !== 'join';
  $('setupFeedback').textContent = '';
}

function setQuickComposer(open) {
  const form = $('quickMessageForm');
  if (!form) return;
  form.hidden = !open;
  $('window').classList.toggle('quick-composing', open);
  if (open) {
    $('actionTray').hidden = true;
    setTimeout(() => $('quickMessageInput').focus(), 0);
  } else {
    $('quickMessageInput').value = '';
  }
}

function setExpanded(expanded) {
  state.expanded = expanded;
  setQuickComposer(false);
  if (expanded && !panelMode) unpeek(true);
  $('window').classList.toggle('compact', !expanded);
  $('expanded').hidden = !expanded;
  $('compactActions').hidden = expanded;
  const resized = panelMode ? undefined : desktop?.setWindowSize(expanded);
  if (!expanded && !panelMode) schedulePeek();
  if (expanded && !panelMode) setTimeout(() => $('messageInput').focus(), 100);
  return resized;
}

function onWalkState(walking) {
  state.walking = walking;
  clearInterval(walkFrameTimer);
  if (walking) {
    clearTimeout(poseTimer);
    clearTimeout(napTimer);
    let frame = 1;
    setPose('walk-1');
    walkFrameTimer = setInterval(() => { frame = frame === 1 ? 2 : 1; setPose(`walk-${frame}`); }, 180);
    speak('出门散步啦', 'alert');
  } else if (state.connected) {
    setPose('idle');
    if (state.edgeAutoOuting) setTimeout(finishPeekOuting, 1800);
    else scheduleNap();
  }
}

function setView(view) {
  state.view = view;
  $('chatTab').classList.toggle('selected', view === 'chat');
  $('connectionTab').classList.toggle('selected', view === 'connection');
  $('chatTab').setAttribute('aria-selected', view === 'chat');
  $('connectionTab').setAttribute('aria-selected', view === 'connection');
  $('chatView').hidden = view !== 'chat';
  $('connectionView').hidden = view !== 'connection';
}

function returnFromSettings() {
  if (panelMode) {
    desktop?.closePanel();
    return;
  }
  if (!$('appSettings').hidden) {
    $('appSettings').hidden = true;
    if (state.connected) {
      $('companion').hidden = false;
      setView('chat');
      setExpanded(false);
    } else {
      $('setup').hidden = false;
    }
    return;
  }
  if (state.connected) {
    setView('chat');
    setExpanded(false);
  } else {
    $('setup').hidden = false;
  }
}

function normalizeAddress(value) {
  const raw = value.trim();
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const octets = url.hostname.split('.').map(Number);
  const isTailnet = octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  const isPreview = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'http:' || !isTailnet && !isPreview || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入对方的 Tailscale IPv4 地址');
  }
  return `${url.origin}${url.port ? '' : ':4827'}`;
}

async function request(route, options = {}) {
  const headers = state.token ? { 'X-Pet-Session': state.token } : { 'X-Pet-Key': state.key };
  const response = await fetch(`${state.url}/api${route}`, {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return response;
}

function applyProfile(profile = {}) {
  state.profile = { petName: '咚咚', ...profile };
  $('petNameLabel').textContent = state.profile.petName || '咚咚';
  $('coupleBadge').hidden = !state.connected;
  $('profilePetName').value = state.profile.petName || '';
}

async function openSession(url, key, name, mode) {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pet-Key': key },
    body: JSON.stringify({ senderId, senderName: name, mode })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `连接失败 (${response.status})`);
  return body;
}

function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadFile(event) {
  try {
    const response = await request(`/files/${encodeURIComponent(event.fileId)}`);
    const data = await response.arrayBuffer();
    if (desktop) {
      const savedPath = await desktop.saveDownload(data, event.fileName);
      toast(`已保存到下载：${savedPath.split(/[\\/]/).pop()}`);
    } else {
      const blobUrl = URL.createObjectURL(new Blob([data]));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = event.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  } catch (error) { toast(error.message); }
}

function renderEvent(event) {
  const wrapper = document.createElement('div');
  wrapper.className = `event ${event.senderId === senderId ? 'mine' : ''} ${event.kind}`;
  const meta = document.createElement('div');
  meta.className = 'event-meta';
  meta.textContent = `${event.senderId === senderId ? '我' : event.senderName} · ${formatTime(event.createdAt)}`;
  wrapper.appendChild(meta);
  if (event.kind === 'file') {
    const button = document.createElement('button');
    button.className = 'event-body file-event';
    button.title = `下载 ${event.fileName}`;
    const icon = document.createElement('img');
    icon.src = './icons/file.svg';
    icon.alt = '';
    const name = document.createElement('span');
    name.textContent = event.fileName;
    const size = document.createElement('small');
    size.textContent = formatSize(event.size);
    button.append(icon, name, size);
    button.addEventListener('click', () => downloadFile(event));
    wrapper.appendChild(button);
  } else {
    const body = document.createElement('div');
    body.className = 'event-body';
    const labels = { wave: '👋 向你招了招手', walk: '🐾 让你的小猫散步', jump: '✨ 让你的小猫乱蹦', pet: '🤍 摸摸小猫', fish: '🐟 投喂小鱼干', sit: '🪑 让小猫坐下', sleep: '💤 让小猫睡觉', stretch: '☀ 让小猫伸懒腰', hug: '🫂 给你一个抱抱', kiss: '💋 亲亲你', groom: '🧶 给你梳梳毛', purr: '💗 在你身边呼噜' };
    body.textContent = labels[event.kind] || event.text;
    wrapper.appendChild(body);
  }
  $('events').appendChild(wrapper);
  $('events').scrollTop = $('events').scrollHeight;
}

function onEvent(event) {
  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  if (event.senderId !== senderId && !panelMode) unpeek(true);
  if (event.kind === 'delivery') {
    if (panelMode) return;
    if (event.senderId !== senderId) {
      const data = event.data || {};
      const name = data.name || String(event.text || '').split('|')[0] || '一封信';
      const progress = Number(data.progress ?? String(event.text || '').split('|')[1] ?? 0) / 100;
      pendingDeliveries.set(event.senderId, Date.now());
      animateDelivery(progress);
      speak(`${event.senderName} 正在递来 ${name} · ${Math.round(progress * 100)}%`);
    }
    return;
  }
  $('events').querySelector('.empty-state')?.remove();
  renderEvent(event);
  // The mascot window owns animations and notifications. A history panel only
  // mirrors the live event stream, otherwise opening it would duplicate effects.
  if (panelMode) return;
  const actionText = { pet: '摸摸你啦', fish: '给你投喂小鱼干', walk: '让你散步啦', sit: '让你坐下啦', sleep: '让你睡觉啦', stretch: '让你伸个懒腰', jump: '让你乱蹦啦', hug: '给你一个抱抱', kiss: '亲亲你', groom: '给你梳梳毛', purr: '在你身边呼噜' };
  if (event.kind === 'walk' && desktop && !panelMode) desktop.startWalk();
  else if (event.kind === 'walk') animateRemoteAction('happy');
  else if (event.kind === 'wave') animatePet('wiggle');
  else if (actionText[event.kind]) animateRemoteAction(event.kind);
  if (event.senderId !== senderId) {
    const message = event.kind === 'file' ? `收到文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 来打招呼啦` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : event.text;
    speak(message, actionText[event.kind] ? 'alert' : 'normal');
    if (event.kind === 'file' || event.kind === 'message') {
      const started = pendingDeliveries.get(event.senderId);
      pendingDeliveries.delete(event.senderId);
      setTimeout(animateReceive, started ? Math.max(0, 650 - (Date.now() - started)) : 0);
    }
    if (desktop && state.notifications) desktop.notify('咚咚', event.kind === 'file' ? `${event.senderName} 发来文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 向你招手` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : `${event.senderName}：${event.text}`);
  }
}

function openSocket() {
  if (!state.connected) return;
  const socket = new WebSocket(`${state.url.replace(/^http/, 'ws')}/ws?v=3&session=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socket.onopen = async () => {
    setStatus('已连接', 'online');
    try {
      const response = await request('/events');
      for (const event of await response.json()) onEvent(event);
    } catch { /* The socket's close handler will retry if the room went away. */ }
  };
  socket.onmessage = message => {
    const payload = JSON.parse(message.data);
    if (payload.type === 'event') onEvent(payload.event);
    if (payload.type === 'presence') setPeerOnline(payload);
    if (payload.type === 'profile') applyProfile(payload.profile);
  };
  socket.onclose = () => {
    if (!state.connected || state.socket !== socket) return;
    setPeerOnline(false);
    setStatus('重连中', 'offline');
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(openSocket, 2500);
  };
}

async function connect(url, key, name, mode) {
  state.url = normalizeAddress(url);
  state.key = key.trim();
  state.name = name.trim().slice(0, 24);
  state.mode = mode;
  const session = await openSession(state.url, state.key, state.name, mode);
  state.token = session.token;
  state.profile = session.profile || {};
  const response = await request('/events');
  const events = await response.json();
  state.connected = true;
  $('setup').hidden = true;
  $('companion').hidden = false;
  $('pinButton').hidden = !desktop;
  $('settingsButton').hidden = true;
  $('roomAddress').textContent = state.url;
  $('roomKey').textContent = state.key;
  $('hostKeyBlock').hidden = mode !== 'host';
  $('events').replaceChildren();
  seenEvents.clear();
  const visibleEvents = events.filter(event => event.kind !== 'delivery');
  if (visibleEvents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '这里还没有消息';
    $('events').appendChild(empty);
  } else {
    events.forEach(event => { seenEvents.add(event.id); if (event.kind !== 'delivery') renderEvent(event); });
    $('speech').textContent = '';
  }
  applyProfile(state.profile);
  setPeerOnline(session.presence || false);
  if (panelMode) {
    state.expanded = true;
    $('window').classList.remove('compact');
    $('expanded').hidden = false;
    $('compactActions').hidden = true;
    setView(panelKind === 'settings' ? 'connection' : 'chat');
  } else {
    setView('chat');
    setExpanded(!desktop);
  }
  setStatus('已连接', 'online');
  setPose('idle');
  scheduleNap();
  clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    if (!state.connected || state.walking || state.pose !== 'idle') return;
    setPose('blink');
    setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, 170);
  }, 6800);
  scheduleIdleAction();
  schedulePeek();
  openSocket();
  localStorage.setItem(SESSION_KEY, JSON.stringify({ url: state.url, key: state.key, name: state.name, mode }));
}

async function disconnect() {
  try { if (state.token) await request('/leave', { method: 'POST' }); } catch { /* Room may already be gone. */ }
  state.connected = false;
  if (state.walking) await desktop?.stopWalk();
  clearInterval(walkFrameTimer);
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearInterval(blinkTimer);
  clearTimeout(state.idleTimer);
  clearTimeout(peekTimer);
  clearTimeout(peekOutingTimer);
  clearTimeout(edgeHoldTimer);
  state.edgeHold = false;
  state.edgeAutoOuting = false;
  state.peeked = false;
  $('window').classList.remove('peeked');
  setQuickComposer(false);
  clearTimeout(state.reconnectTimer);
  state.socket?.close();
  state.socket = null;
  state.token = '';
  if (state.hostStarted && desktop && !panelMode) await desktop.stopHost();
  state.hostStarted = false;
  localStorage.removeItem(SESSION_KEY);
  $('companion').hidden = true;
  $('setup').hidden = false;
  $('appSettings').hidden = true;
  $('window').classList.remove('compact');
  $('pinButton').hidden = true;
  $('settingsButton').hidden = false;
  state.peerOnline = false;
  setStatus('待连接');
  if (desktop && !panelMode) desktop.setWindowSize(true);
  if (panelMode) desktop?.closePanel();
}

async function sendEvent(kind, text = '', data = {}) {
  try {
    const response = await request('/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text, data, clientId: crypto.randomUUID() })
    });
    if (kind === 'wave') {
      speak('招手送出去了');
    } else if (kind === 'walk') speak('已经让对方散步啦', 'alert');
    else if (kind === 'jump') speak('已经让对方乱蹦啦', 'alert');
    else if (['pet', 'fish', 'sit', 'sleep', 'stretch', 'hug', 'kiss', 'groom', 'purr'].includes(kind)) speak('动作送到对方那里啦', 'alert');
    return await response.json();
  } catch (error) { toast(error.message); return null; }
}

async function sendMessage(text) {
  const transferId = crypto.randomUUID();
  animateDelivery(0);
  if (!await sendEvent('delivery', '', { transferId, name: text.slice(0, 180), progress: 0, status: 'preparing' })) return;
  speak('叼着信出发啦');
  await new Promise(resolve => setTimeout(resolve, 380));
  await sendEvent('delivery', '', { transferId, name: text.slice(0, 180), progress: 55, status: 'walking' });
  await new Promise(resolve => setTimeout(resolve, 480));
  await sendEvent('delivery', '', { transferId, name: text.slice(0, 180), progress: 100, status: 'at-window' });
  await new Promise(resolve => setTimeout(resolve, 280));
  await sendEvent('message', text);
  speak('信送到窗口啦', 'alert');
}

async function sendFile(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return toast('文件不能超过 100 MB');
  const form = new FormData();
  form.append('file', file);
  form.append('senderId', senderId);
  form.append('senderName', state.name);
  form.append('fileName', file.name);
  form.append('clientId', crypto.randomUUID());
  speak(`叼着 ${file.name} 送过去…`);
  const transferId = crypto.randomUUID();
  animateDelivery(0);
  await sendEvent('delivery', '', { transferId, name: file.name, progress: 0, status: 'preparing' });
  try {
    const event = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let lastProgress = -1;
      xhr.open('POST', `${state.url}/api/files`);
      xhr.setRequestHeader('X-Pet-Session', state.token);
      xhr.upload.onprogress = progress => {
        if (!progress.lengthComputable) return;
        const ratio = progress.loaded / progress.total;
        if (ratio < 1 && ratio - lastProgress < 0.1) return;
        lastProgress = ratio;
        sendEvent('delivery', '', { transferId, name: file.name, progress: Math.round(ratio * 100), status: ratio >= 1 ? 'complete' : 'uploading' });
        speak(`叼着文件走到窗口 ${Math.round(ratio * 100)}%`);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error('文件发送失败'));
      };
      xhr.onerror = () => reject(new Error('文件发送失败'));
      xhr.send(form);
    });
    speak(`${event.fileName} 已送到窗口`);
    await sendEvent('delivery', '', { transferId, name: event.fileName, progress: 100, status: 'complete' });
  } catch (error) { toast(error.message); speak('发送失败', 'alert'); }
  $('fileInput').value = '';
}

async function copy(value) {
  if (desktop) await desktop.copy(value);
  else await navigator.clipboard.writeText(value);
  toast('已复制');
}

async function init() {
  if (panelMode && panelKind === 'settings' && !localStorage.getItem(SESSION_KEY)) {
    $('setup').hidden = true;
    $('appSettings').hidden = false;
  }
  $('hostTab').addEventListener('click', () => setMode('host'));
  $('joinTab').addEventListener('click', () => setMode('join'));
  $('closeButton').addEventListener('click', () => {
    if (panelMode) {
      desktop?.closePanel();
      return;
    }
    if (!$('appSettings').hidden || (state.connected && state.expanded)) {
      returnFromSettings();
      return;
    }
    desktop?.close();
  });
  $('settingsButton').addEventListener('click', () => {
    if (desktop?.openPanel) {
      desktop.openPanel('settings');
      return;
    }
    if (state.connected) { setExpanded(true); setView('connection'); return; }
    $('setup').hidden = true;
    $('appSettings').hidden = false;
    desktop?.setWindowSize(true);
  });
  $('settingsBackButton').addEventListener('click', returnFromSettings);
  $('idleActionsToggle').checked = state.idleActions;
  $('desktopNotificationsToggle').checked = state.notifications;
  $('idleActionsToggle').addEventListener('change', event => {
    state.idleActions = event.target.checked;
    localStorage.setItem('dongdong-idle-actions', JSON.stringify(state.idleActions));
    if (state.idleActions) scheduleIdleAction(); else clearTimeout(state.idleTimer);
  });
  $('desktopNotificationsToggle').addEventListener('change', event => {
    state.notifications = event.target.checked;
    localStorage.setItem('dongdong-notifications', JSON.stringify(state.notifications));
  });
  $('pinButton').addEventListener('click', async () => {
    state.pinned = !state.pinned;
    await desktop?.setPinned(state.pinned);
    $('pinButton').title = state.pinned ? '取消置顶' : '保持置顶';
    $('pinButton').classList.toggle('unpinned', !state.pinned);
  });
  $('mascotButton').addEventListener('click', () => {
    if (mascotDrag.suppressClick) { mascotDrag.suppressClick = false; return; }
    triggerAction('pet');
  });
  const mascotDrag = { pointerId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, suppressClick: false };
  $('mascotButton').addEventListener('pointerdown', event => {
    if (event.button !== 0 || !desktop?.moveWindow) return;
    mascotDrag.pointerId = event.pointerId;
    mascotDrag.startX = event.screenX;
    mascotDrag.startY = event.screenY;
    mascotDrag.lastX = event.screenX;
    mascotDrag.lastY = event.screenY;
    mascotDrag.moved = false;
    mascotDrag.suppressClick = false;
    $('mascotButton').setPointerCapture?.(event.pointerId);
  });
  $('mascotButton').addEventListener('pointermove', event => {
    if (mascotDrag.pointerId !== event.pointerId) return;
    if (!mascotDrag.moved && Math.hypot(event.screenX - mascotDrag.startX, event.screenY - mascotDrag.startY) < 4) return;
    const deltaX = event.screenX - mascotDrag.lastX;
    const deltaY = event.screenY - mascotDrag.lastY;
    mascotDrag.lastX = event.screenX;
    mascotDrag.lastY = event.screenY;
    mascotDrag.moved = true;
    mascotDrag.suppressClick = true;
    event.preventDefault();
    desktop.moveWindow(deltaX, deltaY);
  });
  const finishMascotDrag = event => {
    if (mascotDrag.pointerId !== event.pointerId) return;
    mascotDrag.pointerId = null;
    if (mascotDrag.moved) mascotDrag.suppressClick = true;
    $('mascotButton').releasePointerCapture?.(event.pointerId);
  };
  $('mascotButton').addEventListener('pointerup', finishMascotDrag);
  $('mascotButton').addEventListener('pointercancel', finishMascotDrag);
  $('mascotButton').addEventListener('contextmenu', event => {
    if (!state.connected) return;
    event.preventDefault();
    const menu = $('contextMenu');
    const main = document.querySelector('.companion-main');
    menu.style.left = `${Math.max(6, Math.min(event.offsetX, main.clientWidth - 132))}px`;
    menu.style.top = `${Math.max(6, event.offsetY - 8)}px`;
    menu.hidden = false;
  });
  $('contextHistory').addEventListener('click', () => { $('contextMenu').hidden = true; desktop?.openPanel?.('chat'); });
  $('contextSettings').addEventListener('click', () => {
    $('contextMenu').hidden = true;
    if (desktop?.openPanel) desktop.openPanel('settings');
    else { setExpanded(true); setView('connection'); }
  });
  $('contextDisconnect').addEventListener('click', () => { $('contextMenu').hidden = true; disconnect(); });
  $('mascotButton').addEventListener('mouseenter', unpeek);
  $('mascotButton').addEventListener('focus', unpeek);
  document.addEventListener('click', event => { if (!event.target.closest('#contextMenu')) $('contextMenu').hidden = true; });
  $('waveButton').addEventListener('click', () => triggerAction('wave'));
  $('careButton').addEventListener('click', () => triggerAction('care'));
  $('actionMenuButton').addEventListener('click', () => { $('actionTray').hidden = !$('actionTray').hidden; });
  document.querySelectorAll('.action-choice').forEach(button => button.addEventListener('click', () => {
    $('actionTray').hidden = true;
    triggerAction(button.dataset.action);
  }));
  if (desktop) desktop.onWalkState(onWalkState);
  if (desktop?.onPeekState) desktop.onPeekState(peeked => {
    state.peeked = Boolean(peeked);
    $('window').classList.toggle('peeked', state.peeked);
  });
  if (desktop?.onMenuAction) desktop.onMenuAction(action => {
    if (action === 'settings') {
      if (desktop?.openPanel) desktop.openPanel('settings');
      else { setExpanded(true); setView('connection'); }
    }
    if (action === 'show') setExpanded(state.connected ? state.expanded : true);
  });
  $('openButton').addEventListener('click', () => {
    // Keep the live message flow beside the cat. The full conversation is a
    // separate panel, so this action never resizes or hides the mascot.
    if (!state.connected) return toast('还没有连接房间');
    setQuickComposer($('quickMessageForm').hidden);
  });
  $('quickMessageClose').addEventListener('click', () => setQuickComposer(false));
  $('quickMessageForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('quickMessageInput');
    const text = input.value.trim();
    if (!text) return;
    if (!state.connected) return toast('还没有连接房间');
    input.value = '';
    sendMessage(text).finally(() => input.focus());
  });
  $('quickMessageInput').addEventListener('keydown', event => {
    if (event.key === 'Escape') setQuickComposer(false);
  });
  $('collapseButton').addEventListener('click', returnFromSettings);
  $('chatTab').addEventListener('click', () => setView('chat'));
  $('connectionTab').addEventListener('click', () => setView('connection'));
  $('disconnectButton').addEventListener('click', disconnect);
  $('openDownloadsButton').addEventListener('click', () => desktop?.openDownloads());
  $('copyAddress').addEventListener('click', () => copy(state.url));
  $('copyKey').addEventListener('click', () => copy(state.key));
  $('saveProfileButton').addEventListener('click', async () => {
    try {
      const response = await request('/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ petName: $('profilePetName').value.trim() }) });
      applyProfile(await response.json());
      toast('共享资料已更新');
    } catch (error) { toast(error.message); }
  });
  $('quickFileButton').addEventListener('click', () => $('fileInput').click());
  $('fileButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => sendFile(event.target.files[0]));
  $('messageForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('messageInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendMessage(text);
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', event => { event.preventDefault(); if (state.connected) { dragDepth++; $('dropOverlay').hidden = false; } });
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
    if (state.connected) sendFile(event.dataTransfer.files[0]);
  });

  const addresses = desktop ? await desktop.addresses() : [];
  $('hostAddress').replaceChildren();
  if (addresses.length) {
    for (const item of addresses) {
      const option = document.createElement('option');
      option.value = item.address;
      option.textContent = `${item.address} (${item.name})`;
      $('hostAddress').appendChild(option);
    }
  } else {
    const option = document.createElement('option');
    option.textContent = desktop ? '未检测到 Tailscale 地址' : '请在桌面应用中创建房间';
    option.value = '';
    $('hostAddress').appendChild(option);
    $('hostForm').querySelector('button[type=submit]').disabled = true;
  }

  $('hostForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('setupFeedback').textContent = '';
    try {
      const result = await desktop.startHost($('hostAddress').value, senderId);
      state.hostStarted = true;
      await connect(result.url, result.key, $('hostName').value, 'host');
    } catch (error) { $('setupFeedback').textContent = error.message; }
  });
  $('joinForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('setupFeedback').textContent = '';
    try { await connect($('joinAddress').value, $('joinKey').value, $('joinName').value, 'join'); }
    catch (error) { $('setupFeedback').textContent = error.message; }
  });

  if (desktop) {
    setAutoLaunchToggles(await desktop.getAutoLaunch());
    const updateAutoLaunch = async event => {
      try {
        const value = await desktop.setAutoLaunch(event.target.checked);
        setAutoLaunchToggles(value);
        toast(event.target.checked ? '已开启开机自启动' : '已关闭开机自启动');
      } catch (error) {
        setAutoLaunchToggles(!event.target.checked);
        toast(error.message);
      }
    };
    $('autoLaunchToggle').addEventListener('change', updateAutoLaunch);
    $('autoLaunchSetup').addEventListener('change', updateAutoLaunch);
  } else {
    $('autoLaunchToggle').disabled = true;
    $('autoLaunchSetup').disabled = true;
  }

  const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  if (new URLSearchParams(location.search).has('preview')) {
    await connect('127.0.0.1:4827', 'preview-only', '我', 'host');
  } else if (saved) {
    $('hostName').value = saved.name;
    $('joinName').value = saved.name;
    $('joinAddress').value = saved.url;
    $('joinKey').value = saved.key;
    setMode(saved.mode);
    try {
      if (saved.mode === 'host' && desktop && !panelMode) {
        const address = new URL(saved.url).hostname;
        const result = await desktop.startHost(address, senderId);
        state.hostStarted = true;
        await connect(result.url, result.key, saved.name, 'host');
      } else await connect(saved.url, saved.key, saved.name, saved.mode);
    } catch { $('setupFeedback').textContent = '上次的房间暂时无法连接，请重新尝试'; }
  }
}

init().catch(error => { $('setupFeedback').textContent = error.message; });

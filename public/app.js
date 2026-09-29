const $ = id => document.getElementById(id);
const desktop = window.petDesktop;
const senderId = localStorage.getItem('dongdong-sender-id') || crypto.randomUUID();
localStorage.setItem('dongdong-sender-id', senderId);

const state = {
  mode: 'host', url: '', key: '', name: '', socket: null,
  connected: false, expanded: false, pinned: true, view: 'chat',
  reconnectTimer: null, hostStarted: false, walking: false, pose: 'idle'
};
const seenEvents = new Set();
let poseTimer;
let napTimer;
let blinkTimer;
let walkFrameTimer;

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
  pet.classList.remove('wiggle', 'happy', 'nap');
  pet.style.backgroundImage = `url('./mascot${pose === 'idle' ? '' : `-${pose}`}.svg')`;
  if (pose === 'wave') pet.classList.add('wiggle');
  if (pose === 'happy') pet.classList.add('happy');
  if (pose === 'nap') pet.classList.add('nap');
}

function scheduleNap() {
  clearTimeout(napTimer);
  napTimer = setTimeout(() => {
    if (!state.connected) return;
    setPose('nap');
    $('speech').textContent = '呼噜…';
  }, 45000);
}

function animatePet(kind = 'happy') {
  clearTimeout(poseTimer);
  setPose(kind === 'wiggle' ? 'wave' : 'happy');
  const pet = $('mainMascot');
  pet.classList.remove('wiggle', 'happy');
  void pet.offsetWidth;
  pet.classList.add(kind);
  poseTimer = setTimeout(() => setPose('idle'), 1500);
  scheduleNap();
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

function setExpanded(expanded) {
  state.expanded = expanded;
  $('window').classList.toggle('compact', !expanded);
  $('expanded').hidden = !expanded;
  $('compactActions').hidden = expanded;
  const resized = desktop?.setWindowSize(expanded);
  if (expanded) setTimeout(() => $('messageInput').focus(), 100);
  return resized;
}

function onWalkState(walking) {
  state.walking = walking;
  $('walkLabel').textContent = walking ? '停下' : '散步';
  $('walkButton').title = walking ? '让小猫停下' : '让小猫散步';
  clearInterval(walkFrameTimer);
  if (walking) {
    clearTimeout(poseTimer);
    clearTimeout(napTimer);
    let frame = 1;
    setPose('walk-1');
    walkFrameTimer = setInterval(() => { frame = frame === 1 ? 2 : 1; setPose(`walk-${frame}`); }, 180);
    $('speech').textContent = '出门散步啦';
  } else if (state.connected) {
    setPose('idle');
    scheduleNap();
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
  const response = await fetch(`${state.url}/api${route}`, {
    ...options,
    headers: { 'X-Pet-Key': state.key, ...options.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return response;
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
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = event.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
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
    body.textContent = event.kind === 'wave' ? '👋 向你招了招手' : event.text;
    wrapper.appendChild(body);
  }
  $('events').appendChild(wrapper);
  $('events').scrollTop = $('events').scrollHeight;
}

function onEvent(event) {
  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  $('events').querySelector('.empty-state')?.remove();
  renderEvent(event);
  if (event.senderId !== senderId) {
    $('speech').textContent = event.kind === 'file' ? `收到文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 来打招呼啦` : event.text;
    animatePet(event.kind === 'wave' ? 'wiggle' : 'happy');
    if (desktop) desktop.notify('咚咚', event.kind === 'file' ? `${event.senderName} 发来文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 向你招手` : `${event.senderName}：${event.text}`);
  }
}

function openSocket() {
  if (!state.connected) return;
  const socket = new WebSocket(`${state.url.replace(/^http/, 'ws')}/ws?key=${encodeURIComponent(state.key)}`);
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
  };
  socket.onclose = () => {
    if (!state.connected || state.socket !== socket) return;
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
  const response = await request('/events');
  const events = await response.json();
  state.connected = true;
  $('setup').hidden = true;
  $('companion').hidden = false;
  $('pinButton').hidden = !desktop;
  $('roomAddress').textContent = state.url;
  $('roomKey').textContent = state.key;
  $('hostKeyBlock').hidden = mode !== 'host';
  $('events').replaceChildren();
  seenEvents.clear();
  if (events.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '这里还没有消息';
    $('events').appendChild(empty);
  } else {
    events.forEach(event => { seenEvents.add(event.id); renderEvent(event); });
    const latest = events[events.length - 1];
    $('speech').textContent = latest.kind === 'file' ? `${latest.senderName} 发来文件` : latest.kind === 'wave' ? `${latest.senderName} 来打招呼啦` : latest.text;
  }
  setView('chat');
  setExpanded(!desktop);
  setStatus('已连接', 'online');
  setPose('idle');
  scheduleNap();
  clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    if (!state.connected || state.walking || state.pose !== 'idle') return;
    setPose('blink');
    setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, 170);
  }, 6800);
  openSocket();
  localStorage.setItem('dongdong-session', JSON.stringify({ url: state.url, key: state.key, name: state.name, mode }));
}

async function disconnect() {
  state.connected = false;
  if (state.walking) await desktop?.stopWalk();
  clearInterval(walkFrameTimer);
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearInterval(blinkTimer);
  clearTimeout(state.reconnectTimer);
  state.socket?.close();
  state.socket = null;
  if (state.hostStarted && desktop) await desktop.stopHost();
  state.hostStarted = false;
  localStorage.removeItem('dongdong-session');
  $('companion').hidden = true;
  $('setup').hidden = false;
  $('window').classList.remove('compact');
  $('pinButton').hidden = true;
  setStatus('待连接');
  if (desktop) desktop.setWindowSize(true);
}

async function sendEvent(kind, text = '') {
  try {
    await request('/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text, senderId, senderName: state.name })
    });
    if (kind === 'wave') {
      $('speech').textContent = '招手送出去了';
      animatePet('wiggle');
    }
  } catch (error) { toast(error.message); }
}

async function sendFile(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return toast('文件不能超过 100 MB');
  const form = new FormData();
  form.append('file', file);
  form.append('senderId', senderId);
  form.append('senderName', state.name);
  $('speech').textContent = `正在发送 ${file.name}`;
  try {
    await request('/files', { method: 'POST', body: form });
    $('speech').textContent = `${file.name} 已送达`;
    animatePet('happy');
  } catch (error) { toast(error.message); $('speech').textContent = '发送失败'; }
  $('fileInput').value = '';
}

async function copy(value) {
  if (desktop) await desktop.copy(value);
  else await navigator.clipboard.writeText(value);
  toast('已复制');
}

async function init() {
  $('hostTab').addEventListener('click', () => setMode('host'));
  $('joinTab').addEventListener('click', () => setMode('join'));
  $('closeButton').addEventListener('click', () => desktop?.close());
  $('pinButton').addEventListener('click', async () => {
    state.pinned = !state.pinned;
    await desktop?.setPinned(state.pinned);
    $('pinButton').title = state.pinned ? '取消置顶' : '保持置顶';
    $('pinButton').classList.toggle('unpinned', !state.pinned);
  });
  $('mascotButton').addEventListener('click', () => { const sleeping = $('mainMascot').classList.contains('nap'); animatePet('happy'); $('speech').textContent = sleeping ? '醒啦，喵～' : '喵～'; });
  $('waveButton').addEventListener('click', () => sendEvent('wave'));
  $('walkButton').hidden = !desktop;
  if (desktop) desktop.onWalkState(onWalkState);
  $('walkButton').addEventListener('click', async () => {
    if (!desktop || !state.connected) return;
    if (state.walking) await desktop.stopWalk();
    else { await setExpanded(false); await desktop.startWalk(); }
  });
  $('openButton').addEventListener('click', () => setExpanded(true));
  $('collapseButton').addEventListener('click', () => setExpanded(false));
  $('chatTab').addEventListener('click', () => setView('chat'));
  $('connectionTab').addEventListener('click', () => setView('connection'));
  $('disconnectButton').addEventListener('click', disconnect);
  $('copyAddress').addEventListener('click', () => copy(state.url));
  $('copyKey').addEventListener('click', () => copy(state.key));
  $('quickFileButton').addEventListener('click', () => $('fileInput').click());
  $('fileButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => sendFile(event.target.files[0]));
  $('messageForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('messageInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendEvent('message', text);
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
      const result = await desktop.startHost($('hostAddress').value);
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

  const saved = JSON.parse(localStorage.getItem('dongdong-session') || 'null');
  if (new URLSearchParams(location.search).has('preview')) {
    await connect('127.0.0.1:4827', 'preview-only', '我', 'host');
  } else if (saved) {
    $('hostName').value = saved.name;
    $('joinName').value = saved.name;
    $('joinAddress').value = saved.url;
    $('joinKey').value = saved.key;
    setMode(saved.mode);
    try {
      if (saved.mode === 'host' && desktop) {
        const address = new URL(saved.url).hostname;
        const result = await desktop.startHost(address);
        state.hostStarted = true;
        await connect(result.url, result.key, saved.name, 'host');
      } else await connect(saved.url, saved.key, saved.name, 'join');
    } catch { $('setupFeedback').textContent = '上次的房间暂时无法连接，请重新尝试'; }
  }
}

init().catch(error => { $('setupFeedback').textContent = error.message; });

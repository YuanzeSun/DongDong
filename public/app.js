const $ = id => document.getElementById(id);
const desktop = window.petDesktop;
const SESSION_KEY = 'dongdong-session-v2';
const senderId = localStorage.getItem('dongdong-sender-id-v2') || crypto.randomUUID();
localStorage.setItem('dongdong-sender-id-v2', senderId);

const state = {
  mode: 'host', url: '', key: '', name: '', socket: null,
  connected: false, expanded: false, pinned: true, view: 'chat', peerOnline: false,
  reconnectTimer: null, idleTimer: null, hostStarted: false, walking: false, pose: 'idle'
};
const seenEvents = new Set();
let poseTimer;
let napTimer;
let blinkTimer;
let walkFrameTimer;

function speak(message, kind = 'normal') {
  $('speech').textContent = message;
  $('speech').classList.remove('speech-pop', 'speech-alert');
  void $('speech').offsetWidth;
  $('speech').classList.add(kind === 'alert' ? 'speech-alert' : 'speech-pop');
  clearTimeout(speak.timer);
  speak.timer = setTimeout(() => $('speech').classList.remove('speech-pop', 'speech-alert'), 1800);
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
  pet.classList.remove('wiggle', 'happy', 'jump', 'nap', 'pet', 'fish', 'sit', 'sleep', 'stretch', 'delivery', 'receive', 'speech-pop');
  pet.style.backgroundImage = `url('./mascot${pose === 'idle' ? '' : `-${pose}`}.svg')`;
  if (pose === 'wave') pet.classList.add('wiggle');
  if (pose === 'happy') pet.classList.add('happy');
  if (pose === 'nap') pet.classList.add('nap');
}

function scheduleNap() {
  clearTimeout(napTimer);
  napTimer = setTimeout(() => {
    if (!state.connected) return;
    if (state.peerOnline) return scheduleIdleAction();
    setPose('nap');
    speak('对方离线，先睡一会儿…', 'alert');
  }, state.peerOnline ? 45000 : 250);
}

function scheduleIdleAction() {
  clearTimeout(state.idleTimer);
  if (!state.connected || !state.peerOnline || state.walking) return;
  state.idleTimer = setTimeout(() => {
    if (!state.connected || !state.peerOnline || state.walking || state.pose !== 'idle') return scheduleIdleAction();
    const action = ['blink', 'happy', 'wiggle'][Math.floor(Math.random() * 3)];
    if (action === 'blink') {
      setPose('blink');
      speak('喵？');
      setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, 260);
    } else {
      animatePet(action);
    }
    scheduleIdleAction();
  }, 18000 + Math.random() * 18000);
}

function setPeerOnline(online) {
  state.peerOnline = Boolean(online);
  $('presenceText').textContent = state.peerOnline ? '对方在线' : '对方离线，小猫正在休息';
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
  scheduleNap();
}

function animateDelivery(progress = 1) {
  clearTimeout(poseTimer);
  const pet = $('mainMascot');
  setPose('idle');
  pet.classList.remove('delivery');
  void pet.offsetWidth;
  pet.style.setProperty('--delivery-progress', String(Math.max(0, Math.min(1, progress))));
  pet.classList.add('delivery');
  poseTimer = setTimeout(() => { pet.classList.remove('delivery'); setPose(state.peerOnline ? 'idle' : 'nap'); }, 1700);
}

function animateReceive() {
  clearTimeout(poseTimer);
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
    speak('对方让你睡一会儿…');
    return;
  }
  const pet = $('mainMascot');
  clearTimeout(poseTimer);
  setPose('idle');
  pet.classList.remove('sit', 'stretch');
  void pet.offsetWidth;
  if (kind === 'sit' || kind === 'stretch') {
    pet.classList.add(kind);
    poseTimer = setTimeout(() => { pet.classList.remove(kind); setPose(state.peerOnline ? 'idle' : 'nap'); }, 1800);
  } else {
    animatePet(kind === 'fish' ? 'fish' : kind === 'pet' ? 'pet' : kind);
  }
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
    const labels = { wave: '👋 向你招了招手', walk: '🐾 让你的小猫散步', jump: '✨ 让你的小猫乱蹦', pet: '🤍 摸摸小猫', fish: '🐟 投喂小鱼干', sit: '🪑 让小猫坐下', sleep: '💤 让小猫睡觉', stretch: '☀ 让小猫伸懒腰' };
    body.textContent = labels[event.kind] || event.text;
    wrapper.appendChild(body);
  }
  $('events').appendChild(wrapper);
  $('events').scrollTop = $('events').scrollHeight;
}

function onEvent(event) {
  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  if (event.kind === 'delivery') {
    if (event.senderId !== senderId) {
      const [name, progressText] = String(event.text || '').split('|');
      const progress = Number(progressText) / 100;
      animateDelivery(progress);
      speak(`${event.senderName} 正在递来 ${name || '一封信'} · ${Math.round(progress * 100)}%`);
    }
    return;
  }
  $('events').querySelector('.empty-state')?.remove();
  renderEvent(event);
  if (event.senderId !== senderId) {
    const actionText = { pet: '摸摸你啦', fish: '给你投喂小鱼干', walk: '让你散步啦', sit: '让你坐下啦', sleep: '让你睡觉啦', stretch: '让你伸个懒腰', jump: '让你乱蹦啦' };
    const message = event.kind === 'file' ? `收到文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 来打招呼啦` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : event.text;
    speak(message, actionText[event.kind] ? 'alert' : 'normal');
    if (event.kind === 'file' || event.kind === 'message') animateReceive();
    else if (event.kind === 'walk' && desktop) desktop.startWalk();
    else if (event.kind === 'wave') animatePet('wiggle');
    else if (actionText[event.kind]) animateRemoteAction(event.kind);
    if (desktop) desktop.notify('咚咚', event.kind === 'file' ? `${event.senderName} 发来文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 向你招手` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : `${event.senderName}：${event.text}`);
  }
}

function openSocket() {
  if (!state.connected) return;
  const socket = new WebSocket(`${state.url.replace(/^http/, 'ws')}/ws?v=2&key=${encodeURIComponent(state.key)}&senderId=${encodeURIComponent(senderId)}&mode=${encodeURIComponent(state.mode)}`);
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
    if (payload.type === 'presence') setPeerOnline(payload.online);
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
    const latest = visibleEvents[visibleEvents.length - 1];
    $('speech').textContent = latest.kind === 'file' ? `${latest.senderName} 发来文件` : latest.kind === 'wave' ? `${latest.senderName} 来打招呼啦` : latest.text;
  }
  setPeerOnline(false);
  const showSettings = mode === 'host' && Boolean(desktop);
  setView(showSettings ? 'connection' : 'chat');
  setExpanded(showSettings || !desktop);
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
  openSocket();
  localStorage.setItem(SESSION_KEY, JSON.stringify({ url: state.url, key: state.key, name: state.name, mode }));
}

async function disconnect() {
  state.connected = false;
  if (state.walking) await desktop?.stopWalk();
  clearInterval(walkFrameTimer);
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearInterval(blinkTimer);
  clearTimeout(state.idleTimer);
  clearTimeout(state.reconnectTimer);
  state.socket?.close();
  state.socket = null;
  if (state.hostStarted && desktop) await desktop.stopHost();
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
  if (desktop) desktop.setWindowSize(true);
}

async function sendEvent(kind, text = '') {
  try {
    if (kind === 'message') animateDelivery(0);
    await request('/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text, senderId, senderName: state.name })
    });
    if (kind === 'wave') {
      speak('招手送出去了');
    } else if (kind === 'walk') speak('已经让对方散步啦', 'alert');
    else if (kind === 'jump') speak('已经让对方乱蹦啦', 'alert');
    else if (['pet', 'fish', 'sit', 'sleep', 'stretch'].includes(kind)) speak('动作送到对方那里啦', 'alert');
  } catch (error) { toast(error.message); }
}

async function sendFile(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return toast('文件不能超过 100 MB');
  const form = new FormData();
  form.append('file', file);
  form.append('senderId', senderId);
  form.append('senderName', state.name);
  speak(`叼着 ${file.name} 送过去…`);
  await sendEvent('delivery', `${file.name}|0`);
  try {
    const event = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let lastProgress = -1;
      xhr.open('POST', `${state.url}/api/files`);
      xhr.setRequestHeader('X-Pet-Key', state.key);
      xhr.upload.onprogress = progress => {
        if (!progress.lengthComputable) return;
        const ratio = progress.loaded / progress.total;
        if (ratio < 1 && ratio - lastProgress < 0.1) return;
        lastProgress = ratio;
        sendEvent('delivery', `${file.name}|${Math.round(ratio * 100)}`);
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
  } catch (error) { toast(error.message); speak('发送失败', 'alert'); }
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
  $('settingsButton').addEventListener('click', () => {
    if (state.connected) { setExpanded(true); setView('connection'); return; }
    $('setup').hidden = true;
    $('appSettings').hidden = false;
    desktop?.setWindowSize(true);
  });
  $('settingsBackButton').addEventListener('click', () => {
    $('appSettings').hidden = true;
    $('setup').hidden = false;
  });
  $('pinButton').addEventListener('click', async () => {
    state.pinned = !state.pinned;
    await desktop?.setPinned(state.pinned);
    $('pinButton').title = state.pinned ? '取消置顶' : '保持置顶';
    $('pinButton').classList.toggle('unpinned', !state.pinned);
  });
  $('mascotButton').addEventListener('click', () => {
    if (!state.connected || !state.peerOnline) return toast('对方当前不在线');
    sendEvent('pet');
  });
  $('mascotButton').addEventListener('contextmenu', event => {
    if (!state.connected) return;
    event.preventDefault();
    const menu = $('contextMenu');
    const main = document.querySelector('.companion-main');
    menu.style.left = `${Math.max(6, Math.min(event.offsetX, main.clientWidth - 132))}px`;
    menu.style.top = `${Math.max(6, event.offsetY - 8)}px`;
    menu.hidden = false;
  });
  $('contextSettings').addEventListener('click', () => { $('contextMenu').hidden = true; setExpanded(true); setView('connection'); });
  $('contextDisconnect').addEventListener('click', () => { $('contextMenu').hidden = true; disconnect(); });
  document.addEventListener('click', event => { if (!event.target.closest('#contextMenu')) $('contextMenu').hidden = true; });
  $('waveButton').addEventListener('click', () => sendEvent('wave'));
  $('actionMenuButton').addEventListener('click', () => { $('actionTray').hidden = !$('actionTray').hidden; });
  document.querySelectorAll('.action-choice').forEach(button => button.addEventListener('click', () => {
    if (!state.connected || !state.peerOnline) return toast('对方当前不在线');
    $('actionTray').hidden = true;
    sendEvent(button.dataset.action);
  }));
  if (desktop) desktop.onWalkState(onWalkState);
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
    (async () => {
      await sendEvent('delivery', `${text.slice(0, 180)}|0`);
      await sendEvent('message', text);
    })();
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

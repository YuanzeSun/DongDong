const $ = id => document.getElementById(id);
const desktop = window.petDesktop;
const panelKind = desktop?.panelKind || '';
const panelMode = panelKind === 'chat' || panelKind === 'settings';
const catAnimator = !panelMode && window.PixelCatAnimator ? new window.PixelCatAnimator($('mainMascot')) : null;
const DEFAULT_PET_NAME = '小橘';
const SESSION_KEY = 'dongdong-session-v4';
let roomIdentity = '';
let uploadStarting = false;
let freshConnection = false;
const SAVED_FILES_KEY = 'dongdong-saved-files-v4';
const senderId = localStorage.getItem('dongdong-sender-id-v4') || crypto.randomUUID();
localStorage.setItem('dongdong-sender-id-v4', senderId);

const state = {
  mode: 'host', url: '', token: '', name: '', socket: null,
  connected: false, roomConnection: 'closed', expanded: false, view: 'chat', peerOnline: false,
  peerName: '对方', profile: {},
  reconnectTimer: null, idleTimer: null, hostStarted: false, walking: false, jumping: false, pose: 'idle',
  idleActions: JSON.parse(localStorage.getItem('dongdong-idle-actions') ?? 'true'),
  edgeHideEnabled: JSON.parse(localStorage.getItem('dongdong-edge-hide') ?? 'false'),
  peeked: false, edgeHold: false, edgeAutoOuting: false,
  notifications: JSON.parse(localStorage.getItem('dongdong-notifications') ?? 'true')
};
const seenEvents = new Set();
let poseTimer;
let napTimer;
let blinkTimer;
let wakeTimer;
let wakeCallback;
let stanceTimer;
let voiceTimer;
let actionEpoch = 0;
let motionPendingKind = null;
let automaticMotion = false;
let peekTimer;
let peekOutingTimer;
let edgeHoldTimer;
let connectionEpoch = 0;
let reconnectAttempt = 0;
let retryInFlightEpoch = null;
let socketConnectTimer;
let offlineNapDeadline = 0;
let hostNeedsStart = false;
let recoveryBlocked = false;
const activeDownloads = new Set();
const savedFileIds = new Set(JSON.parse(localStorage.getItem(SAVED_FILES_KEY) || '[]'));
const transferStates = new Map();
const transferRows = new Map();
const activeTransferAnimations = new Set();
let ignoringMouse = false;
let lastPointer = null;
const ACTIONS_LINGER_MS = 2000;
let actionsHoverUntil = 0;
let actionsHideTimer;
const mascotDrag = { pointerId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, suppressClick: false };

if (panelMode) document.body.classList.add('panel-mode');

function clearSpeech() {
  clearTimeout(speak.timer);
  $('speech').classList.remove('speech-pop', 'speech-alert', 'speech-message');
  $('speech').textContent = '';
  $('speech').dataset.message = '';
  $('speech').title = '';
  syncMousePassThrough();
}

function scheduleSpeechDismiss() {
  clearTimeout(speak.timer);
  const bubble = $('speech');
  if (!bubble.textContent || bubble.classList.contains('speech-message') && bubble.matches(':hover')) return;
  speak.timer = setTimeout(clearSpeech, speak.duration);
}

function scrollSpeech(delta) {
  const bubble = $('speech');
  if (!bubble.classList.contains('speech-message') || !Number.isFinite(delta)
    || !Number.isFinite(bubble.scrollHeight) || !Number.isFinite(bubble.clientHeight)
    || bubble.scrollHeight <= bubble.clientHeight) return;
  const maximum = bubble.scrollHeight - bubble.clientHeight;
  bubble.scrollTop = Math.max(0, Math.min(maximum, (Number(bubble.scrollTop) || 0) + delta));
}

function openSpeechHistory() {
  if (!state.connected || !$('speech').classList.contains('speech-message')) return;
  desktop?.openPanel?.('chat');
}

async function copySpeechText(message) {
  if (!message) return;
  try { await copy(message); toast('已复制消息'); }
  catch (error) { toast(error.message); }
}

function copySpeechMessage() {
  return copySpeechText($('speech').dataset.message);
}

function speak(message, kind = 'normal') {
  if (panelMode) return;
  const bubble = $('speech');
  if (kind !== 'message' && bubble.classList.contains('speech-message')) return;
  clearSpeech();
  bubble.textContent = message;
  bubble.scrollTop = 0;
  bubble.classList.toggle('speech-message', kind === 'message');
  bubble.dataset.message = kind === 'message' ? message : '';
  bubble.title = kind === 'message' ? '点击查看消息记录，双击复制' : '';
  void bubble.offsetWidth;
  bubble.classList.add(kind === 'alert' ? 'speech-alert' : 'speech-pop');
  speak.duration = kind === 'message' ? Math.min(12000, Math.max(4500, message.length * 110)) : 1800;
  scheduleSpeechDismiss();
  syncMousePassThrough();
}

const ACTION_VOICES = {
  wave: ['喵～', '喵呜！'], happy: ['喵！', '咪呀！'], jump: ['喵呜！', '咪！'],
  walk: ['喵～', '咪呜～'], pet: ['呼噜～', '咪～'], fish: ['喵！', '咪呀～'],
  stretch: ['喵嗷～', '哈啊～'], groom: ['咪～', '喵～'], hug: ['咪呜～', '喵～'],
  kiss: ['啾～', '咪！'], purr: ['呼噜噜～', '咕噜咕噜～']
};
function actionVoice(pose) {
  if (panelMode) return;
  const bubble = $('voiceBubble');
  clearTimeout(voiceTimer);
  const options = ACTION_VOICES[pose];
  if (!options) { bubble.hidden = true; return; }
  bubble.textContent = options[Math.floor(Math.random() * options.length)];
  bubble.hidden = false;
  voiceTimer = setTimeout(() => { bubble.hidden = true; }, pose === 'purr' ? 5000 : 1350);
}

function setAutoLaunchToggles(value) {
  $('autoLaunchSetup').checked = Boolean(value);
}

function placePreferences() {
  const destination = $(state.connected ? 'connectionPreferences' : 'setupPreferences');
  if ($('preferenceSettings').parentElement !== destination) destination.appendChild($('preferenceSettings'));
  if (state.connected) $('appSettings').hidden = true;
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

function updateConnectionStatus() {
  if (!state.connected) return setStatus('待连接');
  if (state.roomConnection !== 'online') return setStatus('对方离线', 'offline');
  setStatus(state.peerOnline ? '已连接' : '对方离线', state.peerOnline ? 'online' : 'offline');
}

function setPose(pose) {
  if (panelMode) return;
  const previous = state.pose;
  clearTimeout(wakeTimer);
  clearTimeout(stanceTimer);
  wakeTimer = null;
  wakeCallback = null;
  state.pose = pose;
  $('mainMascot').classList.remove('delivery');
  catAnimator?.play(pose);
  if (previous !== pose) actionVoice(pose);
}

function wakeThen(callback) {
  if (panelMode) return;
  const resting = state.pose;
  if (!['nap', 'sleep', 'nest', 'nest-enter', 'loaf', 'loaf-enter', 'purr'].includes(resting)) return callback();
  wakeCallback = callback;
  if (wakeTimer) return;
  const rise = resting === 'nest' || resting === 'nest-enter' ? 'nest-rise' : ['loaf', 'loaf-enter', 'purr'].includes(resting) ? 'loaf-rise' : 'wake';
  catAnimator?.play(rise);
  wakeTimer = setTimeout(() => {
    const ready = wakeCallback;
    wakeTimer = null;
    setPose('idle');
    ready?.();
  }, catAnimator?.durationFor(rise) || 600);
}

function transitionPose(pose, onReady = () => {}) {
  if (panelMode) return;
  if (pose === 'loaf' || pose === 'nest') {
    if (state.pose === pose) return onReady();
    wakeThen(() => {
      const entering = `${pose}-enter`;
      setPose(entering);
      stanceTimer = setTimeout(() => {
        if (state.pose !== entering) return;
        setPose(pose);
        onReady();
      }, catAnimator?.durationFor(entering) || 800);
    });
    return;
  }
  if (['nap', 'sleep'].includes(pose)) {
    setPose(pose);
    onReady();
    return;
  }
  wakeThen(() => { setPose(pose); onReady(); });
}

function interruptMotion() {
  if (panelMode) return;
  automaticMotion = false;
  const wasWalking = state.walking;
  const wasJumping = state.jumping;
  const pending = motionPendingKind;
  motionPendingKind = null;
  state.walking = false;
  state.jumping = false;
  $('mainMascot').classList.remove('walk-left');
  if (wasWalking || pending === 'walk') desktop?.stopWalk();
  if (wasJumping || pending === 'jump') desktop?.stopJump();
}

function scheduleNap() {
  if (panelMode) return;
  clearTimeout(napTimer);
  napTimer = setTimeout(() => {
    if (!state.connected) return;
    if (activeTransferAnimations.size) return;
    if (state.peerOnline) {
      if (['idle', 'loaf'].includes(state.pose)) transitionPose('nest');
      return scheduleIdleAction();
    }
    setPose('nap');
  }, state.peerOnline ? 45000 : Math.max(250, offlineNapDeadline - Date.now()));
}

function schedulePeek() {
  if (panelMode) return;
  clearTimeout(peekTimer);
  if (!state.edgeHideEnabled || !state.connected || state.expanded || state.walking || state.jumping || state.peeked || state.edgeHold || state.edgeAutoOuting || catInteractionOpen()) return;
  peekTimer = setTimeout(() => {
    if (!state.edgeHideEnabled || !state.connected || state.expanded || state.walking || state.jumping || state.peeked || state.edgeHold || state.edgeAutoOuting || catInteractionOpen()) return schedulePeek();
    state.peeked = true;
    clearTimeout(state.idleTimer);
    $('window').classList.add('peeked');
    desktop?.setPeeked(true);
    schedulePeekOuting();
  }, 70000 + Math.random() * 50000);
}

function setEdgeHide(enabled) {
  state.edgeHideEnabled = Boolean(enabled);
  $('edgeHideToggle').checked = state.edgeHideEnabled;
  if (panelMode) return;
  if (state.edgeHideEnabled) return schedulePeek();
  clearTimeout(peekTimer);
  clearTimeout(peekOutingTimer);
  clearTimeout(edgeHoldTimer);
  state.edgeHold = false;
  state.edgeAutoOuting = false;
  unpeek(false);
}

function schedulePeekOuting() {
  if (panelMode) return;
  clearTimeout(peekOutingTimer);
  if (!state.edgeHideEnabled || !state.connected || state.expanded || !state.peeked || state.edgeHold || catInteractionOpen()) return;
  peekOutingTimer = setTimeout(() => {
    if (!state.edgeHideEnabled || !state.connected || state.expanded || !state.peeked || state.edgeHold || catInteractionOpen()) return;
    state.edgeAutoOuting = true;
    state.peeked = false;
    $('window').classList.remove('peeked');
    desktop?.setPeeked(false);
    const outings = desktop ? ['walk', 'sit', 'stretch', 'nap', 'happy'] : ['sit', 'stretch', 'nap', 'happy'];
    const outing = outings[Math.floor(Math.random() * outings.length)];
    if (outing === 'walk' && desktop) {
      startMotion('walk', true);
    }
    else {
      transitionPose(outing, () => setTimeout(finishPeekOuting, 2400));
    }
  }, 90000 + Math.random() * 90000);
}

function finishPeekOuting() {
  if (panelMode) return;
  if (!state.edgeAutoOuting) return;
  state.edgeAutoOuting = false;
  if (!state.edgeHideEnabled || !state.connected || state.expanded || state.edgeHold || catInteractionOpen()) return;
  state.peeked = true;
  clearTimeout(state.idleTimer);
  $('window').classList.add('peeked');
  desktop?.setPeeked(true);
  schedulePeekOuting();
}

function unpeek(userInitiated = false) {
  if (panelMode) return;
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
    beginAction(finishAction);
  }
  if (!state.peeked) {
    if (userInitiated) { scheduleIdleAction(); schedulePeek(); }
    return;
  }
  state.peeked = false;
  $('window').classList.remove('peeked');
  desktop?.setPeeked(false);
  if (userInitiated) { scheduleIdleAction(); schedulePeek(); }
  else schedulePeek();
}

function scheduleIdleAction() {
  if (panelMode) return;
  clearTimeout(state.idleTimer);
  if (!state.connected || !state.peerOnline || state.walking || state.jumping || state.peeked || !state.idleActions || catInteractionOpen()) return;
  state.idleTimer = setTimeout(() => {
    if (!state.connected || !state.peerOnline || state.walking || state.jumping || state.peeked || state.edgeAutoOuting || catInteractionOpen() || !['idle', 'loaf', 'nest'].includes(state.pose)) return scheduleIdleAction();
    const choices = state.pose === 'idle'
      ? ['blink', 'happy', 'wiggle', 'sit', 'stretch', 'loaf', 'nest']
      : ['idle', 'sit', 'stretch', state.pose === 'loaf' ? 'nest' : 'loaf'];
    if (desktop) choices.push('walk');
    const action = choices[Math.floor(Math.random() * choices.length)];
    if (action === 'blink') {
      setPose('blink');
      setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, catAnimator?.durationFor('blink') || 260);
    } else if (action === 'walk' && desktop) {
      startMotion('walk', true);
    } else if (['idle', 'loaf', 'nest'].includes(action)) {
      transitionPose(action);
    } else if (['sit', 'stretch'].includes(action)) {
      transitionPose(action, () => setTimeout(() => {
        if (state.connected && state.pose === action) finishAction();
      }, (catAnimator?.durationFor(action) || 1800) + 80));
    } else {
      animateLocalAction(action);
    }
    scheduleIdleAction();
  }, 28000 + Math.random() * 24000);
}

function startCatActivity() {
  if (panelMode) return;
  setPose('idle');
  scheduleNap();
  clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    if (!state.connected || state.walking || state.pose !== 'idle') return;
    setPose('blink');
    setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, catAnimator?.durationFor('blink') || 170);
  }, 6800);
  scheduleIdleAction();
  schedulePeek();
}

function setPeerOnline(online) {
  const presence = typeof online === 'object' ? online : { online };
  if (state.peerOnline && !presence.online) offlineNapDeadline = Date.now() + 3000;
  if (presence.online) { offlineNapDeadline = 0; clearTimeout(napTimer); }
  state.peerOnline = Boolean(presence.online);
  state.peerName = presence.peerName || state.peerName || '对方';
  if (!state.peerOnline && !panelMode) {
    for (const item of transferStates.values()) if (item.roomUrl === state.url
      && (item.phase === 'uploaded' || item.phase === 'uploading' && item.direction === 'receive')) showTransfer(item);
  }
  $('presenceText').textContent = state.peerOnline ? `${state.peerName} 在线` : `${state.peerName} 离线，小猫正在休息`;
  $('presenceDot').classList.toggle('online', state.peerOnline);
  $('presenceDot').classList.toggle('offline', !state.peerOnline);
  updateConnectionStatus();
  if (state.peerOnline) {
    if (state.pose === 'nap' || state.pose === 'sleep') transitionPose('idle');
    scheduleIdleAction();
  } else {
    clearTimeout(state.idleTimer);
    if (state.connected && !state.walking && !state.jumping) scheduleNap();
  }
}

function resetAction() {
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  return ++actionEpoch;
}

function beginAction(callback) {
  if (panelMode) return;
  interruptMotion();
  const epoch = resetAction();
  wakeThen(() => { if (epoch === actionEpoch) callback(epoch); });
}

function finishAction() {
  if (activeTransferAnimations.size) return animateDelivery(0, true);
  const target = state.peerOnline ? 'idle' : 'nap';
  if (state.pose === 'sit') {
    transitionPose('sit-rise', () => {
      poseTimer = setTimeout(() => {
        if (state.pose === 'sit-rise') transitionPose(target);
      }, catAnimator?.durationFor('sit-rise') || 700);
    });
  } else transitionPose(target);
  if (state.connected) { scheduleNap(); scheduleIdleAction(); }
}

function animateDelivery(progress = 1, hold = false) {
  if (panelMode) return;
  const pet = $('mainMascot');
  pet.style.setProperty('--delivery-progress', String(Math.max(0, Math.min(1, progress))));
  if (hold && state.pose === 'delivery-hold') return;
  beginAction(() => {
    if (hold && !activeTransferAnimations.size) return;
    setPose(hold ? 'delivery-hold' : 'delivery');
    pet.classList.add('delivery');
    if (!hold) poseTimer = setTimeout(finishAction, 2600);
  });
}

function animateReceive() {
  animateRemoteAction('receive');
}

function animateRemoteAction(kind) {
  beginAction(() => {
    if (kind === 'sleep') return transitionPose('nest');
    transitionPose(kind === 'purr' ? 'loaf' : kind, () => {
      if (kind === 'purr') setPose('purr');
      const duration = kind === 'purr' ? 3400 : (catAnimator?.durationFor(kind) || 1800) + 80;
      poseTimer = setTimeout(finishAction, duration);
    });
  });
}

function startMotion(kind, automatic = false) {
  if (panelMode) return;
  beginAction(async epoch => {
    const start = kind === 'walk' ? desktop?.startWalk : desktop?.startJump;
    motionPendingKind = kind;
    let started = false;
    try { started = await start?.(); } catch {}
    if (epoch !== actionEpoch) return;
    motionPendingKind = null;
    if (!started) state.edgeAutoOuting ? finishPeekOuting() : animateRemoteAction(kind);
  });
  automaticMotion = automatic;
}

function animateLocalAction(kind) {
  if (kind === 'walk' || kind === 'jump') return startMotion(kind);
  animateRemoteAction({ wiggle: 'wave', care: 'happy' }[kind] || kind);
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

let addressRequestId = 0;
async function refreshHostAddresses() {
  if (panelMode || state.connected || $('setup').hidden) return;
  const requestId = ++addressRequestId;
  const addresses = await desktop.addresses().catch(() => []);
  if (requestId !== addressRequestId || state.connected || $('setup').hidden) return;
  const select = $('hostAddress');
  const selected = select.value;
  select.replaceChildren();
  for (const item of addresses.length ? addresses : [{ address: '', name: '未检测到 Tailscale 地址' }]) {
    const option = document.createElement('option');
    option.value = item.address;
    option.textContent = item.address ? `${item.address} (${item.name})` : item.name;
    select.appendChild(option);
  }
  select.value = addresses.some(item => item.address === selected) ? selected : addresses[0]?.address || '';
  $('hostForm').querySelector('button[type=submit]').disabled = !select.value;
}

let scanRequestId = 0;
async function scanPeers() {
  const requestId = ++scanRequestId;
  const results = $('scanResults');
  const button = $('scanPeersButton');
  results.hidden = false;
  results.replaceChildren();
  const message = document.createElement('p');
  message.className = 'scan-message';
  message.textContent = '正在查找设备…';
  results.appendChild(message);
  button.disabled = true;
  try {
    if (!desktop?.scanPeers) throw new Error('请在桌面应用中扫描设备');
    const peers = await desktop.scanPeers();
    if (requestId !== scanRequestId) return;
    results.replaceChildren();
    if (!peers.length) {
      message.textContent = '暂未发现其他 Tailscale 设备';
      results.appendChild(message);
      return;
    }
    for (const peer of peers) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.disabled = !peer.online;
      choice.className = 'scan-choice';
      const device = document.createElement('span');
      device.className = 'scan-device';
      const name = document.createElement('strong');
      name.textContent = peer.name;
      const address = document.createElement('small');
      address.textContent = peer.address;
      device.append(name, address);
      const room = document.createElement('span');
      room.className = `scan-room${peer.room ? '' : ' muted'}`;
      room.textContent = peer.room ? '咚咚房间' : peer.online ? '设备在线' : '离线';
      choice.append(device, room);
      choice.addEventListener('click', () => {
        $('joinAddress').value = peer.address;
        results.querySelectorAll('.scan-choice').forEach(item => item.classList.remove('selected'));
        choice.classList.add('selected');
        $('joinForm').querySelector('button[type=submit]').focus();
      });
      results.appendChild(choice);
    }
  } catch (error) {
    if (requestId !== scanRequestId) return;
    message.textContent = `${error.message}，仍可手动输入地址`;
    results.replaceChildren(message);
  } finally {
    if (requestId === scanRequestId) button.disabled = false;
  }
}

function insideRect(point, element) {
  if (!point || !element) return false;
  const rect = element.getBoundingClientRect();
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function overVisibleCat(point) {
  const mascot = $('mainMascot');
  if (!insideRect(point, mascot)) return false;
  const rect = mascot.getBoundingClientRect();
  const x = (point.x - rect.left) / rect.width * 64;
  const y = (point.y - rect.top) / rect.height * 64;
  const head = y >= 3 && y < 40 && x >= (y < 18 ? 17 : 10) && x <= (y < 18 ? 49 : 54);
  const body = y >= 36 && y <= 62 && x >= 8 && x <= 56;
  const tail = y >= 30 && y <= 62 && x >= 45 && x <= 64;
  return head || body || tail;
}

function syncMousePassThrough() {
  if (!desktop?.setIgnoreMouseEvents || panelMode) return;
  const compact = state.connected && $('window').classList.contains('compact');
  const cat = compact && overVisibleCat(lastPointer);
  const speech = compact && $('speech').classList.contains('speech-message') && insideRect(lastPointer, $('speech'));
  const keyboardRevealed = compact && $('mascotButton').matches(':focus-visible');
  const actions = compact && !$('compactActions').hidden && insideRect(lastPointer, $('compactActions'))
    && (actionsHoverUntil > Date.now() || keyboardRevealed);
  clearTimeout(actionsHideTimer);
  if (!compact) actionsHoverUntil = 0;
  else if (cat || actions) actionsHoverUntil = Date.now() + ACTIONS_LINGER_MS;
  const held = compact && actionsHoverUntil > Date.now();
  if (held && !cat && !actions) {
    actionsHideTimer = setTimeout(syncMousePassThrough, actionsHoverUntil - Date.now() + 1);
  }
  $('window').classList.toggle('cat-hovered', Boolean(cat));
  $('window').classList.toggle('actions-held', held);
  let interactive = !compact || mascotDrag.pointerId !== null;
  if (compact && !interactive) {
    interactive = !$('actionTray').hidden || !$('quickMessageForm').hidden || !$('contextMenu').hidden || !$('dropOverlay').hidden;
    if (!interactive && lastPointer) {
      const mascotRect = $('mainMascot').getBoundingClientRect();
      const actionsRect = $('compactActions').getBoundingClientRect();
      // Keep the short path below the cat interactive while the toolbar lingers.
      const bridge = held && lastPointer.x >= mascotRect.left - 8 && lastPointer.x <= mascotRect.right + 8
        && lastPointer.y >= mascotRect.bottom - 8 && lastPointer.y <= actionsRect.top;
      interactive = cat || speech || actions || bridge;
    }
  }
  const nextIgnored = !interactive;
  if (nextIgnored === ignoringMouse) return;
  ignoringMouse = nextIgnored;
  desktop.setIgnoreMouseEvents(nextIgnored, { forward: true }).catch(() => { ignoringMouse = !nextIgnored; });
}

function catInteractionOpen() {
  return !$('quickMessageForm').hidden || !$('actionTray').hidden;
}

function updateIdleForInteraction() {
  if (panelMode) return;
  if (catInteractionOpen()) {
    clearTimeout(state.idleTimer);
    clearTimeout(peekTimer);
    clearTimeout(peekOutingTimer);
    if (state.peeked || state.edgeAutoOuting) unpeek(true);
    if (automaticMotion) beginAction(finishAction);
  } else {
    scheduleIdleAction();
    schedulePeek();
  }
}

function setQuickComposer(open) {
  const form = $('quickMessageForm');
  if (!form) return;
  const changed = form.hidden === open;
  if (!open && !form.hidden) actionsHoverUntil = Date.now() + ACTIONS_LINGER_MS;
  form.hidden = !open;
  $('window').classList.toggle('quick-composing', open);
  if (open) {
    setActionTray(false);
    setTimeout(() => $('quickMessageInput').focus(), 0);
  }
  if (changed) updateIdleForInteraction();
  syncMousePassThrough();
}

function clearConversation() {
  clearSpeech();
  $('events').replaceChildren();
  seenEvents.clear(); transferStates.clear(); transferRows.clear(); activeTransferAnimations.clear();
  $('quickMessageInput').value = '';
  $('messageInput').value = '';
  delete $('quickMessageForm').dataset.pendingId;
  delete $('messageForm').dataset.pendingId;
  if (!panelMode && state.pose === 'delivery-hold') transitionPose(state.peerOnline ? 'idle' : 'nap');
  updateFileControls();
}

function applyRoomIdentity(session) {
  if (!session) return;
  if (roomIdentity && roomIdentity !== session.roomId) {
    desktop?.forgetRoomTransfers?.(state.url);
    clearConversation();
  }
  roomIdentity = session.roomId;
  freshConnection = false;
}

function pendingFile() {
  return [...transferStates.values()].some(item => item.roomUrl === state.url && ['uploading', 'uploaded', 'downloading'].includes(item.phase));
}

function updateFileControls() {
  const busy = uploadStarting || pendingFile();
  for (const id of ['quickFileButton', 'fileButton']) {
    $(id).disabled = busy;
    $(id).title = busy ? '等上一份文件传完再发送' : '发送文件';
  }
}

function setActionTray(open) {
  const changed = $('actionTray').hidden === open;
  if (!open && !$('actionTray').hidden) actionsHoverUntil = Date.now() + ACTIONS_LINGER_MS;
  $('actionTray').hidden = !open;
  $('actionMenuButton').setAttribute('aria-expanded', String(open));
  if (changed) updateIdleForInteraction();
  syncMousePassThrough();
}

function setExpanded(expanded) {
  state.expanded = expanded;
  setQuickComposer(false);
  setActionTray(false);
  if (expanded && !panelMode) unpeek(true);
  $('window').classList.toggle('compact', !expanded);
  $('expanded').hidden = !expanded;
  $('compactActions').hidden = expanded;
  const resized = panelMode ? undefined : desktop?.setWindowSize(expanded);
  syncMousePassThrough();
  if (!expanded && !panelMode) schedulePeek();
  if (expanded && !panelMode) setTimeout(() => $('messageInput').focus(), 100);
  return resized;
}

function onMotionState(kind, moving) {
  const key = kind === 'walk' ? 'walking' : 'jumping';
  const other = kind === 'walk' ? 'jumping' : 'walking';
  if (panelMode || !moving && !state[key]) return;
  state[key] = moving;
  if (moving) {
    motionPendingKind = null;
    state[other] = false;
    resetAction();
    wakeThen(() => {
      if (!state[key]) return;
      setPose(kind);
      speak(kind === 'walk' ? '出门散步啦' : '跳起来啦', 'alert');
    });
  } else if (!state[other]) {
    automaticMotion = false;
    $('mainMascot').classList.remove('walk-left');
    finishAction();
    if (state.edgeAutoOuting) setTimeout(finishPeekOuting, 1800);
    else schedulePeek();
  }
}

function setView(view) {
  placePreferences();
  state.view = view;
  $('chatTab').classList.toggle('selected', view === 'chat');
  $('connectionTab').classList.toggle('selected', view === 'connection');
  $('chatTab').setAttribute('aria-selected', view === 'chat');
  $('connectionTab').setAttribute('aria-selected', view === 'connection');
  $('chatView').hidden = view !== 'chat';
  $('connectionView').hidden = view !== 'connection';
  if (panelMode && view === 'chat') for (const item of transferStates.values()) showTransfer(item);
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
  const headers = state.token ? { 'X-Pet-Session': state.token } : {};
  const response = await fetch(`${state.url}/api${route}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15000),
    headers: { ...headers, ...options.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function applyProfile(profile = {}) {
  state.profile = { petName: DEFAULT_PET_NAME, ...profile };
  $('petNameLabel').textContent = state.profile.petName || DEFAULT_PET_NAME;
  $('coupleBadge').hidden = !state.connected;
  $('profilePetName').value = state.profile.petName || '';
}

async function openSession(url, name, mode, fresh = false) {
  let response;
  try {
    response = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId, senderName: name, mode, fresh }),
      signal: AbortSignal.timeout(4000)
    });
  } catch {
    const error = new Error('房间暂时不可达');
    error.code = 'ROOM_UNREACHABLE';
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `连接失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
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

function transferLabel(item) {
  if (item.phase === 'saved') return item.direction === 'send' ? '对方已保存到下载' : '已保存到下载';
  if (item.phase === 'cancelled') return '已取消';
  if (item.phase === 'failed') {
    if (item.direction === 'send' && item.fileId) return '对方接收失败，可重新选择文件发送';
    return item.error || (item.direction === 'receive' ? '接收失败，可重试' : '发送失败，可重试');
  }
  if (item.phase === 'uploaded') return '已发送到房间';
  if (item.phase === 'waiting') return '等待接收';
  if (item.phase === 'downloading') return `${item.direction === 'send' ? '对方正在接收' : '正在保存到下载'} · ${Math.round(item.progress)}%`;
  return item.direction === 'receive' ? `正在接收 · ${Math.round(item.progress)}%` : `正在发送 · ${Math.round(item.progress)}%`;
}

function showTransfer(item) {
  if (!item?.transferId) return;
  item = { ...item, roomUrl: item.roomUrl || state.url };
  if (state.url && item.roomUrl !== state.url) return;
  const previous = transferStates.get(item.transferId);
  if (previous?.phase === 'saved' && item.phase !== 'saved') return;
  if (previous?.phase === 'uploaded' && item.phase === 'uploading') return;
  if (previous?.phase === 'downloading' && item.phase === 'uploading') return;
  if (previous?.phase === 'downloading' && item.phase === 'uploaded') return;
  if (previous?.fileId && ['failed', 'cancelled'].includes(previous.phase) && item.phase === 'uploaded') return;
  item = { ...previous, ...item };
  transferStates.set(item.transferId, item);
  updateFileControls();
  while (transferStates.size > 300) {
    const oldest = transferStates.keys().next().value;
    transferStates.delete(oldest);
    transferRows.get(oldest)?.remove(); transferRows.delete(oldest);
  }
  if (!state.url || item.roomUrl !== state.url) return;
  if (!panelMode) {
    const active = item.phase === 'downloading' || item.phase === 'uploading' && (item.direction === 'send' || state.peerOnline)
      || item.phase === 'uploaded' && state.peerOnline;
    const wasActive = activeTransferAnimations.has(item.transferId);
    if (active) {
      activeTransferAnimations.add(item.transferId);
      if (!wasActive) { unpeek(true); animateDelivery((item.progress || 0) / 100, true); }
      $('mainMascot').style.setProperty('--delivery-progress', String((item.progress || 0) / 100));
    } else {
      activeTransferAnimations.delete(item.transferId);
      if (item.phase === 'saved' && item.direction === 'receive' && item.fileId) rememberSavedFile(item.fileId);
      if (wasActive && activeTransferAnimations.size === 0) {
        if (item.phase === 'saved') animateReceive();
        else { ++actionEpoch; transitionPose(state.peerOnline ? 'idle' : 'nap'); scheduleNap(); scheduleIdleAction(); }
      }
    }
  }
  if (!panelMode || state.view !== 'chat' && panelKind !== 'chat') return;
  let row = transferRows.get(item.transferId);
  if (!row) {
    row = document.createElement('div');
    row.className = `event transfer-event ${item.direction === 'send' ? 'mine' : ''}`;
    const heading = document.createElement('div');
    heading.className = 'event-body';
    heading.textContent = item.name || '文件';
    row.appendChild(heading);
    $('events').appendChild(row);
    transferRows.set(item.transferId, row);
  }
  let status = row.querySelector('.transfer-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'transfer-status';
    const label = document.createElement('span');
    const bar = document.createElement('progress');
    bar.max = 100;
    status.append(label, bar);
    row.appendChild(status);
  }
  status.querySelector('span').textContent = transferLabel(item);
  const bar = status.querySelector('progress');
  bar.value = item.progress;
  bar.hidden = ['saved', 'failed', 'cancelled', 'uploaded', 'waiting'].includes(item.phase);
  status.querySelector('.transfer-controls')?.remove();
  const canCancel = item.canCancel && ['uploading', 'uploaded', 'downloading'].includes(item.phase);
  const canRetry = ['failed', 'cancelled'].includes(item.phase)
    && (item.direction === 'receive' ? item.canRetry || item.fileId : item.canRetry && !item.fileId);
  if (canCancel || canRetry) {
    const controls = document.createElement('div'); controls.className = 'transfer-controls';
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = canCancel ? '取消' : '重试';
    button.addEventListener('click', () => transferAction(item, canCancel ? 'cancel' : 'retry'));
    controls.appendChild(button); status.appendChild(controls);
  }
  $('events').scrollTop = $('events').scrollHeight;
}

function rememberSavedFile(fileId) {
  savedFileIds.add(fileId);
  const recent = [...savedFileIds].slice(-300);
  savedFileIds.clear();
  for (const id of recent) savedFileIds.add(id);
  localStorage.setItem(SAVED_FILES_KEY, JSON.stringify(recent));
}

async function downloadFile(event, automatic = false) {
  if (automatic && savedFileIds.has(event.fileId)) return true;
  if (activeDownloads.has(event.fileId)) return false;
  activeDownloads.add(event.fileId);
  try {
    if (desktop?.saveRemoteFile) {
      const result = await desktop.saveRemoteFile({
        url: state.url, token: state.token, fileId: event.fileId,
        fileName: event.fileName, transferId: event.transferId
      });
      if (result.phase !== 'saved') {
        if (result.phase !== 'cancelled') throw new Error(result.error || '文件下载失败');
        return false;
      }
      rememberSavedFile(event.fileId);
      if (!automatic) toast(`已保存到下载：${result.savedPath.split(/[\\/]/).pop()}`);
    } else throw new Error('请在桌面应用中接收文件');
    return true;
  } catch (error) {
    if (automatic) {
      if (state.notifications) desktop?.notify('文件接收失败', `${event.fileName}，可在消息记录里重试`);
    } else toast(error.message);
    return false;
  } finally { activeDownloads.delete(event.fileId); }
}

function receiveFile(event) {
  if (panelMode || event.senderId === senderId || !desktop?.saveRemoteFile) return;
  downloadFile(event, true);
}

function renderEvent(event) {
  const wrapper = document.createElement('div');
  wrapper.className = `event ${event.senderId === senderId ? 'mine' : ''} ${event.kind}`;
  const meta = document.createElement('div');
  meta.className = 'event-meta';
  meta.textContent = `${event.senderId === senderId ? '我' : event.senderName} · ${formatTime(event.createdAt)}`;
  wrapper.appendChild(meta);
  if (event.kind === 'file') {
    const transferId = event.transferId;
    if (panelMode) {
      const earlier = transferRows.get(transferId);
      if (earlier) earlier.remove();
      transferRows.set(transferId, wrapper);
    }
    const button = document.createElement('button');
    button.className = 'event-body file-event';
    button.title = `查看 ${event.fileName}`;
    const icon = document.createElement('img');
    icon.src = './icons/file.svg';
    icon.alt = '';
    const name = document.createElement('span');
    name.textContent = event.fileName;
    const size = document.createElement('small');
    size.textContent = formatSize(event.size);
    button.append(icon, name, size);
    button.addEventListener('click', async () => {
      if (event.senderId === senderId) {
        if (!await desktop?.revealTransfer?.({ url: state.url, transferId })) toast('本次未记录源文件位置');
        return;
      }
      if (savedFileIds.has(event.fileId)) desktop?.openDownloads();
      else downloadFile(event);
    });
    wrapper.appendChild(button);
    if (panelMode) {
      const progress = transferStates.get(transferId) || {
        transferId, name: event.fileName, direction: event.senderId === senderId ? 'send' : 'receive',
        phase: event.senderId === senderId ? 'uploaded' : savedFileIds.has(event.fileId) ? 'saved' : 'waiting',
        progress: event.senderId === senderId || savedFileIds.has(event.fileId) ? 100 : 0
      };
      showTransfer(progress);
    }
  } else {
    const body = document.createElement('div');
    body.className = 'event-body';
    const labels = { wave: '👋 向你招了招手', walk: '🐾 让你的小猫散步', jump: '✨ 让你的小猫乱蹦', pet: '🤍 摸摸小猫', fish: '🐟 投喂小鱼干', sit: '🪑 让小猫坐下', sleep: '💤 让小猫睡觉', stretch: '☀ 让小猫伸懒腰', hug: '🫂 给你一个抱抱', kiss: '💋 亲亲你', groom: '🧶 给你梳梳毛', purr: '💗 在你身边呼噜' };
    body.textContent = labels[event.kind] || event.text;
    if (event.kind === 'message') {
      body.classList.add('message-body');
      const row = document.createElement('div');
      row.className = 'message-row';
      const copyButton = document.createElement('button');
      copyButton.className = 'message-copy';
      copyButton.type = 'button';
      copyButton.title = '复制消息';
      copyButton.setAttribute('aria-label', '复制消息');
      const copyIcon = document.createElement('img');
      copyIcon.src = './icons/copy.svg';
      copyIcon.alt = '';
      copyButton.appendChild(copyIcon);
      copyButton.addEventListener('click', () => copySpeechText(event.text));
      row.append(body, copyButton);
      wrapper.appendChild(row);
    } else wrapper.appendChild(body);
  }
  $('events').appendChild(wrapper);
  while ($('events').children.length > 300) {
    const oldest = $('events').firstElementChild;
    for (const [id, row] of transferRows) if (row === oldest) transferRows.delete(id);
    oldest.remove();
  }
  $('events').scrollTop = $('events').scrollHeight;
}

function onEvent(event) {
  if (!event || typeof event.id !== 'string') return;
  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  while (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value);
  if (event.senderId !== senderId && !panelMode) unpeek(true);
  $('events').querySelector('.empty-state')?.remove();
  renderEvent(event);
  // The mascot window owns animations and notifications. A history panel only
  // mirrors the live event stream, otherwise opening it would duplicate effects.
  if (panelMode) return;
  if (event.kind === 'file') receiveFile(event);
  const actionText = { pet: '摸摸你啦', fish: '给你投喂小鱼干', walk: '让你散步啦', sit: '让你坐下啦', sleep: '让你睡觉啦', stretch: '让你伸个懒腰', jump: '让你乱蹦啦', hug: '给你一个抱抱', kiss: '亲亲你', groom: '给你梳梳毛', purr: '在你身边呼噜' };
  if (event.kind === 'wave' || actionText[event.kind]) animateLocalAction(event.kind);
  if (event.senderId !== senderId) {
    const message = event.kind === 'file' ? `收到文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 来打招呼啦` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : event.text;
    speak(message, event.kind === 'message' ? 'message' : actionText[event.kind] ? 'alert' : 'normal');
    if (event.kind === 'message') animateReceive();
    if (desktop && state.notifications) desktop.notify(state.profile.petName || DEFAULT_PET_NAME, event.kind === 'file' ? `${event.senderName} 发来文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 向你招手` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : `${event.senderName}：${event.text}`);
  }
  if (event.kind === 'message' && event.senderId === senderId) animateDelivery(1);
}

function openSocket() {
  if (!state.connected || !state.token) return;
  clearTimeout(socketConnectTimer);
  const epoch = connectionEpoch;
  const socket = new WebSocket(`${state.url.replace(/^http/, 'ws')}/ws?v=4&session=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socketConnectTimer = setTimeout(() => {
    if (state.socket === socket && socket.readyState === WebSocket.CONNECTING) socket.close();
  }, 6000);
  socket.onopen = async () => {
    if (!state.connected || epoch !== connectionEpoch || state.socket !== socket) return socket.close();
    clearTimeout(socketConnectTimer);
    reconnectAttempt = 0;
    recoveryBlocked = false;
    state.roomConnection = 'online';
    updateConnectionStatus();
    try {
      const response = await request('/events');
      const events = await response.json();
      if (!state.connected || epoch !== connectionEpoch || state.socket !== socket) return;
      for (const event of events) {
        onEvent(event);
        if (event.kind === 'file') receiveFile(event);
      }
      await loadTransferSnapshot();
    } catch { /* The socket's close handler will retry if the room went away. */ }
  };
  socket.onmessage = message => {
    if (!state.connected || state.socket !== socket) return;
    let payload;
    try { payload = JSON.parse(message.data); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'event') onEvent(payload.event);
    if (payload.type === 'presence') setPeerOnline(payload);
    if (payload.type === 'profile') applyProfile(payload.profile);
    if (payload.type === 'transfer') onTransfer(payload.transfer);
    if (payload.type === 'reset') {
      roomIdentity = payload.roomId || '';
      desktop?.forgetRoomTransfers?.(state.url);
      clearConversation();
    }
  };
  socket.onclose = () => {
    if (!state.connected || state.socket !== socket) return;
    clearTimeout(socketConnectTimer);
    state.socket = null;
    state.token = '';
    state.roomConnection = 'reconnecting';
    setPeerOnline(false);
    scheduleSessionRetry();
  };
}

function persistSession() {
  if (panelMode) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ url: state.url, name: state.name, mode: state.mode }));
}

async function ensureHostStarted(epoch) {
  if (!hostNeedsStart || !desktop || panelMode || state.mode !== 'host') return;
  const addresses = await desktop.addresses();
  if (epoch !== connectionEpoch) return;
  const previousAddress = new URL(state.url).hostname;
  const address = addresses.find(item => item.address === previousAddress)?.address || addresses[0]?.address;
  if (!address) throw new Error('Tailscale 正在等待网络');
  const result = await desktop.startHost(address, senderId);
  if (epoch !== connectionEpoch) return;
  state.hostStarted = true;
  hostNeedsStart = false;
  state.url = result.url;
  $('roomAddress').textContent = state.url;
  if (state.connected) persistSession();
}

function scheduleSessionRetry(delay) {
  clearTimeout(state.reconnectTimer);
  if (!state.connected || recoveryBlocked || retryInFlightEpoch === connectionEpoch) return;
  const epoch = connectionEpoch;
  const wait = delay ?? window.ConnectionPolicy.retryDelay(reconnectAttempt++);
  state.reconnectTimer = setTimeout(async () => {
    if (!state.connected || epoch !== connectionEpoch) return;
    retryInFlightEpoch = epoch;
    let retry = false;
    try {
      await ensureHostStarted(epoch);
      if (!state.connected || epoch !== connectionEpoch) return;
      const session = await openSession(state.url, state.name, state.mode, freshConnection);
      if (!state.connected || epoch !== connectionEpoch) return;
      state.token = session.token;
      applyRoomIdentity(session);
      if (!panelMode) desktop?.setTransferSession?.(state.url, state.token);
      state.roomConnection = 'connecting';
      state.profile = session.profile || {};
      applyProfile(state.profile);
      setPeerOnline(session.presence || false);
      openSocket();
    } catch (error) {
      if (state.connected && epoch === connectionEpoch) {
        retry = window.ConnectionPolicy.shouldRetry(error);
        recoveryBlocked = !retry;
        if (!retry) toast(error.message);
      }
    } finally {
      if (retryInFlightEpoch === epoch) retryInFlightEpoch = null;
      if (retry && state.connected && epoch === connectionEpoch) scheduleSessionRetry();
    }
  }, wait);
}

function recoverConnection(force = false) {
  if (!state.connected || recoveryBlocked || retryInFlightEpoch === connectionEpoch) return;
  if (!force && state.socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(socketConnectTimer);
  const socket = state.socket;
  state.socket = null;
  socket?.close();
  state.token = '';
  state.roomConnection = 'reconnecting';
  setPeerOnline(false);
  scheduleSessionRetry(0);
}

async function connect(url, name, mode, { restoreHost = false } = {}) {
  const normalized = normalizeAddress(url);
  const oldUrl = state.url || JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')?.url;
  const epoch = ++connectionEpoch;
  clearTimeout(state.reconnectTimer);
  clearTimeout(socketConnectTimer);
  const previousSocket = state.socket;
  state.socket = null;
  previousSocket?.close();
  reconnectAttempt = 0;
  recoveryBlocked = false;
  offlineNapDeadline = 0;
  hostNeedsStart = restoreHost && !panelMode;
  state.url = normalized;
  freshConnection = oldUrl !== normalized && !panelMode;
  if (oldUrl !== normalized) {
    if (oldUrl) desktop?.forgetRoomTransfers?.(oldUrl);
    clearConversation();
    roomIdentity = '';
  }
  state.name = name.trim().slice(0, 24);
  state.mode = mode;
  let session = null;
  try {
    await ensureHostStarted(epoch);
    if (epoch !== connectionEpoch) return;
    session = await openSession(state.url, state.name, mode, freshConnection);
  } catch (error) { if (!window.ConnectionPolicy.shouldRetry(error)) throw error; }
  if (epoch !== connectionEpoch) return;
  state.token = session?.token || '';
  applyRoomIdentity(session);
  if (!panelMode && state.token) desktop?.setTransferSession?.(state.url, state.token);
  state.profile = session?.profile || {};
  let events = [];
  if (session) {
    try { events = await (await request('/events')).json(); }
    catch { /* A room may close just after the session opens. */ }
  }
  if (epoch !== connectionEpoch) return;
  state.connected = true;
  state.roomConnection = session ? 'connecting' : 'reconnecting';
  $('setup').hidden = true;
  $('companion').hidden = false;
  $('settingsButton').hidden = true;
  $('roomAddress').textContent = state.url;
  $('events').replaceChildren();
  transferRows.clear();
  seenEvents.clear();
  const visibleEvents = events;
  if (visibleEvents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '这里还没有消息';
    $('events').appendChild(empty);
  } else {
    visibleEvents.forEach(event => { seenEvents.add(event.id); renderEvent(event); });
    clearSpeech();
  }
  if (panelKind === 'chat') for (const transfer of transferStates.values()) showTransfer(transfer);
  applyProfile(state.profile);
  setPeerOnline(session?.presence || false);
  if (!panelMode) for (const event of visibleEvents) if (event.kind === 'file') receiveFile(event);
  if (panelMode) {
    state.expanded = true;
    $('window').classList.remove('compact');
    $('expanded').hidden = false;
    $('compactActions').hidden = true;
    setView(panelKind === 'settings' ? 'connection' : 'chat');
  } else {
    setView('chat');
    setExpanded(false);
  }
  updateConnectionStatus();
  startCatActivity();
  if (session) openSocket();
  else scheduleSessionRetry();
  persistSession();
}

async function disconnect() {
  ++connectionEpoch;
  state.connected = false;
  clearSpeech();
  const roomUrl = state.url;
  // Capture credentials before clearing them. Leaving an unavailable room must
  // never hold the desktop UI open while a network request times out.
  if (state.token) request('/leave', { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
  cancelRoomTransfers(roomUrl);
  state.roomConnection = 'closed';
  if (!panelMode && state.walking) desktop?.stopWalk();
  if (!panelMode && state.jumping) desktop?.stopJump();
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
  setActionTray(false);
  clearTimeout(state.reconnectTimer);
  clearTimeout(socketConnectTimer);
  const socket = state.socket;
  state.socket = null;
  socket?.close();
  state.token = '';
  if ((state.hostStarted || hostNeedsStart) && desktop && !panelMode) desktop.stopHost().catch(() => {});
  state.hostStarted = false;
  hostNeedsStart = false;
  recoveryBlocked = false;
  offlineNapDeadline = 0;
  localStorage.removeItem(SESSION_KEY);
  $('companion').hidden = true;
  $('setup').hidden = false;
  $('appSettings').hidden = true;
  $('window').classList.remove('compact');
  $('settingsButton').hidden = false;
  state.peerOnline = false;
  updateConnectionStatus();
  if (desktop && !panelMode) desktop.setWindowSize(true);
  if (panelMode) desktop?.closePanel();
}

async function sendEvent(kind, text = '', { clientId = crypto.randomUUID() } = {}) {
  try {
    const response = await request('/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, text, clientId })
    });
    if (kind === 'wave') {
      speak('招手送出去了');
    } else if (kind === 'walk') speak('已经让对方散步啦', 'alert');
    else if (kind === 'jump') speak('已经让对方乱蹦啦', 'alert');
    else if (['pet', 'fish', 'sit', 'sleep', 'stretch', 'hug', 'kiss', 'groom', 'purr'].includes(kind)) speak('动作送到对方那里啦', 'alert');
    return await response.json();
  } catch (error) { toast(error.message); return null; }
}

async function sendMessage(text, clientId) {
  animateDelivery(0);
  const sent = await sendEvent('message', text, { clientId });
  if (!sent) return false;
  $('mainMascot').style.setProperty('--delivery-progress', '1');
  speak('信已寄出', 'alert');
  return true;
}

async function submitMessage(form, input) {
  if (form.dataset.sending === 'true') return;
  const text = input.value.trim();
  if (!text) return;
  if (!state.connected) return toast('还没有连接房间');
  form.dataset.sending = 'true';
  const clientId = form.dataset.pendingId || crypto.randomUUID();
  form.dataset.pendingId = clientId;
  const sendButton = form.querySelector('.send-button');
  sendButton.disabled = true;
  input.disabled = true;
  try {
    if (await sendMessage(text, clientId)) {
      input.value = '';
      delete form.dataset.pendingId;
    }
  } finally {
    form.dataset.sending = 'false';
    sendButton.disabled = false;
    input.disabled = false;
    if (!form.hidden) input.focus();
  }
}

async function sendFile(file) {
  if (!file) return;
  if (uploadStarting || pendingFile()) return toast('上一份文件还没有传完');
  if (file.size > 100 * 1024 * 1024) return toast('文件不能超过 100 MB');
  if (!state.connected || !state.token) return toast('房间恢复连接后再发送文件');
  if (!desktop?.uploadFile) return toast('请在桌面应用中发送文件');
  uploadStarting = true; updateFileControls();
  try {
    const transfer = await desktop.uploadFile(file, { url: state.url, token: state.token,
      transferId: crypto.randomUUID() });
    showTransfer(transfer);
  } catch (error) { toast(error.message); }
  finally { uploadStarting = false; $('fileInput').value = ''; updateFileControls(); }
}

function cancelRoomTransfers(url) {
  activeTransferAnimations.clear();
  if (url) desktop?.forgetRoomTransfers?.(url);
  updateFileControls();
}

async function transferAction(item, action) {
  try {
    const details = { url: state.url, token: state.token, transferId: item.transferId };
    if (action === 'cancel') await desktop.cancelTransfer(details);
    else if (item.canRetry) showTransfer(await desktop.retryTransfer(details));
    else if (item.fileId && item.direction === 'receive') await downloadFile({ fileId: item.fileId, fileName: item.name, transferId: item.transferId, id: item.transferId });
  } catch (error) { toast(error.message); }
}

async function loadTransferSnapshot() {
  const url = state.url;
  const response = await request('/transfers');
  const items = await response.json();
  if (!state.connected || state.url !== url) return;
  for (const item of items) onTransfer(item);
}

function onTransfer(item) {
  if (!item || typeof item.transferId !== 'string') return;
  if (item.senderId !== senderId && item.fileId && savedFileIds.has(item.fileId)) {
    if (item.phase !== 'saved' && !panelMode) request('/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId: item.transferId, fileId: item.fileId, phase: 'saved', progress: 100 }) }).catch(() => {});
    item = { ...item, phase: 'saved', progress: 100 };
  }
  showTransfer({ ...item, roomUrl: state.url, direction: item.senderId === senderId ? 'send' : 'receive' });
  if (!panelMode) desktop?.updateTransfer?.(state.url, item);
}

async function copy(value) {
  await desktop.copy(value);
  toast('已复制');
}

async function init() {
  const recover = force => { recoverConnection(force); refreshHostAddresses(); };
  window.addEventListener('online', () => recover(true));
  window.addEventListener('focus', () => recover());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recover(); });
  desktop?.onResume?.(() => recover(true));
  if (desktop?.onTransferProgress) {
    desktop.onTransferProgress(showTransfer);
    desktop.transferSnapshot().then(items => items.forEach(showTransfer)).catch(() => {});
  }
  document.addEventListener('mousemove', event => {
    lastPointer = { x: event.clientX, y: event.clientY };
    syncMousePassThrough();
  });
  document.addEventListener('mouseleave', () => { lastPointer = null; syncMousePassThrough(); });
  document.addEventListener('focusin', syncMousePassThrough);
  document.addEventListener('focusout', syncMousePassThrough);
  $('speech').addEventListener('mouseenter', () => {
    if ($('speech').classList.contains('speech-message')) clearTimeout(speak.timer);
  });
  $('speech').addEventListener('mouseleave', scheduleSpeechDismiss);
  $('speech').addEventListener('click', openSpeechHistory);
  $('speech').addEventListener('dblclick', copySpeechMessage);
  $('speech').addEventListener('wheel', event => {
    if ($('speech').scrollHeight <= $('speech').clientHeight) return;
    event.preventDefault();
    scrollSpeech(event.deltaY);
  }, { passive: false });
  if (panelMode && panelKind === 'settings' && !localStorage.getItem(SESSION_KEY)) {
    $('setup').hidden = true;
    $('appSettings').hidden = false;
  }
  $('hostTab').addEventListener('click', () => { setMode('host'); refreshHostAddresses(); });
  $('joinTab').addEventListener('click', () => { setMode('join'); scanPeers(); });
  $('scanPeersButton').addEventListener('click', scanPeers);
  $('joinAddress').addEventListener('input', () => $('scanResults').querySelectorAll('.scan-choice').forEach(item => item.classList.remove('selected')));
  $('closeButton').addEventListener('click', () => panelMode ? desktop.closePanel() : desktop.close());
  $('settingsButton').addEventListener('click', () => desktop.openPanel('settings'));
  $('idleActionsToggle').checked = state.idleActions;
  $('edgeHideToggle').checked = state.edgeHideEnabled;
  $('desktopNotificationsToggle').checked = state.notifications;
  $('idleActionsToggle').addEventListener('change', event => {
    state.idleActions = event.target.checked;
    localStorage.setItem('dongdong-idle-actions', JSON.stringify(state.idleActions));
    if (state.idleActions) scheduleIdleAction(); else clearTimeout(state.idleTimer);
  });
  $('edgeHideToggle').addEventListener('change', event => {
    setEdgeHide(event.target.checked);
    localStorage.setItem('dongdong-edge-hide', JSON.stringify(state.edgeHideEnabled));
  });
  window.addEventListener('storage', event => {
    if (event.key === 'dongdong-edge-hide') setEdgeHide(event.newValue === 'true');
    if (event.key === 'dongdong-idle-actions') {
      state.idleActions = event.newValue === 'true';
      $('idleActionsToggle').checked = state.idleActions;
      if (state.idleActions) scheduleIdleAction(); else clearTimeout(state.idleTimer);
    }
    if (event.key === 'dongdong-notifications') {
      state.notifications = event.newValue === 'true';
      $('desktopNotificationsToggle').checked = state.notifications;
    }
    if (event.key === 'dongdong-auto-launch') setAutoLaunchToggles(event.newValue === 'true');
    if (event.key === SAVED_FILES_KEY) {
      savedFileIds.clear();
      for (const fileId of JSON.parse(event.newValue || '[]')) savedFileIds.add(fileId);
    }
    if (event.key === SESSION_KEY && !event.newValue) disconnect();
    if (event.key === SESSION_KEY && event.newValue && panelMode) {
      const saved = JSON.parse(event.newValue);
      if (saved.url !== state.url) {
        connect(saved.url, saved.name, saved.mode).catch(error => toast(error.message));
      }
    }
  });
  $('desktopNotificationsToggle').addEventListener('change', event => {
    state.notifications = event.target.checked;
    localStorage.setItem('dongdong-notifications', JSON.stringify(state.notifications));
  });
  $('mascotButton').addEventListener('click', () => {
    if (mascotDrag.suppressClick) { mascotDrag.suppressClick = false; return; }
    triggerAction('pet');
  });
  const finishMascotDrag = event => {
    const pointerId = mascotDrag.pointerId;
    if (pointerId === null || (event?.pointerId != null && pointerId !== event.pointerId)) return;
    mascotDrag.pointerId = null;
    // A real pointer-up must suppress the synthetic click after a drag. Focus
    // loss/cancellation has no click to suppress and should fully reset state.
    mascotDrag.suppressClick = event?.type === 'pointerup' || event?.type === 'pointermove'
      ? mascotDrag.moved : false;
    try { $('mascotButton').releasePointerCapture?.(pointerId); } catch { /* Capture may already be gone. */ }
    syncMousePassThrough();
  };
  $('mascotButton').addEventListener('pointerdown', event => {
    if (event.button !== 0 || !desktop?.moveWindow || mascotDrag.pointerId !== null) return;
    mascotDrag.pointerId = event.pointerId;
    mascotDrag.startX = event.screenX;
    mascotDrag.startY = event.screenY;
    mascotDrag.lastX = event.screenX;
    mascotDrag.lastY = event.screenY;
    mascotDrag.moved = false;
    mascotDrag.suppressClick = false;
    $('mascotButton').setPointerCapture?.(event.pointerId);
    syncMousePassThrough();
  });
  $('mascotButton').addEventListener('pointermove', event => {
    if (mascotDrag.pointerId !== event.pointerId) return;
    // A lost pointer-up can otherwise leave the renderer moving the window on
    // every subsequent move. Browsers report buttons=0 once the press ended.
    if (event.buttons === 0) return finishMascotDrag(event);
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
  $('mascotButton').addEventListener('pointerup', finishMascotDrag);
  $('mascotButton').addEventListener('pointercancel', finishMascotDrag);
  $('mascotButton').addEventListener('lostpointercapture', finishMascotDrag);
  // Pointer capture is normally enough, but native window moves and app focus
  // changes can bypass the element. Keep a global release path as a guard.
  window.addEventListener('pointerup', finishMascotDrag, true);
  window.addEventListener('pointercancel', finishMascotDrag, true);
  window.addEventListener('blur', () => finishMascotDrag());
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishMascotDrag(); });
  $('mascotButton').addEventListener('contextmenu', event => {
    if (!state.connected) return;
    event.preventDefault();
    const menu = $('contextMenu');
    const main = document.querySelector('.companion-main');
    menu.style.left = `${Math.max(6, Math.min(event.offsetX, main.clientWidth - 132))}px`;
    menu.style.top = `${Math.max(6, event.offsetY - 8)}px`;
    menu.hidden = false;
    syncMousePassThrough();
  });
  $('contextHistory').addEventListener('click', () => { $('contextMenu').hidden = true; syncMousePassThrough(); desktop?.openPanel?.('chat'); });
  $('contextSettings').addEventListener('click', () => {
    $('contextMenu').hidden = true;
    syncMousePassThrough();
    desktop.openPanel('settings');
  });
  $('mascotButton').addEventListener('mouseenter', unpeek);
  $('mascotButton').addEventListener('focus', unpeek);
  document.addEventListener('click', event => {
    if (!event.target.closest('#contextMenu')) { $('contextMenu').hidden = true; syncMousePassThrough(); }
    if (!event.target.closest('#actionTray, #actionMenuButton')) setActionTray(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('actionTray').hidden) { setActionTray(false); $('actionMenuButton').focus(); }
    $('contextMenu').hidden = true;
    syncMousePassThrough();
  });
  $('waveButton').addEventListener('click', () => triggerAction('wave'));
  $('careButton').addEventListener('click', () => triggerAction('care'));
  $('actionMenuButton').addEventListener('click', () => setActionTray($('actionTray').hidden));
  $('actionTrayClose').addEventListener('click', () => setActionTray(false));
  document.querySelectorAll('.action-choice').forEach(button => button.addEventListener('click', () => {
    if (!button.dataset.action) return;
    setActionTray(false);
    triggerAction(button.dataset.action);
  }));
  if (!panelMode && desktop) desktop.onWalkState(walking => onMotionState('walk', walking));
  if (!panelMode && desktop?.onWalkDirection) desktop.onWalkDirection(direction => {
    $('mainMascot').classList.toggle('walk-left', direction < 0);
  });
  if (!panelMode && desktop?.onJumpState) desktop.onJumpState(jumping => onMotionState('jump', jumping));
  if (!panelMode && desktop?.onPeekState) desktop.onPeekState(peeked => {
    state.peeked = Boolean(peeked);
    $('window').classList.toggle('peeked', state.peeked);
  });
  desktop.onMenuAction(action => { if (action === 'show') setExpanded(!state.connected); });
  $('openButton').addEventListener('click', () => {
    // Keep the live message flow beside the cat. The full conversation is a
    // separate panel, so this action never resizes or hides the mascot.
    if (!state.connected) return toast('还没有连接房间');
    setQuickComposer($('quickMessageForm').hidden);
  });
  $('quickMessageClose').addEventListener('click', () => setQuickComposer(false));
  $('quickMessageForm').addEventListener('submit', event => {
    event.preventDefault();
    submitMessage(event.currentTarget, $('quickMessageInput'));
  });
  $('quickMessageInput').addEventListener('keydown', event => {
    if (event.key === 'Escape') setQuickComposer(false);
  });
  $('quickMessageInput').addEventListener('input', () => { delete $('quickMessageForm').dataset.pendingId; });
  $('messageInput').addEventListener('input', () => { delete $('messageForm').dataset.pendingId; });
  $('chatTab').addEventListener('click', () => setView('chat'));
  $('connectionTab').addEventListener('click', () => setView('connection'));
  $('disconnectButton').addEventListener('click', disconnect);
  $('openDownloadsButton').addEventListener('click', () => desktop?.openDownloads());
  $('copyAddress').addEventListener('click', () => copy(state.url));
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
    submitMessage(event.currentTarget, $('messageInput'));
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', event => { event.preventDefault(); if (state.connected) { dragDepth++; $('dropOverlay').hidden = false; } });
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
    if (state.connected) sendFile(event.dataTransfer.files[0]);
  });

  await refreshHostAddresses();

  $('hostForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('setupFeedback').textContent = '';
    try {
      const result = await desktop.startHost($('hostAddress').value, senderId);
      state.hostStarted = true;
      await connect(result.url, $('hostName').value, 'host');
    } catch (error) { $('setupFeedback').textContent = error.message; }
  });
  $('joinForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('setupFeedback').textContent = '';
    try { await connect($('joinAddress').value, $('joinName').value, 'join'); }
    catch (error) { $('setupFeedback').textContent = error.message; }
  });

  setAutoLaunchToggles(await desktop.getAutoLaunch());
  const updateAutoLaunch = async event => {
    try {
      const value = await desktop.setAutoLaunch(event.target.checked);
      setAutoLaunchToggles(value);
      localStorage.setItem('dongdong-auto-launch', JSON.stringify(value));
      toast(event.target.checked ? '已开启开机自启动' : '已关闭开机自启动');
    } catch (error) {
      setAutoLaunchToggles(!event.target.checked);
      toast(error.message);
    }
  };
  $('autoLaunchSetup').addEventListener('change', updateAutoLaunch);

  const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  if (new URLSearchParams(location.search).has('preview')) {
    await connect('127.0.0.1:4827', '我', 'host');
  } else if (saved) {
    $('hostName').value = saved.name;
    $('joinName').value = saved.name;
    $('joinAddress').value = saved.url;
    setMode(saved.mode);
    try {
      await connect(saved.url, saved.name, saved.mode, { restoreHost: saved.mode === 'host' && Boolean(desktop) && !panelMode });
    } catch (error) { $('setupFeedback').textContent = error.message; }
  }
}

init().catch(error => { $('setupFeedback').textContent = error.message; });

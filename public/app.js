const $ = id => document.getElementById(id);
const desktop = window.petDesktop;
const panelKind = desktop?.panelKind || '';
const panelMode = panelKind === 'chat' || panelKind === 'settings';
const catAnimator = !panelMode && window.PixelCatAnimator ? new window.PixelCatAnimator($('mainMascot')) : null;
const DEFAULT_PET_NAME = '小橘';
const SESSION_KEY = 'dongdong-session-v3';
const SAVED_FILES_KEY = 'dongdong-saved-files-v3';
const senderId = localStorage.getItem('dongdong-sender-id-v3') || crypto.randomUUID();
localStorage.setItem('dongdong-sender-id-v3', senderId);

const state = {
  mode: 'host', url: '', key: '', token: '', name: '', socket: null,
  connected: false, roomConnection: 'closed', expanded: false, pinned: true, view: 'chat', peerOnline: false,
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
let walkFrameTimer;
let walkFallbackTimer;
let wakeTimer;
let wakeCallback;
let stanceTimer;
let voiceTimer;
let actionEpoch = 0;
let motionPendingKind = null;
let peekTimer;
let peekOutingTimer;
let edgeHoldTimer;
let deliveryFinishTimer;
let connectionEpoch = 0;
const pendingDeliveries = new Map();
const activeDownloads = new Set();
const savedFileIds = new Set(JSON.parse(localStorage.getItem(SAVED_FILES_KEY) || '[]'));
const transferStates = new Map();
const transferRows = new Map();
let ignoringMouse = false;
let lastPointer = null;
const ACTIONS_LINGER_MS = 2000;
let actionsHoverUntil = 0;
let actionsHideTimer;
const mascotDrag = { pointerId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, suppressClick: false };

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

const ACTION_VOICES = {
  wave: ['喵～', '喵呜！'], happy: ['喵！', '咪呀！'], jump: ['喵呜！', '咪！'],
  walk: ['喵～', '咪呜～'], pet: ['呼噜～', '咪～'], fish: ['喵！', '咪呀～'],
  stretch: ['喵嗷～', '哈啊～'], groom: ['咪～', '喵～'], hug: ['咪呜～', '喵～'],
  kiss: ['啾～', '咪！'], purr: ['呼噜噜～', '咕噜咕噜～']
};
function actionVoice(pose) {
  const bubble = $('voiceBubble');
  clearTimeout(voiceTimer);
  const options = ACTION_VOICES[pose];
  if (!options) { bubble.hidden = true; return; }
  bubble.textContent = options[Math.floor(Math.random() * options.length)];
  bubble.hidden = false;
  voiceTimer = setTimeout(() => { bubble.hidden = true; }, pose === 'purr' ? 5000 : 1350);
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

function updateConnectionStatus() {
  if (!state.connected) return setStatus('待连接');
  if (state.roomConnection !== 'online') return setStatus('对方离线', 'offline');
  setStatus(state.peerOnline ? '已连接' : '对方离线', state.peerOnline ? 'online' : 'offline');
}

function setPose(pose) {
  const previous = state.pose.startsWith('walk-') ? 'walk' : state.pose;
  const next = pose.startsWith('walk-') ? 'walk' : pose;
  clearTimeout(wakeTimer);
  clearTimeout(stanceTimer);
  wakeTimer = null;
  wakeCallback = null;
  state.pose = pose;
  const pet = $('mainMascot');
  pet.classList.remove('wiggle', 'happy', 'jump', 'nap', 'pet', 'fish', 'sit', 'sleep', 'stretch', 'delivery', 'receive', 'speech-pop', 'hug', 'kiss', 'groom', 'purr', 'waking');
  // Keep the sprite visible even when a logical action has no dedicated art.
  // A missing background image makes the transparent mascot look like it
  // vanished mid-action, which is especially jarring for remote gestures.
  const sprite = {
    idle: 'mascot', nap: 'mascot-nap', sleep: 'mascot-nap',
    blink: 'mascot-blink', wave: 'mascot-wave', happy: 'mascot-happy', jump: 'mascot-jump',
    pet: 'mascot-pet', fish: 'mascot-fish', sit: 'mascot-sit', stretch: 'mascot-stretch',
    hug: 'mascot-hug', kiss: 'mascot-kiss', groom: 'mascot-groom', purr: 'mascot-purr',
    'walk-1': 'mascot-walk-1', 'walk-2': 'mascot-walk-2'
  }[pose] || 'mascot';
  pet.style.backgroundImage = `url('./${sprite}.svg')`;
  catAnimator?.play(pose);
  if (previous !== next) actionVoice(next);
  if (pose === 'wave') pet.classList.add('wiggle');
  if (pose === 'happy') pet.classList.add('happy');
  if (pose === 'nap' || pose === 'sleep') pet.classList.add('nap', 'sleep');
  if (['pet', 'fish', 'sit', 'sleep', 'stretch', 'hug', 'kiss', 'groom', 'purr'].includes(pose)) pet.classList.add(pose);
}

function wakeThen(callback) {
  const pet = $('mainMascot');
  const resting = state.pose;
  if (!['nap', 'sleep', 'nest', 'nest-enter', 'loaf', 'loaf-enter', 'purr'].includes(resting)) return callback();
  wakeCallback = callback;
  if (wakeTimer) return;
  pet.classList.remove('waking');
  void pet.offsetWidth;
  pet.classList.add('waking');
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
  const wasWalking = state.walking;
  const wasJumping = state.jumping;
  const pending = motionPendingKind;
  motionPendingKind = null;
  state.walking = false;
  state.jumping = false;
  clearInterval(walkFrameTimer);
  clearTimeout(walkFallbackTimer);
  if (wasWalking || pending === 'walk') desktop?.stopWalk();
  if (wasJumping || pending === 'jump') desktop?.stopJump();
}

function scheduleNap() {
  clearTimeout(napTimer);
  napTimer = setTimeout(() => {
    if (!state.connected) return;
    if (state.peerOnline) {
      if (['idle', 'loaf'].includes(state.pose)) transitionPose('nest');
      return scheduleIdleAction();
    }
    setPose('nap');
  }, state.peerOnline ? 45000 : 250);
}

function schedulePeek() {
  clearTimeout(peekTimer);
  if (!state.edgeHideEnabled || !state.connected || state.expanded || state.walking || state.jumping || state.peeked || state.edgeHold || state.edgeAutoOuting) return;
  peekTimer = setTimeout(() => {
    if (!state.edgeHideEnabled || !state.connected || state.expanded || state.walking || state.jumping || state.peeked || state.edgeHold || state.edgeAutoOuting) return schedulePeek();
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
  if (state.edgeHideEnabled) return schedulePeek();
  clearTimeout(peekTimer);
  clearTimeout(peekOutingTimer);
  clearTimeout(edgeHoldTimer);
  state.edgeHold = false;
  state.edgeAutoOuting = false;
  unpeek(false);
}

function schedulePeekOuting() {
  clearTimeout(peekOutingTimer);
  if (!state.edgeHideEnabled || !state.connected || state.expanded || !state.peeked || state.edgeHold) return;
  peekOutingTimer = setTimeout(() => {
    if (!state.edgeHideEnabled || !state.connected || state.expanded || !state.peeked || state.edgeHold) return;
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
  if (!state.edgeHideEnabled || !state.connected || state.expanded || state.edgeHold) return;
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
  if (!state.connected || !state.peerOnline || state.walking || state.jumping || state.peeked || !state.idleActions) return;
  state.idleTimer = setTimeout(() => {
    if (!state.connected || !state.peerOnline || state.walking || state.jumping || state.peeked || state.edgeAutoOuting || !['idle', 'loaf', 'nest'].includes(state.pose)) return scheduleIdleAction();
    const choices = state.pose === 'idle'
      ? ['blink', 'happy', 'wiggle', 'sit', 'stretch', 'loaf', 'nest']
      : ['idle', 'sit', 'stretch', state.pose === 'loaf' ? 'nest' : 'loaf'];
    if (desktop) choices.push('walk');
    const action = choices[Math.floor(Math.random() * choices.length)];
    if (action === 'blink') {
      setPose('blink');
      setTimeout(() => { if (state.connected && state.pose === 'blink') setPose('idle'); }, catAnimator?.durationFor('blink') || 260);
    } else if (action === 'walk' && desktop) {
      startMotion('walk');
    } else if (['idle', 'loaf', 'nest'].includes(action)) {
      transitionPose(action);
    } else if (['sit', 'stretch'].includes(action)) {
      transitionPose(action, () => setTimeout(() => {
        if (state.connected && state.pose === action) transitionPose('idle');
      }, (catAnimator?.durationFor(action) || 1800) + 80));
    } else {
      animatePet(action);
    }
    scheduleIdleAction();
  }, 28000 + Math.random() * 24000);
}

function setPeerOnline(online) {
  const presence = typeof online === 'object' ? online : { online };
  state.peerOnline = Boolean(presence.online);
  state.peerName = presence.peerName || state.peerName || '对方';
  desktop?.setOnline(state.peerOnline);
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

function animatePet(kind = 'happy') {
  interruptMotion();
  const epoch = ++actionEpoch;
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  const target = kind === 'wiggle' ? 'wave' : 'happy';
  transitionPose(target, () => {
    if (epoch !== actionEpoch) return;
    poseTimer = setTimeout(() => transitionPose(state.peerOnline ? 'idle' : 'nap'), (catAnimator?.durationFor(target) || 1500) + 80);
  });
  if (state.peerOnline) scheduleNap();
}

function animateDelivery(progress = 1) {
  interruptMotion();
  const epoch = ++actionEpoch;
  clearTimeout(poseTimer);
  clearTimeout(deliveryFinishTimer);
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  wakeThen(() => {
    if (epoch !== actionEpoch) return;
    const pet = $('mainMascot');
    const continuing = pet.classList.contains('delivery') && catAnimator?.action === 'delivery';
    if (!continuing) {
      setPose('idle');
      pet.classList.remove('delivery');
      void pet.offsetWidth;
      pet.classList.add('delivery');
      catAnimator?.play('delivery');
    }
    pet.style.setProperty('--delivery-progress', String(Math.max(0, Math.min(1, progress))));
    deliveryFinishTimer = setTimeout(() => { if (epoch === actionEpoch) { pet.classList.remove('delivery'); transitionPose(state.peerOnline ? 'idle' : 'nap'); } }, 2600);
  });
}

function animateReceive() {
  interruptMotion();
  const epoch = ++actionEpoch;
  clearTimeout(poseTimer);
  clearTimeout(deliveryFinishTimer);
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  wakeThen(() => {
    if (epoch !== actionEpoch) return;
    const pet = $('mainMascot');
    setPose('idle');
    pet.classList.remove('receive');
    void pet.offsetWidth;
    pet.classList.add('receive');
    catAnimator?.play('receive');
    poseTimer = setTimeout(() => { if (epoch === actionEpoch) { pet.classList.remove('receive'); transitionPose(state.peerOnline ? 'idle' : 'nap'); } }, (catAnimator?.durationFor('receive') || 1600) + 80);
  });
}

function animateRemoteAction(kind) {
  interruptMotion();
  const epoch = ++actionEpoch;
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  if (kind === 'sleep') {
    transitionPose('nest');
    return;
  }
  if (kind === 'purr') {
    transitionPose('loaf', () => {
      if (epoch !== actionEpoch) return;
      setPose('purr');
      poseTimer = setTimeout(() => {
        if (epoch === actionEpoch) transitionPose(state.peerOnline ? 'idle' : 'nap');
      }, 3400);
    });
    return;
  }
  transitionPose(kind, () => {
    if (epoch !== actionEpoch) return;
    poseTimer = setTimeout(() => {
      if (epoch === actionEpoch) transitionPose(state.peerOnline ? 'idle' : 'nap');
    }, (catAnimator?.durationFor(kind) || 1800) + 80);
  });
}

function animateWalkFallback() {
  onWalkState(true);
  clearTimeout(walkFallbackTimer);
  walkFallbackTimer = setTimeout(() => { if (state.walking) onWalkState(false); }, 1600);
}

function startMotion(kind) {
  interruptMotion();
  const epoch = ++actionEpoch;
  clearTimeout(poseTimer);
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  clearTimeout(deliveryFinishTimer);
  wakeThen(() => {
    if (epoch !== actionEpoch) return;
    const start = kind === 'walk' ? desktop?.startWalk : desktop?.startJump;
    if (!start) {
      if (kind === 'walk') animateWalkFallback();
      else animateRemoteAction('jump');
      return;
    }
    motionPendingKind = kind;
    Promise.resolve(start()).then(started => {
      if (epoch !== actionEpoch) return;
      motionPendingKind = null;
      if (started) return;
      if (kind === 'walk') animateWalkFallback();
      else animateRemoteAction('jump');
    }).catch(() => {
      if (epoch !== actionEpoch) return;
      motionPendingKind = null;
      if (kind === 'walk') animateWalkFallback();
      else animateRemoteAction('jump');
    });
  });
}

function animateLocalAction(kind) {
  clearTimeout(napTimer);
  clearTimeout(state.idleTimer);
  clearTimeout(poseTimer);
  if (kind === 'walk') {
    startMotion('walk');
    return;
  }
  if (kind === 'jump') {
    startMotion('jump');
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
        $('joinKey').focus();
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
      interactive = cat || actions || bridge;
    }
  }
  const nextIgnored = !interactive;
  if (nextIgnored === ignoringMouse) return;
  ignoringMouse = nextIgnored;
  desktop.setIgnoreMouseEvents(nextIgnored, { forward: true }).catch(() => { ignoringMouse = !nextIgnored; });
}

function setQuickComposer(open) {
  const form = $('quickMessageForm');
  if (!form) return;
  if (!open && !form.hidden) actionsHoverUntil = Date.now() + ACTIONS_LINGER_MS;
  form.hidden = !open;
  $('window').classList.toggle('quick-composing', open);
  if (open) {
    setActionTray(false);
    setTimeout(() => $('quickMessageInput').focus(), 0);
  } else {
    $('quickMessageInput').value = '';
  }
  syncMousePassThrough();
}

function setActionTray(open) {
  if (!open && !$('actionTray').hidden) actionsHoverUntil = Date.now() + ACTIONS_LINGER_MS;
  $('actionTray').hidden = !open;
  $('actionMenuButton').setAttribute('aria-expanded', String(open));
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

function onWalkState(walking) {
  if (!walking && !state.walking) return;
  state.walking = walking;
  clearInterval(walkFrameTimer);
  if (!walking) $('mainMascot').classList.remove('walk-left', 'walk-right');
  if (walking) {
    motionPendingKind = null;
    ++actionEpoch;
    state.jumping = false;
    clearTimeout(poseTimer);
    clearTimeout(napTimer);
    clearTimeout(state.idleTimer);
    clearTimeout(deliveryFinishTimer);
    wakeThen(() => {
      if (!state.walking) return;
      let frame = 1;
      setPose('walk-1');
      walkFrameTimer = setInterval(() => { frame = frame === 1 ? 2 : 1; setPose(`walk-${frame}`); }, 180);
      speak('出门散步啦', 'alert');
    });
  } else if (state.connected && !state.jumping) {
    transitionPose('idle');
    if (state.edgeAutoOuting) setTimeout(finishPeekOuting, 1800);
    else { scheduleNap(); scheduleIdleAction(); schedulePeek(); }
  }
}

function onJumpState(jumping) {
  if (!jumping && !state.jumping) return;
  state.jumping = jumping;
  if (jumping) {
    motionPendingKind = null;
    ++actionEpoch;
    state.walking = false;
    clearInterval(walkFrameTimer);
    clearTimeout(walkFallbackTimer);
    clearTimeout(poseTimer);
    clearTimeout(napTimer);
    clearTimeout(state.idleTimer);
    clearTimeout(deliveryFinishTimer);
    wakeThen(() => {
      if (!state.jumping) return;
      setPose('jump');
      speak('跳起来啦', 'alert');
    });
  } else if (!state.walking) {
    clearTimeout(poseTimer);
    transitionPose(state.connected && state.peerOnline ? 'idle' : 'nap');
    if (state.connected) { scheduleNap(); scheduleIdleAction(); schedulePeek(); }
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
    signal: options.signal || AbortSignal.timeout(15000),
    headers: { ...headers, ...options.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return response;
}

function applyProfile(profile = {}) {
  state.profile = { petName: DEFAULT_PET_NAME, ...profile };
  $('petNameLabel').textContent = state.profile.petName || DEFAULT_PET_NAME;
  $('coupleBadge').hidden = !state.connected;
  $('profilePetName').value = state.profile.petName || '';
}

async function openSession(url, key, name, mode) {
  let response;
  try {
    response = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pet-Key': key },
      body: JSON.stringify({ senderId, senderName: name, mode }),
      signal: AbortSignal.timeout(4000)
    });
  } catch {
    const error = new Error('房间暂时不可达');
    error.code = 'ROOM_UNREACHABLE';
    throw error;
  }
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

function transferLabel(item) {
  if (item.phase === 'saved') return '已保存到下载';
  if (item.phase === 'failed') return item.direction === 'receive' ? '接收失败，点击文件重试' : '发送失败';
  if (item.phase === 'uploaded') return '已发送到房间';
  if (item.phase === 'waiting') return '等待接收';
  if (item.phase === 'downloading') return `正在保存到下载 · ${Math.round(item.progress)}%`;
  return item.direction === 'receive' ? `正在接收 · ${Math.round(item.progress)}%` : `正在发送 · ${Math.round(item.progress)}%`;
}

function showTransfer(item) {
  if (panelKind !== 'chat' || !item?.transferId) return;
  item = { ...item, roomUrl: item.roomUrl || state.url };
  const previous = transferStates.get(item.transferId);
  if (previous?.phase === 'saved' && item.phase !== 'saved') return;
  if (previous?.phase === 'uploaded' && item.phase === 'uploading') return;
  if (previous?.phase === 'downloading' && item.phase === 'uploading') return;
  transferStates.set(item.transferId, item);
  while (transferStates.size > 300) transferStates.delete(transferStates.keys().next().value);
  if (!state.url || item.roomUrl !== state.url) return;
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
  bar.hidden = ['saved', 'failed', 'uploaded', 'waiting'].includes(item.phase);
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
      const savedPath = await desktop.saveRemoteFile({
        url: state.url, token: state.token, fileId: event.fileId,
        fileName: event.fileName, transferId: event.transferId || event.id
      });
      rememberSavedFile(event.fileId);
      if (!automatic) toast(`已保存到下载：${savedPath.split(/[\\/]/).pop()}`);
    } else {
      const response = await request(`/files/${encodeURIComponent(event.fileId)}`);
      const data = await response.arrayBuffer();
      const blobUrl = URL.createObjectURL(new Blob([data]));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = event.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
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
    const transferId = event.transferId || event.id;
    if (panelKind === 'chat') {
      const earlier = transferRows.get(transferId);
      if (earlier) earlier.remove();
      transferRows.set(transferId, wrapper);
    }
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
    button.addEventListener('click', () => {
      if (event.senderId !== senderId && savedFileIds.has(event.fileId)) desktop?.openDownloads();
      else downloadFile(event);
    });
    wrapper.appendChild(button);
    if (panelKind === 'chat') {
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
    const data = event.data || {};
    if (panelKind === 'chat' && data.type === 'file') showTransfer({
      transferId: data.transferId, name: data.name,
      direction: event.senderId === senderId ? 'send' : 'receive',
      phase: 'uploading', progress: Number(data.progress) || 0
    });
    if (panelMode) return;
    if (event.senderId !== senderId) {
      if (!pendingDeliveries.has(data.transferId)) {
        pendingDeliveries.set(data.transferId, Date.now());
        setTimeout(() => pendingDeliveries.delete(data.transferId), 30000);
        animateDelivery(0);
        speak(`${event.senderName} 正在递信`);
      }
      $('mainMascot').style.setProperty('--delivery-progress', String(Math.max(0, Math.min(1, Number(data.progress) / 100 || 0))));
    }
    return;
  }
  $('events').querySelector('.empty-state')?.remove();
  renderEvent(event);
  // The mascot window owns animations and notifications. A history panel only
  // mirrors the live event stream, otherwise opening it would duplicate effects.
  if (panelMode) return;
  if (event.kind === 'file') receiveFile(event);
  const actionText = { pet: '摸摸你啦', fish: '给你投喂小鱼干', walk: '让你散步啦', sit: '让你坐下啦', sleep: '让你睡觉啦', stretch: '让你伸个懒腰', jump: '让你乱蹦啦', hug: '给你一个抱抱', kiss: '亲亲你', groom: '给你梳梳毛', purr: '在你身边呼噜' };
  if (event.kind === 'walk') startMotion('walk');
  else if (event.kind === 'jump') startMotion('jump');
  else if (event.kind === 'wave') animatePet('wiggle');
  else if (actionText[event.kind]) animateRemoteAction(event.kind);
  if (event.senderId !== senderId) {
    const message = event.kind === 'file' ? `收到文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 来打招呼啦` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : event.text;
    speak(message, actionText[event.kind] ? 'alert' : 'normal');
    if (event.kind === 'file' || event.kind === 'message') {
      const transferId = event.transferId;
      const started = transferId ? pendingDeliveries.get(transferId) : null;
      if (transferId) pendingDeliveries.delete(transferId);
      setTimeout(animateReceive, started ? Math.max(0, 650 - (Date.now() - started)) : 0);
    }
    if (desktop && state.notifications) desktop.notify(state.profile.petName || DEFAULT_PET_NAME, event.kind === 'file' ? `${event.senderName} 发来文件：${event.fileName}` : event.kind === 'wave' ? `${event.senderName} 向你招手` : actionText[event.kind] ? `${event.senderName} ${actionText[event.kind]}` : `${event.senderName}：${event.text}`);
  }
}

function openSocket() {
  if (!state.connected) return;
  const socket = new WebSocket(`${state.url.replace(/^http/, 'ws')}/ws?v=3&session=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socket.onopen = async () => {
    if (!state.connected || state.socket !== socket) return socket.close();
    state.roomConnection = 'online';
    updateConnectionStatus();
    try {
      const response = await request('/events');
      for (const event of await response.json()) {
        onEvent(event);
        if (event.kind === 'file') receiveFile(event);
      }
    } catch { /* The socket's close handler will retry if the room went away. */ }
  };
  socket.onmessage = message => {
    if (!state.connected || state.socket !== socket) return;
    const payload = JSON.parse(message.data);
    if (payload.type === 'event') onEvent(payload.event);
    if (payload.type === 'presence') setPeerOnline(payload);
    if (payload.type === 'profile') applyProfile(payload.profile);
  };
  socket.onclose = () => {
    if (!state.connected || state.socket !== socket) return;
    state.socket = null;
    state.token = '';
    state.roomConnection = 'reconnecting';
    setPeerOnline(false);
    scheduleSessionRetry();
  };
}

function scheduleSessionRetry(delay = 2500) {
  clearTimeout(state.reconnectTimer);
  if (!state.connected) return;
  const epoch = connectionEpoch;
  state.reconnectTimer = setTimeout(async () => {
    if (!state.connected || epoch !== connectionEpoch) return;
    try {
      const session = await openSession(state.url, state.key, state.name, state.mode);
      if (!state.connected || epoch !== connectionEpoch) return;
      state.token = session.token;
      state.profile = session.profile || {};
      applyProfile(state.profile);
      setPeerOnline(session.presence || false);
      openSocket();
    } catch {
      if (state.connected && epoch === connectionEpoch) scheduleSessionRetry(5000);
    }
  }, delay);
}

async function connect(url, key, name, mode) {
  const epoch = ++connectionEpoch;
  state.url = normalizeAddress(url);
  state.key = key.trim();
  state.name = name.trim().slice(0, 24);
  state.mode = mode;
  let session = null;
  try { session = await openSession(state.url, state.key, state.name, mode); }
  catch (error) { if (error.code !== 'ROOM_UNREACHABLE') throw error; }
  if (epoch !== connectionEpoch) return;
  state.token = session?.token || '';
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
  $('pinButton').hidden = !desktop;
  $('settingsButton').hidden = true;
  $('roomAddress').textContent = state.url;
  $('roomKey').textContent = state.key;
  $('hostKeyBlock').hidden = mode !== 'host';
  $('events').replaceChildren();
  transferRows.clear();
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
    setExpanded(!desktop);
  }
  updateConnectionStatus();
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
  if (session) openSocket();
  else scheduleSessionRetry();
  localStorage.setItem(SESSION_KEY, JSON.stringify({ url: state.url, key: state.key, name: state.name, mode }));
}

async function disconnect() {
  if (!state.connected) return;
  ++connectionEpoch;
  state.connected = false;
  try { if (state.token) await request('/leave', { method: 'POST' }); } catch { /* Room may already be gone. */ }
  state.roomConnection = 'closed';
  if (state.walking) await desktop?.stopWalk();
  if (state.jumping) await desktop?.stopJump();
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
  setActionTray(false);
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
  updateConnectionStatus();
  if (desktop && !panelMode) desktop.setWindowSize(true);
  if (panelMode) desktop?.closePanel();
}

async function sendEvent(kind, text = '', data = {}, { quiet = false, signal, clientId = crypto.randomUUID() } = {}) {
  try {
    const response = await request('/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ kind, text, data, clientId })
    });
    if (kind === 'wave') {
      speak('招手送出去了');
    } else if (kind === 'walk') speak('已经让对方散步啦', 'alert');
    else if (kind === 'jump') speak('已经让对方乱蹦啦', 'alert');
    else if (['pet', 'fish', 'sit', 'sleep', 'stretch', 'hug', 'kiss', 'groom', 'purr'].includes(kind)) speak('动作送到对方那里啦', 'alert');
    return await response.json();
  } catch (error) { if (!quiet) toast(error.message); return null; }
}

async function sendMessage(text, clientId) {
  animateDelivery(0);
  const sent = await sendEvent('message', text, {}, { clientId });
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
  if (file.size > 100 * 1024 * 1024) return toast('文件不能超过 100 MB');
  const transferId = crypto.randomUUID();
  const form = new FormData();
  form.append('file', file);
  form.append('senderId', senderId);
  form.append('senderName', state.name);
  form.append('fileName', file.name);
  form.append('clientId', crypto.randomUUID());
  form.append('transferId', transferId);
  speak(`叼着 ${file.name} 送过去…`);
  desktop?.reportTransfer?.({ transferId, name: file.name, roomUrl: state.url, direction: 'send', phase: 'uploading', progress: 0 });
  animateDelivery(0);
  await sendEvent('delivery', '', { transferId, name: file.name, progress: 0, status: 'preparing', type: 'file' }, { quiet: true, signal: AbortSignal.timeout(1500) });
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
        const progressValue = Math.round(ratio * 100);
        desktop?.reportTransfer?.({ transferId, name: file.name, roomUrl: state.url, direction: 'send', phase: 'uploading', progress: progressValue });
        sendEvent('delivery', '', { transferId, name: file.name, progress: progressValue, status: 'uploading', type: 'file' }, { quiet: true });
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error('文件发送失败'));
      };
      xhr.onerror = () => reject(new Error('文件发送失败'));
      xhr.send(form);
    });
    speak(`${event.fileName} 已送到窗口`);
    desktop?.reportTransfer?.({ transferId, fileId: event.fileId, name: event.fileName, roomUrl: state.url, direction: 'send', phase: 'uploaded', progress: 100 });
  } catch (error) {
    desktop?.reportTransfer?.({ transferId, name: file.name, roomUrl: state.url, direction: 'send', phase: 'failed', progress: 0 });
    toast(error.message);
    speak('发送失败', 'alert');
  }
  $('fileInput').value = '';
}

async function copy(value) {
  if (desktop) await desktop.copy(value);
  else await navigator.clipboard.writeText(value);
  toast('已复制');
}

async function init() {
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
  if (panelMode && panelKind === 'settings' && !localStorage.getItem(SESSION_KEY)) {
    $('setup').hidden = true;
    $('appSettings').hidden = false;
  }
  $('hostTab').addEventListener('click', () => setMode('host'));
  $('joinTab').addEventListener('click', () => { setMode('join'); scanPeers(); });
  $('scanPeersButton').addEventListener('click', scanPeers);
  $('joinAddress').addEventListener('input', () => $('scanResults').querySelectorAll('.scan-choice').forEach(item => item.classList.remove('selected')));
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
    if (event.key === SESSION_KEY && !event.newValue && state.connected) disconnect();
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
    if (desktop?.openPanel) desktop.openPanel('settings');
    else { setExpanded(true); setView('connection'); }
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
  if (desktop) desktop.onWalkState(onWalkState);
  if (desktop?.onWalkDirection) desktop.onWalkDirection(direction => {
    $('mainMascot').classList.toggle('walk-left', direction < 0);
    $('mainMascot').classList.toggle('walk-right', direction > 0);
  });
  if (desktop?.onJumpState) desktop.onJumpState(onJumpState);
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
    submitMessage(event.currentTarget, $('quickMessageInput'));
  });
  $('quickMessageInput').addEventListener('keydown', event => {
    if (event.key === 'Escape') setQuickComposer(false);
  });
  $('quickMessageInput').addEventListener('input', () => { delete $('quickMessageForm').dataset.pendingId; });
  $('messageInput').addEventListener('input', () => { delete $('messageForm').dataset.pendingId; });
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
        localStorage.setItem('dongdong-auto-launch', JSON.stringify(value));
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

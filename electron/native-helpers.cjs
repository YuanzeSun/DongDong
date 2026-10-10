const path = require('node:path');
const fs = require('node:fs/promises');

function truncateUtf8(value, maximum) {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function downloadName(value) {
  let name = path.posix.basename(String(value || 'file').replaceAll('\\', '/'))
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_')
    .trim().replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = 'file';
  // These device names are reserved on Windows even with an extension.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name.split('.')[0].trim())) name = `_${name}`;
  const extension = truncateUtf8(path.extname(name), 50);
  const originalExtension = path.extname(name);
  const stem = originalExtension ? name.slice(0, -originalExtension.length) : name;
  return `${truncateUtf8(stem, 200 - Buffer.byteLength(extension, 'utf8')) || 'file'}${extension}`;
}

async function openUniqueDownload(downloads, requestedName) {
  await fs.mkdir(downloads, { recursive: true });
  const directory = await fs.realpath(downloads);
  const fileName = downloadName(requestedName);
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 0; index < 10000; index += 1) {
    const target = path.join(directory, index ? `${stem} (${index})${extension}` : fileName);
    let handle;
    try {
      handle = await fs.open(target, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    return { handle, target };
  }
  throw new Error('同名文件太多，请先整理下载文件夹');
}

async function saveResponseDownload(downloads, response, requestedName, maximumBytes, onProgress = () => {}) {
  if (!response.ok || !response.body) throw new Error('文件下载失败');
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : 0;
  if (total > maximumBytes) throw new Error('文件超过允许的大小');
  const { handle, target } = await openUniqueDownload(downloads, requestedName);
  let received = 0;
  try {
    for await (const piece of response.body) {
      const chunk = Buffer.from(piece);
      if (received + chunk.length > maximumBytes) throw new Error('文件超过允许的大小');
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written, received + written);
        if (!result.bytesWritten) throw new Error('文件写入失败');
        written += result.bytesWritten;
      }
      received += chunk.length;
      onProgress(received, total);
    }
    if (total && received !== total) throw new Error('文件下载不完整');
    await handle.close();
    return target;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(target).catch(() => {});
    throw error;
  }
}

function clampBounds(bounds, area) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), area.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds.y))),
    width, height
  };
}

function planWalkTimeline(bounds, area, random = Math.random) {
  const left = area.x;
  const right = Math.max(left, area.x + area.width - bounds.width);
  const top = area.y;
  const bottom = Math.max(top, area.y + area.height - bounds.height);
  const segments = [];
  let totalMs = 0;
  let from = { x: Math.max(left, Math.min(right, bounds.x)), y: Math.max(top, Math.min(bottom, bounds.y)) };
  if (Math.max(right - left, bottom - top) < 48) return { segments, totalMs };
  const count = 3 + Math.floor(random() * 2);
  const weights = Array.from({ length: count }, () => .8 + random() * .4);
  const pauses = weights.map(() => 650 + Math.round(random() * 650));
  const travelBudget = 18000 + random() * 6000 - pauses.reduce((sum, pause) => sum + pause, 0);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const reflect = (value, min, max) => {
    if (max === min) return min;
    const span = max - min;
    const offset = ((value - min) % (span * 2) + span * 2) % (span * 2);
    return min + Math.min(offset, span * 2 - offset);
  };
  let heading = random() * Math.PI * 2;
  for (let index = 0; index < count; index++) {
    const travelMs = Math.round(travelBudget * weights[index] / weightSum);
    const distance = (35 + random() * 10) * .8 * travelMs / 1200;
    let to;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (index || attempt) heading += (random() < .5 ? -1 : 1) * (.45 + random() * 1.1);
      to = {
        x: reflect(from.x + Math.cos(heading) * distance, left, right),
        y: reflect(from.y + Math.sin(heading) * distance, top, bottom)
      };
      const previous = segments.at(-1)?.from;
      if (Math.hypot(to.x - from.x, to.y - from.y) >= Math.min(45, distance * .5)
        && (!previous || Math.hypot(to.x - previous.x, to.y - previous.y) >= 35)) break;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const bend = (.15 + random() * .15) * (random() < .5 ? -1 : 1);
    const control = {
      x: Math.max(left, Math.min(right, (from.x + to.x) / 2 - dy * bend)),
      y: Math.max(top, Math.min(bottom, (from.y + to.y) / 2 + dx * bend))
    };
    // The quadratic derivative is bounded by 1.2 * chord length.  Reserving
    // 20% for easing caps the actual curved motion at the chosen 35-45 px/s.
    const pauseMs = pauses[index];
    segments.push({ from, control, to, travelMs, pauseMs });
    totalMs += travelMs + pauseMs;
    from = to;
    heading = Math.atan2(dy, dx);
  }
  return { segments, totalMs };
}

function walkPositionAt(timeline, elapsedMs) {
  if (!timeline.segments.length) return null;
  let elapsed = Math.max(0, elapsedMs);
  for (const { from, control, to, travelMs, pauseMs } of timeline.segments) {
    if (elapsed <= travelMs + pauseMs) {
      const t = Math.min(1, elapsed / travelMs);
      const progress = t < .2 ? t * t / .32 : t > .8 ? 1 - (1 - t) ** 2 / .32 : (t - .1) / .8;
      const remaining = 1 - progress;
      const dx = 2 * (remaining * (control.x - from.x) + progress * (to.x - control.x));
      const dy = 2 * (remaining * (control.y - from.y) + progress * (to.y - control.y));
      return {
        x: remaining * remaining * from.x + 2 * remaining * progress * control.x + progress * progress * to.x,
        y: remaining * remaining * from.y + 2 * remaining * progress * control.y + progress * progress * to.y,
        direction: Math.abs(dx) > Math.hypot(dx, dy) * .1 ? Math.sign(dx) : 0,
        pace: Math.min(1, t / .2, (1 - t) / .2),
        done: false
      };
    }
    elapsed -= travelMs + pauseMs;
  }
  return { ...timeline.segments.at(-1).to, direction: 0, pace: 0, done: true };
}

function tailnetPeers(status) {
  const self = new Set(status?.Self?.TailscaleIPs || []);
  const peers = Object.values(status?.Peer || {}).flatMap(peer => {
    const address = (peer.TailscaleIPs || []).find(ip => {
      const octets = ip.split('.').map(Number);
      return octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
        && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 && !self.has(ip);
    });
    if (!address) return [];
    return [{ address, name: String(peer.HostName || peer.DNSName || address).replace(/\.$/, '').slice(0, 80), online: peer.Online === true }];
  });
  return [...new Map(peers.map(peer => [peer.address, peer])).values()]
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

module.exports = {
  downloadName,
  saveResponseDownload,
  clampBounds,
  planWalkTimeline,
  walkPositionAt,
  tailnetPeers
};

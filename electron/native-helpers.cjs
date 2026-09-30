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

function downloadBuffer(data, maximumBytes) {
  let buffer;
  if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else throw new TypeError('文件数据格式不正确');
  if (buffer.byteLength > maximumBytes) throw new Error('文件超过允许的大小');
  return buffer;
}

async function saveUniqueDownload(downloads, data, requestedName) {
  const { handle, target } = await openUniqueDownload(downloads, requestedName);
  try {
    await handle.writeFile(data);
    await handle.close();
    return target;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(target).catch(() => {});
    throw error;
  }
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

function planWalkPath(bounds, area, random = Math.random) {
  const left = area.x;
  const right = area.x + area.width - bounds.width;
  const top = area.y;
  const bottom = area.y + area.height - bounds.height;
  if (right - left < 48) return [];
  let x = Math.max(left, Math.min(right, bounds.x));
  let y = Math.max(top, Math.min(bottom, bounds.y));
  const leftRoom = x - left;
  const rightRoom = right - x;
  const firstDirection = Math.min(leftRoom, rightRoom) < 110
    ? (rightRoom > leftRoom ? 1 : -1)
    : (random() < 0.5 ? -1 : 1);
  const points = [];
  for (const [index, baseDistance] of [95, 65, 105, 55].entries()) {
    let direction = index % 2 ? -firstDirection : firstDirection;
    let room = direction > 0 ? right - x : x - left;
    if (room < 24) {
      direction *= -1;
      room = direction > 0 ? right - x : x - left;
    }
    if (room < 24) break;
    x += direction * Math.min(room, baseDistance + Math.round(random() * 25));
    y = Math.max(top, Math.min(bottom, y + [0, -12, 18, -6][index]));
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
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

module.exports = { downloadName, downloadBuffer, saveUniqueDownload, saveResponseDownload, clampBounds, planWalkPath, tailnetPeers };

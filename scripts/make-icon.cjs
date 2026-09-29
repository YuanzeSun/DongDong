const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

async function main() {
  const root = path.join(__dirname, '..');
  const background = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="190" fill="#277e68"/><rect x="56" y="56" width="912" height="912" rx="150" fill="#e9f5eb"/></svg>');
  const cat = await sharp(path.join(root, 'public', 'mascot.svg'))
    .resize(760, 760, { kernel: 'nearest' }).png().toBuffer();
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  await sharp(background).composite([{ input: cat, left: 132, top: 132 }])
    .png().toFile(path.join(root, 'assets', 'icon.png'));
  const iconPath = path.join(root, 'assets', 'icon.png');
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(icoSizes.map(size => sharp(iconPath).resize(size, size, { kernel: 'nearest' }).png().toBuffer()));
  const header = Buffer.alloc(6 + icoSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = header.length;
  icoSizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += pngs[index].length;
  });
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), Buffer.concat([header, ...pngs]));

  if (process.platform === 'darwin') {
    const iconset = path.join(root, 'assets', 'icon.iconset');
    fs.mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      await sharp(iconPath).resize(size, size, { kernel: 'nearest' }).png().toFile(path.join(iconset, `icon_${size}x${size}.png`));
      await sharp(iconPath).resize(size * 2, size * 2, { kernel: 'nearest' }).png().toFile(path.join(iconset, `icon_${size}x${size}@2x.png`));
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets', 'icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

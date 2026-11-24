// Makes the icons from logo.jpg:
//   build/icon.png   the app / installer icon
//   build/tunes.ico  the icon Windows shows on saved songs (.tunes files)
// Run with: npm run icon
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

/** A Windows .ico holding one PNG per size (supported since Windows Vista). */
function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2);                      // no palette
    e.writeUInt8(0, 3);                      // reserved
    e.writeUInt16LE(1, 4);                   // colour planes
    e.writeUInt16LE(32, 6);                  // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

app.whenReady().then(() => {
  const root = path.join(__dirname, '..');
  const img = nativeImage.createFromPath(path.join(root, 'logo.jpg'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), square.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  console.log(`build/icon.png written (512x512 from ${width}x${height})`);

  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const pngs = sizes.map(size => ({ size, data: square.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(root, 'build', 'tunes.ico'), makeIco(pngs));
  console.log(`build/tunes.ico written (${sizes.join(', ')} px)`);
  app.exit(0);
});

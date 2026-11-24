// Makes build/icon.png (the app / installer icon) from logo.jpg.
// Run with: npm run icon
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const root = path.join(__dirname, '..');
  const img = nativeImage.createFromPath(path.join(root, 'logo.jpg'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), square.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  console.log(`build/icon.png written (512x512 from ${width}x${height})`);
  app.exit(0);
});

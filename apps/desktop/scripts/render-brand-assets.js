'use strict';
// Rasterises build/icon.svg and build/background.svg into the files electron-builder packs:
// build/icon.icns and build/background.tiff (1x + 2x in one file, so the DMG window is sharp on Retina).
// Run after editing either SVG: `npm run brand-assets -w @gitlanes/desktop`. Needs macOS (iconutil).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const buildDir = path.join(__dirname, '..', 'build');
app.dock?.hide();

// Draws the SVG onto a canvas of exactly width x height pixels, independent of the display's scale.
async function render(win, svgFile, width, height) {
  const svg = fs.readFileSync(path.join(buildDir, svgFile), 'utf8');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(${width}, ${height});
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: ${width}, height: ${height} });
    canvas.getContext('2d').drawImage(img, 0, 0, ${width}, ${height});
    return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-'));
  const iconset = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), await render(win, 'icon.svg', size, size));
    fs.writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), await render(win, 'icon.svg', size * 2, size * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);

  const bg1x = path.join(tmp, 'background.png');
  const bg2x = path.join(tmp, 'background@2x.png');
  fs.writeFileSync(bg1x, await render(win, 'background.svg', 660, 400));
  fs.writeFileSync(bg2x, await render(win, 'background.svg', 1320, 800));
  execFileSync('tiffutil', ['-cathidpicheck', bg1x, bg2x, '-out', path.join(buildDir, 'background.tiff')]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wrote build/icon.icns, build/background.tiff');
  win.destroy();
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });

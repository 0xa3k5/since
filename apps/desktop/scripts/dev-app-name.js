'use strict';
// `pnpm start` runs the stock Electron.app from node_modules, so macOS shows "Electron" in the Dock and
// the menu bar: both read the bundle's Info.plist, which can't change at run time. Rename that dev copy
// to Since before launching. Packaged builds get their name from electron-builder (productName).
// Best effort: any failure just leaves the dev name as it was.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NAME = 'Since';

if (process.platform === 'darwin') {
  try {
    const plist = path.resolve(require('electron'), '../../Info.plist');
    const read = (key) => { try { return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim(); } catch { return null; } };
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      if (read(key) !== NAME) execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
    }
  } catch (e) {
    console.warn('could not rename the dev app:', e.message);
  }
}

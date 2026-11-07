'use strict';
// Builds out/ before any spec launches the app: package.json "main" points into it.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build.js')], { stdio: 'inherit' });
};

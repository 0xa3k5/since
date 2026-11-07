'use strict';
// The main process source as one string, for tests that check what it does by reading it.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'main');
// A module moved to TypeScript is listed by its .ts file.
const real = (f) => (fs.existsSync(path.join(dir, f)) ? f : f.replace(/\.js$/, '.ts'));
const FILES = ['main.js', 'app-events.js', 'settings.js', 'user-data.js', 'session.js', 'windows.js', 'menu.js', 'lockdown.js',
  ...fs.readdirSync(path.join(dir, 'handlers')).filter((f) => /\.(js|ts)$/.test(f)).sort().map((f) => `handlers/${f}`)].map(real);
const mainSource = () => FILES.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

module.exports = { FILES, mainSource };

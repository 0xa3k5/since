'use strict';
// The main process source as one string, for tests that check what it does by reading it.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'main');
const FILES = ['main.js', 'app-events.js', 'settings.js', 'user-data.js', 'session.js', 'windows.js', 'menu.js', 'lockdown.js',
  ...fs.readdirSync(path.join(dir, 'handlers')).filter((f) => f.endsWith('.js')).sort().map((f) => `handlers/${f}`)];
const mainSource = () => FILES.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

module.exports = { FILES, mainSource };

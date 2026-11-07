'use strict';
// A fake `electron` for tests that load main-process modules. module.registerHooks serves it to
// require() and import alike (a Module._load patch only ever saw require()). Load this file before
// the modules under test; `useElectron(fake)` sets what `electron` is from then on. Modules read
// it through a proxy, so a lazy read (updater.init) sees the fake set by the test that runs it.
const { registerHooks } = require('node:module');

const URL = 'since-test:electron';
let current = {};
globalThis.__sinceFakeElectron = new Proxy({}, {
  get: (_t, k) => current[k],
  has: (_t, k) => k in current,
});
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'electron' ? { url: URL, format: 'commonjs', shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => (url === URL ? { format: 'commonjs', source: 'module.exports = globalThis.__sinceFakeElectron;', shortCircuit: true } : next(url, context)),
});

module.exports = { useElectron: (fake) => { current = fake; } };

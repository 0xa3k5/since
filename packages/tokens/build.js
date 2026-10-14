'use strict';
// Generates tokens.css from tokens.json. tokens.css is committed so consumers need no build step;
// test/tokens.test.js fails if it is out of date.
const fs = require('node:fs');
const path = require('node:path');

function render(tokens) {
  // Website-only tokens ride along in the same blocks; the desktop renderer ignores them.
  const web = tokens.web || {};
  tokens = {
    shared: { ...tokens.shared, ...web.shared },
    light: { ...tokens.light, ...web.light },
    dark: { ...tokens.dark, ...web.dark },
  };
  const decls = (obj, indent) => Object.entries(obj).map(([k, v]) => `${indent}--${k}: ${v};`).join('\n');
  return `/* Generated from tokens.json by build.js. Do not edit; run \`pnpm --filter @gitlanes/tokens build\`. */

/* Theme follows the system unless <html data-theme="light|dark"> overrides it. */
:root {
  color-scheme: light dark;
${decls(tokens.shared, '  ')}

${decls(tokens.light, '  ')}
}

:root[data-theme="light"] { color-scheme: light; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${decls(tokens.dark, '    ')}
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
${decls(tokens.dark, '  ')}
}
`;
}

const read = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'));
module.exports = { render, read };

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, 'tokens.css'), render(read()));
  console.log('wrote tokens.css');
}

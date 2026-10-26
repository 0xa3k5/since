'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderCask, caskFromDist, dmgName } = require('../scripts/homebrew-cask');

const hex = (c) => c.repeat(64);

test('renderCask names the versioned DMG per arch with its checksum, and follows the latest release', () => {
  const cask = renderCask({ version: '0.1.0', sha: { arm: hex('a'), intel: hex('b') } });
  assert.match(cask, /^cask "since" do$/m);
  assert.match(cask, /arch arm: "arm64", intel: "x64"/);
  assert.match(cask, /version "0\.1\.0"/);
  assert.match(cask, new RegExp(`sha256 arm:\\s+"${hex('a')}",\\s+intel: "${hex('b')}"`));
  assert.match(cask, /url "https:\/\/github\.com\/0xa3k5\/since\/releases\/download\/v#\{version\}\/Since-#\{version\}-#\{arch\}\.dmg"/);
  assert.match(cask, /strategy :github_latest/);
  assert.match(cask, /depends_on macos: ">= :monterey"/);
  assert.match(cask, /app "Since\.app"/);
  assert.ok(cask.endsWith('end\n'));
});

test('renderCask rejects a bad version or a missing checksum', () => {
  assert.throws(() => renderCask({ version: 'v0.1.0', sha: { arm: hex('a'), intel: hex('b') } }), /not a version/);
  assert.throws(() => renderCask({ version: '0.1.0', sha: { arm: hex('a') } }), /sha256 for intel/);
  assert.throws(() => renderCask({ version: '0.1.0', sha: { arm: 'abc', intel: hex('b') } }), /sha256 for arm/);
});

test('caskFromDist hashes both signed DMGs and fails on a missing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-cask-'));
  try {
    fs.writeFileSync(path.join(dir, dmgName('0.1.0', 'arm64')), 'arm');
    assert.throws(() => caskFromDist({ version: '0.1.0', dir }), /Since-0\.1\.0-x64\.dmg is missing/);
    fs.writeFileSync(path.join(dir, dmgName('0.1.0', 'x64')), 'intel');
    const cask = caskFromDist({ version: '0.1.0', dir });
    const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
    assert.ok(cask.includes(`arm:   "${h('arm')}"`) && cask.includes(`intel: "${h('intel')}"`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

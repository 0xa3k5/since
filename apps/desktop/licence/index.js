'use strict';
// Trial clock and licence state. Plain Node so it can be unit-tested without Electron.
//
// - The 14-day trial is fully local: it starts on first launch, with no account and no network.
// - A licence is a store key activated on this Mac. It is validated once per session; the last
//   good validation is cached, so the app keeps working offline for `graceDays`.
// - When neither applies, the app stays usable read-only (browse, diff) and mutations are refused.
//
// Tamper resistance is deliberately basic: state is HMAC-signed with a key tied to this Mac, the
// trial start is mirrored to a second file, and time never runs backwards (rolling the clock back
// doesn't extend a trial or a grace period). Anyone determined can patch the app; that's fine.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { StoreError } = require('./stores');

const DAY = 86400000;
const PEPPER = 'gitlanes/licence/v1';
const TOUCH_EVERY = 60 * 60 * 1000; // persist the high-water clock at most hourly

function machineId() {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch { /* fall through */ }
  }
  return `${os.hostname()}/${os.userInfo().username}`;
}

function signer(id) {
  const key = crypto.createHash('sha256').update(PEPPER + '\0' + id).digest();
  return (payload) => crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest('base64url');
}

class Licensing {
  constructor({ stateFile, mirrorFile, config, store, machine = machineId(), now = Date.now, onChange = () => {} }) {
    this.stateFile = stateFile;
    this.mirrorFile = mirrorFile;
    this.config = config;
    this.store = store;
    this.now = now;
    this.onChange = onChange;
    this.sign = signer(machine);
    this.machineHash = crypto.createHash('sha256').update(PEPPER + machine).digest('hex').slice(0, 16);
    this.lastError = null;
    this.load();
  }

  // --- persistence -----------------------------------------------------------------

  read(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { missing: true }; }
    try {
      const { payload, sig } = JSON.parse(raw);
      if (payload && typeof sig === 'string' && sig === this.sign(payload)) return { payload };
    } catch { /* fall through */ }
    return { tampered: true };
  }

  write(file, payload) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ payload, sig: this.sign(payload) }));
    fs.renameSync(tmp, file);
  }

  load() {
    const main = this.read(this.stateFile);
    const mirror = this.read(this.mirrorFile);
    const valid = [main.payload, mirror.payload].filter(Boolean);
    const starts = valid.map((p) => p.trialStart).filter(Number.isFinite);
    const seen = valid.map((p) => p.lastSeen).filter(Number.isFinite);
    this.lastSeen = Math.max(this.now(), ...seen);
    // A missing state means a fresh install. An edited one doesn't get a new trial.
    if (starts.length) this.trialStart = Math.min(...starts);
    else this.trialStart = main.tampered || mirror.tampered ? 0 : this.lastSeen;
    this.licence = main.payload?.licence || null;
    this.notice = main.payload?.notice || null;
    this.save();
  }

  save() {
    const t = { trialStart: this.trialStart, lastSeen: this.lastSeen };
    this.savedAt = this.lastSeen;
    try {
      this.write(this.stateFile, { v: 1, ...t, licence: this.licence, notice: this.notice });
      this.write(this.mirrorFile, { v: 1, ...t });
    } catch (e) { console.warn('could not save licence state', e.message); }
  }

  // Wall-clock time that never goes backwards, so a rolled-back clock can't buy more time.
  clock() {
    const t = this.now();
    if (t > this.lastSeen) this.lastSeen = t;
    if (this.lastSeen - this.savedAt >= TOUCH_EVERY) this.save();
    return this.lastSeen;
  }

  changed() {
    this.save();
    this.onChange(this.status());
  }

  // --- state -------------------------------------------------------------------------

  status() {
    const now = this.clock();
    const { trialDays, graceDays, activationLimit, checkoutUrl, portalUrl, profile } = this.config;
    const trialEndsAt = this.trialStart + trialDays * DAY;
    const trialLeft = trialEndsAt - now;
    const trialActive = trialLeft > 0;
    let licence = null, licensed = false;
    if (this.licence) {
      const graceEndsAt = this.licence.validatedAt + graceDays * DAY;
      licensed = now < graceEndsAt;
      const { key, activationId, ...shown } = this.licence; // the full key never leaves the main process
      licence = { ...shown, maskedKey: mask(key), graceEndsAt, offlineDaysLeft: Math.max(0, Math.ceil((graceEndsAt - now) / DAY)) };
    }
    const mode = licensed ? 'licensed' : licence ? 'unverified' : trialActive ? 'trial' : 'expired';
    return {
      mode,
      canMutate: licensed || trialActive,
      trialDaysLeft: Math.max(0, Math.ceil(trialLeft / DAY)),
      trialEndsAt,
      licence,
      notice: this.notice,
      lastError: this.lastError,
      trialDays,
      graceDays,
      activationLimit,
      checkoutUrl,
      portalUrl,
      profile,
    };
  }

  canMutate() { return this.status().canMutate; }

  // --- store calls -------------------------------------------------------------------

  async activate(rawKey, label = os.hostname().replace(/\.local$/, '')) {
    const key = String(rawKey || '').trim();
    if (!key) throw new StoreError('rejected', 'Enter your licence key.');
    if (this.licence?.key === key) return this.refresh();
    const meta = { mac: this.machineHash };
    const { activationId, licence } = await this.store.activate({ key, label, meta });
    const previous = this.licence;
    this.licence = { ...licence, key, activationId, validatedAt: this.clock(), activatedAt: this.clock() };
    this.notice = null;
    this.lastError = null;
    this.changed();
    // Free the seat held by a key this Mac used before; best effort.
    if (previous && previous.key !== key) this.store.deactivate(previous).catch(() => {});
    return this.status();
  }

  // Validate once per session. Network trouble keeps the cached validation; a rejection removes it.
  async refresh() {
    if (!this.licence) return this.status();
    const { key, activationId } = this.licence;
    try {
      const { licence } = await this.store.validate({ key, activationId });
      this.licence = { ...this.licence, ...licence, key, activationId, validatedAt: this.clock() };
      this.notice = null;
      this.lastError = null;
    } catch (e) {
      if (!(e instanceof StoreError) || e.kind === 'network' || e.kind === 'config') {
        this.lastError = e.message;
        this.onChange(this.status());
        return this.status();
      }
      this.licence = null;
      this.lastError = null;
      this.notice = { kind: 'revoked', message: 'Your licence is no longer active on this Mac. It may have been refunded, revoked or deactivated in the customer portal.' };
    }
    this.changed();
    return this.status();
  }

  async deactivate() {
    if (!this.licence) return this.status();
    try {
      await this.store.deactivate(this.licence);
    } catch (e) {
      if (!(e instanceof StoreError) || e.kind !== 'rejected') throw e; // already gone on the server is fine
    }
    this.licence = null;
    this.notice = null;
    this.lastError = null;
    this.changed();
    return this.status();
  }

  dismissNotice() {
    this.notice = null;
    this.changed();
  }
}

function mask(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

module.exports = { Licensing, machineId, DAY };

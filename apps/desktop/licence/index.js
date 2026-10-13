'use strict';
// Trial clock and licence state. Plain Node so it can be unit-tested without Electron.
//
// - The 14-day trial is fully local: it starts on first launch, with no account and no network.
// - A licence is a store key activated on this Mac. It is validated at launch and then about daily
//   (`maybeRefresh`), and again before a change is refused; the last good validation is cached, so
//   the app keeps working offline for `graceDays`.
// - If the store says the key was revoked or refunded, the key stays on disk marked `revoked`, so the
//   user can check again or deactivate it; it's never silently deleted.
// - When neither applies, the app stays usable read-only (browse, diff) and mutations are refused.
//
// Tamper resistance is deliberately basic: state is HMAC-signed so casual edits and files copied from
// another Mac are ignored (the signing key comes from a constant and this Mac's hardware UUID, both
// readable by the local user, so it's not a secret), the trial start is mirrored to a second file,
// and time never runs backwards (rolling the clock back doesn't extend a trial or a grace period).
// Known trade-off: a clock that was wrongly set far forward is remembered too, so it can end a trial
// early; fixing the clock doesn't bring those days back. Anyone determined can patch the app; that's fine.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { StoreError } = require('./stores');

const DAY = 86400000;
const PEPPER = 'gitlanes/licence/v1';
const TOUCH_EVERY = 60 * 60 * 1000; // persist the high-water clock at most hourly
const REVALIDATE_EVERY = DAY; // re-check a licence this often while the app runs
const RETRY_EVERY = 60 * 60 * 1000; // after a failed background check, wait this long before trying again

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
    this.lastAttempt = 0;
    this.inflight = null;
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
    const revoked = Boolean(this.licence?.revokedAt);
    if (this.licence) {
      const graceEndsAt = this.licence.validatedAt + graceDays * DAY;
      licensed = !revoked && now < graceEndsAt;
      const { key, activationId, ...shown } = this.licence; // the full key never leaves the main process
      licence = { ...shown, revoked, maskedKey: mask(key), graceEndsAt, offlineDaysLeft: Math.max(0, Math.ceil((graceEndsAt - now) / DAY)) };
    }
    const mode = licensed ? 'licensed' : revoked ? 'revoked' : licence ? 'unverified' : trialActive ? 'trial' : 'expired';
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

  // Validate with the store. Only the store saying the key is gone marks it revoked; anything else
  // (offline, proxy, server trouble, a request the store no longer accepts) keeps the cached validation.
  // Concurrent calls share one request.
  refresh() {
    if (!this.licence) return Promise.resolve(this.status());
    if (!this.inflight) this.inflight = this.validate().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async validate() {
    const { key, activationId } = this.licence;
    this.lastAttempt = this.clock();
    try {
      const { licence } = await this.store.validate({ key, activationId });
      if (this.licence?.key !== key) return this.status(); // replaced or deactivated meanwhile
      const { revokedAt, ...kept } = this.licence;
      this.licence = { ...kept, ...licence, key, activationId, validatedAt: this.clock() };
      this.notice = null;
      this.lastError = null;
    } catch (e) {
      if (this.licence?.key !== key) return this.status();
      if (!(e instanceof StoreError) || e.kind !== 'rejected') {
        this.lastError = e.message;
        this.onChange(this.status());
        return this.status();
      }
      this.licence = { ...this.licence, revokedAt: this.licence.revokedAt || this.clock() };
      this.lastError = null;
      this.notice = { kind: 'revoked', message: 'Your licence is no longer active on this Mac. It may have been refunded, revoked or deactivated in the customer portal. Check again, or deactivate it and enter another key.' };
    }
    this.changed();
    return this.status();
  }

  // Background re-validation for long-running sessions: at most daily after a good check, hourly
  // after a failed one. Returns null when no check was due.
  maybeRefresh() {
    if (!this.licence || this.inflight) return this.inflight;
    const now = this.clock();
    if (now - this.licence.validatedAt < REVALIDATE_EVERY && !this.licence.revokedAt) return null;
    if (now - this.lastAttempt < RETRY_EVERY) return null;
    return this.refresh();
  }

  // Before refusing a change: if a licence is stored but not currently valid, check it once more.
  async ensureCanMutate() {
    if (this.canMutate()) return true;
    if (this.licence) {
      try { await this.refresh(); } catch { /* stay read-only */ }
    }
    return this.canMutate();
  }

  async deactivate() {
    if (!this.licence) return this.status();
    try {
      await this.store.deactivate(this.licence);
    } catch (e) {
      // Already gone on the server is fine; so is a revoked key the server can't reach any more.
      if (!(e instanceof StoreError) || (e.kind !== 'rejected' && !this.licence.revokedAt)) throw e;
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

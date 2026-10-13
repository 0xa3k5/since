'use strict';
// Store adapters. Every adapter has the same three calls, so the payment provider can change
// without touching the trial/licence logic:
//
//   activate({ key, label, meta })     -> { activationId, licence }
//   validate({ key, activationId })    -> { licence }
//   deactivate({ key, activationId })  -> undefined
//
// `licence` is { key, displayKey, email, name, limit, benefitId }.
// Failures throw StoreError with `kind`:
//   rejected — the key is unknown, revoked, refunded, or no longer active on this Mac
//   limit    — the key is already active on its maximum number of Macs
//   network  — offline, timeout, rate limit or server error; keep the cached validation
//   config   — this build has no store settings

class StoreError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

// Polar licence keys, through the public customer-portal endpoints. No secret ships in the app.
// https://polar.sh/docs/api-reference/customer-portal/license-keys/activate
function polarStore(config, { fetch = globalThis.fetch, timeout = 15000 } = {}) {
  const ready = () => {
    if (!config.apiBase || !config.organizationId) throw new StoreError('config', 'Licence activation isn’t set up in this build yet.');
  };

  async function post(path, body) {
    ready();
    let res;
    try {
      res = await fetch(config.apiBase + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ organization_id: config.organizationId, ...body }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new StoreError('network', 'Couldn’t reach the licence server. Check your connection and try again.', e.message);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (res.ok) return data;
    const detail = typeof data?.detail === 'string' ? data.detail : text.slice(0, 300);
    if (res.status === 404) throw new StoreError('rejected', 'This licence key isn’t valid, or it is no longer active on this Mac.', detail);
    if (res.status === 403) {
      if (/limit/i.test(detail)) throw new StoreError('limit', `This key is already active on ${config.activationLimit} Macs. Deactivate one in the customer portal, then try again.`, detail);
      throw new StoreError('rejected', 'This licence key has been revoked or disabled.', detail);
    }
    if (res.status === 422 || res.status === 400) throw new StoreError('rejected', 'That doesn’t look like a GitLanes licence key.', detail);
    throw new StoreError('network', 'The licence server had a problem. Try again in a moment.', `HTTP ${res.status}: ${detail}`);
  }

  const toLicence = (k) => {
    if (config.benefitId && k.benefit_id !== config.benefitId) throw new StoreError('rejected', 'This key is for a different product.', k.benefit_id);
    if (k.status && k.status !== 'granted') throw new StoreError('rejected', 'This licence key has been revoked or disabled.', k.status);
    return {
      key: k.key,
      displayKey: k.display_key || null,
      email: k.customer?.email || null,
      name: k.customer?.name || null,
      limit: k.limit_activations ?? null,
      benefitId: k.benefit_id,
    };
  };

  return {
    name: 'polar',
    async activate({ key, label, meta }) {
      const a = await post('/v1/customer-portal/license-keys/activate', { key, label, meta });
      return { activationId: a.id, licence: toLicence(a.license_key) };
    },
    async validate({ key, activationId }) {
      const k = await post('/v1/customer-portal/license-keys/validate', { key, activation_id: activationId, benefit_id: config.benefitId || undefined });
      if (k.activation && k.activation.id !== activationId) throw new StoreError('rejected', 'This licence is no longer active on this Mac.');
      return { licence: toLicence(k) };
    },
    async deactivate({ key, activationId }) {
      await post('/v1/customer-portal/license-keys/deactivate', { key, activation_id: activationId });
    },
  };
}

// In-memory store for development (GITLANES_STORE=mock) and tests.
// GL-TEST-… keys activate; GL-TEST-REVOKED… keys activate and then fail validation;
// GL-TEST-FULL… keys hit the activation limit; GL-TEST-OFFLINE… keys activate and then behave as offline.
function mockStore(config = { activationLimit: 3 }) {
  const activations = new Map(); // activationId -> key
  let n = 0;
  const licence = (key) => ({ key, displayKey: '****-' + key.slice(-4), email: 'test@example.com', name: 'Test Customer', limit: config.activationLimit, benefitId: config.benefitId || 'mock-benefit' });
  const check = (key) => { if (!/^GL-TEST-/i.test(key)) throw new StoreError('rejected', 'This licence key isn’t valid, or it is no longer active on this Mac.'); };
  return {
    name: 'mock',
    activations,
    async activate({ key }) {
      check(key);
      if (/^GL-TEST-FULL/i.test(key)) throw new StoreError('limit', `This key is already active on ${config.activationLimit} Macs. Deactivate one in the customer portal, then try again.`);
      const activationId = `mock-activation-${++n}`;
      activations.set(activationId, key);
      return { activationId, licence: licence(key) };
    },
    async validate({ key, activationId }) {
      if (/^GL-TEST-OFFLINE/i.test(key)) throw new StoreError('network', 'Couldn’t reach the licence server. Check your connection and try again.');
      check(key);
      if (/^GL-TEST-REVOKED/i.test(key) || activations.get(activationId) !== key) throw new StoreError('rejected', 'This licence key isn’t valid, or it is no longer active on this Mac.');
      return { licence: licence(key) };
    },
    async deactivate({ activationId }) {
      activations.delete(activationId);
    },
  };
}

function createStore(config, opts) {
  return config.provider === 'mock' ? mockStore(config) : polarStore(config, opts);
}

module.exports = { StoreError, polarStore, mockStore, createStore };

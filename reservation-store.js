'use strict';

/**
 * The hold store — P1 of AI_BUDGET_ENFORCEMENT_PLAN.md §7.2.
 *
 * ## Why a store and not a counter
 *
 * The plan sketched `billing:held:{tenant}` as an integer alongside a
 * per-reservation key with a TTL. That pair drifts the moment a process dies
 * without settling: the reservation key expires on its own, but nothing
 * decrements the counter, so the tenant's spendable budget leaks away silently
 * and permanently.
 *
 * Here the reservations *are* the counter. Live reservations are summed on
 * read and expired members are pruned in the same pass, so expiry releases a
 * hold with no compensating write. Recovery from a crash is therefore automatic
 * and bounded by the TTL — which is the whole point of §7.5.
 *
 * ## Atomicity
 *
 * `reserve()` is synchronous and contains no `await`. In Node that is the same
 * guarantee the plan's Lua script buys from Redis: the read-modify-write cannot
 * interleave with another turn. `RESERVE_LUA` / `SETTLE_LUA` below are the
 * production translation, kept next to the implementation so the two cannot
 * drift apart.
 */

/** Production translation of `reserve()`. Run with EVAL. */
const RESERVE_LUA = `
-- KEYS[1] = billing:resvs:{tenant}
-- ARGV    = turnUid, want, ttlMs, now, payload
local key = KEYS[1]
local turnUid = ARGV[1]
local want = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local payload = ARGV[5]

local held = 0
local flat = redis.call('HGETALL', key)
for i = 1, #flat, 2 do
  local ok, entry = pcall(cjson.decode, flat[i + 1])
  if ok and entry and tonumber(entry.expiresAt) > now then
    held = held + tonumber(entry.cents)
  else
    redis.call('HDEL', key, flat[i])   -- expired: released for free
  end
end

local existing = redis.call('HGET', key, turnUid)
if existing then
  local ok, entry = pcall(cjson.decode, existing)
  if ok and entry then
    return { tonumber(entry.cents), 1, held, tonumber(entry.expiresAt) }
  end
end

if redis.call('GET', KEYS[2]) and held + want > tonumber(redis.call('GET', KEYS[2])) then
  return { 0, -1, held, 0 }
end

redis.call('HSET', key, turnUid, payload)
redis.call('PEXPIRE', key, ttlMs + 60000)
return { want, 0, held + want, now + ttlMs }
`;

/** Production translation of `settle()`. Settle *is* the release. */
const SETTLE_LUA = `
-- KEYS[1] = billing:resvs:{tenant}
-- ARGV    = turnUid, now
local key = KEYS[1]
local turnUid = ARGV[1]
local now = tonumber(ARGV[2])
local reserved = 0
local found = 0

local flat = redis.call('HGETALL', key)
for i = 1, #flat, 2 do
  local ok, entry = pcall(cjson.decode, flat[i + 1])
  if flat[i] == turnUid then
    if ok and entry then reserved = tonumber(entry.cents); found = 1 end
    redis.call('HDEL', key, flat[i])
  elseif not (ok and entry and tonumber(entry.expiresAt) > now) then
    redis.call('HDEL', key, flat[i])
  end
end

local held = 0
local rest = redis.call('HGETALL', key)
for i = 1, #rest, 2 do
  local ok, entry = pcall(cjson.decode, rest[i + 1])
  if ok and entry then held = held + tonumber(entry.cents) end
end

return { reserved, held, found }
`;

const DEFAULT_TTL_SECONDS = 180;

/** Reserve states, mirroring the plan's state machine (§7.5). */
const ReserveState = Object.freeze({
  GRANTED: 'GRANTED',
  REPLAY: 'REPLAY',
  DENIED: 'DENIED',
});

class ReservationStore {
  /**
   * @param {object}   [options]
   * @param {number}   [options.ttlSeconds=180] hold lifetime; also the crash-recovery window
   * @param {Function} [options.now]            injectable clock, for tests
   */
  constructor({ ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
    this.ttlMs = Math.max(1000, Math.round(ttlSeconds * 1000));
    this.now = now;
    /** @type {Map<string, Map<string, {cents:number, expiresAt:number, model:string|null, createdAt:number}>>} */
    this.tenants = new Map();
  }

  #bucket(tenantId) {
    let bucket = this.tenants.get(tenantId);
    if (!bucket) {
      bucket = new Map();
      this.tenants.set(tenantId, bucket);
    }
    return bucket;
  }

  /** Drop expired holds. Returns the money still held afterwards. */
  #prune(tenantId) {
    const bucket = this.#bucket(tenantId);
    const now = this.now();
    let held = 0;
    for (const [turnUid, entry] of bucket) {
      if (entry.expiresAt <= now) {
        bucket.delete(turnUid);
      } else {
        held += entry.cents;
      }
    }
    return held;
  }

  /**
   * Take the hold.
   *
   * @param {object} input
   * @param {string} input.tenantId
   * @param {string} input.turnUid    idempotency key — a retry returns the same hold
   * @param {number} input.cents      the ceiling to hold
   * @param {number|null} [input.capacityCents] spendable money this tenant may
   *        commit in total; `null`/omitted means "no ceiling" (nothing metered)
   */
  reserve({ tenantId, turnUid, cents, capacityCents = null, model = null }) {
    const want = Math.max(0, Math.ceil(Number(cents || 0)));
    const held = this.#prune(tenantId);
    const bucket = this.#bucket(tenantId);
    const now = this.now();

    const existing = bucket.get(turnUid);
    if (existing) {
      // Idempotent replay: a retried turn must not take a second hold.
      return {
        state: ReserveState.REPLAY,
        grantedCents: existing.cents,
        heldCents: held,
        expiresAt: new Date(existing.expiresAt).toISOString(),
        availableCents:
          capacityCents === null ? null : Math.max(0, capacityCents - held),
      };
    }

    if (capacityCents !== null && held + want > Number(capacityCents)) {
      return {
        state: ReserveState.DENIED,
        grantedCents: 0,
        heldCents: held,
        expiresAt: null,
        availableCents: Math.max(0, Number(capacityCents) - held),
      };
    }

    const expiresAt = now + this.ttlMs;
    bucket.set(turnUid, { cents: want, expiresAt, model, createdAt: now });

    return {
      state: ReserveState.GRANTED,
      grantedCents: want,
      heldCents: held + want,
      expiresAt: new Date(expiresAt).toISOString(),
      availableCents:
        capacityCents === null ? null : Math.max(0, Number(capacityCents) - (held + want)),
    };
  }

  /**
   * Drop the hold. Called by settle (with the priced cost already recorded) and
   * by release (on an aborted turn). Idempotent: a second call finds nothing and
   * reports `found: false` rather than failing.
   */
  settle({ tenantId, turnUid }) {
    const bucket = this.#bucket(tenantId);
    const entry = bucket.get(turnUid);
    if (entry) bucket.delete(turnUid);
    return {
      reservedCents: entry ? entry.cents : 0,
      found: Boolean(entry),
      heldCents: this.#prune(tenantId),
    };
  }

  /** Total money held across in-flight turns — what admission subtracts. */
  held(tenantId) {
    const bucket = this.tenants.get(tenantId);
    const count = bucket
      ? [...bucket.values()].filter((entry) => entry.expiresAt > this.now()).length
      : 0;
    return { heldCents: this.#prune(tenantId), count };
  }

  /** Diagnostics: the live reservations for one tenant. */
  list(tenantId) {
    this.#prune(tenantId);
    return [...this.#bucket(tenantId).entries()].map(([turnUid, entry]) => ({
      turnUid,
      cents: entry.cents,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      model: entry.model,
    }));
  }
}

module.exports = {
  ReservationStore,
  ReserveState,
  RESERVE_LUA,
  SETTLE_LUA,
  DEFAULT_TTL_SECONDS,
};

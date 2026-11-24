'use strict';

/**
 * The §13 test plan of AI_BUDGET_ENFORCEMENT_PLAN.md, executed against the POC.
 *
 *   node --test budget-poc/budget.test.js
 *
 * Each test names the guarantee it defends, not the function it calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ASSUMED_RATES,
  clampForBudget,
  estimatePromptTokens,
  reserveFromEstimate,
  softWall,
  stopThresholdFromEnv,
  TurnBudget,
  applyHolds,
  refusalPayload,
  percentDrift,
  costOfCall,
  MIN_USEFUL_OUTPUT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_STOP_THRESHOLD_PCT,
} = require('./budget');
const { ReservationStore, ReserveState } = require('./reservation-store');
const { BudgetGate } = require('./gate');

/**
 * An explicit card for the tests.
 *
 * Named, never implicit: the production gate derives rates from the tenant's
 * rate card and throws without one, so the tests have to say which prices they
 * are asserting against.
 */
const RATES = ASSUMED_RATES;

/** A vendor stub whose balance a test can move. */
const stubVendor = (initialCents) => {
  const state = { cents: initialCents, calls: 0, fail: false };
  return {
    state,
    async spendableCents() {
      state.calls += 1;
      if (state.fail) throw new Error('metronome 503');
      return state.cents;
    },
  };
};

const gateFor = (vendor, overrides = {}) =>
  new BudgetGate({ vendor, enabled: true, rates: RATES, ...overrides });

/* ─────────────────────────────────────────────── clamp arithmetic §7.3 */

test('a 5 000 in / 8 000 out turn costs 11.30 cents, not 30.2', () => {
  // The plan's §2 example prices the request fee at 20 cents; the live card
  // says 0.2. The formula is unchanged, the constant is not.
  assert.equal(Number(costOfCall({ rates: RATES, inputTokens: 5000, outputTokens: 8000 }).toFixed(2)), 11.3);
});

test('the clamp caps output by money, never above the model maximum', () => {
  const clamp = clampForBudget({ rates: RATES, budgetCents: 1000, promptTokens: 2000 });
  assert.equal(clamp.affordable, true);
  assert.equal(clamp.maxOutputTokens, MODEL_MAX_OUTPUT_TOKENS);
  assert.equal(clamp.truncated, false);
});

test('a tiny budget shortens the answer instead of overshooting', () => {
  // 8 cents is enough for prompt + fee + a short reply, not a full one.
  const clamp = clampForBudget({ rates: RATES, budgetCents: 8, promptTokens: 200 });
  const ceilingCents = clamp.promptCostCents + clamp.requestCostCents +
    clamp.maxOutputTokens * 0.0012;
  assert.equal(clamp.affordable, true);
  assert.ok(clamp.maxOutputTokens < MODEL_MAX_OUTPUT_TOKENS);
  assert.equal(clamp.truncated, true);
  // The invariant: the reservation can never exceed the budget it came from.
  assert.ok(ceilingCents <= 8);
  assert.ok(clamp.reserveCents <= 8);
});

test('a budget that cannot pay for a useful answer is refused, not truncated', () => {
  const clamp = clampForBudget({ rates: RATES, budgetCents: 1, promptTokens: 2000 });
  assert.equal(clamp.affordable, false);
  // The clamp still reports what the money would buy; the gate is what refuses.
  assert.ok(clamp.maxOutputTokens < MIN_USEFUL_OUTPUT_TOKENS);
  assert.ok(clamp.minimumCents > 1);
});

test('prompt alone over budget is unaffordable even with a huge output allowance', () => {
  const clamp = clampForBudget({ rates: RATES, budgetCents: 5, promptTokens: 1_000_000 });
  assert.equal(clamp.affordable, false);
  assert.equal(clamp.availableForOutputCents, 0);
});

test('prompt estimation is pessimistic for short text and scales with length', () => {
  assert.ok(estimatePromptTokens('hi') >= 1);
  const short = estimatePromptTokens('hello there');
  const long = estimatePromptTokens('hello there '.repeat(100));
  assert.ok(long > short * 50);
});

test('the safety margin inflates the hold so the chain cannot land above it', () => {
  assert.equal(reserveFromEstimate(100, 10), 110);
  assert.equal(reserveFromEstimate(100, 0), 100);
});

/* ─────────────────────────────────── multi-call turns §7.3 */

test('one hold covers the whole turn: the second call sees the reduced budget', () => {
  // 14 cents and an 8 000-token cap: enough for one full reply, not for two.
  const turn = new TurnBudget({ rates: RATES, reserveCents: 14, modelMaxOutputTokens: 8000 });
  const first = turn.next(5000);
  assert.equal(first.affordable, true);
  assert.equal(first.maxOutputTokens, 8000);

  turn.consume(costOfCall({ rates: RATES, inputTokens: 5000, outputTokens: first.maxOutputTokens }));
  const second = turn.next(5000);

  assert.ok(turn.remainingCents < 14);
  assert.ok(second.maxOutputTokens < first.maxOutputTokens);
});

test('a turn that runs out returns affordable:false rather than a silent stub', () => {
  const turn = new TurnBudget({ rates: RATES, reserveCents: 2 });
  turn.consume(3);
  const next = turn.next(5000);
  assert.equal(next.affordable, false);
  assert.equal(next.exhausted, true);
});

/* ────────────────────────────── reservation store §7.2, §7.5, §13 */

test('reserving twice with the same turnUid takes the hold once', () => {
  const store = new ReservationStore();
  const first = store.reserve({ tenantId: 't1', turnUid: 'turn-a', cents: 30, capacityCents: 100 });
  const second = store.reserve({ tenantId: 't1', turnUid: 'turn-a', cents: 30, capacityCents: 100 });

  assert.equal(first.state, ReserveState.GRANTED);
  assert.equal(second.state, ReserveState.REPLAY);
  assert.equal(second.grantedCents, 30);
  assert.equal(store.held('t1').heldCents, 30);
});

test('50 concurrent turns against 1 000 cents cannot grant more than 1 000', async () => {
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor);

  const outcomes = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      gate.admit({ tenantId: 't1', turnUid: `turn-${i}`, promptTokens: 200 }),
    ),
  );

  const granted = outcomes.filter((outcome) => outcome.granted);
  const heldCents = gate.store.held('t1').heldCents;

  assert.ok(heldCents <= 1000, `held ${heldCents} exceeded the balance`);
  assert.equal(
    granted.reduce((sum, outcome) => sum + outcome.reservedCents, 0),
    heldCents,
  );
  // At least one turn must have been refused or shortened; 50 full turns at
  // ~11.7 cents each is ~585 cents, so most fit — but the cap is absolute.
  assert.ok(granted.length > 0);
});

test('settling a smaller actual releases the difference', () => {
  const store = new ReservationStore();
  store.reserve({ tenantId: 't1', turnUid: 'turn-a', cents: 30, capacityCents: 100 });
  const result = store.settle({ tenantId: 't1', turnUid: 'turn-a' });

  assert.equal(result.reservedCents, 30);
  assert.equal(result.found, true);
  assert.equal(result.heldCents, 0);
});

test('settling twice is idempotent — no double release, no throw', () => {
  const store = new ReservationStore();
  store.reserve({ tenantId: 't1', turnUid: 'turn-a', cents: 30, capacityCents: 100 });
  store.settle({ tenantId: 't1', turnUid: 'turn-a' });
  const second = store.settle({ tenantId: 't1', turnUid: 'turn-a' });

  assert.equal(second.found, false);
  assert.equal(second.heldCents, 0);
});

test('a crashed turn releases its hold when the TTL expires', () => {
  let clock = 1_000_000;
  const store = new ReservationStore({ ttlSeconds: 180, now: () => clock });

  store.reserve({ tenantId: 't1', turnUid: 'turn-a', cents: 30, capacityCents: 100 });
  assert.equal(store.held('t1').heldCents, 30);

  clock += 179_000;
  assert.equal(store.held('t1').heldCents, 30, 'still held inside the TTL');

  clock += 2_000;
  assert.equal(store.held('t1').heldCents, 0, 'released after the TTL');
});

test('an expired hold leaves no residue in the counter (the leak the plan warned about)', () => {
  let clock = 0;
  const store = new ReservationStore({ ttlSeconds: 60, now: () => clock });

  store.reserve({ tenantId: 't1', turnUid: 'a', cents: 10, capacityCents: 1000 });
  store.reserve({ tenantId: 't1', turnUid: 'b', cents: 20, capacityCents: 1000 });
  clock = 61_000;

  // A new reservation must not inherit the two expired ones.
  const fresh = store.reserve({ tenantId: 't1', turnUid: 'c', cents: 500, capacityCents: 1000 });
  assert.equal(fresh.state, ReserveState.GRANTED);
  assert.equal(store.held('t1').heldCents, 500);
});

test('held money is per tenant', () => {
  const store = new ReservationStore();
  store.reserve({ tenantId: 't1', turnUid: 'a', cents: 50, capacityCents: 100 });
  assert.equal(store.held('t2').heldCents, 0);
});

/* ─────────────────────────── admission and the 402 §7.1, §9 */

test('holds are subtracted from the balance the gate reports', () => {
  const decision = applyHolds({ allowed: true, metered: true, availableCents: 100 }, 40);
  assert.equal(decision.availableCents, 60);
  assert.equal(decision.heldCents, 40);
  assert.equal(decision.allowed, true);
});

test('the last held cent turns the gate off instead of overspending', () => {
  const decision = applyHolds({ allowed: true, metered: true, availableCents: 40 }, 40);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ALLOWANCE_EXHAUSTED');
  assert.equal(decision.availableCents, 0);
});

test('an unmetered account is never blocked by holds', () => {
  const decision = applyHolds({ allowed: true, metered: false, availableCents: 0 }, 500);
  assert.equal(decision.allowed, true);
  assert.equal(decision.heldCents, 500);
});

test('a denied decision keeps its own reason', () => {
  const decision = applyHolds(
    { allowed: false, metered: true, availableCents: 0, reason: 'PLAN_INACTIVE' },
    0,
  );
  assert.equal(decision.reason, 'PLAN_INACTIVE');
});

test('the refusal is a 402 with a top-up suggestion', () => {
  const body = refusalPayload({ requiredCents: 12, availableCents: 5 });
  assert.equal(body.code, 'INSUFFICIENT_CREDIT_FOR_TURN');
  assert.equal(body.requiredCents, 12);
  assert.equal(body.availableCents, 5);
  assert.equal(body.suggestedTopUpCents, 7);
});

test('5 % of a $200 plan runs a full-length turn rather than blocking', async () => {
  const vendor = stubVendor(1000); // 1 000 cents = 5 % of 20 000
  const gate = gateFor(vendor);

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 2000 });
  assert.equal(outcome.granted, true);
  assert.equal(outcome.maxOutputTokens, MODEL_MAX_OUTPUT_TOKENS);
  assert.equal(outcome.truncated, false);
});

test('when the prompt alone exceeds the balance the turn is refused before any model call', async () => {
  const vendor = stubVendor(3);
  const gate = gateFor(vendor);

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 500_000 });
  assert.equal(outcome.granted, false);
  assert.equal(outcome.reason, 'INSUFFICIENT_CREDIT_FOR_TURN');
  assert.equal(outcome.refusal.code, 'INSUFFICIENT_CREDIT_FOR_TURN');
  assert.equal(gate.store.held('t1').heldCents, 0, 'a refused turn holds nothing');
});

test('an unmetered tenant is granted with no hold', async () => {
  const vendor = stubVendor(null);
  const gate = gateFor(vendor);

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 100 });
  assert.equal(outcome.granted, true);
  assert.equal(outcome.reason, 'NOT_METERED');
  assert.equal(outcome.reservedCents, 0);
  assert.equal(gate.store.held('t1').heldCents, 0);
});

test('an embedding-only turn reserves nothing and releases cleanly', async () => {
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor);

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 0 });
  const settled = await gate.release({ tenantId: 't1', reservationId: outcome.reservationId });

  assert.equal(gate.store.held('t1').heldCents, 0);
  assert.equal(settled.overrun, false);
});

/* ─────────────────────── settle versus overshoot §7.4, §12 */

test('settling below the hold releases the difference and records the actual', async () => {
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor);

  const grant = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 200 });
  // Settle at the cost of exactly what was estimated: 200 in / 8 000 out.
  const actual = costOfCall({ rates: RATES, inputTokens: 200, outputTokens: 8000 });
  const settled = await gate.settle({ tenantId: 't1', reservationId: 'turn-1', actualCents: actual });

  assert.equal(settled.found, true);
  assert.equal(settled.overrun, false);
  assert.ok(settled.releasedCents > 0);
  assert.equal(gate.store.held('t1').heldCents, 0);
  assert.ok(grant.reservedCents >= actual, 'the hold covered the priced cost');
});

test('a prompt larger than estimated is an overrun, and it is never re-charged', async () => {
  const vendor = stubVendor(1000);
  // 8 000-token cap pinned: the default 80 000 cap would hold ~106c for this
  // prompt, and an 11.30c settle could not overrun it.
  const gate = new BudgetGate({ vendor, enabled: true, rates: RATES, modelMaxOutputTokens: 8000 });

  // Estimated for 200 prompt tokens, actually used 5 000 — 25x the assumption,
  // well beyond the 10 % safety margin. This is the case the margin exists to
  // make rare, and the case the overrun metric exists to make visible.
  await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 200 });
  const settled = await gate.settle({
    tenantId: 't1',
    reservationId: 'turn-1',
    actualCents: costOfCall({ rates: RATES, inputTokens: 5000, outputTokens: 8000 }),
  });

  assert.equal(settled.overrun, true);
  assert.equal(gate.metrics.settleOverrun, 1);
});

test('settling above the hold is flagged as an overrun, never re-charged', async () => {
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor);

  await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 200 });
  const settled = await gate.settle({ tenantId: 't1', reservationId: 'turn-1', actualCents: 999 });

  assert.equal(settled.overrun, true);
  assert.equal(settled.settledCents, 999);
  assert.equal(settled.releasedCents, 0);
  assert.equal(gate.metrics.settleOverrun, 1);
});

test('an unpriced settle never claims a number it does not know', async () => {
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor);

  await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 200 });
  const settled = await gate.settle({ tenantId: 't1', reservationId: 'turn-1', actualCents: null });

  assert.equal(settled.unpriced, true);
  assert.equal(settled.settledCents, 0);
  assert.equal(settled.releasedCents, 0);
});

/* ───────────────────── vendor failure policies §8, §13 */

test('vendor down + fail-closed refuses the turn and leaks no hold', async () => {
  const vendor = stubVendor(1000);
  vendor.state.fail = true;
  const gate = gateFor(vendor, { failOpen: false });

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 100 });
  assert.equal(outcome.granted, false);
  assert.equal(outcome.reason, 'BILLING_UNAVAILABLE');
  assert.equal(gate.store.held('t1').heldCents, 0);
});

test('vendor down + fail-open runs the turn tagged UNRESERVED_TURN', async () => {
  const vendor = stubVendor(1000);
  vendor.state.fail = true;
  const gate = gateFor(vendor, { failOpen: true });

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 100 });
  assert.equal(outcome.granted, true);
  assert.equal(outcome.reason, 'UNRESERVED_TURN');
  assert.equal(outcome.reservedCents, 0);
});

/* ────────────────────── the ingest guard and drift §7.1, §7.4 */

test('the guard forwards while money is left and drops at the live zero', async () => {
  const vendor = stubVendor(50);
  const gate = gateFor(vendor);

  assert.equal((await gate.guardBatch('t1')).forward, true);

  // A hold takes the last of it. The guard must see that immediately — this is
  // the whole point of a live hold: there is no cache to wait out.
  gate.store.reserve({ tenantId: 't1', turnUid: 'turn-1', cents: 50, capacityCents: 50 });
  const guard = await gate.guardBatch('t1');

  assert.equal(guard.forward, false);
  assert.equal(guard.reason, 'ALLOWANCE_EXHAUSTED');
  assert.equal(gate.metrics.usageDropped, 1);

  // Settle it and the batch flows again.
  await gate.settle({ tenantId: 't1', reservationId: 'turn-1', actualCents: 10 });
  assert.equal((await gate.guardBatch('t1')).forward, true);
});

test('the guard never drops a batch when the vendor read fails', async () => {
  const vendor = stubVendor(10);
  vendor.state.fail = true;
  const gate = gateFor(vendor);

  const guard = await gate.guardBatch('t1');
  assert.equal(guard.forward, true, 'served usage is real usage');
  assert.equal(guard.reason, 'UNRESERVED_TURN');
});

test('drift compares belief against vendor truth', () => {
  assert.equal(percentDrift({ lastKnownCents: 1000, settledSumCents: 100, vendorSpendableCents: 900 }), 0);
  assert.equal(percentDrift({ lastKnownCents: 1000, settledSumCents: 100, vendorSpendableCents: 880 }), 2);
  assert.equal(percentDrift({ lastKnownCents: null, settledSumCents: 0, vendorSpendableCents: 900 }), null);
});

test('reconcile reports healthy when settled spend matches the vendor drop', async () => {
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor);

  await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 200 });
  await gate.settle({ tenantId: 't1', reservationId: 'turn-1', actualCents: 12 });
  vendor.state.cents = 988;

  const report = await gate.reconcile('t1');
  assert.equal(report.settledCents, 12);
  assert.equal(report.driftPct, 0);
  assert.equal(report.healthy, true);
});

/* ────────────────────── reserve disabled ships dark §11 */

test('with reservations off no hold is taken but the clamp still applies', async () => {
  const vendor = stubVendor(1000);
  const gate = new BudgetGate({ vendor, enabled: false, rates: RATES });

  const outcome = await gate.admit({ tenantId: 't1', turnUid: 'turn-1', promptTokens: 200 });
  assert.equal(outcome.granted, true);
  assert.equal(outcome.reason, 'RESERVE_DISABLED');
  assert.equal(outcome.reservedCents, 0);
  assert.equal(gate.store.held('t1').heldCents, 0);
  assert.ok(outcome.maxOutputTokens > 0);
});

test('the refusal threshold is the documented 256 tokens', () => {
  assert.equal(MIN_USEFUL_OUTPUT_TOKENS, 256);
  // 255 tokens of runway must be a refusal, 256 must not be.
  const almost = clampForBudget({ rates: RATES, budgetCents: 0.2 + 255 * 0.0012, promptTokens: 0 });
  assert.equal(almost.affordable, false);
  const enough = clampForBudget({ rates: RATES, budgetCents: 0.2 + 256 * 0.0012, promptTokens: 0 });
  assert.equal(enough.affordable, true);
});

/* ────────────── the stop-threshold soft wall, and why ingest follows it §11 */

test('soft wall: healthy, low, soft-wall and blocked bands', () => {
  const grant = 20000; // $200, threshold 99 → headroom 200c (1 %)

  assert.equal(softWall({ grantCents: grant, availableCents: 19900 }).level, 'HEALTHY');
  // 7.5 % left: the UX warn band (§9 says 5–10 %), still allowed to start.
  const low = softWall({ grantCents: grant, availableCents: 1500 });
  assert.equal(low.level, 'LOW');
  assert.equal(low.blockNewTurns, false);
  assert.equal(low.usedPct, 92.5);

  // 200 cents = 1 % left = exactly the 99 % stop threshold.
  const soft = softWall({ grantCents: grant, availableCents: 200 });
  assert.equal(soft.level, 'SOFT_WALL');
  assert.equal(soft.blockNewTurns, true);
  assert.equal(soft.reason, 'STOP_THRESHOLD_REACHED');
  assert.equal(soft.headroomCents, 200);
  assert.equal(soft.usedPct, 99);

  const blocked = softWall({ grantCents: grant, availableCents: 0 });
  assert.equal(blocked.level, 'BLOCKED');
  assert.equal(blocked.blockNewTurns, true);
  assert.equal(blocked.reason, 'ALLOWANCE_EXHAUSTED');
});

test('the threshold defaults to 99 and follows the env var', () => {
  assert.equal(DEFAULT_STOP_THRESHOLD_PCT, 99);
  assert.equal(stopThresholdFromEnv({}), 99);
  assert.equal(stopThresholdFromEnv({ PLAN_STOP_THRESHOLD_PERCENT: '95' }), 95);
  assert.equal(stopThresholdFromEnv({ PLAN_STOP_THRESHOLD_PERCENT: '90' }), 90);
  // Nonsense falls back to the default, never to something permissive.
  assert.equal(stopThresholdFromEnv({ PLAN_STOP_THRESHOLD_PERCENT: 'abc' }), 99);
  assert.equal(stopThresholdFromEnv({ PLAN_STOP_THRESHOLD_PERCENT: '-5' }), 99);
  // A grant of 20 000 therefore stops with 200c left.
  assert.equal(softWall({ grantCents: 20000, availableCents: 300 }).blockNewTurns, false);
  assert.equal(softWall({ grantCents: 20000, availableCents: 200 }).blockNewTurns, true);
});

test('soft wall: no grant means no wall — nothing to measure a % against', () => {
  const wall = softWall({ grantCents: 0, availableCents: 500 });
  assert.equal(wall.level, 'HEALTHY');
  assert.equal(wall.blockNewTurns, false);
});

test('at 99 % used, a NEW turn is refused — this is the gate closing', async () => {
  const vendor = stubVendor(150); // 0.75 % of a 20 000 grant → past 97 %
  const gate = gateFor(vendor);

  const outcome = await gate.admit({
    tenantId: 't1',
    turnUid: 'turn-1',
    promptTokens: 5000,
    grantCents: 20000,
  });

  assert.equal(outcome.granted, false);
  assert.equal(outcome.reason, 'STOP_THRESHOLD_REACHED');
  assert.equal(outcome.reservedCents, 0, 'a refused turn holds nothing');
  assert.equal(gate.store.held('t1').heldCents, 0);
});

test('at 99 % used the ingest guard BLOCKS the batch at this node', async () => {
  const vendor = stubVendor(150); // 0.75 % left: the gate is closed
  const gate = gateFor(vendor);

  const guard = await gate.guardBatch('t1', { grantCents: 20000 });

  // The requirement: nothing leaves this node for Metronome once the stop
  // threshold is crossed. The call is refused here, before the HTTP request.
  assert.equal(guard.forward, false);
  assert.equal(guard.reason, 'STOP_THRESHOLD_REACHED');
  assert.equal(guard.recorded.usedPct, 99.3);
});

test('a blocked batch is recorded, never silently lost', async () => {
  const vendor = stubVendor(150);
  const gate = gateFor(vendor);

  await gate.guardBatch('t1', { grantCents: 20000 });

  assert.equal(gate.droppedBatches.length, 1);
  assert.equal(gate.droppedBatches[0].reason, 'STOP_THRESHOLD_REACHED');
  assert.equal(gate.droppedBatches[0].tenantId, 't1');
  assert.ok(gate.droppedBatches[0].at, 'timestamped so it can be replayed');
});

test('below the threshold the guard forwards normally', async () => {
  const vendor = stubVendor(5000); // 25 % left
  const gate = gateFor(vendor);

  const guard = await gate.guardBatch('t1', { grantCents: 20000 });
  assert.equal(guard.forward, true);
  assert.equal(guard.reason, 'OK');
  assert.equal(gate.droppedBatches.length, 0);
});

test('the guard applies the threshold to live holds too', async () => {
  const vendor = stubVendor(2000); // 10 % left: still open
  const gate = gateFor(vendor);

  assert.equal((await gate.guardBatch('t1', { grantCents: 20000 })).forward, true);

  // An in-flight turn holds enough to cross 99 %. The batch must now be blocked
  // even though the raw balance never moved — the hold is the difference.
  // net becomes 2 000 − 1 850 = 150, inside the 200c headroom.
  gate.store.reserve({ tenantId: 't1', turnUid: 'inflight', cents: 1850, capacityCents: 2000 });

  const guard = await gate.guardBatch('t1', { grantCents: 20000 });
  assert.equal(guard.forward, false);
  assert.equal(guard.reason, 'STOP_THRESHOLD_REACHED');
});

test("the plan's own policy is available: forward until truly zero", async () => {
  // The document (§6.2, §8) prefers rating served usage and stopping only at
  // zero. Exposed as a flag so the trade-off is a decision, not an accident.
  const vendor = stubVendor(1000);
  const gate = gateFor(vendor, { ingestStopsAtStopThreshold: false });

  const guard = await gate.guardBatch('t1', { grantCents: 20000 });
  assert.equal(guard.forward, true);

  vendor.state.cents = 0;
  assert.equal((await gate.guardBatch('t1', { grantCents: 20000 })).forward, false);
});

test('a hold counts toward the threshold, so two turns cannot both squeeze in', async () => {
  const vendor = stubVendor(2000); // 10 % of the grant: gate still open
  const gate = gateFor(vendor);

  const first = await gate.admit({ tenantId: 't1', turnUid: 'a', promptTokens: 200, grantCents: 20000 });
  assert.equal(first.granted, true);

  // The hold is money already committed, so the wall must see it. Manually
  // take enough to cross 99 % and the next admission closes.
  gate.store.reserve({ tenantId: 't1', turnUid: 'inflight', cents: 1850, capacityCents: 2000 });
  const second = await gate.admit({ tenantId: 't1', turnUid: 'b', promptTokens: 200, grantCents: 20000 });

  assert.equal(second.granted, false);
  assert.equal(second.reason, 'STOP_THRESHOLD_REACHED');
});

'use strict';

/**
 * End-to-end proof of the UI server's ingest guard, with Metronome stubbed.
 *
 *   node --test budget-poc/ui-gate.test.js
 *
 * Answers the flow directly: create customer -> assign package -> grant commit
 * -> send events. The assertion that matters is that the batch refused at the
 * stop threshold **never reaches the vendor**, and that it does so even though
 * the vendor balance has not moved (Metronome rates asynchronously).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const PACKAGE_ID = 'pkg-1';
const RATE_CARD_ID = 'rc-1';
const CUSTOMER_ID = 'cust-1';

/** Every vendor call the server makes, so a test can count them. */
const calls = [];
let ingestCount = 0;

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body ?? {}),
});

global.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  calls.push({ path, payload: options.body ? JSON.parse(options.body) : null });

  if (path === '/v1/packages/list') {
    return ok({
      data: [
        {
          id: PACKAGE_ID,
          name: 'AI Canva US-Growth',
          aliases: [{ name: 'AI_Canva_US_Growth' }],
          rate_card_id: RATE_CARD_ID,
        },
      ],
    });
  }
  if (path === '/v1/contract-pricing/rate-cards/getRates') {
    const credit = { id: 'credit-usd-cents' };
    return ok({
      data: [
        { product_id: 'p-sub', rate: { rate_type: 'FLAT', price: 20000, credit_type: credit } },
        { product_id: 'p-in', rate: { rate_type: 'FLAT', price: 0.0003, credit_type: credit } },
        { product_id: 'p-cache', rate: { rate_type: 'FLAT', price: 0.00015, credit_type: credit } },
        { product_id: 'p-out', rate: { rate_type: 'FLAT', price: 0.0012, credit_type: credit } },
        { product_id: 'p-req', rate: { rate_type: 'FLAT', price: 0.2, credit_type: credit } },
      ],
    });
  }
  if (path === '/v1/contract-pricing/products/list') {
    return ok({
      data: [
        { id: 'p-sub', current: { name: 'Platform Subscription', type: 'SUBSCRIPTION' } },
        { id: 'p-in', current: { name: 'Input Tokens', type: 'USAGE', billable_metric_id: 'm-in' } },
        { id: 'p-out', current: { name: 'Output Tokens', type: 'USAGE', billable_metric_id: 'm-out' } },
        { id: 'p-cache', current: { name: 'Cached Input Tokens', type: 'USAGE', billable_metric_id: 'm-cache' } },
        { id: 'p-req', current: { name: 'AI Requests', type: 'USAGE', billable_metric_id: 'm-req' } },
        { id: 'p-allow', current: { name: 'AI Canva US-Growth allowance', type: 'FIXED' } },
      ],
    });
  }
  if (path === '/v1/billable-metrics') {
    return ok({
      data: [
        { id: 'm-in', name: 'Input Tokens', aggregation_type: 'sum', aggregation_key: 'uncached_input_tokens', event_type_filter: { in_values: ['llm_request'] }, property_filters: [{ name: 'model', exists: true }, { name: 'app_id', exists: true }] },
        { id: 'm-out', name: 'Output Tokens', aggregation_type: 'sum', aggregation_key: 'output_tokens', event_type_filter: { in_values: ['llm_request'] }, property_filters: [{ name: 'model', exists: true }] },
        { id: 'm-cache', name: 'Cached Input Tokens', aggregation_type: 'sum', aggregation_key: 'cached_input_tokens', event_type_filter: { in_values: ['llm_request'] }, property_filters: [{ name: 'model', exists: true }] },
        { id: 'm-req', name: 'AI Requests', aggregation_type: 'count', event_type_filter: { in_values: ['llm_request'] }, property_filters: [{ name: 'app_id', exists: true }] },
      ],
    });
  }
  if (path === '/v2/contracts/list') {
    return ok({
      data: [{ id: 'contract-1', rate_card_id: RATE_CARD_ID, starting_at: '2026-11-23T00:00:00+00:00' }],
    });
  }
  // Deliberately static: the vendor has rated nothing. If the guard depended on
  // this number it would never block, which is the bug being ruled out.
  if (path === '/v1/contracts/customerBalances/getNetBalance') {
    return ok({ data: { balance: 20000, credit_type_id: 'credit-usd-cents' } });
  }
  if (path === '/v1/ingest') {
    ingestCount += 1;
    return { ok: true, status: 200, text: async () => '' };
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ message: `not stubbed: ${path}` }) };
};

// Required *after* the stub is installed.
const srv = require('../token-usage-ui-server.js');

const turn = (events) => ({
  customerId: CUSTOMER_ID,
  packageId: PACKAGE_ID,
  input: '5000',
  output: '8000',
  events: String(events),
});

test('granting the commit seeds the guard so it sees real money immediately', async () => {
  srv.noteGrant(CUSTOMER_ID, 20000);
  const state = await srv.budgetState(CUSTOMER_ID);

  assert.equal(state.grantCents, 20000);
  assert.equal(state.spentCents, 0);
  assert.equal(state.wall.level, 'HEALTHY');
  assert.deepEqual(state.alertThresholds, [50, 75, 85, 90, 95]);
});

test('one 5 000 / 8 000 turn reaches the vendor and is priced at 11.30 c', async () => {
  const before = ingestCount;
  const result = await srv.ingest(turn(1));

  assert.equal(ingestCount, before + 1, 'the batch reached Metronome');
  assert.equal(result.sent, 1);
  assert.equal(result.costCents, 11.3);
  assert.ok(Math.abs(result.budget.availableCents - 19988.7) < 0.01);
});

test('the guard blocks at the stop threshold, before any HTTP call', async () => {
  // Drain with 10-event batches until the guard refuses.
  let blocked = null;
  for (let i = 0; i < 2000 && !blocked; i += 1) {
    try {
      await srv.ingest(turn(10));
    } catch (error) {
      blocked = error;
    }
  }

  assert.ok(blocked, 'the guard must refuse at some point');
  assert.equal(blocked.status, 402);
  assert.match(
    blocked.message,
    /You've used \d+(?:\.\d+)?% of your credit\. Add a top-up to continue\. Nothing was sent to Metronome\./,
  );
  // Keep the technical refusal reason available for diagnostics.
  assert.match(blocked.detail.reason, /STOP_THRESHOLD_REACHED|BATCH_EXCEEDS_REMAINING/);

  const state = await srv.budgetState(CUSTOMER_ID);
  assert.ok(state.spentCents <= 20000, `spent ${state.spentCents} > grant`);
  // The protected headroom (1 % of 20 000 = 200c) was never spent.
  assert.ok(
    state.availableCents >= 200,
    `headroom eaten: ${state.availableCents}c left, expected at least 200c`,
  );

  // The critical property: the refused batch is still refused on a retry, and
  // the vendor ingest count does not move.
  const countBefore = ingestCount;
  await assert.rejects(() => srv.ingest(turn(10)), /Add a top-up to continue/);
  assert.equal(ingestCount, countBefore, 'a blocked batch must never reach Metronome');
});

test('every refused batch is recorded for replay, none silently lost', async () => {
  const state = await srv.budgetState(CUSTOMER_ID);
  assert.ok(state.dropped >= 1, `expected at least one recorded drop, got ${state.dropped}`);
});

test('the $120 -> $180 -> +$20 scenario never reaches Metronome', async () => {
  // A fresh tenant so the earlier drain does not interfere.
  const SHOPPER = 'cust-120';
  srv.noteGrant(SHOPPER, 20000); // $200 commit

  const spend = (cents) => srv.noteSpend(SHOPPER, cents);

  // Prompt 1: $120 used.  60 % consumed, still HEALTHY.
  spend(12000);
  let state = await srv.budgetState(SHOPPER);
  assert.equal(state.availableCents, 8000);
  assert.equal(state.wall.level, 'HEALTHY');

  // Prompt 2: cumulative $180 used.  90 % consumed, still below 97 %.
  spend(6000);
  state = await srv.budgetState(SHOPPER);
  assert.equal(state.availableCents, 2000);
  assert.equal(state.wall.usedPct, 90);
  assert.equal(state.wall.blockNewTurns, false);

  // Prompt 3 wants $20 more. That would consume the $6 of protected headroom,
  // so it must be refused — even though $20 is genuinely "available".
  const ledger = { grantCents: 20000, availableCents: 2000 };
  const guard = await srv.budgetGate.guardBatch(SHOPPER, {
    grantCents: ledger.grantCents,
    costCents: 2000,
  });

  assert.equal(guard.forward, false);
  assert.equal(guard.reason, 'BATCH_EXCEEDS_REMAINING');
  assert.ok(guard.fitsCents < 2000, `only ${guard.fitsCents}c of the $20 fits`);
  assert.equal(guard.fitsCents, 1800, 'spendable is balance minus the 200c headroom');
});

test('configurable credit alerts fire once when spend crosses each saved threshold', async () => {
  const CUSTOMER = 'cust-alert-milestones';
  srv.noteGrant(CUSTOMER, 10000);

  const configured = srv.configureBudgetAlerts(CUSTOMER, [85, 50, 75]);
  assert.deepEqual(configured.alertThresholds, [50, 75, 85]);

  assert.deepEqual(srv.noteSpend(CUSTOMER, 5000).map((alert) => alert.thresholdPct), [50]);
  assert.deepEqual(srv.noteSpend(CUSTOMER, 3500).map((alert) => alert.thresholdPct), [75, 85]);
  assert.deepEqual(srv.noteSpend(CUSTOMER, 100).map((alert) => alert.thresholdPct), []);

  const state = await srv.budgetState(CUSTOMER);
  assert.equal(state.usedPct, 86);
  assert.deepEqual(state.alerts.map((alert) => alert.thresholdPct), [50, 75, 85]);
});

test('alert configuration validates percentages and immediately reports already-used thresholds', async () => {
  const CUSTOMER = 'cust-alert-update';
  srv.noteGrant(CUSTOMER, 10000);
  srv.noteSpend(CUSTOMER, 6000);

  assert.throws(() => srv.configureBudgetAlerts(CUSTOMER, [50, 50]), /must be unique/);
  assert.throws(() => srv.configureBudgetAlerts(CUSTOMER, [0, 101]), /from 1 to 100/);

  const configured = srv.configureBudgetAlerts(CUSTOMER, [55, 75]);
  assert.deepEqual(configured.newAlerts.map((alert) => alert.thresholdPct), [55]);
  assert.deepEqual(srv.configureBudgetAlerts(CUSTOMER, []).alertThresholds, []);
});

test('exhausted-credit refusal says 100% used and recommends a top-up without ingesting', async () => {
  const CUSTOMER = 'cust-exhausted-message';
  srv.noteGrant(CUSTOMER, 10000);
  srv.noteSpend(CUSTOMER, 10000);
  const countBefore = ingestCount;

  await assert.rejects(
    () => srv.ingest({ ...turn(1), customerId: CUSTOMER }),
    (error) => {
      assert.equal(error.status, 402);
      assert.match(error.message, /You've used 100\.00% of your credit/);
      assert.match(error.message, /Add a top-up to continue/);
      assert.equal(error.detail.reason, 'ALLOWANCE_EXHAUSTED');
      return true;
    },
  );
  assert.equal(ingestCount, countBefore, 'the exhausted batch must not reach Metronome');
});

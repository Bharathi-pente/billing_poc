'use strict';

/**
 * Live proof of AI_BUDGET_ENFORCEMENT_PLAN.md — the incident, replayed.
 *
 *   node budget-poc/run.js
 *
 * Deterministic, offline, and read-only: it never calls Metronome. The vendor
 * balance is a stub so the two designs can be compared under identical traffic.
 *
 * What it demonstrates, in the plan's own terms:
 *   §1   the invariant — overshoot bounded by one in-flight request
 *   §2.1 the incident — stale admission × concurrency
 *   §7.3 the clamp — shorten before refusing
 *   §9   the 402 — refuse only when nothing useful fits
 */

const {
  ASSUMED_RATES,
  clampForBudget,
  costOfCall,
  estimatePromptTokens,
  MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_STOP_THRESHOLD_PCT,
} = require('./budget');
const { deriveRates } = require('./rate-card');
const { BudgetGate } = require('./gate');

/**
 * Rates for the offline demo.
 *
 * A *named* snapshot of the live card, never a default: the production path
 * derives rates from the tenant's own card (`rate-card.js` → `deriveRates`), and
 * `clampForBudget` / `costOfCall` throw when handed none.
 */
const RATES = ASSUMED_RATES;

const PLAN_CENTS = 20000; // $200 plan allowance
const FIVE_PERCENT_CENTS = Math.floor(PLAN_CENTS * 0.02); // 1 000 = the "5 % left" case
const TURN = { inputTokens: 5000, outputTokens: 8000 };
const TURN_COST = costOfCall({ ...TURN, rates: RATES });

const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const cents = (c) => `${Number(c).toFixed(2)}c`;
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const line = (n = 76) => '-'.repeat(n);
const heading = (title) => {
  console.log('');
  console.log(line());
  console.log(title);
  console.log(line());
};

/**
 * The design we shipped: one cached decision, admitted for every turn inside
 * the 300 s window, no per-turn ceiling (§6.2 gaps 1, 2 and 5).
 */
function simulateLegacy({ spendableCents, turns }) {
  // Every turn inside the cache window reads the same figure, so every turn is
  // admitted. This is not a exaggeration — it is the mechanism.
  const admitted = turns; // spendableCents > 0 for all of them
  const spentCents = admitted * TURN_COST;
  return {
    admitted,
    refused: 0,
    shortened: 0,
    spentCents,
    overshootCents: Math.max(0, spentCents - spendableCents),
  };
}

/** The design the plan prescribes: reserve -> clamp -> settle. */
async function simulateGate({ spendableCents, turns, label }) {
  const vendor = { spendableCents: async () => spendableCents };
  const gate = new BudgetGate({ vendor, enabled: true, rates: RATES });

  // Fire them together: the point is that they contend for the same money.
  const outcomes = await Promise.all(
    Array.from({ length: turns }, (_, i) =>
      gate.admit({ tenantId: 'tenant-1', turnUid: `${label}-turn-${i}`, promptTokens: TURN.inputTokens }),
    ),
  );

  const granted = outcomes.filter((o) => o.granted);

  // Settle each granted turn at the real price of what it generated.
  for (const outcome of granted) {
    const outputTokens = outcome.maxOutputTokens;
    await gate.settle({
      tenantId: 'tenant-1',
      reservationId: outcome.reservationId,
      actualCents: costOfCall({ ...TURN, outputTokens, rates: RATES }),
    });
  }

  const spentCents = granted.reduce(
    (sum, o) => sum + costOfCall({ ...TURN, outputTokens: o.maxOutputTokens, rates: RATES }),
    0,
  );

  return {
    admitted: granted.length,
    refused: outcomes.length - granted.length,
    shortened: granted.filter((o) => o.truncated).length,
    spentCents,
    overshootCents: Math.max(0, spentCents - spendableCents),
    metrics: gate.metrics,
  };
}

function row(label, legacy, modern) {
  console.log(
    `  ${pad(label, 26)} ${padL(legacy, 14)} ${padL(modern, 16)}`,
  );
}

async function incident() {
  const turns = 100;
  heading(`The incident: ${turns} concurrent turns with 5 % of the plan left`);
  console.log(
    `  plan ${money(PLAN_CENTS)}, spendable ${money(FIVE_PERCENT_CENTS)}, ` +
      `one turn ${cents(TURN_COST)} (5 000 in / 8 000 out)`,
  );
  console.log('');

  const legacy = simulateLegacy({ spendableCents: FIVE_PERCENT_CENTS, turns });
  const modern = await simulateGate({
    spendableCents: FIVE_PERCENT_CENTS,
    turns,
    label: 'incident',
  });

  console.log(`  ${pad('', 26)} ${padL('legacy', 14)} ${padL('reserve+clamp', 16)}`);
  row('turns admitted', legacy.admitted, modern.admitted);
  row('turns refused (402)', legacy.refused, modern.refused);
  row('answers shortened', legacy.shortened, modern.shortened);
  row('spent', money(legacy.spentCents), money(modern.spentCents));
  row('spendable', money(FIVE_PERCENT_CENTS), money(FIVE_PERCENT_CENTS));
  row('OVERSHOOT', money(legacy.overshootCents), money(modern.overshootCents));

  console.log('');
  if (modern.overshootCents === 0) {
    console.log(`  PASS  the new design spent at most the balance, by construction.`);
  } else {
    console.log(`  FAIL  overshoot ${money(modern.overshootCents)} — the invariant is broken.`);
    process.exitCode = 1;
  }
  if (legacy.overshootCents > 0) {
    console.log(
      `  note  the legacy path billed ${money(legacy.overshootCents)} it was never given, ` +
        `exactly the shape of the $200 -> $480 report.`,
    );
  }
  console.log(
    `  note  the gate holds ~${cents(modern.admitted ? modern.spentCents / modern.admitted : 0)} ` +
      `of real cost per turn but reserves 10 % more, so it refuses a few turns that would ` +
      `have fitted. That is the safety margin (BILLING_ESTIMATE_SAFETY_MARGIN_PCT) — ` +
      `it trades a little headroom for the guarantee.`,
  );
}

async function ramp() {
  heading('Why it got worse: the overshoot scales with traffic, not with the plan');
  console.log(
    `  Every point below is the same 5 % starting balance and the same turn cost; ` +
      `only concurrency changes.`,
  );
  console.log('');
  console.log(`  ${padL('turns', 8)} ${padL('legacy spent', 15)} ${padL('gate spent', 14)} ${padL('legacy over', 13)} ${padL('gate over', 11)}`);

  for (const turns of [10, 50, 100, 500, 2000]) {
    const legacy = simulateLegacy({ spendableCents: FIVE_PERCENT_CENTS, turns });
    const modern = await simulateGate({
      spendableCents: FIVE_PERCENT_CENTS,
      turns,
      label: `ramp-${turns}`,
    });
    console.log(
      `  ${padL(turns, 8)} ${padL(money(legacy.spentCents), 15)} ${padL(money(modern.spentCents), 14)} ` +
        `${padL(money(legacy.overshootCents), 13)} ${padL(money(modern.overshootCents), 11)}`,
    );
  }
  console.log('');
  console.log('  The gate column is flat at the balance. That is the invariant.');
}

function clampLadder() {
  heading('§7.3 / §9 — the wall is negotiable, the ceiling is not');
  console.log(
    `  Same prompt (${estimatePromptTokens('x'.repeat(8000))} tokens), shrinking budget. ` +
      `Shorten while a useful answer still fits, refuse below it.`,
  );
  console.log('');
  console.log(`  ${padL('budget', 11)} ${padL('maxOutput', 11)} ${padL('holds', 9)}  outcome`);

  const promptTokens = estimatePromptTokens('x'.repeat(8000));
  for (const budgetCents of [200, 50, 20, 10, 9, 5, 2, 1]) {
    const clamp = clampForBudget({ budgetCents, promptTokens, rates: RATES });
    const outcome = clamp.affordable
      ? clamp.truncated
        ? `shortened (${clamp.maxOutputTokens} of ${MODEL_MAX_OUTPUT_TOKENS} tokens)`
        : 'full length'
      : `402 — needs ${cents(clamp.minimumCents)}`;
    console.log(
      `  ${padL(cents(budgetCents), 11)} ${padL(clamp.affordable ? clamp.maxOutputTokens : 0, 11)} ` +
        `${padL(cents(clamp.reserveCents), 9)}  ${outcome}`,
    );
  }
}

async function failureModes() {
  heading('§8 — failure and edge-case matrix');

  const unmetered = new BudgetGate({ vendor: { spendableCents: async () => null }, enabled: true, rates: RATES });
  const unmeteredOutcome = await unmetered.admit({
    tenantId: 't',
    turnUid: 'u1',
    promptTokens: 2000,
  });

  const failing = new BudgetGate({
    vendor: { spendableCents: async () => { throw new Error('metronome 503'); } },
    enabled: true,
    failOpen: false,
    rates: RATES,
  });
  const closed = await failing.admit({ tenantId: 't', turnUid: 'u2', promptTokens: 100 });

  const failingOpen = new BudgetGate({
    vendor: { spendableCents: async () => { throw new Error('metronome 503'); } },
    enabled: true,
    failOpen: true,
    rates: RATES,
  });
  const open = await failingOpen.admit({ tenantId: 't', turnUid: 'u3', promptTokens: 100 });

  console.log(`  ${pad('nothing metered', 28)} ${unmeteredOutcome.reason} — granted=${unmeteredOutcome.granted}, held=${unmeteredOutcome.reservedCents}c`);
  console.log(`  ${pad('vendor down, fail-closed', 28)} ${closed.reason} — granted=${closed.granted}`);
  console.log(`  ${pad('vendor down, fail-open', 28)} ${open.reason} — granted=${open.granted}, tagged for the ingest backstop`);
}

async function walls() {
    heading(`§11 — the guard that stops a batch at this node (threshold ${DEFAULT_STOP_THRESHOLD_PCT} %)`);
  console.log(
      `  Nothing leaves this process for Metronome once the balance is short: the check\n` +
        `  runs here, before the HTTP call.  Below ${DEFAULT_STOP_THRESHOLD_PCT} % used the batch is forwarded;\n` +
        `  at or past it the batch is DROPPED and recorded for replay after a top-up.\n` +
        `  Headroom retained: ${money(Math.floor(PLAN_CENTS * (100 - DEFAULT_STOP_THRESHOLD_PCT) / 100))} of ${money(PLAN_CENTS)}.`,
  );
  console.log('');
  console.log(
      `  ${padL('spendable', 12)} ${padL('used', 8)} ${padL('level', 12)} ${padL('new turn', 26)} ${padL('ingest', 20)}`,
  );

  const grant = PLAN_CENTS;
    // The interesting rows are around the headroom: 3 % of $200 is $6.00.
    for (const availableCents of [20000, 10000, 2400, 1500, 700, 600, 300, 0]) {
    const vendor = { spendableCents: async () => availableCents };
    const gate = new BudgetGate({ vendor, enabled: true, rates: RATES });
    const outcome = await gate.admit({
      tenantId: 'walls',
      turnUid: `w-${availableCents}`,
      promptTokens: TURN.inputTokens,
      grantCents: grant,
    });
      const guard = await gate.guardBatch('walls', { grantCents: grant });
    const wall = gate.wall('walls', { grantCents: grant, availableCents });

    const verdict = outcome.granted
      ? outcome.truncated
          ? 'shortened'
        : 'allowed'
      : outcome.reason;
      const ingest = guard.forward ? 'forward' : `DROP (${guard.reason})`;
    console.log(
      `  ${padL(money(availableCents), 12)} ${padL(wall.usedPct + '%', 8)} ${padL(wall.level, 12)} ` +
          `${padL(verdict, 26)} ${padL(ingest, 20)}`,
    );
  }
  console.log('');
    console.log('  Every DROP is pushed to gate.droppedBatches — with tenant, reason, spendable,');
    console.log('  held and timestamp — so a top-up can replay it. A drop is never silent.');
}

async function rateCardSection() {
  heading('Rates come from the rate card, not from a constant');

  // The exact payloads the vendor returns for Pente US Growth Pricing, captured
  // live. `deriveRates` maps them by metric semantics, so a product rename
  // cannot move a price.
  const fixture = {
    rateCardId: 'b2da63b7-cac0-412b-83a6-da0215f73c3e',
    products: [
      { id: 'p-sub', current: { name: 'Platform Subscription', type: 'SUBSCRIPTION' } },
      { id: 'p-in', current: { name: 'Input Tokens', type: 'USAGE', billable_metric_id: 'm-in' } },
      { id: 'p-out', current: { name: 'Output Tokens', type: 'USAGE', billable_metric_id: 'm-out' } },
      { id: 'p-cache', current: { name: 'Cached Input Tokens', type: 'USAGE', billable_metric_id: 'm-cache' } },
      { id: 'p-req', current: { name: 'AI Requests', type: 'USAGE', billable_metric_id: 'm-req' } },
      { id: 'p-test-in', current: { name: 'Test Input Tokens', type: 'USAGE', billable_metric_id: 'm-in' } },
    ],
    metrics: [
      { id: 'm-in', aggregation_type: 'sum', aggregation_key: 'uncached_input_tokens' },
      { id: 'm-out', aggregation_type: 'sum', aggregation_key: 'output_tokens' },
      { id: 'm-cache', aggregation_type: 'sum', aggregation_key: 'cached_input_tokens' },
      { id: 'm-req', aggregation_type: 'count', aggregation_key: null },
    ],
    rates: [
      { product_id: 'p-sub', rate: { rate_type: 'FLAT', price: 20000, credit_type: { name: 'USD (cents)' } } },
      { product_id: 'p-in', rate: { rate_type: 'FLAT', price: 0.0003, credit_type: { name: 'USD (cents)' } } },
      { product_id: 'p-out', rate: { rate_type: 'FLAT', price: 0.0012, credit_type: { name: 'USD (cents)' } } },
      { product_id: 'p-cache', rate: { rate_type: 'FLAT', price: 0.00015, credit_type: { name: 'USD (cents)' } } },
      { product_id: 'p-req', rate: { rate_type: 'FLAT', price: 0.2, credit_type: { name: 'USD (cents)' } } },
      { product_id: 'p-test-in', rate: { rate_type: 'FLAT', price: 0.0003, credit_type: { name: 'USD (cents)' } } },
    ],
  };

  const derived = deriveRates(fixture);
  console.log(`  card      ${derived.rateCardId}   credit type ${derived.creditTypeName}`);
  console.log('');
  for (const [slot, meta] of Object.entries(derived.sources)) {
    console.log(
      `  ${pad(slot, 26)} ${padL(meta.price, 10)}  from "${meta.productName}" via ${meta.metric} (${meta.rateType})`,
    );
  }
  console.log('');
  const matches =
    derived.inputCentsPerToken === ASSUMED_RATES.inputCentsPerToken &&
    derived.cachedInputCentsPerToken === ASSUMED_RATES.cachedInputCentsPerToken &&
    derived.outputCentsPerToken === ASSUMED_RATES.outputCentsPerToken &&
    derived.requestFeeCents === ASSUMED_RATES.requestFeeCents;
  console.log(
    `  ${matches ? 'MATCH' : 'DIFFERS'}  the derived rates ${matches ? 'equal' : 'do not equal'} the snapshot this demo uses.`,
  );
  console.log('  The gate refuses to run without a derived card: a wrong rate is a silent billing error.');
}

(async () => {
  console.log('');
  console.log('  AI budget enforcement — POC');
  console.log(`  rates: input 0.0003c, cached 0.00015c, output 0.0012c, request 0.2c per request`);
  console.log(`  (the plan document prices the request fee at 20c; the live card says 0.2c)`);

  await incident();
  await ramp();
  clampLadder();
  await walls();
  await failureModes();
  await rateCardSection();

  console.log('');
  console.log(line());
  console.log('  Tests: node --test budget-poc/budget.test.js');
  console.log(line());
  console.log('');
})();

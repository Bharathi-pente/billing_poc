'use strict';

/**
 * Budget enforcement arithmetic — the mathematical half of
 * AI_BUDGET_ENFORCEMENT_PLAN.md §7.3.
 *
 * Pure on purpose: no clock, no network, no store. Everything here is a
 * function of its arguments, so the clamp can be proven with unit tests instead
 * of inferred from traffic.
 *
 * **Rates are never assumed.** Every function here takes an explicit `rates`
 * object and throws without one. The rates come from the tenant's live rate card
 * (`rate-card.js`), because a wrong constant is a silent 100x billing error — the
 * plan document itself carries one (`AI Requests` is 0.2 cents per request on the
 * live card, not the 20 it assumes in §2).
 */

/**
 * A snapshot of the live **Pente US Growth Pricing** card (credit type
 * `USD (cents)`), verified 2026-11-24.
 *
 * Only for offline demos and unit tests, and only when a caller names it
 * explicitly. Nothing in the gate reaches for it on its own.
 */
const ASSUMED_RATES = {
  inputCentsPerToken: 0.0003,
  cachedInputCentsPerToken: 0.00015,
  outputCentsPerToken: 0.0012,
  requestFeeCents: 0.2,
};

/** Every rate slot the clamp cannot work without. */
const REQUIRED_RATE_KEYS = [
  'inputCentsPerToken',
  'cachedInputCentsPerToken',
  'outputCentsPerToken',
  'requestFeeCents',
];

/**
 * Refuse to compute money without a real rate card behind it.
 *
 * Failing loudly here is the point: a default would silently price a turn with
 * another tenant's (or another year's) card, and the only symptom would be an
 * invoice that disagrees with the vendor.
 */
function assertRates(rates, where) {
  if (!rates || typeof rates !== 'object') {
    throw new Error(
      `[budget] ${where}: rates are required. Load them from the tenant's rate card ` +
        `(rate-card.js) — never assume. Pass ASSUMED_RATES explicitly for offline tests.`,
    );
  }
  const missing = REQUIRED_RATE_KEYS.filter((key) => !Number.isFinite(Number(rates[key])));
  if (missing.length) {
    throw new Error(
      `[budget] ${where}: rate card is incomplete — missing ${missing.join(', ')}.`,
    );
  }
  return rates;
}

/** Below this an answer is broken, not shortened — refuse instead (§7.3). */
const MIN_USEFUL_OUTPUT_TOKENS = 256;

/** `gemini_max_tokens` today; the clamp can only lower it. */
const MODEL_MAX_OUTPUT_TOKENS = 80000;

/** Inflation applied to the estimate so the chain never lands above the hold. */
const DEFAULT_SAFETY_MARGIN_PCT = 10;

/** `PLAN_STOP_THRESHOLD_PERCENT` — stop *starting* turns at this share used. */
const DEFAULT_STOP_THRESHOLD_PCT = 99;

/**
 * Read `PLAN_STOP_THRESHOLD_PERCENT`, the same variable the Tenant Service uses,
 * so the POC and production are tuned by one knob. Anything unusable falls back
 * to the default rather than to a permissive value.
 */
function stopThresholdFromEnv(env = process.env) {
  const raw = Number(env?.PLAN_STOP_THRESHOLD_PERCENT);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STOP_THRESHOLD_PCT;
  return Math.min(100, Math.max(1, raw));
}

/**
 * Prompt size without a tokenizer.
 *
 * 4 characters per token is the usual English approximation. The bias is
 * deliberate: over-estimating the prompt shrinks the answer by a token or two,
 * under-estimating it overruns the reservation.
 */
function estimatePromptTokens(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  let chars = 0;
  for (const message of list) {
    const text =
      typeof message === 'string'
        ? message
        : String((message && (message.content ?? message.text)) ?? '');
    // Per-message envelope (role, separators) is real tokens the model bills.
    chars += text.length + 8;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

const cents = (value) => Math.round(Number(value || 0) * 10000) / 10000;

/**
 * The clamp (§7.3).
 *
 * `budgetCents` is what *this turn* may consume — `vendorSpendable - held`,
 * already net of other in-flight turns. The output cap is derived from what is
 * left after the prompt and the request fee are paid for, so the generation
 * physically cannot exceed the reservation.
 *
 * Returns `affordable: false` when the prompt alone does not fit.
 */
function clampForBudget(input) {
  const rates = assertRates(input.rates, 'clampForBudget');
  const modelMax = Math.max(
    1,
    Math.floor(input.modelMaxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS),
  );
  const promptTokens = Math.max(0, Math.floor(input.promptTokens ?? 0));
  const cachedTokens = Math.max(0, Math.floor(input.cachedTokens ?? 0));
  const uncachedTokens = Math.max(0, promptTokens - cachedTokens);

  const promptCostCents =
    uncachedTokens * rates.inputCentsPerToken +
    cachedTokens * rates.cachedInputCentsPerToken;
  const requestCostCents = rates.requestFeeCents;
  const budgetCents = Number(input.budgetCents ?? 0);
  const availableForOutputCents = budgetCents - promptCostCents - requestCostCents;
  const minimumCents = Math.ceil(
    promptCostCents +
      requestCostCents +
      MIN_USEFUL_OUTPUT_TOKENS * rates.outputCentsPerToken,
  );

  // The floor of a negative ratio is not "zero tokens", it is "cannot run":
  // the prompt and the request fee already cost more than the budget.
  if (availableForOutputCents <= 0) {
    return {
      affordable: false,
      maxOutputTokens: 0,
      promptCostCents: cents(promptCostCents),
      requestCostCents: cents(requestCostCents),
      availableForOutputCents: 0,
      // Exact, unrounded: the caller applies the safety margin to this and
      // ceils once. Rounding here first and inflating second loses the
      // fraction and can leave the hold below the true ceiling.
      reserveExactCents: promptCostCents + requestCostCents,
      reserveCents: Math.ceil(promptCostCents + requestCostCents),
      truncated: false,
      minimumCents,
    };
  }

  const byMoney = Math.floor(availableForOutputCents / rates.outputCentsPerToken);
  const maxOutputTokens = Math.min(modelMax, byMoney);
  const reserveExactCents =
    promptCostCents +
    requestCostCents +
    maxOutputTokens * rates.outputCentsPerToken;

  return {
    affordable: maxOutputTokens >= MIN_USEFUL_OUTPUT_TOKENS,
    maxOutputTokens: Math.max(0, maxOutputTokens),
    promptCostCents: cents(promptCostCents),
    requestCostCents: cents(requestCostCents),
    availableForOutputCents: cents(availableForOutputCents),
    reserveExactCents,
    reserveCents: Math.ceil(reserveExactCents),
    truncated: maxOutputTokens < modelMax,
    minimumCents,
  };
}

/**
 * What to hold. The safety margin covers the gap between the estimate and the
 * priced settle, so the chain cannot land above the ceiling (§11).
 */
function reserveFromEstimate(estimateCents, marginPct = DEFAULT_SAFETY_MARGIN_PCT) {
  const pct = Number.isFinite(marginPct) ? Math.max(0, marginPct) : 0;
  const exact = Number(estimateCents || 0) * (1 + pct / 100);
  // Round to a tenth of a cent first: `10 * 1.1` is 11.000000000000002 in
  // floating point, and a bare ceil would charge 12 for an 11-cent turn.
  return Math.max(0, Math.ceil(Math.round(exact * 1000) / 1000));
}

/**
 * Running budget for a multi-call turn (§7.3).
 *
 * One reservation covers the whole turn, so each LLM call draws from the same
 * hold and every `max_output_tokens` is recomputed from what is left. Without
 * this a pipeline of four calls would each reserve the full budget.
 */
class TurnBudget {
  constructor({ reserveCents, rates, modelMaxOutputTokens } = {}) {
    this.reserveCents = Math.max(0, Math.ceil(Number(reserveCents || 0)));
    this.remainingCents = this.reserveCents;
    this.rates = assertRates(rates, 'TurnBudget');
    this.modelMaxOutputTokens = modelMaxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS;
    this.calls = [];
    this.exhausted = false;
  }

  /**
   * Ask what the next call may generate. Returns `affordable: false` once the
   * turn can no longer pay for prompt + fee + a useful answer — the caller then
   * returns the partial answer with an explicit notice instead of truncating
   * silently.
   */
  next(promptTokens, cachedTokens = 0) {
    if (this.exhausted) {
      return { affordable: false, maxOutputTokens: 0, exhausted: true };
    }
    const clamp = clampForBudget({
      budgetCents: this.remainingCents,
      promptTokens,
      cachedTokens,
      rates: this.rates,
      modelMaxOutputTokens: this.modelMaxOutputTokens,
    });
    if (!clamp.affordable) this.exhausted = true;
    return { ...clamp, exhausted: !clamp.affordable };
  }

  /** Record what a call actually used, so the next clamp sees less money. */
  consume(actualCents) {
    const spent = Math.max(0, Number(actualCents || 0));
    this.remainingCents = Math.max(0, this.remainingCents - spent);
    this.calls.push({
      spentCents: cents(spent),
      remainingCents: cents(this.remainingCents),
    });
    return this.remainingCents;
  }
}

/**
 * The admission rule for one turn (§7.1).
 *
 * `availableCents` is the vendor's spendable figure. `null` means nothing is
 * metered: there is no allowance to exhaust, so the turn must keep working
 * (§8). A decision that is already denied keeps its own reason, because
 * "renew your plan" is more actionable than "add credit".
 */
function applyHolds(decision, heldCents) {
  const held = Number.isFinite(heldCents) ? Math.max(0, Math.round(heldCents)) : 0;
  const base = { ...decision, heldCents: held };

  if (!decision.metered || held <= 0 || !decision.allowed) return base;

  const net = Math.max(0, Number(decision.availableCents || 0) - held);
  if (net > 0) return { ...base, availableCents: net };

  return {
    ...base,
    allowed: false,
    availableCents: 0,
    reason: 'ALLOWANCE_EXHAUSTED',
    message: 'You have used your plan limit. Add credit to keep using the assistant.',
  };
}

/**
 * The `402` body (§9). A 402 is more honest than a 429 — nothing here is rate
 * limiting, and the client should render it as an actionable card.
 */
function refusalPayload(input) {
  const available = Math.max(0, Math.round(input.availableCents || 0));
  const required = Math.max(0, Math.round(input.requiredCents || 0));
  return {
    code: 'INSUFFICIENT_CREDIT_FOR_TURN',
    message:
      'There is not enough credit left for another answer. Add credit to continue.',
    requiredCents: required,
    availableCents: available,
    suggestedTopUpCents: Math.max(0, required - available),
    periodEndsAt: input.periodEndsAt ?? null,
  };
}

/**
 * Drift between what we believe was spent and what the vendor says (§7.4).
 *
 * Ratio in tenths of a percent, matching `percentUsed`; `null` when there is no
 * baseline to compare against — an account with no meter can never drift.
 */
function percentDrift({ lastKnownCents, settledSumCents, vendorSpendableCents }) {
  if (!Number.isFinite(lastKnownCents) || !Number.isFinite(vendorSpendableCents)) {
    return null;
  }
  const expected = lastKnownCents - Number(settledSumCents || 0);
  const denominator = Math.max(1, Math.abs(lastKnownCents));
  const ratio = (Math.abs(expected - vendorSpendableCents) / denominator) * 100;
  return Math.round(ratio * 10) / 10;
}

/** Price one LLM call from its token counts — the settle arithmetic. */
function costOfCall({ inputTokens, outputTokens, cachedTokens = 0, rates } = {}) {
  const r = assertRates(rates, 'costOfCall');
  const uncached = Math.max(0, Number(inputTokens || 0) - Number(cachedTokens || 0));
  return (
    uncached * r.inputCentsPerToken +
    Math.max(0, Number(cachedTokens || 0)) * r.cachedInputCentsPerToken +
    Math.max(0, Number(outputTokens || 0)) * r.outputCentsPerToken +
    r.requestFeeCents
  );
}

/**
 * The stop-threshold soft wall — `PLAN_STOP_THRESHOLD_PERCENT` (§11).
 *
 * This is a **different wall** from the reservation, and the two must not be
 * confused:
 *
 *   soft wall (this)      stop *starting* new turns once `thresholdPct` of the
 *                         grant is used, so the last few percent stays free to
 *                         rate batches already in flight
 *   hard wall (reserve)   never spend more than the balance, whatever the traffic
 *
 * `blockNewTurns` is therefore about admission only. It must **never** be used
 * to drop usage events: a reply that was already delivered to the customer is
 * real usage, and refusing to rate it is how free usage happens. The ingest
 * guard keeps forwarding until the balance is truly zero — which is what the
 * headroom exists to pay for.
 *
 * A grant of `0` or `undefined` disables the wall (there is nothing to measure
 * a percentage against); the reservation still applies.
 */
function softWall({
  grantCents,
  availableCents,
  thresholdPct = DEFAULT_STOP_THRESHOLD_PCT,
} = {}) {
  const grant = Number(grantCents);
  const available = Math.max(0, Number(availableCents || 0));
  const pct = Number.isFinite(Number(thresholdPct))
    ? Math.min(100, Math.max(1, Number(thresholdPct)))
    : DEFAULT_STOP_THRESHOLD_PCT;

  if (!Number.isFinite(grant) || grant <= 0) {
    return {
      level: 'HEALTHY',
      usedPct: 0,
      headroomCents: 0,
      blockNewTurns: false,
      reason: null,
      thresholdPct: pct,
    };
  }

  const headroomCents = Math.floor((grant * (100 - pct)) / 100);
  const usedPct = Math.round(((grant - available) / grant) * 1000) / 10;

  if (available <= 0) {
    return {
      level: 'BLOCKED',
      usedPct: 100,
      headroomCents,
      blockNewTurns: true,
      reason: 'ALLOWANCE_EXHAUSTED',
      thresholdPct: pct,
    };
  }

  // At or inside the headroom: the buffer is all that is left. It belongs to
  // usage already served, not to a new turn.
  if (available <= headroomCents) {
    return {
      level: 'SOFT_WALL',
      usedPct,
      headroomCents,
      blockNewTurns: true,
      reason: 'STOP_THRESHOLD_REACHED',
      thresholdPct: pct,
    };
  }

  // UX band (§9): warn before the wall, block only at it.
  const lowBandCents = grant * 0.1;
  return {
    level: available <= lowBandCents ? 'LOW' : 'HEALTHY',
    usedPct,
    headroomCents,
    blockNewTurns: false,
    reason: null,
    thresholdPct: pct,
  };
}

/**
 * What may actually be spent — the balance minus the protected headroom.
 *
 * This is the single number both the gate and the ingest guard must use. The
 * headroom is not money: it is the buffer reserved for batches already in flight
 * when admission closed, so letting a *new* batch consume it silently defeats the
 * stop threshold.
 *
 * Consequence, and the reason this function exists: a batch is judged on
 * **`available − cost`**, not on `available` alone. Otherwise a $20 batch against
 * a $20 balance passes, spends the $6 of headroom, and finishes the period at
 * 100 % while the threshold says 97 %.
 */
function spendableForSpend({
  grantCents,
  availableCents,
  thresholdPct = DEFAULT_STOP_THRESHOLD_PCT,
} = {}) {
  const available = Math.max(0, Number(availableCents || 0));
  const grant = Number(grantCents);
  if (!Number.isFinite(grant) || grant <= 0) return available;

  const pct = Number.isFinite(Number(thresholdPct))
    ? Math.min(100, Math.max(1, Number(thresholdPct)))
    : DEFAULT_STOP_THRESHOLD_PCT;
  const headroomCents = Math.floor((grant * (100 - pct)) / 100);
  return Math.max(0, available - headroomCents);
}

module.exports = {
  ASSUMED_RATES,
  REQUIRED_RATE_KEYS,
  assertRates,
  MIN_USEFUL_OUTPUT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_SAFETY_MARGIN_PCT,
  DEFAULT_STOP_THRESHOLD_PCT,
  stopThresholdFromEnv,
  estimatePromptTokens,
  clampForBudget,
  reserveFromEstimate,
  softWall,
  spendableForSpend,
  TurnBudget,
  applyHolds,
  refusalPayload,
  percentDrift,
  costOfCall,
};

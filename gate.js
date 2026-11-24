'use strict';

/**
 * The reserve â†’ clamp â†’ settle protocol — AI_BUDGET_ENFORCEMENT_PLAN.md §7.
 *
 * Three layers, each doing exactly one job:
 *
 *   L1  reserve   hold the ceiling atomically, so parallel turns cannot both
 *                 spend the same dollar
 *   L2  clamp     derive `maxOutputTokens` from the budget, so the generation
 *                 physically cannot exceed what was held
 *   L3  settle    price what actually happened and release the difference
 *
 * The gate is vendor-agnostic. `vendor.spendableCents(tenantId)` is the only
 * outside dependency, so the same code runs against Metronome in production and
 * against a stub in a test.
 */

const {
  assertRates,
  clampForBudget,
  reserveFromEstimate,
  applyHolds,
  refusalPayload,
  percentDrift,
  softWall,
  spendableForSpend,
  DEFAULT_SAFETY_MARGIN_PCT,
  DEFAULT_STOP_THRESHOLD_PCT,
  stopThresholdFromEnv,
  MIN_USEFUL_OUTPUT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
} = require('./budget');
const { ReservationStore, ReserveState } = require('./reservation-store');

const ReserveReason = Object.freeze({
  OK: 'OK',
  REPLAY: 'IDEMPOTENT_REPLAY',
  TRUNCATED: 'OK_TRUNCATED',
  RESERVE_DISABLED: 'RESERVE_DISABLED',
  NOT_METERED: 'NOT_METERED',
  INSUFFICIENT_CREDIT_FOR_TURN: 'INSUFFICIENT_CREDIT_FOR_TURN',
  /** Soft wall: `PLAN_STOP_THRESHOLD_PERCENT` of the grant is used. */
  STOP_THRESHOLD_REACHED: 'STOP_THRESHOLD_REACHED',
  /** This batch costs more than the spendable remainder, so it cannot be sent. */
  BATCH_EXCEEDS_REMAINING: 'BATCH_EXCEEDS_REMAINING',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  BILLING_UNAVAILABLE: 'BILLING_UNAVAILABLE',
  /** Fail-open: the turn ran with no hold, and that is logged as such. */
  UNRESERVED_TURN: 'UNRESERVED_TURN',
});

class BudgetGate {
  /**
   * @param {object} options
   * @param {{spendableCents: (tenantId: string) => Promise<number|null>}} options.vendor
   * @param {ReservationStore} [options.store]
   * @param {object}  [options.rates]                rate card overrides
   * @param {boolean} [options.enabled]              `BILLING_RESERVE_ENABLED`, ships false
   * @param {number}  [options.safetyMarginPct]
   * @param {number}  [options.modelMaxOutputTokens]
   */
  constructor({
    vendor,
    store,
    rates,
    enabled = false,
    failOpen = false,
    safetyMarginPct = DEFAULT_SAFETY_MARGIN_PCT,
    // Unset â†’ `PLAN_STOP_THRESHOLD_PERCENT` from the environment â†’ 97.
    stopThresholdPct = stopThresholdFromEnv(),
    /**
     * Whether the ingest guard also stops at the soft wall.
     *
     * The plan (AI_BUDGET_ENFORCEMENT_PLAN.md §6.2, §8) says ingest should keep
     * forwarding until the balance is truly zero, because a reply that already
     * reached the customer is billable usage. **This POC defaults to the
     * stricter policy** — nothing leaves this node for Metronome once the stop
     * threshold is crossed — because that is the requirement being tested here.
     *
     * The consequence is explicit: those batches are not rated, so they cost
     * the business rather than the tenant. They are therefore written to
     * `droppedBatches` instead of vanishing, so they can be replayed after a
     * top-up. Set `ingestStopsAtStopThreshold: false` for the plan's policy.
     */
    ingestStopsAtStopThreshold = true,
    modelMaxOutputTokens = MODEL_MAX_OUTPUT_TOKENS,
    ttlSeconds,
  } = {}) {
    this.vendor = vendor;
    this.store = store || new ReservationStore({ ttlSeconds });
    // No default rates: a mounted card is the tenant's own, and nothing is
    // guessed. `null` here is fine — every priced call must then pass `rates`.
    this.rates = rates ? assertRates(rates, 'BudgetGate') : null;
    this.enabled = enabled;
    this.failOpen = failOpen;
    this.safetyMarginPct = safetyMarginPct;
    this.stopThresholdPct = stopThresholdPct;
    this.ingestStopsAtStopThreshold = ingestStopsAtStopThreshold;
    this.modelMaxOutputTokens = modelMaxOutputTokens;
    /**
     * Every batch refused at this node, so a top-up can replay it. This is the
     * dead-letter queue the "drop" decision owes the business.
     */
    this.droppedBatches = [];
    /** Per-tenant settle ledger, for the drift check (§7.4). */
    this.ledger = new Map();
    /** Counters, the `billing.*` metrics of §12. */
    this.metrics = {
      reserveGranted: 0,
      reserveDenied: 0,
      reserveReplay: 0,
      clampShortened: 0,
      settleOverrun: 0,
      usageDropped: 0,
      reservedCents: 0,
      settledCents: 0,
    };
  }

  #ledger(tenantId) {
    if (!this.ledger.has(tenantId)) {
      this.ledger.set(tenantId, {
        baselineCents: null,
        settledCents: 0,
        turns: 0,
        droppedTurns: 0,
      });
    }
    return this.ledger.get(tenantId);
  }

  /**
   * The **soft** wall — `PLAN_STOP_THRESHOLD_PERCENT` (§11).
   *
   * Returns the usage band and whether a *new turn* may start. It is exposed
   * separately from `guardBatch` on purpose: this answer governs admission, and
   * must never be used to drop usage events.
   */
  wall(tenantId, { grantCents, availableCents }) {
    return softWall({
      grantCents,
      availableCents: availableCents - this.store.held(tenantId).heldCents,
      thresholdPct: this.stopThresholdPct,
    });
  }

  /**
   * The admission decision, with live holds subtracted (§7.1).
   *
   * This is the function the pre-turn gate calls. The ingest guard deliberately
   * does **not** use it — see `guardBatch`, where the soft wall must not apply.
   */
  async decision(tenantId, { metered = true, planActive = true, grantCents } = {}) {
    const held = this.store.held(tenantId).heldCents;

    let spendable;
    try {
      spendable = await this.vendor.spendableCents(tenantId);
    } catch (err) {
      // The vendor is unreachable. Failing closed protects the balance and
      // fails open keeps chat alive; the deployment chooses, loudly (§8).
      return {
        allowed: this.failOpen,
        reason: this.failOpen ? ReserveReason.UNRESERVED_TURN : ReserveReason.BILLING_UNAVAILABLE,
        message: this.failOpen
          ? null
          : 'Billing is temporarily unavailable. Please try again shortly.',
        metered: false,
        availableCents: 0,
        heldCents: held,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const base = {
      allowed: planActive,
      reason: planActive ? 'OK' : 'PLAN_INACTIVE',
      message: planActive ? null : 'Renew your plan to continue.',
      metered: metered && spendable !== null,
      availableCents: spendable === null ? 0 : spendable,
    };
    if (!planActive) return { ...base, heldCents: held };

    const withHolds = applyHolds(base, held);

    // Soft wall on top of the holds: stop *starting* turns at
    // `stopThresholdPct` of the grant so the headroom stays free for usage
    // already served. Only applies when the caller knows the grant.
    if (!withHolds.metered || !(Number(grantCents) > 0) || !withHolds.allowed) {
      return withHolds;
    }
    const wall = this.wall(tenantId, { grantCents, availableCents: spendable });
    if (!wall.blockNewTurns) return { ...withHolds, wall };

    return {
      ...withHolds,
      allowed: false,
      reason: wall.reason,
      message: 'You have used your plan limit. Add credit to keep using the assistant.',
      availableCents: Math.max(0, withHolds.availableCents),
      wall,
    };
  }

  /**
   * L1 + L2 — decide whether this turn may run, and how big its answer may be.
   *
   * Returns either a grant (with `maxOutputTokens` and a `reservationId`) or a
   * `402` body. It never returns "allowed but unbounded".
   */
  async admit({
    tenantId,
    turnUid,
    promptTokens,
    cachedTokens = 0,
    periodEndsAt = null,
    grantCents = null,
    rates = null,
  }) {
    // Resolved once, and required: this gate will not price a turn with a card
    // it was not given.
    const card = assertRates(rates ?? this.rates, 'admit');
    let spendable;
    try {
      spendable = await this.vendor.spendableCents(tenantId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.failOpen) {
        // Allowed, but tagged: the ingest guard still backstops it (§8).
        return {
          granted: true,
          reason: ReserveReason.UNRESERVED_TURN,
          reservationId: null,
          reservedCents: 0,
          maxOutputTokens: this.modelMaxOutputTokens,
          truncated: false,
          availableCents: null,
          heldCents: this.store.held(tenantId).heldCents,
          refusal: null,
          error: reason,
        };
      }
      return {
        granted: false,
        reason: ReserveReason.BILLING_UNAVAILABLE,
        reservationId: null,
        reservedCents: 0,
        maxOutputTokens: 0,
        truncated: false,
        availableCents: 0,
        heldCents: this.store.held(tenantId).heldCents,
        refusal: null,
        error: reason,
      };
    }

    // Nothing metered: no allowance to exhaust, so the turn keeps working and
    // nothing is held (§8). This is not an error path.
    if (spendable === null) {
      return {
        granted: true,
        reason: ReserveReason.NOT_METERED,
        reservationId: null,
        reservedCents: 0,
        maxOutputTokens: this.modelMaxOutputTokens,
        truncated: false,
        availableCents: null,
        heldCents: 0,
      };
    }

    // The soft wall: at `stopThresholdPct` of the grant, no NEW turn starts,
    // whatever the reservation would allow. The headroom that remains is the
    // buffer for batches already in flight, not for another answer.
    if (Number(grantCents) > 0) {
      const wall = this.wall(tenantId, { grantCents, availableCents: spendable });
      if (wall.blockNewTurns) {
        this.metrics.reserveDenied += 1;
        return {
          granted: false,
          reason: wall.reason,
          reservationId: null,
          reservedCents: 0,
          maxOutputTokens: 0,
          truncated: false,
          availableCents: Math.max(0, spendable - this.store.held(tenantId).heldCents),
          heldCents: this.store.held(tenantId).heldCents,
          wall,
          refusal: refusalPayload({
            requiredCents: Math.ceil(wall.headroomCents),
            availableCents: Math.max(0, spendable),
            periodEndsAt,
          }),
        };
      }
    }

    if (!this.enabled) {
      // Ships dark. The clamp still applies so the ceiling is never unbounded,
      // but nothing is held — behaviour matches the pre-reservation gate.
      const clamp = clampForBudget({
        budgetCents: spendable,
        promptTokens,
        cachedTokens,
        rates: card,
        modelMaxOutputTokens: this.modelMaxOutputTokens,
      });
      return {
        granted: clamp.affordable,
        reason: clamp.affordable
          ? ReserveReason.RESERVE_DISABLED
          : ReserveReason.INSUFFICIENT_CREDIT_FOR_TURN,
        reservationId: null,
        reservedCents: 0,
        maxOutputTokens: clamp.maxOutputTokens,
        truncated: clamp.truncated,
        availableCents: Math.max(0, spendable),
        heldCents: 0,
        refusal: clamp.affordable
          ? null
          : refusalPayload({
              requiredCents: clamp.minimumCents,
              availableCents: spendable,
              periodEndsAt,
            }),
      };
    }

    const attempt = (capacityCents) => {
      const clamp = clampForBudget({
        budgetCents: capacityCents,
        promptTokens,
        cachedTokens,
        rates: card,
        modelMaxOutputTokens: this.modelMaxOutputTokens,
      });
      if (!clamp.affordable) return { clamp, hold: 0 };
      // Margin applies to the *exact* ceiling, then one ceil. Inflating an
      // already-rounded number is how a hold ends up below the real cost.
      return { clamp, hold: reserveFromEstimate(clamp.reserveExactCents, this.safetyMarginPct) };
    };

    const held = this.store.held(tenantId).heldCents;
    const net = Math.max(0, spendable - held);

    // The headroom is not spendable: it is the buffer for batches already in
    // flight. Admission uses the protected figure, so a turn can never reserve
    // into the buffer and quietly finish the period past the threshold.
    const capacity =
      Number(grantCents) > 0
        ? spendableForSpend({
            grantCents,
            availableCents: net,
            thresholdPct: this.stopThresholdPct,
          })
        : net;

    const first = attempt(capacity);

    if (!first.clamp.affordable) {
      this.metrics.reserveDenied += 1;
      return {
        granted: false,
        reason: ReserveReason.INSUFFICIENT_CREDIT_FOR_TURN,
        reservationId: null,
        reservedCents: 0,
        maxOutputTokens: 0,
        truncated: false,
        availableCents: Math.max(0, spendable - held),
        heldCents: held,
        refusal: refusalPayload({
          requiredCents: first.clamp.minimumCents,
          availableCents: Math.max(0, spendable - held),
          periodEndsAt,
        }),
      };
    }

    let reservation = this.store.reserve({
      tenantId,
      turnUid,
      cents: first.hold,
      capacityCents: spendable,
    });
    let clamp = first.clamp;

    // Lost the race: another turn took the money between the read and the
    // write. Re-derive the ceiling from what is actually left and try once —
    // that is the plan's "reserve a reduced ceiling" branch (§7.2).
    if (reservation.state === ReserveState.DENIED) {
      const retryNet = reservation.availableCents;
      const retryCapacity =
        Number(grantCents) > 0
          ? spendableForSpend({
              grantCents,
              availableCents: retryNet,
              thresholdPct: this.stopThresholdPct,
            })
          : retryNet;
      const retry = attempt(retryCapacity);
      if (!retry.clamp.affordable) {
        this.metrics.reserveDenied += 1;
        return {
          granted: false,
          reason: ReserveReason.INSUFFICIENT_CREDIT_FOR_TURN,
          reservationId: null,
          reservedCents: 0,
          maxOutputTokens: 0,
          truncated: false,
          availableCents: reservation.availableCents,
          heldCents: reservation.heldCents,
          refusal: refusalPayload({
            requiredCents: retry.clamp.minimumCents,
            availableCents: reservation.availableCents,
            periodEndsAt,
          }),
        };
      }
      clamp = retry.clamp;
      reservation = this.store.reserve({
        tenantId,
        turnUid,
        cents: retry.hold,
        capacityCents: spendable,
      });
      if (reservation.state === ReserveState.DENIED) {
        this.metrics.reserveDenied += 1;
        return {
          granted: false,
          reason: ReserveReason.INSUFFICIENT_CREDIT_FOR_TURN,
          reservationId: null,
          reservedCents: 0,
          maxOutputTokens: 0,
          truncated: false,
          availableCents: reservation.availableCents,
          heldCents: reservation.heldCents,
          refusal: refusalPayload({
            requiredCents: clamp.minimumCents,
            availableCents: reservation.availableCents,
            periodEndsAt,
          }),
        };
      }
    }

    if (reservation.state === ReserveState.REPLAY) {
      this.metrics.reserveReplay += 1;
    } else {
      this.metrics.reserveGranted += 1;
      this.metrics.reservedCents += reservation.grantedCents;
    }
    if (clamp.truncated) this.metrics.clampShortened += 1;

    const ledger = this.#ledger(tenantId);
    if (ledger.baselineCents === null) ledger.baselineCents = spendable;

    return {
      granted: true,
      reason:
        reservation.state === ReserveState.REPLAY
          ? ReserveReason.REPLAY
          : clamp.truncated
            ? ReserveReason.TRUNCATED
            : ReserveReason.OK,
      // The reservation id IS the turn id: deterministic, so a retried turn
      // settles the hold it already owns instead of taking a second one.
      reservationId: turnUid,
      reservedCents: reservation.grantedCents,
      maxOutputTokens: clamp.maxOutputTokens,
      truncated: clamp.truncated,
      promptCostCents: clamp.promptCostCents,
      requestCostCents: clamp.requestCostCents,
      availableCents: reservation.availableCents,
      heldCents: reservation.heldCents,
      expiresAt: reservation.expiresAt,
      refusal: null,
    };
  }

  /**
   * L3 — settle the actual cost.
   *
   * Called from the ingest path, because the usage batch already carries the
   * truth: releasing the hold there means money is returned at the same moment
   * the charge is posted, with no second round trip (§7.2).
   */
  async settle({ tenantId, reservationId, actualCents }) {
    const result = this.store.settle({ tenantId, turnUid: reservationId });
    const ledger = this.#ledger(tenantId);

    const settled = actualCents === null || actualCents === undefined ? null : Math.max(0, actualCents);
    if (settled === null) {
      // Unpriced: the hold is already released by TTL semantics, but we refuse
      // to claim a number we do not know.
      return { ...result, settledCents: 0, releasedCents: 0, overrun: false, unpriced: true };
    }

    const overrun = settled > result.reservedCents;
    if (overrun) {
      // Should be impossible: the generation was capped by the reservation.
      // It is a clamp bug, not a billing event — never re-charge for it.
      this.metrics.settleOverrun += 1;
    }

    ledger.settledCents += settled;
    ledger.turns += 1;
    this.metrics.settledCents += settled;

    return {
      ...result,
      settledCents: settled,
      releasedCents: Math.max(0, result.reservedCents - settled),
      overrun,
      unpriced: false,
    };
  }

  /** Abort path: the whole ceiling goes back. */
  async release({ tenantId, reservationId }) {
    return this.settle({ tenantId, reservationId, actualCents: 0 });
  }

  /**
   * The ingest guard — "may this batch leave this node for Metronome?"
   *
   * **This is the check the requirement asks for**: it runs here, before the
   * HTTP call, so a low or exhausted balance means the batch never reaches the
   * vendor — no reliance on Metronome to reject it.
   *
   * Order of checks:
   *   1. vendor balance unreadable â†’ forward (served usage is real usage; the
   *      alternative is silently losing a charge we know happened)
   *   2. nothing metered          â†’ forward (no allowance to exhaust)
   *   3. live zero (spendable âˆ’ held â‰¤ 0) â†’ DROP, `ALLOWANCE_EXHAUSTED`
   *   4. stop threshold crossed   â†’ DROP, `STOP_THRESHOLD_REACHED`
   *                                 (only when `ingestStopsAtStopThreshold`)
   *
   * Every drop is recorded in `droppedBatches` so it can be replayed after a
   * top-up. Dropping silently would be revenue lost without a trace.
   */
  async guardBatch(tenantId, { grantCents = null, costCents = null } = {}) {
    let spendable;
    try {
      spendable = await this.vendor.spendableCents(tenantId);
    } catch (err) {
      // A failed guard must not drop charges that were already served: we
      // cannot prove the balance is short, and the usage is real regardless.
      return {
        forward: true,
        reason: ReserveReason.UNRESERVED_TURN,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (spendable === null) return { forward: true, reason: 'NOT_METERED' };

    const held = this.store.held(tenantId).heldCents;
    const net = Math.max(0, spendable - held);

    if (net <= 0) {
      return this.#drop(tenantId, 'ALLOWANCE_EXHAUSTED', { spendable, held, grantCents });
    }

    // What is actually spendable: the balance minus the protected headroom.
    const capacity = spendableForSpend({
      grantCents,
      availableCents: net,
      thresholdPct: this.stopThresholdPct,
    });
    const cost = costCents === null || costCents === undefined ? null : Math.max(0, Number(costCents));

    if (capacity <= 0) {
      const wall = softWall({ grantCents, availableCents: net, thresholdPct: this.stopThresholdPct });
      return this.#drop(tenantId, wall.reason ?? 'STOP_THRESHOLD_REACHED', {
        spendable,
        held,
        grantCents,
        wall,
        costCents: cost,
      });
    }

    // The check that was missing: does *this batch* fit? Judging on the balance
    // alone lets a large batch consume the headroom and finish the period over
    // the threshold.
    if (cost !== null && cost > capacity) {
      return {
        ...this.#drop(tenantId, 'BATCH_EXCEEDS_REMAINING', {
          spendable,
          held,
          grantCents,
          costCents: cost,
        }),
        fitsCents: capacity,
      };
    }

    // Belt and braces for a caller that does not price its batch (cost null):
    // still refuse the protected headroom once the threshold is crossed.
    if (this.ingestStopsAtStopThreshold && Number(grantCents) > 0) {
      const wall = softWall({ grantCents, availableCents: net, thresholdPct: this.stopThresholdPct });
      if (wall.blockNewTurns) {
        return this.#drop(tenantId, wall.reason, { spendable, held, grantCents, wall, costCents: cost });
      }
    }

    return { forward: true, reason: 'OK', availableCents: net, spendableCents: capacity };
  }

  /** Record a refusal and answer the caller. Never a silent drop. */
  #drop(tenantId, reason, detail) {
    this.metrics.usageDropped += 1;
    this.#ledger(tenantId).droppedTurns += 1;

    const record = {
      at: new Date().toISOString(),
      tenantId,
      reason,
      spendableCents: detail.spendable,
      heldCents: detail.held,
      grantCents: detail.grantCents ?? null,
      costCents: detail.costCents ?? null,
      usedPct: detail.wall?.usedPct ?? null,
    };
    this.droppedBatches.push(record);

    return {
      forward: false,
      reason,
      availableCents: Math.max(0, (detail.spendable ?? 0) - (detail.held ?? 0)),
      recorded: record,
    };
  }

  /** §7.4 — compare belief against vendor truth. */
  async reconcile(tenantId) {
    const ledger = this.#ledger(tenantId);
    const vendor = await this.vendor.spendableCents(tenantId);
    const driftPct = percentDrift({
      lastKnownCents: ledger.baselineCents,
      settledSumCents: ledger.settledCents,
      vendorSpendableCents: vendor,
    });
    return {
      tenantId,
      baselineCents: ledger.baselineCents,
      settledCents: ledger.settledCents,
      vendorSpendableCents: vendor,
      driftPct,
      healthy: driftPct === null || driftPct <= 1,
      turns: ledger.turns,
      droppedTurns: ledger.droppedTurns,
    };
  }
}

module.exports = { BudgetGate, ReserveReason, MIN_USEFUL_OUTPUT_TOKENS };

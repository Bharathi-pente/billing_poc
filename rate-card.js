'use strict';

/**
 * Rates from the tenant's **live rate card** — never a constant.
 *
 * The clamp is only as correct as its prices: a hardcoded table prices one
 * tenant with another tenant's card, and the only symptom is an invoice that
 * disagrees with the vendor. So `deriveRates()` reads the same three objects the
 * vendor gives us and maps them onto the four slots the clamp needs.
 *
 * The mapping is by **metric semantics**, not by product name:
 *
 *   usage product → billable_metric_id → metric.aggregation_key
 *     `uncached_input_tokens` → inputCentsPerToken
 *     `cached_input_tokens`   → cachedInputCentsPerToken
 *     `output_tokens`         → outputCentsPerToken
 *     aggregation_type=count  → requestFeeCents
 *
 * Names are only a tie-breaker, because `Test Input Tokens` and `Input Tokens`
 * share a metric and a rename must not change the price.
 */

class RateCardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateCardError';
  }
}

/** The four slots the clamp needs, expressed as the metric they price. */
const SLOTS = {
  inputCentsPerToken: { aggregationKey: 'uncached_input_tokens' },
  cachedInputCentsPerToken: { aggregationKey: 'cached_input_tokens' },
  outputCentsPerToken: { aggregationKey: 'output_tokens' },
  requestFeeCents: { count: true },
};

const isTestRow = (name) => /^test[\s_-]/i.test(String(name || ''));

/**
 * The price to guard with, in the card's minor unit.
 *
 * FLAT is exact. TIERED has no single price, so this returns the **highest tier
 * price** — the conservative choice: it can only over-reserve, never under. The
 * result is flagged `tiered` so a caller can report that the estimate is
 * approximate instead of pretending it is exact.
 */
function priceOf(rate) {
  const type = String(rate?.rate_type || 'FLAT').toUpperCase();
  if (type === 'FLAT') {
    const price = Number(rate.price);
    return Number.isFinite(price) ? { price, tiered: false } : null;
  }
  if (type === 'TIERED') {
    const prices = (rate.tiers || [])
      .map((tier) => Number(tier?.price))
      .filter((price) => Number.isFinite(price));
    if (!prices.length) return null;
    return { price: Math.max(...prices), tiered: true };
  }
  return null;
}

/**
 * Pure: vendor payloads in, clamp rates out.
 *
 * @param {object}   input
 * @param {Array}    input.rates     `getRates` rows: { product_id, rate, entitled }
 * @param {Array}    input.products  `products/list` rows
 * @param {Array}    input.metrics   `billable-metrics` rows
 * @param {string}   [input.rateCardId]
 * @throws {RateCardError} when a slot cannot be priced — never falls back
 */
function deriveRates({ rates = [], products = [], metrics = [], rateCardId = null } = {}) {
  const productById = new Map(
    products.map((product) => [
      product.id,
      {
        id: product.id,
        name: product.current?.name ?? product.name ?? product.id,
        type: String(product.current?.type ?? product.type ?? '').toUpperCase(),
        metricId: product.current?.billable_metric_id ?? product.billable_metric_id ?? null,
      },
    ]),
  );
  const metricById = new Map(
    metrics.map((metric) => [
      metric.id,
      {
        id: metric.id,
        aggregationType: String(metric.aggregation_type ?? '').toLowerCase(),
        aggregationKey: metric.aggregation_key ?? null,
      },
    ]),
  );

  const found = {};
  const skipped = [];

  for (const row of rates) {
    if (row.entitled === false) continue;
    if (!row.rate) continue;

    const product = productById.get(row.product_id);
    if (!product || product.type !== 'USAGE') continue;

    const metric = product.metricId ? metricById.get(product.metricId) : null;
    if (!metric) {
      skipped.push({ product: product.name, why: 'no billable metric' });
      continue;
    }

    const isCount = metric.aggregationType === 'count';
    const slot = Object.entries(SLOTS).find(([, spec]) =>
      spec.count ? isCount : spec.aggregationKey === metric.aggregationKey,
    );
    if (!slot) continue;

    const [slotName, spec] = slot;
    const priced = priceOf(row.rate);
    if (!priced) {
      skipped.push({ product: product.name, why: `unpriced ${row.rate.rate_type}` });
      continue;
    }

    const candidate = {
      price: priced.price,
      tiered: priced.tiered,
      productId: product.id,
      productName: product.name,
      rateType: String(row.rate.rate_type || 'FLAT').toUpperCase(),
      metric: spec.count ? 'count' : metric.aggregationKey,
      creditTypeName: row.rate.credit_type?.name ?? null,
    };

    // Two products can answer the same slot (a `Test …` twin). Prefer the
    // production-named one; on a tie, the first wins.
    const current = found[slotName];
    if (!current || (isTestRow(current.productName) && !isTestRow(candidate.productName))) {
      found[slotName] = candidate;
    }
  }

  const missing = Object.keys(SLOTS).filter((slotName) => !found[slotName]);
  if (missing.length) {
    const seen = [...productById.values()]
      .filter((product) => product.type === 'USAGE')
      .map((product) => product.name)
      .join(', ') || '(none)';
    throw new RateCardError(
      `Rate card ${rateCardId ?? '(unknown)'} cannot price ${missing.join(', ')}. ` +
        `Usage products on the card: ${seen}. ` +
        (skipped.length ? `Skipped: ${skipped.map((s) => `${s.product} (${s.why})`).join('; ')}. ` : '') +
        'Refusing to guess — a wrong rate is a silent billing error.',
    );
  }

  const creditTypes = new Set(
    Object.values(found)
      .map((entry) => entry.creditTypeName)
      .filter(Boolean),
  );
  if (creditTypes.size > 1) {
    throw new RateCardError(
      `Rate card ${rateCardId ?? '(unknown)'} mixes credit types (${[...creditTypes].join(', ')}). ` +
        'The clamp needs one denomination.',
    );
  }

  return {
    rateCardId,
    // The four numbers `clampForBudget` / `costOfCall` consume.
    inputCentsPerToken: found.inputCentsPerToken.price,
    cachedInputCentsPerToken: found.cachedInputCentsPerToken.price,
    outputCentsPerToken: found.outputCentsPerToken.price,
    requestFeeCents: found.requestFeeCents.price,
    creditTypeName: [...creditTypes][0] ?? null,
    /** True when any slot came from a TIERED rate, so the estimate is a bound. */
    tiered: Object.values(found).some((entry) => entry.tiered),
    /** Where each number came from — printed by the UI so it is auditable. */
    sources: found,
  };
}

/**
 * I/O wrapper: read the card for a contract, then derive.
 *
 * `metronome` is a `(method, path, body) => Promise<data>` function, so this
 * works with the POC server's client and with a test stub.
 */
async function loadRateCard({ metronome, rateCardId }) {
  if (!rateCardId) throw new RateCardError('A rate card id is required to price usage.');

  const [rates, products, metrics] = await Promise.all([
    metronome('POST', '/v1/contract-pricing/rate-cards/getRates', {
      rate_card_id: rateCardId,
      at: new Date().toISOString(),
      limit: 100,
    }),
    metronome('POST', '/v1/contract-pricing/products/list?limit=100', {
      archive_filter: 'NOT_ARCHIVED',
    }),
    metronome('GET', '/v1/billable-metrics?limit=100'),
  ]);

  return deriveRates({
    rates: rates?.data ?? [],
    products: products?.data ?? [],
    metrics: metrics?.data ?? [],
    rateCardId,
  });
}

module.exports = { deriveRates, loadRateCard, priceOf, RateCardError, SLOTS };

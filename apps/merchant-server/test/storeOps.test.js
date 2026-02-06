import assert from "node:assert/strict";
import test from "node:test";
import { createDatabases } from "../src/db.js";
import { STORE_PROFILES } from "../src/storeProfiles.js";
import {
  applyPriceDrift,
  buildPickupSlots,
  confirmPickupSlot,
  getSubstitutionCandidates,
  listPickupSlots,
  parseStoreOpsConfig,
  reservePickupSlot,
  resolveStoreOpsConfig,
  shouldSimulateOutOfStock,
} from "../src/storeOps.js";

const BIGBOX = STORE_PROFILES.bigbox;

test("parseStoreOpsConfig handles JSON and invalid values", () => {
  assert.deepEqual(parseStoreOpsConfig(), {});
  assert.deepEqual(parseStoreOpsConfig("{\"volatility\":\"low\"}"), {
    volatility: "low",
  });
  assert.deepEqual(parseStoreOpsConfig("not-json"), {});
});

test("resolveStoreOpsConfig falls back to defaults on invalid overrides", () => {
  const config = resolveStoreOpsConfig(BIGBOX, {
    volatility: "wild",
    driftMagnitude: "extreme",
    substitutionAggressiveness: "nope",
  });
  assert.equal(config.volatilityLevel, BIGBOX.defaults.volatility);
  assert.equal(config.driftMagnitude, BIGBOX.defaults.driftMagnitude);
  assert.equal(
    config.substitutionAggressiveness,
    BIGBOX.defaults.substitutionAggressiveness
  );
});

test("applyPriceDrift is deterministic and bounded", () => {
  const config = {
    drift: { rate: 1, maxCents: 120 },
  };
  const basePrice = 1000;
  const first = applyPriceDrift({
    basePrice,
    productId: "milk",
    seed: "seed-1",
    stage: "quote",
    config,
  });
  const second = applyPriceDrift({
    basePrice,
    productId: "milk",
    seed: "seed-1",
    stage: "quote",
    config,
  });
  assert.equal(first, second);
  assert.ok(first >= basePrice - config.drift.maxCents);
  assert.ok(first <= basePrice + config.drift.maxCents);

  const noDrift = applyPriceDrift({
    basePrice,
    productId: "milk",
    seed: "seed-2",
    stage: "quote",
    config: { drift: { rate: 0, maxCents: 120 } },
  });
  assert.equal(noDrift, basePrice);
});

test("shouldSimulateOutOfStock triggers for empty or forced rate", () => {
  const config = {
    volatility: {
      cartOosRate: 1,
      pickOosRate: 1,
      slotExpiryRate: 0,
      lowStockBoost: 0,
    },
  };
  assert.equal(
    shouldSimulateOutOfStock({
      productId: "milk",
      seed: "seed",
      stage: "cart",
      available: 0,
      config,
      lowStockThreshold: 3,
    }),
    true
  );
  assert.equal(
    shouldSimulateOutOfStock({
      productId: "milk",
      seed: "seed",
      stage: "cart",
      available: 10,
      config,
      lowStockThreshold: 3,
    }),
    true
  );
});

test("pickup slots reserve and confirm", () => {
  const { transactionsDb } = createDatabases({
    productsDbPath: ":memory:",
    transactionsDbPath: ":memory:",
  });
  const now = new Date();
  const slots = listPickupSlots(transactionsDb, BIGBOX, now);
  assert.equal(slots.length, BIGBOX.pickup.daysOut * BIGBOX.pickup.times.length);
  const targetSlot = slots[0];

  const reservation = reservePickupSlot(transactionsDb, {
    slotId: targetSlot.id,
    checkoutId: "checkout_1",
    agentRunId: "run_1",
    profile: BIGBOX,
    now,
  });
  assert.equal(reservation.ok, true);

  const updatedSlots = listPickupSlots(transactionsDb, BIGBOX, now);
  const updated = updatedSlots.find((slot) => slot.id === targetSlot.id);
  assert.equal(updated.available, targetSlot.capacity - 1);

  const confirmed = confirmPickupSlot(transactionsDb, {
    checkoutId: "checkout_1",
    orderId: "order_1",
    seed: "seed",
    config: { volatility: { slotExpiryRate: 0 } },
  });
  assert.equal(confirmed.ok, true);
});

test("pickup slot confirmation can expire deterministically", () => {
  const { transactionsDb } = createDatabases({
    productsDbPath: ":memory:",
    transactionsDbPath: ":memory:",
  });
  const now = new Date();
  const slots = buildPickupSlots(BIGBOX, now);
  const targetSlot = slots[0];

  reservePickupSlot(transactionsDb, {
    slotId: targetSlot.id,
    checkoutId: "checkout_expire",
    agentRunId: "run_2",
    profile: BIGBOX,
    now,
  });

  const expired = confirmPickupSlot(transactionsDb, {
    checkoutId: "checkout_expire",
    orderId: "order_2",
    seed: "seed",
    config: { volatility: { slotExpiryRate: 1 } },
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "PICKUP_SLOT_EXPIRED");
});

test("getSubstitutionCandidates respects maxFallbacks", () => {
  const config = { substitution: { maxFallbacks: 2 } };
  const candidates = getSubstitutionCandidates({
    productId: "milk",
    profile: BIGBOX,
    config,
  });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.includes("greek_yogurt"));
});

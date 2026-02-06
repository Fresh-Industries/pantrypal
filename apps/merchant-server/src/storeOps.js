import crypto from "node:crypto";
import { createSeededRandom, nowIso } from "./utils.js";

const VOLATILITY_LEVELS = {
  low: {
    cartOosRate: 0.03,
    pickOosRate: 0.05,
    slotExpiryRate: 0.05,
    lowStockBoost: 0.06,
  },
  medium: {
    cartOosRate: 0.08,
    pickOosRate: 0.12,
    slotExpiryRate: 0.12,
    lowStockBoost: 0.12,
  },
  high: {
    cartOosRate: 0.2,
    pickOosRate: 0.28,
    slotExpiryRate: 0.25,
    lowStockBoost: 0.18,
  },
};

const DRIFT_LEVELS = {
  low: { rate: 0.1, maxCents: 40 },
  medium: { rate: 0.22, maxCents: 85 },
  high: { rate: 0.45, maxCents: 150 },
};

const SUBSTITUTION_LEVELS = {
  conservative: { maxFallbacks: 1 },
  balanced: { maxFallbacks: 2 },
  aggressive: { maxFallbacks: 3 },
};

const normalizeLevel = (value, fallback, levels) => {
  if (!value) {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return levels[normalized] ? normalized : fallback;
};

export const parseStoreOpsConfig = (raw) => {
  if (!raw) {
    return {};
  }
  if (typeof raw === "object") {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return {};
  }
};

export const resolveStoreOpsConfig = (profile, overrides = {}) => {
  const volatility = normalizeLevel(
    overrides.volatility,
    profile.defaults?.volatility ?? "medium",
    VOLATILITY_LEVELS
  );
  const driftMagnitude = normalizeLevel(
    overrides.driftMagnitude,
    profile.defaults?.driftMagnitude ?? "medium",
    DRIFT_LEVELS
  );
  const substitutionAggressiveness = normalizeLevel(
    overrides.substitutionAggressiveness,
    profile.defaults?.substitutionAggressiveness ?? "balanced",
    SUBSTITUTION_LEVELS
  );

  return {
    volatilityLevel: volatility,
    driftMagnitude,
    substitutionAggressiveness,
    volatility: VOLATILITY_LEVELS[volatility],
    drift: DRIFT_LEVELS[driftMagnitude],
    substitution: SUBSTITUTION_LEVELS[substitutionAggressiveness],
  };
};

export const getStoreOpsConfig = (req, profile) => {
  const overrides = parseStoreOpsConfig(req.header("x-storeops-config"));
  return resolveStoreOpsConfig(profile, overrides);
};

export const buildBasePrice = (priceCents, profile) =>
  Math.max(0, Math.round(priceCents * (profile.priceMultiplier ?? 1)));

export const applyPriceDrift = ({
  basePrice,
  productId,
  seed,
  stage,
  config,
}) => {
  if (!seed) {
    return basePrice;
  }
  const rng = createSeededRandom(`${seed}:${stage}:${productId}:drift`);
  if (rng() > config.drift.rate) {
    return basePrice;
  }
  const delta = Math.floor(rng() * config.drift.maxCents);
  const direction = rng() < 0.5 ? -1 : 1;
  return Math.max(0, basePrice + direction * delta);
};

export const shouldSimulateOutOfStock = ({
  productId,
  seed,
  stage,
  available,
  config,
  lowStockThreshold,
}) => {
  if (available <= 0) {
    return true;
  }
  const rng = createSeededRandom(`${seed}:${stage}:${productId}:oos`);
  const baseRate =
    stage === "pick"
      ? config.volatility.pickOosRate
      : config.volatility.cartOosRate;
  const boost =
    lowStockThreshold !== null &&
    lowStockThreshold !== undefined &&
    available <= lowStockThreshold
      ? config.volatility.lowStockBoost
      : 0;
  const rate = Math.min(0.95, Math.max(0, baseRate + boost));
  return rng() < rate;
};

export const shouldExpireSlot = ({ seed, slotId, config }) => {
  if (!seed) {
    return false;
  }
  const rng = createSeededRandom(`${seed}:slot_expiry:${slotId}`);
  return rng() < config.volatility.slotExpiryRate;
};

export const buildPickupSlots = (profile, now = new Date()) => {
  const slots = [];
  const { pickup } = profile;
  for (let dayOffset = 1; dayOffset <= pickup.daysOut; dayOffset += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() + dayOffset);
    const dateLabel = date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    pickup.times.forEach((time) => {
      const [hour, minute] = time.split(":").map(Number);
      const start = new Date(date);
      start.setHours(hour, minute, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + pickup.slotMinutes);
      const id = `${profile.id}_${start
        .toISOString()
        .slice(0, 10)}_${time.replace(":", "")}`;
      slots.push({
        id,
        dateLabel,
        timeLabel: time,
        label: `${dateLabel} at ${time}`,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        capacity: pickup.capacity,
      });
    });
  }
  return slots;
};

const expireReservations = (db, timestamp) => {
  db.prepare(
    `
    UPDATE pickup_reservations
    SET status = 'expired'
    WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= ?
    `
  ).run(timestamp);
};

const getReservationCounts = (db, timestamp) => {
  const rows = db
    .prepare(
      `
      SELECT slot_id as slotId, COUNT(*) as count
      FROM pickup_reservations
      WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at > ?
      GROUP BY slot_id
      `
    )
    .all(timestamp);
  return new Map(rows.map((row) => [row.slotId, row.count]));
};

export const listPickupSlots = (db, profile, now = new Date()) => {
  const timestamp = nowIso();
  expireReservations(db, timestamp);
  const slots = buildPickupSlots(profile, now);
  const counts = getReservationCounts(db, timestamp);
  return slots.map((slot) => {
    const reserved = counts.get(slot.id) ?? 0;
    const available = Math.max(0, slot.capacity - reserved);
    return {
      ...slot,
      reserved,
      available,
      status: available > 0 ? "available" : "full",
    };
  });
};

export const reservePickupSlot = (
  db,
  { slotId, checkoutId, agentRunId, profile, now = new Date() }
) => {
  const timestamp = nowIso();
  expireReservations(db, timestamp);
  if (!slotId) {
    return { ok: false, code: "PICKUP_SLOT_REQUIRED", message: "No slot selected." };
  }

  const existing = db
    .prepare(
      "SELECT * FROM pickup_reservations WHERE checkout_id = ? AND status = 'reserved'"
    )
    .get(checkoutId);
  if (existing && existing.slot_id === slotId) {
    return { ok: true, reservation: existing };
  }
  if (existing) {
    db.prepare(
      "UPDATE pickup_reservations SET status = 'released' WHERE id = ?"
    ).run(existing.id);
  }

  const slots = listPickupSlots(db, profile, now);
  const slot = slots.find((item) => item.id === slotId);
  if (!slot) {
    return { ok: false, code: "PICKUP_SLOT_NOT_FOUND", message: "Slot not found." };
  }
  if (slot.available <= 0) {
    return { ok: false, code: "PICKUP_SLOT_FULL", message: "Slot is full." };
  }

  const reservationId = crypto.randomUUID();
  const expiresAt = new Date(
    now.getTime() + profile.pickup.holdMinutes * 60 * 1000
  ).toISOString();
  db.prepare(
    `
    INSERT INTO pickup_reservations (
      id,
      slot_id,
      agent_run_id,
      checkout_id,
      status,
      reserved_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    reservationId,
    slotId,
    agentRunId ?? null,
    checkoutId ?? null,
    "reserved",
    timestamp,
    expiresAt
  );

  const reservation = db
    .prepare("SELECT * FROM pickup_reservations WHERE id = ?")
    .get(reservationId);
  return { ok: true, reservation };
};

export const confirmPickupSlot = (
  db,
  { checkoutId, orderId, seed, config }
) => {
  const timestamp = nowIso();
  expireReservations(db, timestamp);
  const reservation = db
    .prepare(
      "SELECT * FROM pickup_reservations WHERE checkout_id = ? AND status = 'reserved'"
    )
    .get(checkoutId);
  if (!reservation) {
    return {
      ok: false,
      code: "PICKUP_SLOT_REQUIRED",
      message: "Pickup slot reservation is missing.",
    };
  }
  if (reservation.expires_at && reservation.expires_at <= timestamp) {
    db.prepare(
      "UPDATE pickup_reservations SET status = 'expired' WHERE id = ?"
    ).run(reservation.id);
    return { ok: false, code: "PICKUP_SLOT_EXPIRED", message: "Pickup slot expired." };
  }
  if (shouldExpireSlot({ seed, slotId: reservation.slot_id, config })) {
    db.prepare(
      "UPDATE pickup_reservations SET status = 'expired' WHERE id = ?"
    ).run(reservation.id);
    return { ok: false, code: "PICKUP_SLOT_EXPIRED", message: "Pickup slot expired." };
  }
  db.prepare(
    `
    UPDATE pickup_reservations
    SET status = 'confirmed', order_id = ?, confirmed_at = ?
    WHERE id = ?
    `
  ).run(orderId ?? null, timestamp, reservation.id);
  const updated = db
    .prepare("SELECT * FROM pickup_reservations WHERE id = ?")
    .get(reservation.id);
  return { ok: true, reservation: updated };
};

export const getSubstitutionCandidates = ({ productId, profile, config }) => {
  const list = profile.substitutionGraph?.[productId] ?? [];
  return list.slice(0, config.substitution.maxFallbacks);
};

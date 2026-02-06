import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import {
  DEFAULT_INVENTORY_QUANTITY,
  createDatabases,
  getCheckout,
  getIdempotencyRecord,
  getInventory,
  getLatestApproval,
  getOrder,
  getProduct,
  getProductInventoryQuantity,
  listProducts,
  saveCheckout,
  saveIdempotencyRecord,
  saveOrder,
  setInventory,
} from "./db.js";
import { hashPayload, nowIso, normalizeUrl, parseJson, serializeJson } from "./utils.js";
import { resolveStoreProfile } from "./storeProfiles.js";
import {
  applyPriceDrift,
  buildBasePrice,
  confirmPickupSlot,
  getStoreOpsConfig,
  getSubstitutionCandidates,
  listPickupSlots,
  reservePickupSlot,
  shouldSimulateOutOfStock,
} from "./storeOps.js";

const DEFAULT_PRODUCTS_DB = "/tmp/ucp_test/products.db";
const DEFAULT_TRANSACTIONS_DB = "/tmp/ucp_test/transactions.db";

const parseArgs = (argv) => {
  const options = {
    productsDbPath: process.env.PRODUCTS_DB_PATH || DEFAULT_PRODUCTS_DB,
    transactionsDbPath: process.env.TRANSACTIONS_DB_PATH || DEFAULT_TRANSACTIONS_DB,
    port: Number(process.env.PORT || 8182),
  };

  const eatNext = (index) => (index + 1 < argv.length ? argv[index + 1] : null);

  argv.forEach((arg, index) => {
    if (arg.startsWith("--products_db_path=")) {
      options.productsDbPath = arg.split("=")[1];
    } else if (arg === "--products_db_path") {
      const value = eatNext(index);
      if (value) {
        options.productsDbPath = value;
      }
    } else if (arg.startsWith("--products-db-path=")) {
      options.productsDbPath = arg.split("=")[1];
    } else if (arg.startsWith("--transactions_db_path=")) {
      options.transactionsDbPath = arg.split("=")[1];
    } else if (arg === "--transactions_db_path") {
      const value = eatNext(index);
      if (value) {
        options.transactionsDbPath = value;
      }
    } else if (arg.startsWith("--transactions-db-path=")) {
      options.transactionsDbPath = arg.split("=")[1];
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.split("=")[1]);
    } else if (arg === "--port") {
      const value = eatNext(index);
      if (value) {
        options.port = Number(value);
      }
    }
  });

  return options;
};

const { productsDbPath, transactionsDbPath, port } = parseArgs(process.argv.slice(2));
const { productsDb, transactionsDb } = createDatabases({
  productsDbPath,
  transactionsDbPath,
});

const discoveryTemplatePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/discovery_profile.json"
);
const discoveryTemplate = fs.readFileSync(discoveryTemplatePath, "utf-8");
const SHOP_ID = crypto.randomUUID();
const storeProfile = resolveStoreProfile(process.env.UCP_STORE_PROFILE);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: true,
  })
);

const sendError = (res, status, message, code = "INVALID_REQUEST") => {
  res.status(status).json({ detail: message, code });
};

const getAgentRunId = (req) =>
  req.header("x-agent-run-id") ??
  req.body?.agentRunId ??
  req.body?.agent_run_id ??
  null;

const getRequestSeed = (req, fallback) =>
  getAgentRunId(req) ?? fallback ?? req.header("request-id") ?? "";

const getPriceStage = (req, fallback = "quote") => {
  const stage = req.header("x-price-stage") ?? fallback;
  return stage === "checkout" ? "checkout" : "quote";
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "for",
  "from",
  "have",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "show",
  "the",
  "to",
  "we",
  "with",
  "you",
]);

const normalizeText = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value) =>
  normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));

const rankProducts = (query, limit = 6) => {
  const tokens = tokenize(query);
  const products = listProducts(productsDb)
    .map((product) => ({
      ...product,
      price: buildBasePrice(product.price, storeProfile),
      inventory_quantity: getAvailableInventory(product.id),
    }))
    .filter(
      (product) =>
        product.inventory_quantity === null ||
        product.inventory_quantity === undefined ||
        product.inventory_quantity > 0
    );

  if (!tokens.length) {
    return products.slice(0, limit);
  }

  const scored = products
    .map((product) => {
      const title = normalizeText(product.title);
      let score = 0;
      tokens.forEach((token) => {
        if (title.includes(token)) {
          score += token.length;
        }
        if (product.id.toLowerCase() === token) {
          score += 6;
        }
      });
      return { product, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.product.price - b.product.price);

  return scored.slice(0, limit).map((entry) => entry.product);
};

const buildAgentReply = (message) => {
  const text = message.trim();
  const lowered = text.toLowerCase();
  const wantsCheckout = /(checkout|pay|complete|buy now)/.test(lowered);
  const wantsAdd = /(add|include|put|cart|grab|need)/.test(lowered);
  const wantsBrowse = /(show|find|recommend|suggest|looking|search|ingredients|catalog)/.test(
    lowered
  );

  if (!text) {
    return {
      reply: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Ask me for ingredients or a product category.",
        intent: "prompt",
      },
      suggestedItems: [],
      actions: [],
    };
  }

  if (wantsCheckout) {
    return {
      reply: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Ready to check out. You can review the cart and pay now.",
        intent: "checkout",
      },
      suggestedItems: [],
      actions: [{ type: "checkout", label: "Go to checkout" }],
    };
  }

  const matches = wantsBrowse || wantsAdd ? rankProducts(text, 6) : [];
  if (!matches.length) {
    return {
      reply: {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "I could not find a match. Try a product like milk, pasta, or eggs.",
        intent: "no_results",
      },
      suggestedItems: [],
      actions: [],
    };
  }

  const names = matches.map((item) => item.title).join(", ");
  return {
    reply: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `Found ${matches.length} matches: ${names}. Want any added to the cart?`,
      intent: wantsAdd ? "add_items" : "suggest_items",
    },
    suggestedItems: matches,
    actions: wantsAdd ? [{ type: "add_items", label: "Add from list" }] : [],
  };
};

const requireUcpHeaders = (req, res) => {
  const ucpAgent = req.header("ucp-agent");
  const requestId = req.header("request-id");
  const requestSignature = req.header("request-signature");
  if (!ucpAgent || !requestId || !requestSignature) {
    sendError(res, 400, "Missing required UCP headers.");
    return null;
  }
  return { ucpAgent, requestId, requestSignature };
};

const requireIdempotency = (req, res, payload) => {
  const idempotencyKey = req.header("idempotency-key");
  if (!idempotencyKey) {
    sendError(res, 400, "Missing idempotency-key header.");
    return null;
  }
  const requestHash = hashPayload(payload ?? {});
  const existing = getIdempotencyRecord(transactionsDb, idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      sendError(
        res,
        409,
        "Idempotency key reused with different parameters",
        "IDEMPOTENCY_CONFLICT"
      );
      return null;
    }
    res.status(existing.responseStatus).json(existing.responseBody);
    return null;
  }
  return { idempotencyKey, requestHash };
};

const getAvailableInventory = (productId) => {
  const existing = getInventory(transactionsDb, productId);
  if (existing !== null && existing !== undefined) {
    return existing;
  }
  const productQty = getProductInventoryQuantity(productsDb, productId);
  if (productQty !== null && productQty !== undefined) {
    return productQty;
  }
  return DEFAULT_INVENTORY_QUANTITY;
};

const reserveStock = (productId, quantity) => {
  const available = getAvailableInventory(productId);
  if (available === null || available === undefined) {
    return { ok: false, reason: "missing" };
  }
  if (available < quantity) {
    return { ok: false, reason: "out_of_stock" };
  }
  const nextQty = available - quantity;
  setInventory(transactionsDb, productId, nextQty);
  return { ok: true, remaining: nextQty };
};

const resolveFulfillment = ({
  incoming,
  existing,
  lineItemIds,
  checkoutId,
  agentRunId,
}) => {
  if (!incoming && !existing) {
    return { fulfillment: null };
  }

  const slots = listPickupSlots(transactionsDb, storeProfile, new Date());
  const desiredMethod = incoming?.methods?.[0] ?? existing?.methods?.[0] ?? {};
  const desiredGroup = desiredMethod.groups?.[0] ?? existing?.methods?.[0]?.groups?.[0] ?? {};
  const selectedOptionId =
    desiredGroup.selected_option_id ??
    desiredGroup.selectedOptionId ??
    existing?.methods?.[0]?.groups?.[0]?.selected_option_id ??
    null;
  const fallbackOptionId =
    slots.find((slot) => slot.status === "available")?.id ??
    slots[0]?.id ??
    null;
  const resolvedOptionId = selectedOptionId ?? fallbackOptionId;
  const reservationResult = resolvedOptionId
    ? reservePickupSlot(transactionsDb, {
        slotId: resolvedOptionId,
        checkoutId,
        agentRunId,
        profile: storeProfile,
        now: new Date(),
      })
    : { ok: true, reservation: null };

  if (!reservationResult.ok) {
    return { error: reservationResult };
  }

  const optionPrice = storeProfile.fees?.pickupFeeCents ?? 0;
  const options = slots.map((slot) => ({
    id: slot.id,
    title: `Pickup ${slot.timeLabel}`,
    price: optionPrice,
    estimated_range: slot.label,
    metadata: {
      start_at: slot.startAt,
      end_at: slot.endAt,
      available: slot.available,
      capacity: slot.capacity,
    },
  }));

  const method = {
    id: desiredMethod.id ?? "pickup",
    type: "pickup",
    line_item_ids: lineItemIds,
    groups: [
      {
        id: desiredGroup.id ?? "pickup_slots",
        line_item_ids: lineItemIds,
        options,
        selected_option_id: resolvedOptionId,
        reservation: reservationResult.reservation
          ? {
              id: reservationResult.reservation.id,
              expires_at: reservationResult.reservation.expires_at,
            }
          : null,
      },
    ],
    destinations: desiredMethod.destinations ?? null,
  };

  return { fulfillment: { methods: [method] } };
};

const recalcTotals = (lineItems, fulfillment, profile) => {
  let subtotal = 0;
  lineItems.forEach((line) => {
    const lineTotal = line.item.price * line.quantity;
    line.totals = [
      { type: "subtotal", amount: lineTotal },
      { type: "total", amount: lineTotal },
    ];
    subtotal += lineTotal;
  });

  let fulfillmentFee = 0;
  const method = fulfillment?.methods?.[0];
  const group = method?.groups?.[0];
  if (group?.options?.length) {
    const selectedOption = group.options.find(
      (option) => option.id === group.selected_option_id
    );
    fulfillmentFee = selectedOption?.price ?? 0;
  }

  const totals = [{ type: "subtotal", amount: subtotal }];
  if (fulfillmentFee > 0) {
    totals.push({
      type: method?.type === "pickup" ? "pickup" : "shipping",
      amount: fulfillmentFee,
    });
  }
  const serviceFee = profile.fees?.serviceFeeCents ?? 0;
  if (serviceFee > 0) {
    totals.push({ type: "service_fee", amount: serviceFee });
  }
  const taxRate = profile.taxRate ?? 0;
  const tax = taxRate > 0 ? Math.round(subtotal * taxRate) : 0;
  if (tax > 0) {
    totals.push({ type: "tax", amount: tax });
  }
  totals.push({
    type: "total",
    amount: subtotal + fulfillmentFee + serviceFee + tax,
  });
  return totals;
};

const applyPricingToCheckout = (checkout, seed, config, stage) => {
  const updatedLineItems = (checkout.line_items ?? []).map((line) => {
    const product = getProduct(productsDb, line.item?.id);
    if (!product) {
      return line;
    }
    const basePrice = buildBasePrice(product.price, storeProfile);
    const price = applyPriceDrift({
      basePrice,
      productId: product.id,
      seed,
      stage,
      config,
    });
    return {
      ...line,
      item: {
        ...line.item,
        price,
        title: product.title,
        image_url: product.image_url ?? null,
      },
    };
  });

  const totals = recalcTotals(updatedLineItems, checkout.fulfillment, storeProfile);
  return {
    ...checkout,
    line_items: updatedLineItems,
    totals,
  };
};

const buildLineItems = (payloadLineItems, { seed, config, stage }) => {
  if (!Array.isArray(payloadLineItems) || payloadLineItems.length === 0) {
    return { error: "line_items is required." };
  }

  const lineItems = [];
  for (const line of payloadLineItems) {
    const productId = line?.item?.id;
    if (!productId) {
      return { error: "line_items item.id is required." };
    }
    const product = getProduct(productsDb, productId);
    if (!product) {
      return { error: `Product ${productId} not found.` };
    }
    if (typeof line.quantity !== "number" || Number.isNaN(line.quantity) || line.quantity <= 0) {
      return { error: "line_items quantity must be a positive number." };
    }
    const available = getAvailableInventory(productId);
    const isOut =
      available < line.quantity ||
      shouldSimulateOutOfStock({
        productId,
        seed,
        stage: "cart",
        available,
        config,
        lowStockThreshold: storeProfile.lowStockThreshold,
      });
    if (isOut) {
      const alternatives = getSubstitutionCandidates({
        productId,
        profile: storeProfile,
        config,
      });
      return {
        error: {
          message: `Insufficient stock for item ${productId}`,
          itemId: productId,
          alternatives,
        },
        code: "OUT_OF_STOCK",
      };
    }
    const basePrice = buildBasePrice(product.price, storeProfile);
    const price = applyPriceDrift({
      basePrice,
      productId,
      seed,
      stage,
      config,
    });
    const lineId = line.id ?? crypto.randomUUID();
    lineItems.push({
      id: lineId,
      item: {
        id: product.id,
        title: product.title,
        price,
        image_url: product.image_url ?? null,
      },
      quantity: line.quantity,
      totals: [],
    });
  }
  return { lineItems };
};

const serializeAgentRun = (row) => ({
  id: row.id,
  userId: row.user_id,
  deviceId: row.device_id,
  recipeId: row.recipe_id,
  merchantBaseUrl: row.merchant_base_url,
  storeId: row.store_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  state: row.state,
  failureCode: row.failure_code,
  failureDetail: row.failure_detail,
  cartDraftId: row.cart_draft_id,
  orderId: row.order_id,
  zeroEdits:
    row.zero_edits === null || row.zero_edits === undefined
      ? null
      : Boolean(row.zero_edits),
  tapToApprovalMs: row.tap_to_approval_ms ?? null,
  checkoutSuccess:
    row.checkout_success === null || row.checkout_success === undefined
      ? null
      : Boolean(row.checkout_success),
  editCount: row.edit_count ?? 0,
});

const serializeStepLog = (row) => ({
  id: row.id,
  agentRunId: row.agent_run_id,
  stepName: row.step_name,
  requestId: row.request_id,
  idempotencyKey: row.idempotency_key,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  durationMs: row.duration_ms,
  success: Boolean(row.success),
  errorSummary: row.error_summary,
});

const serializeCartDraft = (row) => ({
  id: row.id,
  agentRunId: row.agent_run_id,
  recipeId: row.recipe_id,
  servings: row.servings,
  pantryItemsRemoved: parseJson(row.pantry_items_removed),
  policies: parseJson(row.policies),
  quoteSummary: parseJson(row.quote_summary),
  checkoutSessionId: row.checkout_session_id,
  cartHash: row.cart_hash,
  quoteHash: row.quote_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeCartLineItem = (row, alternatives) => ({
  id: row.id,
  cartDraftId: row.cart_draft_id,
  ingredientKey: row.ingredient_key,
  canonicalIngredientJson: parseJson(row.canonical_ingredient_json),
  primarySkuJson: parseJson(row.primary_sku_json),
  quantity: row.quantity,
  unit: row.unit,
  confidence: row.confidence,
  chosenReason: row.chosen_reason,
  substitutionPolicyJson: parseJson(row.substitution_policy_json),
  lineTotalCents: row.line_total_cents,
  estimatedPricing: Boolean(row.estimated_pricing),
  quantityRangeJson: parseJson(row.quantity_range_json),
  maxVarianceCents: row.max_variance_cents,
  alternatives,
});

const serializeAlternative = (row) => ({
  id: row.id,
  lineItemId: row.line_item_id,
  rank: row.rank,
  skuJson: parseJson(row.sku_json),
  scoreBreakdownJson: parseJson(row.score_breakdown_json),
  reason: row.reason,
  confidence: row.confidence,
});

const serializeApproval = (row) => ({
  id: row.id,
  agentRunId: row.agent_run_id,
  cartHash: row.cart_hash,
  quoteHash: row.quote_hash,
  approvedTotalCents: row.approved_total_cents,
  approvedAt: row.approved_at,
  signatureMock: row.signature_mock,
  status: row.status,
});

const serializeUserEditEvent = (row) => ({
  id: row.id,
  agentRunId: row.agent_run_id,
  ingredientKey: row.ingredient_key,
  actionType: row.action_type,
  fromSkuJson: parseJson(row.from_sku_json),
  toSkuJson: parseJson(row.to_sku_json),
  timestamp: row.timestamp,
  reason: row.reason,
});

const getCartLineItems = (cartDraftId) => {
  const lineRows = transactionsDb
    .prepare("SELECT * FROM cart_draft_line_items WHERE cart_draft_id = ?")
    .all(cartDraftId);
  return lineRows.map((line) => {
    const alternatives = transactionsDb
      .prepare(
        "SELECT * FROM cart_draft_alternatives WHERE line_item_id = ? ORDER BY rank"
      )
      .all(line.id)
      .map(serializeAlternative);
    return serializeCartLineItem(line, alternatives);
  });
};

const replaceCartLineItems = (cartDraftId, lineItems) => {
  const deleteAlternatives = transactionsDb.prepare(
    "DELETE FROM cart_draft_alternatives WHERE line_item_id IN (SELECT id FROM cart_draft_line_items WHERE cart_draft_id = ?)"
  );
  const deleteLines = transactionsDb.prepare(
    "DELETE FROM cart_draft_line_items WHERE cart_draft_id = ?"
  );
  const insertLine = transactionsDb.prepare(
    `
    INSERT INTO cart_draft_line_items (
      id,
      cart_draft_id,
      ingredient_key,
      canonical_ingredient_json,
      primary_sku_json,
      quantity,
      unit,
      confidence,
      chosen_reason,
      substitution_policy_json,
      line_total_cents,
      estimated_pricing,
      quantity_range_json,
      max_variance_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );
  const insertAlternative = transactionsDb.prepare(
    `
    INSERT INTO cart_draft_alternatives (
      id,
      line_item_id,
      rank,
      sku_json,
      score_breakdown_json,
      reason,
      confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  );

  const transaction = transactionsDb.transaction((items) => {
    deleteAlternatives.run(cartDraftId);
    deleteLines.run(cartDraftId);
    (items ?? []).forEach((line) => {
      const lineId = line.id ?? crypto.randomUUID();
      insertLine.run(
        lineId,
        cartDraftId,
        line.ingredientKey,
        serializeJson(line.canonicalIngredientJson),
        serializeJson(line.primarySkuJson),
        line.quantity,
        line.unit ?? null,
        line.confidence ?? null,
        line.chosenReason ?? null,
        serializeJson(line.substitutionPolicyJson),
        line.lineTotalCents ?? null,
        line.estimatedPricing ? 1 : 0,
        serializeJson(line.quantityRangeJson),
        line.maxVarianceCents ?? null
      );

      (line.alternatives ?? []).forEach((alt) => {
        insertAlternative.run(
          alt.id ?? crypto.randomUUID(),
          lineId,
          alt.rank,
          serializeJson(alt.skuJson),
          serializeJson(alt.scoreBreakdownJson),
          alt.reason ?? null,
          alt.confidence ?? null
        );
      });
    });
  });

  transaction(lineItems);
};

app.get("/.well-known/ucp", (req, res) => {
  const baseUrl = normalizeUrl(`${req.protocol}://${req.get("host")}`);
  const payload = JSON.parse(
    discoveryTemplate
      .replace("{{ENDPOINT}}", baseUrl)
      .replace("{{SHOP_ID}}", SHOP_ID)
  );
  const handlers = payload.payment?.handlers ?? [];
  handlers.forEach((handler) => {
    if (handler.config?.merchant_info?.merchant_name) {
      handler.config.merchant_info.merchant_name = storeProfile.name;
      handler.config.merchant_info.merchant_origin = baseUrl;
    }
  });
  payload.merchant = {
    id: storeProfile.id,
    name: storeProfile.name,
    label: storeProfile.label,
    address: storeProfile.address,
    timezone: storeProfile.timezone,
    fees: storeProfile.fees,
    tax_rate: storeProfile.taxRate,
    pickup: {
      slot_minutes: storeProfile.pickup.slotMinutes,
      hold_minutes: storeProfile.pickup.holdMinutes,
      capacity: storeProfile.pickup.capacity,
    },
  };
  payload.store_ops = {
    profile: `${baseUrl}/store-ops/profile`,
    substitutions: `${baseUrl}/store-ops/substitutions`,
    pickup_slots: `${baseUrl}/store-ops/pickup-slots`,
  };
  res.json(payload);
});

app.get("/.well-known/agent-card.json", (req, res) => {
  const baseUrl = normalizeUrl(`${req.protocol}://${req.get("host")}`);
  res.json({
    id: "dish-feed-agent",
    name: "Dish Feed Agent",
    description: "Conversational assistant for Dish Feed grocery runs.",
    version: "0.1.0",
    profile: `${baseUrl}/profile/agent-profile.json`,
    endpoints: {
      messages: `${baseUrl}/agent/messages`,
    },
    ucp: `${baseUrl}/.well-known/ucp`,
  });
});

app.get("/profile/agent-profile.json", (req, res) => {
  const baseUrl = normalizeUrl(`${req.protocol}://${req.get("host")}`);
  res.json({
    agent: {
      name: "Dish Feed Agent",
      version: "0.1.0",
      description:
        "Maps ingredient requests to the catalog and guides checkout.",
      endpoints: {
        messages: `${baseUrl}/agent/messages`,
      },
    },
    ucp: {
      version: "2026-01-11",
      merchant: `${baseUrl}/.well-known/ucp`,
    },
  });
});

app.get("/store-ops/profile", (req, res) => {
  const baseUrl = normalizeUrl(`${req.protocol}://${req.get("host")}`);
  const config = getStoreOpsConfig(req, storeProfile);
  res.json({
    store: {
      id: storeProfile.id,
      name: storeProfile.name,
      label: storeProfile.label,
      address: storeProfile.address,
      timezone: storeProfile.timezone,
      priceMultiplier: storeProfile.priceMultiplier,
      lowStockThreshold: storeProfile.lowStockThreshold,
      fees: storeProfile.fees,
      taxRate: storeProfile.taxRate,
      pickup: storeProfile.pickup,
    },
    defaults: storeProfile.defaults,
    config: {
      volatility: config.volatilityLevel,
      driftMagnitude: config.driftMagnitude,
      substitutionAggressiveness: config.substitutionAggressiveness,
    },
    endpoints: {
      substitutions: `${baseUrl}/store-ops/substitutions`,
      pickupSlots: `${baseUrl}/store-ops/pickup-slots`,
    },
  });
});

app.get("/store-ops/substitutions", (req, res) => {
  const config = getStoreOpsConfig(req, storeProfile);
  res.json({
    storeId: storeProfile.id,
    maxFallbacks: config.substitution.maxFallbacks,
    substitutionGraph: storeProfile.substitutionGraph ?? {},
  });
});

app.get("/store-ops/pickup-slots", (req, res) => {
  const slots = listPickupSlots(transactionsDb, storeProfile, new Date());
  res.json({
    storeId: storeProfile.id,
    holdMinutes: storeProfile.pickup.holdMinutes,
    slotMinutes: storeProfile.pickup.slotMinutes,
    slots,
  });
});

app.post("/agent/messages", (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  const response = buildAgentReply(message);
  res.json(response);
});

app.get("/products", (req, res) => {
  const rows = listProducts(productsDb);
  res.json({
    products: rows.map((row) => ({
      id: row.id,
      title: row.title,
      price: buildBasePrice(row.price, storeProfile),
      image_url: row.image_url ?? null,
      inventory_quantity: getAvailableInventory(row.id),
    })),
  });
});

app.post("/checkout-sessions", (req, res) => {
  if (!requireUcpHeaders(req, res)) {
    return;
  }
  const idempotency = requireIdempotency(req, res, req.body);
  if (!idempotency) {
    return;
  }

  const payload = req.body ?? {};
  const checkoutId = payload.id ?? crypto.randomUUID();
  const storeOpsConfig = getStoreOpsConfig(req, storeProfile);
  const seed = getRequestSeed(req, checkoutId);
  const stage = getPriceStage(req, "quote");
  const { lineItems, error, code } = buildLineItems(payload.line_items, {
    seed,
    config: storeOpsConfig,
    stage,
  });
  if (error) {
    sendError(res, code === "OUT_OF_STOCK" ? 400 : 400, error, code);
    return;
  }

  const payment = {
    handlers: payload.payment?.handlers ?? [],
    instruments: payload.payment?.instruments ?? [],
    selected_instrument_id: payload.payment?.selected_instrument_id ?? null,
  };

  const agentRunId = getAgentRunId(req);
  const fulfillmentResult = resolveFulfillment({
    incoming: payload.fulfillment ?? null,
    existing: null,
    lineItemIds: lineItems.map((line) => line.id),
    checkoutId,
    agentRunId,
  });
  if (fulfillmentResult.error) {
    sendError(res, 409, fulfillmentResult.error, fulfillmentResult.error.code);
    return;
  }
  const fulfillment = fulfillmentResult.fulfillment;
  const totals = recalcTotals(lineItems, fulfillment, storeProfile);
  const checkout = {
    id: checkoutId,
    status: "IN_PROGRESS",
    currency: payload.currency ?? "USD",
    line_items: lineItems,
    totals,
    links: [],
    payment,
    fulfillment,
    buyer: payload.buyer ?? null,
    agent_run_id: agentRunId,
  };

  saveCheckout(transactionsDb, checkoutId, checkout.status, checkout);
  saveIdempotencyRecord(
    transactionsDb,
    idempotency.idempotencyKey,
    idempotency.requestHash,
    200,
    checkout
  );
  res.json(checkout);
});

app.get("/checkout-sessions/:id", (req, res) => {
  if (!requireUcpHeaders(req, res)) {
    return;
  }
  const checkout = getCheckout(transactionsDb, req.params.id);
  if (!checkout) {
    sendError(res, 404, "Checkout session not found", "RESOURCE_NOT_FOUND");
    return;
  }
  const storeOpsConfig = getStoreOpsConfig(req, storeProfile);
  const seed = getRequestSeed(req, checkout.agent_run_id ?? checkout.id);
  const stage = getPriceStage(req, "quote");
  const updated = applyPricingToCheckout(checkout, seed, storeOpsConfig, stage);
  if (updated !== checkout) {
    saveCheckout(transactionsDb, updated.id, updated.status, updated);
  }
  res.json(updated);
});

app.put("/checkout-sessions/:id", (req, res) => {
  if (!requireUcpHeaders(req, res)) {
    return;
  }
  const idempotency = requireIdempotency(req, res, req.body);
  if (!idempotency) {
    return;
  }

  const existing = getCheckout(transactionsDb, req.params.id);
  if (!existing) {
    sendError(res, 404, "Checkout session not found", "RESOURCE_NOT_FOUND");
    return;
  }

  const payload = req.body ?? {};
  const storeOpsConfig = getStoreOpsConfig(req, storeProfile);
  const seed = getRequestSeed(req, existing.agent_run_id ?? existing.id);
  const stage = getPriceStage(req, "quote");
  const { lineItems, error, code } = payload.line_items
    ? buildLineItems(payload.line_items, {
        seed,
        config: storeOpsConfig,
        stage,
      })
    : { lineItems: existing.line_items };

  if (error) {
    sendError(res, code === "OUT_OF_STOCK" ? 400 : 400, error, code);
    return;
  }

  const fulfillmentResult = resolveFulfillment({
    incoming: payload.fulfillment ?? existing.fulfillment ?? null,
    existing: existing.fulfillment ?? null,
    lineItemIds: lineItems.map((line) => line.id),
    checkoutId: existing.id,
    agentRunId: getAgentRunId(req) ?? existing.agent_run_id,
  });
  if (fulfillmentResult.error) {
    sendError(res, 409, fulfillmentResult.error, fulfillmentResult.error.code);
    return;
  }
  const fulfillment = fulfillmentResult.fulfillment;

  const updated = {
    ...existing,
    line_items: lineItems,
    payment: {
      ...existing.payment,
      ...payload.payment,
    },
    fulfillment,
    agent_run_id: getAgentRunId(req) ?? existing.agent_run_id,
  };
  updated.totals = recalcTotals(updated.line_items, updated.fulfillment, storeProfile);

  saveCheckout(transactionsDb, updated.id, updated.status, updated);
  saveIdempotencyRecord(
    transactionsDb,
    idempotency.idempotencyKey,
    idempotency.requestHash,
    200,
    updated
  );
  res.json(updated);
});

app.post("/checkout-sessions/:id/complete", (req, res) => {
  if (!requireUcpHeaders(req, res)) {
    return;
  }
  const idempotency = requireIdempotency(req, res, req.body);
  if (!idempotency) {
    return;
  }

  const checkout = getCheckout(transactionsDb, req.params.id);
  if (!checkout) {
    sendError(res, 404, "Checkout session not found", "RESOURCE_NOT_FOUND");
    return;
  }

  const paymentData = req.body?.payment_data;
  const token = paymentData?.credential?.token;
  if (token === "fail_token") {
    sendError(res, 402, "Payment failed", "PAYMENT_FAILED");
    return;
  }

  const storeOpsConfig = getStoreOpsConfig(req, storeProfile);
  const seed = getRequestSeed(req, checkout.agent_run_id ?? checkout.id);
  const orderId = `order_${checkout.id}`;
  const slotResult = confirmPickupSlot(transactionsDb, {
    checkoutId: checkout.id,
    orderId,
    seed,
    config: storeOpsConfig,
  });
  if (!slotResult.ok) {
    sendError(res, 409, slotResult, slotResult.code);
    return;
  }

  const pricedCheckout = applyPricingToCheckout(
    checkout,
    seed,
    storeOpsConfig,
    "checkout"
  );
  const reservation = pricedCheckout.line_items.map((line) => ({
    id: line.item.id,
    quantity: line.quantity,
  }));

  for (const item of reservation) {
    const available = getAvailableInventory(item.id);
    const isOut =
      available < item.quantity ||
      shouldSimulateOutOfStock({
        productId: item.id,
        seed,
        stage: "pick",
        available,
        config: storeOpsConfig,
        lowStockThreshold: storeProfile.lowStockThreshold,
      });
    if (isOut) {
      const alternatives = getSubstitutionCandidates({
        productId: item.id,
        profile: storeProfile,
        config: storeOpsConfig,
      });
      sendError(
        res,
        409,
        {
          message: `Item ${item.id} is out of stock`,
          itemId: item.id,
          alternatives,
        },
        "OUT_OF_STOCK"
      );
      return;
    }
    const result = reserveStock(item.id, item.quantity);
    if (!result.ok) {
      sendError(
        res,
        409,
        { message: `Item ${item.id} is out of stock`, itemId: item.id },
        "OUT_OF_STOCK"
      );
      return;
    }
  }

  const order = {
    id: orderId,
    checkout_id: pricedCheckout.id,
    permalink_url: `${normalizeUrl(`${req.protocol}://${req.get("host")}`)}/orders/${orderId}`,
    line_items: pricedCheckout.line_items,
    totals: pricedCheckout.totals,
    fulfillment: pricedCheckout.fulfillment ?? null,
    created_at: nowIso(),
    status: "processing",
  };

  const completed = {
    ...pricedCheckout,
    status: "COMPLETED",
    order,
  };

  saveOrder(transactionsDb, orderId, order);
  saveCheckout(transactionsDb, checkout.id, completed.status, completed);
  saveIdempotencyRecord(
    transactionsDb,
    idempotency.idempotencyKey,
    idempotency.requestHash,
    200,
    completed
  );

  res.json(completed);
});

app.get("/orders/:id", (req, res) => {
  if (!requireUcpHeaders(req, res)) {
    return;
  }
  const order = getOrder(transactionsDb, req.params.id);
  if (!order) {
    sendError(res, 404, "Order not found", "RESOURCE_NOT_FOUND");
    return;
  }
  res.json(order);
});

app.post("/agent-runs", (req, res) => {
  const payload = req.body ?? {};
  const agentRunId = payload.id ?? crypto.randomUUID();
  const existing = transactionsDb
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(agentRunId);
  const timestamp = nowIso();

  if (existing) {
    const updated = {
      user_id: payload.userId ?? existing.user_id,
      device_id: payload.deviceId ?? existing.device_id,
      recipe_id: payload.recipeId ?? existing.recipe_id,
      merchant_base_url: payload.merchantBaseUrl ?? existing.merchant_base_url,
      store_id: payload.storeId ?? existing.store_id,
      state: payload.state ?? existing.state,
      failure_code: payload.failureCode ?? existing.failure_code,
      failure_detail: payload.failureDetail ?? existing.failure_detail,
      cart_draft_id: payload.cartDraftId ?? existing.cart_draft_id,
      order_id: payload.orderId ?? existing.order_id,
      zero_edits:
        payload.zeroEdits === undefined || payload.zeroEdits === null
          ? existing.zero_edits
          : payload.zeroEdits
            ? 1
            : 0,
      tap_to_approval_ms:
        payload.tapToApprovalMs ?? existing.tap_to_approval_ms,
      checkout_success:
        payload.checkoutSuccess === undefined || payload.checkoutSuccess === null
          ? existing.checkout_success
          : payload.checkoutSuccess
            ? 1
            : 0,
      edit_count: payload.editCount ?? existing.edit_count,
      updated_at: payload.updatedAt ?? timestamp,
    };
    transactionsDb
      .prepare(
        `
        UPDATE agent_runs SET
          user_id = ?,
          device_id = ?,
          recipe_id = ?,
          merchant_base_url = ?,
          store_id = ?,
          updated_at = ?,
          state = ?,
          failure_code = ?,
          failure_detail = ?,
          cart_draft_id = ?,
          order_id = ?,
          zero_edits = ?,
          tap_to_approval_ms = ?,
          checkout_success = ?,
          edit_count = ?
        WHERE id = ?
        `
      )
      .run(
        updated.user_id,
        updated.device_id,
        updated.recipe_id,
        updated.merchant_base_url,
        updated.store_id,
        updated.updated_at,
        updated.state,
        updated.failure_code,
        updated.failure_detail,
        updated.cart_draft_id,
        updated.order_id,
        updated.zero_edits,
        updated.tap_to_approval_ms,
        updated.checkout_success,
        updated.edit_count,
        agentRunId
      );
    const row = transactionsDb
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(agentRunId);
    res.json({ agentRun: serializeAgentRun(row) });
    return;
  }

  const createdAt = payload.createdAt ?? timestamp;
  const updatedAt = payload.updatedAt ?? timestamp;
  const state = payload.state ?? "DISCOVER_MERCHANT";

  transactionsDb
    .prepare(
      `
      INSERT INTO agent_runs (
        id,
        user_id,
        device_id,
        recipe_id,
        merchant_base_url,
        store_id,
        created_at,
        updated_at,
        state,
        failure_code,
        failure_detail,
        cart_draft_id,
        order_id,
        zero_edits,
        tap_to_approval_ms,
        checkout_success,
        edit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      agentRunId,
      payload.userId ?? null,
      payload.deviceId ?? null,
      payload.recipeId ?? null,
      payload.merchantBaseUrl ?? null,
      payload.storeId ?? null,
      createdAt,
      updatedAt,
      state,
      payload.failureCode ?? null,
      payload.failureDetail ?? null,
      payload.cartDraftId ?? null,
      payload.orderId ?? null,
      payload.zeroEdits === undefined || payload.zeroEdits === null
        ? null
        : payload.zeroEdits
          ? 1
          : 0,
      payload.tapToApprovalMs ?? null,
      payload.checkoutSuccess === undefined || payload.checkoutSuccess === null
        ? null
        : payload.checkoutSuccess
          ? 1
          : 0,
      payload.editCount ?? 0
    );

  const row = transactionsDb
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(agentRunId);
  res.json({ agentRun: serializeAgentRun(row) });
});

app.patch("/agent-runs/:id", (req, res) => {
  const agentRunId = req.params.id;
  const existing = transactionsDb
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(agentRunId);
  if (!existing) {
    sendError(res, 404, "Agent run not found.");
    return;
  }
  const payload = req.body ?? {};
  const updatedAt = payload.updatedAt ?? nowIso();

  transactionsDb
    .prepare(
      `
      UPDATE agent_runs SET
        user_id = ?,
        device_id = ?,
        recipe_id = ?,
        merchant_base_url = ?,
        store_id = ?,
        updated_at = ?,
        state = ?,
        failure_code = ?,
        failure_detail = ?,
        cart_draft_id = ?,
        order_id = ?,
        zero_edits = ?,
        tap_to_approval_ms = ?,
        checkout_success = ?,
        edit_count = ?
      WHERE id = ?
      `
    )
    .run(
      payload.userId ?? existing.user_id,
      payload.deviceId ?? existing.device_id,
      payload.recipeId ?? existing.recipe_id,
      payload.merchantBaseUrl ?? existing.merchant_base_url,
      payload.storeId ?? existing.store_id,
      updatedAt,
      payload.state ?? existing.state,
      payload.failureCode ?? existing.failure_code,
      payload.failureDetail ?? existing.failure_detail,
      payload.cartDraftId ?? existing.cart_draft_id,
      payload.orderId ?? existing.order_id,
      payload.zeroEdits === undefined || payload.zeroEdits === null
        ? existing.zero_edits
        : payload.zeroEdits
          ? 1
          : 0,
      payload.tapToApprovalMs ?? existing.tap_to_approval_ms,
      payload.checkoutSuccess === undefined || payload.checkoutSuccess === null
        ? existing.checkout_success
        : payload.checkoutSuccess
          ? 1
          : 0,
      payload.editCount ?? existing.edit_count,
      agentRunId
    );

  const row = transactionsDb
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(agentRunId);
  res.json({ agentRun: serializeAgentRun(row) });
});

app.get("/agent-runs/:id", (req, res) => {
  const row = transactionsDb
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(req.params.id);
  if (!row) {
    sendError(res, 404, "Agent run not found.");
    return;
  }
  res.json({ agentRun: serializeAgentRun(row) });
});

app.post("/agent-run-steps", (req, res) => {
  const payload = req.body ?? {};
  const stepId = payload.id ?? crypto.randomUUID();
  const startedAt = payload.startedAt ?? nowIso();

  transactionsDb
    .prepare(
      `
      INSERT INTO agent_run_step_logs (
        id,
        agent_run_id,
        step_name,
        request_id,
        idempotency_key,
        started_at,
        finished_at,
        duration_ms,
        success,
        error_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      stepId,
      payload.agentRunId,
      payload.stepName,
      payload.requestId ?? null,
      payload.idempotencyKey ?? null,
      startedAt,
      payload.finishedAt ?? null,
      payload.durationMs ?? null,
      payload.success ? 1 : 0,
      payload.errorSummary ?? null
    );

  const row = transactionsDb
    .prepare("SELECT * FROM agent_run_step_logs WHERE id = ?")
    .get(stepId);
  res.json({ stepLog: serializeStepLog(row) });
});

app.post("/cart-drafts", (req, res) => {
  const payload = req.body ?? {};
  const cart = payload.cart ?? {};
  const cartId = cart.id ?? crypto.randomUUID();
  const existing = transactionsDb
    .prepare("SELECT * FROM cart_drafts WHERE id = ?")
    .get(cartId);
  const timestamp = nowIso();

  if (existing) {
    transactionsDb
      .prepare(
        `
        UPDATE cart_drafts SET
          agent_run_id = ?,
          recipe_id = ?,
          servings = ?,
          pantry_items_removed = ?,
          policies = ?,
          quote_summary = ?,
          checkout_session_id = ?,
          cart_hash = ?,
          quote_hash = ?,
          updated_at = ?
        WHERE id = ?
        `
      )
      .run(
        cart.agentRunId ?? existing.agent_run_id,
        cart.recipeId ?? existing.recipe_id,
        cart.servings ?? existing.servings,
        serializeJson(cart.pantryItemsRemoved ?? parseJson(existing.pantry_items_removed)),
        serializeJson(cart.policies ?? parseJson(existing.policies)),
        serializeJson(cart.quoteSummary ?? parseJson(existing.quote_summary)),
        cart.checkoutSessionId ?? existing.checkout_session_id,
        cart.cartHash ?? existing.cart_hash,
        cart.quoteHash ?? existing.quote_hash,
        cart.updatedAt ?? timestamp,
        cartId
      );
    replaceCartLineItems(cartId, payload.lineItems ?? []);
  } else {
    transactionsDb
      .prepare(
        `
        INSERT INTO cart_drafts (
          id,
          agent_run_id,
          recipe_id,
          servings,
          pantry_items_removed,
          policies,
          quote_summary,
          checkout_session_id,
          cart_hash,
          quote_hash,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        cartId,
        cart.agentRunId ?? null,
        cart.recipeId ?? null,
        cart.servings ?? null,
        serializeJson(cart.pantryItemsRemoved),
        serializeJson(cart.policies),
        serializeJson(cart.quoteSummary),
        cart.checkoutSessionId ?? null,
        cart.cartHash ?? null,
        cart.quoteHash ?? null,
        cart.createdAt ?? timestamp,
        cart.updatedAt ?? timestamp
      );
    replaceCartLineItems(cartId, payload.lineItems ?? []);
  }

  const row = transactionsDb
    .prepare("SELECT * FROM cart_drafts WHERE id = ?")
    .get(cartId);
  res.json({ cart: serializeCartDraft(row), lineItems: getCartLineItems(cartId) });
});

app.patch("/cart-drafts/:id", (req, res) => {
  const cartId = req.params.id;
  const existing = transactionsDb
    .prepare("SELECT * FROM cart_drafts WHERE id = ?")
    .get(cartId);
  if (!existing) {
    sendError(res, 404, "Cart draft not found.");
    return;
  }

  const payload = req.body ?? {};
  const updatedAt = payload.updatedAt ?? nowIso();

  transactionsDb
    .prepare(
      `
      UPDATE cart_drafts SET
        agent_run_id = ?,
        recipe_id = ?,
        servings = ?,
        pantry_items_removed = ?,
        policies = ?,
        quote_summary = ?,
        checkout_session_id = ?,
        cart_hash = ?,
        quote_hash = ?,
        updated_at = ?
      WHERE id = ?
      `
    )
    .run(
      payload.agentRunId ?? existing.agent_run_id,
      payload.recipeId ?? existing.recipe_id,
      payload.servings ?? existing.servings,
      serializeJson(payload.pantryItemsRemoved ?? parseJson(existing.pantry_items_removed)),
      serializeJson(payload.policies ?? parseJson(existing.policies)),
      serializeJson(payload.quoteSummary ?? parseJson(existing.quote_summary)),
      payload.checkoutSessionId ?? existing.checkout_session_id,
      payload.cartHash ?? existing.cart_hash,
      payload.quoteHash ?? existing.quote_hash,
      updatedAt,
      cartId
    );

  const row = transactionsDb
    .prepare("SELECT * FROM cart_drafts WHERE id = ?")
    .get(cartId);
  res.json({ cart: serializeCartDraft(row), lineItems: getCartLineItems(cartId) });
});

app.get("/cart-drafts/:id", (req, res) => {
  const cartId = req.params.id;
  const row = transactionsDb
    .prepare("SELECT * FROM cart_drafts WHERE id = ?")
    .get(cartId);
  if (!row) {
    sendError(res, 404, "Cart draft not found.");
    return;
  }
  res.json({ cart: serializeCartDraft(row), lineItems: getCartLineItems(cartId) });
});

app.post("/user-edit-events", (req, res) => {
  const payload = req.body ?? {};
  if (!payload.agentRunId) {
    sendError(res, 400, "agentRunId is required.");
    return;
  }
  if (!payload.actionType) {
    sendError(res, 400, "actionType is required.");
    return;
  }

  const eventId = payload.id ?? crypto.randomUUID();
  const timestamp = payload.timestamp ?? nowIso();
  transactionsDb
    .prepare(
      `
      INSERT INTO user_edit_events (
        id,
        agent_run_id,
        ingredient_key,
        action_type,
        from_sku_json,
        to_sku_json,
        timestamp,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      eventId,
      payload.agentRunId,
      payload.ingredientKey ?? null,
      payload.actionType,
      serializeJson(payload.fromSkuJson ?? null),
      serializeJson(payload.toSkuJson ?? null),
      timestamp,
      payload.reason ?? null
    );

  const editCountRow = transactionsDb
    .prepare(
      "SELECT COUNT(*) as count FROM user_edit_events WHERE agent_run_id = ?"
    )
    .get(payload.agentRunId);
  const editCount = editCountRow?.count ?? 0;
  transactionsDb
    .prepare(
      `
      UPDATE agent_runs
      SET edit_count = ?, zero_edits = ?, updated_at = ?
      WHERE id = ?
      `
    )
    .run(editCount, editCount === 0 ? 1 : 0, nowIso(), payload.agentRunId);

  const row = transactionsDb
    .prepare("SELECT * FROM user_edit_events WHERE id = ?")
    .get(eventId);
  const runRow = transactionsDb
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(payload.agentRunId);

  res.json({
    event: serializeUserEditEvent(row),
    agentRun: runRow ? serializeAgentRun(runRow) : null,
  });
});

app.get("/metrics/summary", (req, res) => {
  const ingredientRows = transactionsDb
    .prepare(
      `
      SELECT ingredient_key as ingredientKey, COUNT(*) as count
      FROM user_edit_events
      WHERE ingredient_key IS NOT NULL
      GROUP BY ingredient_key
      ORDER BY count DESC
      LIMIT 10
      `
    )
    .all();

  const rejectedRows = transactionsDb
    .prepare(
      `
      SELECT from_sku_json
      FROM user_edit_events
      WHERE action_type = ?
      `
    )
    .all("rejectedReplacement");

  const rejectedMap = new Map();
  rejectedRows.forEach((row) => {
    const sku = parseJson(row.from_sku_json) ?? {};
    const skuId = sku.id ?? null;
    const title = sku.title ?? sku.name ?? "Unknown SKU";
    const key = skuId ?? title;
    if (!key) {
      return;
    }
    const entry = rejectedMap.get(key) ?? {
      skuId,
      title,
      count: 0,
    };
    entry.count += 1;
    rejectedMap.set(key, entry);
  });

  const topRejectedSkus = [...rejectedMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const totalRunsRow = transactionsDb
    .prepare("SELECT COUNT(*) as count FROM agent_runs")
    .get();
  const totalEditsRow = transactionsDb
    .prepare("SELECT COUNT(*) as count FROM user_edit_events")
    .get();

  res.json({
    totalRuns: totalRunsRow?.count ?? 0,
    totalEdits: totalEditsRow?.count ?? 0,
    topIngredients: ingredientRows,
    topRejectedSkus,
  });
});

app.post("/approvals", (req, res) => {
  const payload = req.body ?? {};
  const approvalId = payload.id ?? crypto.randomUUID();
  const approvedAt = payload.approvedAt ?? nowIso();

  transactionsDb
    .prepare(
      `
      INSERT INTO approvals (
        id,
        agent_run_id,
        cart_hash,
        quote_hash,
        approved_total_cents,
        approved_at,
        signature_mock,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      approvalId,
      payload.agentRunId,
      payload.cartHash,
      payload.quoteHash,
      payload.approvedTotalCents ?? null,
      approvedAt,
      payload.signatureMock ?? null,
      payload.status
    );

  const row = transactionsDb
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(approvalId);
  res.json({ approval: serializeApproval(row) });
});

app.get("/approvals", (req, res) => {
  const agentRunId = req.query.agentRunId
    ? String(req.query.agentRunId)
    : null;
  const cartHash = req.query.cartHash ? String(req.query.cartHash) : null;
  const approval = getLatestApproval(transactionsDb, {
    agentRunId,
    cartHash,
  });
  res.json({ approval: approval ?? null });
});

app.listen(port, () => {
  console.log(
    `UCP Node merchant server listening on port ${port} (products DB: ${productsDbPath}, transactions DB: ${transactionsDbPath})`
  );
});

import { useEffect, useMemo, useState } from "react";
import { INGREDIENTS } from "./data/ingredients";
import { RECIPES } from "./data/recipes";
import {
  normalizeText,
  parseCanonicalIngredient,
  rankProducts,
} from "./lib/ingredientMatcher";

const API_BASE = import.meta.env.VITE_UCP_BASE_URL || "/api";
const UCP_AGENT =
  'dish-feed/0.1; version="2026-01-11"; profile="https://dishfeed.app/agent"';

const DEFAULT_MERCHANTS = [
  "http://localhost:8182",
  "http://localhost:8282",
];
const LOCAL_PROXY_TARGETS = new Set([
  "http://localhost:8182",
  "http://127.0.0.1:8182",
]);

const DEFAULT_SIM_CONFIG = {
  volatility: "medium",
  driftMagnitude: "medium",
  substitutionAggressiveness: "balanced",
};

const VOLATILITY_OPTIONS = ["low", "medium", "high"];
const DRIFT_OPTIONS = ["low", "medium", "high"];
const SUBSTITUTION_OPTIONS = ["conservative", "balanced", "aggressive"];

const INGREDIENT_INDEX = INGREDIENTS.reduce((acc, item) => {
  acc[item.id] = {
    ...item,
    query: item.query ?? item.name,
  };
  return acc;
}, {});

const CATEGORY_FILTERS = [
  "All",
  "Produce",
  "Dairy",
  "Protein",
  "Pantry",
  "Herbs",
  "Spices",
  "Bakery",
];

const PANTRY_ITEMS = [
  {
    id: "salt",
    label: "Sea Salt",
    keywords: ["salt"],
    ingredientKey: "salt",
  },
  {
    id: "olive_oil",
    label: "Olive Oil",
    keywords: ["olive oil"],
    ingredientKey: "olive_oil",
  },
  {
    id: "butter",
    label: "Butter",
    keywords: ["butter"],
    ingredientKey: "butter",
  },
  {
    id: "garlic",
    label: "Garlic",
    keywords: ["garlic"],
    ingredientKey: "garlic",
  },
  {
    id: "flour",
    label: "Flour",
    keywords: ["flour"],
    ingredientKey: "flour",
  },
  {
    id: "sugar",
    label: "Sugar",
    keywords: ["sugar"],
    ingredientKey: "sugar",
  },
];

const AGENT_TIMELINE = [
  {
    key: "DISCOVER_MERCHANT",
    label: "Discover stores",
    description: "Finding available stores and checking connectivity.",
  },
  {
    key: "CHECK_CAPABILITIES",
    label: "Verify checkout",
    description: "Checking payments, policies, and pickup options.",
  },
  {
    key: "RESOLVE_INGREDIENTS",
    label: "Finding the best matches",
    description: "Matching ingredients to the best store items.",
  },
  {
    key: "BUILD_CART_DRAFT",
    label: "Saving your cart",
    description: "Building a cart draft you can review.",
  },
  {
    key: "QUOTE_CART",
    label: "Confirming total",
    description: "Pulling a live price from the merchant.",
  },
  {
    key: "AWAITING_APPROVAL",
    label: "Ready for approval",
    description: "Waiting for you to approve the cart.",
  },
  {
    key: "CHECKOUT",
    label: "Checkout ready",
    description: "Preparing the checkout session.",
  },
  {
    key: "ORDER_CREATED",
    label: "Order confirmed",
    description: "Payment approved and order placed.",
  },
  {
    key: "ORDER_TRACKING",
    label: "Pickup scheduled",
    description: "Tracking pickup and fulfillment.",
  },
  {
    key: "FAILED",
    label: "Needs attention",
    description: "We need your help before we can proceed.",
  },
];

const VIEW_MODES = {
  FEED: "FEED",
  CART_REVIEW: "CART_REVIEW",
  CHECKOUT: "CHECKOUT",
};

const COMPACT_PROGRESS_STEPS = [
  { key: "match", label: "Matching items" },
  { key: "quote", label: "Confirming total" },
  { key: "review", label: "Ready to review" },
];

const makeId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

const baseHeaders = ({
  requestId,
  idempotencyKey,
  agentRunId,
  storeOpsConfig,
  priceStage,
} = {}) => {
  const headers = {
    "UCP-Agent": UCP_AGENT,
    "request-signature": "test",
    "request-id": requestId ?? makeId(),
    "idempotency-key": idempotencyKey ?? makeId(),
  };
  if (agentRunId) {
    headers["x-agent-run-id"] = agentRunId;
  }
  if (storeOpsConfig) {
    headers["x-storeops-config"] = JSON.stringify(storeOpsConfig);
  }
  if (priceStage) {
    headers["x-price-stage"] = priceStage;
  }
  return headers;
};

const buildRequestId = (agentRunId, tag) =>
  agentRunId ? `${agentRunId}:${tag}` : makeId();

const buildCheckoutIdempotencyKey = ({
  agentRunId,
  cartDraftId,
  cartHash,
}) => {
  const base = agentRunId ?? cartDraftId ?? makeId();
  const suffix = cartHash ?? makeId();
  return `checkout_${base}_${suffix}`;
};

const safeJson = async (response) => {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
};

const normalizeUrl = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("/")) {
    return trimmed.replace(/\/+$/, "");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed.replace(/\/+$/, "")}`;
  }
  return trimmed.replace(/\/+$/, "");
};

const resolveMerchantBase = (value) => {
  const trimmed = normalizeUrl(value);
  if (!trimmed) {
    return API_BASE;
  }
  if (API_BASE.startsWith("/") && LOCAL_PROXY_TARGETS.has(trimmed)) {
    return API_BASE;
  }
  return trimmed;
};

const formatMerchantLabel = (url, index, debugEnabled) => {
  if (debugEnabled) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return "Dish Feed Market";
    }
    return parsed.hostname;
  } catch (error) {
    return `Merchant ${index + 1}`;
  }
};

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
};

const hashString = async (value) => {
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    const data = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return `js-${Math.abs(hash)}`;
};

const getDeviceId = () => {
  if (typeof window === "undefined") {
    return makeId();
  }
  const storageKey = "dishfeed_device_id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }
  const next = makeId();
  window.localStorage.setItem(storageKey, next);
  return next;
};

const joinUrl = (base, path) => {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${root}${path}` : `${root}/${path}`;
};

const formatMoney = (amount) =>
  (amount / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

const formatTotalLabel = (type) => {
  const labels = {
    subtotal: "Subtotal",
    shipping: "Shipping",
    pickup: "Pickup",
    service_fee: "Service fee",
    tax: "Tax",
    discount: "Discount",
  };
  return labels[type] ?? type;
};

const MEAT_KEYS = new Set([
  "bacon",
  "ground_beef",
  "chicken_breast",
  "salmon",
  "shrimp",
  "beef",
  "pork",
  "sausage",
  "turkey",
]);

const getRecipeMinutes = (recipe) => {
  const match = recipe?.time?.match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
};

const getRecipeServings = (recipe) => {
  if (!recipe) {
    return 2;
  }
  if (recipe.tag === "Family") {
    return 4;
  }
  if (recipe.tag === "Breakfast" || recipe.tag === "Snack") {
    return 2;
  }
  if (recipe.tag === "Side") {
    return 2;
  }
  return 3;
};

const getRecipeEstimate = (recipe) => {
  if (!recipe) {
    return null;
  }
  let total = 0;
  recipe.ingredients.forEach((ingredient) => {
    const base = INGREDIENT_INDEX[ingredient.key];
    if (base?.price) {
      total += base.price * (ingredient.quantity ?? 1);
    }
  });
  if (!total) {
    return null;
  }
  return {
    min: Math.max(0, Math.round(total * 0.9)),
    max: Math.max(0, Math.round(total * 1.1)),
    total,
  };
};

const getRecipeTags = (recipe) => {
  if (!recipe) {
    return [];
  }
  const tags = new Set();
  if (recipe.tag) {
    tags.add(recipe.tag);
  }
  const minutes = getRecipeMinutes(recipe);
  if (minutes && minutes <= 20) {
    tags.add("Quick");
  }
  const hasMeat = recipe.ingredients.some((ingredient) =>
    MEAT_KEYS.has(ingredient.key)
  );
  if (hasMeat) {
    tags.add("High protein");
  } else {
    tags.add("Vegetarian");
  }
  if (recipe.ingredients.length >= 7) {
    tags.add("Family");
  }
  return Array.from(tags).slice(0, 4);
};

const formatRecipeEstimate = (recipe) => {
  const estimate = getRecipeEstimate(recipe);
  if (!estimate) {
    return "--";
  }
  return `${formatMoney(estimate.min)} - ${formatMoney(estimate.max)}`;
};

const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) {
    return "--";
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remaining} min`;
};

const formatScore = (value) =>
  Number.isFinite(value) ? value.toFixed(2) : "--";

const formatConfidence = (value) => {
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (value <= 1) {
    return `${(value * 100).toFixed(1)}%`;
  }
  return value.toFixed(2);
};

const DEFAULT_CART_POLICIES = {
  allowSubs: true,
  preferCheapest: false,
  brandLock: false,
  organicOnly: false,
  maxDeltaPerItemCents: 250,
  maxCartIncreaseCents: 800,
  requireReapprovalAboveCents: 500,
  version: "2026-01-11",
};

const normalizePolicies = (policies) => ({
  ...DEFAULT_CART_POLICIES,
  ...(policies ?? {}),
});

const ESTIMATED_UNITS = new Set(["lb", "oz", "kg", "g"]);

const buildQuantityRange = (quantity, unit) => {
  if (!quantity || !unit) {
    return null;
  }
  if (!ESTIMATED_UNITS.has(unit)) {
    return null;
  }
  const min = Math.max(0, Math.round(quantity * 0.9 * 100) / 100);
  const max = Math.max(0, Math.round(quantity * 1.1 * 100) / 100);
  return { min, max, unit };
};

const buildMaxVarianceCents = (lineTotalCents) => {
  if (!lineTotalCents) {
    return null;
  }
  return Math.max(25, Math.round(lineTotalCents * 0.1));
};

const getTotalFromTotals = (totals) =>
  totals?.find((total) => total.type === "total")?.amount ?? 0;

const getQuoteTotal = (quoteSummary) =>
  getTotalFromTotals(quoteSummary?.totals ?? []);

const resolveTimelineState = ({
  agentRun,
  checkoutStatus,
  paymentStatus,
  checkout,
}) => {
  if (agentRun?.state === "ORDER_TRACKING") {
    return "ORDER_TRACKING";
  }
  if (paymentStatus === "success" || checkout?.order?.id) {
    return "ORDER_CREATED";
  }
  if (agentRun?.state === "FAILED") {
    return "FAILED";
  }
  if (checkoutStatus === "awaiting") {
    return "AWAITING_APPROVAL";
  }
  if (checkoutStatus === "ready") {
    return "CHECKOUT";
  }
  if (agentRun?.state) {
    return agentRun.state;
  }
  if (checkoutStatus === "loading") {
    return "RESOLVE_INGREDIENTS";
  }
  return "DISCOVER_MERCHANT";
};

const getLineItemPrice = (line) => line.primarySkuJson?.price ?? 0;

const getLineItemTotal = (line) =>
  getLineItemPrice(line) * (line.quantity ?? 0);

const getCartTotal = (lineItems) =>
  lineItems.reduce((sum, line) => sum + getLineItemTotal(line), 0);

const buildCartHashPayload = (recipeId, lineItems) => ({
  recipeId,
  items: [...lineItems]
    .sort((a, b) => a.ingredientKey.localeCompare(b.ingredientKey))
    .map((item) => ({
      ingredientKey: item.ingredientKey,
      productId: item.primarySkuJson?.id ?? null,
      quantity: item.quantity,
    })),
});

const getBrandToken = (title) => {
  const normalized = normalizeText(title ?? "");
  return normalized.split(" ")[0] ?? "";
};

const matchesBrandLock = (primary, candidate) => {
  const token = getBrandToken(primary?.title);
  if (!token) {
    return false;
  }
  return normalizeText(candidate?.title ?? "").includes(token);
};

const isOrganicProduct = (product, scoreBreakdown) => {
  if (!product) {
    return false;
  }
  if (normalizeText(product.title ?? "").includes("organic")) {
    return true;
  }
  return Boolean(scoreBreakdown?.productSignals?.attributes?.organic);
};

const shouldReplaceLineItem = (line, targetProductId) => {
  const primary = line.primarySkuJson;
  if (!primary) {
    return true;
  }
  if (targetProductId && primary.id === targetProductId) {
    return true;
  }
  return primary.inventory_quantity === 0;
};

const extractOutOfStockId = (detail) => {
  if (!detail || typeof detail !== "string") {
    const itemId = detail?.itemId ?? detail?.skuId ?? detail?.productId;
    if (itemId) {
      return itemId;
    }
    const message = detail?.message;
    if (typeof message === "string") {
      const match = message.match(/item\s+([a-z0-9_\-]+)/i);
      return match?.[1] ?? null;
    }
    return null;
  }
  const match = detail.match(/item\s+([a-z0-9_\-]+)/i);
  return match?.[1] ?? null;
};

const getAlternativeCandidates = (line) =>
  [...(line.alternatives ?? [])]
    .filter((alt) => alt?.skuJson)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

const selectReplacement = (
  line,
  policies,
  cartIncrease,
  enforceBudget,
  allowedProductIds
) => {
  const primary = line.primarySkuJson;
  const primaryPrice = primary?.price ?? 0;
  for (const candidate of getAlternativeCandidates(line)) {
    const product = candidate.skuJson;
    if (!product) {
      continue;
    }
    if (
      Array.isArray(allowedProductIds) &&
      !allowedProductIds.includes(product.id)
    ) {
      continue;
    }
    if (product.inventory_quantity === 0) {
      continue;
    }
    if (policies.organicOnly && !isOrganicProduct(product, candidate.scoreBreakdownJson)) {
      continue;
    }
    if (policies.brandLock && primary && !matchesBrandLock(primary, product)) {
      continue;
    }
    const perItemDelta = product.price - primaryPrice;
    if (enforceBudget) {
      if (
        Number.isFinite(policies.maxDeltaPerItemCents) &&
        perItemDelta > policies.maxDeltaPerItemCents
      ) {
        continue;
      }
      const projectedIncrease = cartIncrease + perItemDelta * (line.quantity ?? 0);
      if (
        Number.isFinite(policies.maxCartIncreaseCents) &&
        projectedIncrease > policies.maxCartIncreaseCents
      ) {
        continue;
      }
    }
    return { alternative: candidate, perItemDelta };
  }
  return null;
};

const selectProposalReplacement = (line, policies, allowedProductIds) => {
  const relaxed = selectReplacement(line, policies, 0, false, allowedProductIds);
  if (relaxed) {
    return { ...relaxed, policyViolated: false };
  }
  const primary = line.primarySkuJson;
  const primaryPrice = primary?.price ?? 0;
  for (const candidate of getAlternativeCandidates(line)) {
    const product = candidate.skuJson;
    if (!product || product.inventory_quantity === 0) {
      continue;
    }
    if (
      Array.isArray(allowedProductIds) &&
      !allowedProductIds.includes(product.id)
    ) {
      continue;
    }
    return {
      alternative: candidate,
      perItemDelta: product.price - primaryPrice,
      policyViolated: true,
    };
  }
  return null;
};

const buildReplacementPlan = ({
  lineItems,
  replacements,
  policies,
  reason,
}) => {
  const baseTotalCents = getCartTotal(lineItems);
  const replacementMap = new Map(
    replacements.map((entry) => [entry.ingredientKey, entry])
  );
  const proposedTotalCents = lineItems.reduce((sum, line) => {
    const entry = replacementMap.get(line.ingredientKey);
    const price =
      entry?.replacement?.skuJson?.price ??
      line.primarySkuJson?.price ??
      0;
    return sum + price * (line.quantity ?? 0);
  }, 0);
  const deltaCents = proposedTotalCents - baseTotalCents;

  return {
    reason,
    createdAt: new Date().toISOString(),
    baseTotalCents,
    proposedTotalCents,
    deltaCents,
    policies,
    items: replacements.map((entry) => {
      const primary = entry.primary ?? entry.line.primarySkuJson;
      const proposed = entry.replacement?.skuJson ?? null;
      const perItemDelta =
        proposed && primary ? proposed.price - primary.price : null;
      return {
        ingredientKey: entry.ingredientKey,
        quantity: entry.line.quantity,
        current: primary
          ? {
              id: primary.id,
              title: primary.title,
              price: primary.price,
            }
          : null,
        proposed: proposed
          ? {
              id: proposed.id,
              title: proposed.title,
              price: proposed.price,
            }
          : null,
        deltaCents:
          perItemDelta !== null ? perItemDelta * entry.line.quantity : null,
        reason: entry.reason,
        policyDecision: entry.autoApplied ? "auto" : "needs_approval",
        policyViolation: entry.policyViolation ?? false,
        compatibilityScore:
          entry.replacement?.scoreBreakdownJson?.totalScore ?? null,
        rank: entry.replacement?.rank ?? null,
      };
    }),
  };
};

const evaluateReplacementPlan = ({
  lineItems,
  policies,
  reason,
  targetProductId,
  allowedProductIds,
}) => {
  const resolvedPolicies = normalizePolicies(policies);
  const needsReplacement = lineItems.filter((line) =>
    shouldReplaceLineItem(line, targetProductId)
  );
  if (!needsReplacement.length) {
    return { action: "none", policies: resolvedPolicies };
  }

  const replacements = [];
  let cartIncrease = 0;
  let autoAllowed = resolvedPolicies.allowSubs;

  for (const line of needsReplacement) {
    const trigger =
      targetProductId && line.primarySkuJson?.id === targetProductId
        ? "merchant_reject"
        : line.primarySkuJson?.inventory_quantity === 0
          ? "out_of_stock"
          : reason;
    const allowedForLine =
      targetProductId && line.primarySkuJson?.id === targetProductId
        ? allowedProductIds
        : null;
    const autoChoice = resolvedPolicies.allowSubs
      ? selectReplacement(
          line,
          resolvedPolicies,
          cartIncrease,
          true,
          allowedForLine
        )
      : null;

    if (autoChoice) {
      cartIncrease +=
        autoChoice.perItemDelta * (line.quantity ?? 0);
      replacements.push({
        ingredientKey: line.ingredientKey,
        line,
        primary: line.primarySkuJson,
        replacement: autoChoice.alternative,
        perItemDelta: autoChoice.perItemDelta,
        reason: trigger,
        autoApplied: true,
      });
      continue;
    }

    autoAllowed = false;
    const proposal = selectProposalReplacement(
      line,
      resolvedPolicies,
      allowedForLine
    );
    replacements.push({
      ingredientKey: line.ingredientKey,
      line,
      primary: line.primarySkuJson,
      replacement: proposal?.alternative ?? null,
      perItemDelta: proposal?.perItemDelta ?? null,
      reason: trigger,
      autoApplied: false,
      policyViolation: proposal?.policyViolated ?? true,
    });
  }

  const planForApproval = buildReplacementPlan({
    lineItems,
    replacements: replacements.map((entry) => ({
      ...entry,
      autoApplied: false,
    })),
    policies: resolvedPolicies,
    reason,
  });

  const needsReapproval =
    Number.isFinite(resolvedPolicies.requireReapprovalAboveCents) &&
    planForApproval.deltaCents >
      resolvedPolicies.requireReapprovalAboveCents;

  if (!autoAllowed || needsReapproval) {
    return {
      action: "approval",
      replacements,
      plan: planForApproval,
      policies: resolvedPolicies,
    };
  }

  return {
    action: "auto",
    replacements,
    plan: planForApproval,
    policies: resolvedPolicies,
  };
};

const applyReplacementPlanToLineItems = (lineItems, replacements) => {
  const replacementMap = new Map(
    replacements
      .filter((entry) => entry.replacement?.skuJson)
      .map((entry) => [entry.ingredientKey, entry])
  );

  return lineItems.map((line) => {
    const entry = replacementMap.get(line.ingredientKey);
    if (!entry || !entry.replacement?.skuJson) {
      return line;
    }
    const replacementProduct = entry.replacement.skuJson;
    const replacementScore = entry.replacement.scoreBreakdownJson ?? null;
    const previousPrimary = line.primarySkuJson;
    const previousAlt = previousPrimary
      ? {
          rank: 1,
          skuJson: previousPrimary,
          scoreBreakdownJson: previousPrimary.scoreBreakdown ?? null,
          reason: "replaced_primary",
          confidence: line.confidence ?? null,
        }
      : null;
    const remainingAlternatives = (line.alternatives ?? []).filter(
      (alt) => alt?.skuJson?.id !== replacementProduct.id
    );
    const nextAlternatives = [previousAlt, ...remainingAlternatives]
      .filter(Boolean)
      .slice(0, 3)
      .map((alt, index) => ({ ...alt, rank: index + 1 }));

    return {
      ...line,
      primarySkuJson: {
        ...replacementProduct,
        scoreBreakdown: replacementScore,
      },
      confidence:
        entry.replacement.confidence ??
        entry.replacement.scoreBreakdownJson?.totalScore ??
        line.confidence,
      chosenReason: entry.replacement.reason ?? "auto_substitution",
      lineTotalCents: replacementProduct.price * line.quantity,
      alternatives: nextAlternatives,
    };
  });
};

const loadStoredArray = (key, fallback) => {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const value = window.localStorage.getItem(key);
    if (!value) {
      return fallback;
    }
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
};

const loadStoredObject = (key, fallback) => {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const value = window.localStorage.getItem(key);
    if (!value) {
      return fallback;
    }
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
};

const loadStoredValue = (key, fallback = null) => {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  return value ?? fallback;
};

const loadStoredBool = (key, fallback = false) => {
  const value = loadStoredValue(key);
  if (value === null || value === undefined) {
    return fallback;
  }
  return value === "true";
};

export default function App() {
  const [merchantUrls, setMerchantUrls] = useState(() =>
    loadStoredArray("dishfeed_merchants", DEFAULT_MERCHANTS)
  );
  const [merchantInput, setMerchantInput] = useState(
    merchantUrls.join("\n")
  );
  const [pantryIds, setPantryIds] = useState(() =>
    loadStoredArray("dishfeed_pantry", [])
  );
  const [agentLogs, setAgentLogs] = useState([]);
  const [merchantSummaries, setMerchantSummaries] = useState([]);
  const [selectedMerchant, setSelectedMerchant] = useState(null);
  const [agentRun, setAgentRun] = useState(null);
  const [agentRunId, setAgentRunId] = useState(() =>
    loadStoredValue("dishfeed_agent_run_id")
  );
  const [cartDraft, setCartDraft] = useState(null);
  const [cartDraftItems, setCartDraftItems] = useState([]);
  const [cartDraftId, setCartDraftId] = useState(() =>
    loadStoredValue("dishfeed_cart_draft_id")
  );
  const [cartDraftBaseUrl, setCartDraftBaseUrl] = useState(() =>
    loadStoredValue("dishfeed_cart_draft_base", API_BASE)
  );
  const [debugEnabled, setDebugEnabled] = useState(() =>
    loadStoredBool("dishfeed_debug", false)
  );
  const [mainView, setMainView] = useState(VIEW_MODES.FEED);
  const [panelOpen, setPanelOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [pantryOpen, setPantryOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [usePantry, setUsePantry] = useState(() =>
    loadStoredBool("dishfeed_use_pantry", true)
  );
  const [debugOpen, setDebugOpen] = useState(false);
  const [checkout, setCheckout] = useState(null);
  const [checkoutStatus, setCheckoutStatus] = useState("idle");
  const [paymentStatus, setPaymentStatus] = useState("idle");
  const [pickupMessage, setPickupMessage] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);
  const [latestApproval, setLatestApproval] = useState(null);
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  const [approvalDeltaCents, setApprovalDeltaCents] = useState(null);
  const [approvalRequestedAt, setApprovalRequestedAt] = useState(null);
  const [metricsSummary, setMetricsSummary] = useState(null);
  const [expandedLineItems, setExpandedLineItems] = useState({});
  const [editingLineItemId, setEditingLineItemId] = useState(null);
  const [cartItems, setCartItems] = useState({});
  const [activeRecipe, setActiveRecipe] = useState(null);
  const [activeCategory, setActiveCategory] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [chatMessages, setChatMessages] = useState(() => [
    {
      id: makeId(),
      role: "assistant",
      content:
        "Ask me for ingredients or say 'show me pasta options' to start.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatSuggestions, setChatSuggestions] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [storeProfile, setStoreProfile] = useState(null);
  const [pickupSlots, setPickupSlots] = useState([]);
  const [pickupSlotsStatus, setPickupSlotsStatus] = useState("idle");
  const [selectedSlotId, setSelectedSlotId] = useState(() =>
    loadStoredValue("dishfeed_selected_slot_id", "")
  );
  const [merchantSimConfig, setMerchantSimConfig] = useState(() =>
    loadStoredObject("dishfeed_storeops_config", {})
  );
  const [cartRiskScore, setCartRiskScore] = useState(null);
  const [outOfStockContext, setOutOfStockContext] = useState(null);
  const selectedStore = storeProfile;
  const selectedStoreId = selectedStore?.id ?? null;
  const selectedSlot = pickupSlots.find((slot) => slot.id === selectedSlotId);

  useEffect(() => {
    window.localStorage.setItem(
      "dishfeed_merchants",
      JSON.stringify(merchantUrls)
    );
    setMerchantInput(merchantUrls.join("\n"));
  }, [merchantUrls]);

  useEffect(() => {
    window.localStorage.setItem(
      "dishfeed_pantry",
      JSON.stringify(pantryIds)
    );
  }, [pantryIds]);

  useEffect(() => {
    if (agentRunId) {
      window.localStorage.setItem("dishfeed_agent_run_id", agentRunId);
    } else {
      window.localStorage.removeItem("dishfeed_agent_run_id");
    }
  }, [agentRunId]);

  useEffect(() => {
    if (cartDraftId) {
      window.localStorage.setItem("dishfeed_cart_draft_id", cartDraftId);
    } else {
      window.localStorage.removeItem("dishfeed_cart_draft_id");
    }
  }, [cartDraftId]);

  useEffect(() => {
    if (selectedSlotId) {
      window.localStorage.setItem(
        "dishfeed_selected_slot_id",
        selectedSlotId
      );
    } else {
      window.localStorage.removeItem("dishfeed_selected_slot_id");
    }
  }, [selectedSlotId]);

  useEffect(() => {
    window.localStorage.setItem(
      "dishfeed_storeops_config",
      JSON.stringify(merchantSimConfig)
    );
  }, [merchantSimConfig]);

  useEffect(() => {
    if (cartDraftBaseUrl) {
      window.localStorage.setItem(
        "dishfeed_cart_draft_base",
        cartDraftBaseUrl
      );
    }
  }, [cartDraftBaseUrl]);

  useEffect(() => {
    window.localStorage.setItem(
      "dishfeed_use_pantry",
      usePantry ? "true" : "false"
    );
  }, [usePantry]);

  useEffect(() => {
    window.localStorage.setItem(
      "dishfeed_debug",
      debugEnabled ? "true" : "false"
    );
    if (!debugEnabled) {
      setDebugOpen(false);
      setExpandedLineItems({});
    }
  }, [debugEnabled]);

  useEffect(() => {
    const orderConfirmed =
      paymentStatus === "success" || Boolean(checkout?.order?.id);
    const hasDraft = Boolean(cartDraft);
    const isBuilding = checkoutStatus === "loading";
    const approvalRequired =
      Boolean(cartDraft?.quoteSummary?.proposedReplacementPlan) ||
      approvalNeeded ||
      checkoutStatus === "awaiting";
    const hasCheckout = Boolean(cartDraft?.checkoutSessionId);
    const nextView = !hasDraft && !isBuilding
      ? VIEW_MODES.FEED
      : isBuilding
        ? VIEW_MODES.CART_REVIEW
        : orderConfirmed
          ? VIEW_MODES.CHECKOUT
          : approvalRequired || !hasCheckout
            ? VIEW_MODES.CART_REVIEW
            : VIEW_MODES.CHECKOUT;
    if (mainView !== nextView) {
      setMainView(nextView);
    }
  }, [
    cartDraft,
    approvalNeeded,
    checkoutStatus,
    paymentStatus,
    checkout?.order?.id,
    mainView,
  ]);

  useEffect(() => {
    if (
      cartDraft ||
      checkoutStatus === "loading" ||
      checkoutStatus === "awaiting"
    ) {
      setPanelOpen(true);
    }
  }, [cartDraft, checkoutStatus]);

  useEffect(() => {
    if (!cartDraftId) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const loadDraft = async () => {
      try {
        const data = await fetchCartDraft(baseUrl, cartDraftId);
        setCartDraft(data.cart ?? null);
        setCartDraftItems(data.lineItems ?? []);
        if (data.cart?.checkoutSessionId) {
          setCheckoutStatus("ready");
        } else if (
          data.cart?.quoteSummary?.proposedReplacementPlan
        ) {
          setCheckoutStatus("awaiting");
        }
      } catch (err) {
        if (err?.code === "NOT_FOUND") {
          resetRunState({ keepCart: true });
          showToast("Previous cart session expired. Start a new cart.");
          return;
        }
        setError(err?.message ?? "Failed to load cart draft.");
      }
    };
    loadDraft();
  }, [cartDraftId, cartDraftBaseUrl]);

  useEffect(() => {
    if (!cartDraftBaseUrl || selectedMerchant) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const loadMerchant = async () => {
      try {
        const [discovery, storeOpsProfile, substitutions] = await Promise.all([
          fetchDiscovery(baseUrl),
          fetchStoreOpsProfile(baseUrl),
          fetchStoreOpsSubstitutions(baseUrl),
        ]);
        const simConfig = resolveSimConfig(baseUrl);
        setSelectedMerchant({
          url: baseUrl,
          baseUrl,
          handlers: discovery?.payment?.handlers ?? [],
          products: [],
          mapping: [],
          total: 0,
          storeProfile: storeOpsProfile?.store ?? null,
          substitutionGraph: substitutions?.substitutionGraph ?? {},
          maxFallbacks: substitutions?.maxFallbacks ?? null,
          simConfig,
        });
        setStoreProfile(storeOpsProfile?.store ?? null);
      } catch (err) {
        setError(err?.message ?? "Failed to reload merchant.");
      }
    };
    loadMerchant();
  }, [cartDraftBaseUrl, selectedMerchant]);

  useEffect(() => {
    const baseUrl = selectedMerchant?.baseUrl ?? cartDraftBaseUrl;
    if (!baseUrl) {
      return;
    }
    const loadStoreOps = async () => {
      try {
        const profile = await fetchStoreOpsProfile(baseUrl);
        setStoreProfile(profile?.store ?? null);
      } catch (err) {
        setError(err?.message ?? "Failed to load store profile.");
      }
    };
    loadStoreOps();
  }, [selectedMerchant?.baseUrl, cartDraftBaseUrl]);

  useEffect(() => {
    const baseUrl = selectedMerchant?.baseUrl ?? cartDraftBaseUrl;
    if (!baseUrl) {
      return;
    }
    const loadSlots = async () => {
      try {
        setPickupSlotsStatus("loading");
        const slots = await fetchPickupSlots(baseUrl, agentRun?.id ?? agentRunId);
        setPickupSlots(slots);
        setPickupSlotsStatus("ready");
        const preferred = pickAvailableSlot(slots, selectedSlotId);
        if (preferred && preferred.id !== selectedSlotId) {
          setSelectedSlotId(preferred.id);
        }
      } catch (err) {
        setPickupSlotsStatus("error");
      }
    };
    loadSlots();
  }, [
    selectedMerchant?.baseUrl,
    cartDraftBaseUrl,
    agentRun?.id,
    agentRunId,
  ]);

  useEffect(() => {
    if (!agentRunId) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const loadAgentRun = async () => {
      try {
        const data = await fetchAgentRun(baseUrl, agentRunId);
        setAgentRun(data);
      } catch (err) {
        if (err?.code === "NOT_FOUND") {
          resetRunState({ keepCart: true });
          showToast("Previous run not found. Start a new cart.");
          return;
        }
        setError(err?.message ?? "Failed to load agent run.");
      }
    };
    loadAgentRun();
  }, [agentRunId, cartDraftBaseUrl]);

  useEffect(() => {
    if (!cartDraft?.checkoutSessionId || checkout) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const loadCheckout = async () => {
      try {
        await refreshCheckoutQuote({
          baseUrl,
          checkoutId: cartDraft.checkoutSessionId,
          cartDraft,
          agentRunId: cartDraft.agentRunId ?? agentRunId,
          priceStage: "quote",
        });
      } catch (err) {
        setError(err?.message ?? "Failed to load checkout session.");
      }
    };
    loadCheckout();
  }, [cartDraft, cartDraftBaseUrl, checkout]);

  useEffect(() => {
    if (!cartDraft?.cartHash) {
      setLatestApproval(null);
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const loadApproval = async () => {
      try {
        const approval = await fetchLatestApproval(baseUrl, {
          agentRunId: cartDraft.agentRunId ?? agentRunId,
          cartHash: cartDraft.cartHash,
        });
        setLatestApproval(approval);
      } catch (err) {
        setError(err?.message ?? "Failed to load approval history.");
      }
    };
    loadApproval();
  }, [
    cartDraft?.cartHash,
    cartDraft?.agentRunId,
    agentRunId,
    cartDraftBaseUrl,
  ]);

  useEffect(() => {
    if (!debugEnabled) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const loadSummary = async () => {
      try {
        const summary = await fetchMetricsSummary(baseUrl);
        setMetricsSummary(summary);
      } catch (err) {
        setError(err?.message ?? "Failed to load metrics summary.");
      }
    };
    loadSummary();
  }, [debugEnabled, cartDraftBaseUrl, agentRun?.editCount]);

  useEffect(() => {
    if (!cartDraftItems.length || !storeProfile) {
      setCartRiskScore(null);
      return;
    }
    const entries = cartDraftItems.map((line) => ({
      inventory: line.primarySkuJson?.inventory_quantity ?? null,
      fallbackCount: line.alternatives?.length ?? 0,
    }));
    const baseUrl = cartDraftBaseUrl || selectedMerchant?.baseUrl;
    const simConfig = resolveSimConfig(baseUrl);
    const score = computeRiskScore({
      entries,
      storeProfile,
      simConfig,
      pickupSlot: selectedSlot ?? null,
    });
    setCartRiskScore(score);
  }, [
    cartDraftItems,
    cartDraftBaseUrl,
    storeProfile,
    selectedSlot,
    merchantSimConfig,
    selectedMerchant?.baseUrl,
  ]);

  const cartList = useMemo(() => Object.values(cartItems), [cartItems]);
  const cartCount = cartList.reduce(
    (total, item) => total + item.quantity,
    0
  );
  const cartSubtotal = cartList.reduce(
    (total, item) => total + item.price * item.quantity,
    0
  );
  const cartDraftCount = cartDraftItems.reduce(
    (total, item) => total + (item.quantity ?? 0),
    0
  );
  const cartDraftSubtotal = useMemo(
    () =>
      cartDraftItems.reduce(
        (total, item) =>
          total +
          (item.lineTotalCents ??
            (item.primarySkuJson?.price ?? 0) * item.quantity),
        0
      ),
    [cartDraftItems]
  );
  const quoteTotals =
    cartDraft?.quoteSummary?.totals ??
    [
      { type: "subtotal", amount: cartDraftSubtotal },
      { type: "total", amount: cartDraftSubtotal },
    ];
  const cartTotalAmount =
    quoteTotals.find((total) => total.type === "total")?.amount ??
    cartDraftSubtotal;
  const panelItemCount = cartDraft ? cartDraftCount : cartCount;
  const panelTotal = cartDraft ? cartTotalAmount : cartSubtotal;
  const totalVarianceCents = cartDraftItems.reduce(
    (sum, item) =>
      sum + (item.estimatedPricing ? item.maxVarianceCents ?? 0 : 0),
    0
  );
  const proposedReplacementPlan =
    cartDraft?.quoteSummary?.proposedReplacementPlan ?? null;
  const replacementDeltaCents =
    proposedReplacementPlan?.deltaCents ?? null;
  const missingReplacementKeys =
    proposedReplacementPlan?.items
      ?.filter((item) => !item.proposed)
      .map((item) => item.ingredientKey) ?? [];
  const missingReplacementProductIds =
    proposedReplacementPlan?.items
      ?.filter((item) => !item.proposed)
      .map((item) => item.current?.id)
      .filter(Boolean) ?? [];
  const hasMissingReplacements =
    missingReplacementKeys.length > 0 || missingReplacementProductIds.length > 0;
  const needsApproval =
    Boolean(proposedReplacementPlan) || approvalNeeded;
  const approvalItemCount = proposedReplacementPlan?.items?.length ?? 0;
  const replacementItems = proposedReplacementPlan?.items ?? [];
  const replacementItemKeys = new Set(
    replacementItems.map((item) => item.ingredientKey)
  );
  const remainingCartItems = cartDraftItems.filter(
    (line) => !replacementItemKeys.has(line.ingredientKey)
  );
  const currentPolicies = normalizePolicies(cartDraft?.policies);
  const runMetrics = {
    zeroEdits:
      agentRun?.zeroEdits === null || agentRun?.zeroEdits === undefined
        ? null
        : agentRun.zeroEdits,
    editCount: agentRun?.editCount ?? 0,
    tapToApprovalMs: agentRun?.tapToApprovalMs ?? null,
    checkoutSuccess:
      agentRun?.checkoutSuccess === null ||
      agentRun?.checkoutSuccess === undefined
        ? null
        : agentRun.checkoutSuccess,
  };
  const timelineState = resolveTimelineState({
    agentRun,
    checkoutStatus,
    paymentStatus,
    checkout,
  });
  const timelineIndex = AGENT_TIMELINE.findIndex(
    (step) => step.key === timelineState
  );
  const resolvedTimelineIndex = timelineIndex >= 0 ? timelineIndex : 0;
  const timelineSteps = AGENT_TIMELINE.map((step, index) => {
    let status = "pending";
    if (index < resolvedTimelineIndex) {
      status = "done";
    } else if (index === resolvedTimelineIndex) {
      status = "active";
    }
    return { ...step, status };
  });
  const activeTimelineStep =
    timelineSteps[resolvedTimelineIndex] ?? timelineSteps[0];
  const timelineSummary = agentRun
    ? activeTimelineStep?.description ?? "Preparing the checkout flow."
    : cartDraft
      ? "Cart draft saved. Review when you are ready."
      : "Select a recipe or add ingredients to begin.";

  const isOrderConfirmed =
    paymentStatus === "success" || Boolean(checkout?.order?.id);
  const hasCartItems = cartList.length > 0;
  const hasCartDraft = Boolean(cartDraft);
  const canPay =
    !approvalNeeded &&
    !proposedReplacementPlan &&
    Boolean(cartDraft?.checkoutSessionId) &&
    paymentStatus !== "processing" &&
    paymentStatus !== "success";
  const subtotalAmount =
    quoteTotals.find((total) => total.type === "subtotal")?.amount ??
    cartDraftSubtotal;
  const taxAmount =
    quoteTotals.find((total) => total.type === "tax")?.amount ?? 0;
  const viewClass = mainView.toLowerCase().replace(/_/g, "-");
  const storeLabel =
    selectedStore?.label ?? selectedStore?.name ?? "Dish Feed Market";
  const pickupTimeLabel =
    selectedSlot?.timeLabel ?? selectedSlot?.label ?? "Pickup window";
  const pickupDateLabel = selectedSlot?.dateLabel ?? "";
  const pickupSummary = selectedSlot
    ? [pickupDateLabel, pickupTimeLabel].filter(Boolean).join(" - ")
    : "Choose pickup time";
  const compactProgressIndex = (() => {
    if (!checkoutStatus || checkoutStatus === "idle") {
      return null;
    }
    if (
      ["DISCOVER_MERCHANT", "CHECK_CAPABILITIES", "RESOLVE_INGREDIENTS", "BUILD_CART_DRAFT"].includes(
        timelineState
      )
    ) {
      return 0;
    }
    if (timelineState === "QUOTE_CART") {
      return 1;
    }
    if (
      ["AWAITING_APPROVAL", "CHECKOUT", "ORDER_CREATED", "ORDER_TRACKING"].includes(
        timelineState
      )
    ) {
      return 2;
    }
    return 0;
  })();
  const showCompactProgress =
    checkoutStatus === "loading" && compactProgressIndex !== null;
  const drawerStatusLine =
    checkoutStatus === "loading"
      ? "Finding best matches..."
      : needsApproval
        ? "Needs approval"
        : isOrderConfirmed
          ? "Order confirmed"
          : hasCartDraft
            ? "Cart ready"
            : hasCartItems
              ? "Ready to build cart"
              : null;
  const headerContext =
    mainView === VIEW_MODES.FEED
      ? `${storeLabel}${selectedSlot ? ` - ${pickupSummary}` : ""}`
      : isOrderConfirmed
        ? pickupMessage ?? "Order confirmed"
        : needsApproval
          ? "Needs approval"
          : mainView === VIEW_MODES.CART_REVIEW
            ? "Review your cart"
            : "Ready to pay";
  const showHero =
    mainView === VIEW_MODES.FEED && !hasCartItems && !hasCartDraft;


  useEffect(() => {
    if (!cartDraft || proposedReplacementPlan) {
      setApprovalNeeded(false);
      setApprovalDeltaCents(null);
      return;
    }
    if (
      !latestApproval ||
      !Number.isFinite(latestApproval.approvedTotalCents)
    ) {
      setApprovalNeeded(false);
      setApprovalDeltaCents(null);
      return;
    }
    const policies = normalizePolicies(cartDraft.policies);
    const currentTotal = getTotalFromTotals(
      checkout?.totals ?? cartDraft?.quoteSummary?.totals ?? []
    );
    const delta = currentTotal - latestApproval.approvedTotalCents;
    const requiresReapproval =
      Number.isFinite(policies.requireReapprovalAboveCents) &&
      delta > policies.requireReapprovalAboveCents;

    setApprovalNeeded(requiresReapproval);
    setApprovalDeltaCents(requiresReapproval ? delta : null);

    if (requiresReapproval) {
      if (checkoutStatus !== "awaiting") {
        setCheckoutStatus("awaiting");
      }
      if (!approvalRequestedAt) {
        setApprovalRequestedAt(Date.now());
      }
      return;
    }

    if (approvalRequestedAt) {
      setApprovalRequestedAt(null);
    }

    if (checkoutStatus === "awaiting" && cartDraft.checkoutSessionId) {
      setCheckoutStatus("ready");
    }
  }, [
    cartDraft,
    checkout,
    latestApproval,
    proposedReplacementPlan,
    checkoutStatus,
    approvalRequestedAt,
  ]);

  const pantrySet = useMemo(() => new Set(pantryIds), [pantryIds]);

  const filteredIngredients = useMemo(() => {
    return INGREDIENTS.filter((item) => {
      const matchesCategory =
        activeCategory === "All" || item.category === activeCategory;
      const matchesSearch = item.name
        .toLowerCase()
        .includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  const selectedRecipe = RECIPES.find(
    (recipe) =>
      recipe.id === (cartDraft?.recipeId ?? activeRecipe)
  );
  const outOfStockLabel = outOfStockContext?.itemId
    ? INGREDIENT_INDEX[outOfStockContext.itemId]?.name ??
      outOfStockContext.itemId
    : null;

  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  };

  const addLog = (message, tone = "info") => {
    setAgentLogs((prev) => [
      ...prev,
      {
        id: makeId(),
        message,
        tone,
      },
    ]);
  };

  const resetRunState = ({ keepCart = true } = {}) => {
    setOutOfStockContext(null);
    setAgentLogs([]);
    setMerchantSummaries([]);
    setCartDraft(null);
    setCartDraftItems([]);
    setCartDraftId(null);
    setCheckout(null);
    setCheckoutStatus("idle");
    setPaymentStatus("idle");
    setPickupMessage(null);
    setApprovalNeeded(false);
    setApprovalDeltaCents(null);
    setLatestApproval(null);
    setApprovalRequestedAt(null);
    setAgentRun(null);
    setAgentRunId(null);
    setSelectedMerchant(null);
    setStoreProfile(null);
    setPickupSlots([]);
    setPickupSlotsStatus("idle");
    setSelectedSlotId("");
    setCartRiskScore(null);
    setError(null);
    if (!keepCart) {
      clearCart();
      setActiveRecipe(null);
    }
  };

  const captureOutOfStockContext = (detail) => {
    const itemId = extractOutOfStockId(detail);
    if (!itemId) {
      return;
    }
    const alternatives = Array.isArray(detail?.alternatives)
      ? detail.alternatives
      : [];
    setOutOfStockContext({ itemId, alternatives });
  };

  const resolveSimConfig = (baseUrl) => ({
    ...DEFAULT_SIM_CONFIG,
    ...(baseUrl ? merchantSimConfig[baseUrl] : null),
  });

  const updateSimConfig = (baseUrl, updates) => {
    if (!baseUrl) {
      return;
    }
    setMerchantSimConfig((prev) => ({
      ...prev,
      [baseUrl]: {
        ...DEFAULT_SIM_CONFIG,
        ...(prev[baseUrl] ?? {}),
        ...updates,
      },
    }));
  };

  const buildStoreOpsHeaders = (baseUrl, agentRunId) => {
    const config = resolveSimConfig(baseUrl);
    const headers = {
      "x-storeops-config": JSON.stringify(config),
    };
    if (agentRunId) {
      headers["x-agent-run-id"] = agentRunId;
    }
    return headers;
  };

  const pickAvailableSlot = (slots, preferredId) => {
    if (!slots.length) {
      return null;
    }
    const preferred = slots.find(
      (slot) => slot.id === preferredId && slot.status === "available"
    );
    if (preferred) {
      return preferred;
    }
    return slots.find((slot) => slot.status === "available") ?? slots[0] ?? null;
  };

  const openFeed = () => {
    setMainView(VIEW_MODES.FEED);
  };

  const openReview = () => {
    setMainView(VIEW_MODES.CART_REVIEW);
    setPanelOpen(true);
  };

  const handleCartToggle = () => {
    if (cartDraft) {
      const approvalRequired =
        Boolean(cartDraft?.quoteSummary?.proposedReplacementPlan) ||
        approvalNeeded ||
        checkoutStatus === "awaiting";
      const nextView =
        approvalRequired || !cartDraft?.checkoutSessionId
          ? VIEW_MODES.CART_REVIEW
          : VIEW_MODES.CHECKOUT;
      setMainView(nextView);
    }
    setPanelOpen((prev) => !prev);
  };

  const toggleLineItemDetails = (lineKey) => {
    if (!lineKey) {
      return;
    }
    setExpandedLineItems((prev) => ({
      ...prev,
      [lineKey]: !prev[lineKey],
    }));
  };

  const toggleLineItemEdit = (lineKey) => {
    if (!lineKey) {
      return;
    }
    setEditingLineItemId((prev) => (prev === lineKey ? null : lineKey));
  };

  const addToCart = (item, quantity = 1) => {
    setCartItems((prev) => {
      const existing = prev[item.key];
      const nextQuantity = (existing?.quantity ?? 0) + quantity;
      return {
        ...prev,
        [item.key]: { ...item, quantity: nextQuantity },
      };
    });
  };

  const updateCartQuantity = (itemKey, quantity) => {
    setCartItems((prev) => {
      if (quantity <= 0) {
        const next = { ...prev };
        delete next[itemKey];
        return next;
      }
      return {
        ...prev,
        [itemKey]: { ...prev[itemKey], quantity },
      };
    });
  };

  const addRecipeToCart = (recipe) => {
    recipe.ingredients.forEach((ingredient) => {
      const base = INGREDIENT_INDEX[ingredient.key];
      const key = ingredient.key ?? ingredient.query;
      addToCart(
        {
          key,
          name: base?.name ?? ingredient.query,
          query: ingredient.query ?? base?.query ?? base?.name,
          price: base?.price ?? 0,
          category: base?.category ?? "Pantry",
        },
        ingredient.quantity
      );
    });
    setActiveRecipe(recipe.id);
    window.setTimeout(() => setActiveRecipe(null), 1200);
  };

  const clearCart = () => setCartItems({});

  const togglePantry = (itemId) => {
    setPantryIds((prev) => {
      if (prev.includes(itemId)) {
        return prev.filter((id) => id !== itemId);
      }
      return [...prev, itemId];
    });
  };

  const isPantryMatch = (item) => {
    if (!usePantry) {
      return false;
    }
    return PANTRY_ITEMS.some((pantryItem) => {
      if (!pantrySet.has(pantryItem.id)) {
        return false;
      }
      if (pantryItem.ingredientKey && pantryItem.ingredientKey === item.key) {
        return true;
      }
      const query = normalizeText(item.query);
      return pantryItem.keywords.some((keyword) =>
        query.includes(keyword.toLowerCase())
      );
    });
  };

  const saveMerchants = () => {
    const list = merchantInput
      .split("\n")
      .map((line) => normalizeUrl(line))
      .filter(Boolean);
    setMerchantUrls(list.length ? list : DEFAULT_MERCHANTS);
  };

  const fetchDiscovery = async (baseUrl) => {
    const response = await fetch(joinUrl(baseUrl, "/.well-known/ucp"), {
      headers: {
        "UCP-Agent": UCP_AGENT,
        "request-id": makeId(),
        "request-signature": "test",
        ...buildStoreOpsHeaders(baseUrl),
      },
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(
        data?.detail?.message ??
          data?.detail ??
          data?.message ??
          "Discovery failed."
      );
    }
    return data;
  };

  const fetchProducts = async (baseUrl) => {
    const response = await fetch(joinUrl(baseUrl, "/products"), {
      headers: buildStoreOpsHeaders(baseUrl),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(
        data?.detail?.message ??
          data?.detail ??
          data?.message ??
          "Failed to fetch products."
      );
    }
    return data?.products ?? [];
  };

  const fetchStoreOpsProfile = async (baseUrl) => {
    const response = await fetch(joinUrl(baseUrl, "/store-ops/profile"), {
      headers: buildStoreOpsHeaders(baseUrl),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(
        data?.detail?.message ??
          data?.detail ??
          data?.message ??
          "Failed to load store profile."
      );
    }
    return data ?? null;
  };

  const fetchStoreOpsSubstitutions = async (baseUrl) => {
    const response = await fetch(joinUrl(baseUrl, "/store-ops/substitutions"), {
      headers: buildStoreOpsHeaders(baseUrl),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(
        data?.detail?.message ??
          data?.detail ??
          data?.message ??
          "Failed to load substitutions."
      );
    }
    return data ?? null;
  };

  const fetchPickupSlots = async (baseUrl, agentRunId) => {
    const response = await fetch(joinUrl(baseUrl, "/store-ops/pickup-slots"), {
      headers: buildStoreOpsHeaders(baseUrl, agentRunId),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(
        data?.detail?.message ??
          data?.detail ??
          data?.message ??
          "Failed to load pickup slots."
      );
    }
    return data?.slots ?? [];
  };

  const agentHeaders = () => ({
    "Content-Type": "application/json",
  });

  const fetchAgentRun = async (baseUrl, agentRunId) => {
    const response = await fetch(
      joinUrl(baseUrl, `/agent-runs/${agentRunId}`)
    );
    const data = await safeJson(response);
    if (!response.ok) {
      const error = new Error(
        data?.detail ?? "Failed to fetch agent run."
      );
      if (response.status === 404) {
        error.code = "NOT_FOUND";
      }
      throw error;
    }
    return data?.agentRun ?? null;
  };

  const createAgentRun = async (baseUrl, payload) => {
    const response = await fetch(joinUrl(baseUrl, "/agent-runs"), {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to create agent run.");
    }
    return data?.agentRun ?? null;
  };

  const updateAgentRun = async (baseUrl, agentRunId, payload) => {
    const response = await fetch(
      joinUrl(baseUrl, `/agent-runs/${agentRunId}`),
      {
        method: "PATCH",
        headers: agentHeaders(),
        body: JSON.stringify(payload),
      }
    );
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to update agent run.");
    }
    return data?.agentRun ?? null;
  };

  const createAgentRunStep = async (baseUrl, payload) => {
    const response = await fetch(joinUrl(baseUrl, "/agent-run-steps"), {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to log agent step.");
    }
    return data?.stepLog ?? null;
  };

  const upsertCartDraft = async (baseUrl, payload) => {
    const response = await fetch(joinUrl(baseUrl, "/cart-drafts"), {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to save cart draft.");
    }
    return data;
  };

  const updateCartDraft = async (baseUrl, cartId, payload) => {
    const response = await fetch(
      joinUrl(baseUrl, `/cart-drafts/${cartId}`),
      {
        method: "PATCH",
        headers: agentHeaders(),
        body: JSON.stringify(payload),
      }
    );
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to update cart draft.");
    }
    return data;
  };

  const fetchCartDraft = async (baseUrl, cartId) => {
    const response = await fetch(joinUrl(baseUrl, `/cart-drafts/${cartId}`));
    const data = await safeJson(response);
    if (!response.ok) {
      const error = new Error(data?.detail ?? "Failed to fetch cart draft.");
      if (response.status === 404) {
        error.code = "NOT_FOUND";
      }
      throw error;
    }
    return data;
  };

  const createApproval = async (baseUrl, payload) => {
    const response = await fetch(joinUrl(baseUrl, "/approvals"), {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to create approval.");
    }
    return data?.approval ?? null;
  };

  const fetchLatestApproval = async (baseUrl, { agentRunId, cartHash }) => {
    const params = new URLSearchParams();
    if (agentRunId) {
      params.set("agentRunId", agentRunId);
    }
    if (cartHash) {
      params.set("cartHash", cartHash);
    }
    const response = await fetch(
      joinUrl(baseUrl, `/approvals?${params.toString()}`)
    );
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to fetch approval.");
    }
    return data?.approval ?? null;
  };

  const recordApproval = async ({
    baseUrl,
    agentRunId,
    cartHash,
    quoteHash,
    approvedTotalCents,
    status = "approved",
  }) => {
    const approval = await createApproval(baseUrl, {
      agentRunId,
      cartHash,
      quoteHash,
      approvedTotalCents,
      approvedAt: new Date().toISOString(),
      signatureMock: "demo",
      status,
    });
    setLatestApproval(approval);
    return approval;
  };

  const createUserEditEvent = async (baseUrl, payload) => {
    const response = await fetch(joinUrl(baseUrl, "/user-edit-events"), {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to record user edit.");
    }
    return data;
  };

  const fetchMetricsSummary = async (baseUrl) => {
    const response = await fetch(joinUrl(baseUrl, "/metrics/summary"));
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data?.detail ?? "Failed to fetch metrics summary.");
    }
    return data;
  };

  const recordEditEvent = async ({
    agentRunId,
    ingredientKey,
    actionType,
    fromSkuJson,
    toSkuJson,
    reason,
  }) => {
    if (!agentRunId) {
      return null;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const response = await createUserEditEvent(baseUrl, {
      agentRunId,
      ingredientKey,
      actionType,
      fromSkuJson,
      toSkuJson,
      reason,
      timestamp: new Date().toISOString(),
    });
    if (response?.agentRun) {
      setAgentRun(response.agentRun);
    }
    return response?.event ?? null;
  };

  const recordTapToApproval = async () => {
    if (!approvalRequestedAt) {
      return null;
    }
    const agentId = agentRun?.id ?? agentRunId;
    if (!agentId) {
      setApprovalRequestedAt(null);
      return null;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const delta = Date.now() - approvalRequestedAt;
    const updated = await updateAgentRun(baseUrl, agentId, {
      tapToApprovalMs: delta,
    });
    setAgentRun(updated);
    setApprovalRequestedAt(null);
    return delta;
  };

  const refreshCheckoutQuote = async ({
    baseUrl,
    checkoutId,
    cartDraft: draft,
    priceStage = "quote",
    agentRunId,
  }) => {
    const requestId = buildRequestId(
      agentRunId ?? draft?.agentRunId,
      `quote:${priceStage}:${checkoutId}`
    );
    const response = await fetch(
      joinUrl(baseUrl, `/checkout-sessions/${checkoutId}`),
      {
        headers: baseHeaders({
          requestId,
          idempotencyKey: draft?.cartHash ?? makeId(),
          agentRunId: agentRunId ?? draft?.agentRunId,
          storeOpsConfig: resolveSimConfig(baseUrl),
          priceStage,
        }),
      }
    );
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(
        data?.detail?.message ??
          data?.detail ??
          data?.message ??
          "Failed to fetch checkout session."
      );
    }
    setCheckout(data);

    const quoteSummary = buildQuoteSummary(data);
    const quoteHash = await hashString(stableStringify(quoteSummary));
    let updatedDraft = draft;

    if (draft?.id) {
      if (draft.quoteHash !== quoteHash || draft.checkoutSessionId !== data.id) {
        const updated = await updateCartDraft(baseUrl, draft.id, {
          quoteSummary,
          quoteHash,
          checkoutSessionId: data.id,
        });
        updatedDraft = updated.cart ?? draft;
        setCartDraft(updatedDraft ?? null);
        setCartDraftItems(updated.lineItems ?? []);
        setCartDraftId(updatedDraft?.id ?? null);
      }
    }

    return { checkout: data, quoteSummary, quoteHash, cartDraft: updatedDraft };
  };

  const mapSuggestionToCartItem = (product) => {
    const base = INGREDIENT_INDEX[product.id];
    return {
      key: product.id,
      name: base?.name ?? product.title,
      query: base?.query ?? product.title,
      price: product.price ?? base?.price ?? 0,
      category: base?.category ?? "Pantry",
    };
  };

  const addSuggestionToCart = (product) => {
    addToCart(mapSuggestionToCartItem(product), 1);
    showToast(`${product.title} added to cart.`);
  };

  const addAllSuggestions = () => {
    chatSuggestions.forEach((product) => {
      addToCart(mapSuggestionToCartItem(product), 1);
    });
    if (chatSuggestions.length) {
      showToast("Added suggested items to cart.");
    }
  };

  const clearChat = () => {
    setChatMessages([
      {
        id: makeId(),
        role: "assistant",
        content:
          "Ask me for ingredients or say 'show me pasta options' to start.",
      },
    ]);
    setChatSuggestions([]);
    setChatInput("");
  };

  const sendAgentMessage = async (message) => {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const userMessage = {
      id: makeId(),
      role: "user",
      content: trimmed,
    };
    setChatMessages((prev) => [...prev, userMessage]);
    setChatLoading(true);
    setChatInput("");

    try {
      const history = [...chatMessages, userMessage]
        .slice(-8)
        .map((msg) => ({ role: msg.role, content: msg.content }));
      const response = await fetch(joinUrl(baseUrl, "/agent/messages"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: trimmed, history }),
      });
      const data = await safeJson(response);
      if (!response.ok) {
        throw new Error(data?.detail ?? "Agent response failed.");
      }
      const reply = data?.reply ?? {
        id: makeId(),
        role: "assistant",
        content: "Agent replied, but no content was returned.",
      };
      setChatMessages((prev) => [
        ...prev,
        {
          id: reply.id ?? makeId(),
          role: reply.role ?? "assistant",
          content: reply.content ?? "Agent reply received.",
        },
      ]);
      setChatSuggestions(data?.suggestedItems ?? []);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          content: err?.message ?? "Agent error. Try again.",
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatSubmit = (event) => {
    event.preventDefault();
    sendAgentMessage(chatInput);
  };

  const resolveFallbackLimit = (aggressiveness) => {
    if (aggressiveness === "conservative") {
      return 1;
    }
    if (aggressiveness === "aggressive") {
      return 3;
    }
    return 2;
  };

  const buildMapping = (ingredients, products, options = {}) => {
    const substitutionGraph = options.substitutionGraph ?? {};
    const fallbackLimit =
      Number.isFinite(options.fallbackLimit) && options.fallbackLimit > 0
        ? options.fallbackLimit
        : resolveFallbackLimit(options.substitutionAggressiveness);
    const maxCandidates = Math.max(2, fallbackLimit + 1);
    const productById = new Map(
      (products ?? []).map((product) => [product.id, product])
    );

    return ingredients.map((ingredient) => {
      const canonical = parseCanonicalIngredient(ingredient);
      const ranked = rankProducts(canonical, products);
      const primary = ranked[0] ?? null;
      const fallbackIds = primary
        ? substitutionGraph[primary.product?.id] ?? []
        : [];
      const fallbackCandidates = ranked
        .filter(
          (candidate) =>
            candidate.product &&
            candidate.product.id !== primary?.product?.id &&
            fallbackIds.includes(candidate.product.id)
        )
        .slice(0, fallbackLimit);
      const fallbackNeeded = Math.max(0, fallbackLimit - fallbackCandidates.length);
      const fallbackExtras = fallbackNeeded
        ? fallbackIds
            .filter(
              (id) =>
                id !== primary?.product?.id &&
                !fallbackCandidates.some((candidate) => candidate.product?.id === id)
            )
            .map((id) => productById.get(id))
            .filter(Boolean)
            .slice(0, fallbackNeeded)
            .map((product) => ({
              product,
              score: 0.05,
              confidence: 0.05,
              chosenReason: "fallback_graph",
              scoreBreakdown: { totalScore: 0.05 },
            }))
        : [];
      const candidateSet = new Set(
        [primary, ...fallbackCandidates, ...fallbackExtras]
          .filter(Boolean)
          .map((candidate) => candidate.product.id)
      );
      const remaining = ranked.filter(
        (candidate) => !candidateSet.has(candidate.product.id)
      );
      const candidates = [primary, ...fallbackCandidates, ...fallbackExtras, ...remaining]
        .filter(Boolean)
        .slice(0, maxCandidates);
      return {
        ingredient,
        canonical,
        candidates,
        selectionIndex: 0,
      };
    });
  };

  const buildMappingFromLineItems = (lineItems) => {
    return lineItems.map((line) => {
      const canonical =
        line.canonicalIngredientJson ??
        parseCanonicalIngredient({
          name: line.primarySkuJson?.title ?? line.ingredientKey,
          query: line.primarySkuJson?.title ?? line.ingredientKey,
          quantity: line.quantity,
          unit: line.unit,
        });
      const ingredient = {
        key: line.ingredientKey,
        name: canonical.canonicalName ?? line.primarySkuJson?.title ?? line.ingredientKey,
        query: canonical.originalText ?? line.primarySkuJson?.title ?? line.ingredientKey,
        quantity: line.quantity,
        unit: line.unit ?? null,
      };
      const primaryScore =
        line.primarySkuJson?.scoreBreakdown ?? null;
      const primaryCandidate = line.primarySkuJson
        ? {
            product: line.primarySkuJson,
            score:
              line.confidence ??
              primaryScore?.totalScore ??
              0,
            confidence:
              line.confidence ??
              primaryScore?.totalScore ??
              0,
            chosenReason: line.chosenReason ?? "primary",
            scoreBreakdown: primaryScore,
          }
        : null;
      const altCandidates = (line.alternatives ?? [])
        .filter((alt) => alt?.skuJson)
        .map((alt) => ({
          product: alt.skuJson,
          score:
            alt.scoreBreakdownJson?.totalScore ??
            alt.confidence ??
            0,
          confidence:
            alt.confidence ??
            alt.scoreBreakdownJson?.totalScore ??
            0,
          chosenReason: alt.reason ?? "alternative",
          scoreBreakdown: alt.scoreBreakdownJson ?? null,
        }));
      const candidates = [primaryCandidate, ...altCandidates].filter(Boolean);
      return {
        ingredient,
        canonical,
        candidates,
        selectionIndex: 0,
      };
    });
  };

  const computeRiskScore = ({
    entries,
    storeProfile,
    simConfig,
    pickupSlot,
  }) => {
    if (!entries?.length || !storeProfile) {
      return null;
    }
    const lowStockThreshold = storeProfile.lowStockThreshold ?? 0;
    const lowStockCount = entries.filter(
      (entry) =>
        Number.isFinite(entry.inventory) &&
        entry.inventory <= lowStockThreshold
    ).length;
    const missingFallbacks = entries.filter(
      (entry) => entry.fallbackCount === 0
    ).length;
    const volatilityScore =
      simConfig?.volatility === "high"
        ? 0.3
        : simConfig?.volatility === "medium"
          ? 0.18
          : 0.08;
    const driftScore =
      simConfig?.driftMagnitude === "high"
        ? 0.15
        : simConfig?.driftMagnitude === "medium"
          ? 0.08
          : 0.03;
    const lowStockScore = entries.length
      ? (lowStockCount / entries.length) * 0.35
      : 0;
    const fallbackScore = entries.length
      ? (missingFallbacks / entries.length) * 0.25
      : 0;
    const slotScore =
      pickupSlot && Number.isFinite(pickupSlot.capacity)
        ? pickupSlot.available <= Math.max(1, Math.round(pickupSlot.capacity * 0.2))
          ? 0.1
          : 0
        : 0;
    return Math.min(
      1,
      volatilityScore + driftScore + lowStockScore + fallbackScore + slotScore
    );
  };

  const describeRisk = (score) => {
    if (score === null || score === undefined) {
      return { label: "--", tone: "" };
    }
    if (score >= 0.66) {
      return { label: "High", tone: "warning" };
    }
    if (score >= 0.33) {
      return { label: "Medium", tone: "neutral" };
    }
    return { label: "Low", tone: "success" };
  };

  const buildReplacementEntriesFromPlan = (lineItems, plan) => {
    if (!plan?.items?.length) {
      return [];
    }
    return plan.items
      .map((item) => {
        const line = lineItems.find(
          (entry) => entry.ingredientKey === item.ingredientKey
        );
        const proposedId = item.proposed?.id;
        if (!line || !proposedId) {
          return null;
        }
        const alternative = (line.alternatives ?? []).find(
          (alt) => alt.skuJson?.id === proposedId
        );
        const skuJson = alternative?.skuJson ?? item.proposed;
        const replacement =
          alternative ??
          (skuJson
            ? {
                skuJson,
                scoreBreakdownJson: null,
                confidence: line.confidence ?? null,
                reason: "approved_substitution",
                rank: 1,
              }
            : null);
        return {
          ingredientKey: line.ingredientKey,
          line,
          replacement: {
            ...replacement,
            skuJson,
            scoreBreakdownJson: replacement?.scoreBreakdownJson ?? null,
            confidence: replacement?.confidence ?? line.confidence ?? null,
            reason: replacement?.reason ?? "approved_substitution",
            rank: replacement?.rank ?? 1,
          },
          reason: "approved_substitution",
          autoApplied: true,
        };
      })
      .filter(Boolean);
  };

  const summarizeMapping = (mapping) => {
    const selections = mapping.map((entry) => {
      const candidate = entry.candidates[entry.selectionIndex];
      return {
        ingredient: entry.ingredient,
        product: candidate?.product ?? null,
        score: candidate?.score ?? 0,
      };
    });
    const total = selections.reduce((sum, selection) => {
      if (!selection.product) {
        return sum;
      }
      return sum + selection.product.price * selection.ingredient.quantity;
    }, 0);
    return { selections, total };
  };

  const buildCartDraftPayload = async ({
    agentRunId,
    recipeId,
    pantryItemsRemoved,
    mapping,
    cartDraftId,
    servings = 2,
    policies = DEFAULT_CART_POLICIES,
  }) => {
    const nowIso = new Date().toISOString();
    const resolvedPolicies = normalizePolicies(policies);
    const lineItems = mapping.map((entry) => {
      const selection = entry.candidates[entry.selectionIndex];
      const primary = selection?.product ?? null;
      const ingredient = entry.ingredient;
      const ingredientKey = ingredient.key ?? ingredient.query ?? makeId();
      const canonical = entry.canonical ?? parseCanonicalIngredient(ingredient);
      const quantity = ingredient.quantity;
      const unit = ingredient.unit ?? null;
      const quantityRange = buildQuantityRange(
        canonical.quantity ?? quantity,
        canonical.unit ?? unit
      );
      const estimatedPricing = Boolean(quantityRange);
      const lineTotalCents = primary ? primary.price * quantity : null;
      const maxVarianceCents =
        estimatedPricing && lineTotalCents
          ? buildMaxVarianceCents(lineTotalCents)
          : null;
      const alternatives = entry.candidates
        .filter((_, index) => index !== entry.selectionIndex)
        .slice(0, 3)
        .map((candidate, index) => ({
          rank: index + 1,
          skuJson: candidate.product,
          scoreBreakdownJson: candidate.scoreBreakdown,
          reason:
            candidate.product?.inventory_quantity === 0
              ? "out_of_stock"
              : candidate.chosenReason ?? "ranked_candidate",
          confidence: candidate.confidence ?? candidate.score,
        }));

      return {
        ingredientKey,
        canonicalIngredientJson: canonical,
        primarySkuJson: primary
          ? { ...primary, scoreBreakdown: selection?.scoreBreakdown ?? null }
          : null,
        quantity,
        unit,
        confidence: selection?.confidence ?? selection?.score ?? 0,
        chosenReason:
          selection?.chosenReason ??
          (entry.selectionIndex === 0 ? "best_match" : "auto_substitution"),
        substitutionPolicyJson: {
          strategy: "top_ranked",
          maxAlternatives: 3,
          allowSubs: resolvedPolicies.allowSubs,
          brandLock: resolvedPolicies.brandLock,
          organicOnly: resolvedPolicies.organicOnly,
          maxDeltaPerItemCents: resolvedPolicies.maxDeltaPerItemCents,
          maxCartIncreaseCents: resolvedPolicies.maxCartIncreaseCents,
          requireReapprovalAboveCents:
            resolvedPolicies.requireReapprovalAboveCents,
        },
        lineTotalCents,
        estimatedPricing,
        quantityRangeJson: quantityRange,
        maxVarianceCents,
        alternatives,
      };
    });

    const cartHashPayload = buildCartHashPayload(recipeId, lineItems);
    const cartHash = await hashString(stableStringify(cartHashPayload));

    const cart = {
      ...(cartDraftId ? { id: cartDraftId } : {}),
      agentRunId,
      recipeId,
      servings,
      pantryItemsRemoved,
      policies: resolvedPolicies,
      cartHash,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    return { cart, lineItems };
  };

  const buildCheckoutPayload = (lineItems, handlers) => ({
    currency: "USD",
    line_items: lineItems.map((line) => ({
      quantity: line.quantity,
      item: {
        id: line.primarySkuJson.id,
        title: line.primarySkuJson.title,
      },
    })),
    payment: {
      handlers,
      instruments: [],
      selected_instrument_id: null,
    },
    buyer: {
      full_name: "Dish Feed Tester",
      email: "dishfeed@example.com",
    },
  });

  const buildQuoteSummary = (checkoutData) => ({
    currency: checkoutData.currency,
    totals: checkoutData.totals ?? [],
    line_items:
      checkoutData.line_items?.map((line) => ({
        id: line.id,
        item: line.item,
        quantity: line.quantity,
        totals: line.totals ?? [],
      })) ?? [],
  });

  const buildUpdatePayload = (checkoutData, fulfillment) => ({
    id: checkoutData.id,
    line_items: checkoutData.line_items.map((line) => ({
      id: line.id,
      quantity: line.quantity,
      item: {
        id: line.item.id,
        title: line.item.title,
      },
    })),
    currency: checkoutData.currency,
    payment: {
      selected_instrument_id:
        checkoutData.payment?.selected_instrument_id ?? null,
      instruments: checkoutData.payment?.instruments ?? [],
    },
    fulfillment,
  });

  const updateCheckout = async (
    baseUrl,
    checkoutData,
    fulfillment,
    options = {}
  ) => {
    const payload = buildUpdatePayload(checkoutData, fulfillment);
    const priceStage = options.priceStage ?? "quote";
    const requestId = buildRequestId(
      options.agentRunId,
      `checkout:update:${priceStage}:${checkoutData.id}`
    );
    const response = await fetch(
      joinUrl(baseUrl, `/checkout-sessions/${checkoutData.id}`),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...baseHeaders({
            requestId,
            idempotencyKey: `update_${checkoutData.id}_${priceStage}`,
            agentRunId: options.agentRunId,
            storeOpsConfig: resolveSimConfig(baseUrl),
            priceStage,
          }),
        },
        body: JSON.stringify(payload),
      }
    );
    const data = await safeJson(response);
    if (!response.ok) {
      const error = new Error(
        data?.detail?.message ||
          data?.detail ||
          data?.message ||
          `Checkout update failed with status ${response.status}.`
      );
      error.code = data?.code ?? null;
      error.detail = data?.detail ?? null;
      throw error;
    }
    return data;
  };

  const prepareFulfillment = async (baseUrl, checkoutData, agentRunId) => {
    setPickupSlotsStatus("loading");
    const slots = await fetchPickupSlots(baseUrl, agentRunId);
    setPickupSlots(slots);
    setPickupSlotsStatus("ready");

    const preferredSlot = pickAvailableSlot(slots, selectedSlotId);
    if (!preferredSlot) {
      throw new Error("No pickup slots available.");
    }
    if (preferredSlot.id !== selectedSlotId) {
      setSelectedSlotId(preferredSlot.id);
    }

    const fulfillment = {
      methods: [
        {
          type: "pickup",
          groups: [{ selected_option_id: preferredSlot.id }],
        },
      ],
    };

    try {
      return await updateCheckout(baseUrl, checkoutData, fulfillment, {
        agentRunId,
        priceStage: "quote",
      });
    } catch (err) {
      if (
        err?.code === "PICKUP_SLOT_FULL" ||
        err?.code === "PICKUP_SLOT_EXPIRED"
      ) {
        const refreshedSlots = await fetchPickupSlots(baseUrl, agentRunId);
        setPickupSlots(refreshedSlots);
        const fallbackSlot = pickAvailableSlot(refreshedSlots, null);
        if (!fallbackSlot) {
          throw err;
        }
        setSelectedSlotId(fallbackSlot.id);
        return updateCheckout(baseUrl, checkoutData, {
          methods: [
            {
              type: "pickup",
              groups: [{ selected_option_id: fallbackSlot.id }],
            },
          ],
        }, {
          agentRunId,
          priceStage: "quote",
        });
      }
      throw err;
    }
  };

  const persistReplacementSelection = async (
    baseUrl,
    cartResult,
    replacements,
    policies
  ) => {
    const updatedLineItems = applyReplacementPlanToLineItems(
      cartResult.lineItems ?? [],
      replacements
    );
    const cartHashPayload = buildCartHashPayload(
      cartResult.cart?.recipeId,
      updatedLineItems
    );
    const cartHash = await hashString(stableStringify(cartHashPayload));
    const updatedCart = {
      ...cartResult.cart,
      cartHash,
      policies,
      updatedAt: new Date().toISOString(),
    };
    return upsertCartDraft(baseUrl, {
      cart: updatedCart,
      lineItems: updatedLineItems,
    });
  };

  const storeReplacementPlan = async (baseUrl, cartResult, plan) => {
    const quoteHash = await hashString(stableStringify(plan));
    const totals = [
      { type: "subtotal", amount: plan.proposedTotalCents },
      { type: "total", amount: plan.proposedTotalCents },
    ];
    return updateCartDraft(baseUrl, cartResult.cart.id, {
      quoteSummary: {
        ...(cartResult.cart?.quoteSummary ?? {}),
        proposedReplacementPlan: plan,
        totals,
      },
      quoteHash,
    });
  };

  const finalizeCheckoutFlow = async ({
    baseUrl,
    checkoutData,
    cartDraftResult,
    agentRunId,
    storeId,
    approvalStatus = "quoted",
  }) => {
    const preparedCheckout = await prepareFulfillment(
      baseUrl,
      checkoutData,
      agentRunId
    );
    const quoteSummary = buildQuoteSummary(preparedCheckout);
    const quoteHash = await hashString(stableStringify(quoteSummary));
    const updatedDraft = await updateCartDraft(
      baseUrl,
      cartDraftResult.cart.id,
      {
        quoteSummary,
        quoteHash,
        checkoutSessionId: preparedCheckout.id,
      }
    );

    setCartDraft(updatedDraft.cart ?? null);
    setCartDraftItems(updatedDraft.lineItems ?? []);
    setCartDraftId(updatedDraft.cart?.id ?? null);

    const approvedTotal = getTotalFromTotals(quoteSummary.totals ?? []);
    const shouldRecordApproval =
      updatedDraft.cart?.cartHash &&
      Number.isFinite(approvedTotal) &&
      (latestApproval?.quoteHash !== quoteHash ||
        latestApproval?.cartHash !== updatedDraft.cart?.cartHash);
    if (shouldRecordApproval) {
      try {
        await recordApproval({
          baseUrl,
          agentRunId: agentRunId ?? updatedDraft.cart?.agentRunId ?? null,
          cartHash: updatedDraft.cart?.cartHash,
          quoteHash,
          approvedTotalCents: approvedTotal,
          status: approvalStatus,
        });
        setApprovalNeeded(false);
        setApprovalDeltaCents(null);
      } catch (err) {
        addLog("Failed to store approval record.", "warn");
      }
    }

    if (agentRunId) {
      const updatedRun = await updateAgentRun(baseUrl, agentRunId, {
        cartDraftId: updatedDraft.cart?.id ?? null,
        state: "CHECKOUT",
        merchantBaseUrl: baseUrl,
        storeId,
      });
      setAgentRun(updatedRun);

      await createAgentRunStep(baseUrl, {
        agentRunId,
        stepName: "CHECKOUT",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        success: true,
      });
    }

    setCheckout(preparedCheckout);
    setCheckoutStatus("ready");
    addLog("Checkout prepared. Ready for payment.", "success");
    openReview();

    return { preparedCheckout, updatedDraft };
  };

  const createCheckoutWithHealing = async (
    merchant,
    mapping,
    { agentRunId, recipeId, pantryItemsRemoved, cartDraftId, policies }
  ) => {
    const maxAttempts = 3;
    let attempt = 0;
    let workingMapping = mapping.map((entry) => ({ ...entry }));
    let workingCartDraftId = cartDraftId;
    let lastCartDraft = null;

    const applyReplacementsToMapping = (currentMapping, replacements) => {
      const mappingByKey = new Map(
        currentMapping.map((entry) => [
          entry.ingredient.key ?? entry.ingredient.query,
          entry,
        ])
      );
      replacements.forEach((entry) => {
        const target = mappingByKey.get(entry.ingredientKey);
        const replacementId = entry.replacement?.skuJson?.id;
        if (!target || !replacementId) {
          return;
        }
        const index = target.candidates.findIndex(
          (candidate) => candidate.product?.id === replacementId
        );
        if (index >= 0) {
          target.selectionIndex = index;
        }
      });
      return currentMapping;
    };

    while (attempt < maxAttempts) {
      const policySeed =
        lastCartDraft?.cart?.policies ??
        policies ??
        DEFAULT_CART_POLICIES;
      const cartPayload = await buildCartDraftPayload({
        agentRunId,
        recipeId,
        pantryItemsRemoved,
        mapping: workingMapping,
        cartDraftId: workingCartDraftId,
        policies: policySeed,
      });
      let cartResult = await upsertCartDraft(merchant.baseUrl, cartPayload);
      workingCartDraftId = cartResult.cart?.id ?? workingCartDraftId;
      lastCartDraft = cartResult;

      const precheckOutcome = evaluateReplacementPlan({
        lineItems: cartResult.lineItems ?? [],
        policies: cartResult.cart?.policies,
        reason: "inventory_precheck",
      });

      if (precheckOutcome.action === "auto") {
        if (precheckOutcome.replacements.length) {
          workingMapping = applyReplacementsToMapping(
            workingMapping,
            precheckOutcome.replacements
          );
          cartResult = await persistReplacementSelection(
            merchant.baseUrl,
            cartResult,
            precheckOutcome.replacements,
            precheckOutcome.policies
          );
          lastCartDraft = cartResult;
          addLog("Auto-substituted items before checkout.", "warn");
        }
      } else if (precheckOutcome.action === "approval") {
        const updatedDraft = await storeReplacementPlan(
          merchant.baseUrl,
          cartResult,
          precheckOutcome.plan
        );
        return {
          checkout: null,
          mapping: workingMapping,
          cartDraft: updatedDraft,
          approvalRequired: true,
          replacementPlan: precheckOutcome.plan,
        };
      }

      addLog(
        `Attempting checkout at ${merchant.url} (try ${attempt + 1}).`,
        "info"
      );
      const payload = buildCheckoutPayload(
        cartResult.lineItems ?? [],
        merchant.handlers
      );
      const storeOpsConfig = resolveSimConfig(merchant.baseUrl);
      const requestId = buildRequestId(
        agentRunId,
        `checkout:create:${attempt}:${cartResult.cart?.cartHash ?? ""}`
      );
      const idempotencyKey = buildCheckoutIdempotencyKey({
        agentRunId,
        cartDraftId: cartResult.cart?.id ?? workingCartDraftId,
        cartHash: cartResult.cart?.cartHash,
      });
      const response = await fetch(
        joinUrl(merchant.baseUrl, "/checkout-sessions"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...baseHeaders({
              requestId,
              idempotencyKey,
              agentRunId,
              storeOpsConfig,
              priceStage: "quote",
            }),
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await safeJson(response);
      if (response.ok) {
        return {
          checkout: data,
          mapping: workingMapping,
          cartDraft: cartResult,
          approvalRequired: false,
        };
      }

      if (data?.code === "OUT_OF_STOCK") {
        const outId = extractOutOfStockId(data?.detail);
        if (outId) {
          const allowedProductIds = Array.isArray(data?.detail?.alternatives)
            ? data.detail.alternatives
            : null;
          const outcome = evaluateReplacementPlan({
            lineItems: cartResult.lineItems ?? [],
            policies: cartResult.cart?.policies,
            reason: "merchant_reject",
            targetProductId: outId,
            allowedProductIds,
          });

          if (outcome.action === "auto" && outcome.replacements.length) {
            workingMapping = applyReplacementsToMapping(
              workingMapping,
              outcome.replacements
            );
            cartResult = await persistReplacementSelection(
              merchant.baseUrl,
              cartResult,
              outcome.replacements,
              outcome.policies
            );
            lastCartDraft = cartResult;
            addLog(
              `Out of stock: substituted ${outId} from saved alternatives.`,
              "warn"
            );
            attempt += 1;
            continue;
          }

          if (outcome.action === "approval") {
            const updatedDraft = await storeReplacementPlan(
              merchant.baseUrl,
              cartResult,
              outcome.plan
            );
            return {
              checkout: null,
              mapping: workingMapping,
              cartDraft: updatedDraft,
              approvalRequired: true,
              replacementPlan: outcome.plan,
            };
          }
        }
      }

      const error = new Error(
        data?.detail?.message ||
          data?.detail ||
          data?.message ||
          `Checkout failed with status ${response.status}.`
      );
      error.code = data?.code ?? null;
      error.detail = data?.detail ?? null;
      throw error;
    }

    if (lastCartDraft) {
      return {
        checkout: null,
        mapping: workingMapping,
        cartDraft: lastCartDraft,
        approvalRequired: false,
      };
    }
    throw new Error("Unable to auto-heal checkout after retries.");
  };

  const runAgent = async () => {
    setAgentLogs([]);
    setMerchantSummaries([]);
    setSelectedMerchant(null);
    setAgentRun(null);
    setCheckoutStatus("loading");
    setCheckout(null);
    setPickupMessage(null);
    setPaymentStatus("idle");
    setError(null);
    setLatestApproval(null);
    setApprovalNeeded(false);
    setApprovalDeltaCents(null);
    setApprovalRequestedAt(null);
    setCartDraft(null);
    setCartDraftItems([]);
    setCartDraftId(null);

    const activeMerchantUrls =
      merchantUrls.length > 0 ? merchantUrls : DEFAULT_MERCHANTS;
    if (!merchantUrls.length) {
      setMerchantUrls(DEFAULT_MERCHANTS);
      showToast("No merchants configured. Restored defaults.");
    }

    const pantryItemsRemoved = cartList
      .filter((item) => isPantryMatch(item))
      .map((item) => ({
        key: item.key,
        name: item.name,
        quantity: item.quantity,
      }));

    const ingredientInputs = cartList
      .filter((item) => !isPantryMatch(item))
      .map((item) => ({
        key: item.key,
        name: item.name,
        query: item.query,
        quantity: item.quantity,
      }));

    const pantrySkipped = cartList.length - ingredientInputs.length;
    if (!ingredientInputs.length) {
      throw new Error("No ingredients left after applying pantry filters.");
    }
    if (pantrySkipped) {
      addLog(`Removed ${pantrySkipped} pantry items from the cart.`, "info");
    }

    addLog("Running discovery across merchants...", "info");

    const summaries = [];
    for (const url of activeMerchantUrls) {
      const baseUrl = resolveMerchantBase(url);
      try {
        addLog(`Fetching catalog from ${url}...`, "info");
        const [discoveryData, products, storeOpsProfile, substitutions] =
          await Promise.all([
            fetchDiscovery(baseUrl),
            fetchProducts(baseUrl),
            fetchStoreOpsProfile(baseUrl),
            fetchStoreOpsSubstitutions(baseUrl),
          ]);

        const handlers = discoveryData?.payment?.handlers ?? [];
        if (!handlers.length) {
          addLog(`No payment handlers at ${url}.`, "warn");
          continue;
        }

        ingredientInputs.forEach((ingredient) => {
          addLog(`Searching for ${ingredient.query} at ${url}...`, "info");
        });

        const simConfig = resolveSimConfig(baseUrl);
        const mapping = buildMapping(ingredientInputs, products, {
          substitutionGraph: substitutions?.substitutionGraph ?? {},
          substitutionAggressiveness: simConfig.substitutionAggressiveness,
          fallbackLimit: substitutions?.maxFallbacks ?? null,
        });
        const { selections, total } = summarizeMapping(mapping);
        const missing = selections.filter((selection) => !selection.product);

        if (missing.length) {
          addLog(`Missing items at ${url}, skipping.`, "warn");
          continue;
        }

        const riskEntries = mapping.map((entry) => ({
          inventory: entry.candidates[0]?.product?.inventory_quantity ?? null,
          fallbackCount: Math.max(0, entry.candidates.length - 1),
        }));
        const riskScore = computeRiskScore({
          entries: riskEntries,
          storeProfile: storeOpsProfile?.store ?? null,
          simConfig,
          pickupSlot: null,
        });

        addLog(
          `Mapped ingredients for ${url} - total ${formatMoney(total)}.`,
          "success"
        );

        summaries.push({
          url,
          baseUrl,
          handlers,
          products,
          storeProfile: storeOpsProfile?.store ?? null,
          substitutionGraph: substitutions?.substitutionGraph ?? {},
          maxFallbacks: substitutions?.maxFallbacks ?? null,
          simConfig,
          riskScore,
          mapping,
          total,
        });
      } catch (err) {
        addLog(`Merchant ${url} failed: ${err.message}`, "error");
      }
    }

    if (!summaries.length) {
      throw new Error(
        "No merchants available. Start the merchant server(s) or update the merchant list in Debug."
      );
    }

    const sorted = [...summaries].sort((a, b) => a.total - b.total);
    setMerchantSummaries(sorted);

    const best = sorted[0];
    setSelectedMerchant(best);
    setCartDraftBaseUrl(best.baseUrl);
    setStoreProfile(best.storeProfile ?? null);
    setCartRiskScore(best.riskScore ?? null);
    addLog(
      `Best price found at ${best.url} for ${formatMoney(best.total)}.`,
      "success"
    );

    const runTimestamp = new Date().toISOString();
    const createdRun = await createAgentRun(best.baseUrl, {
      deviceId: getDeviceId(),
      recipeId: activeRecipe ?? "custom",
      merchantBaseUrl: best.baseUrl,
      storeId: best.storeProfile?.id ?? null,
      createdAt: runTimestamp,
      updatedAt: runTimestamp,
      state: "RESOLVE_INGREDIENTS",
      zeroEdits: true,
      editCount: 0,
      checkoutSuccess: false,
      tapToApprovalMs: null,
    });
    setAgentRun(createdRun);
    setAgentRunId(createdRun?.id ?? null);

    if (createdRun?.id) {
      await createAgentRunStep(best.baseUrl, {
        agentRunId: createdRun.id,
        stepName: "DISCOVER_MERCHANT",
        startedAt: runTimestamp,
        finishedAt: runTimestamp,
        durationMs: 1,
        success: true,
      });
    }

    const {
      checkout: createdCheckout,
      cartDraft: createdDraft,
      approvalRequired,
    } = await createCheckoutWithHealing(best, best.mapping, {
      agentRunId: createdRun?.id ?? null,
      recipeId: activeRecipe ?? "custom",
      pantryItemsRemoved,
      cartDraftId: null,
    });

    if (approvalRequired) {
      setCartDraft(createdDraft?.cart ?? null);
      setCartDraftItems(createdDraft?.lineItems ?? []);
      setCartDraftId(createdDraft?.cart?.id ?? null);
      setCheckoutStatus("awaiting");
      setApprovalRequestedAt(Date.now());
      addLog("Replacements require approval before checkout.", "warn");
      if (createdRun?.id) {
        const updatedRun = await updateAgentRun(best.baseUrl, createdRun.id, {
          cartDraftId: createdDraft?.cart?.id ?? null,
          state: "AWAITING_APPROVAL",
          merchantBaseUrl: best.baseUrl,
          storeId: best.storeProfile?.id ?? selectedStoreId,
        });
        setAgentRun(updatedRun);
      }
      openReview();
      return;
    }

    if (!createdCheckout) {
      throw new Error("Checkout could not be created from the cart draft.");
    }
    await finalizeCheckoutFlow({
      baseUrl: best.baseUrl,
      checkoutData: createdCheckout,
      cartDraftResult: createdDraft,
      agentRunId: createdRun?.id ?? null,
      storeId: best.storeProfile?.id ?? selectedStoreId,
      approvalStatus: "quoted",
    });
  };

  const handleCheckout = async () => {
    if (!cartList.length) {
      setError("Add ingredients before checking out.");
      return;
    }
    setPanelOpen(true);
    try {
      await runAgent();
      setOutOfStockContext(null);
      showToast("Checkout ready.");
    } catch (err) {
      setCheckoutStatus("error");
      if (err?.code === "OUT_OF_STOCK") {
        captureOutOfStockContext(err.detail ?? err);
      }
      setError(err?.message ?? "Checkout failed.");
    }
  };

  const handleRemoveLineItem = async ({ ingredientKey, productId }) => {
    if (!cartDraft) {
      return;
    }
    const updatedLineItems = cartDraftItems.filter((line) => {
      if (ingredientKey && line.ingredientKey === ingredientKey) {
        return false;
      }
      if (productId && line.primarySkuJson?.id === productId) {
        return false;
      }
      return true;
    });
    const updatedDraft = await updateDraftLineItems(updatedLineItems);
    if (updatedDraft) {
      await handleRequoteCart(
        updatedDraft.lineItems ?? updatedLineItems,
        updatedDraft.cart ?? null
      );
    }
    setOutOfStockContext(null);
    showToast("Removed item. Confirm total to continue.");
  };

  const handleRemoveUnavailableItems = async () => {
    if (
      !cartDraft ||
      (!missingReplacementKeys.length && !missingReplacementProductIds.length)
    ) {
      return;
    }
    const updatedLineItems = cartDraftItems.filter(
      (line) =>
        !missingReplacementKeys.includes(line.ingredientKey) &&
        !missingReplacementProductIds.includes(line.primarySkuJson?.id)
    );
    const updatedDraft = await updateDraftLineItems(updatedLineItems);
    if (updatedDraft) {
      await handleRequoteCart(
        updatedDraft.lineItems ?? updatedLineItems,
        updatedDraft.cart ?? null
      );
    }
    setOutOfStockContext(null);
    showToast("Removed unavailable items. Confirm total to continue.");
  };

  const handleAcceptReplacement = async (item) => {
    if (!item?.proposed || !cartDraft) {
      return;
    }
    const line = cartDraftItems.find(
      (entry) => entry.ingredientKey === item.ingredientKey
    );
    if (!line) {
      return;
    }
    const replacement = {
      skuJson: item.proposed,
      scoreBreakdownJson: null,
      confidence: line.confidence ?? null,
      reason: "approved_substitution",
      rank: item.rank ?? 1,
    };
    await handleSwapLineItem(line, replacement);
  };

  const handleApproveReplacements = async () => {
    if (!cartDraft || !proposedReplacementPlan) {
      return;
    }

    const baseUrl = cartDraftBaseUrl || API_BASE;
    setCheckoutStatus("loading");
    setError(null);
    setApprovalNeeded(false);
    setApprovalDeltaCents(null);

    try {
      if (hasMissingReplacements) {
        setCheckoutStatus("idle");
        setError(
          "Some items have no replacement. Remove them to continue checkout."
        );
        addLog("Missing replacements require item removal.", "warn");
        return;
      }
      let merchant = selectedMerchant;
      if (!merchant || !merchant.handlers?.length) {
        const [discovery, storeOpsProfile, substitutions] = await Promise.all([
          fetchDiscovery(baseUrl),
          fetchStoreOpsProfile(baseUrl),
          fetchStoreOpsSubstitutions(baseUrl),
        ]);
        merchant = {
          url: baseUrl,
          baseUrl,
          handlers: discovery?.payment?.handlers ?? [],
          products: [],
          mapping: [],
          total: 0,
          storeProfile: storeOpsProfile?.store ?? null,
          substitutionGraph: substitutions?.substitutionGraph ?? {},
          maxFallbacks: substitutions?.maxFallbacks ?? null,
          simConfig: resolveSimConfig(baseUrl),
        };
        setSelectedMerchant(merchant);
        setStoreProfile(storeOpsProfile?.store ?? null);
      }

      if (!merchant.handlers?.length) {
        throw new Error("No payment handlers available for checkout.");
      }

      try {
        await recordTapToApproval();
      } catch (err) {
        addLog("Failed to log approval timing.", "warn");
      }

      const policies = normalizePolicies(cartDraft.policies);
      const replacementEntries = buildReplacementEntriesFromPlan(
        cartDraftItems,
        proposedReplacementPlan
      );
      if (!replacementEntries.length) {
        setCheckoutStatus("idle");
        setError(
          "No replacements available. Remove unavailable items or rerun the cart."
        );
        addLog("No replacements available to approve.", "warn");
        return;
      }

      await Promise.all(
        replacementEntries.map(async (entry) => {
          try {
            await recordEditEvent({
              agentRunId: agentRun?.id ?? agentRunId,
              ingredientKey: entry.ingredientKey,
              actionType: "replacedSku",
              fromSkuJson: entry.line.primarySkuJson ?? entry.primary ?? null,
              toSkuJson: entry.replacement?.skuJson ?? null,
              reason: entry.reason ?? "approved_replacement",
            });
          } catch (err) {
            addLog("Failed to record replacement edit.", "warn");
          }
        })
      );

      const updatedLineItems = applyReplacementPlanToLineItems(
        cartDraftItems,
        replacementEntries
      );
      setCartDraftItems(updatedLineItems);
      setCartDraft((prev) =>
        prev
          ? {
              ...prev,
              quoteSummary: {
                ...(prev.quoteSummary ?? {}),
                proposedReplacementPlan: null,
              },
            }
          : prev
      );

      const approvedMapping = buildMappingFromLineItems(updatedLineItems);

      const {
        checkout: createdCheckout,
        cartDraft: createdDraft,
        approvalRequired,
      } = await createCheckoutWithHealing(merchant, approvedMapping, {
        agentRunId: agentRun?.id ?? agentRunId,
        recipeId: cartDraft.recipeId ?? "custom",
        pantryItemsRemoved: cartDraft.pantryItemsRemoved ?? [],
        cartDraftId: cartDraft.id,
        policies,
      });

      if (approvalRequired) {
        setCartDraft(createdDraft?.cart ?? null);
        setCartDraftItems(createdDraft?.lineItems ?? []);
        setCartDraftId(createdDraft?.cart?.id ?? null);
        setCheckoutStatus("awaiting");
        setApprovalRequestedAt(Date.now());
        addLog("Replacements still need approval.", "warn");
        if (agentRun?.id || agentRunId) {
          const updatedRun = await updateAgentRun(
            baseUrl,
            agentRun?.id ?? agentRunId,
            {
              cartDraftId: createdDraft?.cart?.id ?? null,
              state: "AWAITING_APPROVAL",
              merchantBaseUrl: baseUrl,
              storeId: selectedStoreId,
            }
          );
          setAgentRun(updatedRun);
        }
        openReview();
        return;
      }

      if (!createdCheckout) {
        throw new Error("Checkout could not be created after approval.");
      }

      await finalizeCheckoutFlow({
        baseUrl,
        checkoutData: createdCheckout,
        cartDraftResult: createdDraft,
        agentRunId: agentRun?.id ?? agentRunId,
        storeId: selectedStoreId,
        approvalStatus: "approved",
      });
    } catch (err) {
      setCheckoutStatus("error");
      setError(err?.message ?? "Failed to approve replacements.");
    }
  };

  const handleRejectReplacements = async () => {
    if (!cartDraft || !proposedReplacementPlan) {
      return;
    }

    const baseUrl = cartDraftBaseUrl || API_BASE;
    setCheckoutStatus("idle");
    setApprovalRequestedAt(null);
    setCheckout(null);
    setApprovalNeeded(false);
    setApprovalDeltaCents(null);

    try {
      await Promise.all(
        (proposedReplacementPlan.items ?? []).map(async (item) => {
          try {
            await recordEditEvent({
              agentRunId: agentRun?.id ?? agentRunId,
              ingredientKey: item.ingredientKey,
              actionType: "rejectedReplacement",
              fromSkuJson: item.proposed ?? item.current ?? null,
              toSkuJson: null,
              reason: item.reason ?? "user_rejected",
            });
          } catch (err) {
            addLog("Failed to record rejection edit.", "warn");
          }
        })
      );

      const updatedDraft = await updateCartDraft(baseUrl, cartDraft.id, {
        quoteSummary: {
          ...(cartDraft.quoteSummary ?? {}),
          proposedReplacementPlan: null,
          replacementRejectedAt: new Date().toISOString(),
        },
        quoteHash: null,
        checkoutSessionId: null,
        updatedAt: new Date().toISOString(),
      });
      setCartDraft(updatedDraft.cart ?? null);
      setCartDraftItems(updatedDraft.lineItems ?? []);
      setCartDraftId(updatedDraft.cart?.id ?? null);

      if (agentRun?.id || agentRunId) {
        const updated = await updateAgentRun(baseUrl, agentRun?.id ?? agentRunId, {
          state: "FAILED",
          failureCode: "REPLACEMENT_REJECTED",
          failureDetail: "User rejected proposed replacements.",
        });
        setAgentRun(updated);
      }

      setError("Replacements rejected. Update the cart and rerun checkout.");
      addLog("User rejected replacements.", "warn");
    } catch (err) {
      setError(err?.message ?? "Failed to reject replacements.");
    }
  };

  const handleApproveTotal = async () => {
    if (!cartDraft) {
      return;
    }

    const baseUrl = cartDraftBaseUrl || API_BASE;
    const checkoutId = cartDraft.checkoutSessionId ?? checkout?.id;
    if (!checkoutId) {
      setError("No checkout session available to approve.");
      return;
    }

    setCheckoutStatus("loading");
    setError(null);

    try {
      try {
        await recordTapToApproval();
      } catch (err) {
        addLog("Failed to log approval timing.", "warn");
      }
      const { quoteSummary, quoteHash, cartDraft: updatedDraft } =
        await refreshCheckoutQuote({
          baseUrl,
          checkoutId,
          cartDraft,
          agentRunId: agentRun?.id ?? agentRunId,
          priceStage: "quote",
        });
      const approvedTotal = getQuoteTotal(quoteSummary);
      if (!Number.isFinite(approvedTotal)) {
        throw new Error("Unable to resolve the updated total.");
      }

      await recordApproval({
        baseUrl,
        agentRunId: agentRun?.id ?? agentRunId ?? updatedDraft?.agentRunId,
        cartHash: updatedDraft?.cartHash ?? cartDraft.cartHash,
        quoteHash,
        approvedTotalCents: approvedTotal,
        status: "approved",
      });

      setApprovalNeeded(false);
      setApprovalDeltaCents(null);
      setCheckoutStatus("ready");
      addLog("Updated total approved.", "success");

      if (agentRun?.id || agentRunId) {
        const updatedRun = await updateAgentRun(
          baseUrl,
          agentRun?.id ?? agentRunId,
          {
            cartDraftId: updatedDraft?.id ?? cartDraft.id,
            state: "CHECKOUT",
            merchantBaseUrl: baseUrl,
            storeId: selectedStoreId,
          }
        );
        setAgentRun(updatedRun);
      }
    } catch (err) {
      setCheckoutStatus("error");
      setError(err?.message ?? "Failed to approve the updated total.");
    }
  };

  const updateCartPolicies = async (updates, reason) => {
    if (!cartDraft) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const current = normalizePolicies(cartDraft.policies);
    const updatedPolicies = {
      ...current,
      ...updates,
    };
    try {
      const updated = await updateCartDraft(baseUrl, cartDraft.id, {
        policies: updatedPolicies,
        updatedAt: new Date().toISOString(),
      });
      setCartDraft(updated.cart ?? null);
      setCartDraftItems(updated.lineItems ?? []);
      return updatedPolicies;
    } catch (err) {
      setError(err?.message ?? "Failed to update cart preferences.");
      return null;
    }
  };

  const handlePolicyToggle = async (key, nextValue) => {
    const updatedPolicies = await updateCartPolicies(
      { [key]: nextValue },
      key
    );
    if (!updatedPolicies) {
      return;
    }
    try {
      await recordEditEvent({
        agentRunId: agentRun?.id ?? agentRunId,
        ingredientKey: null,
        actionType: "toggledSubstitutions",
        fromSkuJson: { [key]: !nextValue },
        toSkuJson: { [key]: nextValue },
        reason: key,
      });
    } catch (err) {
      addLog("Failed to record preference update.", "warn");
    }
    if (key === "allowSubs") {
      showToast(nextValue ? "Substitutions enabled." : "Substitutions disabled.");
    }
  };

  const updateDraftLineItems = async (nextLineItems) => {
    if (!cartDraft) {
      return null;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    const updatedCart = {
      ...cartDraft,
      quoteSummary: null,
      quoteHash: null,
      checkoutSessionId: null,
      updatedAt: new Date().toISOString(),
    };
    const result = await upsertCartDraft(baseUrl, {
      cart: updatedCart,
      lineItems: nextLineItems,
    });
    setCartDraft(result.cart ?? null);
    setCartDraftItems(result.lineItems ?? []);
    setCartDraftId(result.cart?.id ?? null);
    setCheckout(null);
    setCheckoutStatus("idle");
    return result;
  };

  const ensureMerchantContext = async (baseUrl) => {
    let merchant = selectedMerchant;
    if (!merchant || !merchant.handlers?.length) {
      const [discovery, storeOpsProfile, substitutions] = await Promise.all([
        fetchDiscovery(baseUrl),
        fetchStoreOpsProfile(baseUrl),
        fetchStoreOpsSubstitutions(baseUrl),
      ]);
      merchant = {
        url: baseUrl,
        baseUrl,
        handlers: discovery?.payment?.handlers ?? [],
        products: [],
        mapping: [],
        total: 0,
        storeProfile: storeOpsProfile?.store ?? null,
        substitutionGraph: substitutions?.substitutionGraph ?? {},
        maxFallbacks: substitutions?.maxFallbacks ?? null,
        simConfig: resolveSimConfig(baseUrl),
      };
      setSelectedMerchant(merchant);
      setStoreProfile(storeOpsProfile?.store ?? null);
    }
    if (!merchant.handlers?.length) {
      throw new Error("No payment handlers available for checkout.");
    }
    return merchant;
  };

  const handleRequoteCart = async (overrideLineItems, overrideDraft) => {
    const activeDraft = overrideDraft ?? cartDraft;
    if (!activeDraft) {
      return;
    }
    const baseUrl = cartDraftBaseUrl || API_BASE;
    setCheckoutStatus("loading");
    setError(null);
    try {
      const merchant = await ensureMerchantContext(baseUrl);
      const lineItems = overrideLineItems ?? cartDraftItems;
      const mapping = buildMappingFromLineItems(lineItems);
      const runId =
        agentRun?.id ?? agentRunId ?? activeDraft.agentRunId ?? null;
      const {
        checkout: createdCheckout,
        cartDraft: createdDraft,
        approvalRequired,
      } = await createCheckoutWithHealing(merchant, mapping, {
        agentRunId: runId,
        recipeId: activeDraft.recipeId ?? "custom",
        pantryItemsRemoved: activeDraft.pantryItemsRemoved ?? [],
        cartDraftId: activeDraft.id,
        policies: activeDraft.policies,
      });

      if (approvalRequired) {
        setCartDraft(createdDraft?.cart ?? null);
        setCartDraftItems(createdDraft?.lineItems ?? []);
        setCartDraftId(createdDraft?.cart?.id ?? null);
        setCheckoutStatus("awaiting");
        setApprovalRequestedAt(Date.now());
        addLog("Replacements require approval before checkout.", "warn");
        return;
      }

      if (!createdCheckout) {
        throw new Error("Checkout could not be created from the cart.");
      }

      await finalizeCheckoutFlow({
        baseUrl,
        checkoutData: createdCheckout,
        cartDraftResult: createdDraft,
        agentRunId: runId,
        storeId: selectedStoreId,
        approvalStatus: "quoted",
      });
      setOutOfStockContext(null);
    } catch (err) {
      setCheckoutStatus("error");
      if (err?.code === "OUT_OF_STOCK") {
        captureOutOfStockContext(err.detail ?? err);
      }
      setError(err?.message ?? "Failed to confirm total.");
    }
  };

  const handleSwapLineItem = async (line, alternative) => {
    if (!line || !alternative?.skuJson) {
      return;
    }
    try {
      await recordEditEvent({
        agentRunId: agentRun?.id ?? agentRunId,
        ingredientKey: line.ingredientKey,
        actionType: "replacedSku",
        fromSkuJson: line.primarySkuJson ?? null,
        toSkuJson: alternative.skuJson ?? null,
        reason: "manual_swap",
      });
    } catch (err) {
      addLog("Failed to record replacement edit.", "warn");
    }

    const replacementEntry = {
      ingredientKey: line.ingredientKey,
      line,
      replacement: alternative,
      reason: "manual_swap",
      autoApplied: true,
    };
    const updatedLineItems = applyReplacementPlanToLineItems(
      cartDraftItems,
      [replacementEntry]
    );
    const updatedDraft = await updateDraftLineItems(updatedLineItems);
    if (updatedDraft) {
      await handleRequoteCart(
        updatedDraft.lineItems ?? updatedLineItems,
        updatedDraft.cart ?? null
      );
    }
    setEditingLineItemId(null);
  };

  const handleUpdateLineItemQuantity = async (line, nextQuantity) => {
    if (!line || !cartDraft) {
      return;
    }
    const quantity = Math.max(0, nextQuantity);
    const updatedLineItems = cartDraftItems
      .map((item) =>
        item.id === line.id
          ? {
              ...item,
              quantity,
              lineTotalCents:
                item.primarySkuJson?.price !== undefined
                  ? item.primarySkuJson.price * quantity
                  : item.lineTotalCents,
            }
          : item
      )
      .filter((item) => item.quantity > 0);
    await updateDraftLineItems(updatedLineItems);
    try {
      await recordEditEvent({
        agentRunId: agentRun?.id ?? agentRunId,
        ingredientKey: line.ingredientKey,
        actionType: "changedQuantity",
        fromSkuJson: { quantity: line.quantity },
        toSkuJson: { quantity },
        reason: "manual_quantity",
      });
    } catch (err) {
      addLog("Failed to record quantity edit.", "warn");
    }
    showToast("Cart updated. Confirm total to continue.");
  };

  const handlePay = async () => {
    const checkoutId = checkout?.id ?? cartDraft?.checkoutSessionId;
    if (!checkoutId || !selectedMerchant) {
      return;
    }

    if (approvalNeeded || proposedReplacementPlan || checkoutStatus === "awaiting") {
      addLog("Approval required before payment.", "warn");
      return;
    }

    setPaymentStatus("processing");
    setError(null);

    try {
      const baseUrl = selectedMerchant.baseUrl;
      if (!cartDraft) {
        throw new Error("Cart draft is missing for payment.");
      }
      const runId = agentRun?.id ?? agentRunId;
      let refreshResult = await refreshCheckoutQuote({
        baseUrl,
        checkoutId,
        cartDraft,
        agentRunId: runId,
        priceStage: "checkout",
      });
      const reservation =
        refreshResult.checkout?.fulfillment?.methods?.[0]?.groups?.[0]
          ?.reservation ?? null;
      if (
        !reservation ||
        (reservation?.expires_at &&
          new Date(reservation.expires_at).getTime() <= Date.now())
      ) {
        addLog("Pickup slot expired. Reserving a new slot.", "warn");
        const refreshedCheckout = await prepareFulfillment(
          baseUrl,
          refreshResult.checkout ?? checkout,
          runId
        );
        refreshResult = await refreshCheckoutQuote({
          baseUrl,
          checkoutId: refreshedCheckout.id,
          cartDraft: refreshResult.cartDraft ?? cartDraft,
          agentRunId: runId,
          priceStage: "checkout",
        });
      }

      const latestQuoteSummary = refreshResult.quoteSummary;
      const latestQuoteHash = refreshResult.quoteHash;
      const activeDraft = refreshResult.cartDraft ?? cartDraft;
      const latestTotal = getQuoteTotal(latestQuoteSummary);

      const policies = normalizePolicies(activeDraft?.policies ?? cartDraft?.policies);
      let approval = latestApproval;
      if (!approval && activeDraft?.cartHash) {
        approval = await fetchLatestApproval(baseUrl, {
          agentRunId: activeDraft?.agentRunId ?? runId,
          cartHash: activeDraft.cartHash,
        });
        setLatestApproval(approval);
      }

      if (
        approval &&
        Number.isFinite(approval.approvedTotalCents) &&
        Number.isFinite(policies.requireReapprovalAboveCents)
      ) {
        const delta = latestTotal - approval.approvedTotalCents;
        if (delta > policies.requireReapprovalAboveCents) {
          setApprovalNeeded(true);
          setApprovalDeltaCents(delta);
          setCheckoutStatus("awaiting");
          if (!approvalRequestedAt) {
            setApprovalRequestedAt(Date.now());
          }
          setPaymentStatus("idle");
          addLog("Quote total increased. Re-approval required.", "warn");

          if (agentRun?.id || agentRunId) {
            const updatedRun = await updateAgentRun(
              baseUrl,
              runId,
              {
                cartDraftId: activeDraft?.id ?? cartDraft?.id ?? null,
                state: "AWAITING_APPROVAL",
                merchantBaseUrl: baseUrl,
                storeId: selectedStoreId,
              }
            );
            setAgentRun(updatedRun);
          }
          return;
        }
      }

      setApprovalNeeded(false);
      setApprovalDeltaCents(null);

      if (!approval && activeDraft?.cartHash && Number.isFinite(latestTotal)) {
        try {
          await recordApproval({
            baseUrl,
            agentRunId: activeDraft?.agentRunId ?? runId,
            cartHash: activeDraft.cartHash,
            quoteHash: latestQuoteHash,
            approvedTotalCents: latestTotal,
            status: "quoted",
          });
        } catch (err) {
          addLog("Failed to record initial approval.", "warn");
        }
      }

      const handler =
        selectedMerchant.handlers.find(
          (item) => item.id === "mock_payment_handler"
        ) ?? selectedMerchant.handlers[0];
      if (!handler) {
        throw new Error("No payment handler available to process payment.");
      }

      const paymentAttemptId =
        latestQuoteHash ?? activeDraft?.quoteHash ?? makeId();
      const instrumentId = `instr_${paymentAttemptId}`;
      const paymentIdempotencyKey = `pay_${paymentAttemptId}`;
      const paymentPayload = {
        payment_data: {
          id: instrumentId,
          handler_id: handler.id,
          handler_name: handler.name || handler.id,
          type: "card",
          brand: "Visa",
          last_digits: "4242",
          credential: { type: "token", token: "success_token" },
          billing_address: {
            street_address: "600 Market St",
            address_locality: "San Francisco",
            address_region: "CA",
            postal_code: "94104",
            address_country: "US",
          },
        },
        risk_signals: {
          ip: "127.0.0.1",
          browser: "dish-feed-web",
        },
      };

      const response = await fetch(
        joinUrl(
          baseUrl,
          `/checkout-sessions/${checkoutId}/complete`
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...baseHeaders({
              requestId: buildRequestId(
                runId,
                `payment:${checkoutId}:${latestQuoteHash ?? ""}`
              ),
              idempotencyKey: paymentIdempotencyKey,
              agentRunId: runId,
              storeOpsConfig: resolveSimConfig(baseUrl),
              priceStage: "checkout",
            }),
          },
          body: JSON.stringify(paymentPayload),
        }
      );

      const data = await safeJson(response);
      if (!response.ok) {
        if (data?.code === "OUT_OF_STOCK") {
          const outId = extractOutOfStockId(data?.detail);
          const allowedProductIds = Array.isArray(data?.detail?.alternatives)
            ? data.detail.alternatives
            : null;
          if (outId && activeDraft) {
            const outcome = evaluateReplacementPlan({
              lineItems: cartDraftItems ?? [],
              policies: activeDraft.policies ?? cartDraft.policies,
              reason: "picking_oos",
              targetProductId: outId,
              allowedProductIds,
            });
            if (outcome.action === "auto" && outcome.replacements.length) {
              const updatedResult = await persistReplacementSelection(
                baseUrl,
                { cart: activeDraft, lineItems: cartDraftItems },
                outcome.replacements,
                outcome.policies
              );
              setCartDraft(updatedResult.cart ?? null);
              setCartDraftItems(updatedResult.lineItems ?? []);
              setCartDraftId(updatedResult.cart?.id ?? null);
              setPaymentStatus("idle");
              addLog(
                "Picking issue detected. Auto-healed with fallback SKUs.",
                "warn"
              );
              await handleRequoteCart(
                updatedResult.lineItems ?? cartDraftItems,
                updatedResult.cart ?? activeDraft
              );
              return;
            }
            if (outcome.action === "approval") {
              const updatedDraft = await storeReplacementPlan(
                baseUrl,
                { cart: activeDraft, lineItems: cartDraftItems },
                outcome.plan
              );
              setCartDraft(updatedDraft.cart ?? null);
              setCartDraftItems(updatedDraft.lineItems ?? []);
              setCartDraftId(updatedDraft.cart?.id ?? null);
              setCheckoutStatus("awaiting");
              setApprovalRequestedAt(Date.now());
              setPaymentStatus("idle");
              addLog("Picking issue requires approval.", "warn");
              return;
            }
          }
        }
        if (
          data?.code === "PICKUP_SLOT_EXPIRED" ||
          data?.code === "PICKUP_SLOT_FULL" ||
          data?.code === "PICKUP_SLOT_REQUIRED"
        ) {
          setPaymentStatus("idle");
          addLog("Pickup slot expired. Reserving a new slot.", "warn");
          const refreshedCheckout = await prepareFulfillment(
            baseUrl,
            checkout ?? refreshResult.checkout,
            runId
          );
          await refreshCheckoutQuote({
            baseUrl,
            checkoutId: refreshedCheckout.id,
            cartDraft: activeDraft,
            agentRunId: runId,
            priceStage: "checkout",
          });
          setCheckoutStatus("ready");
          return;
        }
        throw new Error(
          data?.detail?.message ||
            data?.detail ||
            data?.message ||
            `Payment failed with status ${response.status}.`
        );
      }

      setPaymentStatus("success");
      setCheckout(data);
      setApprovalNeeded(false);
      setApprovalDeltaCents(null);
      setAgentRun((prev) =>
        prev
          ? {
              ...prev,
              state: "ORDER_CREATED",
              orderId: data?.order?.id ?? prev.orderId,
              checkoutSuccess: true,
            }
          : prev
      );

      const selectedSlot = pickupSlots.find(
        (slot) => slot.id === selectedSlotId
      );
      const pickupLabel = selectedSlot?.dateLabel ?? "soon";
      const pickupTime = selectedSlot?.timeLabel ?? "12:00";
      const storeName =
        selectedStore?.label ?? selectedStore?.name ?? "Dish Feed Market";
      setPickupMessage(
        `Pickup groceries at ${pickupTime} on ${pickupLabel} at ${storeName}.`
      );
      showToast("Payment successful.");
      if (agentRun?.id || agentRunId) {
        try {
          await updateAgentRun(
            cartDraftBaseUrl || API_BASE,
            runId,
            {
              state: "ORDER_CREATED",
              orderId: data?.order?.id ?? null,
              checkoutSuccess: true,
            }
          );
        } catch (err) {
          addLog("Failed to update agent run after payment.", "warn");
        }
      }
      if (runId && cartDraft) {
        try {
          const approvedTotal =
            data?.totals?.find((total) => total.type === "total")?.amount ??
            cartDraftItems.reduce(
              (sum, item) =>
                sum +
                (item.lineTotalCents ??
                  (item.primarySkuJson?.price ?? 0) * item.quantity),
              0
            );
          await recordApproval({
            baseUrl: cartDraftBaseUrl || API_BASE,
            agentRunId: runId,
            cartHash: cartDraft.cartHash,
            quoteHash: cartDraft.quoteHash ?? latestQuoteHash ?? "",
            approvedTotalCents: approvedTotal,
            status: "paid",
          });
        } catch (err) {
          addLog("Failed to store approval record.", "warn");
        }
      }
      clearCart();
    } catch (err) {
      setPaymentStatus("error");
      setError(err?.message ?? "Payment failed.");
    }
  };

  const handleStartNewCart = () => {
    resetRunState({ keepCart: false });
    setMainView(VIEW_MODES.FEED);
    setPanelOpen(false);
  };

  const handleCopyRunDetails = async () => {
    const payload = {
      agentRun,
      cartDraft,
      cartDraftItems,
      checkout,
      latestApproval,
      storeProfile,
      pickupSlots,
      merchantSimConfig,
      logs: agentLogs,
      metricsSummary,
    };
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(payload, null, 2)
      );
      showToast("Run details copied.");
    } catch (err) {
      setError("Could not copy run details.");
    }
  };

  const primaryAction = (() => {
    if (proposedReplacementPlan) {
      return {
        label: "Approve",
        onClick: openReview,
        disabled: checkoutStatus === "loading",
      };
    }
    if (approvalNeeded) {
      return {
        label:
          checkoutStatus === "loading"
            ? "Approving..."
            : "Approve",
        onClick: handleApproveTotal,
        disabled: checkoutStatus === "loading",
      };
    }
    if (isOrderConfirmed) {
      return {
        label: "Build cart",
        onClick: handleStartNewCart,
        disabled: false,
      };
    }
    if (!hasCartDraft) {
      return {
        label: checkoutStatus === "loading" ? "Building..." : "Build cart",
        onClick: hasCartItems ? handleCheckout : null,
        disabled: checkoutStatus === "loading" || !hasCartItems,
      };
    }
    if (!cartDraft?.checkoutSessionId) {
      return {
        label: "Review cart",
        onClick: openReview,
        disabled: false,
      };
    }
    return {
      label: paymentStatus === "processing" ? "Paying..." : "Pay",
      onClick: handlePay,
      disabled: !canPay,
    };
  })();

  const renderLineItem = (line) => {
    const lineTotal =
      line.lineTotalCents ??
      (line.primarySkuJson?.price ?? 0) * line.quantity;
    const lineKey =
      line.ingredientKey ??
      line.id ??
      line.primarySkuJson?.id ??
      line.primarySkuJson?.title;
    const isEditing = lineKey ? editingLineItemId === lineKey : false;
    const isExpanded =
      debugEnabled && lineKey ? Boolean(expandedLineItems[lineKey]) : false;
    const alternatives = (line.alternatives ?? []).slice(0, 3);

    return (
      <div key={lineKey} className="cart-row">
        <div className="cart-row-main">
          <strong>{line.primarySkuJson?.title ?? "Item"}</strong>
          <div className="cart-row-actions">
            <button
              type="button"
              className="link"
              onClick={() => toggleLineItemEdit(lineKey)}
            >
              {isEditing ? "Done" : "Change"}
            </button>
            {debugEnabled ? (
              <button
                type="button"
                className="info-button"
                onClick={() => toggleLineItemDetails(lineKey)}
                aria-label="Why this item"
              >
                i
              </button>
            ) : null}
          </div>
        </div>
        <div className="cart-row-controls">
          <div className="quantity">
            <button
              type="button"
              onClick={() =>
                handleUpdateLineItemQuantity(line, line.quantity - 1)
              }
            >
              -
            </button>
            <span>{line.quantity}</span>
            <button
              type="button"
              onClick={() =>
                handleUpdateLineItemQuantity(line, line.quantity + 1)
              }
            >
              +
            </button>
          </div>
          <span className="price">{formatMoney(lineTotal)}</span>
        </div>
        {isEditing ? (
          <div className="line-edit">
            <strong>Alternatives</strong>
            {alternatives.length ? (
              alternatives.map((alt) => (
                <div
                  key={alt.id ?? alt.rank ?? alt.skuJson?.id}
                  className="line-alternative"
                >
                  <div>
                    <span>{alt.skuJson?.title ?? "Alternative"}</span>
                    <span className="muted">
                      {formatMoney(alt.skuJson?.price ?? 0)}
                      {debugEnabled
                        ? ` - score ${formatScore(
                            alt.scoreBreakdownJson?.totalScore
                          )}`
                        : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => handleSwapLineItem(line, alt)}
                    disabled={checkoutStatus === "loading"}
                  >
                    Swap
                  </button>
                </div>
              ))
            ) : (
              <span className="muted">No alternatives stored.</span>
            )}
            <button
              type="button"
              className="ghost line-remove"
              onClick={() => handleUpdateLineItemQuantity(line, 0)}
              disabled={checkoutStatus === "loading"}
            >
              Remove item
            </button>
          </div>
        ) : null}
        {debugEnabled && isExpanded ? (
          <div className="why-drawer">
            <div className="why-row">
              <span className="muted">Chosen reason</span>
              <span>{line.chosenReason ?? "best_match"}</span>
            </div>
            <div className="why-row">
              <span className="muted">Confidence</span>
              <span>{formatConfidence(line.confidence)}</span>
            </div>
            <div className="why-section">
              <strong>Top alternatives</strong>
              {alternatives.length ? (
                alternatives.map((alt) => {
                  const breakdown = alt.scoreBreakdownJson ?? {};
                  const penalties = breakdown.penalties ?? {};
                  const penaltyTotal = Object.values(penalties).reduce(
                    (sum, value) =>
                      sum + (typeof value === "number" ? value : 0),
                    0
                  );
                  return (
                    <div
                      key={alt.id ?? alt.rank ?? alt.skuJson?.id}
                      className="why-alt"
                    >
                      <div className="why-alt-header">
                        <span>
                          {alt.skuJson?.title ?? "Alternative"}
                        </span>
                        <span className="muted">
                          score {formatScore(breakdown.totalScore)}
                        </span>
                      </div>
                      <div className="why-alt-grid">
                        <span>
                          Name {formatScore(breakdown.nameMatch)}
                        </span>
                        <span>
                          Form {formatScore(breakdown.formMatch)}
                        </span>
                        <span>
                          Category {formatScore(breakdown.categoryMatch)}
                        </span>
                        <span>
                          Size {formatScore(breakdown.sizeMatch)}
                        </span>
                        <span>
                          Attribute {formatScore(breakdown.attributeMatch)}
                        </span>
                        <span>
                          Penalty {formatScore(penaltyTotal)}
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <span className="muted">No alternatives stored.</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={`app ${debugEnabled ? "debug-mode" : ""}`}>
      <header className="app-header">
        <div className="brand">Dish Feed</div>
        <div className="header-context">{headerContext}</div>
        <div className="header-actions">
          <button
            type="button"
            className="cart-button"
            onClick={handleCartToggle}
          >
            Cart <span>{panelItemCount}</span>
          </button>
          {needsApproval ? (
            <button
              type="button"
              className="attention-pill"
              onClick={openReview}
            >
              Needs approval
            </button>
          ) : null}
          <button
            type="button"
            className={`debug-toggle ${debugEnabled ? "active" : ""}`}
            onClick={() => setDebugEnabled((prev) => !prev)}
          >
            Debug
          </button>
        </div>
      </header>

      <div className="app-shell">
        <main className={`main-content view-${viewClass}`}>
          {mainView === VIEW_MODES.FEED ? (
            <div className="feed-view">
              {showHero ? (
                <section className="hero hero-primary">
                  <div className="hero-copy">
                    <p className="eyebrow">Dish Feed</p>
                    <h1>Meal planning, simplified for pickup.</h1>
                    <p className="lead">
                      Pick a recipe, approve the cart, and schedule pickup in
                      one calm flow.
                    </p>
                    <div className="hero-meta">
                      <span>{storeLabel}</span>
                      <span>{pickupSummary}</span>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="feed-header">
                  <p className="eyebrow">Recipe Feed</p>
                  <h1>Pick a dish to start</h1>
                  <p className="muted">
                    We build a pickup-ready cart in one clean flow.
                  </p>
                </section>
              )}

              <section className="section">
                <div className="section-head minimal">
                  <div>
                    <p className="eyebrow">Recipes</p>
                    <h2>Choose tonight's meal</h2>
                  </div>
                  <p className="muted">
                    Tap a recipe to build ingredients.
                  </p>
                </div>
                <div className="recipe-grid">
                  {RECIPES.map((recipe, index) => {
                    const servings = getRecipeServings(recipe);
                    const estimate = formatRecipeEstimate(recipe);
                    return (
                      <article
                        key={recipe.id}
                        className="recipe-card"
                        style={{ "--card-index": index }}
                        onClick={() =>
                          showToast("Recipe details coming soon.")
                        }
                      >
                        <div className="recipe-media">
                          <img
                            className="recipe-image"
                            src={recipe.image}
                            alt={recipe.title}
                            loading="lazy"
                          />
                        </div>
                        <div className="recipe-body">
                          <h3>{recipe.title}</h3>
                          <div className="recipe-meta">
                            <span>{recipe.time}</span>
                            <span>{servings} servings</span>
                          </div>
                          <p className="recipe-estimate">
                            Est. {estimate}
                          </p>
                          <div className="recipe-actions">
                            <button
                              type="button"
                              className="primary"
                              onClick={(event) => {
                                event.stopPropagation();
                                addRecipeToCart(recipe);
                              }}
                            >
                              {activeRecipe === recipe.id
                                ? "Added"
                                : "Get ingredients"}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : null}

          {mainView === VIEW_MODES.CART_REVIEW ? (
            <section className="review-shell">
              {cartDraft ? (
                <>
                  <div className="review-header">
                    <div>
                      <p className="eyebrow">Cart review</p>
                      <h2>
                        {selectedRecipe?.title ?? "Review your cart"}
                      </h2>
                      <p className="muted">
                        Confirm items and quantities before paying.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary ghost"
                      onClick={() => setPreferencesOpen(true)}
                    >
                      Preferences
                    </button>
                  </div>

                  {needsApproval ? (
                    <div className="warning-banner">
                      <strong>Needs approval</strong>
                      <span className="muted">
                        {proposedReplacementPlan
                          ? "Some items are unavailable."
                          : "The total changed since your last approval."}
                      </span>
                    </div>
                  ) : null}

                  <div className="preferences-summary">
                    <span>
                      Substitutions:{" "}
                      {currentPolicies.allowSubs ? "Allowed" : "Locked"}
                    </span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setPreferencesOpen(true)}
                    >
                      Change
                    </button>
                  </div>

                  <div className="review-layout">
                    <div className="review-main">
                      {proposedReplacementPlan ? (
                        <section className="approval-section">
                          <div className="approval-header">
                            <h3>Needs your approval</h3>
                            <p className="muted">
                              Review replacements or remove unavailable items.
                            </p>
                          </div>
                          <div className="approval-list">
                            {replacementItems.map((item) => (
                              <div
                                key={item.ingredientKey}
                                className="approval-item"
                              >
                                <div className="approval-info">
                                  <strong>
                                    {item.current?.title ??
                                      item.ingredientKey}
                                  </strong>
                                  <span className="muted">Unavailable</span>
                                  <span className="muted">
                                    Replacement:{" "}
                                    {item.proposed?.title ??
                                      "No replacement available"}
                                  </span>
                                </div>
                                <div className="approval-actions">
                                  <span className="price">
                                    {typeof item.deltaCents === "number"
                                      ? `${item.deltaCents >= 0 ? "+" : "-"}${formatMoney(
                                          Math.abs(item.deltaCents)
                                        )}`
                                      : "--"}
                                  </span>
                                  <button
                                    type="button"
                                    className="secondary"
                                    onClick={() =>
                                      handleAcceptReplacement(item)
                                    }
                                    disabled={
                                      !item.proposed ||
                                      checkoutStatus === "loading"
                                    }
                                  >
                                    Accept
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost"
                                    onClick={() =>
                                      handleRemoveLineItem({
                                        ingredientKey: item.ingredientKey,
                                        productId: item.current?.id,
                                      })
                                    }
                                    disabled={checkoutStatus === "loading"}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>
                      ) : null}

                      <section className="cart-list-section">
                        {proposedReplacementPlan ? (
                          remainingCartItems.length ? (
                            <details className="cart-collapsed">
                              <summary>
                                Rest of cart ({remainingCartItems.length} items)
                              </summary>
                              <div className="cart-list">
                                {remainingCartItems.map(renderLineItem)}
                              </div>
                            </details>
                          ) : null
                        ) : (
                          <div className="cart-list">
                            {cartDraftItems.map(renderLineItem)}
                          </div>
                        )}
                      </section>

                      <div className="review-totals">
                        <div className="total-row">
                          <span>Subtotal</span>
                          <span>{formatMoney(subtotalAmount)}</span>
                        </div>
                        <div className="total-row">
                          <span>Estimated tax</span>
                          <span>{formatMoney(taxAmount)}</span>
                        </div>
                        <div className="total-row total-grand">
                          <span>Total</span>
                          <span>{formatMoney(cartTotalAmount)}</span>
                        </div>
                        {totalVarianceCents > 0 ? (
                          <div className="variance-note">
                            Total may vary up to{" "}
                            {formatMoney(totalVarianceCents)}.
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <aside className="review-aside">
                      <div className="pickup-card">
                        <p className="eyebrow">Pickup</p>
                        <h4>{storeLabel}</h4>
                        {selectedStore?.address ? (
                          <p className="muted">{selectedStore.address}</p>
                        ) : null}
                        <label className="pickup-select">
                          <span className="muted">Time</span>
                          <select
                            value={selectedSlotId}
                            onChange={(event) =>
                              setSelectedSlotId(event.target.value)
                            }
                          >
                            {pickupSlots.map((slot) => (
                              <option
                                key={slot.id}
                                value={slot.id}
                                disabled={slot.status === "full"}
                              >
                                {slot.label}
                                {slot.status === "full" ? " (full)" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        {pickupSlotsStatus === "loading" ? (
                          <p className="muted">Loading pickup slots...</p>
                        ) : pickupSlotsStatus === "error" ? (
                          <p className="muted">
                            Pickup slots unavailable. Try again shortly.
                          </p>
                        ) : selectedSlot ? (
                          <p className="muted">
                            {selectedSlot.available ?? 0}/
                            {selectedSlot.capacity ?? 0} spots left.
                          </p>
                        ) : (
                          <p className="muted">
                            Reserve your pickup window before paying.
                          </p>
                        )}
                      </div>
                    </aside>
                  </div>
                </>
              ) : checkoutStatus === "loading" ? (
                <div className="review-loading">
                  <p className="muted">Building your cart...</p>
                </div>
              ) : (
                <div className="empty-state">
                  No cart draft yet. Add items and build a cart to continue.
                  <button type="button" onClick={openFeed}>
                    Back to feed
                  </button>
                </div>
              )}
            </section>
          ) : null}

          {mainView === VIEW_MODES.CHECKOUT ? (
            <section className="checkout-shell">
              {isOrderConfirmed ? (
                <div className="checkout-success">
                  <div className="success-badge">Order confirmed</div>
                  <h2>You're all set.</h2>
                  <p className="muted">
                    {pickupMessage ??
                      `Pickup at ${pickupTimeLabel} on ${
                        pickupDateLabel || "soon"
                      } at ${storeLabel}.`}
                  </p>
                  <button
                    type="button"
                    className="primary"
                    onClick={handleStartNewCart}
                  >
                    Build another cart
                  </button>
                </div>
              ) : (
                <div className="checkout-ready">
                  <div className="checkout-header">
                    <p className="eyebrow">Checkout</p>
                    <h2>Ready to pay</h2>
                    <p className="muted">
                      Review pickup details and approve payment.
                    </p>
                  </div>
                  <div className="checkout-layout">
                    <div className="checkout-summary">
                      <div className="review-totals">
                        <div className="total-row">
                          <span>Subtotal</span>
                          <span>{formatMoney(subtotalAmount)}</span>
                        </div>
                        <div className="total-row">
                          <span>Estimated tax</span>
                          <span>{formatMoney(taxAmount)}</span>
                        </div>
                        <div className="total-row total-grand">
                          <span>Total</span>
                          <span>{formatMoney(cartTotalAmount)}</span>
                        </div>
                        {totalVarianceCents > 0 ? (
                          <div className="variance-note">
                            Total may vary up to{" "}
                            {formatMoney(totalVarianceCents)}.
                          </div>
                        ) : null}
                      </div>
                      <p className="muted checkout-note">
                        Nothing is charged until you tap Pay.
                      </p>
                    </div>
                    <aside className="review-aside">
                      <div className="pickup-card">
                        <p className="eyebrow">Pickup</p>
                        <h4>{storeLabel}</h4>
                        {selectedStore?.address ? (
                          <p className="muted">{selectedStore.address}</p>
                        ) : null}
                        <label className="pickup-select">
                          <span className="muted">Time</span>
                          <select
                            value={selectedSlotId}
                            onChange={(event) =>
                              setSelectedSlotId(event.target.value)
                            }
                          >
                            {pickupSlots.map((slot) => (
                              <option
                                key={slot.id}
                                value={slot.id}
                                disabled={slot.status === "full"}
                              >
                                {slot.label}
                                {slot.status === "full" ? " (full)" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        {pickupSlotsStatus === "loading" ? (
                          <p className="muted">Loading pickup slots...</p>
                        ) : pickupSlotsStatus === "error" ? (
                          <p className="muted">
                            Pickup slots unavailable. Try again shortly.
                          </p>
                        ) : selectedSlot ? (
                          <p className="muted">
                            {selectedSlot.available ?? 0}/
                            {selectedSlot.capacity ?? 0} spots left.
                          </p>
                        ) : (
                          <p className="muted">
                            Reserve your pickup window before paying.
                          </p>
                        )}
                      </div>
                    </aside>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </main>

        <aside className={`cart-drawer ${panelOpen ? "open" : ""}`}>
          <button
            type="button"
            className="drawer-handle"
            onClick={handleCartToggle}
            aria-label="Toggle cart drawer"
          />
          <div className="cart-drawer-inner">
            {showCompactProgress ? (
              <div className="drawer-progress">
                {COMPACT_PROGRESS_STEPS.map((step, index) => (
                  <div
                    key={step.key}
                    className={`progress-step ${
                      index <= compactProgressIndex ? "active" : ""
                    }`}
                  >
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="drawer-summary">
              <div className="summary-row">
                <span>Items</span>
                <strong>{panelItemCount}</strong>
              </div>
              <div className="summary-row">
                <span>{hasCartDraft ? "Total" : "Est. total"}</span>
                <strong>
                  {panelItemCount ? formatMoney(panelTotal) : "--"}
                </strong>
              </div>
            </div>
            <div className="drawer-pickup">
              <span className="muted">Pickup</span>
              <strong>{storeLabel}</strong>
              <span className="muted">{pickupSummary}</span>
            </div>
            {approvalItemCount > 0 ? (
              <button
                type="button"
                className="drawer-badge"
                onClick={openReview}
              >
                {approvalItemCount} item
                {approvalItemCount === 1 ? "" : "s"} need
                {approvalItemCount === 1 ? "s" : ""} approval
              </button>
            ) : null}
            {drawerStatusLine ? (
              <div className="drawer-status">{drawerStatusLine}</div>
            ) : null}
            <div className="drawer-actions">
              <button
                type="button"
                className="primary"
                onClick={primaryAction.onClick ?? undefined}
                disabled={
                  primaryAction.disabled || !primaryAction.onClick
                }
              >
                {primaryAction.label}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {preferencesOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => setPreferencesOpen(false)}
        >
          <div
            className="modal-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Preferences</p>
                <h3>Substitution settings</h3>
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() => setPreferencesOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="modal-body">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={currentPolicies.allowSubs}
                  onChange={(event) =>
                    handlePolicyToggle("allowSubs", event.target.checked)
                  }
                />
                <span>Allow substitutions</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={currentPolicies.preferCheapest}
                  onChange={(event) =>
                    handlePolicyToggle("preferCheapest", event.target.checked)
                  }
                />
                <span>Prefer cheapest</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={currentPolicies.brandLock}
                  onChange={(event) =>
                    handlePolicyToggle("brandLock", event.target.checked)
                  }
                />
                <span>Brand locked</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={usePantry}
                  onChange={() => setUsePantry((prev) => !prev)}
                />
                <span>Use pantry staples</span>
              </label>
              <button
                type="button"
                className="link"
                onClick={() => setPantryOpen((prev) => !prev)}
              >
                {pantryOpen ? "Hide pantry list" : "Edit pantry list"}
              </button>
              {pantryOpen ? (
                <div className="pantry-list">
                  {PANTRY_ITEMS.map((item) => (
                    <label key={item.id} className="pantry-item">
                      <input
                        type="checkbox"
                        checked={pantrySet.has(item.id)}
                        onChange={() => togglePantry(item.id)}
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {debugEnabled ? (
        <div className="debug-overlay">
          <button
            type="button"
            className="debug-backdrop"
            onClick={() => setDebugEnabled(false)}
            aria-label="Close debug drawer"
          />
          <aside className="debug-panel">
            <div className="debug-header">
              <div>
                <p className="eyebrow">Debug</p>
                <h3>Developer tools</h3>
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() => setDebugEnabled(false)}
              >
                Close
              </button>
            </div>

            <div className="debug-actions">
              <button
                type="button"
                className="secondary"
                onClick={handleCheckout}
                disabled={!cartList.length || checkoutStatus === "loading"}
              >
                {checkoutStatus === "loading"
                  ? "Running agent..."
                  : "Run agent"}
              </button>
              <button
                type="button"
                className="secondary ghost"
                onClick={handleCopyRunDetails}
              >
                Copy run details
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setDebugOpen((prev) => !prev)}
              >
                {debugOpen ? "Hide scoring" : "Show scoring"}
              </button>
            </div>

            <div className="debug-section">
              <p className="eyebrow">State timeline</p>
              <p className="muted">{timelineSummary}</p>
              <div className="flow-timeline">
                {timelineSteps.map((step) => (
                  <div key={step.key} className={`flow-step ${step.status}`}>
                    <div className="flow-marker" />
                    <div>
                      <strong>{step.label}</strong>
                      {step.status === "active" ? (
                        <span className="muted">{step.description}</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="debug-block">
              <p className="eyebrow">Merchants</p>
              <textarea
                value={merchantInput}
                onChange={(event) => setMerchantInput(event.target.value)}
                rows={4}
              />
              <button
                type="button"
                className="secondary"
                onClick={saveMerchants}
              >
                Save merchants
              </button>
            </div>

            <div className="debug-block">
              <p className="eyebrow">Merchant comparison</p>
              {merchantSummaries.length ? (
                <div className="merchant-list">
                  {merchantSummaries.map((summary, index) => (
                    <div
                      key={summary.url}
                      className={
                        summary.url === selectedMerchant?.url
                          ? "merchant-row active"
                          : "merchant-row"
                      }
                    >
                      <div>
                        <strong>
                          {summary.storeProfile?.label ??
                            summary.storeProfile?.name ??
                            formatMerchantLabel(
                              summary.url,
                              index,
                              debugEnabled
                            )}
                        </strong>
                        <span className="muted">
                          {summary.handlers.length} handlers
                        </span>
                        {summary.riskScore !== null ? (
                          <span className="muted">
                            Risk {describeRisk(summary.riskScore).label}
                          </span>
                        ) : null}
                      </div>
                      <span>{formatMoney(summary.total)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No merchant results yet.</p>
              )}
            </div>

            <div className="debug-block">
              <p className="eyebrow">Simulation controls</p>
              <div className="sim-config-list">
                {merchantUrls.map((url, index) => {
                  const baseUrl = resolveMerchantBase(url);
                  const config = resolveSimConfig(baseUrl);
                  const summary = merchantSummaries.find(
                    (entry) => entry.url === url
                  );
                  const label =
                    summary?.storeProfile?.label ??
                    summary?.storeProfile?.name ??
                    formatMerchantLabel(url, index, debugEnabled);
                  return (
                    <div key={url} className="sim-config-row">
                      <div className="sim-config-title">
                        <strong>{label}</strong>
                        <span className="muted">{baseUrl}</span>
                      </div>
                      <div className="sim-config-controls">
                        <label>
                          <span className="muted">Volatility</span>
                          <select
                            value={config.volatility}
                            onChange={(event) =>
                              updateSimConfig(baseUrl, {
                                volatility: event.target.value,
                              })
                            }
                          >
                            {VOLATILITY_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span className="muted">Drift</span>
                          <select
                            value={config.driftMagnitude}
                            onChange={(event) =>
                              updateSimConfig(baseUrl, {
                                driftMagnitude: event.target.value,
                              })
                            }
                          >
                            {DRIFT_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span className="muted">Substitutions</span>
                          <select
                            value={config.substitutionAggressiveness}
                            onChange={(event) =>
                              updateSimConfig(baseUrl, {
                                substitutionAggressiveness:
                                  event.target.value,
                              })
                            }
                          >
                            {SUBSTITUTION_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="debug-section">
              <div className="debug-header">
                <div>
                  <p className="eyebrow">Ingredient scoring</p>
                  <h4>Match breakdown</h4>
                </div>
                <button
                  type="button"
                  className="secondary ghost"
                  onClick={() => setDebugOpen((prev) => !prev)}
                >
                  {debugOpen ? "Hide details" : "Show details"}
                </button>
              </div>
              {debugOpen ? (
                <div className="debug-list">
                  {cartDraftItems.map((line) => {
                    const canonical = line.canonicalIngredientJson ?? {};
                    const selected = line.primarySkuJson ?? {};
                    const breakdown = selected.scoreBreakdown ?? {};
                    const penalties = breakdown.penalties ?? {};
                    const activeAttributes = Object.entries(
                      canonical.attributes ?? {}
                    )
                      .filter(([, value]) => value)
                      .map(([key]) => key);
                    return (
                      <article key={line.id} className="debug-item">
                        <div className="debug-title">
                          <div>
                            <strong>
                              {canonical.canonicalName ||
                                canonical.originalText ||
                                line.ingredientKey}
                            </strong>
                            <span className="muted">
                              {canonical.form ? `${canonical.form} ` : ""}
                              {canonical.quantity ? `${canonical.quantity} ` : ""}
                              {canonical.unit ?? ""}
                            </span>
                            {canonical.categoryHint ? (
                              <span className="muted">
                                Category: {canonical.categoryHint}
                              </span>
                            ) : null}
                            {activeAttributes.length ? (
                              <span className="muted">
                                Attributes: {activeAttributes.join(", ")}
                              </span>
                            ) : null}
                          </div>
                          <span className="debug-score">
                            {typeof breakdown.totalScore === "number"
                              ? breakdown.totalScore.toFixed(2)
                              : "n/a"}
                          </span>
                        </div>
                        <div className="debug-selected">
                          <span>Selected SKU</span>
                          <strong>{selected.title ?? "Unresolved"}</strong>
                        </div>
                        <div className="debug-breakdown">
                          <div>
                            <span>Name match</span>
                            <span>
                              {typeof breakdown.nameMatch === "number"
                                ? breakdown.nameMatch.toFixed(2)
                                : "n/a"}
                            </span>
                          </div>
                          <div>
                            <span>Form match</span>
                            <span>
                              {typeof breakdown.formMatch === "number"
                                ? breakdown.formMatch.toFixed(2)
                                : "n/a"}
                            </span>
                          </div>
                          <div>
                            <span>Category match</span>
                            <span>
                              {typeof breakdown.categoryMatch === "number"
                                ? breakdown.categoryMatch.toFixed(2)
                                : "n/a"}
                            </span>
                          </div>
                          <div>
                            <span>Size match</span>
                            <span>
                              {typeof breakdown.sizeMatch === "number"
                                ? breakdown.sizeMatch.toFixed(2)
                                : "n/a"}
                            </span>
                          </div>
                          <div>
                            <span>Attribute match</span>
                            <span>
                              {typeof breakdown.attributeMatch === "number"
                                ? breakdown.attributeMatch.toFixed(2)
                                : "n/a"}
                            </span>
                          </div>
                          <div>
                            <span>Penalty</span>
                            <span>
                              {Object.values(penalties)
                                .reduce(
                                  (sum, value) =>
                                    sum +
                                    (typeof value === "number" ? value : 0),
                                  0
                                )
                                .toFixed(2)}
                            </span>
                          </div>
                        </div>
                        {line.alternatives?.length ? (
                          <div className="debug-alternatives">
                            <span className="muted">Top alternatives</span>
                            {line.alternatives.map((alt) => (
                              <div key={alt.id} className="debug-alt">
                                <span>
                                  {alt.skuJson?.title ?? "Alternative"}
                                </span>
                                <span>
                                  {typeof alt.scoreBreakdownJson?.totalScore ===
                                  "number"
                                    ? alt.scoreBreakdownJson.totalScore.toFixed(
                                        2
                                      )
                                    : "n/a"}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">
                  Toggle to inspect how each ingredient was parsed and scored.
                </p>
              )}
            </div>

            <div className="debug-block">
              <p className="eyebrow">Agent log</p>
              <div className="log-list">
                {agentLogs.length ? (
                  agentLogs.map((log) => (
                    <div key={log.id} className={`log-item ${log.tone}`}>
                      {log.message}
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    Trigger checkout to start the agent trace.
                  </div>
                )}
              </div>
            </div>

            <div className="debug-block">
              <p className="eyebrow">Run metrics</p>
              {agentRun ? (
                <div className="metric-list">
                  <div>
                    <span className="muted">Edits logged</span>
                    <strong>{runMetrics.editCount}</strong>
                  </div>
                  <div>
                    <span className="muted">Zero edits</span>
                    <strong>
                      {runMetrics.zeroEdits === null
                        ? "--"
                        : runMetrics.zeroEdits
                          ? "Yes"
                          : "No"}
                    </strong>
                  </div>
                  <div>
                    <span className="muted">Tap-to-approval</span>
                    <strong>
                      {formatDuration(runMetrics.tapToApprovalMs)}
                    </strong>
                  </div>
                  <div>
                    <span className="muted">Checkout success</span>
                    <strong>
                      {runMetrics.checkoutSuccess === null
                        ? "--"
                        : runMetrics.checkoutSuccess
                          ? "Yes"
                          : "No"}
                    </strong>
                  </div>
                </div>
              ) : (
                <p className="muted">Run the agent to generate metrics.</p>
              )}
            </div>

            <div className="debug-block">
              <p className="eyebrow">Learning summary</p>
              {metricsSummary ? (
                <div className="summary-list">
                  <p className="muted">
                    {metricsSummary.totalRuns ?? 0} runs |{" "}
                    {metricsSummary.totalEdits ?? 0} edits logged
                  </p>
                  <div className="summary-section">
                    <strong>Top edited ingredients</strong>
                    {metricsSummary.topIngredients?.length ? (
                      metricsSummary.topIngredients.map((item) => (
                        <div
                          key={`ingredient-${item.ingredientKey}`}
                          className="summary-row"
                        >
                          <span>{item.ingredientKey}</span>
                          <span>{item.count}</span>
                        </div>
                      ))
                    ) : (
                      <span className="muted">No edits yet.</span>
                    )}
                  </div>
                  <div className="summary-section">
                    <strong>Most rejected SKUs</strong>
                    {metricsSummary.topRejectedSkus?.length ? (
                      metricsSummary.topRejectedSkus.map((item) => (
                        <div
                          key={`sku-${item.skuId ?? item.title}`}
                          className="summary-row"
                        >
                          <span>{item.title}</span>
                          <span>{item.count}</span>
                        </div>
                      ))
                    ) : (
                      <span className="muted">No rejections yet.</span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="muted">Loading summary...</p>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {error ? (
        <div className="error-banner">
          <div>
            <span>{error}</span>
            {outOfStockLabel ? (
              <span className="muted">
                Out of stock: {outOfStockLabel}.
              </span>
            ) : null}
          </div>
          <div className="error-actions">
            {outOfStockContext ? (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  handleRemoveLineItem({
                    ingredientKey: null,
                    productId: outOfStockContext.itemId,
                  })
                }
              >
                Remove out-of-stock item
              </button>
            ) : null}
            <button
              type="button"
              className="secondary ghost"
              onClick={() => resetRunState({ keepCart: true })}
            >
              Reset session
            </button>
          </div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

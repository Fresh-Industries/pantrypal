export const normalizeText = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const tokenize = (text) => normalizeText(text).split(" ").filter(Boolean);

const FORM_KEYWORDS = [
  { form: "fresh", keywords: ["fresh"] },
  { form: "frozen", keywords: ["frozen"] },
  { form: "canned", keywords: ["canned", "tinned"] },
  { form: "ground", keywords: ["ground", "minced"] },
  { form: "shredded", keywords: ["shredded"] },
  { form: "grated", keywords: ["grated"] },
  { form: "diced", keywords: ["diced", "cubed"] },
  { form: "chopped", keywords: ["chopped"] },
  { form: "crushed", keywords: ["crushed"] },
  { form: "sliced", keywords: ["sliced"] },
  { form: "block", keywords: ["block", "brick"] },
];

const FORM_CONFLICTS = {
  fresh: ["canned", "frozen"],
  frozen: ["fresh"],
  canned: ["fresh"],
  shredded: ["block"],
  grated: ["block"],
  block: ["shredded", "grated"],
  ground: ["whole", "sliced"],
};

const PACKAGE_KEYWORDS = [
  "can",
  "jar",
  "bag",
  "box",
  "bottle",
  "bunch",
  "pack",
  "package",
  "carton",
  "tray",
  "tub",
];

const UNIT_SYNONYMS = {
  teaspoon: "tsp",
  teaspoons: "tsp",
  tsp: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tbsp: "tbsp",
  ounce: "oz",
  ounces: "oz",
  oz: "oz",
  pound: "lb",
  pounds: "lb",
  lb: "lb",
  lbs: "lb",
  gram: "g",
  grams: "g",
  g: "g",
  kilogram: "kg",
  kilograms: "kg",
  kg: "kg",
  milliliter: "ml",
  milliliters: "ml",
  ml: "ml",
  liter: "l",
  liters: "l",
  l: "l",
  cup: "cup",
  cups: "cup",
  clove: "clove",
  cloves: "clove",
  bunch: "bunch",
  bunches: "bunch",
  can: "can",
  cans: "can",
  jar: "jar",
  jars: "jar",
  bag: "bag",
  bags: "bag",
  box: "box",
  boxes: "box",
  bottle: "bottle",
  bottles: "bottle",
  pack: "pack",
  packs: "pack",
  package: "package",
  packages: "package",
  stick: "stick",
  sticks: "stick",
  piece: "piece",
  pieces: "piece",
};

const ATTRIBUTE_KEYWORDS = {
  organic: ["organic"],
  lowSodium: ["low sodium", "low-sodium", "no salt", "salt free"],
  glutenFree: ["gluten free", "gluten-free", "gf"],
  unsalted: ["unsalted"],
  dairyFree: ["dairy free", "lactose free"],
  vegan: ["vegan"],
  nonGmo: ["non gmo", "non-gmo"],
  sugarFree: ["sugar free", "no sugar"],
  wholeGrain: ["whole grain", "wholegrain"],
  reducedFat: ["reduced fat", "low fat", "low-fat"],
};

const CATEGORY_HINTS = [
  { category: "Dairy", keywords: ["milk", "cheese", "yogurt", "butter"] },
  {
    category: "Protein",
    keywords: ["beef", "chicken", "pork", "salmon", "shrimp", "bacon"],
  },
  {
    category: "Produce",
    keywords: [
      "tomato",
      "onion",
      "garlic",
      "avocado",
      "lime",
      "lemon",
      "pepper",
      "cucumber",
      "spinach",
      "lettuce",
    ],
  },
  { category: "Herbs", keywords: ["basil", "cilantro", "parsley", "mint"] },
  { category: "Pantry", keywords: ["pasta", "rice", "flour", "sugar", "oil"] },
  { category: "Spices", keywords: ["seasoning", "pepper", "salt"] },
  { category: "Bakery", keywords: ["bread", "tortilla", "bun"] },
];

const SYNONYM_PHRASES = [
  { pattern: "scallion", replacement: "green onion" },
  { pattern: "scallions", replacement: "green onion" },
  { pattern: "spring onion", replacement: "green onion" },
  { pattern: "green onions", replacement: "green onion" },
  { pattern: "coriander leaves", replacement: "cilantro" },
  { pattern: "coriander", replacement: "cilantro" },
  { pattern: "garbanzo", replacement: "chickpeas" },
  { pattern: "capsicum", replacement: "bell pepper" },
  { pattern: "aubergine", replacement: "eggplant" },
  { pattern: "courgette", replacement: "zucchini" },
  { pattern: "rocket", replacement: "arugula" },
];

const STOPWORDS = new Set([
  "of",
  "and",
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "fresh",
  "frozen",
  "canned",
  "diced",
  "chopped",
  "shredded",
  "grated",
  "crushed",
  "ground",
  "minced",
  "sliced",
  "can",
  "jar",
  "bag",
  "box",
  "bottle",
  "bunch",
  "pack",
  "package",
  "carton",
]);

const applySynonyms = (text) => {
  let updated = ` ${text} `;
  SYNONYM_PHRASES.forEach(({ pattern, replacement }) => {
    const regex = new RegExp(`\\b${pattern}\\b`, "g");
    updated = updated.replace(regex, replacement);
  });
  return updated.trim();
};

const parseFraction = (value) => {
  if (!value) {
    return null;
  }
  const text = value.trim();
  if (text.includes("/")) {
    const parts = text.split(" ");
    if (parts.length === 2 && parts[1].includes("/")) {
      const whole = Number.parseFloat(parts[0]);
      const [num, den] = parts[1].split("/").map(Number);
      if (!Number.isNaN(whole) && den) {
        return whole + num / den;
      }
    }
    const [num, den] = text.split("/").map(Number);
    if (den) {
      return num / den;
    }
  }
  const parsed = Number.parseFloat(text);
  return Number.isNaN(parsed) ? null : parsed;
};

const extractQuantityAndUnit = (text) => {
  const regex =
    /(?:^|\b)(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*([a-zA-Z]+)?/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const quantity = parseFraction(match[1]);
    const unitRaw = match[2]?.toLowerCase() ?? "";
    const unit = UNIT_SYNONYMS[unitRaw] ?? null;
    if (quantity && unit) {
      return { quantity, unit, rawUnit: unitRaw };
    }
    if (quantity && !unit) {
      return { quantity, unit: "count", rawUnit: null };
    }
  }
  return { quantity: null, unit: null, rawUnit: null };
};

const detectForms = (text) => {
  const forms = [];
  FORM_KEYWORDS.forEach(({ form, keywords }) => {
    if (keywords.some((word) => text.includes(word))) {
      forms.push(form);
    }
  });
  return forms;
};

const detectPackageType = (text, unit) => {
  if (unit && PACKAGE_KEYWORDS.includes(unit)) {
    return unit;
  }
  const match = PACKAGE_KEYWORDS.find((keyword) => text.includes(keyword));
  return match ?? null;
};

const detectAttributes = (text) => {
  const attributes = {};
  Object.entries(ATTRIBUTE_KEYWORDS).forEach(([key, phrases]) => {
    attributes[key] = phrases.some((phrase) => text.includes(phrase));
  });
  return attributes;
};

const inferCategory = (text) => {
  for (const entry of CATEGORY_HINTS) {
    if (entry.keywords.some((keyword) => text.includes(keyword))) {
      return entry.category;
    }
  }
  return null;
};

const stripNoiseTokens = (tokens, attributeTokens) =>
  tokens.filter(
    (token) =>
      !/^\d/.test(token) &&
      !STOPWORDS.has(token) &&
      !UNIT_SYNONYMS[token] &&
      !PACKAGE_KEYWORDS.includes(token) &&
      !(attributeTokens && attributeTokens.has(token))
  );

export const parseCanonicalIngredient = (ingredient) => {
  const originalText = ingredient.query ?? ingredient.name ?? "";
  const normalized = applySynonyms(normalizeText(originalText));
  const quantityInfo = extractQuantityAndUnit(normalized);
  const forms = detectForms(normalized);
  const packageType = detectPackageType(normalized, quantityInfo.unit);
  const attributes = detectAttributes(normalized);
  const attributeTokens = new Set();
  Object.entries(attributes).forEach(([key, enabled]) => {
    if (!enabled) {
      return;
    }
    ATTRIBUTE_KEYWORDS[key]?.forEach((phrase) => {
      phrase.split(" ").forEach((token) => attributeTokens.add(token));
    });
  });
  const categoryHint = inferCategory(normalized);
  const tokens = stripNoiseTokens(tokenize(normalized), attributeTokens);
  const canonicalName =
    tokens.join(" ") ||
    normalizeText(ingredient.name ?? ingredient.key ?? originalText);

  return {
    originalText,
    canonicalName: canonicalName.trim(),
    form: forms[0] ?? null,
    quantity: quantityInfo.quantity ?? ingredient.quantity ?? null,
    unit: quantityInfo.unit ?? (ingredient.quantity ? "count" : null),
    packageType,
    categoryHint,
    attributes,
  };
};

const normalizeSize = (quantity, unit) => {
  if (!quantity || !unit) {
    return null;
  }
  const unitLower = unit.toLowerCase();
  const weightUnits = {
    g: 1,
    kg: 1000,
    oz: 28.3495,
    lb: 453.592,
  };
  const volumeUnits = {
    ml: 1,
    l: 1000,
    cup: 240,
    tbsp: 15,
    tsp: 5,
  };
  if (weightUnits[unitLower]) {
    return { unitType: "weight", value: quantity * weightUnits[unitLower] };
  }
  if (volumeUnits[unitLower]) {
    return { unitType: "volume", value: quantity * volumeUnits[unitLower] };
  }
  return { unitType: "count", value: quantity };
};

const analyzeProduct = (product) => {
  const text = applySynonyms(normalizeText(product.title ?? ""));
  const quantityInfo = extractQuantityAndUnit(text);
  return {
    text,
    tokens: tokenize(text),
    forms: detectForms(text),
    packageType: detectPackageType(text, quantityInfo.unit),
    attributes: detectAttributes(text),
    category: inferCategory(text),
    size: normalizeSize(quantityInfo.quantity, quantityInfo.unit),
  };
};

const computeNameScore = (canonicalName, productTokens, productText) => {
  if (!canonicalName) {
    return 0;
  }
  const nameTokens = tokenize(canonicalName);
  if (!nameTokens.length) {
    return 0;
  }
  const union = new Set([...nameTokens, ...productTokens]);
  const shared = nameTokens.filter((token) => productTokens.includes(token));
  let score = union.size ? shared.length / union.size : 0;
  const canonicalText = normalizeText(canonicalName);
  if (productText.includes(canonicalText)) {
    score += 0.35;
  }
  if (canonicalText.includes(productText)) {
    score += 0.15;
  }
  return Math.min(score, 1);
};

const scoreCandidate = (canonical, product) => {
  const analysis = analyzeProduct(product);
  const nameScore = computeNameScore(
    canonical.canonicalName,
    analysis.tokens,
    analysis.text
  );

  let formScore = 0.5;
  let formPenalty = 0;
  if (canonical.form) {
    if (analysis.forms.includes(canonical.form)) {
      formScore = 1;
    } else if (!analysis.forms.length) {
      formScore = 0.5;
    } else {
      formScore = 0;
    }
    const conflicts = FORM_CONFLICTS[canonical.form] ?? [];
    if (conflicts.some((conflict) => analysis.forms.includes(conflict))) {
      formPenalty = 0.2;
    }
  }

  let categoryScore = 0.5;
  if (canonical.categoryHint) {
    if (!analysis.category) {
      categoryScore = 0.5;
    } else if (analysis.category === canonical.categoryHint) {
      categoryScore = 1;
    } else {
      categoryScore = 0;
    }
  }

  let sizeScore = 0.5;
  const canonicalSize = normalizeSize(canonical.quantity, canonical.unit);
  if (canonicalSize && analysis.size) {
    if (canonicalSize.unitType === analysis.size.unitType) {
      const diff = Math.abs(analysis.size.value - canonicalSize.value);
      const ratio = diff / canonicalSize.value;
      sizeScore = ratio <= 0.2 ? 1 : ratio <= 0.5 ? 0.5 : 0;
    } else {
      sizeScore = 0.2;
    }
  }

  const requestedAttributes = Object.entries(canonical.attributes || {}).filter(
    ([, value]) => value
  );
  let attributeScore = requestedAttributes.length ? 0 : 0.6;
  if (requestedAttributes.length) {
    const matched = requestedAttributes.filter(
      ([key]) => analysis.attributes?.[key]
    );
    attributeScore = matched.length / requestedAttributes.length;
  }

  let mismatchPenalty = formPenalty;
  if (product.inventory_quantity === 0) {
    mismatchPenalty += 0.25;
  }

  const total =
    nameScore * 0.45 +
    formScore * 0.15 +
    categoryScore * 0.15 +
    sizeScore * 0.1 +
    attributeScore * 0.15 -
    mismatchPenalty;
  const clampedTotal = Math.max(0, Math.min(1, total));

  const scoreBreakdown = {
    nameMatch: nameScore,
    formMatch: formScore,
    categoryMatch: categoryScore,
    sizeMatch: sizeScore,
    attributeMatch: attributeScore,
    penalties: {
      formMismatch: formPenalty,
      inventoryPenalty: product.inventory_quantity === 0 ? 0.25 : 0,
    },
    totalScore: clampedTotal,
    canonical: {
      name: canonical.canonicalName,
      form: canonical.form,
      categoryHint: canonical.categoryHint,
      quantity: canonical.quantity,
      unit: canonical.unit,
      attributes: canonical.attributes,
    },
    productSignals: {
      forms: analysis.forms,
      category: analysis.category,
      size: analysis.size,
      packageType: analysis.packageType,
      attributes: analysis.attributes,
    },
  };

  let chosenReason = "best_overall_score";
  if (mismatchPenalty > 0) {
    chosenReason = "best_available_with_penalties";
  } else if (nameScore > 0.7 && attributeScore >= 0.8) {
    chosenReason = "strong_name_attribute_match";
  }

  return {
    score: clampedTotal,
    confidence: clampedTotal,
    chosenReason,
    scoreBreakdown,
  };
};

export const rankProducts = (canonical, products) =>
  products
    .map((product) => {
      const scored = scoreCandidate(canonical, product);
      return { product, ...scored };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.product.id.localeCompare(b.product.id);
    });

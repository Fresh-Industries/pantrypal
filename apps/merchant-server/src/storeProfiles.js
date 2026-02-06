const SUBSTITUTION_GROUPS = [
  {
    id: "dairy",
    items: ["milk", "greek_yogurt", "butter", "cheddar", "parmesan", "feta"],
  },
  {
    id: "protein",
    items: ["eggs", "bacon", "ground_beef", "chicken_breast", "salmon", "shrimp"],
  },
  {
    id: "produce",
    items: [
      "avocado",
      "tomato",
      "onion",
      "lime",
      "jalapeno",
      "cilantro",
      "lettuce",
      "cucumber",
      "lemon",
      "basil",
      "bell_pepper",
      "mushrooms",
      "spinach",
      "garlic",
      "ginger",
      "strawberries",
    ],
  },
  {
    id: "grains",
    items: ["pasta", "rice", "tortillas", "bread", "flour", "oats", "quinoa"],
  },
  {
    id: "pantry",
    items: [
      "black_beans",
      "chickpeas",
      "olive_oil",
      "soy_sauce",
      "honey",
      "salt",
      "sugar",
      "taco_seasoning",
    ],
  },
];

const buildSubstitutionGraph = (groups) => {
  const graph = {};
  groups.forEach((group) => {
    group.items.forEach((item) => {
      graph[item] = group.items.filter((id) => id !== item);
    });
  });
  return graph;
};

const COMMON_SUBSTITUTION_GRAPH = buildSubstitutionGraph(SUBSTITUTION_GROUPS);

export const STORE_PROFILES = {
  bigbox: {
    id: "bigbox_pickup",
    name: "BigBoxPickup",
    label: "BigBox Pickup",
    address: "2000 Mission St, San Francisco",
    timezone: "America/Los_Angeles",
    priceMultiplier: 0.97,
    taxRate: 0.086,
    fees: {
      serviceFeeCents: 249,
      pickupFeeCents: 0,
    },
    lowStockThreshold: 6,
    pickup: {
      daysOut: 3,
      slotMinutes: 90,
      holdMinutes: 12,
      capacity: 10,
      times: ["10:00", "13:30", "18:00"],
    },
    defaults: {
      volatility: "medium",
      driftMagnitude: "medium",
      substitutionAggressiveness: "balanced",
    },
    substitutionGraph: COMMON_SUBSTITUTION_GRAPH,
  },
  local: {
    id: "local_grocer",
    name: "LocalGrocer",
    label: "Local Grocer",
    address: "312 Valencia St, San Francisco",
    timezone: "America/Los_Angeles",
    priceMultiplier: 1.04,
    taxRate: 0.092,
    fees: {
      serviceFeeCents: 149,
      pickupFeeCents: 199,
    },
    lowStockThreshold: 4,
    pickup: {
      daysOut: 2,
      slotMinutes: 75,
      holdMinutes: 9,
      capacity: 5,
      times: ["09:30", "12:00", "17:30"],
    },
    defaults: {
      volatility: "high",
      driftMagnitude: "medium",
      substitutionAggressiveness: "conservative",
    },
    substitutionGraph: COMMON_SUBSTITUTION_GRAPH,
  },
};

export const DEFAULT_STORE_PROFILE_ID = "bigbox";

export const resolveStoreProfile = (profileId) => {
  if (!profileId) {
    return STORE_PROFILES[DEFAULT_STORE_PROFILE_ID];
  }
  const normalized = profileId.toLowerCase();
  if (STORE_PROFILES[normalized]) {
    return STORE_PROFILES[normalized];
  }
  const simplified = normalized.replace(/[^a-z0-9]/g, "");
  const match = Object.values(STORE_PROFILES).find((profile) => {
    const idKey = profile.id.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nameKey = profile.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const labelKey = profile.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    return idKey === simplified || nameKey === simplified || labelKey === simplified;
  });
  return match ?? STORE_PROFILES[DEFAULT_STORE_PROFILE_ID];
};

export const listStoreProfiles = () => Object.values(STORE_PROFILES);

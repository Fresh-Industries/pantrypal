import { INGREDIENTS } from "../src/data/ingredients.js";
import { RECIPES } from "../src/data/recipes.js";
import {
  normalizeText,
  parseCanonicalIngredient,
  rankProducts,
} from "../src/lib/ingredientMatcher.js";

const DEFAULT_PRODUCTS_URL = "http://localhost:8182/products";

const tokenize = (text) => normalizeText(text).split(" ").filter(Boolean);

const scoreProductBaseline = (query, product) => {
  const queryText = normalizeText(query);
  const productText = normalizeText(product.title || "");
  if (!queryText || !productText) {
    return 0;
  }
  const queryTokens = tokenize(queryText);
  const productTokens = tokenize(productText);
  const union = new Set([...queryTokens, ...productTokens]);
  const shared = queryTokens.filter((token) => productTokens.includes(token));
  let score = union.size ? shared.length / union.size : 0;

  if (productText.includes(queryText)) {
    score += 0.6;
  }
  if (queryText.includes(productText)) {
    score += 0.4;
  }
  score += shared.length * 0.05;

  if (product.inventory_quantity === 0) {
    score -= 0.3;
  }
  return score;
};

const rankProductsBaseline = (query, products) =>
  products
    .map((product) => ({
      product,
      score: scoreProductBaseline(query, product),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.product.id.localeCompare(b.product.id);
    });

const toLocalProducts = () =>
  INGREDIENTS.map((item) => ({
    id: item.id,
    title: item.name,
    price: item.price,
    image_url: item.image,
    inventory_quantity: 100,
  }));

const loadProducts = async () => {
  const target = process.env.UCP_PRODUCTS_URL || DEFAULT_PRODUCTS_URL;
  if (typeof fetch !== "function") {
    return { products: toLocalProducts(), source: "local" };
  }
  try {
    const response = await fetch(target);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return { products: data?.products ?? [], source: target };
  } catch (err) {
    return { products: toLocalProducts(), source: "local" };
  }
};

const formatPercent = (value) =>
  `${(value * 100).toFixed(1).replace(/\\.0$/, "")}%`;

const evaluate = async () => {
  const { products, source } = await loadProducts();
  if (!products.length) {
    console.error("No products available for evaluation.");
    process.exit(1);
  }

  let ingredientTotal = 0;
  let ingredientMatchBaseline = 0;
  let ingredientMatchNew = 0;
  let recipeTotal = 0;
  let recipePerfectBaseline = 0;
  let recipePerfectNew = 0;

  RECIPES.forEach((recipe) => {
    recipeTotal += 1;
    let recipeBaselineOk = true;
    let recipeNewOk = true;

    recipe.ingredients.forEach((ingredient) => {
      ingredientTotal += 1;
      const expectedId = ingredient.expectedId || ingredient.key;

      const baselineRanked = rankProductsBaseline(
        ingredient.query || ingredient.name || ingredient.key || "",
        products
      );
      const baselineTop = baselineRanked[0]?.product?.id ?? null;
      if (baselineTop === expectedId) {
        ingredientMatchBaseline += 1;
      } else {
        recipeBaselineOk = false;
      }

      const canonical = parseCanonicalIngredient(ingredient);
      const ranked = rankProducts(canonical, products);
      const selected = ranked[0]?.product?.id ?? null;
      if (selected === expectedId) {
        ingredientMatchNew += 1;
      } else {
        recipeNewOk = false;
      }
    });

    if (recipeBaselineOk) {
      recipePerfectBaseline += 1;
    }
    if (recipeNewOk) {
      recipePerfectNew += 1;
    }
  });

  console.log(`Product source: ${source}`);
  console.log(`Recipes evaluated: ${recipeTotal}`);
  console.log(
    `Zero-edit cart rate (baseline): ${recipePerfectBaseline}/${recipeTotal} (${formatPercent(
      recipePerfectBaseline / recipeTotal
    )})`
  );
  console.log(
    `Zero-edit cart rate (new): ${recipePerfectNew}/${recipeTotal} (${formatPercent(
      recipePerfectNew / recipeTotal
    )})`
  );
  console.log(
    `Ingredient match rate (baseline): ${ingredientMatchBaseline}/${ingredientTotal} (${formatPercent(
      ingredientMatchBaseline / ingredientTotal
    )})`
  );
  console.log(
    `Ingredient match rate (new): ${ingredientMatchNew}/${ingredientTotal} (${formatPercent(
      ingredientMatchNew / ingredientTotal
    )})`
  );
};

evaluate();

# AGENT

## Purpose
This repo is a monorepo for the Dish Feed prototype:
- `apps/dish-feed-frontend`: Vite + React UI for recipe-driven grocery carts.
- `apps/merchant-server`: Node.js (Express) merchant server backed by SQLite.
- `legacy/` and `packages/ucp-sdk-python`: legacy Python reference server/SDK.
- `samples/`: sample clients and A2A demos.

## Key files
- Frontend entry: `apps/dish-feed-frontend/src/App.jsx`
- Frontend data: `apps/dish-feed-frontend/src/data/ingredients.js`, `apps/dish-feed-frontend/src/data/recipes.js`
- Matching logic: `apps/dish-feed-frontend/src/lib/ingredientMatcher.js`
- Merchant server entry: `apps/merchant-server/src/server.js`
- Merchant DB helpers: `apps/merchant-server/src/db.js`
- Seed script: `apps/merchant-server/scripts/import_grocery.mjs`
- Discovery profile: `apps/merchant-server/data/discovery_profile.json`

## Common commands (run from repo root)
- `npm --workspace apps/merchant-server run import:grocery -- --products_db_path=/tmp/ucp_test/products.db`
- `npm --workspace apps/merchant-server run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db --port=8182`
- `npm --workspace apps/merchant-server run dev:bigbox -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db`
- `npm --workspace apps/merchant-server run dev:local -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db`
- `npm --workspace apps/dish-feed-frontend run dev`
- `npm run eval:zero-edit`

## Runtime expectations and configuration
- Frontend uses `/api` as the default base; Vite proxies `/api` to `http://localhost:8182`.
- Override the frontend API base with `VITE_UCP_BASE_URL`.
- Merchant server CLI/ENV: `PRODUCTS_DB_PATH`, `TRANSACTIONS_DB_PATH`, `PORT`.
- Store profile selection: `UCP_STORE_PROFILE` (`bigbox` or `local`).
- StoreOps simulation headers:
  `x-storeops-config` (JSON with `volatility`, `driftMagnitude`, `substitutionAggressiveness`),
  `x-agent-run-id` (deterministic seed), and `x-price-stage` (`quote` or `checkout`).

## Testing and evaluation
- No JS test runner is configured.
- `npm run eval:zero-edit` evaluates ingredient matching against `/products`
  (falls back to local data when the API is unavailable).

## Change notes
- Keep UCP request headers (`UCP-Agent`, `request-id`, `idempotency-key`) aligned
  between the frontend and the merchant server when changing checkout flows.
- `ingredientMatcher.js` is shared by the UI and the eval script; update both
  behavior and metrics together.
- StoreOps endpoints live on the merchant server:
  `/store-ops/profile`, `/store-ops/substitutions`, `/store-ops/pickup-slots`.

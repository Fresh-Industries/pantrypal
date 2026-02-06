# Dish Feed Merchant Server (Node.js)

This is the Node.js version of the UCP Merchant Server used by the Dish Feed frontend.

## Install

```bash
cd apps/merchant-server
npm install
```

## Seed the grocery catalog

```bash
npm run import:grocery -- --products_db_path=/tmp/ucp_test/products.db
```

## Run the server

```bash
npm run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db --port=8182
```

## Run BigBoxPickup and LocalGrocer

Launch two store profiles on different ports:

```bash
UCP_STORE_PROFILE=bigbox PORT=8182 npm run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db
UCP_STORE_PROFILE=local PORT=8282 npm run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db
```

Notes:
- The server expects the required UCP headers on checkout endpoints.
- `/.well-known/ucp` returns the discovery manifest used by Dish Feed.
- `/products` returns the catalog with inventory quantities.
- `/.well-known/agent-card.json` and `/agent/messages` power the Dish Feed chat helper.
- Store ops endpoints: `/store-ops/profile`, `/store-ops/substitutions`, `/store-ops/pickup-slots`.

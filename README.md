# UCP Prototype Monorepo

## Layout

- `apps/merchant-server`: Node.js merchant server (Express + SQLite)
- `apps/dish-feed-frontend`: Dish Feed frontend (Vite + React)
- `legacy/merchant-server-python`: Legacy FastAPI merchant server (optional)
- `packages/ucp-sdk-python`: Legacy Python SDK (optional)

## Run the merchant server (Node.js)

```bash
npm --workspace apps/merchant-server run import:grocery -- --products_db_path=/tmp/ucp_test/products.db
npm --workspace apps/merchant-server run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db --port=8182
```

Run multiple store profiles (optional):

```bash
UCP_STORE_PROFILE=bigbox PORT=8182 npm --workspace apps/merchant-server run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db
UCP_STORE_PROFILE=local PORT=8282 npm --workspace apps/merchant-server run dev -- --products_db_path=/tmp/ucp_test/products.db --transactions_db_path=/tmp/ucp_test/transactions.db
```

## Run the frontend

```bash
npm --workspace apps/dish-feed-frontend run dev
```

## Evaluate zero-edit cart rate

```bash
npm run eval:zero-edit
```

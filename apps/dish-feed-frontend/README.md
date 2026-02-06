# Dish Feed Frontend Prototype

Quick start:

```bash
cd apps/dish-feed-frontend
npm install
npm run dev
```

Notes:
- The Vite dev server proxies `/api` to `http://localhost:8182` to avoid CORS.
- Add multiple merchant URLs in the UI (one per line) to compare totals.
- The frontend expects a `/products` endpoint on each merchant for catalog mapping.
- To override the base URL, set `VITE_UCP_BASE_URL` (for example, `http://localhost:8182`).
- Start the Node merchant servers in `apps/merchant-server` before running the UI.
- For the multi-merchant demo, run BigBoxPickup on `:8182` and LocalGrocer on `:8282`.

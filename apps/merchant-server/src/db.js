import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseJson, serializeJson, nowIso } from "./utils.js";

export const DEFAULT_INVENTORY_QUANTITY = 100;

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const ensureProductsSchema = (db) => {
  db.exec(
    `
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      title TEXT,
      price INTEGER,
      image_url TEXT,
      inventory_quantity INTEGER
    )
    `
  );

  const columns = db
    .prepare("PRAGMA table_info(products)")
    .all()
    .map((row) => row.name);
  if (!columns.includes("image_url")) {
    db.exec("ALTER TABLE products ADD COLUMN image_url TEXT");
  }
  if (!columns.includes("inventory_quantity")) {
    db.exec("ALTER TABLE products ADD COLUMN inventory_quantity INTEGER");
  }
};

const ensureColumn = (db, table, column, type) => {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
};

const ensureTransactionsSchema = (db) => {
  db.exec(
    `
    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY,
      status TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT PRIMARY KEY,
      request_hash TEXT,
      response_status INTEGER,
      response_body TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS inventory (
      product_id TEXT PRIMARY KEY,
      quantity INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      device_id TEXT,
      recipe_id TEXT,
      merchant_base_url TEXT,
      store_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      state TEXT,
      failure_code TEXT,
      failure_detail TEXT,
      cart_draft_id TEXT,
      order_id TEXT,
      zero_edits INTEGER,
      tap_to_approval_ms INTEGER,
      checkout_success INTEGER,
      edit_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_run_step_logs (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT,
      step_name TEXT,
      request_id TEXT,
      idempotency_key TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      success INTEGER,
      error_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS cart_drafts (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT,
      recipe_id TEXT,
      servings INTEGER,
      pantry_items_removed TEXT,
      policies TEXT,
      quote_summary TEXT,
      checkout_session_id TEXT,
      cart_hash TEXT,
      quote_hash TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cart_draft_line_items (
      id TEXT PRIMARY KEY,
      cart_draft_id TEXT,
      ingredient_key TEXT,
      canonical_ingredient_json TEXT,
      primary_sku_json TEXT,
      quantity REAL,
      unit TEXT,
      confidence REAL,
      chosen_reason TEXT,
      substitution_policy_json TEXT,
      line_total_cents INTEGER
    );
    CREATE TABLE IF NOT EXISTS cart_draft_alternatives (
      id TEXT PRIMARY KEY,
      line_item_id TEXT,
      rank INTEGER,
      sku_json TEXT,
      score_breakdown_json TEXT,
      reason TEXT,
      confidence REAL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT,
      cart_hash TEXT,
      quote_hash TEXT,
      approved_total_cents INTEGER,
      approved_at TEXT,
      signature_mock TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS user_edit_events (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT,
      ingredient_key TEXT,
      action_type TEXT,
      from_sku_json TEXT,
      to_sku_json TEXT,
      timestamp TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS pickup_reservations (
      id TEXT PRIMARY KEY,
      slot_id TEXT,
      agent_run_id TEXT,
      checkout_id TEXT,
      order_id TEXT,
      status TEXT,
      reserved_at TEXT,
      expires_at TEXT,
      confirmed_at TEXT
    );
    `
  );

  ensureColumn(db, "cart_draft_line_items", "estimated_pricing", "INTEGER");
  ensureColumn(db, "cart_draft_line_items", "quantity_range_json", "TEXT");
  ensureColumn(db, "cart_draft_line_items", "max_variance_cents", "INTEGER");
  ensureColumn(db, "agent_runs", "zero_edits", "INTEGER");
  ensureColumn(db, "agent_runs", "tap_to_approval_ms", "INTEGER");
  ensureColumn(db, "agent_runs", "checkout_success", "INTEGER");
  ensureColumn(db, "agent_runs", "edit_count", "INTEGER");

  db.exec(
    `
    CREATE INDEX IF NOT EXISTS idx_user_edit_events_agent_run
      ON user_edit_events(agent_run_id);
    CREATE INDEX IF NOT EXISTS idx_user_edit_events_action
      ON user_edit_events(action_type);
    CREATE INDEX IF NOT EXISTS idx_user_edit_events_ingredient
      ON user_edit_events(ingredient_key);
    CREATE INDEX IF NOT EXISTS idx_pickup_reservations_slot
      ON pickup_reservations(slot_id);
    CREATE INDEX IF NOT EXISTS idx_pickup_reservations_checkout
      ON pickup_reservations(checkout_id);
    `
  );
};

export const createDatabases = ({ productsDbPath, transactionsDbPath }) => {
  ensureDir(productsDbPath);
  ensureDir(transactionsDbPath);

  const productsDb = new Database(productsDbPath);
  const transactionsDb = new Database(transactionsDbPath);

  productsDb.pragma("journal_mode = WAL");
  transactionsDb.pragma("journal_mode = WAL");
  productsDb.pragma("foreign_keys = ON");
  transactionsDb.pragma("foreign_keys = ON");

  ensureProductsSchema(productsDb);
  ensureTransactionsSchema(transactionsDb);

  return { productsDb, transactionsDb };
};

export const listProducts = (db) =>
  db
    .prepare(
      "SELECT id, title, price, image_url, inventory_quantity FROM products"
    )
    .all();

export const getProduct = (db, productId) =>
  db
    .prepare(
      "SELECT id, title, price, image_url, inventory_quantity FROM products WHERE id = ?"
    )
    .get(productId);

export const getProductInventoryQuantity = (db, productId) => {
  const row = db
    .prepare("SELECT inventory_quantity FROM products WHERE id = ?")
    .get(productId);
  return row?.inventory_quantity ?? null;
};

export const getInventory = (db, productId) => {
  const row = db
    .prepare("SELECT quantity FROM inventory WHERE product_id = ?")
    .get(productId);
  return row?.quantity ?? null;
};

export const setInventory = (db, productId, quantity) => {
  db
    .prepare(
      `
      INSERT INTO inventory (product_id, quantity)
      VALUES (?, ?)
      ON CONFLICT(product_id) DO UPDATE SET quantity = excluded.quantity
      `
    )
    .run(productId, quantity);
};

export const getCheckout = (db, checkoutId) => {
  const row = db.prepare("SELECT data FROM checkouts WHERE id = ?").get(checkoutId);
  return row ? parseJson(row.data) : null;
};

export const saveCheckout = (db, checkoutId, status, data) => {
  db
    .prepare(
      `
      INSERT INTO checkouts (id, status, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data
      `
    )
    .run(checkoutId, status, serializeJson(data));
};

export const getOrder = (db, orderId) => {
  const row = db.prepare("SELECT data FROM orders WHERE id = ?").get(orderId);
  return row ? parseJson(row.data) : null;
};

export const saveOrder = (db, orderId, data) => {
  db
    .prepare(
      `
      INSERT INTO orders (id, data)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
      `
    )
    .run(orderId, serializeJson(data));
};

export const getIdempotencyRecord = (db, key) => {
  const row = db
    .prepare(
      "SELECT key, request_hash, response_status, response_body FROM idempotency_records WHERE key = ?"
    )
    .get(key);
  if (!row) {
    return null;
  }
  return {
    key: row.key,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: parseJson(row.response_body),
  };
};

export const saveIdempotencyRecord = (db, key, requestHash, status, body) => {
  db
    .prepare(
      `
      INSERT INTO idempotency_records (key, request_hash, response_status, response_body, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        request_hash = excluded.request_hash,
        response_status = excluded.response_status,
        response_body = excluded.response_body,
        created_at = excluded.created_at
      `
    )
    .run(key, requestHash, status, serializeJson(body), nowIso());
};

export const getLatestApproval = (db, { agentRunId, cartHash } = {}) => {
  if (!agentRunId && !cartHash) {
    return null;
  }
  const clauses = [];
  const params = [];
  if (agentRunId) {
    clauses.push("agent_run_id = ?");
    params.push(agentRunId);
  }
  if (cartHash) {
    clauses.push("cart_hash = ?");
    params.push(cartHash);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db
    .prepare(
      `SELECT * FROM approvals ${where} ORDER BY approved_at DESC LIMIT 1`
    )
    .get(...params);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    cartHash: row.cart_hash,
    quoteHash: row.quote_hash,
    approvedTotalCents: row.approved_total_cents,
    approvedAt: row.approved_at,
    signatureMock: row.signature_mock,
    status: row.status,
  };
};

-- Capella Coffee order management (Cloudflare D1)
-- Run once on a newly created D1 database.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('stripe','manual')),
  customer_name TEXT,
  customer_email TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','cancelled','refunded')),
  fulfillment_status TEXT NOT NULL DEFAULT 'pending' CHECK (fulfillment_status IN ('pending','roasted','packed','shipped','picked_up')),
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('shipping','pickup')),
  shipping_address_json TEXT,
  special_request TEXT,
  notes TEXT,
  roast_window_date TEXT NOT NULL, -- Friday date, YYYY-MM-DD, America/Los_Angeles
  amount_total_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  bag_size_oz INTEGER NOT NULL CHECK (bag_size_oz IN (8,16)),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER,
  stripe_price_id TEXT
);
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_roast_window ON orders(roast_window_date,status);
CREATE INDEX IF NOT EXISTS idx_orders_subscription ON orders(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
-- Dashboard: bag counts and total roasted pounds, including only paid orders.
CREATE VIEW IF NOT EXISTS roast_summary AS
SELECT o.roast_window_date,
 SUM(CASE WHEN i.bag_size_oz=16 THEN i.quantity ELSE 0 END) AS one_pound_bags,
 SUM(CASE WHEN i.bag_size_oz=8 THEN i.quantity ELSE 0 END) AS half_pound_bags,
 SUM(i.quantity) AS total_bags,
 SUM(i.quantity*i.bag_size_oz)/16.0 AS total_roasted_pounds
FROM orders o JOIN order_items i ON i.order_id=o.id
WHERE o.status='paid' AND o.fulfillment_status NOT IN ('shipped','picked_up')
GROUP BY o.roast_window_date;

-- Run in the existing capella-orders D1 database.
CREATE TABLE IF NOT EXISTS recurring_custom_orders (
 id TEXT PRIMARY KEY,
 customer_name TEXT NOT NULL,
 customer_email TEXT,
 bag_size_oz INTEGER NOT NULL CHECK(bag_size_oz IN (8,16)),
 quantity INTEGER NOT NULL CHECK(quantity>0),
 interval_weeks INTEGER NOT NULL CHECK(interval_weeks IN (1,2,4)),
 start_friday TEXT NOT NULL,
 delivery_method TEXT NOT NULL CHECK(delivery_method IN ('pickup','shipping')),
 payment_method TEXT NOT NULL,
 payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
 unit_price_cents INTEGER NOT NULL,
 notes TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recurring_custom_start ON recurring_custom_orders(active,start_friday);

-- Run once in Cloudflare D1: capella-orders → Console.
CREATE TABLE IF NOT EXISTS finance_expenses (
 id TEXT PRIMARY KEY,
 expense_date TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('green_beans','packaging','shipping','processing_fees','equipment','supplies','marketing','other')),
 vendor TEXT,
 description TEXT,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_date ON finance_expenses(expense_date);

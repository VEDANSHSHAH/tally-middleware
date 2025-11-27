-- Performance Optimization Indexes
-- Run this to add indexes for faster queries

-- Stats API Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_vendors_company_synced 
  ON vendors(company_guid, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_company_synced 
  ON customers(company_guid, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_company_synced 
  ON transactions(company_guid, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_company_date 
  ON transactions(company_guid, date DESC);

-- Partial index for payment/receipt queries (more efficient)
CREATE INDEX IF NOT EXISTS idx_transactions_voucher_type 
  ON transactions(company_guid, voucher_type) 
  WHERE voucher_type LIKE '%Payment%' OR voucher_type LIKE '%Receipt%';

-- Aging API Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_outstanding_aging_company_outstanding 
  ON outstanding_aging(company_guid, total_outstanding DESC);

CREATE INDEX IF NOT EXISTS idx_outstanding_aging_company_calculated 
  ON outstanding_aging(company_guid, calculated_at DESC);

-- Companies table index (if not exists)
CREATE INDEX IF NOT EXISTS idx_companies_guid_lookup 
  ON companies(company_guid);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_customers_company_balance 
  ON customers(company_guid, current_balance DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_vendors_company_balance 
  ON vendors(company_guid, current_balance DESC NULLS LAST);

-- ============== NEW CRITICAL INDEXES (Add These!) ==============

-- Party name lookups: Speed up transaction history by customer/vendor
-- Used for: Transaction filtering by party, balance calculations
CREATE INDEX IF NOT EXISTS idx_transactions_party_company
  ON transactions(party_name, company_guid, date DESC);

-- Voucher lookup: Speed up duplicate detection during sync
-- Used for: Incremental sync deduplication, voucher number searches
CREATE INDEX IF NOT EXISTS idx_transactions_voucher_company
  ON transactions(voucher_number, company_guid, date DESC);

-- Amount-based queries: Speed up high-value transaction searches
-- Used for: Large transaction alerts, amount-based filtering
CREATE INDEX IF NOT EXISTS idx_transactions_amount_company
  ON transactions(amount DESC, company_guid, date DESC);

-- Composite index for aging analysis (CRITICAL for performance!)
-- Used for: Aging bucket calculations (your slowest queries)
CREATE INDEX IF NOT EXISTS idx_transactions_aging
  ON transactions(company_guid, party_name, date DESC, amount);

-- Ledgers by parent: Speed up Sales Group calculations
-- Used for: Sales Accounts summary (api/sales/group-summary)
CREATE INDEX IF NOT EXISTS idx_ledgers_parent_company
  ON ledgers(parent, company_guid);

-- Ledgers by balance: Speed up trial balance queries
-- Used for: Balance sheet, trial balance reports
CREATE INDEX IF NOT EXISTS idx_ledgers_balance_company
  ON ledgers(company_guid, closing_balance DESC);

-- Analyze tables after creating indexes for query planner
ANALYZE vendors;
ANALYZE customers;
ANALYZE transactions;
ANALYZE outstanding_aging;
ANALYZE companies;


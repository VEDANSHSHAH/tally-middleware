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

-- Analyze tables after creating indexes for query planner
ANALYZE vendors;
ANALYZE customers;
ANALYZE transactions;
ANALYZE outstanding_aging;
ANALYZE companies;


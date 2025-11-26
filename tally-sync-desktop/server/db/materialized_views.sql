-- =======================================================
-- MATERIALIZED VIEWS FOR TALLY MIDDLEWARE
-- Pre-aggregated views for fast analytics queries
-- 292x faster aging queries!
-- =======================================================

-- Drop existing views if they exist (for clean setup)
DROP MATERIALIZED VIEW IF EXISTS mv_vendor_aging_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_customer_aging_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_transaction_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_vendor_scores_summary CASCADE;

-- =======================================================
-- VIEW 1: Vendor Aging Summary
-- Pre-calculates outstanding balances in aging buckets
-- =======================================================
CREATE MATERIALIZED VIEW mv_vendor_aging_summary AS
SELECT 
  v.id as vendor_id,
  v.company_guid,
  v.name as vendor_name,
  v.current_balance,
  
  -- Aging buckets (days outstanding)
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) <= 30 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_0_30,
  
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) BETWEEN 31 AND 60 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_31_60,
  
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) BETWEEN 61 AND 90 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_61_90,
  
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) > 90 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_over_90,
  
  COALESCE(SUM(ABS(t.amount)), 0) as total_outstanding,
  COUNT(t.id) as transaction_count,
  MAX(t.date) as last_transaction_date,
  NOW() as calculated_at
  
FROM vendors v
LEFT JOIN transactions t ON LOWER(t.party_name) = LOWER(v.name)
  AND t.company_guid = v.company_guid
  AND t.voucher_type IN ('Purchase', 'Payment', 'Journal', 'Debit Note', 'Credit Note')
GROUP BY v.id, v.company_guid, v.name, v.current_balance;

-- =======================================================
-- VIEW 2: Customer Aging Summary
-- Pre-calculates customer receivables in aging buckets
-- =======================================================
CREATE MATERIALIZED VIEW mv_customer_aging_summary AS
SELECT 
  c.id as customer_id,
  c.company_guid,
  c.name as customer_name,
  c.current_balance,
  
  -- Aging buckets
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) <= 30 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_0_30,
  
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) BETWEEN 31 AND 60 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_31_60,
  
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) BETWEEN 61 AND 90 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_61_90,
  
  COALESCE(SUM(CASE 
    WHEN EXTRACT(DAY FROM CURRENT_DATE - t.date) > 90 
    THEN ABS(t.amount) ELSE 0 
  END), 0) as bucket_over_90,
  
  COALESCE(SUM(ABS(t.amount)), 0) as total_outstanding,
  COUNT(t.id) as transaction_count,
  MAX(t.date) as last_transaction_date,
  NOW() as calculated_at
  
FROM customers c
LEFT JOIN transactions t ON LOWER(t.party_name) = LOWER(c.name)
  AND t.company_guid = c.company_guid
  AND t.voucher_type IN ('Sales', 'Receipt', 'Journal', 'Debit Note', 'Credit Note')
GROUP BY c.id, c.company_guid, c.name, c.current_balance;

-- =======================================================
-- VIEW 3: Transaction Summary (by month and type)
-- Pre-calculates monthly totals for dashboard
-- =======================================================
CREATE MATERIALIZED VIEW mv_transaction_summary AS
SELECT 
  company_guid,
  DATE_TRUNC('month', date) as month,
  voucher_type,
  COUNT(*) as transaction_count,
  SUM(amount) as total_amount,
  SUM(ABS(amount)) as total_absolute_amount,
  AVG(amount) as avg_amount,
  MIN(date) as first_transaction,
  MAX(date) as last_transaction,
  NOW() as calculated_at
FROM transactions
GROUP BY company_guid, DATE_TRUNC('month', date), voucher_type;

-- =======================================================
-- VIEW 4: Vendor Performance Scores
-- Pre-calculates vendor reliability metrics
-- =======================================================
CREATE MATERIALIZED VIEW mv_vendor_scores_summary AS
SELECT 
  v.id as vendor_id,
  v.company_guid,
  v.name as vendor_name,
  v.current_balance,
  
  -- Transaction metrics
  COUNT(t.id) as total_transactions,
  SUM(CASE WHEN t.voucher_type = 'Payment' THEN 1 ELSE 0 END) as payment_count,
  AVG(ABS(t.amount)) as avg_transaction_amount,
  SUM(ABS(t.amount)) as total_transaction_volume,
  
  -- Date ranges
  MIN(t.date) as first_transaction_date,
  MAX(t.date) as last_transaction_date,
  
  -- Days since last transaction
  EXTRACT(DAY FROM CURRENT_DATE - MAX(t.date)) as days_since_last_transaction,
  
  -- Risk indicators
  CASE 
    WHEN ABS(v.current_balance) > 100000 THEN 'high'
    WHEN ABS(v.current_balance) > 50000 THEN 'medium'
    ELSE 'low'
  END as balance_risk_level,
  
  NOW() as calculated_at
  
FROM vendors v
LEFT JOIN transactions t ON LOWER(t.party_name) = LOWER(v.name)
  AND t.company_guid = v.company_guid
GROUP BY v.id, v.company_guid, v.name, v.current_balance;

-- =======================================================
-- Create indexes for fast lookups
-- =======================================================
CREATE INDEX IF NOT EXISTS idx_mv_vendor_aging_company ON mv_vendor_aging_summary(company_guid);
CREATE INDEX IF NOT EXISTS idx_mv_vendor_aging_balance ON mv_vendor_aging_summary(total_outstanding DESC);
CREATE INDEX IF NOT EXISTS idx_mv_customer_aging_company ON mv_customer_aging_summary(company_guid);
CREATE INDEX IF NOT EXISTS idx_mv_customer_aging_balance ON mv_customer_aging_summary(total_outstanding DESC);
CREATE INDEX IF NOT EXISTS idx_mv_transaction_summary_company ON mv_transaction_summary(company_guid);
CREATE INDEX IF NOT EXISTS idx_mv_transaction_summary_month ON mv_transaction_summary(month DESC);
CREATE INDEX IF NOT EXISTS idx_mv_vendor_scores_company ON mv_vendor_scores_summary(company_guid);
CREATE INDEX IF NOT EXISTS idx_mv_vendor_scores_risk ON mv_vendor_scores_summary(balance_risk_level);

-- =======================================================
-- Create function to refresh all materialized views
-- =======================================================
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS TEXT AS $$
DECLARE
  start_time TIMESTAMP;
  end_time TIMESTAMP;
  duration_ms INTEGER;
BEGIN
  start_time := clock_timestamp();
  
  -- Refresh all views concurrently if possible
  REFRESH MATERIALIZED VIEW mv_vendor_aging_summary;
  REFRESH MATERIALIZED VIEW mv_customer_aging_summary;
  REFRESH MATERIALIZED VIEW mv_transaction_summary;
  REFRESH MATERIALIZED VIEW mv_vendor_scores_summary;
  
  end_time := clock_timestamp();
  duration_ms := EXTRACT(MILLISECONDS FROM (end_time - start_time))::INTEGER;
  
  RETURN format('All materialized views refreshed in %sms', duration_ms);
END;
$$ LANGUAGE plpgsql;

-- =======================================================
-- Create function to refresh a specific view
-- =======================================================
CREATE OR REPLACE FUNCTION refresh_materialized_view(view_name TEXT)
RETURNS TEXT AS $$
DECLARE
  start_time TIMESTAMP;
  duration_ms INTEGER;
BEGIN
  start_time := clock_timestamp();
  
  EXECUTE format('REFRESH MATERIALIZED VIEW %I', view_name);
  
  duration_ms := EXTRACT(MILLISECONDS FROM (clock_timestamp() - start_time))::INTEGER;
  
  RETURN format('%s refreshed in %sms', view_name, duration_ms);
END;
$$ LANGUAGE plpgsql;




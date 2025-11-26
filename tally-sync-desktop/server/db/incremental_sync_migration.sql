-- =====================================================
-- INCREMENTAL SYNC TRACKING
-- =====================================================

-- Table to track last sync time per company and data type
CREATE TABLE IF NOT EXISTS sync_history (
  id SERIAL PRIMARY KEY,
  company_guid VARCHAR(255) NOT NULL,
  data_type VARCHAR(50) NOT NULL, -- 'vendors', 'customers', 'transactions'
  last_sync_at TIMESTAMP NOT NULL,
  records_synced INTEGER DEFAULT 0,
  sync_duration_ms INTEGER,
  sync_mode VARCHAR(20) DEFAULT 'full', -- 'full' or 'incremental'
  from_date DATE,
  to_date DATE,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_company_datatype UNIQUE (company_guid, data_type)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_sync_history_company ON sync_history(company_guid);
CREATE INDEX IF NOT EXISTS idx_sync_history_datatype ON sync_history(data_type);
CREATE INDEX IF NOT EXISTS idx_sync_history_time ON sync_history(last_sync_at DESC);

-- Function to get last sync time
CREATE OR REPLACE FUNCTION get_last_sync_time(
  p_company_guid VARCHAR(255),
  p_data_type VARCHAR(50)
)
RETURNS TIMESTAMP AS $$
DECLARE
  last_sync TIMESTAMP;
BEGIN
  SELECT last_sync_at INTO last_sync
  FROM sync_history
  WHERE company_guid = p_company_guid 
    AND data_type = p_data_type
    AND error_message IS NULL  -- Only count successful syncs
  ORDER BY last_sync_at DESC
  LIMIT 1;
  
  RETURN last_sync;
END;
$$ LANGUAGE plpgsql;

-- Function to update sync history
CREATE OR REPLACE FUNCTION update_sync_history(
  p_company_guid VARCHAR(255),
  p_data_type VARCHAR(50),
  p_records_synced INTEGER,
  p_sync_duration_ms INTEGER,
  p_sync_mode VARCHAR(20),
  p_from_date DATE DEFAULT NULL,
  p_to_date DATE DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO sync_history (
    company_guid, 
    data_type, 
    last_sync_at, 
    records_synced, 
    sync_duration_ms,
    sync_mode,
    from_date,
    to_date,
    error_message
  ) VALUES (
    p_company_guid,
    p_data_type,
    NOW(),
    p_records_synced,
    p_sync_duration_ms,
    p_sync_mode,
    p_from_date,
    p_to_date,
    p_error_message
  )
  ON CONFLICT (company_guid, data_type)
  DO UPDATE SET
    last_sync_at = NOW(),
    records_synced = p_records_synced,
    sync_duration_ms = p_sync_duration_ms,
    sync_mode = p_sync_mode,
    from_date = p_from_date,
    to_date = p_to_date,
    error_message = p_error_message,
    created_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Add modified_date column to tables if not exists
ALTER TABLE vendors 
  ADD COLUMN IF NOT EXISTS modified_date TIMESTAMP DEFAULT NOW();

ALTER TABLE customers 
  ADD COLUMN IF NOT EXISTS modified_date TIMESTAMP DEFAULT NOW();

ALTER TABLE transactions 
  ADD COLUMN IF NOT EXISTS modified_date TIMESTAMP DEFAULT NOW();

-- Create trigger to auto-update modified_date
CREATE OR REPLACE FUNCTION update_modified_date()
RETURNS TRIGGER AS $$
BEGIN
  NEW.modified_date = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables (drop first to avoid duplicates)
DROP TRIGGER IF EXISTS vendors_modified_trigger ON vendors;
CREATE TRIGGER vendors_modified_trigger
  BEFORE UPDATE ON vendors
  FOR EACH ROW
  EXECUTE FUNCTION update_modified_date();

DROP TRIGGER IF EXISTS customers_modified_trigger ON customers;
CREATE TRIGGER customers_modified_trigger
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_modified_date();

DROP TRIGGER IF EXISTS transactions_modified_trigger ON transactions;
CREATE TRIGGER transactions_modified_trigger
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_modified_date();

-- Create sync_history_log table for keeping full history (optional but useful for debugging)
CREATE TABLE IF NOT EXISTS sync_history_log (
  id SERIAL PRIMARY KEY,
  company_guid VARCHAR(255) NOT NULL,
  data_type VARCHAR(50) NOT NULL,
  sync_started_at TIMESTAMP NOT NULL,
  sync_completed_at TIMESTAMP,
  records_synced INTEGER DEFAULT 0,
  sync_duration_ms INTEGER,
  sync_mode VARCHAR(20) DEFAULT 'full',
  from_date DATE,
  to_date DATE,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_history_log_company ON sync_history_log(company_guid);
CREATE INDEX IF NOT EXISTS idx_sync_history_log_time ON sync_history_log(sync_started_at DESC);




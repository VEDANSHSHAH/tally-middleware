-- Company Setup Migration
-- Add company_guid to all existing tables

-- Add company_guid to vendors
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors(company_guid);

-- Add company_guid to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_guid);

-- Add company_guid to transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_guid);

-- Add company_guid to vendor_scores (if table exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'vendor_scores') THEN
        ALTER TABLE vendor_scores ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_vendor_scores_company ON vendor_scores(company_guid);
    END IF;
END $$;

-- Add company_guid to outstanding_aging (if table exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'outstanding_aging') THEN
        ALTER TABLE outstanding_aging ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_outstanding_aging_company ON outstanding_aging(company_guid);
    END IF;
END $$;

-- Add company_guid to payment_cycles (if table exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'payment_cycles') THEN
        ALTER TABLE payment_cycles ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_payment_cycles_company ON payment_cycles(company_guid);
    END IF;
END $$;

-- Create companies table
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  company_guid VARCHAR(255) UNIQUE NOT NULL,
  company_name VARCHAR(500) NOT NULL,
  tally_company_name VARCHAR(500),
  verified BOOLEAN DEFAULT false,
  registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_guid ON companies(company_guid);



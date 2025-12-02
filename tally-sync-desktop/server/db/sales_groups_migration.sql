-- =======================================================
-- SALES GROUPS & LEDGERS MIGRATION
-- Creates tables to store Tally Groups and ALL Ledgers
-- Required for accurate Sales Accounts calculation
-- =======================================================

-- Groups Table (Stores Tally's group hierarchy)
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    guid VARCHAR(255) NOT NULL,
    name VARCHAR(500) NOT NULL,
    parent VARCHAR(500),
    primary_group VARCHAR(100),
    is_revenue BOOLEAN DEFAULT FALSE,
    is_expense BOOLEAN DEFAULT FALSE,
    company_guid VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    synced_at TIMESTAMP,
    CONSTRAINT groups_guid_company_key UNIQUE(guid, company_guid)
);

-- Ledgers Table (Stores ALL ledgers, not just vendors/customers)
CREATE TABLE IF NOT EXISTS ledgers (
    id SERIAL PRIMARY KEY,
    guid VARCHAR(255) NOT NULL,
    name VARCHAR(500) NOT NULL,
    parent_group VARCHAR(500) NOT NULL,
    opening_balance NUMERIC(15,2) DEFAULT 0,
    closing_balance NUMERIC(15,2) DEFAULT 0,
    ledger_type VARCHAR(100),
    is_revenue BOOLEAN DEFAULT FALSE,
    is_expense BOOLEAN DEFAULT FALSE,
    company_guid VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    synced_at TIMESTAMP,
    CONSTRAINT ledgers_guid_company_key UNIQUE(guid, company_guid)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_groups_company ON groups(company_guid);
CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent);
CREATE INDEX IF NOT EXISTS idx_groups_primary ON groups(primary_group);
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);
CREATE INDEX IF NOT EXISTS idx_ledgers_company ON ledgers(company_guid);
CREATE INDEX IF NOT EXISTS idx_ledgers_parent ON ledgers(parent_group);
CREATE INDEX IF NOT EXISTS idx_ledgers_revenue ON ledgers(is_revenue) WHERE is_revenue = TRUE;
CREATE INDEX IF NOT EXISTS idx_ledgers_name ON ledgers(name);

-- Add company_guid column to transactions if it doesn't exist (for consistency)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'company_guid'
    ) THEN
        ALTER TABLE transactions ADD COLUMN company_guid VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_guid);
    END IF;
END $$;

-- SALES GROUPS & LEDGERS MIGRATION
-- Creates tables to store Tally Groups and ALL Ledgers
-- Required for accurate Sales Accounts calculation
-- =======================================================

-- Groups Table (Stores Tally's group hierarchy)
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    guid VARCHAR(255) NOT NULL,
    name VARCHAR(500) NOT NULL,
    parent VARCHAR(500),
    primary_group VARCHAR(100),
    is_revenue BOOLEAN DEFAULT FALSE,
    is_expense BOOLEAN DEFAULT FALSE,
    company_guid VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    synced_at TIMESTAMP,
    CONSTRAINT groups_guid_company_key UNIQUE(guid, company_guid)
);

-- Ledgers Table (Stores ALL ledgers, not just vendors/customers)
CREATE TABLE IF NOT EXISTS ledgers (
    id SERIAL PRIMARY KEY,
    guid VARCHAR(255) NOT NULL,
    name VARCHAR(500) NOT NULL,
    parent_group VARCHAR(500) NOT NULL,
    opening_balance NUMERIC(15,2) DEFAULT 0,
    closing_balance NUMERIC(15,2) DEFAULT 0,
    ledger_type VARCHAR(100),
    is_revenue BOOLEAN DEFAULT FALSE,
    is_expense BOOLEAN DEFAULT FALSE,
    company_guid VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    synced_at TIMESTAMP,
    CONSTRAINT ledgers_guid_company_key UNIQUE(guid, company_guid)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_groups_company ON groups(company_guid);
CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent);
CREATE INDEX IF NOT EXISTS idx_groups_primary ON groups(primary_group);
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);
CREATE INDEX IF NOT EXISTS idx_ledgers_company ON ledgers(company_guid);
CREATE INDEX IF NOT EXISTS idx_ledgers_parent ON ledgers(parent_group);
CREATE INDEX IF NOT EXISTS idx_ledgers_revenue ON ledgers(is_revenue) WHERE is_revenue = TRUE;
CREATE INDEX IF NOT EXISTS idx_ledgers_name ON ledgers(name);

-- Add company_guid column to transactions if it doesn't exist (for consistency)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'transactions' AND column_name = 'company_guid'
    ) THEN
        ALTER TABLE transactions ADD COLUMN company_guid VARCHAR(255);
        CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_guid);
    END IF;
END $$;












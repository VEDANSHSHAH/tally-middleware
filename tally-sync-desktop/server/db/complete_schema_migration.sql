-- =====================================================
-- TALLY MIDDLEWARE - COMPLETE NORMALIZED SCHEMA
-- =====================================================
-- Version: 2.0
-- Purpose: Replace flat transaction structure with normalized relational design
-- Based on: Tally's complete data structure (53 columns analyzed)

-- =====================================================
-- EXECUTION ORDER
-- =====================================================
-- Run this AFTER sales_groups_migration.sql
-- This creates: companies, ledgers, addresses, items, vouchers, voucher_line_items

-- =====================================================
-- 1. COMPANIES TABLE (Enhanced)
-- =====================================================

CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) UNIQUE NOT NULL,
    company_name VARCHAR(500) NOT NULL,
    tally_company_name VARCHAR(500),
    
    -- Financial year
    financial_year_from DATE,
    books_beginning_from DATE,
    
    -- Company details
    address_line1 VARCHAR(500),
    address_line2 VARCHAR(500),
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(20),
    country VARCHAR(100) DEFAULT 'India',
    
    -- Registration numbers
    pan VARCHAR(20),
    gstin VARCHAR(20),
    tan VARCHAR(20),
    cin VARCHAR(30),
    
    -- Contact
    phone VARCHAR(20),
    email VARCHAR(100),
    website VARCHAR(200),
    
    -- System fields
    verified BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_sync TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for companies
CREATE INDEX IF NOT EXISTS idx_companies_guid ON companies(company_guid);
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(active);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(company_name);

-- Add new columns to existing companies table if it exists
DO $$
BEGIN
    -- Add financial year columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'financial_year_from') THEN
        ALTER TABLE companies ADD COLUMN financial_year_from DATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'books_beginning_from') THEN
        ALTER TABLE companies ADD COLUMN books_beginning_from DATE;
    END IF;
    
    -- Add address columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'address_line1') THEN
        ALTER TABLE companies ADD COLUMN address_line1 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'address_line2') THEN
        ALTER TABLE companies ADD COLUMN address_line2 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'city') THEN
        ALTER TABLE companies ADD COLUMN city VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'state') THEN
        ALTER TABLE companies ADD COLUMN state VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'pincode') THEN
        ALTER TABLE companies ADD COLUMN pincode VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'country') THEN
        ALTER TABLE companies ADD COLUMN country VARCHAR(100) DEFAULT 'India';
    END IF;
    
    -- Add registration columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'pan') THEN
        ALTER TABLE companies ADD COLUMN pan VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'gstin') THEN
        ALTER TABLE companies ADD COLUMN gstin VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'tan') THEN
        ALTER TABLE companies ADD COLUMN tan VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'cin') THEN
        ALTER TABLE companies ADD COLUMN cin VARCHAR(30);
    END IF;
    
    -- Add contact columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'phone') THEN
        ALTER TABLE companies ADD COLUMN phone VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'email') THEN
        ALTER TABLE companies ADD COLUMN email VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'website') THEN
        ALTER TABLE companies ADD COLUMN website VARCHAR(200);
    END IF;
    
    -- Add active column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'active') THEN
        ALTER TABLE companies ADD COLUMN active BOOLEAN DEFAULT TRUE;
    END IF;
    
    -- Add updated_at column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'updated_at') THEN
        ALTER TABLE companies ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;

-- =====================================================
-- 2. LEDGERS TABLE (Enhanced - Unified vendors + customers)
-- =====================================================

-- Enhance existing ledgers table with new columns
DO $$
BEGIN
    -- Add ledger_guid as UUID if not exists (convert from guid VARCHAR)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'ledger_guid') THEN
        ALTER TABLE ledgers ADD COLUMN ledger_guid VARCHAR(255);
        -- Copy from guid if exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'guid') THEN
            UPDATE ledgers SET ledger_guid = guid WHERE ledger_guid IS NULL;
        END IF;
    END IF;
    
    -- Add alias
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'alias') THEN
        ALTER TABLE ledgers ADD COLUMN alias VARCHAR(500);
    END IF;
    
    -- Add balance type columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'opening_balance_type') THEN
        ALTER TABLE ledgers ADD COLUMN opening_balance_type VARCHAR(10) DEFAULT 'Dr';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'current_balance') THEN
        ALTER TABLE ledgers ADD COLUMN current_balance NUMERIC(15,2) DEFAULT 0;
        -- Copy from closing_balance if exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'closing_balance') THEN
            UPDATE ledgers SET current_balance = closing_balance WHERE current_balance = 0;
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'current_balance_type') THEN
        ALTER TABLE ledgers ADD COLUMN current_balance_type VARCHAR(10) DEFAULT 'Dr';
    END IF;
    
    -- Add party details
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'pan') THEN
        ALTER TABLE ledgers ADD COLUMN pan VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'gstin') THEN
        ALTER TABLE ledgers ADD COLUMN gstin VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'state_code') THEN
        ALTER TABLE ledgers ADD COLUMN state_code VARCHAR(5);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'gst_registration_type') THEN
        ALTER TABLE ledgers ADD COLUMN gst_registration_type VARCHAR(50);
    END IF;
    
    -- Add bill-wise details
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'maintain_billwise') THEN
        ALTER TABLE ledgers ADD COLUMN maintain_billwise BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'credit_limit') THEN
        ALTER TABLE ledgers ADD COLUMN credit_limit NUMERIC(15,2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'credit_days') THEN
        ALTER TABLE ledgers ADD COLUMN credit_days INTEGER;
    END IF;
    
    -- Add banking details
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'bank_name') THEN
        ALTER TABLE ledgers ADD COLUMN bank_name VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'account_number') THEN
        ALTER TABLE ledgers ADD COLUMN account_number VARCHAR(50);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'ifsc_code') THEN
        ALTER TABLE ledgers ADD COLUMN ifsc_code VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'swift_code') THEN
        ALTER TABLE ledgers ADD COLUMN swift_code VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'branch') THEN
        ALTER TABLE ledgers ADD COLUMN branch VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'micr_code') THEN
        ALTER TABLE ledgers ADD COLUMN micr_code VARCHAR(20);
    END IF;
    
    -- Add contact info
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'primary_contact') THEN
        ALTER TABLE ledgers ADD COLUMN primary_contact VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'primary_phone') THEN
        ALTER TABLE ledgers ADD COLUMN primary_phone VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'primary_email') THEN
        ALTER TABLE ledgers ADD COLUMN primary_email VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'secondary_phone') THEN
        ALTER TABLE ledgers ADD COLUMN secondary_phone VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'secondary_email') THEN
        ALTER TABLE ledgers ADD COLUMN secondary_email VARCHAR(100);
    END IF;
    
    -- Add address columns (main address - detailed addresses in addresses table)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'address_line1') THEN
        ALTER TABLE ledgers ADD COLUMN address_line1 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'address_line2') THEN
        ALTER TABLE ledgers ADD COLUMN address_line2 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'city') THEN
        ALTER TABLE ledgers ADD COLUMN city VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'state') THEN
        ALTER TABLE ledgers ADD COLUMN state VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'pincode') THEN
        ALTER TABLE ledgers ADD COLUMN pincode VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'country') THEN
        ALTER TABLE ledgers ADD COLUMN country VARCHAR(100) DEFAULT 'India';
    END IF;
    
    -- Add active column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'active') THEN
        ALTER TABLE ledgers ADD COLUMN active BOOLEAN DEFAULT TRUE;
    END IF;
END $$;

-- Add new indexes for ledgers
CREATE INDEX IF NOT EXISTS idx_ledgers_guid ON ledgers(ledger_guid);
CREATE INDEX IF NOT EXISTS idx_ledgers_type ON ledgers(ledger_type);
CREATE INDEX IF NOT EXISTS idx_ledgers_gstin ON ledgers(gstin);
CREATE INDEX IF NOT EXISTS idx_ledgers_active ON ledgers(active);

-- =====================================================
-- 3. ADDRESSES TABLE (Multiple addresses per ledger)
-- =====================================================

CREATE TABLE IF NOT EXISTS addresses (
    id SERIAL PRIMARY KEY,
    address_guid VARCHAR(255) UNIQUE NOT NULL,
    ledger_id INTEGER NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Address type
    address_type VARCHAR(50) NOT NULL, -- 'Billing', 'Shipping', 'Registered', 'Branch'
    is_default BOOLEAN DEFAULT FALSE,
    address_name VARCHAR(200), -- "Mumbai Office", "Factory", etc.
    
    -- Address details
    address_line1 VARCHAR(500),
    address_line2 VARCHAR(500),
    address_line3 VARCHAR(500),
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(20),
    country VARCHAR(100) DEFAULT 'India',
    
    -- Contact at this address
    contact_person VARCHAR(100),
    contact_phone VARCHAR(20),
    contact_email VARCHAR(100),
    
    -- GST for this location
    gstin VARCHAR(20),
    
    -- System fields
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for addresses
CREATE INDEX IF NOT EXISTS idx_addresses_ledger ON addresses(ledger_id);
CREATE INDEX IF NOT EXISTS idx_addresses_company ON addresses(company_guid);
CREATE INDEX IF NOT EXISTS idx_addresses_type ON addresses(address_type);
CREATE INDEX IF NOT EXISTS idx_addresses_gstin ON addresses(gstin);
CREATE INDEX IF NOT EXISTS idx_addresses_active ON addresses(active);

-- =====================================================
-- 4. ITEMS TABLE (Stock items, services)
-- =====================================================

CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    item_guid VARCHAR(255) NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Basic info
    name VARCHAR(500) NOT NULL,
    alias VARCHAR(500),
    item_code VARCHAR(100),
    barcode VARCHAR(100),
    description TEXT,
    
    -- Category
    parent_group VARCHAR(200), -- 'Finished Goods', 'Raw Materials', 'Services', 'Trading Goods'
    category VARCHAR(200),
    sub_category VARCHAR(200),
    
    -- Tax codes
    hsn_code VARCHAR(20), -- For goods
    sac_code VARCHAR(20), -- For services
    
    -- Units
    base_unit VARCHAR(50), -- 'Pcs', 'Kg', 'Ltrs', 'Boxes', 'Meters'
    alternate_unit VARCHAR(50),
    conversion_factor NUMERIC(10,4),
    
    -- Pricing
    rate NUMERIC(15,2),
    rate_per VARCHAR(50), -- Unit for the rate
    cost_price NUMERIC(15,2),
    mrp NUMERIC(15,2),
    wholesale_price NUMERIC(15,2),
    retail_price NUMERIC(15,2),
    
    -- Tax
    gst_rate NUMERIC(5,2),
    gst_type VARCHAR(50), -- 'Goods', 'Services'
    taxable BOOLEAN DEFAULT TRUE,
    
    -- Inventory tracking
    maintain_inventory BOOLEAN DEFAULT TRUE,
    opening_quantity NUMERIC(15,3) DEFAULT 0,
    opening_value NUMERIC(15,2) DEFAULT 0,
    current_quantity NUMERIC(15,3) DEFAULT 0,
    current_value NUMERIC(15,2) DEFAULT 0,
    reorder_level NUMERIC(15,3),
    
    -- Additional details
    manufacturer VARCHAR(200),
    brand VARCHAR(200),
    model_number VARCHAR(100),
    
    -- System fields
    active BOOLEAN DEFAULT TRUE,
    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT items_guid_company_key UNIQUE(item_guid, company_guid)
);

-- Indexes for items
CREATE INDEX IF NOT EXISTS idx_items_company ON items(company_guid);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
CREATE INDEX IF NOT EXISTS idx_items_code ON items(item_code);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_hsn ON items(hsn_code);
CREATE INDEX IF NOT EXISTS idx_items_sac ON items(sac_code);
CREATE INDEX IF NOT EXISTS idx_items_active ON items(active);
CREATE INDEX IF NOT EXISTS idx_items_guid ON items(item_guid);

-- =====================================================
-- 5. VOUCHERS TABLE (Transaction headers)
-- =====================================================

CREATE TABLE IF NOT EXISTS vouchers (
    id SERIAL PRIMARY KEY,
    voucher_guid VARCHAR(255) NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Voucher identification
    voucher_number VARCHAR(100) NOT NULL,
    voucher_type VARCHAR(50) NOT NULL, -- 'Sales', 'Purchase', 'Payment', 'Receipt', 'Journal', 'Contra', 'Debit Note', 'Credit Note'
    voucher_name VARCHAR(100), -- Tally's "Vocher Name" field
    date DATE NOT NULL,
    
    -- Reference
    reference_number VARCHAR(100),
    reference_date DATE,
    
    -- Party reference (for sales/purchase/payment/receipt)
    party_ledger_id INTEGER,
    party_name VARCHAR(500), -- Cached for performance (denormalized)
    
    -- Addresses (for sales/purchase)
    billing_address_id INTEGER,
    shipping_address_id INTEGER,
    
    -- Amounts
    total_amount NUMERIC(15,2) NOT NULL,
    gross_amount NUMERIC(15,2),
    discount_amount NUMERIC(15,2) DEFAULT 0,
    tax_amount NUMERIC(15,2) DEFAULT 0,
    round_off NUMERIC(15,2) DEFAULT 0,
    
    -- Mode
    change_mode VARCHAR(50), -- 'Item Invoice', 'Accounting Invoice', 'Single Entry'
    
    -- Narration
    narration TEXT,
    
    -- Dispatch details (for sales with goods movement)
    dispatch_doc_no VARCHAR(100),
    dispatch_date DATE,
    dispatched_through VARCHAR(200),
    destination VARCHAR(200),
    carrier_name VARCHAR(200),
    bill_of_lading VARCHAR(100),
    motor_vehicle_no VARCHAR(50),
    
    -- Port/Shipping details (for import/export)
    place_of_receipt VARCHAR(200),
    vessel_flight_no VARCHAR(100),
    port_of_loading VARCHAR(100),
    port_of_discharge VARCHAR(100),
    country_to VARCHAR(100),
    shipping_bill_no VARCHAR(100),
    bill_of_entry VARCHAR(100),
    port_code VARCHAR(50),
    date_of_export DATE,
    
    -- Order reference
    order_number VARCHAR(100),
    order_date DATE,
    
    -- Payment terms
    mode_of_payment VARCHAR(100),
    payment_terms VARCHAR(200),
    due_date DATE,
    
    -- Additional references
    other_references TEXT,
    terms_of_delivery TEXT,
    
    -- E-invoice details (if applicable)
    einvoice_generated BOOLEAN DEFAULT FALSE,
    einvoice_irn VARCHAR(100),
    einvoice_ack_no VARCHAR(100),
    einvoice_ack_date TIMESTAMP,
    
    -- System fields
    is_cancelled BOOLEAN DEFAULT FALSE,
    cancelled_at TIMESTAMP,
    cancelled_reason TEXT,
    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT vouchers_guid_company_key UNIQUE(voucher_guid, company_guid),
    CONSTRAINT vouchers_number_type_company_key UNIQUE(voucher_number, voucher_type, company_guid, date)
);

-- Indexes for vouchers
CREATE INDEX IF NOT EXISTS idx_vouchers_company ON vouchers(company_guid);
CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(date);
CREATE INDEX IF NOT EXISTS idx_vouchers_type ON vouchers(voucher_type);
CREATE INDEX IF NOT EXISTS idx_vouchers_party ON vouchers(party_ledger_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_number ON vouchers(voucher_number);
CREATE INDEX IF NOT EXISTS idx_vouchers_reference ON vouchers(reference_number);
CREATE INDEX IF NOT EXISTS idx_vouchers_cancelled ON vouchers(is_cancelled);
CREATE INDEX IF NOT EXISTS idx_vouchers_guid ON vouchers(voucher_guid);
CREATE INDEX IF NOT EXISTS idx_vouchers_einvoice ON vouchers(einvoice_irn);

-- =====================================================
-- 6. VOUCHER_LINE_ITEMS TABLE (Double-entry details)
-- =====================================================

CREATE TABLE IF NOT EXISTS voucher_line_items (
    id SERIAL PRIMARY KEY,
    line_guid VARCHAR(255) UNIQUE NOT NULL,
    voucher_id INTEGER NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Line sequence
    line_number INTEGER NOT NULL, -- 1, 2, 3... for ordering within voucher
    
    -- Accounting entry (THIS IS THE CORE - Double Entry!)
    ledger_id INTEGER NOT NULL,
    ledger_name VARCHAR(500), -- Cached for performance
    
    -- Debit/Credit amounts (ALWAYS one is 0, other has value)
    debit_amount NUMERIC(15,2) DEFAULT 0,
    credit_amount NUMERIC(15,2) DEFAULT 0,
    
    -- Item details (if this line is for an item)
    item_id INTEGER,
    item_name VARCHAR(500), -- Cached
    
    -- Quantity & Rate (for item lines)
    actual_quantity NUMERIC(15,3),
    billed_quantity NUMERIC(15,3),
    free_quantity NUMERIC(15,3),
    rate NUMERIC(15,2),
    rate_per VARCHAR(50), -- 'Pcs', 'Kg', etc.
    amount NUMERIC(15,2),
    
    -- Discount
    discount_percent NUMERIC(5,2),
    discount_amount NUMERIC(15,2) DEFAULT 0,
    
    -- Tax breakdown (for item lines)
    taxable_amount NUMERIC(15,2),
    cgst_rate NUMERIC(5,2),
    cgst_amount NUMERIC(15,2) DEFAULT 0,
    sgst_rate NUMERIC(5,2),
    sgst_amount NUMERIC(15,2) DEFAULT 0,
    igst_rate NUMERIC(5,2),
    igst_amount NUMERIC(15,2) DEFAULT 0,
    cess_rate NUMERIC(5,2),
    cess_amount NUMERIC(15,2) DEFAULT 0,
    
    -- Bill-wise allocation (for payment/receipt lines)
    reference_type VARCHAR(50), -- 'Advance', 'On Account', 'Against Reference', 'New Reference'
    reference_name VARCHAR(200), -- Invoice number being paid/allocated
    reference_amount NUMERIC(15,2),
    reference_date DATE,
    
    -- Cost center / department (if applicable)
    cost_center VARCHAR(200),
    department VARCHAR(200),
    
    -- Additional tracking
    tracking_number VARCHAR(100),
    batch_number VARCHAR(100),
    serial_number VARCHAR(100),
    
    -- Notes for this line
    notes TEXT,
    
    -- System fields
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for voucher_line_items
CREATE INDEX IF NOT EXISTS idx_line_items_voucher ON voucher_line_items(voucher_id);
CREATE INDEX IF NOT EXISTS idx_line_items_company ON voucher_line_items(company_guid);
CREATE INDEX IF NOT EXISTS idx_line_items_ledger ON voucher_line_items(ledger_id);
CREATE INDEX IF NOT EXISTS idx_line_items_item ON voucher_line_items(item_id);
CREATE INDEX IF NOT EXISTS idx_line_items_reference ON voucher_line_items(reference_name);
CREATE INDEX IF NOT EXISTS idx_line_items_line_number ON voucher_line_items(voucher_id, line_number);
CREATE INDEX IF NOT EXISTS idx_line_items_guid ON voucher_line_items(line_guid);

-- =====================================================
-- 7. DASHBOARD_CACHE TABLE (Performance optimization)
-- =====================================================

CREATE TABLE IF NOT EXISTS dashboard_cache (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Metric identification
    metric_type VARCHAR(100) NOT NULL, -- 'total_sales', 'total_receivables', 'top_customers', 'sales_by_state'
    metric_subtype VARCHAR(100), -- Additional classification
    date_from DATE,
    date_to DATE,
    
    -- Cached data
    metric_value NUMERIC(15,2), -- For simple numeric metrics
    metric_data JSONB, -- For complex metrics (arrays, objects, charts data)
    
    -- Cache metadata
    calculated_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP,
    is_valid BOOLEAN DEFAULT TRUE,
    cache_key VARCHAR(500), -- Unique key for this metric combination
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for dashboard_cache
CREATE INDEX IF NOT EXISTS idx_cache_company ON dashboard_cache(company_guid);
CREATE INDEX IF NOT EXISTS idx_cache_type ON dashboard_cache(metric_type);
CREATE INDEX IF NOT EXISTS idx_cache_valid ON dashboard_cache(is_valid);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON dashboard_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_key ON dashboard_cache(cache_key);

-- =====================================================
-- 8. SYNC_LOGS TABLE (Track all sync operations)
-- =====================================================

CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Sync identification
    sync_id VARCHAR(255) UNIQUE NOT NULL, -- Unique ID for this sync session
    sync_type VARCHAR(50) NOT NULL, -- 'Full', 'Incremental', 'Selective'
    data_type VARCHAR(50) NOT NULL, -- 'Ledgers', 'Vouchers', 'Items', 'All'
    
    -- Status
    status VARCHAR(20) NOT NULL, -- 'Started', 'InProgress', 'Completed', 'Failed', 'PartiallyCompleted'
    
    -- Statistics
    records_total INTEGER,
    records_synced INTEGER,
    records_failed INTEGER,
    records_skipped INTEGER,
    records_updated INTEGER,
    records_inserted INTEGER,
    
    -- Timing
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    duration_seconds INTEGER,
    
    -- Date range synced
    from_date DATE,
    to_date DATE,
    
    -- Error handling
    error_message TEXT,
    error_details JSONB,
    warnings JSONB, -- Array of warning messages
    
    -- Configuration
    sync_config JSONB, -- Configuration used for this sync
    
    -- System
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for sync_logs
CREATE INDEX IF NOT EXISTS idx_sync_logs_company ON sync_logs(company_guid);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_date ON sync_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_sync_logs_type ON sync_logs(data_type);
CREATE INDEX IF NOT EXISTS idx_sync_logs_sync_id ON sync_logs(sync_id);

-- =====================================================
-- 9. AUDIT_LOGS TABLE (Complete change tracking)
-- =====================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) NOT NULL,
    
    -- What changed
    table_name VARCHAR(100) NOT NULL,
    record_id INTEGER NOT NULL,
    record_guid VARCHAR(255),
    
    -- Action
    action VARCHAR(20) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    
    -- Changes
    old_values JSONB, -- Complete old record (for UPDATE/DELETE)
    new_values JSONB, -- Complete new record (for INSERT/UPDATE)
    changed_fields TEXT[], -- Array of field names that changed
    
    -- Who/When
    user_id INTEGER, -- If you add users table later
    user_name VARCHAR(200),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Source
    change_source VARCHAR(50), -- 'TallySync', 'API', 'ManualEdit', 'BatchProcess', 'Migration'
    sync_id VARCHAR(255), -- Links to sync_logs if from sync
    
    -- Context
    ip_address VARCHAR(50),
    user_agent TEXT,
    
    -- System
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_guid);
CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_logs(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_logs(changed_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_logs(change_source);
CREATE INDEX IF NOT EXISTS idx_audit_sync ON audit_logs(sync_id);

-- =====================================================
-- 10. CONSTRAINTS & VALIDATION
-- =====================================================

-- Add check constraints for data validation
DO $$
BEGIN
    -- Check constraint for debit/credit exclusivity
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'check_debit_credit_exclusive'
    ) THEN
        ALTER TABLE voucher_line_items 
        ADD CONSTRAINT check_debit_credit_exclusive 
        CHECK (
            (debit_amount > 0 AND credit_amount = 0) OR 
            (debit_amount = 0 AND credit_amount > 0) OR 
            (debit_amount = 0 AND credit_amount = 0)
        );
    END IF;
END $$;

-- =====================================================
-- 11. FUNCTIONS & TRIGGERS (Optional but recommended)
-- =====================================================

-- Function to update ledger balances after voucher changes
CREATE OR REPLACE FUNCTION update_ledger_balance()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Update current balance in ledgers table
        UPDATE ledgers 
        SET current_balance = (
            SELECT COALESCE(SUM(debit_amount - credit_amount), 0)
            FROM voucher_line_items
            WHERE ledger_id = NEW.ledger_id
        )
        WHERE id = NEW.ledger_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trg_update_ledger_balance ON voucher_line_items;
CREATE TRIGGER trg_update_ledger_balance
AFTER INSERT OR UPDATE ON voucher_line_items
FOR EACH ROW
EXECUTE FUNCTION update_ledger_balance();

-- =====================================================
-- 12. VIEWS FOR COMMON QUERIES
-- =====================================================

-- View for complete voucher details with party info
CREATE OR REPLACE VIEW vw_vouchers_detailed AS
SELECT 
    v.id,
    v.voucher_guid,
    v.voucher_number,
    v.voucher_type,
    v.date,
    v.total_amount,
    v.narration,
    l.name as party_name,
    l.gstin as party_gstin,
    l.state as party_state,
    ba.city as billing_city,
    ba.state as billing_state,
    sa.city as shipping_city,
    sa.state as shipping_state,
    c.company_name,
    v.is_cancelled
FROM vouchers v
LEFT JOIN ledgers l ON v.party_ledger_id = l.id
LEFT JOIN addresses ba ON v.billing_address_id = ba.id
LEFT JOIN addresses sa ON v.shipping_address_id = sa.id
JOIN companies c ON v.company_guid = c.company_guid;

-- View for customer/vendor balances
CREATE OR REPLACE VIEW vw_ledger_balances AS
SELECT 
    l.id,
    l.ledger_guid,
    l.name,
    l.ledger_type,
    l.parent_group,
    l.opening_balance,
    l.current_balance,
    l.gstin,
    l.state,
    c.company_name,
    l.company_guid
FROM ledgers l
JOIN companies c ON l.company_guid = c.company_guid
WHERE l.active = TRUE;

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Schema migration completed!';
    RAISE NOTICE '';
    RAISE NOTICE 'Tables created/enhanced:';
    RAISE NOTICE '  1. companies (enhanced)';
    RAISE NOTICE '  2. ledgers (enhanced)';
    RAISE NOTICE '  3. addresses (new)';
    RAISE NOTICE '  4. items (new)';
    RAISE NOTICE '  5. vouchers (new)';
    RAISE NOTICE '  6. voucher_line_items (new)';
    RAISE NOTICE '  7. dashboard_cache (new)';
    RAISE NOTICE '  8. sync_logs (new)';
    RAISE NOTICE '  9. audit_logs (new)';
    RAISE NOTICE '';
    RAISE NOTICE 'Next step: Run data_migration_script.sql';
END $$;

-- TALLY MIDDLEWARE - COMPLETE NORMALIZED SCHEMA
-- =====================================================
-- Version: 2.0
-- Purpose: Replace flat transaction structure with normalized relational design
-- Based on: Tally's complete data structure (53 columns analyzed)

-- =====================================================
-- EXECUTION ORDER
-- =====================================================
-- Run this AFTER sales_groups_migration.sql
-- This creates: companies, ledgers, addresses, items, vouchers, voucher_line_items

-- =====================================================
-- 1. COMPANIES TABLE (Enhanced)
-- =====================================================

CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) UNIQUE NOT NULL,
    company_name VARCHAR(500) NOT NULL,
    tally_company_name VARCHAR(500),
    
    -- Financial year
    financial_year_from DATE,
    books_beginning_from DATE,
    
    -- Company details
    address_line1 VARCHAR(500),
    address_line2 VARCHAR(500),
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(20),
    country VARCHAR(100) DEFAULT 'India',
    
    -- Registration numbers
    pan VARCHAR(20),
    gstin VARCHAR(20),
    tan VARCHAR(20),
    cin VARCHAR(30),
    
    -- Contact
    phone VARCHAR(20),
    email VARCHAR(100),
    website VARCHAR(200),
    
    -- System fields
    verified BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_sync TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for companies
CREATE INDEX IF NOT EXISTS idx_companies_guid ON companies(company_guid);
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(active);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(company_name);

-- Add new columns to existing companies table if it exists
DO $$
BEGIN
    -- Add financial year columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'financial_year_from') THEN
        ALTER TABLE companies ADD COLUMN financial_year_from DATE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'books_beginning_from') THEN
        ALTER TABLE companies ADD COLUMN books_beginning_from DATE;
    END IF;
    
    -- Add address columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'address_line1') THEN
        ALTER TABLE companies ADD COLUMN address_line1 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'address_line2') THEN
        ALTER TABLE companies ADD COLUMN address_line2 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'city') THEN
        ALTER TABLE companies ADD COLUMN city VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'state') THEN
        ALTER TABLE companies ADD COLUMN state VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'pincode') THEN
        ALTER TABLE companies ADD COLUMN pincode VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'country') THEN
        ALTER TABLE companies ADD COLUMN country VARCHAR(100) DEFAULT 'India';
    END IF;
    
    -- Add registration columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'pan') THEN
        ALTER TABLE companies ADD COLUMN pan VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'gstin') THEN
        ALTER TABLE companies ADD COLUMN gstin VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'tan') THEN
        ALTER TABLE companies ADD COLUMN tan VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'cin') THEN
        ALTER TABLE companies ADD COLUMN cin VARCHAR(30);
    END IF;
    
    -- Add contact columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'phone') THEN
        ALTER TABLE companies ADD COLUMN phone VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'email') THEN
        ALTER TABLE companies ADD COLUMN email VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'website') THEN
        ALTER TABLE companies ADD COLUMN website VARCHAR(200);
    END IF;
    
    -- Add active column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'active') THEN
        ALTER TABLE companies ADD COLUMN active BOOLEAN DEFAULT TRUE;
    END IF;
    
    -- Add updated_at column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'updated_at') THEN
        ALTER TABLE companies ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;

-- =====================================================
-- 2. LEDGERS TABLE (Enhanced - Unified vendors + customers)
-- =====================================================

-- Enhance existing ledgers table with new columns
DO $$
BEGIN
    -- Add ledger_guid as UUID if not exists (convert from guid VARCHAR)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'ledger_guid') THEN
        ALTER TABLE ledgers ADD COLUMN ledger_guid VARCHAR(255);
        -- Copy from guid if exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'guid') THEN
            UPDATE ledgers SET ledger_guid = guid WHERE ledger_guid IS NULL;
        END IF;
    END IF;
    
    -- Add alias
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'alias') THEN
        ALTER TABLE ledgers ADD COLUMN alias VARCHAR(500);
    END IF;
    
    -- Add balance type columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'opening_balance_type') THEN
        ALTER TABLE ledgers ADD COLUMN opening_balance_type VARCHAR(10) DEFAULT 'Dr';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'current_balance') THEN
        ALTER TABLE ledgers ADD COLUMN current_balance NUMERIC(15,2) DEFAULT 0;
        -- Copy from closing_balance if exists
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'closing_balance') THEN
            UPDATE ledgers SET current_balance = closing_balance WHERE current_balance = 0;
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'current_balance_type') THEN
        ALTER TABLE ledgers ADD COLUMN current_balance_type VARCHAR(10) DEFAULT 'Dr';
    END IF;
    
    -- Add party details
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'pan') THEN
        ALTER TABLE ledgers ADD COLUMN pan VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'gstin') THEN
        ALTER TABLE ledgers ADD COLUMN gstin VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'state_code') THEN
        ALTER TABLE ledgers ADD COLUMN state_code VARCHAR(5);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'gst_registration_type') THEN
        ALTER TABLE ledgers ADD COLUMN gst_registration_type VARCHAR(50);
    END IF;
    
    -- Add bill-wise details
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'maintain_billwise') THEN
        ALTER TABLE ledgers ADD COLUMN maintain_billwise BOOLEAN DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'credit_limit') THEN
        ALTER TABLE ledgers ADD COLUMN credit_limit NUMERIC(15,2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'credit_days') THEN
        ALTER TABLE ledgers ADD COLUMN credit_days INTEGER;
    END IF;
    
    -- Add banking details
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'bank_name') THEN
        ALTER TABLE ledgers ADD COLUMN bank_name VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'account_number') THEN
        ALTER TABLE ledgers ADD COLUMN account_number VARCHAR(50);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'ifsc_code') THEN
        ALTER TABLE ledgers ADD COLUMN ifsc_code VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'swift_code') THEN
        ALTER TABLE ledgers ADD COLUMN swift_code VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'branch') THEN
        ALTER TABLE ledgers ADD COLUMN branch VARCHAR(200);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'micr_code') THEN
        ALTER TABLE ledgers ADD COLUMN micr_code VARCHAR(20);
    END IF;
    
    -- Add contact info
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'primary_contact') THEN
        ALTER TABLE ledgers ADD COLUMN primary_contact VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'primary_phone') THEN
        ALTER TABLE ledgers ADD COLUMN primary_phone VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'primary_email') THEN
        ALTER TABLE ledgers ADD COLUMN primary_email VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'secondary_phone') THEN
        ALTER TABLE ledgers ADD COLUMN secondary_phone VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'secondary_email') THEN
        ALTER TABLE ledgers ADD COLUMN secondary_email VARCHAR(100);
    END IF;
    
    -- Add address columns (main address - detailed addresses in addresses table)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'address_line1') THEN
        ALTER TABLE ledgers ADD COLUMN address_line1 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'address_line2') THEN
        ALTER TABLE ledgers ADD COLUMN address_line2 VARCHAR(500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'city') THEN
        ALTER TABLE ledgers ADD COLUMN city VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'state') THEN
        ALTER TABLE ledgers ADD COLUMN state VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'pincode') THEN
        ALTER TABLE ledgers ADD COLUMN pincode VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'country') THEN
        ALTER TABLE ledgers ADD COLUMN country VARCHAR(100) DEFAULT 'India';
    END IF;
    
    -- Add active column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ledgers' AND column_name = 'active') THEN
        ALTER TABLE ledgers ADD COLUMN active BOOLEAN DEFAULT TRUE;
    END IF;
END $$;

-- Add new indexes for ledgers
CREATE INDEX IF NOT EXISTS idx_ledgers_guid ON ledgers(ledger_guid);
CREATE INDEX IF NOT EXISTS idx_ledgers_type ON ledgers(ledger_type);
CREATE INDEX IF NOT EXISTS idx_ledgers_gstin ON ledgers(gstin);
CREATE INDEX IF NOT EXISTS idx_ledgers_active ON ledgers(active);

-- =====================================================
-- 3. ADDRESSES TABLE (Multiple addresses per ledger)
-- =====================================================

CREATE TABLE IF NOT EXISTS addresses (
    id SERIAL PRIMARY KEY,
    address_guid VARCHAR(255) UNIQUE NOT NULL,
    ledger_id INTEGER NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Address type
    address_type VARCHAR(50) NOT NULL, -- 'Billing', 'Shipping', 'Registered', 'Branch'
    is_default BOOLEAN DEFAULT FALSE,
    address_name VARCHAR(200), -- "Mumbai Office", "Factory", etc.
    
    -- Address details
    address_line1 VARCHAR(500),
    address_line2 VARCHAR(500),
    address_line3 VARCHAR(500),
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(20),
    country VARCHAR(100) DEFAULT 'India',
    
    -- Contact at this address
    contact_person VARCHAR(100),
    contact_phone VARCHAR(20),
    contact_email VARCHAR(100),
    
    -- GST for this location
    gstin VARCHAR(20),
    
    -- System fields
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for addresses
CREATE INDEX IF NOT EXISTS idx_addresses_ledger ON addresses(ledger_id);
CREATE INDEX IF NOT EXISTS idx_addresses_company ON addresses(company_guid);
CREATE INDEX IF NOT EXISTS idx_addresses_type ON addresses(address_type);
CREATE INDEX IF NOT EXISTS idx_addresses_gstin ON addresses(gstin);
CREATE INDEX IF NOT EXISTS idx_addresses_active ON addresses(active);

-- =====================================================
-- 4. ITEMS TABLE (Stock items, services)
-- =====================================================

CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    item_guid VARCHAR(255) NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Basic info
    name VARCHAR(500) NOT NULL,
    alias VARCHAR(500),
    item_code VARCHAR(100),
    barcode VARCHAR(100),
    description TEXT,
    
    -- Category
    parent_group VARCHAR(200), -- 'Finished Goods', 'Raw Materials', 'Services', 'Trading Goods'
    category VARCHAR(200),
    sub_category VARCHAR(200),
    
    -- Tax codes
    hsn_code VARCHAR(20), -- For goods
    sac_code VARCHAR(20), -- For services
    
    -- Units
    base_unit VARCHAR(50), -- 'Pcs', 'Kg', 'Ltrs', 'Boxes', 'Meters'
    alternate_unit VARCHAR(50),
    conversion_factor NUMERIC(10,4),
    
    -- Pricing
    rate NUMERIC(15,2),
    rate_per VARCHAR(50), -- Unit for the rate
    cost_price NUMERIC(15,2),
    mrp NUMERIC(15,2),
    wholesale_price NUMERIC(15,2),
    retail_price NUMERIC(15,2),
    
    -- Tax
    gst_rate NUMERIC(5,2),
    gst_type VARCHAR(50), -- 'Goods', 'Services'
    taxable BOOLEAN DEFAULT TRUE,
    
    -- Inventory tracking
    maintain_inventory BOOLEAN DEFAULT TRUE,
    opening_quantity NUMERIC(15,3) DEFAULT 0,
    opening_value NUMERIC(15,2) DEFAULT 0,
    current_quantity NUMERIC(15,3) DEFAULT 0,
    current_value NUMERIC(15,2) DEFAULT 0,
    reorder_level NUMERIC(15,3),
    
    -- Additional details
    manufacturer VARCHAR(200),
    brand VARCHAR(200),
    model_number VARCHAR(100),
    
    -- System fields
    active BOOLEAN DEFAULT TRUE,
    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT items_guid_company_key UNIQUE(item_guid, company_guid)
);

-- Indexes for items
CREATE INDEX IF NOT EXISTS idx_items_company ON items(company_guid);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
CREATE INDEX IF NOT EXISTS idx_items_code ON items(item_code);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_hsn ON items(hsn_code);
CREATE INDEX IF NOT EXISTS idx_items_sac ON items(sac_code);
CREATE INDEX IF NOT EXISTS idx_items_active ON items(active);
CREATE INDEX IF NOT EXISTS idx_items_guid ON items(item_guid);

-- =====================================================
-- 5. VOUCHERS TABLE (Transaction headers)
-- =====================================================

CREATE TABLE IF NOT EXISTS vouchers (
    id SERIAL PRIMARY KEY,
    voucher_guid VARCHAR(255) NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Voucher identification
    voucher_number VARCHAR(100) NOT NULL,
    voucher_type VARCHAR(50) NOT NULL, -- 'Sales', 'Purchase', 'Payment', 'Receipt', 'Journal', 'Contra', 'Debit Note', 'Credit Note'
    voucher_name VARCHAR(100), -- Tally's "Vocher Name" field
    date DATE NOT NULL,
    
    -- Reference
    reference_number VARCHAR(100),
    reference_date DATE,
    
    -- Party reference (for sales/purchase/payment/receipt)
    party_ledger_id INTEGER,
    party_name VARCHAR(500), -- Cached for performance (denormalized)
    
    -- Addresses (for sales/purchase)
    billing_address_id INTEGER,
    shipping_address_id INTEGER,
    
    -- Amounts
    total_amount NUMERIC(15,2) NOT NULL,
    gross_amount NUMERIC(15,2),
    discount_amount NUMERIC(15,2) DEFAULT 0,
    tax_amount NUMERIC(15,2) DEFAULT 0,
    round_off NUMERIC(15,2) DEFAULT 0,
    
    -- Mode
    change_mode VARCHAR(50), -- 'Item Invoice', 'Accounting Invoice', 'Single Entry'
    
    -- Narration
    narration TEXT,
    
    -- Dispatch details (for sales with goods movement)
    dispatch_doc_no VARCHAR(100),
    dispatch_date DATE,
    dispatched_through VARCHAR(200),
    destination VARCHAR(200),
    carrier_name VARCHAR(200),
    bill_of_lading VARCHAR(100),
    motor_vehicle_no VARCHAR(50),
    
    -- Port/Shipping details (for import/export)
    place_of_receipt VARCHAR(200),
    vessel_flight_no VARCHAR(100),
    port_of_loading VARCHAR(100),
    port_of_discharge VARCHAR(100),
    country_to VARCHAR(100),
    shipping_bill_no VARCHAR(100),
    bill_of_entry VARCHAR(100),
    port_code VARCHAR(50),
    date_of_export DATE,
    
    -- Order reference
    order_number VARCHAR(100),
    order_date DATE,
    
    -- Payment terms
    mode_of_payment VARCHAR(100),
    payment_terms VARCHAR(200),
    due_date DATE,
    
    -- Additional references
    other_references TEXT,
    terms_of_delivery TEXT,
    
    -- E-invoice details (if applicable)
    einvoice_generated BOOLEAN DEFAULT FALSE,
    einvoice_irn VARCHAR(100),
    einvoice_ack_no VARCHAR(100),
    einvoice_ack_date TIMESTAMP,
    
    -- System fields
    is_cancelled BOOLEAN DEFAULT FALSE,
    cancelled_at TIMESTAMP,
    cancelled_reason TEXT,
    synced_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT vouchers_guid_company_key UNIQUE(voucher_guid, company_guid),
    CONSTRAINT vouchers_number_type_company_key UNIQUE(voucher_number, voucher_type, company_guid, date)
);

-- Indexes for vouchers
CREATE INDEX IF NOT EXISTS idx_vouchers_company ON vouchers(company_guid);
CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(date);
CREATE INDEX IF NOT EXISTS idx_vouchers_type ON vouchers(voucher_type);
CREATE INDEX IF NOT EXISTS idx_vouchers_party ON vouchers(party_ledger_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_number ON vouchers(voucher_number);
CREATE INDEX IF NOT EXISTS idx_vouchers_reference ON vouchers(reference_number);
CREATE INDEX IF NOT EXISTS idx_vouchers_cancelled ON vouchers(is_cancelled);
CREATE INDEX IF NOT EXISTS idx_vouchers_guid ON vouchers(voucher_guid);
CREATE INDEX IF NOT EXISTS idx_vouchers_einvoice ON vouchers(einvoice_irn);

-- =====================================================
-- 6. VOUCHER_LINE_ITEMS TABLE (Double-entry details)
-- =====================================================

CREATE TABLE IF NOT EXISTS voucher_line_items (
    id SERIAL PRIMARY KEY,
    line_guid VARCHAR(255) UNIQUE NOT NULL,
    voucher_id INTEGER NOT NULL,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Line sequence
    line_number INTEGER NOT NULL, -- 1, 2, 3... for ordering within voucher
    
    -- Accounting entry (THIS IS THE CORE - Double Entry!)
    ledger_id INTEGER NOT NULL,
    ledger_name VARCHAR(500), -- Cached for performance
    
    -- Debit/Credit amounts (ALWAYS one is 0, other has value)
    debit_amount NUMERIC(15,2) DEFAULT 0,
    credit_amount NUMERIC(15,2) DEFAULT 0,
    
    -- Item details (if this line is for an item)
    item_id INTEGER,
    item_name VARCHAR(500), -- Cached
    
    -- Quantity & Rate (for item lines)
    actual_quantity NUMERIC(15,3),
    billed_quantity NUMERIC(15,3),
    free_quantity NUMERIC(15,3),
    rate NUMERIC(15,2),
    rate_per VARCHAR(50), -- 'Pcs', 'Kg', etc.
    amount NUMERIC(15,2),
    
    -- Discount
    discount_percent NUMERIC(5,2),
    discount_amount NUMERIC(15,2) DEFAULT 0,
    
    -- Tax breakdown (for item lines)
    taxable_amount NUMERIC(15,2),
    cgst_rate NUMERIC(5,2),
    cgst_amount NUMERIC(15,2) DEFAULT 0,
    sgst_rate NUMERIC(5,2),
    sgst_amount NUMERIC(15,2) DEFAULT 0,
    igst_rate NUMERIC(5,2),
    igst_amount NUMERIC(15,2) DEFAULT 0,
    cess_rate NUMERIC(5,2),
    cess_amount NUMERIC(15,2) DEFAULT 0,
    
    -- Bill-wise allocation (for payment/receipt lines)
    reference_type VARCHAR(50), -- 'Advance', 'On Account', 'Against Reference', 'New Reference'
    reference_name VARCHAR(200), -- Invoice number being paid/allocated
    reference_amount NUMERIC(15,2),
    reference_date DATE,
    
    -- Cost center / department (if applicable)
    cost_center VARCHAR(200),
    department VARCHAR(200),
    
    -- Additional tracking
    tracking_number VARCHAR(100),
    batch_number VARCHAR(100),
    serial_number VARCHAR(100),
    
    -- Notes for this line
    notes TEXT,
    
    -- System fields
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for voucher_line_items
CREATE INDEX IF NOT EXISTS idx_line_items_voucher ON voucher_line_items(voucher_id);
CREATE INDEX IF NOT EXISTS idx_line_items_company ON voucher_line_items(company_guid);
CREATE INDEX IF NOT EXISTS idx_line_items_ledger ON voucher_line_items(ledger_id);
CREATE INDEX IF NOT EXISTS idx_line_items_item ON voucher_line_items(item_id);
CREATE INDEX IF NOT EXISTS idx_line_items_reference ON voucher_line_items(reference_name);
CREATE INDEX IF NOT EXISTS idx_line_items_line_number ON voucher_line_items(voucher_id, line_number);
CREATE INDEX IF NOT EXISTS idx_line_items_guid ON voucher_line_items(line_guid);

-- =====================================================
-- 7. DASHBOARD_CACHE TABLE (Performance optimization)
-- =====================================================

CREATE TABLE IF NOT EXISTS dashboard_cache (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Metric identification
    metric_type VARCHAR(100) NOT NULL, -- 'total_sales', 'total_receivables', 'top_customers', 'sales_by_state'
    metric_subtype VARCHAR(100), -- Additional classification
    date_from DATE,
    date_to DATE,
    
    -- Cached data
    metric_value NUMERIC(15,2), -- For simple numeric metrics
    metric_data JSONB, -- For complex metrics (arrays, objects, charts data)
    
    -- Cache metadata
    calculated_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP,
    is_valid BOOLEAN DEFAULT TRUE,
    cache_key VARCHAR(500), -- Unique key for this metric combination
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for dashboard_cache
CREATE INDEX IF NOT EXISTS idx_cache_company ON dashboard_cache(company_guid);
CREATE INDEX IF NOT EXISTS idx_cache_type ON dashboard_cache(metric_type);
CREATE INDEX IF NOT EXISTS idx_cache_valid ON dashboard_cache(is_valid);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON dashboard_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_key ON dashboard_cache(cache_key);

-- =====================================================
-- 8. SYNC_LOGS TABLE (Track all sync operations)
-- =====================================================

CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) NOT NULL,
    
    -- Sync identification
    sync_id VARCHAR(255) UNIQUE NOT NULL, -- Unique ID for this sync session
    sync_type VARCHAR(50) NOT NULL, -- 'Full', 'Incremental', 'Selective'
    data_type VARCHAR(50) NOT NULL, -- 'Ledgers', 'Vouchers', 'Items', 'All'
    
    -- Status
    status VARCHAR(20) NOT NULL, -- 'Started', 'InProgress', 'Completed', 'Failed', 'PartiallyCompleted'
    
    -- Statistics
    records_total INTEGER,
    records_synced INTEGER,
    records_failed INTEGER,
    records_skipped INTEGER,
    records_updated INTEGER,
    records_inserted INTEGER,
    
    -- Timing
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    duration_seconds INTEGER,
    
    -- Date range synced
    from_date DATE,
    to_date DATE,
    
    -- Error handling
    error_message TEXT,
    error_details JSONB,
    warnings JSONB, -- Array of warning messages
    
    -- Configuration
    sync_config JSONB, -- Configuration used for this sync
    
    -- System
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for sync_logs
CREATE INDEX IF NOT EXISTS idx_sync_logs_company ON sync_logs(company_guid);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_date ON sync_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_sync_logs_type ON sync_logs(data_type);
CREATE INDEX IF NOT EXISTS idx_sync_logs_sync_id ON sync_logs(sync_id);

-- =====================================================
-- 9. AUDIT_LOGS TABLE (Complete change tracking)
-- =====================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    company_guid VARCHAR(255) NOT NULL,
    
    -- What changed
    table_name VARCHAR(100) NOT NULL,
    record_id INTEGER NOT NULL,
    record_guid VARCHAR(255),
    
    -- Action
    action VARCHAR(20) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    
    -- Changes
    old_values JSONB, -- Complete old record (for UPDATE/DELETE)
    new_values JSONB, -- Complete new record (for INSERT/UPDATE)
    changed_fields TEXT[], -- Array of field names that changed
    
    -- Who/When
    user_id INTEGER, -- If you add users table later
    user_name VARCHAR(200),
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Source
    change_source VARCHAR(50), -- 'TallySync', 'API', 'ManualEdit', 'BatchProcess', 'Migration'
    sync_id VARCHAR(255), -- Links to sync_logs if from sync
    
    -- Context
    ip_address VARCHAR(50),
    user_agent TEXT,
    
    -- System
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_guid);
CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_logs(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_logs(changed_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_logs(change_source);
CREATE INDEX IF NOT EXISTS idx_audit_sync ON audit_logs(sync_id);

-- =====================================================
-- 10. CONSTRAINTS & VALIDATION
-- =====================================================

-- Add check constraints for data validation
DO $$
BEGIN
    -- Check constraint for debit/credit exclusivity
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'check_debit_credit_exclusive'
    ) THEN
        ALTER TABLE voucher_line_items 
        ADD CONSTRAINT check_debit_credit_exclusive 
        CHECK (
            (debit_amount > 0 AND credit_amount = 0) OR 
            (debit_amount = 0 AND credit_amount > 0) OR 
            (debit_amount = 0 AND credit_amount = 0)
        );
    END IF;
END $$;

-- =====================================================
-- 11. FUNCTIONS & TRIGGERS (Optional but recommended)
-- =====================================================

-- Function to update ledger balances after voucher changes
CREATE OR REPLACE FUNCTION update_ledger_balance()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Update current balance in ledgers table
        UPDATE ledgers 
        SET current_balance = (
            SELECT COALESCE(SUM(debit_amount - credit_amount), 0)
            FROM voucher_line_items
            WHERE ledger_id = NEW.ledger_id
        )
        WHERE id = NEW.ledger_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trg_update_ledger_balance ON voucher_line_items;
CREATE TRIGGER trg_update_ledger_balance
AFTER INSERT OR UPDATE ON voucher_line_items
FOR EACH ROW
EXECUTE FUNCTION update_ledger_balance();

-- =====================================================
-- 12. VIEWS FOR COMMON QUERIES
-- =====================================================

-- View for complete voucher details with party info
CREATE OR REPLACE VIEW vw_vouchers_detailed AS
SELECT 
    v.id,
    v.voucher_guid,
    v.voucher_number,
    v.voucher_type,
    v.date,
    v.total_amount,
    v.narration,
    l.name as party_name,
    l.gstin as party_gstin,
    l.state as party_state,
    ba.city as billing_city,
    ba.state as billing_state,
    sa.city as shipping_city,
    sa.state as shipping_state,
    c.company_name,
    v.is_cancelled
FROM vouchers v
LEFT JOIN ledgers l ON v.party_ledger_id = l.id
LEFT JOIN addresses ba ON v.billing_address_id = ba.id
LEFT JOIN addresses sa ON v.shipping_address_id = sa.id
JOIN companies c ON v.company_guid = c.company_guid;

-- View for customer/vendor balances
CREATE OR REPLACE VIEW vw_ledger_balances AS
SELECT 
    l.id,
    l.ledger_guid,
    l.name,
    l.ledger_type,
    l.parent_group,
    l.opening_balance,
    l.current_balance,
    l.gstin,
    l.state,
    c.company_name,
    l.company_guid
FROM ledgers l
JOIN companies c ON l.company_guid = c.company_guid
WHERE l.active = TRUE;

-- =====================================================
-- VERIFICATION
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Schema migration completed!';
    RAISE NOTICE '';
    RAISE NOTICE 'Tables created/enhanced:';
    RAISE NOTICE '  1. companies (enhanced)';
    RAISE NOTICE '  2. ledgers (enhanced)';
    RAISE NOTICE '  3. addresses (new)';
    RAISE NOTICE '  4. items (new)';
    RAISE NOTICE '  5. vouchers (new)';
    RAISE NOTICE '  6. voucher_line_items (new)';
    RAISE NOTICE '  7. dashboard_cache (new)';
    RAISE NOTICE '  8. sync_logs (new)';
    RAISE NOTICE '  9. audit_logs (new)';
    RAISE NOTICE '';
    RAISE NOTICE 'Next step: Run data_migration_script.sql';
END $$;












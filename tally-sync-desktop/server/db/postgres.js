const { Pool } = require('pg');
const path = require('path');

// Load environment variables from tally-middleware root
const envPath = path.resolve(__dirname, '../../..', '.env');
console.log('Loading .env from:', envPath);
const result = require('dotenv').config({ path: envPath });
if (result.error) {
  console.error('Error loading .env:', result.error);
} else {
  console.log('✅ Environment variables loaded:', Object.keys(result.parsed || {}));
}
console.log('DATABASE_URL exists?', !!process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ WARNING: DATABASE_URL not found in environment variables!');
  console.warn('   Server will start but database operations will fail.');
  console.warn('   Please create a .env file in the root directory with:');
  console.warn('   DATABASE_URL=your_postgres_connection_string');
}

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum pool size
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000 // Connection timeout
}) : null;

// Test connection only once on startup
if (pool) {
  let isFirstConnection = true;
  
  pool.on('connect', () => {
    if (isFirstConnection) {
      console.log('✅ Connected to PostgreSQL (Neon)');
      isFirstConnection = false;
    }
  });

  pool.on('error', (err) => {
    console.error('❌ PostgreSQL connection error:', err);
  });

  // Verify connection on startup
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ Database connection test failed:', err.message);
    } else {
      console.log('✅ Database connection verified');
    }
  });
} else {
  console.warn('⚠️ Database pool not initialized (DATABASE_URL missing)');
}

// Create tables if they don't exist
const initDB = async () => {
  if (!pool) {
    throw new Error('DATABASE_URL not configured. Please set DATABASE_URL in .env file');
  }
  
  try {
    // Create vendors table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id SERIAL PRIMARY KEY,
        guid VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        business_id VARCHAR(255),
        opening_balance DECIMAL(15, 2) DEFAULT 0,
        current_balance DECIMAL(15, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        synced_at TIMESTAMP
      );
    `);
    await pool.query(`
      ALTER TABLE vendors
      ADD COLUMN IF NOT EXISTS business_id VARCHAR(255);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_guid ON vendors(guid);
      CREATE INDEX IF NOT EXISTS idx_vendor_name ON vendors(name);
      CREATE INDEX IF NOT EXISTS idx_vendor_business ON vendors(business_id);
    `);
    console.log('✅ Vendors table initialized');

    // Create customers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        guid VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        business_id VARCHAR(255),
        opening_balance DECIMAL(15, 2) DEFAULT 0,
        current_balance DECIMAL(15, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        synced_at TIMESTAMP
      );
    `);
    await pool.query(`
      ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS business_id VARCHAR(255);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_guid ON customers(guid);
      CREATE INDEX IF NOT EXISTS idx_customer_name ON customers(name);
      CREATE INDEX IF NOT EXISTS idx_customer_business ON customers(business_id);
    `);
    console.log('✅ Customers table initialized');

    // Create transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        guid VARCHAR(255) UNIQUE NOT NULL,
        voucher_number VARCHAR(100),
        voucher_type VARCHAR(50) NOT NULL,
        business_id VARCHAR(255),
        item_name VARCHAR(255),
        item_code VARCHAR(255),
        date DATE NOT NULL,
        party_name VARCHAR(255),
        amount DECIMAL(15, 2) NOT NULL,
        narration TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        synced_at TIMESTAMP
      );
    `);
    await pool.query(`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS business_id VARCHAR(255);
    `);
    await pool.query(`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS item_name VARCHAR(255);
    `);
    await pool.query(`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS item_code VARCHAR(255);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transaction_guid ON transactions(guid);
      CREATE INDEX IF NOT EXISTS idx_transaction_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_transaction_type ON transactions(voucher_type);
      CREATE INDEX IF NOT EXISTS idx_transaction_party ON transactions(party_name);
      CREATE INDEX IF NOT EXISTS idx_transaction_business ON transactions(business_id);
    `);
    console.log('✅ Transactions table initialized');

    // Create groups table
    await pool.query(`
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
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_groups_company ON groups(company_guid);
      CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent);
      CREATE INDEX IF NOT EXISTS idx_groups_primary ON groups(primary_group);
      CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);
    `);
    console.log('✅ Groups table initialized');

    // Create ledgers table
    await pool.query(`
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
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ledgers_company ON ledgers(company_guid);
      CREATE INDEX IF NOT EXISTS idx_ledgers_parent ON ledgers(parent_group);
      CREATE INDEX IF NOT EXISTS idx_ledgers_revenue ON ledgers(is_revenue) WHERE is_revenue = TRUE;
      CREATE INDEX IF NOT EXISTS idx_ledgers_name ON ledgers(name);
    `);
    console.log('✅ Ledgers table initialized');

    // Add company_guid to transactions if it doesn't exist
    await pool.query(`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_guid);
    `);

    // Create companies table
    await pool.query(`
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
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_companies_guid ON companies(company_guid);
    `);
    console.log('✅ Companies table initialized');

    // Add company_guid columns if they don't exist
    await pool.query(`
      ALTER TABLE vendors ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors(company_guid);
      CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_guid);
      CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_guid);
    `);

    // Add company_guid to analytics tables if they exist
    await pool.query(`
      DO $$ 
      BEGIN
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'vendor_scores') THEN
          ALTER TABLE vendor_scores ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
          CREATE INDEX IF NOT EXISTS idx_vendor_scores_company ON vendor_scores(company_guid);
        END IF;
        
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'outstanding_aging') THEN
          ALTER TABLE outstanding_aging ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
          CREATE INDEX IF NOT EXISTS idx_outstanding_aging_company ON outstanding_aging(company_guid);
        END IF;
        
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'payment_cycles') THEN
          ALTER TABLE payment_cycles ADD COLUMN IF NOT EXISTS company_guid VARCHAR(255);
          CREATE INDEX IF NOT EXISTS idx_payment_cycles_company ON payment_cycles(company_guid);
        END IF;
      END $$;
    `);
    console.log('✅ Company GUID columns added');

    console.log('✅ Database tables initialized successfully');

    // Update constraints for data bifurcation
    await updateSchemaConstraints();

  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
};

// Update constraints to allow same GUID for different companies
const updateSchemaConstraints = async () => {
  try {
    console.log('🔄 Checking schema constraints...');

    // Vendors
    await pool.query(`
      DO $$ 
      BEGIN
        -- Drop old unique constraint if exists
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_guid_key') THEN
          ALTER TABLE vendors DROP CONSTRAINT vendors_guid_key;
        END IF;
        
        -- Add new composite unique constraint if not exists
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_guid_company_key') THEN
          ALTER TABLE vendors ADD CONSTRAINT vendors_guid_company_key UNIQUE (guid, company_guid);
        END IF;
      END $$;
    `);

    // Customers
    await pool.query(`
      DO $$ 
      BEGIN
        -- Drop old unique constraint if exists
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_guid_key') THEN
          ALTER TABLE customers DROP CONSTRAINT customers_guid_key;
        END IF;
        
        -- Add new composite unique constraint if not exists
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_guid_company_key') THEN
          ALTER TABLE customers ADD CONSTRAINT customers_guid_company_key UNIQUE (guid, company_guid);
        END IF;
      END $$;
    `);

    // Transactions
    await pool.query(`
      DO $$ 
      BEGIN
        -- Drop old unique constraint if exists
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_guid_key') THEN
          ALTER TABLE transactions DROP CONSTRAINT transactions_guid_key;
        END IF;
        
        -- Add new composite unique constraint if not exists
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_guid_company_key') THEN
          ALTER TABLE transactions ADD CONSTRAINT transactions_guid_company_key UNIQUE (guid, company_guid);
        END IF;
      END $$;
    `);

    console.log('✅ Schema constraints updated for data bifurcation');
  } catch (error) {
    console.error('❌ Error updating schema constraints:', error.message);
    // Don't throw, just log - might fail if data violates new constraint (duplicates)
  }
};

// Refresh materialized views helper (used after sync/analytics)
async function refreshMaterializedViews() {
  if (!pool) {
    return { success: false, error: 'DATABASE_URL not configured' };
  }
  try {
    console.log('dY"S Refreshing materialized views...');
    const start = Date.now();
    await Promise.all([
      pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_vendor_aging_summary'),
      pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_customer_aging_summary'),
      pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_summary')
    ]);
    const duration = Date.now() - start;
    console.log(`�o. Materialized views refreshed in ${duration}ms`);
    return { success: true, duration };
  } catch (error) {
    console.warn('�s��,? Concurrent refresh failed, retrying without CONCURRENTLY:', error.message);
    try {
      await pool.query('REFRESH MATERIALIZED VIEW mv_vendor_aging_summary');
      await pool.query('REFRESH MATERIALIZED VIEW mv_customer_aging_summary');
      await pool.query('REFRESH MATERIALIZED VIEW mv_daily_summary');
      console.log('�o. Materialized views refreshed (non-concurrent)');
      return { success: true, fallback: true };
    } catch (retryError) {
      console.error('�?O Materialized view refresh failed:', retryError.message);
      return { success: false, error: retryError.message };
    }
  }
}

module.exports = { pool, initDB, refreshMaterializedViews };

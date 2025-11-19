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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL (Neon)');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL connection error:', err);
});

// Create tables if they don't exist
const initDB = async () => {
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

    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
};

module.exports = { pool, initDB };

const { Pool } = require('pg');
const path = require('path');

const envPath = path.resolve(__dirname, '../../..', '.env');
require('dotenv').config({ path: envPath });

const parseList = (value, fallback = []) => {
  if (!value || typeof value !== 'string') return [...fallback];
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
};

if (!process.env.DATABASE_URL) {
  console.warn('[WARN] DATABASE_URL not found in environment variables.');
  console.warn('       Add DATABASE_URL to your .env file to enable database operations.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_SIZE || 20),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

if (pool) {
  let firstConnect = true;
  pool.on('connect', () => {
    if (firstConnect) {
      console.log('[OK] Connected to PostgreSQL');
      firstConnect = false;
    }
  });

  pool.on('error', (err) => {
    console.error('[ERROR] PostgreSQL connection error:', err);
  });

  pool
    .query('SELECT NOW()')
    .then(() => console.log('[OK] Database connection verified'))
    .catch((err) => console.error('[ERROR] Database connection test failed:', err.message));
} else {
  console.warn('[WARN] Database pool not initialized (DATABASE_URL missing)');
}

const DEFAULT_CORE_TABLES = parseList(process.env.DB_CORE_TABLES, [
  'companies',
  'vouchers',
  'ledgers',
  'line_items'
]);

const REQUIRED_TABLES = Array.from(
  new Set([
    ...DEFAULT_CORE_TABLES,
    'voucher_line_items',
    'customers',
    'vendors',
    'transactions',
    'items',
    'payment_references',
    'sync_history',
    'sync_history_log',
    'vendor_scores',
    'outstanding_aging',
    'payment_cycles'
  ])
).filter(Boolean);

const tableExists = async (table) => {
  if (!pool) return false;
  const { rows } = await pool.query('SELECT to_regclass($1) as reg', [`public.${table}`]);
  return Boolean(rows[0]?.reg);
};

// Lightweight readiness check: verify connection + required tables
async function initDB() {
  if (!pool) {
    throw new Error('DATABASE_URL not configured. Please set DATABASE_URL in .env.');
  }

  await pool.query('SELECT 1'); // connectivity check

  const missing = [];
  for (const table of REQUIRED_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await tableExists(table);
    if (!exists) missing.push(table);
  }

  if (missing.length) {
    console.warn(`[WARN] Missing required tables: ${missing.join(', ')}`);
    console.warn('       Provide the full schema or enable DB_AUTO_MIGRATE=true to run bundled SQL files.');
  } else {
    console.log(`[OK] Detected ${REQUIRED_TABLES.length} core tables - DB schema looks ready.`);
  }

  return { ready: missing.length === 0, missing, checked: REQUIRED_TABLES };
}

// Refresh configured materialized views using env list
async function refreshMaterializedViews() {
  if (!pool) {
    return { success: false, error: 'DATABASE_URL not configured' };
  }

  const viewList = parseList(process.env.MATERIALIZED_VIEWS_LIST);
  if (!viewList.length) {
    return { success: false, error: 'No materialized views configured', skipped: true, refreshed: [] };
  }

  const refreshed = [];
  const skippedMissing = [];
  const errors = [];
  let fallback = false;
  const start = Date.now();

  for (const view of viewList) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      refreshed.push(view);
    } catch (err) {
      const message = err.message || '';
      if (message.toLowerCase().includes('does not exist')) {
        skippedMissing.push(view);
        continue;
      }

      if (message.toLowerCase().includes('concurrent')) {
        fallback = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await pool.query(`REFRESH MATERIALIZED VIEW ${view}`);
          refreshed.push(view);
          continue;
        } catch (retryErr) {
          errors.push({ view, error: retryErr.message });
          continue;
        }
      }

      errors.push({ view, error: message });
    }
  }

  return {
    success: errors.length === 0,
    duration: Date.now() - start,
    refreshed,
    skippedMissing,
    errors,
    fallback
  };
}

module.exports = { pool, initDB, refreshMaterializedViews };

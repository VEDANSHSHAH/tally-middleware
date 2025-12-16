const express = require('express');
const cors = require('cors');
const compression = require('compression'); // ADD THIS LINE
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const { CONFIG_FILE, loadConfig, saveConfig } = require('./utils/config');
const {
  getFallbackLastSync,
  getLastSyncTime,
  logSyncToHistory,
  shouldRunFullSync,
  updateSyncHistory
} = require('./services/syncHistory');
const setupAutoSync = require('./scheduler/autoSync');
const registerCompanyRoutes = require('./routes/companyRoutes');
const registerVendorRoutes = require('./routes/vendorRoutes');
const registerCustomerRoutes = require('./routes/customerRoutes');
const registerTransactionRoutes = require('./routes/transactionRoutes');
const registerMasterDataRoutes = require('./routes/masterDataRoutes');
const registerStatsRoutes = require('./routes/statsRoutes');
const registerAnalyticsRoutes = require('./routes/analyticsRoutes');
const {
  buildCompanyTag,
  currentCompanyTag,
  extractValue,
  formatTallyDate,
  formatTallyDateForDisplay
} = require('./utils/tallyHelpers');

// Load environment variables from the repo root with fallbacks
const envCandidates = [
  path.resolve(__dirname, '../..', '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '../../..', '.env')
];

let envLoadedFrom = null;
for (const candidate of envCandidates) {
  if (!fs.existsSync(candidate)) continue;
  const result = require('dotenv').config({ path: candidate });
  if (!result.error) {
    envLoadedFrom = candidate;
    break;
  }
  console.warn('Could not load .env at', candidate, '-', result.error.message);
}

if (!envLoadedFrom) {
  const fallback = require('dotenv').config();
  if (!fallback.error) {
    envLoadedFrom = path.resolve(process.cwd(), '.env');
  } else {
    console.warn('Could not load .env from any known location:', fallback.error.message);
  }
}

if (envLoadedFrom) {
  console.log('Environment variables loaded from:', envLoadedFrom);
}
const { pool, initDB, refreshMaterializedViews } = require('./db/postgres');
const { getCompanyInfo, getAllCompanies } = require('./tally/companyInfo');
const cache = require('./cache');
const { updateProgress, getProgress, resetProgress } = require('./syncProgress');
const { installMaterializedViews, refreshAllViews, checkMaterializedViewsExist } = require('./db/install-materialized-views');

let voucherRoutes = null;
try {
  voucherRoutes = require('./sync/voucherRoutes');
  console.log('✅ Voucher sync routes loaded');
} catch (err) {
  console.warn('⚠️ Voucher sync routes not available:', err.message);
}

let agingRoutes = null;
try {
  agingRoutes = require('./analytics/agingRoutes');
  console.log('✅ Aging routes loaded');
} catch (err) {
  console.warn('⚠️ Aging routes not available:', err.message);
}


// =====================================================
// INCREMENTAL SYNC HELPERS
// =====================================================

// ⭐ Import analytics functions
const {
  calculateVendorSettlementCycles,
  calculateOutstandingAging,
  calculateVendorScores
} = require('./analytics/paymentCycles');

// Lightweight in-memory rate limiter (fallback to avoid external dependency issues)
const makeSimpleRateLimiter = ({ windowMs, max }) => {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'global';
    const now = Date.now();
    const windowStart = now - windowMs;
    const bucket = hits.get(key) || [];
    const recent = bucket.filter(ts => ts > windowStart);
    recent.push(now);
    hits.set(key, recent);
    if (recent.length > max) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please slow down.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
    next();
  };
};

const app = express();
app.use(cors());
app.use(express.json());

// Rate limiting (protect API and AI calls) using lightweight limiter
const aiRateLimiter = makeSimpleRateLimiter({ windowMs: 60 * 1000, max: 10 });
// Desktop app calls many endpoints on load/poll; raise limit to avoid 429s
const generalRateLimiter = makeSimpleRateLimiter({ windowMs: 60 * 1000, max: 500 });
app.use('/api/ai/', aiRateLimiter);
app.use('/api/', generalRateLimiter);

// ADD THIS SECTION - Compression middleware
app.use(compression({
  // Compress all responses
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      // Don't compress responses if this request header is present
      return false;
    }
    // Fallback to standard compression filter
    return compression.filter(req, res);
  },
  // Compression level (0-9, where 9 is best compression but slowest)
  level: 6, // Good balance between speed and compression
  // Only compress responses larger than this (in bytes)
  threshold: 1024 // 1KB
}));

const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9000';
const PORT = process.env.PORT || 3001;
const DEFAULT_BUSINESS_ID = process.env.BUSINESS_ID || 'default-business';
const DEFAULT_BUSINESS_NAME = process.env.BUSINESS_NAME || 'Primary Business';
const BUSINESS_CACHE_MS = 5 * 60 * 1000;
let cachedBusinessMeta = null;
let cachedBusinessExpiry = 0;
const formatDateForDisplay = (date) => (date ? new Date(date).toLocaleString() : 'N/A');

// Robust name extraction for Tally XML (handles all formats)
const extractLedgerName = (ledger) => {
  if (!ledger) return '';
  
  // Method 1: Check $ attribute (XML attributes like NAME="AKASH")
  if (ledger.$ && ledger.$.NAME) {
    const name = ledger.$.NAME;
    if (typeof name === 'string') return name.trim();
    if (typeof name === 'object' && name._) return String(name._).trim();
  }
  
  // Method 2: Check direct NAME property
  if (ledger.NAME !== undefined && ledger.NAME !== null) {
    const name = ledger.NAME;
    
    // Direct string
    if (typeof name === 'string') {
      return name.trim();
    }
    
    // Object with _ property (xml2js format)
    if (typeof name === 'object') {
      if (name._ !== undefined) return String(name._).trim();
      if (name.$ !== undefined) return String(name.$).trim();
      if (name['#text'] !== undefined) return String(name['#text']).trim();
      
      // Last resort: find any string value in the object
      const values = Object.values(name);
      for (const val of values) {
        if (typeof val === 'string' && val.trim()) {
          return val.trim();
        }
      }
    }
  }
  
  // Method 3: extractValue fallback
  const extracted = extractValue(ledger.NAME);
  if (extracted && typeof extracted === 'string') {
    return extracted.trim();
  }
  
  return '';
};


// Friendly root handler so hitting "/" shows a message instead of "Cannot GET /"
app.get('/', (req, res) => {
  res.json({
    message: 'Tally Middleware API is running',
    docs: 'Use /api/test or other /api/* endpoints',
    port: PORT
  });
});

// Format currency in Indian format (₹ with commas)
function formatCurrency(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹0';
  return '₹' + Math.abs(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Initialize database on startup (read-only readiness check)
let dbInitStatus = null;
const dbReadyPromise = initDB()
  .then(status => {
    dbInitStatus = status;
    return status;
  })
  .catch(err => {
    console.error('⚠️ Failed to initialize database:', err.message);
    console.error('⚠️ Server will continue but database operations may fail');
    return null;
  });

// Run company migration on startup
async function runCompanyMigration() {
  try {
    const migrationSQL = fs.readFileSync(path.join(__dirname, 'db', 'company_migration.sql'), 'utf8');
    await pool.query(migrationSQL);
    console.log('✅ Company migration completed');
  } catch (error) {
    console.error('⚠️ Company migration error (may already be applied):', error.message);
  }
}

// Helper function to split SQL statements while respecting dollar-quoted strings
function splitSQLStatements(sql) {
  const statements = [];
  let currentStatement = '';
  let inDollarQuote = false;
  let dollarTag = '';
  
  const lines = sql.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let remainingLine = line;
    
    // Check for dollar-quoted strings ($$ or $tag$)
    while (remainingLine.length > 0) {
      if (!inDollarQuote) {
        // Look for start of dollar quote: $ followed by optional tag, followed by $
        const dollarMatch = remainingLine.match(/\$[a-zA-Z_]*\$/);
        if (dollarMatch) {
          dollarTag = dollarMatch[0];
          inDollarQuote = true;
          const beforeQuote = remainingLine.substring(0, dollarMatch.index);
          currentStatement += beforeQuote + dollarTag;
          remainingLine = remainingLine.substring(dollarMatch.index + dollarTag.length);
        } else {
          currentStatement += remainingLine;
          remainingLine = '';
        }
      } else {
        // Look for end of dollar quote (must match the opening tag)
        const endIndex = remainingLine.indexOf(dollarTag);
        if (endIndex !== -1) {
          currentStatement += remainingLine.substring(0, endIndex + dollarTag.length);
          remainingLine = remainingLine.substring(endIndex + dollarTag.length);
          inDollarQuote = false;
          dollarTag = '';
        } else {
          currentStatement += remainingLine;
          remainingLine = '';
        }
      }
    }
    
    currentStatement += '\n';
    
    // Only split on semicolon if we're NOT inside a dollar-quoted string
    if (!inDollarQuote && line.trim().endsWith(';')) {
      const trimmed = currentStatement.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        statements.push(trimmed);
      }
      currentStatement = '';
    }
  }
  
  // Add any remaining statement
  if (currentStatement.trim()) {
    statements.push(currentStatement.trim());
  }
  
  return statements;
}

// Run incremental sync migration on startup (auto-runs, no manual step needed!)
async function runIncrementalSyncMigration() {
  try {
    const migrationPath = path.join(__dirname, 'db', 'incremental_sync_migration.sql');
    if (fs.existsSync(migrationPath)) {
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
      // Split and run each statement using smart splitting
      const statements = splitSQLStatements(migrationSQL);

      for (const statement of statements) {
        try {
          await pool.query(statement);
        } catch (err) {
          // Ignore "already exists" errors
          if (!err.message.includes('already exists') &&
            !err.message.includes('duplicate') &&
            !err.message.includes('does not exist')) {
            console.warn('⚠️ Incremental sync migration statement error:', err.message.substring(0, 100));
          }
        }
      }
      console.log('✅ Incremental sync migration completed (auto-applied)');
    }
  } catch (error) {
    console.error('⚠️ Incremental sync migration error:', error.message);
  }
}

// Run all migrations on startup
async function runAllMigrations() {
  if (!pool) {
    console.warn('⚠️ Database not configured, skipping migrations');
    return;
  }
  const status = dbInitStatus || (await dbReadyPromise.catch(() => null));
  const autoMigrateEnabled = process.env.DB_AUTO_MIGRATE === 'true';

  if (status?.ready && !autoMigrateEnabled) {
    console.log('✅ Core schema detected; skipping bundled SQL migrations (DB_AUTO_MIGRATE=true to force).');
    return;
  }

  if (!autoMigrateEnabled) {
    const missingTables = status?.missing?.length ? ` Missing: ${status.missing.join(', ')}` : '';
    console.warn(`⚠️ DB_AUTO_MIGRATE not enabled; bundled SQL migrations skipped.${missingTables}`);
    console.warn('⚠️ Apply your managed schema or set DB_AUTO_MIGRATE=true to run local SQL helpers.');
    return;
  }

  if (status?.ready) {
    console.log('⚙️ DB_AUTO_MIGRATE=true - running bundled SQL helpers even though schema looks ready.');
  }

  await runCompanyMigration();
  await runIncrementalSyncMigration();
  await installMaterializedViews();
  await backfillCompanyGuidIfMissing();
}

// Auto-run migrations (safe to rerun; uses IF NOT EXISTS/ON CONFLICT guards)
dbReadyPromise.then(runAllMigrations).catch(err => {
  console.error('⚠️ Startup migrations failed (continuing):', err?.message || err);
});
// Backfill missing company_guid values for single-company setups (helps filters + incremental sync)
async function backfillCompanyGuidIfMissing() {
  try {
    if (!pool) return;
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    if (!companyGuid) return;

    const tables = ['vendors', 'customers', 'transactions'];
    for (const table of tables) {
      const distinct = await pool.query(
        `SELECT COUNT(DISTINCT company_guid) AS distinct_count,
                SUM(CASE WHEN company_guid IS NULL THEN 1 ELSE 0 END) AS null_count
         FROM ${table}`
      );
      const distinctCount = Number(distinct.rows[0]?.distinct_count || 0);
      const nullCount = Number(distinct.rows[0]?.null_count || 0);

      if (nullCount === 0) continue;
      if (distinctCount > 1) {
        console.warn(`Skipping company_guid backfill for ${table}: multiple companies detected (${distinctCount})`);
        continue;
      }

      const result = await pool.query(
        `UPDATE ${table}
         SET company_guid = $1, synced_at = COALESCE(synced_at, NOW())
         WHERE company_guid IS NULL`,
        [companyGuid]
      );
      console.log(`Backfilled company_guid for ${result.rowCount} ${table} row(s) with ${companyGuid}`);
    }
  } catch (error) {
    console.warn('company_guid backfill skipped:', error.message);
  }
}

// Helper function to query Tally with retry logic
async function queryTally(xmlRequest, options = {}) {
  const {
    timeout = 30000, // Increased to 30s for large queries
    retries = 3,
    retryDelay = 1000,
    queryType = 'unknown'
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔄 Retry ${attempt}/${retries} for ${queryType}...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt)); // Exponential backoff
      }

      // If timeout is 0, disable timeout (sync indefinitely)
      const axiosConfig = {
        headers: { 'Content-Type': 'application/xml' }
      };
      if (timeout > 0) {
        axiosConfig.timeout = timeout;
      }
      // If timeout is 0, axios will wait indefinitely
      const response = await axios.post(TALLY_URL, xmlRequest, axiosConfig);

      const parser = new xml2js.Parser({ explicitArray: false });
      return await parser.parseStringPromise(response.data);
    } catch (error) {
      lastError = error;

      // Don't retry on non-timeout errors
      if (!error.message.includes('timeout') && !error.code?.includes('ECONN')) {
        console.error(`❌ Tally query error (${queryType}):`, error.message);
        throw error;
      }

      if (attempt < retries) {
        console.warn(`⚠️  Tally timeout (${queryType}), retrying... (${attempt}/${retries})`);
      }
    }
  }

  console.error(`❌ Tally query failed after ${retries} attempts (${queryType}):`, lastError.message);
  throw lastError;
}

// Load group hierarchy either from database or directly from Tally (used for nested vendor/customer groups)
async function loadGroupHierarchy(companyGuid, companyName) {
  const groupMap = new Map();
  if (!companyGuid) return groupMap;
  const companyTag = buildCompanyTag(companyName);

  // Helper to add a group and track whether Sundry groups are present
  let hasSundryGroups = false;
  const addGroup = (name, parent, primaryGroup) => {
    const trimmedName = (name || '').trim();
    if (!trimmedName) return;

    const parentVal = (parent || '').trim();
    const primaryVal = (primaryGroup || '').trim();

    const key = trimmedName.toLowerCase();
    groupMap.set(key, {
      parent: parentVal.toLowerCase(),
      primaryGroup: primaryVal.toLowerCase()
    });

    if (
      key === 'sundry creditors' ||
      key === 'sundry debtors' ||
      primaryVal.toLowerCase() === 'sundry creditors' ||
      primaryVal.toLowerCase() === 'sundry debtors'
    ) {
      hasSundryGroups = true;
    }
  };

  // Try database first so we do not hit Tally on every sync.
  try {
    if (pool) {
      const dbGroups = await pool.query(
        'SELECT name, parent, primary_group FROM groups WHERE company_guid = $1',
        [companyGuid]
      );
      dbGroups.rows.forEach(row => addGroup(row.name, row.parent, row.primary_group));
    }
  } catch (error) {
    console.warn('Could not load groups from database for filtering:', error.message);
  }

  // If DB data is missing/partial (no Sundry groups detected), enrich from Tally.
  if (groupMap.size === 0 || !hasSundryGroups) {
    try {
      const groupRequest = `
        <ENVELOPE>
          <HEADER>
            <VERSION>1</VERSION>
            <TALLYREQUEST>Export</TALLYREQUEST>
            <TYPE>Collection</TYPE>
            <ID>Group Collection</ID>
          </HEADER>
          <BODY>
            <DESC>
              <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                ${companyTag}
              </STATICVARIABLES>
              <TDL>
                <TDLMESSAGE>
                  <COLLECTION NAME="Group Collection">
                    <TYPE>Group</TYPE>
                    <FETCH>GUID, Name, Parent, PrimaryGroup</FETCH>
                  </COLLECTION>
                </TDLMESSAGE>
              </TDL>
            </DESC>
          </BODY>
        </ENVELOPE>
      `;

      const result = await queryTally(groupRequest, { timeout: 40000, retries: 1, queryType: 'group_lookup' });
      const groups = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP;
      const groupArray = Array.isArray(groups) ? groups : (groups ? [groups] : []);

      groupArray.forEach(group => {
        const name = extractValue(group?.NAME);
        const parent = extractValue(group?.PARENT);
        const primaryGroup = extractValue(group?.PRIMARYGROUP);
        addGroup(name, parent, primaryGroup);
      });

      if (groupMap.size > 0) {
        console.log(`Loaded ${groupMap.size} groups from Tally for group filtering${hasSundryGroups ? '' : ' (no Sundry groups seen in DB, using Tally data)'}`);
      }
    } catch (error) {
      console.warn('Could not load groups from Tally for filtering:', error.message);
    }
  }

  return groupMap;
}

// Check if a ledger's parent group ultimately belongs to a target primary group (e.g., Sundry Creditors).
function isUnderPrimaryGroup(groupName, targetPrimaryGroup, groupsMap) {
  if (!groupName || !targetPrimaryGroup) return false;

  const target = targetPrimaryGroup.trim().toLowerCase();
  let current = groupName.trim().toLowerCase();

  if (current === target) {
    return true;
  }

  if (!groupsMap || groupsMap.size === 0) {
    // No hierarchy info available; only match direct parent.
    return current === target;
  }

  const visited = new Set();

  while (current && !visited.has(current)) {
    visited.add(current);
    const group = groupsMap.get(current);

    if (!group) break;

    if (group.primaryGroup === target || group.parent === target) {
      return true;
    }

    current = group.parent;
  }

  return false;
}

async function getBusinessMetadata(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedBusinessMeta && cachedBusinessExpiry > now) {
    return cachedBusinessMeta;
  }
  const config = loadConfig();
  const companyTag = currentCompanyTag(config);

  const xmlRequest = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>Company Collection</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            ${companyTag}
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="Company Collection">
                <TYPE>Company</TYPE>
                <FETCH>NAME, REMOTECMPID, GUID</FETCH>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;

  try {
    const result = await queryTally(xmlRequest, { queryType: 'business_metadata' });
    const companies = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    if (!companies) {
      throw new Error('Company data not returned');
    }
    const companyArray = Array.isArray(companies) ? companies : [companies];
    const company = companyArray[0];
    const meta = {
      id: extractValue(company?.REMOTECMPID) || extractValue(company?.GUID) || DEFAULT_BUSINESS_ID,
      name: extractValue(company?.NAME) || DEFAULT_BUSINESS_NAME
    };
    cachedBusinessMeta = meta;
    cachedBusinessExpiry = now + BUSINESS_CACHE_MS;
    return meta;
  } catch (error) {
    console.warn('Unable to fetch business metadata from Tally:', error.message);
    const fallback = {
      id: process.env.BUSINESS_ID || DEFAULT_BUSINESS_ID,
      name: process.env.BUSINESS_NAME || DEFAULT_BUSINESS_NAME
    };
    cachedBusinessMeta = fallback;
    cachedBusinessExpiry = now + BUSINESS_CACHE_MS;
    return fallback;
  }
}

function summarizeInventoryEntries(voucher) {
  const rawEntries =
    voucher?.['ALLINVENTORYENTRIES.LIST'] ||
    voucher?.ALLINVENTORYENTRIES?.LIST ||
    voucher?.['INVENTORYENTRIESIN.LIST'] ||
    voucher?.['INVENTORYENTRIESOUT.LIST'];
  if (!rawEntries) {
    return { itemName: null, itemCode: null };
  }
  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  const names = [];
  const codes = [];

  entries.forEach(entry => {
    if (!entry) return;
    const name = extractValue(entry?.STOCKITEMNAME)
      || extractValue(entry?.['STOCKITEMNAME.LIST']?.NAME);
    const code = extractValue(entry?.ITEMCODE)
      || extractValue(entry?.STOCKITEMCODE)
      || extractValue(entry?.PARTNUMBER);
    if (name) names.push(name);
    if (code) codes.push(code);
  });

  const uniqueNames = [...new Set(names)].join(', ');
  const uniqueCodes = [...new Set(codes)].join(', ');

  return {
    itemName: uniqueNames ? uniqueNames.substring(0, 255) : null,
    itemCode: uniqueCodes ? uniqueCodes.substring(0, 255) : null
  };
}

registerCompanyRoutes(app, {
  axios,
  currentCompanyTag,
  fs,
  TALLY_URL,
  pool,
  getCompanyInfo,
  getAllCompanies,
  loadConfig,
  saveConfig,
  CONFIG_FILE,
  DEFAULT_BUSINESS_ID,
  DEFAULT_BUSINESS_NAME,
  xml2js
});
// ==================== VOUCHER SYNC (NEW - Normalized Tables) ====================
if (voucherRoutes) {
  app.use('/api/sync/vouchers', voucherRoutes);
  app.use('/api/vouchers', voucherRoutes);
}
if (agingRoutes) {
  app.use('/api/aging', agingRoutes);
}

registerVendorRoutes(app, {
  axios,
  cache,
  currentCompanyTag,
  formatTallyDate,
  getCompanyInfo,
  logSyncToHistory,
  loadConfig,
  pool,
  shouldRunFullSync,
  updateSyncHistory,
  queryTally
});
registerCustomerRoutes(app, {
  axios,
  cache,
  currentCompanyTag,
  formatTallyDate,
  getCompanyInfo,
  logSyncToHistory,
  loadConfig,
  pool,
  shouldRunFullSync,
  updateSyncHistory,
  queryTally
});
registerTransactionRoutes(app, {
  axios,
  cache,
  currentCompanyTag,
  formatDateForDisplay,
  formatTallyDate,
  formatTallyDateForDisplay,
  getCompanyInfo,
  getFallbackLastSync,
  getLastSyncTime,
  loadConfig,
  logSyncToHistory,
  pool,
  shouldRunFullSync,
  updateSyncHistory,
  queryTally
});

registerMasterDataRoutes(app, {
  axios,
  extractLedgerName,
  extractValue,
  formatCurrency,
  formatDateForDisplay,
  formatTallyDate,
  formatTallyDateForDisplay,
  getCompanyInfo,
  loadConfig,
  pool,
  queryTally
});

registerStatsRoutes(app, {
  cache,
  formatCurrency,
  loadConfig,
  pool
});

registerAnalyticsRoutes(app, {
  cache,
  calculateOutstandingAging,
  calculateVendorScores,
  calculateVendorSettlementCycles,
  formatCurrency,
  loadConfig,
  pool,
  refreshAllViews,
  refreshMaterializedViews
});
// Group/Ledger routes moved to routes/masterDataRoutes.js
// ==================== PAYMENT REFERENCES SYNC ====================

// Build payment reference records from recently-synced receipts
async function syncPaymentReferences(companyGuid) {
  if (!pool) throw new Error('Database not configured');

  const result = await pool.query(
    `
      INSERT INTO payment_references (
        company_guid,
        payment_voucher_id,
        payment_voucher_guid,
        payment_voucher_number,
        payment_date,
        invoice_voucher_id,
        invoice_voucher_guid,
        invoice_voucher_number,
        invoice_date,
        allocated_amount,
        allocation_type,
        party_ledger_id,
        party_name,
        synced_from_tally
      )
      SELECT DISTINCT
        pv.company_guid,
        pv.id,
        pv.voucher_guid,
        pv.voucher_number,
        pv.date,
        iv.id,
        iv.voucher_guid,
        vli.reference_name,
        vli.reference_date,
        vli.reference_amount,
        COALESCE(vli.reference_type, 'Against Reference'),
        pv.party_ledger_id,
        pv.party_name,
        TRUE
      FROM voucher_line_items vli
      JOIN vouchers pv ON vli.voucher_id = pv.id
      LEFT JOIN vouchers iv ON iv.voucher_number = vli.reference_name 
        AND iv.company_guid = pv.company_guid
        AND iv.party_ledger_id = pv.party_ledger_id
      WHERE pv.company_guid = $1
        AND pv.voucher_type IN ('RECEIPT', 'Payment Received')
        AND vli.reference_name IS NOT NULL
        AND vli.reference_amount IS NOT NULL
        AND vli.reference_amount > 0
        AND pv.synced_at > NOW() - INTERVAL '1 hour'
      ON CONFLICT DO NOTHING
    `,
    [companyGuid]
  );

  return result.rowCount || 0;
}

// Manual trigger endpoint (used by auto-sync after transactions)
app.post('/api/sync/payment-references', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    const inserted = await syncPaymentReferences(companyGuid);
    res.json({
      success: true,
      message: `Payment references synced (${inserted} new)`,
      count: inserted
    });
  } catch (error) {
    console.error('Payment reference sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Sync transactions from Tally to PostgreSQL
app.post('/api/sync/transactions', async (req, res) => {
  try {
    console.log('🔄 Starting transaction sync from Tally...');

    // Get company GUID from config
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    // Verify that the currently open company in Tally matches the selected company
    console.log(`🔍 Checking Tally company... Selected: "${config.company.name}" (${companyGuid})`);
    const tallyCompanyInfo = await getCompanyInfo(config?.company?.name);

    if (!tallyCompanyInfo || !tallyCompanyInfo.guid) {
      return res.json({
        success: false,
        error: 'Could not detect company from Tally. Make sure Tally is running and a company is open.'
      });
    }

    console.log(`🔍 Tally has open: "${tallyCompanyInfo.name}" (${tallyCompanyInfo.guid})`);
    console.log(`🔍 Selected in app: "${config.company.name}" (${companyGuid})`);

    if (tallyCompanyInfo.guid.toLowerCase() !== companyGuid.toLowerCase()) {
      return res.json({
        success: false,
        error: `Company mismatch!\n\nTally has: "${tallyCompanyInfo.name}"\nGUID: ${tallyCompanyInfo.guid}\n\nYou selected: "${config.company.name}"\nGUID: ${companyGuid}\n\nPlease:\n1. Open "${config.company.name}" in Tally\n2. Or change your selection to "${tallyCompanyInfo.name}" in the app\n3. Then try syncing again.`
      });
    }

    console.log(`✅ Verified: Tally company "${tallyCompanyInfo.name}" matches selected company "${config.company.name}"`);

    // =====================================================
    // INCREMENTAL SYNC LOGIC
    // =====================================================
    const syncStartTime = Date.now();
    const { startDate, endDate, forceFullSync } = req.body;
    let fromDate;
    let toDate = endDate || new Date().toISOString().split('T')[0];
    let syncMode = 'full';
    let syncReason = '';
    let alteredAfter = null;

    // Check if we should run incremental or full sync
    const syncDecision = await shouldRunFullSync(companyGuid, 'transactions');

    if (forceFullSync) {
      // User requested full sync
      syncMode = 'full';
      syncReason = 'user_requested';
      fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      console.log(`📅 Force full sync requested - syncing last 365 days`);
    } else if (startDate) {
      // User specified start date - use it (custom range)
      fromDate = startDate;
      syncMode = 'custom';
      syncReason = 'custom_date_range';
      console.log(`📅 Custom date range: ${fromDate} to ${toDate}`);
    } else if (syncDecision.isFullSync) {
      // Full sync needed (first sync or stale data)
      syncMode = 'full';
      syncReason = syncDecision.reason;
      fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      console.log(`📅 Full sync (${syncReason}) - syncing last 365 days (from ${fromDate})`);
    } else {
      // Incremental sync - only get data since last sync
      syncMode = 'incremental';
      syncReason = 'incremental';
      const lastSyncDate = new Date(syncDecision.lastSyncTime);
      // Go back 2 hours before last sync to catch edge cases without re-syncing whole days
      lastSyncDate.setHours(lastSyncDate.getHours() - 2);
      fromDate = lastSyncDate.toISOString().split('T')[0];
      alteredAfter = formatTallyDate(lastSyncDate); // Use ALTERDATE for true incremental
      console.log(`⚡ INCREMENTAL sync - fetching only data since ${fromDate}`);
      console.log(`   Last successful sync: ${formatDateForDisplay(syncDecision.lastSyncTime)}`);
    }

    console.log(`📅 Syncing transactions from ${fromDate} to ${toDate}`);

    // Tally expects YYYYMMDD format for date filters
    const tallyFromDate = formatTallyDate(fromDate);
    const tallyToDate = formatTallyDate(toDate);

    // Build TDL so we can retry without AlteredOn when incremental returns empty
    const buildTransactionRequest = (tallyFrom, tallyTo, alteredAfterDate) => `
      <ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Voucher Collection</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              <SVFROMDATE>${tallyFrom}</SVFROMDATE>
              <SVTODATE>${tallyTo}</SVTODATE>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Voucher Collection">
                  <TYPE>Voucher</TYPE>
                  <FETCH>GUID, VoucherNumber, VoucherTypeName, Date, PartyLedgerName, Amount, Narration, AlteredOn, AlterId, ALLINVENTORYENTRIES.LIST:STOCKITEMNAME, ALLINVENTORYENTRIES.LIST:ITEMCODE</FETCH>
                  ${alteredAfterDate ? '<FILTER>ModifiedSince</FILTER>' : ''}
                </COLLECTION>
                ${alteredAfterDate ? `
                <SYSTEM TYPE="Formulae" NAME="ModifiedSince">
                  $AlteredOn >= $$Date:##SVAlteredAfter
                </SYSTEM>
                <VARIABLE NAME="SVAlteredAfter" TYPE="Date">${alteredAfterDate}</VARIABLE>
                ` : ''}
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    // Initial Tally API call: 15 minute timeout to detect if Tally is dead/unresponsive
    // If Tally is responding and data is coming, we'll get the data within this time
    // If Tally is completely dead, we'll error out after 15 minutes instead of waiting forever
    let result = await queryTally(buildTransactionRequest(tallyFromDate, tallyToDate, alteredAfter), {
      timeout: 900000, // 15 minutes - enough for very large datasets, but detects if Tally is dead
      retries: 3, // Retry 3 times if connection fails
      queryType: 'transaction_sync'
    });

    let vouchers = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER;
    let voucherArray = Array.isArray(vouchers) ? vouchers : (vouchers ? [vouchers] : []);

    // Incremental sometimes returns nothing because AlteredOn is blank; retry without the filter
    if (syncMode === 'incremental' && alteredAfter && voucherArray.length === 0) {
      console.warn('ƒsÿ‹,? Incremental transaction sync returned 0 vouchers; retrying without AlteredOn filter...');
      try {
        syncMode = 'incremental_fallback';
        syncReason = 'incremental_empty';
        result = await queryTally(buildTransactionRequest(tallyFromDate, tallyToDate, null), {
          timeout: 900000,
          retries: 2,
          queryType: 'transaction_sync_incremental_fallback'
        });
        vouchers = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER;
        voucherArray = Array.isArray(vouchers) ? vouchers : (vouchers ? [vouchers] : []);
        console.log(`ƒo. Incremental fallback pulled ${voucherArray.length} vouchers`);
      } catch (fallbackError) {
        console.warn('ƒsÿ‹,? Incremental fallback failed:', fallbackError.message);
      }
    }

	    if (!voucherArray.length) {
	      const syncDuration = Date.now() - syncStartTime;

	      // Record "no changes" so incremental window advances instead of always redoing full sync
	      await updateSyncHistory(
	        companyGuid,
	        'transactions',
	        0,
	        syncDuration,
	        syncMode,
	        fromDate,
	        toDate,
	        null
	      );
	      await logSyncToHistory(
	        companyGuid,
	        'transactions',
	        new Date(syncStartTime),
	        0,
	        syncDuration,
	        syncMode,
	        fromDate,
	        toDate,
	        null
	      );
	      resetProgress('transaction');

	      return res.json({
	        success: true,
	        message: 'No transactions found in Tally for the specified period',
	        count: 0,
	        syncMode,
	        syncReason,
	        duration: `${Math.round(syncDuration / 1000)}s`
	      });
	    }

    const totalTransactions = voucherArray.length;
    console.log(`Found ${totalTransactions} transactions - processing in batches (NO TIMEOUT - will sync until complete)...`);

    const { id: businessId } = await getBusinessMetadata();

    let syncedCount = 0;
    let errors = [];
    const BATCH_SIZE = 50; // Process 50 at a time to avoid memory issues
    const totalBatches = Math.ceil(voucherArray.length / BATCH_SIZE);
    const failedBatches = []; // Track batches that failed for retry later

    // Initialize progress tracking
    updateProgress('transaction', {
      inProgress: true,
      total: totalTransactions,
      current: 0,
      startTime: Date.now(),
      totalBatches
    });

    console.log(`🔄 Starting batch processing: ${totalBatches} batches of ${BATCH_SIZE} transactions each`);
    console.log(`⏱️  NO TIMEOUT - Sync will continue until all ${totalTransactions} transactions are processed`);
    console.log(`📊 Progress tracking: Will monitor batch completion to ensure data is flowing`);
    console.log(`🔄 Retry logic: Failed batches will be retried after all other batches complete`);

    let lastBatchCompletionTime = Date.now();
    const STUCK_THRESHOLD = 600000; // 10 minutes - if no batch completes in 10 min, something is wrong

    // Process in batches - NO TIMEOUT, continues until all batches complete
    // But monitors if batches are actually completing (data is flowing)
    for (let i = 0; i < voucherArray.length; i += BATCH_SIZE) {
      const batchStartTime = Date.now();
      const batch = voucherArray.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(voucherArray.length / BATCH_SIZE);
      const percentage = Math.round((i / voucherArray.length) * 100);

      console.log(`📦 Processing batch ${batchNum}/${totalBatches} (${percentage}% complete) - ${batch.length} transactions`);

      // Prepare bulk upsert using VALUES
      const values = [];
      const placeholders = [];
      let paramIndex = 1;

      for (const voucher of batch) {
        try {
          const guid = voucher.GUID?._ || voucher.GUID;
          const voucherNumber = voucher.VOUCHERNUMBER?._ || voucher.VOUCHERNUMBER || 'N/A';
          const voucherType = voucher.VOUCHERTYPENAME?._ || voucher.VOUCHERTYPENAME;
          const date = voucher.DATE?._ || voucher.DATE;
          const partyName = voucher.PARTYLEDGERNAME?._ || voucher.PARTYLEDGERNAME || '';
          const amount = Math.abs(parseFloat(voucher.AMOUNT?._ || voucher.AMOUNT || 0));
          const narration = voucher.NARRATION?._ || voucher.NARRATION || '';
          const { itemName, itemCode } = summarizeInventoryEntries(voucher);

          // Format date from Tally format (YYYYMMDD) to PostgreSQL format (YYYY-MM-DD)
          let formattedDate = date;
          if (date && date.length === 8) {
            formattedDate = `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
          }

          // Add to bulk values
          placeholders.push(
            `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, NOW())`
          );
          values.push(
            guid, voucherNumber, voucherType, businessId, companyGuid,
            itemName, itemCode, formattedDate, partyName, amount, narration
          );
          paramIndex += 11;
        } catch (err) {
          console.error(`Error preparing transaction:`, err);
          errors.push({
            voucher: voucher.VOUCHERNUMBER?._ || voucher.VOUCHERNUMBER || 'unknown',
            error: err.message
          });
        }
      }

      // Execute bulk upsert for this batch
      if (values.length > 0) {
        try {
          const query = `
            INSERT INTO transactions (
              guid, voucher_number, voucher_type, business_id, company_guid, 
              item_name, item_code, date, party_name, amount, narration, synced_at
            )
            VALUES ${placeholders.join(', ')}
            ON CONFLICT (guid, company_guid) 
            DO UPDATE SET
              voucher_number = EXCLUDED.voucher_number,
              voucher_type = EXCLUDED.voucher_type,
              business_id = EXCLUDED.business_id,
              item_name = EXCLUDED.item_name,
              item_code = EXCLUDED.item_code,
              date = EXCLUDED.date,
              party_name = EXCLUDED.party_name,
              amount = EXCLUDED.amount,
              narration = EXCLUDED.narration,
              synced_at = NOW(),
              updated_at = NOW()
          `;

          await pool.query(query, values);
          syncedCount += batch.length;

          const batchDuration = Date.now() - batchStartTime;
          lastBatchCompletionTime = Date.now(); // Update last completion time

          // Check if batch took unusually long (warn but continue)
          if (batchDuration > 300000) { // 5 minutes per batch is unusually slow
            console.warn(`⚠️  Batch ${batchNum} took ${Math.round(batchDuration / 1000)}s (${Math.round(batchDuration / 60000)}min) - this is slow but continuing...`);
          }

          // Update progress
          updateProgress('transaction', {
            current: syncedCount,
            currentBatch: batchNum
          });

          console.log(`✅ Batch ${batchNum}/${totalBatches} completed in ${Math.round(batchDuration / 1000)}s - ${syncedCount}/${totalTransactions} synced (${getProgress('transaction').percentage}%)`);

          // Clear memory between batches
          if (global.gc) {
            global.gc();
          }

          // Safety check: If we've been stuck (no batch completion for extended period), error out
          // This should never happen in normal flow, but protects against infinite loops
          const timeSinceLastCompletion = Date.now() - lastBatchCompletionTime;
          if (timeSinceLastCompletion > STUCK_THRESHOLD && batchNum < totalBatches) {
            throw new Error(`Sync appears stuck - no batch completed in ${Math.round(STUCK_THRESHOLD / 60000)} minutes. Last completed: batch ${batchNum}/${totalBatches}. Check database connection.`);
          }
        } catch (err) {
          console.error(`❌ Error in batch ${batchNum}:`, err.message);

          // Store failed batch for retry later (don't add to errors yet - will retry)
          failedBatches.push({
            batchNum,
            batch,
            values,
            placeholders,
            error: err.message,
            attempt: 1
          });

          // If database connection error, wait a bit before next batch
          if (err.message.includes('timeout') || err.message.includes('connection') || err.message.includes('ECONN')) {
            console.warn(`⚠️  Database connection issue in batch ${batchNum} - will retry after all batches complete`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            console.warn(`⚠️  Batch ${batchNum} failed (${err.message}) - will retry after all batches complete`);
          }

          // Don't add to errors array yet - we'll retry after all batches are done
          // Only add to errors if retry also fails
        }
      }
    }

    // Retry failed batches after all other batches are done
    if (failedBatches.length > 0) {
      console.log(`\n🔄 Retrying ${failedBatches.length} failed batch(es) after all other batches completed...`);

      for (const failedBatch of failedBatches) {
        const { batchNum, batch, values, placeholders, error: originalError, attempt } = failedBatch;
        console.log(`🔄 Retrying batch ${batchNum} (attempt ${attempt + 1})...`);

        try {
          const query = `
            INSERT INTO transactions (
              guid, voucher_number, voucher_type, business_id, company_guid, 
              item_name, item_code, date, party_name, amount, narration, synced_at
            )
            VALUES ${placeholders.join(', ')}
            ON CONFLICT (guid, company_guid) 
            DO UPDATE SET
              voucher_number = EXCLUDED.voucher_number,
              voucher_type = EXCLUDED.voucher_type,
              business_id = EXCLUDED.business_id,
              item_name = EXCLUDED.item_name,
              item_code = EXCLUDED.item_code,
              date = EXCLUDED.date,
              party_name = EXCLUDED.party_name,
              amount = EXCLUDED.amount,
              narration = EXCLUDED.narration,
              synced_at = NOW(),
              updated_at = NOW()
          `;

          await pool.query(query, values);
          syncedCount += batch.length;

          console.log(`✅ Batch ${batchNum} retry successful - ${batch.length} transactions synced`);

          // Update progress
          updateProgress('transaction', {
            current: syncedCount,
            currentBatch: batchNum
          });

          // Remove from failed batches (successfully retried)
          const index = failedBatches.indexOf(failedBatch);
          if (index > -1) {
            failedBatches.splice(index, 1);
          }
        } catch (retryError) {
          console.error(`❌ Batch ${batchNum} retry failed:`, retryError.message);

          // Track final error
          errors.push({
            batch: batchNum,
            error: retryError.message,
            originalError: originalError,
            attempts: attempt + 1
          });

          // If connection error, wait before next retry
          if (retryError.message.includes('timeout') || retryError.message.includes('connection') || retryError.message.includes('ECONN')) {
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3s for retries
          }
        }
      }

      if (failedBatches.length === 0) {
        console.log(`✅ All failed batches retried successfully!`);
      } else {
        console.log(`⚠️  ${failedBatches.length} batch(es) still failed after retry`);
      }
    }

    const syncDuration = Date.now() - syncStartTime;
    console.log(`✅ Synced ${syncedCount} transactions in ${Math.round(syncDuration / 1000)}s (${syncMode} mode)`);

    // Update last_sync timestamp in companies table
    await pool.query(
      'UPDATE companies SET last_sync = NOW() WHERE company_guid = $1',
      [companyGuid]
    );
    console.log(`✅ Updated last_sync timestamp for company ${companyGuid}`);

    // =====================================================
    // UPDATE SYNC HISTORY (for incremental sync tracking)
    // =====================================================
    await updateSyncHistory(
      companyGuid,
      'transactions',
      syncedCount,
      syncDuration,
      syncMode,
      fromDate,
      toDate,
      errors.length > 0 ? `${errors.length} errors during sync` : null
    );

    // Log to sync history for full audit trail
    await logSyncToHistory(
      companyGuid,
      'transactions',
      new Date(syncStartTime),
      syncedCount,
      syncDuration,
      syncMode,
      fromDate,
      toDate,
      errors.length > 0 ? `${errors.length} errors` : null
    );

    // Reset progress
    resetProgress('transaction');

      res.json({
        success: true,
        message: `Successfully synced ${syncedCount} transactions from Tally (${syncMode} sync)`,
        count: syncedCount,
        total: totalTransactions,
        period: { from: fromDate, to: toDate },
        syncMode: syncMode,
        syncReason: syncReason,
        duration: `${Math.round(syncDuration / 1000)}s`,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
        errorCount: errors.length
      });

      // Auto-run analytics right after a transaction sync so dashboards stay fresh
      try {
        console.log('dY"S Auto-calculating analytics after transaction sync...');
        await calculateVendorSettlementCycles(companyGuid);
        await calculateOutstandingAging(companyGuid);
        await calculateVendorScores(companyGuid);
        await refreshMaterializedViews();
        cache.deletePattern(`stats:${companyGuid}*`);
        cache.deletePattern(`aging:${companyGuid}*`);
        console.log('�o. Analytics refreshed post-sync');
      } catch (analyticsError) {
        console.warn('�s��,? Analytics refresh after sync failed:', analyticsError.message);
      }

      // Invalidate cache after successful sync
      if (companyGuid) {
        cache.deletePattern(`stats:${companyGuid}*`);
        cache.deletePattern(`aging:${companyGuid}*`);
      cache.deletePattern(`customers:${companyGuid}*`);
      cache.deletePattern(`transactions:${companyGuid}*`);
      console.log(`🗑️  Cache invalidated for company: ${companyGuid}`);
    }
  } catch (error) {
    const syncDuration = Date.now() - (typeof syncStartTime !== 'undefined' ? syncStartTime : Date.now());
    console.error('Transaction sync error:', error);

    // Log failed sync to history
    const config = loadConfig();
    if (config?.company?.guid) {
      await logSyncToHistory(
        config.company.guid,
        'transactions',
        new Date(),
        0,
        syncDuration,
        'failed',
        null,
        null,
        error.message
      );
    }

    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Make sure Tally is running and port 9000 is accessible'
    });
  }
});

// ==================== SYNC PROGRESS ====================

// Get sync progress for real-time updates
app.get('/api/sync/progress', (req, res) => {
  res.json(getProgress());
});

// ==================== SYNC HISTORY ====================

// Get sync history (for incremental sync tracking)
app.get('/api/sync/history', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured' });
    }

    const { dataType, limit = 50 } = req.query;

    let query = `
      SELECT 
        id,
        data_type,
        last_sync_at,
        records_synced,
        sync_duration_ms,
        sync_mode,
        from_date,
        to_date,
        error_message,
        created_at
      FROM sync_history
      WHERE company_guid = $1
    `;
    const params = [companyGuid];

    if (dataType) {
      query += ` AND data_type = $2`;
      params.push(dataType);
    }

    query += ` ORDER BY last_sync_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    // Also get last sync times per data type
    const lastSyncTimes = await pool.query(`
      SELECT 
        data_type,
        last_sync_at,
        records_synced,
        sync_mode,
        sync_duration_ms
      FROM sync_history
      WHERE company_guid = $1
      ORDER BY data_type
    `, [companyGuid]);

    res.json({
      success: true,
      history: result.rows,
      count: result.rows.length,
      lastSyncByType: lastSyncTimes.rows.reduce((acc, row) => {
        acc[row.data_type] = {
          lastSync: row.last_sync_at,
          recordsSynced: row.records_synced,
          mode: row.sync_mode,
          duration: row.sync_duration_ms
        };
        return acc;
      }, {})
    });
  } catch (error) {
    console.error('Error fetching sync history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get full sync history log (all syncs, not just latest per type)
app.get('/api/sync/history/log', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured' });
    }

    const { dataType, limit = 100 } = req.query;

    let query = `
      SELECT *
      FROM sync_history_log
      WHERE company_guid = $1
    `;
    const params = [companyGuid];

    if (dataType) {
      query += ` AND data_type = $2`;
      params.push(dataType);
    }

    query += ` ORDER BY sync_started_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      log: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching sync history log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Force full sync (reset incremental sync)
app.post('/api/sync/reset', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured' });
    }

    const { dataType } = req.body;

    if (dataType) {
      // Reset specific data type
      await pool.query(
        'DELETE FROM sync_history WHERE company_guid = $1 AND data_type = $2',
        [companyGuid, dataType]
      );
      console.log(`🔄 Reset sync history for ${dataType}`);
    } else {
      // Reset all data types
      await pool.query(
        'DELETE FROM sync_history WHERE company_guid = $1',
        [companyGuid]
      );
      console.log(`🔄 Reset all sync history for company ${companyGuid}`);
    }

    res.json({
      success: true,
      message: dataType
        ? `Sync history reset for ${dataType}. Next sync will be a full sync.`
        : 'All sync history reset. Next syncs will be full syncs.'
    });
  } catch (error) {
    console.error('Error resetting sync history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stats routes moved to routes/statsRoutes.js
// Analytics routes moved to routes/analyticsRoutes.js
// ==================== MATERIALIZED VIEWS TEST ENDPOINT ====================

// Test materialized views performance comparison
app.get('/api/test/materialized-views', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured' });
    }

    const results = {};

    // Test 1: Regular query (legacy)
    const startLegacy = Date.now();
    await pool.query(`
      SELECT v.name, COUNT(t.id) as txn_count, SUM(ABS(t.amount)) as total
      FROM vendors v
      LEFT JOIN transactions t ON LOWER(t.party_name) = LOWER(v.name) AND t.company_guid = v.company_guid
      WHERE v.company_guid = $1
      GROUP BY v.id, v.name
      LIMIT 100
    `, [companyGuid]);
    results.legacyQuery = Date.now() - startLegacy;

    // Test 2: Materialized view query
    const startMV = Date.now();
    try {
      await pool.query(`
        SELECT vendor_name, transaction_count, total_outstanding
        FROM mv_vendor_aging_summary
        WHERE company_guid = $1
        LIMIT 100
      `, [companyGuid]);
      results.materializedView = Date.now() - startMV;
    } catch (mvErr) {
      results.materializedView = null;
      results.materializedViewError = mvErr.message;
    }

    // Test 3: Refresh time
    const startRefresh = Date.now();
    try {
      await pool.query('SELECT refresh_all_materialized_views()');
      results.refreshTime = Date.now() - startRefresh;
    } catch (refreshErr) {
      results.refreshTime = null;
      results.refreshError = refreshErr.message;
    }

    // Calculate improvement
    if (results.materializedView && results.legacyQuery) {
      const improvement = Math.round(results.legacyQuery / results.materializedView);
      results.improvement = `${improvement}x faster`;
    }

    // Check if views exist
    const viewsExist = await checkMaterializedViewsExist();

    res.json({
      success: true,
      viewsInstalled: viewsExist,
      results: {
        legacyQuery: results.legacyQuery ? `${results.legacyQuery}ms` : 'N/A',
        materializedView: results.materializedView ? `${results.materializedView}ms` : results.materializedViewError || 'N/A',
        refreshTime: results.refreshTime ? `${results.refreshTime}ms` : results.refreshError || 'N/A',
        improvement: results.improvement || 'N/A'
      },
      recommendation: results.materializedView && results.materializedView < 50
        ? '✅ Materialized views are working perfectly!'
        : results.materializedView
          ? '⚠️ Consider adding more indexes or checking data volume'
          : '❌ Materialized views not installed. Restart server to auto-install.'
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get vendor scores
app.get('/api/analytics/vendor-scores', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'No company selected'
      });
    }

    console.log(`🏆 Fetching vendor scores for GUID: ${companyGuid}`);

    const result = await pool.query(`
      SELECT 
        vs.*,
        v.name as vendor_name,
        v.current_balance
      FROM vendor_scores vs
      JOIN vendors v ON v.id = vs.vendor_id
      WHERE (vs.company_guid = $1 OR v.company_guid = $1)
      ORDER BY vs.overall_score DESC
    `, [companyGuid]);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error('Vendor scores error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Performance dashboard (sync history + reliability)
app.get('/api/dashboard/performance', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured. Please run setup first.' });
    }

    const [syncHistory, stats] = await Promise.all([
      pool.query(`
        SELECT 
          data_type,
          last_sync_at,
          records_synced,
          sync_duration_ms,
          sync_mode,
          EXTRACT(EPOCH FROM (NOW() - last_sync_at)) / 3600 as hours_ago
        FROM sync_history
        WHERE company_guid = $1
        ORDER BY last_sync_at DESC
        LIMIT 30
      `, [companyGuid]),
      pool.query(`
        SELECT 
          data_type,
          COUNT(*) as total_syncs,
          AVG(sync_duration_ms) as avg_duration,
          AVG(records_synced) as avg_records,
          SUM(CASE WHEN error_message IS NOT NULL THEN 1 ELSE 0 END) as error_count
        FROM sync_history_log
        WHERE company_guid = $1
        AND sync_started_at > NOW() - INTERVAL '7 days'
        GROUP BY data_type
      `, [companyGuid])
    ]);

    res.json({
      success: true,
      history: syncHistory.rows,
      stats: stats.rows
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Customer payment patterns (cycle + reliability)
app.get('/api/analytics/payment-patterns', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured. Please run setup first.' });
    }

    const patterns = await pool.query(`
      WITH customer_payments AS (
        SELECT 
          party_name,
          date,
          amount,
          LAG(date) OVER (PARTITION BY party_name ORDER BY date) as prev_payment_date,
          EXTRACT(DAY FROM date - LAG(date) OVER (PARTITION BY party_name ORDER BY date)) as days_between_payments
        FROM transactions
        WHERE company_guid = $1
        AND voucher_type LIKE '%Receipt%'
        AND party_name IS NOT NULL
        AND date > NOW() - INTERVAL '6 months'
      )
      SELECT 
        party_name,
        COUNT(*) as payment_count,
        AVG(days_between_payments) as avg_payment_cycle,
        STDDEV(days_between_payments) as payment_consistency,
        MAX(date) as last_payment_date,
        EXTRACT(DAY FROM NOW() - MAX(date)) as days_since_last_payment,
        SUM(amount) as total_paid
      FROM customer_payments
      WHERE days_between_payments IS NOT NULL
      GROUP BY party_name
      HAVING COUNT(*) >= 2
      ORDER BY avg_payment_cycle DESC
      LIMIT 50
    `, [companyGuid]);

    const enriched = patterns.rows.map(p => {
      const consistency = Number(p.payment_consistency) || 0;
      const avgCycle = Number(p.avg_payment_cycle) || 30;

      const reliabilityScore = Math.max(0, Math.min(100,
        100 - (consistency / avgCycle * 100)
      ));

      const lastPaymentTime = p.last_payment_date
        ? new Date(p.last_payment_date).getTime()
        : Date.now();
      const predictedNextPayment = new Date(
        lastPaymentTime +
        (avgCycle * 24 * 60 * 60 * 1000)
      );

      const daysOverdue = (Number(p.days_since_last_payment) || 0) - avgCycle;
      const riskLevel = daysOverdue > avgCycle * 0.5 ? 'high' :
        daysOverdue > avgCycle * 0.2 ? 'medium' : 'low';

      return {
        ...p,
        reliability_score: Math.round(reliabilityScore),
        predicted_next_payment: predictedNextPayment,
        days_overdue: Math.max(0, Math.round(daysOverdue)),
        risk_level: riskLevel
      };
    });

    res.json({
      success: true,
      patterns: enriched
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Revenue trends + simple forecast
app.get('/api/analytics/revenue-trends', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured. Please run setup first.' });
    }

    const trends = await pool.query(`
      WITH monthly_revenue AS (
        SELECT 
          DATE_TRUNC('month', date) as month,
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as revenue,
          COUNT(DISTINCT party_name) as unique_customers,
          COUNT(*) as transaction_count
        FROM transactions
        WHERE company_guid = $1
        AND voucher_type LIKE '%Sales%'
        AND date >= DATE_TRUNC('month', NOW() - INTERVAL '12 months')
        GROUP BY DATE_TRUNC('month', date)
        ORDER BY month DESC
      )
      SELECT 
        month,
        revenue,
        unique_customers,
        transaction_count,
        LAG(revenue) OVER (ORDER BY month) as prev_month_revenue,
        ((revenue - LAG(revenue) OVER (ORDER BY month)) / 
         NULLIF(LAG(revenue) OVER (ORDER BY month), 0) * 100) as growth_rate
      FROM monthly_revenue
    `, [companyGuid]);

    const recentRevenue = trends.rows.slice(0, 3).map(r => Number(r.revenue) || 0);
    const avgRecent = recentRevenue.length
      ? recentRevenue.reduce((a, b) => a + b, 0) / recentRevenue.length
      : 0;

    let growthRate = 0;
    const forecast = [];

    if (trends.rows.length) {
      const lastMonth = trends.rows[0]?.month ? new Date(trends.rows[0].month) : new Date();
      growthRate = Number(trends.rows[0]?.growth_rate) || 0;

      for (let i = 1; i <= 3; i += 1) {
        const forecastMonth = new Date(lastMonth);
        forecastMonth.setMonth(forecastMonth.getMonth() + i);

        forecast.push({
          month: forecastMonth,
          forecasted_revenue: avgRecent * (1 + (growthRate / 100))
        });
      }
    }

    res.json({
      success: true,
      trends: trends.rows,
      forecast,
      summary: {
        current_month: Number(trends.rows[0]?.revenue) || 0,
        avg_monthly: avgRecent,
        growth_rate: growthRate
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Smart collection priority list
app.get('/api/analytics/collection-priority', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured. Please run setup first.' });
    }

    const priority = await pool.query(`
      WITH customer_metrics AS (
        SELECT 
          c.name,
          c.current_balance,
          oa.total_outstanding,
          oa.current_0_30_days,
          oa.current_31_60_days,
          oa.current_61_90_days,
          oa.current_over_90_days,
          (
            (oa.current_over_90_days * 4) + 
            (oa.current_61_90_days * 3) + 
            (oa.current_31_60_days * 2) + 
            (oa.current_0_30_days * 1)
          ) / NULLIF(oa.total_outstanding, 0) * 100 as risk_score,
          (
            SELECT MAX(date) 
            FROM transactions t 
            WHERE t.party_name = c.name 
            AND t.voucher_type LIKE '%Receipt%'
          ) as last_payment_date,
          (
            SELECT COUNT(*) 
            FROM transactions t 
            WHERE t.party_name = c.name 
            AND t.voucher_type LIKE '%Receipt%'
            AND t.date > NOW() - INTERVAL '6 months'
          ) as payment_count
        FROM customers c
        LEFT JOIN outstanding_aging oa ON oa.entity_name = c.name
        WHERE c.company_guid = $1
        AND c.current_balance > 0
      )
      SELECT 
        name,
        current_balance,
        total_outstanding,
        current_0_30_days,
        current_31_60_days,
        current_61_90_days,
        current_over_90_days,
        risk_score,
        last_payment_date,
        payment_count,
        EXTRACT(DAY FROM NOW() - last_payment_date) as days_since_payment,
        (
          (risk_score * 0.4) + 
          (LEAST(EXTRACT(DAY FROM NOW() - last_payment_date), 90) * 0.3) +
          ((total_outstanding / 10000) * 0.3)
        ) as priority_score
      FROM customer_metrics
      WHERE total_outstanding > 0
      ORDER BY priority_score DESC
      LIMIT 20
    `, [companyGuid]);

    res.json({
      success: true,
      priorities: priority.rows
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Overdue analysis summary
app.get('/api/analytics/overdue-analysis', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured. Please run setup first.' });
    }

      // Join to customers/vendors to derive display name instead of relying on entity_name column
      const analysis = await pool.query(`
        WITH base AS (
          SELECT 
            oa.*,
            COALESCE(c.name, v.name, 'Unknown') AS entity_name
          FROM outstanding_aging oa
          LEFT JOIN customers c ON oa.customer_id = c.id AND oa.company_guid = c.company_guid
          LEFT JOIN vendors v ON oa.vendor_id = v.id AND oa.company_guid = v.company_guid
          WHERE oa.company_guid = $1
            AND oa.entity_type = 'customer'
            AND (oa.current_31_60_days + oa.current_61_90_days + oa.current_over_90_days) > 0
        ),
        overdue_summary AS (
          SELECT 
            SUM(current_31_60_days + current_61_90_days + current_over_90_days) AS total_overdue,
            SUM(current_31_60_days) AS overdue_30_60,
            SUM(current_61_90_days) AS overdue_60_90,
            SUM(current_over_90_days) AS overdue_90_plus,
            COUNT(DISTINCT entity_name) AS overdue_customers
          FROM base
        ),
        top_overdue AS (
          SELECT 
            entity_name,
            (current_31_60_days + current_61_90_days + current_over_90_days) AS overdue_amount,
            current_over_90_days,
            current_61_90_days,
            current_31_60_days
          FROM base
          ORDER BY overdue_amount DESC
          LIMIT 10
        )
        SELECT 
          json_build_object(
            'total_overdue', os.total_overdue,
            'overdue_30_60', os.overdue_30_60,
            'overdue_60_90', os.overdue_60_90,
            'overdue_90_plus', os.overdue_90_plus,
            'overdue_customers', os.overdue_customers
          ) AS summary,
          COALESCE(
            json_agg(to_overdue.*) FILTER (WHERE to_overdue.entity_name IS NOT NULL),
            '[]'::json
          ) AS top_overdue
        FROM overdue_summary os
        LEFT JOIN top_overdue to_overdue ON true
        GROUP BY os.total_overdue, os.overdue_30_60, os.overdue_60_90, 
                 os.overdue_90_plus, os.overdue_customers
      `, [companyGuid]);

    res.json({
      success: true,
      data: analysis.rows[0] || { summary: {}, top_overdue: [] }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Real-time aging calculation (non-materialized)
app.get('/api/analytics/aging-realtime', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    const requestedType = (req.query.entityType || 'customer').toLowerCase();
    const isVendor = requestedType === 'vendor' || requestedType === 'vendors';
    const entityType = isVendor ? 'vendor' : 'customer';
    const amountFilter = isVendor ? 'amount < 0' : 'amount > 0';

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured. Please run setup first.' });
    }

    const aging = await pool.query(`
      WITH party_transactions AS (
        SELECT 
          party_name,
          date,
          amount,
          EXTRACT(DAY FROM NOW() - date) as days_old
        FROM transactions
        WHERE company_guid = $1
        AND party_name IS NOT NULL
        AND amount != 0
        AND ${amountFilter}
      )
      SELECT 
        party_name as entity_name,
        '${entityType}' as entity_type,
        SUM(ABS(amount)) as total_outstanding,
        SUM(CASE WHEN days_old <= 30 THEN ABS(amount) ELSE 0 END) as current_0_30_days,
        SUM(CASE WHEN days_old > 30 AND days_old <= 60 THEN ABS(amount) ELSE 0 END) as current_31_60_days,
        SUM(CASE WHEN days_old > 60 AND days_old <= 90 THEN ABS(amount) ELSE 0 END) as current_61_90_days,
        SUM(CASE WHEN days_old > 90 THEN ABS(amount) ELSE 0 END) as current_over_90_days,
        NOW() as calculated_at
      FROM party_transactions
      GROUP BY party_name
      HAVING SUM(ABS(amount)) > 0
      ORDER BY total_outstanding DESC
    `, [companyGuid]);

    res.json({
      success: true,
      data: aging.rows,
      calculated_at: new Date().toISOString(),
      note: 'Real-time calculation (updated just now)'
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Trigger analytics calculation
app.post('/api/analytics/calculate', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'No company selected'
      });
    }

    console.log(`📊 Calculating analytics for GUID: ${companyGuid}`);
    const analyticsStart = Date.now();

    // Pass companyGuid to calculation functions
    await calculateVendorSettlementCycles(companyGuid);
    await calculateOutstandingAging(companyGuid);
    await calculateVendorScores(companyGuid);

    // ⚡ Refresh materialized views for fast queries
    const refreshResult = await refreshMaterializedViews();

    const analyticsDuration = Date.now() - analyticsStart;

    res.json({
      success: true,
      message: `Analytics calculated successfully in ${Math.round(analyticsDuration / 1000)}s`,
      duration: `${analyticsDuration}ms`,
      materializedViewsRefreshed: refreshResult.success
    });

    // Invalidate cache after analytics calculation
    if (companyGuid) {
      cache.deletePattern(`stats:${companyGuid}`);
      cache.deletePattern(`aging:${companyGuid}*`);
      console.log(`🗑️  Cache invalidated for company: ${companyGuid}`);
    }
  } catch (error) {
    console.error('Calculate analytics error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// DASHBOARD API - Cached dashboard payload per company
// =====================================================
app.get('/api/company/:guid/dashboard', async (req, res) => {
  const { guid } = req.params;

  try {
    console.log(`📊 Dashboard request for company: ${guid}`);

    // Fetch cached dashboard metrics
    const result = await pool.query(
      `
        SELECT 
          metric_type,
          metric_data,
          calculated_at
        FROM dashboard_cache
        WHERE company_guid = $1
          AND is_valid = TRUE
          AND expires_at > NOW()
          AND metric_type != 'test_metric'
        ORDER BY metric_type
      `,
      [guid]
    );

    if (result.rows.length === 0) {
      console.log('⚠️ No dashboard data found in cache');
      return res.status(404).json({
        error: 'No dashboard data found. Please sync first.',
        company_guid: guid
      });
    }

    // Fetch company name (best effort)
    const companyResult = await pool.query(
      'SELECT company_name FROM companies WHERE company_guid = $1',
      [guid]
    );

    // Transform rows into a friendly response
    const dashboard = {
      company_guid: guid,
      company_name: companyResult.rows[0]?.company_name || 'Unknown',
      updated_at: result.rows[0].calculated_at
    };

    result.rows.forEach(row => {
      dashboard[row.metric_type] = row.metric_data;
    });

    console.log(`✅ Dashboard sent: ${result.rows.length} metrics`);
    res.json(dashboard);
  } catch (error) {
    console.error('❌ Dashboard API error:', error);
    res.status(500).json({
      error: error.message,
      company_guid: guid
    });
  }
});

// =====================================================
// DASHBOARD REFRESH - Invalidate cache (recalc on next sync)
// =====================================================
app.post('/api/company/:guid/dashboard/refresh', async (req, res) => {
  const { guid } = req.params;

  try {
    console.log(`🔄 Dashboard refresh requested for: ${guid}`);

    // Invalidate cached metrics for this company; next sync should repopulate
    await pool.query(
      `
        UPDATE dashboard_cache
        SET is_valid = FALSE
        WHERE company_guid = $1
      `,
      [guid]
    );

    res.json({
      message: 'Dashboard cache invalidated. Will recalculate on next sync.',
      company_guid: guid
    });
  } catch (error) {
    console.error('❌ Dashboard refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// COMPANIES LIST (for dropdowns/mobile apps)
// =====================================================
app.get('/api/companies', async (req, res) => {
  try {
    console.log('📋 Companies list requested');

    const result = await pool.query(`
      SELECT 
        company_guid,
        company_name,
        last_sync,
        verified
      FROM companies
      ORDER BY company_name
    `);

    res.json({
      count: result.rows.length,
      companies: result.rows
    });
  } catch (error) {
    console.error('❌ Companies API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/api/health', async (req, res) => {
  try {
    // DB heartbeat
    await pool.query('SELECT NOW()');

    // Cache stats (best effort)
    const cacheStats = await pool.query(`
      SELECT 
        COUNT(*)::int AS total_metrics,
        COUNT(*) FILTER (WHERE is_valid AND metric_type != 'test_metric')::int AS valid_metrics,
        COUNT(DISTINCT company_guid)::int AS companies_cached
      FROM dashboard_cache
    `);

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      cache: cacheStats.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// ==================== AUTO-SYNC SCHEDULER ====================
const {
  startAutoSync,
  stopAutoSync,
  SYNC_INTERVAL
} = setupAutoSync(app, { port: PORT, refreshMaterializedViews });

// Start server with auto-sync
const server = app.listen(PORT, () => {
  console.log(`
Tally Middleware Server Started`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Tally: ${TALLY_URL}`);
  const dbStatus = pool ? 'Connected' : 'Not configured (DATABASE_URL missing)';
  console.log(`Database: ${dbStatus}`);
  if (!pool) {
    console.log('   Create a .env file in the root directory with:');
    console.log('   DATABASE_URL=your_postgres_connection_string');
  }
  console.log(`
Available endpoints:`);
  console.log(`   GET  /api/test`);
  console.log(`   GET  /api/test-odbc`);
  console.log(`   GET  /api/company/detect`);
  console.log(`   POST /api/company/verify`);
  console.log(`   POST /api/company/setup`);
  console.log(`   GET  /api/company/config`);
  console.log(`   POST /api/company/reset`);
  console.log(`   GET  /api/vendors`);
  console.log(`   GET  /api/vendors/:id`);
  console.log(`   POST /api/sync/vendors`);
  console.log(`   GET  /api/customers`);
  console.log(`   GET  /api/customers/:id`);
  console.log(`   POST /api/sync/customers`);
  console.log(`   GET  /api/transactions`);
  console.log(`   GET  /api/transactions/search`);
  console.log(`   GET  /api/transactions/:id`);
  console.log(`   POST /api/sync/transactions`);
  console.log(`   GET  /api/sync/history`);
  console.log(`   GET  /api/sync/history/log`);
  console.log(`   POST /api/sync/reset`);
  console.log(`   GET  /api/stats`);
  console.log(`   GET  /api/dashboard/performance`);
  console.log(`   GET  /api/analytics/vendor-scores`);
  console.log(`   GET  /api/analytics/aging`);
  console.log(`   GET  /api/analytics/payment-cycles`);
  console.log(`   POST /api/analytics/calculate`);
  console.log(`   GET  /api/test/materialized-views`);
  console.log(`
Auto-sync: Every ${Math.round(SYNC_INTERVAL / 60000)} minutes`);
  console.log(`First sync scheduled in 10 seconds...
`);

  startAutoSync();
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
ERROR: Port ${PORT} is already in use!`);
    console.error(`   Another process is using port ${PORT}`);
    console.error(`   Please close that process or change PORT in .env file
`);
  } else {
    console.error(`
ERROR: Failed to start server:`, err.message);
  }
  // Don't exit - let Electron handle it
});

// Graceful shutdown handlers
const shutdown = (signal) => {
  console.log(`
${signal} received, shutting down gracefully...`);
  stopAutoSync();
  server.close(() => {
    console.log('Server closed');
    pool.end(() => {
      console.log('Database connection closed');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

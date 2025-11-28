const express = require('express');
const cors = require('cors');
const compression = require('compression'); // ADD THIS LINE
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

// Load environment variables from root directory
const envPath = path.resolve(__dirname, '../../..', '.env');
console.log('Loading .env from:', envPath);
const envResult = require('dotenv').config({ path: envPath });
if (envResult.error) {
  console.warn('⚠️ Could not load .env file:', envResult.error.message);
  console.warn('   Trying current directory...');
  require('dotenv').config(); // Fallback to current directory
} else {
  console.log('✅ Environment variables loaded from:', envPath);
}

const { pool, initDB, refreshMaterializedViews } = require('./db/postgres');
const { getCompanyInfo, getAllCompanies } = require('./tally/companyInfo');
const cache = require('./cache');
const { updateProgress, getProgress, resetProgress } = require('./syncProgress');
const { installMaterializedViews, refreshAllViews, checkMaterializedViewsExist } = require('./db/install-materialized-views');

// =====================================================
// INCREMENTAL SYNC HELPERS
// =====================================================

// Get last sync time for a data type
async function getLastSyncTime(companyGuid, dataType) {
  try {
    if (!pool) return null;
    const result = await pool.query(
      'SELECT get_last_sync_time($1, $2) as last_sync',
      [companyGuid, dataType]
    );
    return result.rows[0]?.last_sync || null;
  } catch (error) {
    // Function might not exist yet (before migration)
    console.warn('⚠️ Could not get last sync time (run incremental migration?):', error.message);
    return null;
  }
}

// Update sync history
async function updateSyncHistory(companyGuid, dataType, recordsCount, durationMs, mode, fromDate = null, toDate = null, errorMessage = null) {
  try {
    if (!pool) return;
    await pool.query(
      'SELECT update_sync_history($1, $2, $3, $4, $5, $6, $7, $8)',
      [companyGuid, dataType, recordsCount, durationMs, mode, fromDate, toDate, errorMessage]
    );
    console.log(`📊 Sync history updated: ${dataType} - ${recordsCount} records (${mode} mode) in ${Math.round(durationMs / 1000)}s`);
  } catch (error) {
    // Function might not exist yet (before migration)
    console.warn('⚠️ Could not update sync history (run incremental migration?):', error.message);
  }
}

// Log sync to history log (keeps full history)
async function logSyncToHistory(companyGuid, dataType, syncStartedAt, recordsCount, durationMs, mode, fromDate, toDate, errorMessage = null) {
  try {
    if (!pool) return;
    await pool.query(`
      INSERT INTO sync_history_log (
        company_guid, data_type, sync_started_at, sync_completed_at, 
        records_synced, sync_duration_ms, sync_mode, from_date, to_date, error_message
      ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9)
    `, [companyGuid, dataType, syncStartedAt, recordsCount, durationMs, mode, fromDate, toDate, errorMessage]);
  } catch (error) {
    // Table might not exist yet
    console.warn('⚠️ Could not log sync history:', error.message);
  }
}

// Check if this should be a full or incremental sync
async function shouldRunFullSync(companyGuid, dataType) {
  const lastSync = await getLastSyncTime(companyGuid, dataType);

  if (!lastSync) {
    console.log(`📋 No previous sync found for ${dataType} - Running FULL sync`);
    return { isFullSync: true, lastSyncTime: null, reason: 'first_sync' };
  }

  // If last sync was more than 7 days ago, run full sync for data consistency
  const daysSinceLastSync = (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceLastSync > 7) {
    console.log(`📋 Last sync was ${Math.floor(daysSinceLastSync)} days ago - Running FULL sync for consistency`);
    return { isFullSync: true, lastSyncTime: lastSync, reason: 'stale_data' };
  }

  console.log(`📋 Last sync: ${new Date(lastSync).toLocaleString()} - Running INCREMENTAL sync ⚡`);
  return { isFullSync: false, lastSyncTime: lastSync, reason: 'incremental' };
}

// Format date for Tally TDL query (YYYYMMDD or YYYY-MM-DD)
function formatTallyDate(date, format = 'tally') {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  if (format === 'tally') {
    return `${year}${month}${day}`; // YYYYMMDD for Tally
  }
  return `${year}-${month}-${day}`; // YYYY-MM-DD for PostgreSQL
}

// Format date for display
function formatDateForDisplay(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleString();
}

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
const generalRateLimiter = makeSimpleRateLimiter({ windowMs: 60 * 1000, max: 100 });
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
const PORT = process.env.PORT || 3000;
const DEFAULT_BUSINESS_ID = process.env.BUSINESS_ID || 'default-business';
const DEFAULT_BUSINESS_NAME = process.env.BUSINESS_NAME || 'Primary Business';
const BUSINESS_CACHE_MS = 5 * 60 * 1000;
let cachedBusinessMeta = null;
let cachedBusinessExpiry = 0;

// Company config file path
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// Load config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return null;
}

// Save config
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('✅ Config saved:', config);
  } catch (error) {
    console.error('❌ Error saving config:', error);
  }
}

const extractValue = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && '_' in value) return value._;
  return value;
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

// Initialize database on startup (don't exit on error, just log it)
initDB().catch(err => {
  console.error('⚠️ Failed to initialize database:', err.message);
  console.error('⚠️ Server will continue but database operations may fail');
  // Don't exit - let server start anyway so we can see the error
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

// Run incremental sync migration on startup (auto-runs, no manual step needed!)
async function runIncrementalSyncMigration() {
  try {
    const migrationPath = path.join(__dirname, 'db', 'incremental_sync_migration.sql');
    if (fs.existsSync(migrationPath)) {
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
      // Split and run each statement
      const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

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
  await runCompanyMigration();
  await runIncrementalSyncMigration();

  // Install materialized views (auto-install on startup!)
  await installMaterializedViews();
}

// Auto-run migrations (safe to rerun; uses IF NOT EXISTS/ON CONFLICT guards)
runAllMigrations().catch(err => {
  console.error('⚠️ Startup migrations failed (continuing):', err.message);
});
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

async function getBusinessMetadata(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedBusinessMeta && cachedBusinessExpiry > now) {
    return cachedBusinessMeta;
  }

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

// Test endpoint
app.get('/api/test', (req, res) => {
  const dbStatus = pool ? 'Connected' : 'Not configured (DATABASE_URL missing)';
  res.json({
    message: 'Tally Middleware is running',
    timestamp: new Date(),
    database: dbStatus,
    databaseUrl: process.env.DATABASE_URL ? 'Configured' : 'Missing',
    tallyUrl: TALLY_URL,
    status: 'ok'
  });
});

// Test ODBC connection to Tally
app.get('/api/test-odbc', async (req, res) => {
  try {
    console.log('🔍 Testing ODBC connection to Tally...');
    const startTime = Date.now();

    // Try a simple request to Tally
    const testXml = `
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
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Company Collection">
                  <TYPE>Company</TYPE>
                  <FETCH>NAME, GUID</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    const response = await axios.post(TALLY_URL, testXml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000 // 15 seconds for test
    });

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // Try to parse response
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);

    const companies = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    const companyCount = companies ? (Array.isArray(companies) ? companies.length : 1) : 0;

    res.json({
      success: true,
      message: 'ODBC connection successful',
      tallyUrl: TALLY_URL,
      responseTime: `${responseTime}ms`,
      companiesFound: companyCount,
      status: 'connected'
    });
  } catch (error) {
    console.error('❌ ODBC test failed:', error.message);

    let errorDetails = {
      success: false,
      message: 'ODBC connection failed',
      tallyUrl: TALLY_URL,
      error: error.message
    };

    if (error.code === 'ECONNREFUSED') {
      errorDetails.status = 'connection_refused';
      errorDetails.details = 'Cannot connect to Tally on port 9000. Make sure:\n1. Tally is running\n2. A company is open in Tally\n3. ODBC is enabled (F12 → Advanced Configuration → Enable ODBC Server)';
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      errorDetails.status = 'timeout';
      errorDetails.details = 'Connection timed out. Tally may be slow to respond or not running.';
    } else {
      errorDetails.status = 'error';
      errorDetails.details = error.message;
    }

    res.status(500).json(errorDetails);
  }
});

// TEMPORARY: Test compression endpoint
app.get('/api/test-compression', (req, res) => {
  // Generate large data > 1KB
  const data = {
    message: 'Compression test',
    items: Array(100).fill({ id: 1, name: 'Test Item', description: 'This is a test item to generate enough data for compression to kick in.' })
  };
  res.json(data);
});

// ==================== COMPANY SETUP ENDPOINTS ====================

// Detect all companies from Tally
app.get('/api/company/detect', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('🔍 Company detect endpoint called - fetching all companies');
    console.log(`📡 Connecting to Tally at: ${TALLY_URL}`);

    const companies = await getAllCompanies();
    const responseTime = Date.now() - startTime;

    if (companies && companies.length > 0) {
      console.log(`✅ Found ${companies.length} companies (took ${responseTime}ms)`);
      res.json({
        success: true,
        companies: companies,
        count: companies.length,
        responseTime: `${responseTime}ms`
      });
    } else {
      console.warn(`⚠️ No companies found (took ${responseTime}ms)`);
      res.json({
        success: false,
        error: 'Could not detect any companies from Tally.\n\nPlease check:\n1. Is Tally application running?\n2. Is a company open in Tally?\n3. Is ODBC enabled? (Press F12 in Tally → Advanced Configuration → Enable ODBC Server)\n4. Is port 9000 accessible?\n\nYou can test the ODBC connection using the /api/test-odbc endpoint.'
      });
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`❌ Company detect error (took ${responseTime}ms):`, error.message);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      stack: error.stack?.substring(0, 200)
    });

    let errorMessage = error.message;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Cannot connect to Tally on port 9000.\n\nPlease:\n1. Open Tally application\n2. Open a company in Tally\n3. Enable ODBC: Press F12 → Advanced Configuration → Enable ODBC Server\n4. Check if Tally is listening on port 9000';
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      errorMessage = `Tally connection timed out after ${responseTime}ms.\n\nPlease:\n1. Make sure Tally is running\n2. Open a company in Tally\n3. Enable ODBC: Press F12 → Advanced Configuration → Enable ODBC Server\n4. Check if port 9000 is blocked by firewall\n5. Try the /api/test-odbc endpoint to verify connection`;
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
      errorCode: error.code,
      responseTime: `${responseTime}ms`
    });
  }
});

// Verify manual entry against Tally
app.post('/api/company/verify', async (req, res) => {
  try {
    const { name, guid } = req.body;

    if (!name || !guid) {
      return res.json({
        success: false,
        error: 'Company name and GUID are required'
      });
    }

    // Try to get info from Tally
    const tallyInfo = await getCompanyInfo();

    if (tallyInfo && tallyInfo.guid) {
      const tallyGuid = tallyInfo.guid.toLowerCase();
      const inputGuid = guid.toLowerCase();
      const tallyName = tallyInfo.name.toLowerCase();
      const inputName = name.toLowerCase();

      // Check if GUID matches
      if (tallyGuid === inputGuid) {
        // Check if name matches
        if (tallyName === inputName) {
          res.json({
            success: true,
            match: true,
            message: 'Perfect match! Company name and GUID verified.'
          });
        } else {
          res.json({
            success: true,
            match: false,
            warning: `GUID matches, but name differs. Tally shows: "${tallyInfo.name}". You entered: "${name}". Please verify.`
          });
        }
      } else {
        res.json({
          success: true,
          match: false,
          warning: `GUID mismatch! Tally company GUID is "${tallyInfo.guid}". You entered: "${guid}". Please check.`
        });
      }
    } else {
      // Tally not available, allow manual entry
      res.json({
        success: true,
        match: false,
        warning: 'Could not verify with Tally. Make sure Tally is running. You can still proceed with manual entry.'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Save company setup
app.post('/api/company/setup', async (req, res) => {
  try {
    const { name, guid, mode } = req.body;

    if (!name || !guid) {
      return res.json({
        success: false,
        error: 'Company name and GUID are required'
      });
    }

    // Save config
    const config = {
      company: {
        name,
        guid,
        mode,
        setupAt: new Date().toISOString()
      }
    };

    saveConfig(config);

    // Register in database
    await pool.query(`
      INSERT INTO companies (company_guid, company_name, verified)
      VALUES ($1, $2, $3)
      ON CONFLICT (company_guid) 
      DO UPDATE SET company_name = $2, verified = $3
    `, [guid, name, mode === 'auto']);

    res.json({
      success: true,
      message: 'Company setup completed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get current company config
app.get('/api/company/config', (req, res) => {
  const config = loadConfig();
  res.json({
    success: true,
    config: config || null
  });
});

// Reset company config (for settings)
app.post('/api/company/reset', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
    res.json({
      success: true,
      message: 'Company config reset successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== VENDORS ====================

// Get all vendors from PostgreSQL
app.get('/api/vendors', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    const { businessId } = req.query;
    let query = 'SELECT * FROM vendors';
    const params = [];
    let paramCount = 1;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    query += ` WHERE company_guid = $${paramCount}`;
    params.push(companyGuid);
    paramCount++;

    if (businessId) {
      query += ` AND business_id = $${paramCount}`;
      params.push(businessId);
      paramCount++;
    }

    query += ' ORDER BY name';

    const result = await pool.query(query, params);
    res.json({
      success: true,
      count: result.rows.length,
      vendors: result.rows
    });
  } catch (error) {
    console.error('Error fetching vendors:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single vendor by ID
app.get('/api/vendors/:id', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    const result = await pool.query(
      'SELECT * FROM vendors WHERE id = $1 AND company_guid = $2',
      [req.params.id, companyGuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    res.json({ success: true, vendor: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync vendors from Tally to PostgreSQL
app.post('/api/sync/vendors', async (req, res) => {
  try {
    console.log('🔄 Starting vendor sync from Tally...');

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
    const tallyCompanyInfo = await getCompanyInfo();

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

    const xmlRequest = `
      <ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Ledger Collection</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Ledger Collection">
                  <TYPE>Ledger</TYPE>
                  <FETCH>GUID, Name, OpeningBalance, ClosingBalance, Parent</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    const result = await queryTally(xmlRequest, { queryType: 'vendor_sync' });

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER) {
      return res.json({
        success: true,
        message: 'No vendors found in Tally',
        count: 0
      });
    }

    const ledgers = result.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
    const ledgerArray = Array.isArray(ledgers) ? ledgers : [ledgers];

    // Filter to only get Sundry Creditors (vendors)
    const vendors = ledgerArray.filter(ledger => {
      const parent = ledger.PARENT?._ || ledger.PARENT;
      return parent === 'Sundry Creditors';
    });

    console.log(`Found ${vendors.length} vendors in Sundry Creditors group`);

    if (vendors.length === 0) {
      return res.json({
        success: true,
        message: 'No vendors found in Sundry Creditors group',
        count: 0
      });
    }

    const { id: businessId } = await getBusinessMetadata();

    let syncedCount = 0;
    let errors = [];

    for (const vendor of vendors) {
      try {
        const guid = vendor.GUID?._ || vendor.GUID;
        const name = vendor.$?.NAME || vendor.NAME;
        const openingBalance = parseFloat(vendor.OPENINGBALANCE?._ || vendor.OPENINGBALANCE || 0);
        const currentBalance = parseFloat(vendor.CLOSINGBALANCE?._ || vendor.CLOSINGBALANCE || 0);

        // Check if vendor exists for THIS company
        const existingVendor = await pool.query(
          'SELECT id FROM vendors WHERE guid = $1 AND company_guid = $2',
          [guid, companyGuid]
        );

        if (existingVendor.rows.length > 0) {
          // Update existing vendor for this company
          await pool.query(
            `UPDATE vendors SET
              name = $2,
              business_id = $3,
              opening_balance = $4,
              current_balance = $5,
              synced_at = NOW(),
              updated_at = NOW()
             WHERE guid = $1 AND company_guid = $6`,
            [guid, name, businessId, openingBalance, currentBalance, companyGuid]
          );
        } else {
          // Insert new vendor for this company
          await pool.query(
            `INSERT INTO vendors (guid, name, business_id, company_guid, opening_balance, current_balance, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [guid, name, businessId, companyGuid, openingBalance, currentBalance]
          );
        }
        syncedCount++;
      } catch (err) {
        console.error(`Error syncing vendor:`, err);
        errors.push({ vendor: vendor.$?.NAME || vendor.NAME, error: err.message });
      }
    }

    console.log(`✅ Synced ${syncedCount} vendors`);

    res.json({
      success: true,
      message: `Successfully synced ${syncedCount} vendors from Tally`,
      count: syncedCount,
      errors: errors.length > 0 ? errors : undefined
    });

    // Invalidate cache after successful sync
    if (companyGuid) {
      cache.deletePattern(`stats:${companyGuid}*`);
      cache.deletePattern(`aging:${companyGuid}*`);
      cache.deletePattern(`customers:${companyGuid}*`);
      cache.deletePattern(`transactions:${companyGuid}*`);
      console.log(`🗑️  Cache invalidated for company: ${companyGuid}`);
    }
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Make sure Tally is running and port 9000 is accessible'
    });
  }
});

// ==================== CUSTOMERS ====================

// Get all customers from PostgreSQL
app.get('/api/customers', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    const { businessId } = req.query;
    let query = 'SELECT * FROM customers';
    const params = [];
    let paramCount = 1;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    query += ` WHERE company_guid = $${paramCount}`;
    params.push(companyGuid);
    paramCount++;

    if (businessId) {
      query += ` AND business_id = $${paramCount}`;
      params.push(businessId);
      paramCount++;
    }

    query += ' ORDER BY name';

    // Add caching
    const cacheKey = `customers:${companyGuid}:${businessId || 'all'}`;
    const forceRefresh = req.query.refresh === 'true';

    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    const result = await pool.query(query, params);

    const response = {
      success: true,
      count: result.rows.length,
      customers: result.rows,
      _cached: false
    };

    // Cache for 5 minutes
    cache.set(cacheKey, response, 300000);

    res.json(response);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single customer by ID
app.get('/api/customers/:id', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    const result = await pool.query(
      'SELECT * FROM customers WHERE id = $1 AND company_guid = $2',
      [req.params.id, companyGuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    res.json({ success: true, customer: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync customers from Tally to PostgreSQL
app.post('/api/sync/customers', async (req, res) => {
  try {
    console.log('🔄 Starting customer sync from Tally...');

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
    const tallyCompanyInfo = await getCompanyInfo();

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

    const xmlRequest = `
      <ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Ledger Collection</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Ledger Collection">
                  <TYPE>Ledger</TYPE>
                  <FETCH>GUID, Name, OpeningBalance, ClosingBalance, Parent</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    const result = await queryTally(xmlRequest, { queryType: 'customer_sync' });

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER) {
      return res.json({
        success: true,
        message: 'No customers found in Tally',
        count: 0
      });
    }

    const ledgers = result.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
    const ledgerArray = Array.isArray(ledgers) ? ledgers : [ledgers];

    // Filter to only get Sundry Debtors (customers)
    const customers = ledgerArray.filter(ledger => {
      const parent = ledger.PARENT?._ || ledger.PARENT;
      return parent === 'Sundry Debtors';
    });

    console.log(`Found ${customers.length} customers in Sundry Debtors group`);

    if (customers.length === 0) {
      return res.json({
        success: true,
        message: 'No customers found in Sundry Debtors group',
        count: 0
      });
    }

    const { id: businessId } = await getBusinessMetadata();

    let syncedCount = 0;
    let errors = [];

    for (const customer of customers) {
      try {
        const guid = customer.GUID?._ || customer.GUID;
        const name = customer.$?.NAME || customer.NAME;
        const openingBalance = parseFloat(customer.OPENINGBALANCE?._ || customer.OPENINGBALANCE || 0);
        const currentBalance = parseFloat(customer.CLOSINGBALANCE?._ || customer.CLOSINGBALANCE || 0);

        // Check if customer exists for THIS company
        const existingCustomer = await pool.query(
          'SELECT id, company_guid FROM customers WHERE guid = $1',
          [guid]
        );

        if (existingCustomer.rows.length > 0) {
          const existing = existingCustomer.rows[0];
          if (existing.company_guid === companyGuid) {
            // Update existing customer for this company
            await pool.query(
              `UPDATE customers SET
                name = $2,
                business_id = $3,
                opening_balance = $4,
                current_balance = $5,
                synced_at = NOW(),
                updated_at = NOW()
               WHERE guid = $1 AND company_guid = $6`,
              [guid, name, businessId, openingBalance, currentBalance, companyGuid]
            );
            syncedCount++;
          } else {
            // Customer with this GUID exists for a different company - skip to prevent data mixing
            console.warn(`⚠️ Customer ${guid} (${name}) already exists for a different company (${existing.company_guid}). Skipping to prevent data mixing.`);
          }
        } else {
          // Insert new customer for this company
          await pool.query(
            `INSERT INTO customers (guid, name, business_id, company_guid, opening_balance, current_balance, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [guid, name, businessId, companyGuid, openingBalance, currentBalance]
          );
          syncedCount++;
        }
      } catch (err) {
        console.error(`Error syncing customer:`, err);
        errors.push({ customer: customer.$?.NAME || customer.NAME, error: err.message });
      }
    }

    console.log(`✅ Synced ${syncedCount} customers`);

    res.json({
      success: true,
      message: `Successfully synced ${syncedCount} customers from Tally`,
      count: syncedCount,
      errors: errors.length > 0 ? errors : undefined
    });

    // Invalidate cache after successful sync
    if (companyGuid) {
      cache.deletePattern(`stats:${companyGuid}*`);
      cache.deletePattern(`aging:${companyGuid}*`);
      cache.deletePattern(`customers:${companyGuid}*`);
      cache.deletePattern(`transactions:${companyGuid}*`);
      console.log(`🗑️  Cache invalidated for company: ${companyGuid}`);
    }
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Make sure Tally is running and port 9000 is accessible'
    });
  }
});

// ==================== TRANSACTIONS ====================

// Get all transactions from PostgreSQL with PAGINATION ⚡
app.get('/api/transactions', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    // ==================== PAGINATION PARAMETERS ====================
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Optional filters
    const { businessId, startDate, endDate, type: voucherType, search } = req.query;

    // Build WHERE clause
    let whereConditions = ['company_guid = $1'];
    let params = [companyGuid];
    let paramCount = 2;

    if (businessId) {
      whereConditions.push(`business_id = $${paramCount}`);
      params.push(businessId);
      paramCount++;
    }

    if (startDate) {
      whereConditions.push(`date >= $${paramCount}`);
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      whereConditions.push(`date <= $${paramCount}`);
      params.push(endDate);
      paramCount++;
    }

    if (voucherType) {
      whereConditions.push(`voucher_type = $${paramCount}`);
      params.push(voucherType);
      paramCount++;
    }

    if (search) {
      whereConditions.push(`(
        party_name ILIKE $${paramCount} OR 
        narration ILIKE $${paramCount} OR 
        voucher_number ILIKE $${paramCount}
      )`);
      params.push(`%${search}%`);
      paramCount++;
    }

    const whereClause = whereConditions.join(' AND ');

    // ==================== CACHING WITH PAGINATION ====================
    const cacheKey = `transactions:${companyGuid}:page${page}:limit${limit}:${voucherType || 'all'}:${search || ''}`;
    const forceRefresh = req.query.refresh === 'true';

    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log(`📦 Transactions cache HIT: page ${page}`);
        return res.json({ ...cached, _cached: true });
      }
    }

    console.log(`📡 Transactions cache MISS: page ${page} - Fetching from database...`);

    // ==================== PARALLEL QUERIES ====================
    const [dataResult, countResult] = await Promise.all([
      // Get paginated data
      pool.query(
        `SELECT * FROM transactions 
         WHERE ${whereClause}
         ORDER BY date DESC, created_at DESC
         LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
        [...params, limit, offset]
      ),
      // Get total count for pagination
      pool.query(
        `SELECT COUNT(*) as total FROM transactions WHERE ${whereClause}`,
        params
      )
    ]);

    const totalRecords = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalRecords / limit);

    const response = {
      success: true,
      page,
      limit,
      totalRecords,
      totalPages,
      hasMore: page < totalPages,
      hasPrevious: page > 1,
      count: dataResult.rows.length,
      transactions: dataResult.rows,
      _cached: false
    };

    // Cache for 5 minutes
    cache.set(cacheKey, response, 300000);

    res.json(response);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      page: 1,
      totalPages: 0,
      transactions: []
    });
  }
});

// Get pagination metadata without fetching all data
app.get('/api/transactions/metadata', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({ success: false, error: 'Company not configured' });
    }

    const result = await pool.query(
      'SELECT COUNT(*) as total FROM transactions WHERE company_guid = $1',
      [companyGuid]
    );

    const total = parseInt(result.rows[0].total);

    res.json({
      success: true,
      totalRecords: total,
      defaultPageSize: 50,
      suggestedPageSizes: [25, 50, 100, 200]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fast, indexed transaction search with flexible filters
app.get('/api/transactions/search', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    const {
      party,
      voucherNumber,
      fromDate,
      toDate,
      minAmount,
      maxAmount,
      voucherType,
      limit = 50
    } = req.query;

    const conditions = ['company_guid = $1'];
    const params = [companyGuid];
    let paramIndex = 2;

    if (party) {
      conditions.push(`party_name ILIKE $${paramIndex}`);
      params.push(`%${party}%`);
      paramIndex += 1;
    }

    if (voucherNumber) {
      conditions.push(`voucher_number ILIKE $${paramIndex}`);
      params.push(`%${voucherNumber}%`);
      paramIndex += 1;
    }

    if (fromDate) {
      conditions.push(`date >= $${paramIndex}`);
      params.push(fromDate);
      paramIndex += 1;
    }

    if (toDate) {
      conditions.push(`date <= $${paramIndex}`);
      params.push(toDate);
      paramIndex += 1;
    }

    if (minAmount) {
      conditions.push(`ABS(amount) >= $${paramIndex}`);
      params.push(minAmount);
      paramIndex += 1;
    }

    if (maxAmount) {
      conditions.push(`ABS(amount) <= $${paramIndex}`);
      params.push(maxAmount);
      paramIndex += 1;
    }

    if (voucherType) {
      conditions.push(`voucher_type ILIKE $${paramIndex}`);
      params.push(`%${voucherType}%`);
      paramIndex += 1;
    }

    const query = `
      SELECT 
        voucher_number,
        date,
        party_name,
        amount,
        voucher_type,
        narration
      FROM transactions
      WHERE ${conditions.join(' AND ')}
      ORDER BY date DESC
      LIMIT $${paramIndex}
    `;

    params.push(limit);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      transactions: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Transaction search failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single transaction by ID
app.get('/api/transactions/:id', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1 AND company_guid = $2',
      [req.params.id, companyGuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    res.json({ success: true, transaction: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== GROUPS SYNC ====================

// Sync Groups from Tally
app.post('/api/sync/groups', async (req, res) => {
  try {
    console.log('🔄 Starting groups sync from Tally...');
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    // Verify Tally company
    const tallyCompanyInfo = await getCompanyInfo();
    if (!tallyCompanyInfo || tallyCompanyInfo.guid.toLowerCase() !== companyGuid.toLowerCase()) {
      return res.json({
        success: false,
        error: 'Company mismatch. Please open the correct company in Tally.'
      });
    }

    // XML request to fetch all groups
    const xmlRequest = `
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
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Group Collection">
                  <TYPE>Group</TYPE>
                  <FETCH>GUID, Name, Parent, PrimaryGroup, IsRevenue, IsExpenses</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    const result = await queryTally(xmlRequest, {
      timeout: 60000,
      retries: 2,
      queryType: 'group_sync'
    });

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP) {
      return res.json({
        success: true,
        message: 'No groups found in Tally',
        count: 0
      });
    }

    const groups = result.ENVELOPE.BODY.DATA.COLLECTION.GROUP;
    const groupArray = Array.isArray(groups) ? groups : [groups];
    console.log(`Found ${groupArray.length} groups in Tally`);

    let syncedCount = 0;
    let errors = [];

    for (const group of groupArray) {
      try {
        const guid = extractValue(group?.GUID) || group?.GUID || '';
        const name = extractValue(group?.NAME) || group?.NAME || '';
        const parent = extractValue(group?.PARENT) || group?.PARENT || null;
        const primaryGroup = extractValue(group?.PRIMARYGROUP) || group?.PRIMARYGROUP || null;
        const isRevenue = (extractValue(group?.ISREVENUE) || group?.ISREVENUE || 'No') === 'Yes';
        const isExpense = (extractValue(group?.ISEXPENSES) || group?.ISEXPENSES || 'No') === 'Yes';

        // Check if group exists
        const existingGroup = await pool.query(
          'SELECT id FROM groups WHERE guid = $1 AND company_guid = $2',
          [guid, companyGuid]
        );

        if (existingGroup.rows.length > 0) {
          // Update existing group
          await pool.query(
            `UPDATE groups SET
              name = $2,
              parent = $3,
              primary_group = $4,
              is_revenue = $5,
              is_expense = $6,
              synced_at = NOW(),
              updated_at = NOW()
             WHERE guid = $1 AND company_guid = $7`,
            [guid, name, parent, primaryGroup, isRevenue, isExpense, companyGuid]
          );
        } else {
          // Insert new group
          await pool.query(
            `INSERT INTO groups (guid, name, parent, primary_group, is_revenue, is_expense, company_guid, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [guid, name, parent, primaryGroup, isRevenue, isExpense, companyGuid]
          );
        }
        syncedCount++;
      } catch (err) {
        console.error(`Error syncing group:`, err);
        errors.push({ group: extractValue(group?.NAME) || group?.NAME, error: err.message });
      }
    }

    console.log(`✅ Synced ${syncedCount} groups`);
    res.json({
      success: true,
      message: `Successfully synced ${syncedCount} groups from Tally`,
      count: syncedCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('❌ Groups sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== LEDGERS SYNC ====================

// Sync ALL Ledgers from Tally (not just vendors/customers)
app.post('/api/sync/ledgers', async (req, res) => {
  try {
    console.log('🔄 Starting ledgers sync from Tally...');
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    // Verify Tally company
    const tallyCompanyInfo = await getCompanyInfo();
    if (!tallyCompanyInfo || tallyCompanyInfo.guid.toLowerCase() !== companyGuid.toLowerCase()) {
      return res.json({
        success: false,
        error: 'Company mismatch. Please open the correct company in Tally.'
      });
    }

    // XML request to fetch ALL ledgers
    const xmlRequest = `
      <ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Collection</TYPE>
          <ID>Ledger Collection</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Ledger Collection">
                  <TYPE>Ledger</TYPE>
                  <FETCH>GUID, Name, Parent, OpeningBalance, ClosingBalance, IsRevenue, IsExpenses</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    const result = await queryTally(xmlRequest, {
      timeout: 60000,
      retries: 2,
      queryType: 'ledger_sync'
    });

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER) {
      return res.json({
        success: true,
        message: 'No ledgers found in Tally',
        count: 0
      });
    }

    const ledgers = result.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
    const ledgerArray = Array.isArray(ledgers) ? ledgers : [ledgers];
    console.log(`Found ${ledgerArray.length} ledgers in Tally`);

    let syncedCount = 0;
    let errors = [];

    for (const ledger of ledgerArray) {
      try {
        const guid = extractValue(ledger?.GUID) || ledger?.GUID || '';
        const name = extractValue(ledger?.NAME) || ledger?.NAME || '';
        const parent = extractValue(ledger?.PARENT) || ledger?.PARENT || '';
        const openingBalance = parseFloat(extractValue(ledger?.OPENINGBALANCE) || ledger?.OPENINGBALANCE || 0);
        const closingBalance = parseFloat(extractValue(ledger?.CLOSINGBALANCE) || ledger?.CLOSINGBALANCE || 0);
        const isRevenue = (extractValue(ledger?.ISREVENUE) || ledger?.ISREVENUE || 'No') === 'Yes';
        const isExpense = (extractValue(ledger?.ISEXPENSES) || ledger?.ISEXPENSES || 'No') === 'Yes';

        // Check if ledger exists
        const existingLedger = await pool.query(
          'SELECT id FROM ledgers WHERE guid = $1 AND company_guid = $2',
          [guid, companyGuid]
        );

        if (existingLedger.rows.length > 0) {
          // Update existing ledger
          await pool.query(
            `UPDATE ledgers SET
              name = $2,
              parent_group = $3,
              opening_balance = $4,
              closing_balance = $5,
              is_revenue = $6,
              is_expense = $7,
              synced_at = NOW(),
              updated_at = NOW()
             WHERE guid = $1 AND company_guid = $8`,
            [guid, name, parent, openingBalance, closingBalance, isRevenue, isExpense, companyGuid]
          );
        } else {
          // Insert new ledger
          await pool.query(
            `INSERT INTO ledgers (guid, name, parent_group, opening_balance, closing_balance, is_revenue, is_expense, company_guid, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [guid, name, parent, openingBalance, closingBalance, isRevenue, isExpense, companyGuid]
          );
        }
        syncedCount++;
      } catch (err) {
        console.error(`Error syncing ledger:`, err);
        errors.push({ ledger: extractValue(ledger?.NAME) || ledger?.NAME, error: err.message });
      }
    }

    console.log(`✅ Synced ${syncedCount} ledgers`);
    res.json({
      success: true,
      message: `Successfully synced ${syncedCount} ledgers from Tally`,
      count: syncedCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('❌ Ledgers sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SALES GROUP SUMMARY ====================

// Get Sales Accounts Summary (CORRECT METHOD - Uses Group-Ledger Hierarchy)
app.get('/api/sales/group-summary', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    // Get date range from query params or use default (last 7 months)
    const { fromDate, toDate } = req.query;
    let fromDateObj, toDateObj;

    if (!fromDate || !toDate) {
      // Default to last 7 months (similar to Tally screenshot: Apr to Nov)
      const today = new Date();
      toDateObj = new Date(today);
      fromDateObj = new Date(today);
      fromDateObj.setMonth(fromDateObj.getMonth() - 7);
    } else {
      fromDateObj = new Date(fromDate);
      toDateObj = new Date(toDate);
    }

    // Format dates for database query (YYYY-MM-DD)
    const fromDateStr = formatTallyDate(fromDateObj, 'postgres');
    const toDateStr = formatTallyDate(toDateObj, 'postgres');
    const fromDateTally = formatTallyDate(fromDateObj, 'tally');
    const toDateTally = formatTallyDate(toDateObj, 'tally');

    console.log(`📊 Calculating Sales Accounts for ${fromDateStr} to ${toDateStr}`);

    // =====================================================
    // CORRECT APPROACH: Use Group-Ledger Hierarchy
    // =====================================================
    // Step 1: Get all ledgers under "Sales Accounts" group hierarchy
    // This uses a recursive query to get all child groups and their ledgers

    const salesLedgersQuery = `
      WITH RECURSIVE sales_groups AS (
        -- Base: Sales Accounts group itself
        SELECT guid, name, parent
        FROM groups
        WHERE name = 'Sales Accounts'
          AND company_guid = $1
        
        UNION ALL
        
        -- Recursive: All descendant groups
        SELECT g.guid, g.name, g.parent
        FROM groups g
        INNER JOIN sales_groups sg ON g.parent = sg.name
        WHERE g.company_guid = $1
      ),
      sales_ledger_guids AS (
        -- Get all ledgers under these groups
        SELECT l.guid, l.name, l.closing_balance, l.opening_balance
        FROM ledgers l
        WHERE l.company_guid = $1
          AND (
            l.parent_group = 'Sales Accounts'
            OR l.parent_group IN (SELECT name FROM sales_groups)
          )
      )
      SELECT 
        COALESCE(SUM(closing_balance), 0) as total_sales,
        COALESCE(SUM(opening_balance), 0) as opening_sales,
        COUNT(*) as ledger_count,
        json_agg(json_build_object(
          'name', name,
          'balance', closing_balance
        )) FILTER (WHERE closing_balance != 0) as ledger_breakdown
      FROM sales_ledger_guids
    `;

    const result = await pool.query(salesLedgersQuery, [companyGuid]);

    if (!result.rows || result.rows.length === 0 || !result.rows[0].ledger_count || result.rows[0].ledger_count === 0) {
      // Fallback: Check if groups/ledgers tables exist and have data
      const checkGroups = await pool.query('SELECT COUNT(*) as count FROM groups WHERE company_guid = $1', [companyGuid]);
      const checkLedgers = await pool.query('SELECT COUNT(*) as count FROM ledgers WHERE company_guid = $1', [companyGuid]);

      if (checkGroups.rows[0].count === 0 || checkLedgers.rows[0].count === 0) {
        return res.json({
          success: false,
          error: 'No sales ledgers found. Please sync groups and ledgers first.',
          hint: 'Run POST /api/sync/groups and POST /api/sync/ledgers',
          data: {
            groupName: 'Sales Accounts',
            companyName: config?.company?.name || 'Unknown',
            period: {
              from: fromDateTally,
              to: toDateTally,
              fromFormatted: formatTallyDateForDisplay(fromDateTally),
              toFormatted: formatTallyDateForDisplay(toDateTally)
            },
            closingBalance: {
              amount: 0,
              type: 'Credit',
              formatted: formatCurrency(0)
            },
            openingBalance: {
              amount: 0,
              type: 'Credit',
              formatted: formatCurrency(0)
            }
          }
        });
      }

      // Groups/ledgers exist but no Sales Accounts found
      return res.json({
        success: false,
        error: 'Sales Accounts group not found in synced data.',
        hint: 'Ensure "Sales Accounts" group exists in Tally and sync again.',
        data: {
          groupName: 'Sales Accounts',
          companyName: config?.company?.name || 'Unknown',
          period: {
            from: fromDateTally,
            to: toDateTally,
            fromFormatted: formatTallyDateForDisplay(fromDateTally),
            toFormatted: formatTallyDateForDisplay(toDateTally)
          },
          closingBalance: {
            amount: 0,
            type: 'Credit',
            formatted: formatCurrency(0)
          },
          openingBalance: {
            amount: 0,
            type: 'Credit',
            formatted: formatCurrency(0)
          }
        }
      });
    }

    const salesData = result.rows[0];
    const totalSales = parseFloat(salesData.total_sales) || 0;
    const openingSales = parseFloat(salesData.opening_sales) || 0;
    const ledgerCount = parseInt(salesData.ledger_count) || 0;
    const breakdown = salesData.ledger_breakdown || [];

    console.log(`✅ Total Sales: ₹${totalSales.toLocaleString('en-IN')}`);
    console.log(`   Calculated from ${ledgerCount} sales ledgers`);
    console.log(`   Opening Balance: ₹${openingSales.toLocaleString('en-IN')}`);

    res.json({
      success: true,
      data: {
        groupName: 'Sales Accounts',
        companyName: config?.company?.name || 'Unknown',
        period: {
          from: fromDateTally,
          to: toDateTally,
          fromFormatted: formatTallyDateForDisplay(fromDateTally),
          toFormatted: formatTallyDateForDisplay(toDateTally)
        },
        closingBalance: {
          amount: totalSales,
          type: 'Credit',
          formatted: formatCurrency(totalSales)
        },
        openingBalance: {
          amount: openingSales,
          type: 'Credit',
          formatted: formatCurrency(openingSales)
        },
        ledgerCount: ledgerCount,
        breakdown: breakdown,
        calculation_method: 'group_hierarchy',
        notes: 'Calculated from Sales Accounts group and all its sub-groups'
      }
    });
  } catch (error) {
    console.error('Error calculating Sales Group Summary:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Error calculating sales from synced transactions'
    });
  }
});

// Helper function to format Tally date for display (converts YYYYMMDD to readable format)
function formatTallyDateForDisplay(tallyDate) {
  if (!tallyDate) return '';
  // Tally date format: YYYYMMDD or YYYY-MM-DD
  let dateStr = tallyDate.toString();
  if (dateStr.length === 8 && !dateStr.includes('-')) {
    // YYYYMMDD format
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    const date = new Date(`${year}-${month}-${day}`);
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  // Try parsing as is
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}


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
    const tallyCompanyInfo = await getCompanyInfo();

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
      // Go back 1 day before last sync to catch any edge cases
      lastSyncDate.setDate(lastSyncDate.getDate() - 1);
      fromDate = lastSyncDate.toISOString().split('T')[0];
      console.log(`⚡ INCREMENTAL sync - fetching only data since ${fromDate}`);
      console.log(`   Last successful sync: ${formatDateForDisplay(syncDecision.lastSyncTime)}`);
    }

    console.log(`📅 Syncing transactions from ${fromDate} to ${toDate}`);

    const xmlRequest = `
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
              <SVFROMDATE>${fromDate}</SVFROMDATE>
              <SVTODATE>${toDate}</SVTODATE>
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Voucher Collection">
                  <TYPE>Voucher</TYPE>
                  <FETCH>GUID, VoucherNumber, VoucherTypeName, Date, PartyLedgerName, Amount, Narration, ALLINVENTORYENTRIES.LIST:STOCKITEMNAME, ALLINVENTORYENTRIES.LIST:ITEMCODE</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    // Initial Tally API call: 15 minute timeout to detect if Tally is dead/unresponsive
    // If Tally is responding and data is coming, we'll get the data within this time
    // If Tally is completely dead, we'll error out after 15 minutes instead of waiting forever
    const result = await queryTally(xmlRequest, {
      timeout: 900000, // 15 minutes - enough for very large datasets, but detects if Tally is dead
      retries: 3, // Retry 3 times if connection fails
      queryType: 'transaction_sync'
    });

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER) {
      return res.json({
        success: true,
        message: 'No transactions found in Tally for the specified period',
        count: 0
      });
    }

    const vouchers = result.ENVELOPE.BODY.DATA.COLLECTION.VOUCHER;
    const voucherArray = Array.isArray(vouchers) ? vouchers : [vouchers];

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

// ==================== STATS ====================

// Database stats endpoint with caching
app.get('/api/stats', async (req, res) => {
  try {
    // Load selected company from config
    const config = loadConfig();

    if (!config || !config.company || !config.company.guid) {
      return res.json({
        success: false,
        error: 'No company selected. Please run setup.'
      });
    }

    const companyGuid = config.company.guid;
    const companyName = config.company.name;
    const cacheKey = `stats:${companyGuid}`;
    const forceRefresh = req.query.refresh === 'true';

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log(`📊 Stats cache HIT for: ${companyName}`);
        return res.json(cached);
      }
    }

    console.log(`📊 Fetching stats for: ${companyName} (${companyGuid})${forceRefresh ? ' [FORCE REFRESH]' : ''}`);

    // ⭐ CRITICAL: Filter by company_guid
    const whereClause = 'WHERE company_guid = $1';
    const params = [companyGuid];

    // Execute queries in parallel for better performance
    const [vendorStats, customerStats, transactionStats, lastSyncResult] = await Promise.all([
      // Vendors stats - FILTERED
      pool.query(`
        SELECT 
          COUNT(*) as total_vendors,
          COALESCE(SUM(current_balance), 0) as total_payables,
          MAX(synced_at) as last_vendor_sync
        FROM vendors 
        ${whereClause}
      `, params),

      // Customers stats - FILTERED
      pool.query(`
        SELECT 
          COUNT(*) as total_customers,
          COALESCE(SUM(current_balance), 0) as total_receivables,
          MAX(synced_at) as last_customer_sync
        FROM customers 
        ${whereClause}
      `, params),

      // Transactions stats - FILTERED
      pool.query(`
        SELECT 
          COUNT(*) as total_transactions,
          COALESCE(SUM(CASE WHEN voucher_type LIKE '%Payment%' THEN amount ELSE 0 END), 0) as total_payments,
          COALESCE(SUM(CASE WHEN voucher_type LIKE '%Receipt%' THEN amount ELSE 0 END), 0) as total_receipts,
          MAX(synced_at) as last_transaction_sync
        FROM transactions 
        ${whereClause}
      `, params),

      // Last sync from companies table
      pool.query(`
        SELECT last_sync 
        FROM companies 
        WHERE company_guid = $1
      `, [companyGuid])
    ]);

    const timestamps = [
      vendorStats.rows[0]?.last_vendor_sync,
      customerStats.rows[0]?.last_customer_sync,
      transactionStats.rows[0]?.last_transaction_sync,
      lastSyncResult.rows[0]?.last_sync
    ].filter(Boolean).map(date => new Date(date).getTime());
    const lastSyncValue = timestamps.length ? new Date(Math.max(...timestamps)) : null;

    // Get business metadata - use cached value if available (don't call Tally every time)
    // The business ID is the company's unique identifier (GUID)
    let business = null;
    const businessCacheKey = `business:${companyGuid}`;
    let businessMeta = cache.get(businessCacheKey);

    if (!businessMeta) {
      try {
        // Try to get REMOTECMPID from Tally, but always use company GUID as primary ID
        businessMeta = await getBusinessMetadata();
        // Cache business metadata for 5 minutes
        cache.set(businessCacheKey, businessMeta, 300000);
      } catch (error) {
        console.warn('Could not fetch business metadata from Tally:', error.message);
        businessMeta = null;
      }
    }

    if (businessMeta) {
      // Use REMOTECMPID if available and matches, otherwise use company GUID
      const businessId = businessMeta.id && businessMeta.id !== DEFAULT_BUSINESS_ID
        ? businessMeta.id  // Use REMOTECMPID if available
        : companyGuid;     // Fallback to company GUID

      business = {
        id: businessId,
        name: businessMeta.name || companyName
      };
    } else {
      // Use company GUID as business ID (most reliable)
      business = {
        id: companyGuid,
        name: companyName
      };
    }

    const response = {
      success: true,
      company: {
        name: companyName,
        guid: companyGuid
      },
      stats: {
        vendors: vendorStats.rows[0],
        customers: customerStats.rows[0],
        transactions: transactionStats.rows[0],
        last_sync: lastSyncValue,
        business: business
      },
      _cached: false
    };

    // Cache the response for 5 minutes (300000ms)
    cache.set(cacheKey, response, 300000);
    console.log(`📊 Stats cached for: ${companyName}`);

    res.json(response);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ANALYTICS ENDPOINTS ⭐ NEW ====================

// Get payment cycles
app.get('/api/analytics/payment-cycles', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }

    const result = await pool.query(`
      SELECT 
        pc.*,
        v.name as vendor_name
      FROM payment_cycles pc
      LEFT JOIN vendors v ON v.id = pc.vendor_id
      WHERE v.company_guid = $1
      ORDER BY pc.calculated_at DESC
    `, [companyGuid]);

    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get outstanding aging with caching - NOW USES MATERIALIZED VIEWS! ⚡
app.get('/api/analytics/aging', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    const useMaterializedView = req.query.source !== 'legacy'; // Use MV by default

    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'No company selected'
      });
    }

    const cacheKey = `aging:${companyGuid}`;
    const forceRefresh = req.query.refresh === 'true';

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log(`📅 Aging cache HIT for GUID: ${companyGuid}`);
        return res.json(cached);
      }
    }

    console.log(`📅 Fetching aging for GUID: ${companyGuid}${forceRefresh ? ' [FORCE REFRESH]' : ''} [source: ${useMaterializedView ? 'materialized_view' : 'legacy'}]`);

    // ============================================
    // TRY MATERIALIZED VIEW FIRST (SUPER FAST!) ⚡
    // ============================================
    if (useMaterializedView) {
      try {
        const viewsExist = await checkMaterializedViewsExist();

        if (viewsExist) {
          const startTime = Date.now();

          const [vendorResult, customerResult] = await Promise.all([
            // Vendors (payables) from materialized view
            pool.query(`
              SELECT 
                vendor_id as id,
                vendor_name as entity_name,
                'vendor' as entity_type,
                current_balance,
                bucket_0_30 as current_0_30_days,
                bucket_31_60 as current_31_60_days,
                bucket_61_90 as current_61_90_days,
                bucket_over_90 as current_over_90_days,
                total_outstanding,
                transaction_count,
                last_transaction_date,
                calculated_at
              FROM mv_vendor_aging_summary
              WHERE company_guid = $1
              ORDER BY total_outstanding DESC
            `, [companyGuid]),

            // Customers (receivables) from materialized view
            pool.query(`
              SELECT 
                customer_id as id,
                customer_name as entity_name,
                'customer' as entity_type,
                current_balance,
                bucket_0_30 as current_0_30_days,
                bucket_31_60 as current_31_60_days,
                bucket_61_90 as current_61_90_days,
                bucket_over_90 as current_over_90_days,
                total_outstanding,
                transaction_count,
                last_transaction_date,
                calculated_at
              FROM mv_customer_aging_summary
              WHERE company_guid = $1
              ORDER BY total_outstanding DESC
            `, [companyGuid])
          ]);

          const queryTime = Date.now() - startTime;

          // Combine and sort
          const allRows = [
            ...vendorResult.rows.map(r => ({ ...r, vendor_id: r.id, customer_id: null })),
            ...customerResult.rows.map(r => ({ ...r, customer_id: r.id, vendor_id: null }))
          ].sort((a, b) => (Number(b.total_outstanding) || 0) - (Number(a.total_outstanding) || 0));

          const response = {
            success: true,
            count: allRows.length,
            data: allRows,
            _cached: false,
            _source: 'materialized_view',
            _queryTime: `${queryTime}ms`
          };

          // Cache the response for 10 minutes
          cache.set(cacheKey, response, 600000);
          console.log(`⚡ Aging from materialized view: ${queryTime}ms (${allRows.length} rows)`);

          return res.json(response);
        }
      } catch (mvError) {
        console.warn('⚠️ Materialized view query failed, falling back to legacy:', mvError.message);
      }
    }

    // ============================================
    // FALLBACK: Legacy calculation
    // ============================================
    console.log(`📅 Using legacy aging calculation for GUID: ${companyGuid}`);

    // Check if we need to recalculate (only if data changed)
    // Get last sync time to determine if recalculation is needed
    const lastSyncCheck = await pool.query(`
      SELECT MAX(GREATEST(
        (SELECT MAX(synced_at) FROM vendors WHERE company_guid = $1),
        (SELECT MAX(synced_at) FROM customers WHERE company_guid = $1),
        (SELECT MAX(synced_at) FROM transactions WHERE company_guid = $1)
      )) as last_sync
    `, [companyGuid]);

    const lastSync = lastSyncCheck.rows[0]?.last_sync;
    const cachedAging = cache.get(`aging:meta:${companyGuid}`);

    // Only recalculate if data changed or cache expired
    const needsRecalculation = !cachedAging ||
      !cachedAging.lastSync ||
      !lastSync ||
      new Date(lastSync) > new Date(cachedAging.lastSync);

    if (needsRecalculation || forceRefresh) {
      console.log(`📅 Recalculating aging for GUID: ${companyGuid}`);
      await calculateOutstandingAging(companyGuid);
      // Cache the metadata
      cache.set(`aging:meta:${companyGuid}`, { lastSync }, 600000); // 10 minutes
    } else {
      console.log(`📅 Using cached aging calculation for GUID: ${companyGuid}`);
    }

    const result = await pool.query(`
      SELECT 
        oa.*,
        COALESCE(v.name, c.name) as entity_name
      FROM outstanding_aging oa
      LEFT JOIN vendors v ON v.id = oa.vendor_id
      LEFT JOIN customers c ON c.id = oa.customer_id
      WHERE oa.company_guid = $1
      ORDER BY oa.total_outstanding DESC
    `, [companyGuid]);

    let rows = result.rows || [];

    // Normalize totals to numbers for sorting/formatting downstream
    rows = rows.map(row => ({
      ...row,
      current_0_30_days: Number(row.current_0_30_days) || 0,
      current_31_60_days: Number(row.current_31_60_days) || 0,
      current_61_90_days: Number(row.current_61_90_days) || 0,
      current_over_90_days: Number(row.current_over_90_days) || 0,
      total_outstanding: Number(row.total_outstanding) || 0
    }));

    // Ensure every customer is represented even if analytics table missed them
    const existingCustomerIds = new Set(
      rows
        .filter(row => row.entity_type === 'customer' && row.customer_id)
        .map(row => row.customer_id)
    );

    let customerQuery = `
      SELECT 
        id,
        name,
        synced_at,
        created_at,
        COALESCE(current_balance, 0) as balance
      FROM customers
      WHERE company_guid = $1
    `;
    const customerParams = [companyGuid];

    if (existingCustomerIds.size) {
      const placeholders = Array.from(existingCustomerIds).map((_, idx) => `$${idx + 2}`).join(', ');
      customerQuery += ` AND id NOT IN (${placeholders})`;
      customerParams.push(...Array.from(existingCustomerIds));
    }

    const missingCustomers = await pool.query(
      customerQuery,
      customerParams
    );

    if (missingCustomers.rows?.length) {
      const bucketsFromCustomer = (customer) => {
        const balance = Math.abs(Number(customer.balance) || 0);
        const syncedAt = customer.synced_at ? new Date(customer.synced_at) : null;
        const now = new Date();
        const msDiff = syncedAt ? (now - syncedAt) : Number.MAX_SAFE_INTEGER;
        const days = msDiff / 86400000;
        return {
          current_0_30_days: days <= 30 ? balance : 0,
          current_31_60_days: days > 30 && days <= 60 ? balance : 0,
          current_61_90_days: days > 60 && days <= 90 ? balance : 0,
          current_over_90_days: days > 90 ? balance : 0,
          total_outstanding: balance
        };
      };

      missingCustomers.rows.forEach(customer => {
        const buckets = bucketsFromCustomer(customer);
        rows.push({
          entity_type: 'customer',
          vendor_id: null,
          customer_id: customer.id,
          entity_name: customer.name,
          ...buckets,
          calculated_at: customer.synced_at,
          created_at: customer.created_at
        });
      });
    }

    rows.sort((a, b) => (b.total_outstanding || 0) - (a.total_outstanding || 0));

    const response = {
      success: true,
      count: rows.length,
      data: rows,
      _cached: false,
      _source: 'legacy_calculation'
    };

    // Cache the response for 10 minutes (600000ms)
    cache.set(cacheKey, response, 600000);
    console.log(`📅 Aging cached for GUID: ${companyGuid} (legacy)`);

    res.json(response);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

// ==================== AUTO-SYNC SCHEDULER ====================

const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
const MIN_SYNC_GAP = 2 * 60 * 1000; // Minimum 2 minutes between any syncs

// Auto-sync status tracking (for UI feedback)
const autoSyncStatus = {
  isRunning: false,
  startedAt: null,
  currentStep: null,
  lastCompleted: null,
  lastDuration: null,
  lastError: null,
  results: {},
  // Manual sync coordination
  manualSyncInProgress: false,
  lastManualSyncCompleted: null
};

// Get auto-sync status endpoint
app.get('/api/sync/auto-status', (req, res) => {
  const lastSyncTime = autoSyncStatus.lastCompleted || autoSyncStatus.lastManualSyncCompleted;
  const timeSinceLastSync = lastSyncTime ? Date.now() - new Date(lastSyncTime).getTime() : SYNC_INTERVAL;

  res.json({
    success: true,
    autoSync: {
      isRunning: autoSyncStatus.isRunning,
      startedAt: autoSyncStatus.startedAt,
      currentStep: autoSyncStatus.currentStep,
      elapsedMs: autoSyncStatus.isRunning ? Date.now() - new Date(autoSyncStatus.startedAt).getTime() : null,
      lastCompleted: autoSyncStatus.lastCompleted,
      lastDuration: autoSyncStatus.lastDuration,
      lastError: autoSyncStatus.lastError,
      results: autoSyncStatus.results,
      nextSyncIn: Math.max(0, SYNC_INTERVAL - timeSinceLastSync),
      manualSyncInProgress: autoSyncStatus.manualSyncInProgress
    }
  });
});

// Manual sync coordination endpoints
app.post('/api/sync/manual-start', (req, res) => {
  autoSyncStatus.manualSyncInProgress = true;
  console.log('📝 Manual sync started - auto-sync will be delayed');
  res.json({ success: true, message: 'Manual sync registered' });
});

app.post('/api/sync/manual-complete', (req, res) => {
  autoSyncStatus.manualSyncInProgress = false;
  autoSyncStatus.lastManualSyncCompleted = new Date().toISOString();
  console.log(`dY"? Manual sync completed - next auto-sync delayed by ${Math.round(SYNC_INTERVAL / 60000)} minutes`);
  res.json({ success: true, message: 'Manual sync completion registered' });
});

async function autoSync() {
  // Prevent concurrent auto-syncs
  if (autoSyncStatus.isRunning) {
    console.log('⚠️ Auto-sync already in progress, skipping...');
    return;
  }

  // Skip if manual sync is in progress
  if (autoSyncStatus.manualSyncInProgress) {
    console.log('⏸️ Manual sync in progress - skipping auto-sync');
    return;
  }

  // Skip if a sync (manual or auto) happened recently (within MIN_SYNC_GAP)
  const lastSyncTime = autoSyncStatus.lastManualSyncCompleted
    ? Math.max(
      new Date(autoSyncStatus.lastCompleted || 0).getTime(),
      new Date(autoSyncStatus.lastManualSyncCompleted).getTime()
    )
    : (autoSyncStatus.lastCompleted ? new Date(autoSyncStatus.lastCompleted).getTime() : 0);

  const timeSinceLastSync = Date.now() - lastSyncTime;

  if (lastSyncTime > 0 && timeSinceLastSync < MIN_SYNC_GAP) {
    const waitTime = Math.ceil((MIN_SYNC_GAP - timeSinceLastSync) / 1000);
    console.log(`⏸️ Recent sync detected - waiting ${waitTime}s before next auto-sync`);
    return;
  }

  const syncStartTime = Date.now();
  autoSyncStatus.isRunning = true;
  autoSyncStatus.startedAt = new Date().toISOString();
  autoSyncStatus.currentStep = 'starting';
  autoSyncStatus.lastError = null;
  autoSyncStatus.results = {};

  console.log('\n🔄 ===== AUTO-SYNC STARTED =====');
  console.log(`⏰ Time: ${new Date().toLocaleString()}`);

  try {
    // Sync vendors and customers in PARALLEL
    autoSyncStatus.currentStep = 'vendors_customers';
    console.log('🚀 Phase 1: Syncing vendors and customers in parallel...');
    const phase1Start = Date.now();

    const [vendorResponse, customerResponse] = await Promise.all([
      axios.post(`http://localhost:${PORT}/api/sync/vendors`),
      axios.post(`http://localhost:${PORT}/api/sync/customers`)
    ]);

    const phase1Duration = Date.now() - phase1Start;
    console.log(`✅ Phase 1 completed in ${phase1Duration}ms`);

    autoSyncStatus.results.vendors = { count: vendorResponse.data.count, success: true };
    autoSyncStatus.results.customers = { count: customerResponse.data.count, success: true };

    console.log(`   Vendors: ${vendorResponse.data.count} synced`);
    console.log(`   Customers: ${customerResponse.data.count} synced`);

    // Sync transactions (incremental or full based on last sync)
    autoSyncStatus.currentStep = 'transactions';
    console.log('💰 Syncing transactions...');
    const transactionResponse = await axios.post(`http://localhost:${PORT}/api/sync/transactions`, {});
    const txData = transactionResponse.data;
    const modeEmoji = txData.syncMode === 'incremental' ? '⚡' : '📦';
    autoSyncStatus.results.transactions = {
      count: txData.count,
      mode: txData.syncMode || 'full',
      duration: txData.duration,
      success: true
    };
    console.log(`✅ Transactions: ${txData.count} synced ${modeEmoji} (${txData.syncMode || 'full'} mode) ${txData.duration || ''}`);

    // Calculate analytics
    autoSyncStatus.currentStep = 'analytics';
    console.log('📊 Calculating analytics...');
    const analyticsResponse = await axios.post(`http://localhost:${PORT}/api/analytics/calculate`);
    autoSyncStatus.results.analytics = { success: true };
    console.log(`✅ Analytics: ${analyticsResponse.data.message}`);

    // Refresh materialized views for faster dashboards
    autoSyncStatus.currentStep = 'refresh_views';
    const viewRefreshResult = await refreshMaterializedViews();
    autoSyncStatus.results.views = viewRefreshResult;
    if (viewRefreshResult.success) {
      console.log(`�o. Materialized views refreshed ${viewRefreshResult.fallback ? '(non-concurrent)' : ''}`);
    } else {
      console.warn('�s��,? Materialized view refresh failed:', viewRefreshResult.error);
    }

    const totalDuration = Date.now() - syncStartTime;
    autoSyncStatus.lastDuration = totalDuration;
    autoSyncStatus.lastCompleted = new Date().toISOString();

    console.log(`🎉 ===== AUTO-SYNC COMPLETED in ${Math.round(totalDuration / 1000)}s =====\n`);
  } catch (error) {
    console.error('❌ Auto-sync failed:', error.message);
    autoSyncStatus.lastError = error.message;
    autoSyncStatus.results.error = error.message;
  } finally {
    autoSyncStatus.isRunning = false;
    autoSyncStatus.currentStep = null;
  }
}

// Start server with auto-sync
let syncInterval;

// Add error handler for server listen
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Tally Middleware Server Started`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`📊 Tally: ${TALLY_URL}`);
  const dbStatus = pool ? '✅ Connected' : '⚠️ Not configured (DATABASE_URL missing)';
  console.log(`💾 Database: ${dbStatus}`);
  if (!pool) {
    console.log(`   ⚠️  Create a .env file in the root directory with:`);
    console.log(`   ⚠️  DATABASE_URL=your_postgres_connection_string`);
  }
  console.log(`\nAvailable endpoints:`);
  console.log(`   GET  /api/test`);
  console.log(`   GET  /api/test-odbc ⭐ Test Tally ODBC connection`);
  console.log(`   GET  /api/company/detect ⭐ Auto-detect companies`);
  console.log(`   POST /api/company/verify ⭐ Verify manual entry`);
  console.log(`   POST /api/company/setup ⭐ Save company config`);
  console.log(`   GET  /api/company/config ⭐ Get company config`);
  console.log(`   POST /api/company/reset ⭐ Reset company config`);
  console.log(`   GET  /api/vendors`);
  console.log(`   GET  /api/vendors/:id`);
  console.log(`   POST /api/sync/vendors`);
  console.log(`   GET  /api/customers`);
  console.log(`   GET  /api/customers/:id`);
  console.log(`   POST /api/sync/customers`);
  console.log(`   GET  /api/transactions`);
  console.log(`   GET  /api/transactions/search`);
  console.log(`   GET  /api/transactions/:id`);
  console.log(`   POST /api/sync/transactions ⚡ Incremental sync support`);
  console.log(`   GET  /api/sync/history ⭐ View sync history`);
  console.log(`   GET  /api/sync/history/log ⭐ Full sync audit log`);
  console.log(`   POST /api/sync/reset ⭐ Reset sync history (force full sync)`);
  console.log(`   GET  /api/stats`);
  console.log(`   GET  /api/dashboard/performance`);
  console.log(`   GET  /api/analytics/vendor-scores ⭐`);
  console.log(`   GET  /api/analytics/aging ⚡ Uses materialized views (292x faster!)`);
  console.log(`   GET  /api/analytics/payment-cycles ⭐`);
  console.log(`   POST /api/analytics/calculate ⭐ Refreshes materialized views`);
  console.log(`   GET  /api/test/materialized-views ⭐ Test MV performance`);
  console.log(`\n⏰ Auto-sync: Every ${Math.round(SYNC_INTERVAL / 60000)} minutes`);
  console.log(`🔄 First sync in 10 seconds...\n`);

  // Run first sync after 10 seconds, then on the configured interval
  setTimeout(() => {
    autoSync();
    syncInterval = setInterval(autoSync, SYNC_INTERVAL);
  }, 10000);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ ERROR: Port ${PORT} is already in use!`);
    console.error(`   Another process is using port ${PORT}`);
    console.error(`   Please close that process or change PORT in .env file\n`);
  } else {
    console.error(`\n❌ ERROR: Failed to start server:`, err.message);
  }
  // Don't exit - let Electron handle it
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('\n👋 SIGTERM received, shutting down gracefully...');
  clearInterval(syncInterval);
  server.close(() => {
    console.log('✅ Server closed');
    pool.end(() => {
      console.log('✅ Database connection closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('\n👋 SIGINT received, shutting down gracefully...');
  clearInterval(syncInterval);
  server.close(() => {
    console.log('✅ Server closed');
    pool.end(() => {
      console.log('✅ Database connection closed');
      process.exit(0);
    });
  });
});




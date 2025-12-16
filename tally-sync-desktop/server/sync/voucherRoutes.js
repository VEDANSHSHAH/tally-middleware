/**
 * VOUCHER SYNC API ENDPOINT
 * =========================
 * New endpoint that syncs to vouchers + voucher_line_items tables
 * instead of the flat transactions table.
 * 
 * Usage:
 *   POST /api/sync/vouchers
 *   Body: { startDate?, endDate?, forceFullSync? }
 * 
 * This file is self-contained and can be integrated into server.js
 */

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const router = express.Router();

const { buildVoucherFetchXML, syncVouchers, clearCaches } = require('./voucherSync');
const { pool } = require('../db/postgres');
const { getCompanyInfo } = require('../tally/companyInfo');
const cache = require('../cache');
const { updateProgress, getProgress, resetProgress } = require('../syncProgress');
const { loadConfig } = require('../utils/config');
const { formatTallyDate } = require('../utils/tallyHelpers');

// =====================================================
// CONFIG & HELPER FUNCTIONS
// =====================================================

const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9000';

async function queryTally(xmlRequest, options = {}) {
  const { timeout = 60000, retries = 2, queryType = 'unknown' } = options;
  
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔄 Retry ${attempt}/${retries} for ${queryType}...`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }

      const axiosConfig = {
        headers: { 'Content-Type': 'application/xml' }
      };
      if (timeout > 0) {
        axiosConfig.timeout = timeout;
      }
      
      const response = await axios.post(TALLY_URL, xmlRequest, axiosConfig);
      const parser = new xml2js.Parser({ explicitArray: false });
      return await parser.parseStringPromise(response.data);
    } catch (error) {
      lastError = error;
      if (!error.message.includes('timeout') && !error.code?.includes('ECONN')) {
        console.error(`❌ Tally query error (${queryType}):`, error.message);
        throw error;
      }
      if (attempt < retries) {
        console.warn(`⚠️  Tally timeout (${queryType}), retrying... (${attempt}/${retries})`);
      }
    }
  }
  throw lastError;
}

// Get last sync time for vouchers
async function getLastSyncTime(companyGuid) {
  try {
    if (!pool) return null;
    const result = await pool.query(
      `SELECT MAX(synced_at) as last_sync FROM vouchers WHERE company_guid = $1`,
      [companyGuid]
    );
    return result.rows[0]?.last_sync || null;
  } catch (error) {
    console.warn('Could not get last sync time:', error.message);
    return null;
  }
}

// Decide if full sync is needed
async function shouldRunFullSync(companyGuid) {
  const lastSync = await getLastSyncTime(companyGuid);
  
  if (!lastSync) {
    return { isFullSync: true, reason: 'first_sync', lastSyncTime: null };
  }
  
  const daysSinceSync = (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24);
  
  if (daysSinceSync > 7) {
    return { isFullSync: true, reason: 'stale_data', lastSyncTime: lastSync };
  }
  
  return { isFullSync: false, reason: 'incremental', lastSyncTime: lastSync };
}

// Log sync to history
async function logSyncToHistory(companyGuid, syncStartedAt, recordsCount, durationMs, mode, fromDate, toDate, errorMessage = null) {
  try {
    if (!pool) return;
    
    await pool.query(`
      INSERT INTO sync_history_log (
        company_guid, data_type, sync_started_at, records_synced, 
        duration_ms, sync_mode, from_date, to_date, error_message, synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `, [
      companyGuid, 'vouchers', syncStartedAt, recordsCount,
      durationMs, mode, fromDate, toDate, errorMessage
    ]);
  } catch (error) {
    // Table might not exist - that's okay
    console.warn('Could not log sync history:', error.message);
  }
}

// =====================================================
// ROUTES
// =====================================================

/**
 * POST /api/sync/vouchers
 * Sync vouchers from Tally to vouchers + voucher_line_items tables
 */
router.post('/', async (req, res) => {
  const syncStartTime = Date.now();
  
  try {
    console.log('🔄 Starting VOUCHER sync from Tally (NEW - normalized tables)...');
    
    // Get company GUID from config
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    
    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured. Please run setup first.'
      });
    }
    
    // Verify company match
    const tallyCompanyInfo = await getCompanyInfo();
    
    if (!tallyCompanyInfo || !tallyCompanyInfo.guid) {
      return res.json({
        success: false,
        error: 'Could not detect company from Tally. Make sure Tally is running.'
      });
    }
    
    if (tallyCompanyInfo.guid.toLowerCase() !== companyGuid.toLowerCase()) {
      return res.json({
        success: false,
        error: `Company mismatch! Tally has "${tallyCompanyInfo.name}" but you selected "${config.company.name}".`
      });
    }
    
    console.log(`✅ Company verified: ${tallyCompanyInfo.name}`);
    
    // Determine sync mode
    const { startDate, endDate, forceFullSync } = req.body;
    let fromDate, toDate;
    let syncMode = 'full';
    let syncReason = '';
    let alteredAfter = null;
    
    toDate = endDate || new Date().toISOString().split('T')[0];
    
    // Check if we should run incremental or full sync
    const syncDecision = await shouldRunFullSync(companyGuid);
    
    if (forceFullSync) {
      syncMode = 'full';
      syncReason = 'user_requested';
      fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      console.log(`📅 Force full sync - syncing last 365 days`);
    } else if (startDate) {
      fromDate = startDate;
      syncMode = 'custom';
      syncReason = 'custom_date_range';
      console.log(`📅 Custom date range: ${fromDate} to ${toDate}`);
    } else if (syncDecision.isFullSync) {
      syncMode = 'full';
      syncReason = syncDecision.reason;
      fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      console.log(`📅 Full sync (${syncReason}) - last 365 days`);
    } else {
      syncMode = 'incremental';
      syncReason = 'incremental';
      const lastSyncDate = new Date(syncDecision.lastSyncTime);
      lastSyncDate.setHours(lastSyncDate.getHours() - 2);
      fromDate = lastSyncDate.toISOString().split('T')[0];
      alteredAfter = formatTallyDate(lastSyncDate);
      console.log(`⚡ INCREMENTAL sync - since ${fromDate}`);
    }
    
    // Convert to Tally format
    const tallyFromDate = formatTallyDate(fromDate);
    const tallyToDate = formatTallyDate(toDate);
    
    console.log(`📅 Fetching vouchers from ${tallyFromDate} to ${tallyToDate}`);
    
    // Build XML request with ALL fields
    const xmlRequest = buildVoucherFetchXML(tallyFromDate, tallyToDate, alteredAfter);
    
    // Initialize progress
    updateProgress('voucher', {
      inProgress: true,
      total: 0,
      current: 0,
      startTime: Date.now()
    });
    
    // Query Tally
    console.log('📡 Querying Tally for vouchers...');
    const result = await queryTally(xmlRequest, {
      timeout: 900000, // 15 minutes
      retries: 3,
      queryType: 'voucher_sync'
    });
    
    // Check if we got data
    const voucherData = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER;
    
    if (!voucherData) {
      resetProgress('voucher');
      return res.json({
        success: true,
        message: 'No vouchers found in Tally for the specified period',
        count: 0,
        syncMode,
        syncReason
      });
    }
    
    const voucherArray = Array.isArray(voucherData) ? voucherData : [voucherData];
    console.log(`📊 Found ${voucherArray.length} vouchers in Tally`);
    
    // Update progress with total
    updateProgress('voucher', {
      total: voucherArray.length
    });
    
    // Sync vouchers using new module
    const syncResult = await syncVouchers({
      companyGuid,
      tallyVouchers: voucherArray,
      onProgress: (current, total) => {
        updateProgress('voucher', {
          current,
          percentage: Math.round((current / total) * 100)
        });
      }
    });
    
    // Log sync
    const syncDuration = Date.now() - syncStartTime;
    await logSyncToHistory(
      companyGuid,
      new Date(syncStartTime),
      syncResult.totalProcessed,
      syncDuration,
      syncMode,
      fromDate,
      toDate,
      syncResult.errors.length > 0 ? `${syncResult.errors.length} errors` : null
    );
    
    // Update company last_sync
    try {
      await pool.query(
        'UPDATE companies SET last_sync = NOW() WHERE company_guid = $1',
        [companyGuid]
      );
    } catch (e) {
      console.warn('Could not update company last_sync:', e.message);
    }
    
    // Clear cache
    cache.deletePattern(`vouchers:${companyGuid}*`);
    cache.deletePattern(`stats:${companyGuid}*`);
    
    // Reset progress
    resetProgress('voucher');
    
    // Return results
    res.json({
      success: true,
      message: `Successfully synced ${syncResult.totalProcessed} vouchers (${syncMode} sync)`,
      data: {
        totalProcessed: syncResult.totalProcessed,
        vouchersInserted: syncResult.vouchersInserted,
        vouchersUpdated: syncResult.vouchersUpdated,
        lineItemsInserted: syncResult.lineItemsInserted,
        errors: syncResult.errors.length,
        duration: `${syncResult.durationSeconds}s`
      },
      syncMode,
      syncReason,
      period: { from: fromDate, to: toDate },
      errors: syncResult.errors.length > 0 ? syncResult.errors.slice(0, 10) : undefined
    });
    
  } catch (error) {
    console.error('❌ Voucher sync error:', error);
    resetProgress('voucher');
    
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Make sure Tally is running with ODBC enabled'
    });
  }
});

/**
 * GET /api/vouchers
 * Get vouchers from database with pagination
 */
router.get('/', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    
    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured'
      });
    }
    
    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    // Filters
    const { voucherType, startDate, endDate, partyName, search } = req.query;
    
    let whereConditions = ['v.company_guid = $1'];
    let params = [companyGuid];
    let paramCount = 2;
    
    if (voucherType) {
      whereConditions.push(`v.voucher_type = $${paramCount}`);
      params.push(voucherType);
      paramCount++;
    }
    
    if (startDate) {
      whereConditions.push(`v.date >= $${paramCount}`);
      params.push(startDate);
      paramCount++;
    }
    
    if (endDate) {
      whereConditions.push(`v.date <= $${paramCount}`);
      params.push(endDate);
      paramCount++;
    }
    
    if (partyName) {
      whereConditions.push(`v.party_name ILIKE $${paramCount}`);
      params.push(`%${partyName}%`);
      paramCount++;
    }
    
    if (search) {
      whereConditions.push(`(
        v.voucher_number ILIKE $${paramCount} OR
        v.party_name ILIKE $${paramCount} OR
        v.narration ILIKE $${paramCount}
      )`);
      params.push(`%${search}%`);
      paramCount++;
    }
    
    const whereClause = whereConditions.join(' AND ');
    
    // Get paginated data with party info
    const [dataResult, countResult] = await Promise.all([
      pool.query(`
        SELECT 
          v.*,
          l.gstin as party_gstin,
          l.state as party_state,
          (SELECT COUNT(*) FROM voucher_line_items WHERE voucher_id = v.id) as line_count
        FROM vouchers v
        LEFT JOIN ledgers l ON v.party_ledger_id = l.id
        WHERE ${whereClause}
        ORDER BY v.date DESC, v.created_at DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `, [...params, limit, offset]),
      
      pool.query(`
        SELECT COUNT(*) as total FROM vouchers v WHERE ${whereClause}
      `, params)
    ]);
    
    const totalRecords = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalRecords / limit);
    
    res.json({
      success: true,
      page,
      limit,
      totalRecords,
      totalPages,
      hasMore: page < totalPages,
      count: dataResult.rows.length,
      vouchers: dataResult.rows
    });
    
  } catch (error) {
    console.error('Error fetching vouchers:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/vouchers/:id
 * Get single voucher with all line items
 */
router.get('/:id', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    
    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured'
      });
    }
    
    const voucherId = req.params.id;
    
    // Get voucher
    const voucherResult = await pool.query(`
      SELECT 
        v.*,
        l.name as party_name_from_ledger,
        l.gstin as party_gstin,
        l.state as party_state,
        l.credit_days,
        l.credit_limit
      FROM vouchers v
      LEFT JOIN ledgers l ON v.party_ledger_id = l.id
      WHERE v.id = $1 AND v.company_guid = $2
    `, [voucherId, companyGuid]);
    
    if (voucherResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voucher not found'
      });
    }
    
    // Get line items
    const lineItemsResult = await pool.query(`
      SELECT 
        vli.*,
        l.name as ledger_name_from_db,
        i.hsn_code,
        i.gst_rate as item_gst_rate
      FROM voucher_line_items vli
      LEFT JOIN ledgers l ON vli.ledger_id = l.id
      LEFT JOIN items i ON vli.item_id = i.id
      WHERE vli.voucher_id = $1
      ORDER BY vli.line_number
    `, [voucherId]);
    
    res.json({
      success: true,
      voucher: voucherResult.rows[0],
      lineItems: lineItemsResult.rows
    });
    
  } catch (error) {
    console.error('Error fetching voucher:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/vouchers/stats/summary
 * Get voucher statistics
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    
    if (!companyGuid) {
      return res.json({
        success: false,
        error: 'Company not configured'
      });
    }
    
    const { startDate, endDate } = req.query;
    
    let dateFilter = '';
    const params = [companyGuid];
    
    if (startDate && endDate) {
      dateFilter = 'AND date BETWEEN $2 AND $3';
      params.push(startDate, endDate);
    }
    
    const result = await pool.query(`
      SELECT 
        voucher_type,
        COUNT(*) as count,
        SUM(total_amount) as total_amount,
        AVG(total_amount) as avg_amount,
        MIN(date) as first_date,
        MAX(date) as last_date
      FROM vouchers
      WHERE company_guid = $1 ${dateFilter}
      GROUP BY voucher_type
      ORDER BY count DESC
    `, params);
    
    // Get totals
    const totalsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_vouchers,
        SUM(total_amount) as total_amount,
        COUNT(DISTINCT party_ledger_id) as unique_parties,
        COUNT(DISTINCT DATE_TRUNC('day', date)) as active_days
      FROM vouchers
      WHERE company_guid = $1 ${dateFilter}
    `, params);
    
    res.json({
      success: true,
      byType: result.rows,
      totals: totalsResult.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching voucher stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

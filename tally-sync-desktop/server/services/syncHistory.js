const { pool } = require('../db/postgres');

// Sync history helpers extracted from app.js to keep the entry lean
async function getLastSyncTime(companyGuid, dataType) {
  try {
    if (!pool) return null;
    const result = await pool.query(
      'SELECT get_last_sync_time($1, $2) as last_sync',
      [companyGuid, dataType]
    );
    return result.rows[0]?.last_sync || null;
  } catch (error) {
    console.warn('Could not get last sync time (run incremental migration?):', error.message);
    return null;
  }
}

async function updateSyncHistory(companyGuid, dataType, recordsCount, durationMs, mode, fromDate = null, toDate = null, errorMessage = null) {
  try {
    if (!pool) return;
    await pool.query(
      'SELECT update_sync_history($1, $2, $3, $4, $5, $6, $7, $8)',
      [companyGuid, dataType, recordsCount, durationMs, mode, fromDate, toDate, errorMessage]
    );
    console.log(`Sync history updated: ${dataType} - ${recordsCount} records (${mode} mode) in ${Math.round(durationMs / 1000)}s`);
  } catch (error) {
    console.warn('Could not update sync history (run incremental migration?):', error.message);
  }
}

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
    console.warn('Could not log sync history:', error.message);
  }
}

async function getFallbackLastSync(companyGuid, dataType) {
  try {
    if (!pool || !companyGuid) return null;
    const tableMap = { vendors: 'vendors', customers: 'customers', transactions: 'transactions' };
    const table = tableMap[dataType];
    if (!table) return null;

    const result = await pool.query(
      `SELECT MAX(synced_at) AS last_sync FROM ${table} WHERE company_guid = $1`,
      [companyGuid]
    );
    return result.rows[0]?.last_sync || null;
  } catch (error) {
    console.warn('Fallback last-sync lookup failed:', error.message);
    return null;
  }
}

async function shouldRunFullSync(companyGuid, dataType) {
  let lastSync = await getLastSyncTime(companyGuid, dataType);

  if (!lastSync) {
    const fallback = await getFallbackLastSync(companyGuid, dataType);
    if (fallback) {
      lastSync = fallback;
      console.log(`Using fallback last sync from ${dataType} table: ${new Date(lastSync).toLocaleString()}`);
    }
  }

  if (!lastSync) {
    console.log(`No previous sync found for ${dataType} - Running FULL sync`);
    return { isFullSync: true, lastSyncTime: null, reason: 'first_sync' };
  }

  const daysSinceLastSync = (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLastSync > 7) {
    console.log(`Last sync was ${Math.floor(daysSinceLastSync)} days ago - Running FULL sync for consistency`);
    return { isFullSync: true, lastSyncTime: lastSync, reason: 'stale_data' };
  }

  console.log(`Last sync: ${new Date(lastSync).toLocaleString()} - Running INCREMENTAL sync`);
  return { isFullSync: false, lastSyncTime: lastSync, reason: 'incremental' };
}

module.exports = {
  getLastSyncTime,
  updateSyncHistory,
  logSyncToHistory,
  getFallbackLastSync,
  shouldRunFullSync
};

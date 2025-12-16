const axios = require('axios');

/**
 * Auto-sync scheduler and status endpoints.
 * Kept separate from the main app wiring to keep app.js small.
 */
function setupAutoSync(app, { port, refreshMaterializedViews }) {
  const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
  const MIN_SYNC_GAP = 2 * 60 * 1000; // Minimum 2 minutes between any syncs

  const autoSyncStatus = {
    isRunning: false,
    startedAt: null,
    currentStep: null,
    lastCompleted: null,
    lastDuration: null,
    lastError: null,
    results: {},
    manualSyncInProgress: false,
    lastManualSyncCompleted: null
  };

  // Expose status for UI
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
    console.log(`📝 Manual sync completed - next auto-sync delayed by ${Math.round(SYNC_INTERVAL / 60000)} minutes`);
    res.json({ success: true, message: 'Manual sync completion registered' });
  });

  async function autoSync() {
    if (autoSyncStatus.isRunning) {
      console.log('⚠️ Auto-sync already in progress, skipping...');
      return;
    }

    if (autoSyncStatus.manualSyncInProgress) {
      console.log('⏸️ Manual sync in progress - skipping auto-sync');
      return;
    }

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

    console.log('\n🚀 ===== AUTO-SYNC STARTED =====');
    console.log(`🕒 Time: ${new Date().toLocaleString()}`);

    try {
      autoSyncStatus.currentStep = 'vendors_customers';
      console.log('📦 Phase 1: Syncing vendors and customers in parallel...');
      const phase1Start = Date.now();

      const [vendorResponse, customerResponse] = await Promise.all([
        axios.post(`http://localhost:${port}/api/sync/vendors`),
        axios.post(`http://localhost:${port}/api/sync/customers`)
      ]);

      const phase1Duration = Date.now() - phase1Start;
      console.log(`✅ Phase 1 completed in ${phase1Duration}ms`);

      autoSyncStatus.results.vendors = {
        count: vendorResponse.data.count,
        success: true,
        mode: vendorResponse.data.syncMode || 'full'
      };
      autoSyncStatus.results.customers = {
        count: customerResponse.data.count,
        success: true,
        mode: customerResponse.data.syncMode || 'full'
      };

      console.log(`   Vendors: ${vendorResponse.data.count} synced (${vendorResponse.data.syncMode || 'full'} mode)`);
      console.log(`   Customers: ${customerResponse.data.count} synced (${customerResponse.data.syncMode || 'full'} mode)`);

      autoSyncStatus.currentStep = 'transactions';
      console.log('📃 Syncing transactions...');
      const transactionResponse = await axios.post(`http://localhost:${port}/api/sync/transactions`, {});
      const txData = transactionResponse.data;
      const modeEmoji = txData.syncMode === 'incremental' ? '⚡' : '🧹';
      autoSyncStatus.results.transactions = {
        count: txData.count,
        mode: txData.syncMode || 'full',
        duration: txData.duration,
        success: true
      };
      console.log(`✅ Transactions: ${txData.count} synced ${modeEmoji} (${txData.syncMode || 'full'} mode) ${txData.duration || ''}`);

      autoSyncStatus.currentStep = 'payment_references';
      console.log('✅ Syncing payment references...');
      const prResponse = await axios.post(`http://localhost:${port}/api/sync/payment-references`);
      autoSyncStatus.results.payment_references = {
        count: prResponse.data.count,
        success: prResponse.data.success !== false
      };
      console.log(`✅ Payment references: ${prResponse.data.count} inserted`);

      autoSyncStatus.currentStep = 'analytics';
      console.log('📊 Calculating analytics...');
      const analyticsResponse = await axios.post(`http://localhost:${port}/api/analytics/calculate`);
      autoSyncStatus.results.analytics = { success: true };
      console.log(`✅ Analytics: ${analyticsResponse.data.message}`);

      autoSyncStatus.currentStep = 'refresh_views';
      const viewRefreshResult = await refreshMaterializedViews();
      autoSyncStatus.results.views = viewRefreshResult;
      if (viewRefreshResult.success) {
        console.log(`✅ Materialized views refreshed ${viewRefreshResult.fallback ? '(non-concurrent)' : ''}`);
      } else {
        console.warn('⚠️ Materialized view refresh failed:', viewRefreshResult.error);
      }

      const totalDuration = Date.now() - syncStartTime;
      autoSyncStatus.lastDuration = totalDuration;
      autoSyncStatus.lastCompleted = new Date().toISOString();

      console.log(`🏁 ===== AUTO-SYNC COMPLETED in ${Math.round(totalDuration / 1000)}s =====\n`);
    } catch (error) {
      console.error('❌ Auto-sync failed:', error.message);
      autoSyncStatus.lastError = error.message;
      autoSyncStatus.results.error = error.message;
    } finally {
      autoSyncStatus.isRunning = false;
      autoSyncStatus.currentStep = null;
    }
  }

  let syncIntervalHandle = null;

  function startAutoSync() {
    // Run first sync after 10 seconds, then on the configured interval
    setTimeout(() => {
      autoSync();
      syncIntervalHandle = setInterval(autoSync, SYNC_INTERVAL);
    }, 10000);
  }

  function stopAutoSync() {
    if (syncIntervalHandle) {
      clearInterval(syncIntervalHandle);
      syncIntervalHandle = null;
    }
  }

  return {
    autoSync,
    autoSyncStatus,
    startAutoSync,
    stopAutoSync,
    SYNC_INTERVAL,
    MIN_SYNC_GAP
  };
}

module.exports = setupAutoSync;

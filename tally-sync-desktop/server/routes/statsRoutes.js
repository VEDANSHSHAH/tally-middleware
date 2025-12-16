function registerStatsRoutes(app, deps) {
  const {
    cache,
    formatCurrency,
    loadConfig,
    pool
  } = deps;


// Database stats endpoint with caching
app.get('/api/stats', async (req, res) => {
  try {
    // Check database connection first
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: 'Database not configured. Please check DATABASE_URL in .env file.'
      });
    }

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

    // Execute queries in parallel for better performance with timeout handling
    const queryTimeout = 25000; // 25 seconds timeout per query
    
    const queryWithTimeout = (queryText, queryParams) => {
      return Promise.race([
        pool.query(queryText, queryParams),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Query timeout exceeded')), queryTimeout)
        )
      ]);
    };

    const [vendorStats, customerStats, transactionStats, lastSyncResult] = await Promise.all([
      // Vendors stats - FILTERED
      queryWithTimeout(`
        SELECT 
          COUNT(*) as total_vendors,
          COALESCE(SUM(current_balance), 0) as total_payables,
          MAX(synced_at) as last_vendor_sync
        FROM vendors 
        ${whereClause}
      `, params).catch(err => {
        console.error('⚠️ Vendor stats query failed:', err.message);
        return { rows: [{ total_vendors: 0, total_payables: 0, last_vendor_sync: null }] };
      }),

      // Customers stats - FILTERED
      queryWithTimeout(`
        SELECT 
          COUNT(*) as total_customers,
          COALESCE(SUM(current_balance), 0) as total_receivables,
          MAX(synced_at) as last_customer_sync
        FROM customers 
        ${whereClause}
      `, params).catch(err => {
        console.error('⚠️ Customer stats query failed:', err.message);
        return { rows: [{ total_customers: 0, total_receivables: 0, last_customer_sync: null }] };
      }),

      // Transactions stats - FILTERED
      queryWithTimeout(`
        SELECT 
          COUNT(*) as total_transactions,
          COALESCE(SUM(CASE WHEN voucher_type LIKE '%Payment%' THEN amount ELSE 0 END), 0) as total_payments,
          COALESCE(SUM(CASE WHEN voucher_type LIKE '%Receipt%' THEN amount ELSE 0 END), 0) as total_receipts,
          MAX(synced_at) as last_transaction_sync
        FROM transactions 
        ${whereClause}
      `, params).catch(err => {
        console.error('⚠️ Transaction stats query failed:', err.message);
        return { rows: [{ total_transactions: 0, total_payments: 0, total_receipts: 0, last_transaction_sync: null }] };
      }),

      // Last sync from companies table
      queryWithTimeout(`
        SELECT last_sync 
        FROM companies 
        WHERE company_guid = $1
      `, [companyGuid]).catch(err => {
        console.error('⚠️ Last sync query failed:', err.message);
        return { rows: [{ last_sync: null }] };
      })
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
    console.error('❌ Stats endpoint error:', error.message);
    console.error('   Stack:', error.stack);
    
    // Provide more helpful error messages
    let errorMessage = error.message;
    if (error.message.includes('timeout') || error.message.includes('Connection terminated')) {
      errorMessage = 'Database connection timeout. The database may be slow or unreachable.';
    } else if (error.message.includes('ECONNREFUSED')) {
      errorMessage = 'Cannot connect to database. Please check DATABASE_URL and ensure the database is running.';
    }
    
    res.status(500).json({ 
      success: false, 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


}

module.exports = registerStatsRoutes;

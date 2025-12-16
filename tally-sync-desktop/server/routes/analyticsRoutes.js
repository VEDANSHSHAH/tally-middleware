function registerAnalyticsRoutes(app, deps) {
  const {
    cache,
    calculateOutstandingAging,
    calculateVendorScores,
    calculateVendorSettlementCycles,
    formatCurrency,
    loadConfig,
    pool,
    refreshAllViews,
    refreshMaterializedViews
  } = deps;


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


}

module.exports = registerAnalyticsRoutes;

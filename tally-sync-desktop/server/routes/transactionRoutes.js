function registerTransactionRoutes(app, deps) {
  const {
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
  } = deps;


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


}

module.exports = registerTransactionRoutes;

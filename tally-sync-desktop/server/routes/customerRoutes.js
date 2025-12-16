function registerCustomerRoutes(app, deps) {
  const {
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
  } = deps;


// Get all customers from PostgreSQL
app.get('/api/customers', async (req, res) => {
  try {
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    const companyTag = currentCompanyTag(config);
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
  const syncStartTime = Date.now();
  try {
    console.log('🔄 Starting customer sync from Tally...');

    // Get company GUID from config
    const config = loadConfig();
    const companyGuid = config?.company?.guid;
    const companyTag = currentCompanyTag(config);

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

    // Determine whether to run full or incremental sync
    const { forceFullSync } = req.body || {};
    const syncDecision = await shouldRunFullSync(companyGuid, 'customers');
    let syncMode = 'full';
    let syncReason = 'full';
    let alteredAfter = null;
    let fromDate = null;
    const toDate = new Date().toISOString().split('T')[0];

    if (forceFullSync) {
      syncReason = 'user_requested';
      console.log('Force full customer sync requested');
    } else if (syncDecision.isFullSync) {
      syncReason = syncDecision.reason;
      console.log(`📦 Running FULL customer sync (${syncReason})`);
    } else {
      syncMode = 'incremental';
      syncReason = 'incremental';
      const lastSyncDate = new Date(syncDecision.lastSyncTime);
      // Look back 1 day to avoid missing late edits
      lastSyncDate.setDate(lastSyncDate.getDate() - 1);
      fromDate = lastSyncDate.toISOString().split('T')[0];
      alteredAfter = formatTallyDate(lastSyncDate); // Tally expects YYYYMMDD
      console.log(`⚡ Running INCREMENTAL customer sync since ${fromDate} (Tally date ${alteredAfter})`);
    }

    const buildCustomerRequest = (alterDate) => `
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
              ${companyTag}
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <COLLECTION NAME="Ledger Collection">
                  <TYPE>Ledger</TYPE>
                  <FETCH>GUID, Name, OpeningBalance, ClosingBalance, Parent, AlteredOn, AlterId</FETCH>
                  ${alterDate ? '<FILTER>ModifiedSince</FILTER>' : ''}
                </COLLECTION>
                ${alterDate ? `
                <SYSTEM TYPE="Formulae" NAME="ModifiedSince">
                  $AlteredOn >= $$Date:##SVAlteredAfter
                </SYSTEM>
                <VARIABLE NAME="SVAlteredAfter" TYPE="Date">${alterDate}</VARIABLE>
                ` : ''}
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    let result;

    try {
      result = await queryTally(buildCustomerRequest(alteredAfter), { queryType: 'customer_sync' });
    } catch (err) {
      if (alteredAfter) {
        console.warn(`⚠️ Incremental customer fetch failed (${err.message}), falling back to full sync...`);
        syncMode = 'full_fallback';
        syncReason = 'incremental_fallback';
        alteredAfter = null;
        fromDate = null;
        result = await queryTally(buildCustomerRequest(null), { queryType: 'customer_sync_full_fallback' });
      } else {
        throw err;
      }
    }

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER) {
      const syncDuration = Date.now() - syncStartTime;
      await updateSyncHistory(companyGuid, 'customers', 0, syncDuration, syncMode, fromDate, toDate, null);
      await logSyncToHistory(companyGuid, 'customers', new Date(syncStartTime), 0, syncDuration, syncMode, fromDate, toDate, null);
      return res.json({
        success: true,
        message: 'No customers found in Tally',
        count: 0,
        syncMode,
        syncReason,
        duration: `${Math.round(syncDuration / 1000)}s`
      });
    }

    let ledgers = result.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
    let ledgerArray = Array.isArray(ledgers) ? ledgers : [ledgers];

    // Incremental sometimes returns nothing if AlteredOn is blank in Tally; retry with full fetch.
    if (ledgerArray.length === 0 && alteredAfter) {
      console.warn('Incremental customer sync returned 0 ledgers, retrying with full fetch...');
      syncMode = 'full_fallback';
      syncReason = 'incremental_empty';
      alteredAfter = null;
      fromDate = null;
      result = await queryTally(buildCustomerRequest(null), { queryType: 'customer_sync_full_on_empty' });
      ledgers = result.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
      ledgerArray = Array.isArray(ledgers) ? ledgers : (ledgers ? [ledgers] : []);
    }

    const groupHierarchy = await loadGroupHierarchy(companyGuid);

    // Filter to only get ledgers under Sundry Debtors (including nested groups)
    let customers = ledgerArray.filter(ledger => {
      const parent = extractValue(ledger.PARENT) || ledger.PARENT;
      const parentName = typeof parent === 'string' ? parent.trim() : parent;
      return isUnderPrimaryGroup(parentName || '', 'Sundry Debtors', groupHierarchy);
    });

    // If hierarchy is empty or nothing matched, fall back to all ledgers to avoid dropping customers
    if (customers.length === 0) {
      console.warn('Sundry Debtors filter returned 0 customers; falling back to all ledgers from Tally response');
      customers = Array.isArray(ledgerArray) ? ledgerArray : [];
    }

    console.log(`Found ${customers.length} customers in Sundry Debtors group (or fallback set)`);

    if (customers.length === 0) {
      const syncDuration = Date.now() - syncStartTime;
      await updateSyncHistory(
        companyGuid,
        'customers',
        0,
        syncDuration,
        syncMode,
        fromDate,
        toDate,
        null
      );
      await logSyncToHistory(
        companyGuid,
        'customers',
        new Date(syncStartTime),
        0,
        syncDuration,
        syncMode,
        fromDate,
        toDate,
        null
      );
      return res.json({
        success: true,
        message: 'No customers found in Sundry Debtors group',
        count: 0,
        syncMode,
        syncReason,
        fromDate,
        toDate,
        duration: `${Math.round(syncDuration / 1000)}s`
      });
    }

    const { id: businessId } = await getBusinessMetadata();

    let syncedCount = 0;
    let errors = [];

    for (const customer of customers) {
      try {
        const guid = customer.GUID?._ || customer.GUID;
        const name = extractLedgerName(customer);
        
        // Skip customers with empty names
        if (!name || name.trim() === '') {
          console.warn(`⚠️ Skipping customer with empty name (GUID: ${guid})`);
          continue;
        }
        
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

    const syncDuration = Date.now() - syncStartTime;

    await updateSyncHistory(
      companyGuid,
      'customers',
      syncedCount,
      syncDuration,
      syncMode,
      fromDate,
      toDate,
      errors.length > 0 ? `${errors.length} errors during sync` : null
    );

    await logSyncToHistory(
      companyGuid,
      'customers',
      new Date(syncStartTime),
      syncedCount,
      syncDuration,
      syncMode,
      fromDate,
      toDate,
      errors.length > 0 ? `${errors.length} errors` : null
    );

    res.json({
      success: true,
      message: `Successfully synced ${syncedCount} customers from Tally`,
      count: syncedCount,
      errors: errors.length > 0 ? errors : undefined,
      syncMode,
      syncReason,
      fromDate,
      toDate,
      duration: `${Math.round(syncDuration / 1000)}s`
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
    const syncDuration = Date.now() - syncStartTime;
    const config = loadConfig();
    if (config?.company?.guid) {
      await logSyncToHistory(
        config.company.guid,
        'customers',
        new Date(syncStartTime),
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


}

module.exports = registerCustomerRoutes;

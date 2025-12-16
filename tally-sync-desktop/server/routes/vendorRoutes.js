function registerVendorRoutes(app, deps) {
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
  const syncStartTime = Date.now();
  try {
    console.log('🔄 Starting vendor sync from Tally...');

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
    const syncDecision = await shouldRunFullSync(companyGuid, 'vendors');
    let syncMode = 'full';
    let syncReason = 'full';
    let alteredAfter = null;
    let fromDate = null;
    const toDate = new Date().toISOString().split('T')[0];

    if (forceFullSync) {
      syncReason = 'user_requested';
      console.log('Force full vendor sync requested');
    } else if (syncDecision.isFullSync) {
      syncReason = syncDecision.reason;
      console.log(`📦 Running FULL vendor sync (${syncReason})`);
    } else {
      syncMode = 'incremental';
      syncReason = 'incremental';
      const lastSyncDate = new Date(syncDecision.lastSyncTime);
      // Look back 1 day to avoid missing late edits
      lastSyncDate.setDate(lastSyncDate.getDate() - 1);
      fromDate = lastSyncDate.toISOString().split('T')[0];
      alteredAfter = formatTallyDate(lastSyncDate); // Tally expects YYYYMMDD
      console.log(`⚡ Running INCREMENTAL vendor sync since ${fromDate} (Tally date ${alteredAfter})`);
    }

    const buildVendorRequest = (alterDate) => `
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
      result = await queryTally(buildVendorRequest(alteredAfter), { queryType: 'vendor_sync' });
    } catch (err) {
      if (alteredAfter) {
        console.warn(`⚠️ Incremental vendor fetch failed (${err.message}), falling back to full sync...`);
        syncMode = 'full_fallback';
        syncReason = 'incremental_fallback';
        alteredAfter = null;
        fromDate = null;
        result = await queryTally(buildVendorRequest(null), { queryType: 'vendor_sync_full_fallback' });
      } else {
        throw err;
      }
    }

    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER) {
      const syncDuration = Date.now() - syncStartTime;
      await updateSyncHistory(companyGuid, 'vendors', 0, syncDuration, syncMode, fromDate, toDate, null);
      await logSyncToHistory(companyGuid, 'vendors', new Date(syncStartTime), 0, syncDuration, syncMode, fromDate, toDate, null);
      return res.json({
        success: true,
        message: 'No vendors found in Tally',
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
      console.warn('Incremental vendor sync returned 0 ledgers, retrying with full fetch...');
      syncMode = 'full_fallback';
      syncReason = 'incremental_empty';
      alteredAfter = null;
      fromDate = null;
      result = await queryTally(buildVendorRequest(null), { queryType: 'vendor_sync_full_on_empty' });
      ledgers = result.ENVELOPE.BODY.DATA.COLLECTION.LEDGER;
      ledgerArray = Array.isArray(ledgers) ? ledgers : (ledgers ? [ledgers] : []);
    }

    const groupHierarchy = await loadGroupHierarchy(companyGuid, config?.company?.name);

    // Filter to only get ledgers under Sundry Creditors (including nested groups)
    const vendors = ledgerArray.filter(ledger => {
      const parent = extractValue(ledger.PARENT) || ledger.PARENT;
      const parentName = typeof parent === 'string' ? parent.trim() : parent;
      return isUnderPrimaryGroup(parentName || '', 'Sundry Creditors', groupHierarchy);
    });

    console.log(`Found ${vendors.length} vendors in Sundry Creditors group`);

    if (vendors.length === 0) {
      const syncDuration = Date.now() - syncStartTime;
      await updateSyncHistory(
        companyGuid,
        'vendors',
        0,
        syncDuration,
        syncMode,
        fromDate,
        toDate,
        null
      );
      await logSyncToHistory(
        companyGuid,
        'vendors',
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
        message: 'No vendors found in Sundry Creditors group',
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

    for (const vendor of vendors) {
      try {
        const guid = vendor.GUID?._ || vendor.GUID;
        const name = extractLedgerName(vendor);
        
        // Skip vendors with empty names
        if (!name || name.trim() === '') {
          console.warn(`⚠️ Skipping vendor with empty name (GUID: ${guid})`);
          continue;
        }
        
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

    const syncDuration = Date.now() - syncStartTime;

    await updateSyncHistory(
      companyGuid,
      'vendors',
      syncedCount,
      syncDuration,
      syncMode,
      fromDate,
      toDate,
      errors.length > 0 ? `${errors.length} errors during sync` : null
    );

    await logSyncToHistory(
      companyGuid,
      'vendors',
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
      message: `Successfully synced ${syncedCount} vendors from Tally`,
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
        'vendors',
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

module.exports = registerVendorRoutes;

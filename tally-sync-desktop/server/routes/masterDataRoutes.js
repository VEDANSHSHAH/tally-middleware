function registerMasterDataRoutes(app, deps) {
  const {
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
  } = deps;


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
    const tallyCompanyInfo = await getCompanyInfo(config?.company?.name);
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
    const tallyCompanyInfo = await getCompanyInfo(config?.company?.name);
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
        // DEBUG: Uncomment to see raw Tally XML structure
        // console.log('Raw ledger data:', JSON.stringify(ledger).slice(0, 500));

        const guid = extractValue(ledger?.GUID) || ledger?.GUID || '';
        
        // Use robust name extraction function
        const name = extractLedgerName(ledger);
        
        // Skip ledgers with empty names
        if (!name) {
          console.warn(`⚠️ Skipping ledger with empty name (GUID: ${guid})`);
          console.log('   Raw NAME field:', JSON.stringify(ledger?.NAME));
          continue;
        }
        
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


}

module.exports = registerMasterDataRoutes;

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const xml2js = require('xml2js');
require('dotenv').config();

const { pool, initDB } = require('./db/postgres');

// ⭐ Import analytics functions
const { 
  calculateVendorSettlementCycles,
  calculateOutstandingAging,
  calculateVendorScores
} = require('./analytics/paymentCycles');

const app = express();
app.use(cors());
app.use(express.json());

const TALLY_URL = process.env.TALLY_URL || 'http://localhost:9000';
const PORT = process.env.PORT || 3000;
const DEFAULT_BUSINESS_ID = process.env.BUSINESS_ID || 'default-business';
const DEFAULT_BUSINESS_NAME = process.env.BUSINESS_NAME || 'Primary Business';
const BUSINESS_CACHE_MS = 5 * 60 * 1000;
let cachedBusinessMeta = null;
let cachedBusinessExpiry = 0;

const extractValue = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && '_' in value) return value._;
  return value;
};

// Initialize database on startup
initDB().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Helper function to query Tally
async function queryTally(xmlRequest) {
  try {
    const response = await axios.post(TALLY_URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 10000
    });

    const parser = new xml2js.Parser({ explicitArray: false });
    return await parser.parseStringPromise(response.data);
  } catch (error) {
    console.error('Tally query error:', error.message);
    throw error;
  }
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
    const result = await queryTally(xmlRequest);
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
  res.json({ 
    message: 'Tally Middleware is running', 
    timestamp: new Date(),
    database: 'PostgreSQL (Neon)',
    tallyUrl: TALLY_URL
  });
});

// ==================== VENDORS ====================

// Get all vendors from PostgreSQL
app.get('/api/vendors', async (req, res) => {
  try {
    const { businessId } = req.query;
    let query = 'SELECT * FROM vendors';
    const params = [];

    if (businessId) {
      query += ' WHERE business_id = $1';
      params.push(businessId);
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
    const result = await pool.query(
      'SELECT * FROM vendors WHERE id = $1',
      [req.params.id]
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

    const result = await queryTally(xmlRequest);
    
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

        await pool.query(
          `INSERT INTO vendors (guid, name, business_id, opening_balance, current_balance, synced_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (guid)
           DO UPDATE SET
             name = EXCLUDED.name,
             business_id = EXCLUDED.business_id,
             opening_balance = EXCLUDED.opening_balance,
             current_balance = EXCLUDED.current_balance,
             synced_at = NOW(),
             updated_at = NOW()`,
          [guid, name, businessId, openingBalance, currentBalance]
        );
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
    const { businessId } = req.query;
    let query = 'SELECT * FROM customers';
    const params = [];

    if (businessId) {
      query += ' WHERE business_id = $1';
      params.push(businessId);
    }

    query += ' ORDER BY name';

    const result = await pool.query(query, params);
    res.json({ 
      success: true, 
      count: result.rows.length,
      customers: result.rows 
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single customer by ID
app.get('/api/customers/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
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

    const result = await queryTally(xmlRequest);
    
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

    let syncedCount = 0;
    let errors = [];

    for (const customer of customers) {
      try {
        const guid = customer.GUID?._ || customer.GUID;
        const name = customer.$?.NAME || customer.NAME;
        const openingBalance = parseFloat(customer.OPENINGBALANCE?._ || customer.OPENINGBALANCE || 0);
        const currentBalance = parseFloat(customer.CLOSINGBALANCE?._ || customer.CLOSINGBALANCE || 0);

        await pool.query(
          `INSERT INTO customers (guid, name, business_id, opening_balance, current_balance, synced_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (guid)
           DO UPDATE SET
             name = EXCLUDED.name,
             business_id = EXCLUDED.business_id,
             opening_balance = EXCLUDED.opening_balance,
             current_balance = EXCLUDED.current_balance,
             synced_at = NOW(),
             updated_at = NOW()`,
          [guid, name, businessId, openingBalance, currentBalance]
        );
        syncedCount++;
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

// Get all transactions from PostgreSQL
app.get('/api/transactions', async (req, res) => {
  try {
    const { limit = 100, offset = 0, type, startDate, endDate, businessId } = req.query;
    
    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];
    let paramCount = 1;

    if (businessId) {
      query += ` AND business_id = $${paramCount}`;
      params.push(businessId);
      paramCount++;
    }

    if (type) {
      query += ` AND voucher_type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    if (startDate) {
      query += ` AND date >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND date <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` ORDER BY date DESC, id DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      transactions: result.rows 
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single transaction by ID
app.get('/api/transactions/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    
    res.json({ success: true, transaction: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync transactions from Tally to PostgreSQL
app.post('/api/sync/transactions', async (req, res) => {
  try {
    console.log('🔄 Starting transaction sync from Tally...');
    
    // Get date range from request or default to last 30 days
    const { startDate, endDate } = req.body;
    const fromDate = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = endDate || new Date().toISOString().split('T')[0];
    
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

    const result = await queryTally(xmlRequest);
    
    if (!result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER) {
      return res.json({
        success: true,
        message: 'No transactions found in Tally for the specified period',
        count: 0
      });
    }

    const vouchers = result.ENVELOPE.BODY.DATA.COLLECTION.VOUCHER;
    const voucherArray = Array.isArray(vouchers) ? vouchers : [vouchers];

    console.log(`Found ${voucherArray.length} transactions`);

    const { id: businessId } = await getBusinessMetadata();
    let syncedCount = 0;
    let errors = [];

    for (const voucher of voucherArray) {
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

        await pool.query(
          `INSERT INTO transactions (
            guid, voucher_number, voucher_type, business_id, item_name, item_code, date, party_name, amount, narration, synced_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          ON CONFLICT (guid)
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
            updated_at = NOW()`,
          [guid, voucherNumber, voucherType, businessId, itemName, itemCode, formattedDate, partyName, amount, narration]
        );
        syncedCount++;
      } catch (err) {
        console.error(`Error syncing transaction:`, err);
        errors.push({ 
          voucher: voucher.VOUCHERNUMBER?._ || voucher.VOUCHERNUMBER || 'unknown', 
          error: err.message 
        });
      }
    }

    console.log(`✅ Synced ${syncedCount} transactions`);

    res.json({
      success: true,
      message: `Successfully synced ${syncedCount} transactions from Tally`,
      count: syncedCount,
      period: { from: fromDate, to: toDate },
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Transaction sync error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Make sure Tally is running and port 9000 is accessible'
    });
  }
});

// ==================== STATS ====================

// Database stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const { businessId } = req.query;
    const vendorStats = await pool.query(`
      SELECT 
        COUNT(*) as total_vendors,
        SUM(current_balance) as total_payables,
        MAX(synced_at) as last_vendor_sync
      FROM vendors
      ${businessId ? 'WHERE business_id = $1' : ''}
    `, businessId ? [businessId] : []);
    
    const customerStats = await pool.query(`
      SELECT 
        COUNT(*) as total_customers,
        SUM(current_balance) as total_receivables,
        MAX(synced_at) as last_customer_sync
      FROM customers
      ${businessId ? 'WHERE business_id = $1' : ''}
    `, businessId ? [businessId] : []);
    
    const transactionStats = await pool.query(`
      SELECT 
        COUNT(*) as total_transactions,
        SUM(CASE WHEN voucher_type LIKE '%Payment%' THEN amount ELSE 0 END) as total_payments,
        SUM(CASE WHEN voucher_type LIKE '%Receipt%' THEN amount ELSE 0 END) as total_receipts,
        MAX(synced_at) as last_transaction_sync
      FROM transactions
      ${businessId ? 'WHERE business_id = $1' : ''}
    `, businessId ? [businessId] : []);

    const timestamps = [
      vendorStats.rows[0]?.last_vendor_sync,
      customerStats.rows[0]?.last_customer_sync,
      transactionStats.rows[0]?.last_transaction_sync
    ].filter(Boolean).map(date => new Date(date).getTime());
    const lastSyncValue = timestamps.length ? new Date(Math.max(...timestamps)) : null;
    const businessMeta = await getBusinessMetadata();
    
    res.json({ 
      success: true, 
      stats: {
        vendors: vendorStats.rows[0],
        customers: customerStats.rows[0],
        transactions: transactionStats.rows[0],
        last_sync: lastSyncValue,
        business: {
          id: businessId || businessMeta.id,
          name: businessMeta.name
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ANALYTICS ENDPOINTS ⭐ NEW ====================

// Get payment cycles
app.get('/api/analytics/payment-cycles', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        pc.*,
        v.name as vendor_name
      FROM payment_cycles pc
      LEFT JOIN vendors v ON v.id = pc.vendor_id
      ORDER BY pc.calculated_at DESC
    `);
    
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get outstanding aging
app.get('/api/analytics/aging', async (req, res) => {
  try {
    // Always refresh the aging table before serving results
    await calculateOutstandingAging();

    const result = await pool.query(`
      SELECT 
        oa.entity_type,
        oa.vendor_id,
        oa.customer_id,
        COALESCE(v.name, c.name) as entity_name,
        SUM(oa.current_0_30_days) as current_0_30_days,
        SUM(oa.current_31_60_days) as current_31_60_days,
        SUM(oa.current_61_90_days) as current_61_90_days,
        SUM(oa.current_over_90_days) as current_over_90_days,
        SUM(oa.total_outstanding) as total_outstanding,
        MAX(oa.calculated_at) as calculated_at,
        MAX(oa.created_at) as created_at
      FROM outstanding_aging oa
      LEFT JOIN vendors v ON v.id = oa.vendor_id
      LEFT JOIN customers c ON c.id = oa.customer_id
      GROUP BY 
        oa.entity_type,
        oa.vendor_id,
        oa.customer_id,
        COALESCE(v.name, c.name)
      ORDER BY total_outstanding DESC
    `);

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
    `;

    if (existingCustomerIds.size) {
      const placeholders = Array.from(existingCustomerIds).map((_, idx) => `$${idx + 1}`).join(', ');
      customerQuery += ` WHERE id NOT IN (${placeholders})`;
    }

    const missingCustomers = await pool.query(
      customerQuery,
      existingCustomerIds.size ? Array.from(existingCustomerIds) : []
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
    
    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get vendor scores
app.get('/api/analytics/vendor-scores', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        vs.*,
        v.name as vendor_name,
        v.current_balance
      FROM vendor_scores vs
      JOIN vendors v ON v.id = vs.vendor_id
      ORDER BY vs.overall_score DESC
    `);
    
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger analytics calculation
app.post('/api/analytics/calculate', async (req, res) => {
  try {
    console.log('🔄 Running analytics calculations...');
    
    await calculateVendorSettlementCycles();
    await calculateOutstandingAging();
    await calculateVendorScores();
    
    res.json({ 
      success: true, 
      message: 'Analytics calculated successfully' 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== AUTO-SYNC SCHEDULER ====================

const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

async function autoSync() {
  console.log('\n🔄 ===== AUTO-SYNC STARTED =====');
  console.log(`⏰ Time: ${new Date().toLocaleString()}`);
  
  try {
    // Sync vendors
    console.log('📦 Syncing vendors...');
    const vendorResponse = await axios.post(`http://localhost:${PORT}/api/sync/vendors`);
    console.log(`✅ Vendors: ${vendorResponse.data.count} synced`);
    
    // Sync customers
    console.log('👥 Syncing customers...');
    const customerResponse = await axios.post(`http://localhost:${PORT}/api/sync/customers`);
    console.log(`✅ Customers: ${customerResponse.data.count} synced`);
    
    // Sync transactions (last 30 days)
    console.log('💰 Syncing transactions...');
    const transactionResponse = await axios.post(`http://localhost:${PORT}/api/sync/transactions`, {});
    console.log(`✅ Transactions: ${transactionResponse.data.count} synced`);
    
    // ⭐ NEW - Calculate analytics
    console.log('📊 Calculating analytics...');
    const analyticsResponse = await axios.post(`http://localhost:${PORT}/api/analytics/calculate`);
    console.log(`✅ Analytics: ${analyticsResponse.data.message}`);
    
    console.log('🎉 ===== AUTO-SYNC COMPLETED =====\n');
  } catch (error) {
    console.error('❌ Auto-sync failed:', error.message);
  }
}

// Start server with auto-sync
let syncInterval;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Tally Middleware Server Started`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`📊 Tally: ${TALLY_URL}`);
  console.log(`💾 Database: PostgreSQL (Neon)`);
  console.log(`\nAvailable endpoints:`);
  console.log(`   GET  /api/test`);
  console.log(`   GET  /api/vendors`);
  console.log(`   GET  /api/vendors/:id`);
  console.log(`   POST /api/sync/vendors`);
  console.log(`   GET  /api/customers`);
  console.log(`   GET  /api/customers/:id`);
  console.log(`   POST /api/sync/customers`);
  console.log(`   GET  /api/transactions`);
  console.log(`   GET  /api/transactions/:id`);
  console.log(`   POST /api/sync/transactions`);
  console.log(`   GET  /api/stats`);
  console.log(`   GET  /api/analytics/vendor-scores ⭐`);
  console.log(`   GET  /api/analytics/aging ⭐`);
  console.log(`   GET  /api/analytics/payment-cycles ⭐`);
  console.log(`   POST /api/analytics/calculate ⭐`);
  console.log(`\n⏰ Auto-sync: Every 5 minutes`);
  console.log(`🔄 First sync in 10 seconds...\n`);
  
  // Run first sync after 10 seconds
  setTimeout(() => {
    autoSync();
    // Then run every 5 minutes
    syncInterval = setInterval(autoSync, SYNC_INTERVAL);
  }, 10000);
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

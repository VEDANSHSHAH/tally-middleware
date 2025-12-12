/**
 * VOUCHER SYNC MODULE
 * ====================
 * Syncs Tally vouchers to the normalized vouchers + voucher_line_items tables
 * instead of the flat transactions table.
 * 
 * This captures ALL data from Tally including:
 * - Complete voucher header (64 columns)
 * - All line items with quantities, rates, taxes
 * - Bill-wise allocations (payment references)
 * - GST details, addresses, dispatch info
 */

// Database connection - using same pool as main server
const { pool } = require('../db/postgres');

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Extract value from Tally XML node (handles both direct values and {_: value} format)
 */
function extractValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && '_' in value) return value._;
  if (typeof value === 'object' && '$' in value) return value.$;
  return value;
}

/**
 * Parse Tally amount (removes negatives, handles text)
 */
function parseAmount(value) {
  const extracted = extractValue(value);
  if (extracted === null || extracted === undefined || extracted === '') return 0;
  const num = parseFloat(String(extracted).replace(/[^0-9.-]/g, ''));
  return isNaN(num) ? 0 : num;
}

/**
 * Parse Tally date (YYYYMMDD) to PostgreSQL date (YYYY-MM-DD)
 */
function parseTallyDate(tallyDate) {
  const dateStr = extractValue(tallyDate);
  if (!dateStr) return null;
  
  // Already in correct format
  if (dateStr.includes('-') && dateStr.length === 10) {
    return dateStr;
  }
  
  // YYYYMMDD format
  if (dateStr.length === 8) {
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  }
  
  return null;
}

/**
 * Generate a unique line GUID for voucher line items
 */
function generateLineGuid(voucherGuid, lineNumber) {
  return `${voucherGuid}-LINE-${lineNumber}`;
}

/**
 * Look up ledger ID by name (with caching for performance)
 */
const ledgerCache = new Map();

async function getLedgerId(ledgerName, companyGuid) {
  if (!ledgerName) return null;
  
  const cacheKey = `${companyGuid}:${ledgerName}`;
  if (ledgerCache.has(cacheKey)) {
    return ledgerCache.get(cacheKey);
  }
  
  try {
    // First try exact name match
    let result = await pool.query(
      'SELECT id FROM ledgers WHERE name = $1 AND company_guid = $2 LIMIT 1',
      [ledgerName, companyGuid]
    );
    
    // If not found, try case-insensitive match
    if (result.rows.length === 0) {
      result = await pool.query(
        'SELECT id FROM ledgers WHERE LOWER(name) = LOWER($1) AND company_guid = $2 LIMIT 1',
        [ledgerName, companyGuid]
      );
    }
    
    // If still not found, log for visibility
    if (result.rows.length === 0) {
      console.warn(`Ledger not found for party: "${ledgerName}" - party_ledger_id will be NULL`);
    }

    const ledgerId = result.rows.length > 0 ? result.rows[0].id : null;
    ledgerCache.set(cacheKey, ledgerId);
    return ledgerId;
  } catch (error) {
    console.error(`Error looking up ledger "${ledgerName}":`, error.message);
    return null;
  }
}

/**
 * Look up item ID by name (with caching for performance)
 */
const itemCache = new Map();

async function getItemId(itemName, companyGuid) {
  if (!itemName) return null;
  
  const cacheKey = `${companyGuid}:${itemName}`;
  if (itemCache.has(cacheKey)) {
    return itemCache.get(cacheKey);
  }
  
  try {
    const result = await pool.query(
      'SELECT id FROM items WHERE name = $1 AND company_guid = $2 LIMIT 1',
      [itemName, companyGuid]
    );
    
    const itemId = result.rows.length > 0 ? result.rows[0].id : null;
    itemCache.set(cacheKey, itemId);
    return itemId;
  } catch (error) {
    console.error(`Error looking up item "${itemName}":`, error.message);
    return null;
  }
}

/**
 * Clear lookup caches (call after sync to free memory)
 */
function clearCaches() {
  ledgerCache.clear();
  itemCache.clear();
}

// =====================================================
// TDL XML REQUEST BUILDER
// =====================================================

/**
 * Build TDL XML request to fetch complete voucher data from Tally
 * This fetches ALL fields needed for vouchers and voucher_line_items tables
 */
function buildVoucherFetchXML(fromDate, toDate, alteredAfter = null) {
  // Comprehensive field list - fetches everything we need
  const fetchFields = [
    // Basic identification
    'GUID',
    'MASTERID',
    'ALTERID',
    'VOUCHERNUMBER',
    'VOUCHERTYPENAME',
    'DATE',
    'ALTEREDON',
    
    // References
    'REFERENCE',
    'REFERENCEDATE',
    'NARRATION',
    
    // Party info
    'PARTYLEDGERNAME',
    'PARTYGSTIN',
    'PLACEOFSUPPLY',
    'PARTYNAME',
    
    // Amounts
    'AMOUNT',
    'ROUNDOFF', // This is in LEDGERENTRIES, but try to get from root
    
    // E-invoice
    'IRN',
    'IRNACKNO',
    'IRNACKDATE',
    
    // Dispatch details
    'BASICBUYERORDERDATE',
    'BASICBUYERORDERNO',
    'BASICDISPATCHDOCNO',
    'BASICDISPATCHEDTHROUGH',
    'BASICDESTINATION',
    'BASICFINALDESTINATION',
    'BASICSHIPVESSELNO',
    'BASICSHIPPINGDATE',
    'BILLOFLADINGNO',
    'BILLOFLADINGDATE',
    
    // Mode
    'VCHGSTCLASS',
    'PERSISTEDVIEW',
    'VOUCHERTYPEORIGNAME',
    
    // Cancellation
    'ISCANCELLED',
    'ISOPTIONAL',
    
    // ALL LEDGER ENTRIES (accounting lines - debits/credits)
    'ALLLEDGERENTRIES.LIST',
    
    // ALL INVENTORY ENTRIES (item lines with quantities)
    'ALLINVENTORYENTRIES.LIST',
    
    // BILL ALLOCATIONS (which invoices are being paid)
    'BILLALLOCATIONS.LIST'
  ];

  const xml = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>VoucherCollection</ID>
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
              <COLLECTION NAME="VoucherCollection">
                <TYPE>Voucher</TYPE>
                <FETCH>${fetchFields.join(', ')}</FETCH>
                ${alteredAfter ? '<FILTER>ModifiedSince</FILTER>' : ''}
              </COLLECTION>
              ${alteredAfter ? `
              <SYSTEM TYPE="Formulae" NAME="ModifiedSince">
                $AlteredOn >= $$Date:##SVAlteredAfter
              </SYSTEM>
              <VARIABLE NAME="SVAlteredAfter" TYPE="Date">${alteredAfter}</VARIABLE>
              ` : ''}
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  return xml;
}

// =====================================================
// VOUCHER PARSER
// =====================================================

/**
 * Parse a single voucher from Tally XML into our database format
 */
async function parseVoucher(voucher, companyGuid) {
  const voucherGuid = extractValue(voucher.GUID);
  const partyName = extractValue(voucher.PARTYLEDGERNAME) || extractValue(voucher.PARTYNAME);
  
  // Look up party ledger ID
  const partyLedgerId = await getLedgerId(partyName, companyGuid);
  
  // Parse voucher header
  const voucherData = {
    voucher_guid: voucherGuid,
    company_guid: companyGuid,
    voucher_number: extractValue(voucher.VOUCHERNUMBER) || 'N/A',
    voucher_type: extractValue(voucher.VOUCHERTYPENAME),
    voucher_name: extractValue(voucher.VOUCHERTYPEORIGNAME),
    date: parseTallyDate(voucher.DATE),
    
    // References
    reference_number: extractValue(voucher.REFERENCE),
    reference_date: parseTallyDate(voucher.REFERENCEDATE),
    
    // Party
    party_ledger_id: partyLedgerId,
    party_name: partyName,
    
    // Amounts - will be calculated from line items
    total_amount: Math.abs(parseAmount(voucher.AMOUNT)),
    gross_amount: 0, // Will calculate from inventory entries
    discount_amount: 0,
    tax_amount: 0,
    round_off: parseAmount(voucher.ROUNDOFF) || 0,
    
    // Narration
    narration: extractValue(voucher.NARRATION),
    
    // Order details
    order_number: extractValue(voucher.BASICBUYERORDERNO),
    order_date: parseTallyDate(voucher.BASICBUYERORDERDATE),
    
    // Dispatch details
    dispatch_doc_no: extractValue(voucher.BASICDISPATCHDOCNO),
    dispatched_through: extractValue(voucher.BASICDISPATCHEDTHROUGH),
    destination: extractValue(voucher.BASICDESTINATION) || extractValue(voucher.BASICFINALDESTINATION),
    vessel_flight_no: extractValue(voucher.BASICSHIPVESSELNO),
    bill_of_lading: extractValue(voucher.BILLOFLADINGNO),
    
    // E-invoice
    einvoice_irn: extractValue(voucher.IRN),
    einvoice_ack_no: extractValue(voucher.IRNACKNO),
    einvoice_ack_date: extractValue(voucher.IRNACKDATE) ? new Date(extractValue(voucher.IRNACKDATE)) : null,
    einvoice_generated: !!extractValue(voucher.IRN),
    
    // Status
    is_cancelled: extractValue(voucher.ISCANCELLED) === 'Yes',
    
    // Timestamps
    synced_at: new Date()
  };
  
  // Parse line items (both ledger entries and inventory entries)
  const lineItems = await parseVoucherLineItems(voucher, voucherGuid, companyGuid);
  
  // Calculate totals from line items
  let grossAmount = 0;
  let taxAmount = 0;
  
  lineItems.forEach(line => {
    if (line.item_id || line.item_name) {
      // Inventory line - add to gross
      grossAmount += Math.abs(line.amount || 0);
    }
    // Sum up taxes
    taxAmount += (line.cgst_amount || 0) + (line.sgst_amount || 0) + (line.igst_amount || 0) + (line.cess_amount || 0);
  });
  
  voucherData.gross_amount = grossAmount;
  voucherData.tax_amount = taxAmount;
  
  return {
    voucher: voucherData,
    lineItems: lineItems
  };
}

/**
 * Parse all line items from a voucher
 */
async function parseVoucherLineItems(voucher, voucherGuid, companyGuid) {
  const lineItems = [];
  let lineNumber = 0;
  
  // 1. Parse LEDGER ENTRIES (accounting entries - debits/credits)
  const ledgerEntries = voucher['ALLLEDGERENTRIES.LIST'] || voucher.ALLLEDGERENTRIES;
  if (ledgerEntries) {
    const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [ledgerEntries];
    
    for (const entry of entries) {
      if (!entry) continue;
      lineNumber++;
      
      const ledgerName = extractValue(entry.LEDGERNAME);
      const ledgerId = await getLedgerId(ledgerName, companyGuid);
      const amount = parseAmount(entry.AMOUNT);
      
      // Parse bill allocations within this ledger entry
      const billAllocations = entry['BILLALLOCATIONS.LIST'] || entry.BILLALLOCATIONS;
      let refType = null, refName = null, refAmount = null, refDate = null;
      
      if (billAllocations) {
        const allocations = Array.isArray(billAllocations) ? billAllocations : [billAllocations];
        if (allocations.length > 0 && allocations[0]) {
          refType = extractValue(allocations[0].BILLTYPE);
          refName = extractValue(allocations[0].NAME);
          refAmount = parseAmount(allocations[0].AMOUNT);
          refDate = parseTallyDate(allocations[0].BILLDATE);
        }
      }
      
      lineItems.push({
        line_guid: generateLineGuid(voucherGuid, lineNumber),
        company_guid: companyGuid,
        line_number: lineNumber,
        
        // Ledger info
        ledger_id: ledgerId,
        ledger_name: ledgerName,
        
        // Debit/Credit (Tally uses negative for debit, positive for credit)
        debit_amount: amount < 0 ? Math.abs(amount) : 0,
        credit_amount: amount >= 0 ? amount : 0,
        
        // No item for pure ledger entries
        item_id: null,
        item_name: null,
        
        // Bill references
        reference_type: refType,
        reference_name: refName,
        reference_amount: refAmount,
        reference_date: refDate
      });
    }
  }
  
  // 2. Parse INVENTORY ENTRIES (item lines with quantities, rates, taxes)
  const inventoryEntries = voucher['ALLINVENTORYENTRIES.LIST'] || voucher.ALLINVENTORYENTRIES;
  if (inventoryEntries) {
    const entries = Array.isArray(inventoryEntries) ? inventoryEntries : [inventoryEntries];
    
    for (const entry of entries) {
      if (!entry) continue;
      lineNumber++;
      
      const itemName = extractValue(entry.STOCKITEMNAME);
      const itemId = await getItemId(itemName, companyGuid);
      
      // Get the accounting ledger for this item line
      const accountingAllocations = entry['ACCOUNTINGALLOCATIONS.LIST'] || entry.ACCOUNTINGALLOCATIONS;
      let ledgerId = null, ledgerName = null;
      
      if (accountingAllocations) {
        const allocations = Array.isArray(accountingAllocations) ? accountingAllocations : [accountingAllocations];
        if (allocations.length > 0 && allocations[0]) {
          ledgerName = extractValue(allocations[0].LEDGERNAME);
          ledgerId = await getLedgerId(ledgerName, companyGuid);
        }
      }
      
      const amount = parseAmount(entry.AMOUNT);
      const rate = parseAmount(entry.RATE);
      const actualQty = parseAmount(entry.ACTUALQTY) || parseAmount(entry.BILLEDQTY);
      const billedQty = parseAmount(entry.BILLEDQTY);
      
      // Parse GST details from BATCHALLOCATIONS or direct fields
      let cgstRate = 0, cgstAmount = 0;
      let sgstRate = 0, sgstAmount = 0;
      let igstRate = 0, igstAmount = 0;
      let cessRate = 0, cessAmount = 0;
      let discountAmount = 0;
      
      // Try to get GST from GSTOVRDNDETAILS or similar
      const gstDetails = entry.GSTOVRDNDETAILS || entry['GSTOVRDNDETAILS.LIST'];
      if (gstDetails) {
        const details = Array.isArray(gstDetails) ? gstDetails : [gstDetails];
        details.forEach(detail => {
          const taxType = extractValue(detail.TAXTYPE) || '';
          const taxAmount = parseAmount(detail.AMOUNT);
          const taxRate = parseAmount(detail.TAXRATE);
          
          if (taxType.includes('CGST')) {
            cgstRate = taxRate;
            cgstAmount = Math.abs(taxAmount);
          } else if (taxType.includes('SGST') || taxType.includes('UTGST')) {
            sgstRate = taxRate;
            sgstAmount = Math.abs(taxAmount);
          } else if (taxType.includes('IGST')) {
            igstRate = taxRate;
            igstAmount = Math.abs(taxAmount);
          } else if (taxType.includes('CESS')) {
            cessRate = taxRate;
            cessAmount = Math.abs(taxAmount);
          }
        });
      }
      
      // Calculate discount
      const discountPercent = parseAmount(entry.DISCOUNT);
      if (discountPercent > 0 && amount > 0) {
        discountAmount = (Math.abs(amount) * discountPercent) / 100;
      }
      
      lineItems.push({
        line_guid: generateLineGuid(voucherGuid, lineNumber),
        company_guid: companyGuid,
        line_number: lineNumber,
        
        // Ledger
        ledger_id: ledgerId,
        ledger_name: ledgerName,
        
        // For inventory entries, amount goes to debit (expense) or credit (income)
        debit_amount: amount < 0 ? Math.abs(amount) : 0,
        credit_amount: amount >= 0 ? amount : 0,
        
        // Item details
        item_id: itemId,
        item_name: itemName,
        
        // Quantities
        actual_quantity: actualQty,
        billed_quantity: billedQty,
        rate: rate,
        rate_per: extractValue(entry.RATEPERUNIT),
        amount: Math.abs(amount),
        
        // Discount
        discount_percent: discountPercent,
        discount_amount: discountAmount,
        
        // Taxes
        taxable_amount: Math.abs(amount) - discountAmount,
        cgst_rate: cgstRate,
        cgst_amount: cgstAmount,
        sgst_rate: sgstRate,
        sgst_amount: sgstAmount,
        igst_rate: igstRate,
        igst_amount: igstAmount,
        cess_rate: cessRate,
        cess_amount: cessAmount,
        
        // Tracking
        batch_number: extractValue(entry.BATCHNAME),
        tracking_number: extractValue(entry.TRACKINGNUMBER),
        
        // Notes
        notes: extractValue(entry.NARRATION)
      });
    }
  }
  
  return lineItems;
}

// =====================================================
// DATABASE OPERATIONS
// =====================================================

/**
 * Upsert a voucher into the database
 */
async function upsertVoucher(voucherData) {
  const query = `
    INSERT INTO vouchers (
      voucher_guid, company_guid, voucher_number, voucher_type, voucher_name,
      date, reference_number, reference_date, party_ledger_id, party_name,
      total_amount, gross_amount, discount_amount, tax_amount, round_off,
      narration, order_number, order_date, dispatch_doc_no, dispatched_through,
      destination, vessel_flight_no, bill_of_lading, einvoice_irn, einvoice_ack_no,
      einvoice_ack_date, einvoice_generated, is_cancelled, synced_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, NOW()
    )
    ON CONFLICT (voucher_guid, company_guid)
    DO UPDATE SET
      voucher_number = EXCLUDED.voucher_number,
      voucher_type = EXCLUDED.voucher_type,
      voucher_name = EXCLUDED.voucher_name,
      date = EXCLUDED.date,
      reference_number = EXCLUDED.reference_number,
      reference_date = EXCLUDED.reference_date,
      party_ledger_id = EXCLUDED.party_ledger_id,
      party_name = EXCLUDED.party_name,
      total_amount = EXCLUDED.total_amount,
      gross_amount = EXCLUDED.gross_amount,
      discount_amount = EXCLUDED.discount_amount,
      tax_amount = EXCLUDED.tax_amount,
      round_off = EXCLUDED.round_off,
      narration = EXCLUDED.narration,
      order_number = EXCLUDED.order_number,
      order_date = EXCLUDED.order_date,
      dispatch_doc_no = EXCLUDED.dispatch_doc_no,
      dispatched_through = EXCLUDED.dispatched_through,
      destination = EXCLUDED.destination,
      vessel_flight_no = EXCLUDED.vessel_flight_no,
      bill_of_lading = EXCLUDED.bill_of_lading,
      einvoice_irn = EXCLUDED.einvoice_irn,
      einvoice_ack_no = EXCLUDED.einvoice_ack_no,
      einvoice_ack_date = EXCLUDED.einvoice_ack_date,
      einvoice_generated = EXCLUDED.einvoice_generated,
      is_cancelled = EXCLUDED.is_cancelled,
      synced_at = NOW(),
      updated_at = NOW()
    RETURNING id
  `;
  
  const values = [
    voucherData.voucher_guid,
    voucherData.company_guid,
    voucherData.voucher_number,
    voucherData.voucher_type,
    voucherData.voucher_name,
    voucherData.date,
    voucherData.reference_number,
    voucherData.reference_date,
    voucherData.party_ledger_id,
    voucherData.party_name,
    voucherData.total_amount,
    voucherData.gross_amount,
    voucherData.discount_amount,
    voucherData.tax_amount,
    voucherData.round_off,
    voucherData.narration,
    voucherData.order_number,
    voucherData.order_date,
    voucherData.dispatch_doc_no,
    voucherData.dispatched_through,
    voucherData.destination,
    voucherData.vessel_flight_no,
    voucherData.bill_of_lading,
    voucherData.einvoice_irn,
    voucherData.einvoice_ack_no,
    voucherData.einvoice_ack_date,
    voucherData.einvoice_generated,
    voucherData.is_cancelled
  ];
  
  const result = await pool.query(query, values);
  return result.rows[0].id;
}

/**
 * Upsert voucher line items into the database
 */
async function upsertLineItems(voucherId, lineItems) {
  if (!lineItems || lineItems.length === 0) return 0;
  
  let insertedCount = 0;
  
  for (const line of lineItems) {
    const query = `
      INSERT INTO voucher_line_items (
        line_guid, voucher_id, company_guid, line_number,
        ledger_id, ledger_name, debit_amount, credit_amount,
        item_id, item_name, actual_quantity, billed_quantity,
        rate, rate_per, amount, discount_percent, discount_amount,
        taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, cess_rate, cess_amount,
        reference_type, reference_name, reference_amount, reference_date,
        batch_number, tracking_number, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33
      )
      ON CONFLICT (line_guid)
      DO UPDATE SET
        voucher_id = EXCLUDED.voucher_id,
        line_number = EXCLUDED.line_number,
        ledger_id = EXCLUDED.ledger_id,
        ledger_name = EXCLUDED.ledger_name,
        debit_amount = EXCLUDED.debit_amount,
        credit_amount = EXCLUDED.credit_amount,
        item_id = EXCLUDED.item_id,
        item_name = EXCLUDED.item_name,
        actual_quantity = EXCLUDED.actual_quantity,
        billed_quantity = EXCLUDED.billed_quantity,
        rate = EXCLUDED.rate,
        rate_per = EXCLUDED.rate_per,
        amount = EXCLUDED.amount,
        discount_percent = EXCLUDED.discount_percent,
        discount_amount = EXCLUDED.discount_amount,
        taxable_amount = EXCLUDED.taxable_amount,
        cgst_rate = EXCLUDED.cgst_rate,
        cgst_amount = EXCLUDED.cgst_amount,
        sgst_rate = EXCLUDED.sgst_rate,
        sgst_amount = EXCLUDED.sgst_amount,
        igst_rate = EXCLUDED.igst_rate,
        igst_amount = EXCLUDED.igst_amount,
        cess_rate = EXCLUDED.cess_rate,
        cess_amount = EXCLUDED.cess_amount,
        reference_type = EXCLUDED.reference_type,
        reference_name = EXCLUDED.reference_name,
        reference_amount = EXCLUDED.reference_amount,
        reference_date = EXCLUDED.reference_date,
        batch_number = EXCLUDED.batch_number,
        tracking_number = EXCLUDED.tracking_number,
        notes = EXCLUDED.notes,
        updated_at = NOW()
    `;
    
    const values = [
      line.line_guid,
      voucherId,
      line.company_guid,
      line.line_number,
      line.ledger_id,
      line.ledger_name,
      line.debit_amount || 0,
      line.credit_amount || 0,
      line.item_id,
      line.item_name,
      line.actual_quantity,
      line.billed_quantity,
      line.rate,
      line.rate_per,
      line.amount,
      line.discount_percent,
      line.discount_amount || 0,
      line.taxable_amount,
      line.cgst_rate,
      line.cgst_amount || 0,
      line.sgst_rate,
      line.sgst_amount || 0,
      line.igst_rate,
      line.igst_amount || 0,
      line.cess_rate,
      line.cess_amount || 0,
      line.reference_type,
      line.reference_name,
      line.reference_amount,
      line.reference_date,
      line.batch_number,
      line.tracking_number,
      line.notes
    ];
    
    try {
      await pool.query(query, values);
      insertedCount++;
    } catch (error) {
      console.error(`Error inserting line item ${line.line_guid}:`, error.message);
    }
  }
  
  return insertedCount;
}

// =====================================================
// MAIN SYNC FUNCTION
// =====================================================

/**
 * Sync vouchers from Tally to PostgreSQL
 * 
 * @param {Object} options - Sync options
 * @param {string} options.companyGuid - Company GUID
 * @param {Array} options.tallyVouchers - Raw voucher data from Tally XML
 * @param {Function} options.onProgress - Progress callback (current, total)
 * @returns {Object} - Sync results
 */
async function syncVouchers({ companyGuid, tallyVouchers, onProgress }) {
  const results = {
    totalProcessed: 0,
    vouchersInserted: 0,
    vouchersUpdated: 0,
    lineItemsInserted: 0,
    errors: [],
    startTime: Date.now()
  };
  
  if (!tallyVouchers || tallyVouchers.length === 0) {
    return results;
  }
  
  const voucherArray = Array.isArray(tallyVouchers) ? tallyVouchers : [tallyVouchers];
  const total = voucherArray.length;
  
  console.log(`📊 Processing ${total} vouchers...`);
  
  // Process in batches
  const BATCH_SIZE = 50;
  
  for (let i = 0; i < voucherArray.length; i += BATCH_SIZE) {
    const batch = voucherArray.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(voucherArray.length / BATCH_SIZE);
    
    console.log(`📦 Processing batch ${batchNum}/${totalBatches}...`);
    
    for (const tallyVoucher of batch) {
      try {
        // Parse voucher and line items
        const { voucher, lineItems } = await parseVoucher(tallyVoucher, companyGuid);
        
        // Skip if no valid GUID
        if (!voucher.voucher_guid) {
          results.errors.push({
            voucher_number: voucher.voucher_number,
            error: 'Missing voucher GUID'
          });
          continue;
        }
        
        // Check if voucher exists
        const existsResult = await pool.query(
          'SELECT id FROM vouchers WHERE voucher_guid = $1 AND company_guid = $2',
          [voucher.voucher_guid, companyGuid]
        );
        
        const isUpdate = existsResult.rows.length > 0;
        
        // Upsert voucher
        const voucherId = await upsertVoucher(voucher);
        
        // Upsert line items
        const linesInserted = await upsertLineItems(voucherId, lineItems);
        
        // Update stats
        results.totalProcessed++;
        if (isUpdate) {
          results.vouchersUpdated++;
        } else {
          results.vouchersInserted++;
        }
        results.lineItemsInserted += linesInserted;
        
        // Progress callback
        if (onProgress) {
          onProgress(results.totalProcessed, total);
        }
        
      } catch (error) {
        console.error(`Error processing voucher:`, error.message);
        results.errors.push({
          voucher_number: extractValue(tallyVoucher.VOUCHERNUMBER) || 'unknown',
          error: error.message
        });
      }
    }
    
    // Log batch completion
    console.log(`✅ Batch ${batchNum}/${totalBatches} complete - ${results.totalProcessed}/${total} processed`);
  }
  
  // Clear caches
  clearCaches();
  
  // Calculate duration
  results.durationMs = Date.now() - results.startTime;
  results.durationSeconds = Math.round(results.durationMs / 1000);
  
  console.log(`✅ Voucher sync complete!`);
  console.log(`   - Vouchers inserted: ${results.vouchersInserted}`);
  console.log(`   - Vouchers updated: ${results.vouchersUpdated}`);
  console.log(`   - Line items: ${results.lineItemsInserted}`);
  console.log(`   - Errors: ${results.errors.length}`);
  console.log(`   - Duration: ${results.durationSeconds}s`);
  
  return results;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  buildVoucherFetchXML,
  syncVouchers,
  parseVoucher,
  clearCaches
};

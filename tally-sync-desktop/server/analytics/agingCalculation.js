/**
 * CORRECTED AGING CALCULATION MODULE
 * ====================================
 * 
 * PROBLEM: The old aging calculation used `synced_at` (when data was synced)
 *          instead of actual invoice dates. This meant if you synced all data
 *          today, everything showed as "0-30 days" regardless of actual age.
 * 
 * SOLUTION: Calculate aging based on:
 *   1. Voucher `date` field (when invoice was created)
 *   2. Voucher `due_date` field (when payment is due, if available)
 *   3. Individual unpaid vouchers, not just ledger totals
 * 
 * This gives TRUE aging that matches what Tally shows.
 */

const { pool } = require('../db/postgres');

/**
 * Calculate aging based on VOUCHER DATE (correct method)
 * 
 * For receivables (Sales invoices):
 *   - Age = days since invoice date (or due date if available)
 *   - Only count unpaid/partially paid vouchers
 * 
 * For payables (Purchase invoices):
 *   - Age = days since invoice date (or due date if available)
 *   - Only count unpaid/partially paid vouchers
 */
async function calculateVoucherBasedAging(companyGuid) {
  if (!companyGuid) {
    console.warn('⚠️ No company GUID provided for aging calculation');
    return { success: false, error: 'No company GUID' };
  }

  console.log(`📅 Calculating voucher-based aging for company: ${companyGuid}...`);
  const startTime = Date.now();

  try {
    // Clear previous aging data for this company
    await pool.query(
      'DELETE FROM outstanding_aging WHERE company_guid = $1',
      [companyGuid]
    );

    // =========================================================
    // RECEIVABLES AGING (Sales invoices - customers owe us)
    // =========================================================
    const receivablesQuery = `
      INSERT INTO outstanding_aging (
        customer_id,
        entity_type,
        current_0_30_days,
        current_31_60_days,
        current_61_90_days,
        current_over_90_days,
        total_outstanding,
        company_guid,
        calculated_at
      )
      SELECT 
        c.id as customer_id,
        'customer' as entity_type,
        COALESCE(SUM(CASE 
          WHEN age_days <= 30 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_0_30_days,
        COALESCE(SUM(CASE 
          WHEN age_days > 30 AND age_days <= 60 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_31_60_days,
        COALESCE(SUM(CASE 
          WHEN age_days > 60 AND age_days <= 90 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_61_90_days,
        COALESCE(SUM(CASE 
          WHEN age_days > 90 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_over_90_days,
        COALESCE(SUM(outstanding_amount), 0) as total_outstanding,
        $1 as company_guid,
        NOW() as calculated_at
      FROM (
        SELECT 
          v.party_name,
          v.total_amount as outstanding_amount,
          -- Use due_date if available, otherwise use voucher date
          EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))::INTEGER as age_days
        FROM vouchers v
        WHERE v.company_guid = $1
          AND v.voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')
          AND v.is_cancelled = FALSE
          AND v.total_amount > 0
          -- Only include unpaid vouchers
          AND (v.payment_status IS NULL OR v.payment_status != 'PAID')
      ) aged_vouchers
      JOIN customers c ON LOWER(c.name) = LOWER(aged_vouchers.party_name) 
        AND c.company_guid = $1
      GROUP BY c.id
      HAVING SUM(outstanding_amount) > 0
    `;

    // =========================================================
    // PAYABLES AGING (Purchase invoices - we owe vendors)
    // =========================================================
    const payablesQuery = `
      INSERT INTO outstanding_aging (
        vendor_id,
        entity_type,
        current_0_30_days,
        current_31_60_days,
        current_61_90_days,
        current_over_90_days,
        total_outstanding,
        company_guid,
        calculated_at
      )
      SELECT 
        v_vendor.id as vendor_id,
        'vendor' as entity_type,
        COALESCE(SUM(CASE 
          WHEN age_days <= 30 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_0_30_days,
        COALESCE(SUM(CASE 
          WHEN age_days > 30 AND age_days <= 60 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_31_60_days,
        COALESCE(SUM(CASE 
          WHEN age_days > 60 AND age_days <= 90 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_61_90_days,
        COALESCE(SUM(CASE 
          WHEN age_days > 90 THEN outstanding_amount 
          ELSE 0 
        END), 0) as current_over_90_days,
        COALESCE(SUM(outstanding_amount), 0) as total_outstanding,
        $1 as company_guid,
        NOW() as calculated_at
      FROM (
        SELECT 
          v.party_name,
          v.total_amount as outstanding_amount,
          -- Use due_date if available, otherwise use voucher date
          EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))::INTEGER as age_days
        FROM vouchers v
        WHERE v.company_guid = $1
          AND v.voucher_type IN ('Purchase', 'Purchase Invoice', 'Credit Note')
          AND v.is_cancelled = FALSE
          AND v.total_amount > 0
          -- Only include unpaid vouchers
          AND (v.payment_status IS NULL OR v.payment_status != 'PAID')
      ) aged_vouchers
      JOIN vendors v_vendor ON LOWER(v_vendor.name) = LOWER(aged_vouchers.party_name) 
        AND v_vendor.company_guid = $1
      GROUP BY v_vendor.id
      HAVING SUM(outstanding_amount) > 0
    `;

    // Execute both queries
    const [receivablesResult, payablesResult] = await Promise.all([
      pool.query(receivablesQuery, [companyGuid]),
      pool.query(payablesQuery, [companyGuid])
    ]);

    const duration = Date.now() - startTime;
    console.log(`✅ Voucher-based aging calculated in ${duration}ms`);
    console.log(`   Receivables (customers): ${receivablesResult.rowCount} records`);
    console.log(`   Payables (vendors): ${payablesResult.rowCount} records`);

    return {
      success: true,
      receivables: receivablesResult.rowCount,
      payables: payablesResult.rowCount,
      duration: `${duration}ms`
    };

  } catch (error) {
    console.error('❌ Error calculating voucher-based aging:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get aging summary with proper date-based calculations
 * This can be called directly without pre-calculating
 */
async function getAgingSummaryRealtime(companyGuid, entityType = 'all') {
  if (!companyGuid) {
    return { success: false, error: 'No company GUID' };
  }

  try {
    // Build voucher type filter based on entity type
    let voucherTypes;
    if (entityType === 'customer' || entityType === 'receivables') {
      voucherTypes = "('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')";
    } else if (entityType === 'vendor' || entityType === 'payables') {
      voucherTypes = "('Purchase', 'Purchase Invoice', 'Credit Note')";
    } else {
      // All types
      voucherTypes = "('Sales', 'Invoice', 'Sales Invoice', 'Debit Note', 'Purchase', 'Purchase Invoice', 'Credit Note')";
    }

    const query = `
      SELECT 
        party_name as entity_name,
        CASE 
          WHEN voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note') THEN 'customer'
          ELSE 'vendor'
        END as entity_type,
        COUNT(*) as invoice_count,
        SUM(CASE WHEN age_days <= 30 THEN outstanding ELSE 0 END) as current_0_30_days,
        SUM(CASE WHEN age_days > 30 AND age_days <= 60 THEN outstanding ELSE 0 END) as current_31_60_days,
        SUM(CASE WHEN age_days > 60 AND age_days <= 90 THEN outstanding ELSE 0 END) as current_61_90_days,
        SUM(CASE WHEN age_days > 90 THEN outstanding ELSE 0 END) as current_over_90_days,
        SUM(outstanding) as total_outstanding,
        MIN(date) as oldest_invoice_date,
        MAX(date) as newest_invoice_date,
        MAX(age_days) as max_age_days,
        NOW() as calculated_at
      FROM (
        SELECT 
          v.party_name,
          v.voucher_type,
          v.date,
          v.due_date,
          v.total_amount as outstanding,
          GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days
        FROM vouchers v
        WHERE v.company_guid = $1
          AND v.voucher_type IN ${voucherTypes}
          AND v.is_cancelled = FALSE
          AND v.total_amount > 0
          AND (v.payment_status IS NULL OR v.payment_status != 'PAID')
      ) aged_invoices
      WHERE party_name IS NOT NULL
      GROUP BY party_name, 
        CASE 
          WHEN voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note') THEN 'customer'
          ELSE 'vendor'
        END
      HAVING SUM(outstanding) > 0
      ORDER BY SUM(outstanding) DESC
    `;

    const result = await pool.query(query, [companyGuid]);

    // Calculate totals
    const totals = {
      total_outstanding: 0,
      current_0_30_days: 0,
      current_31_60_days: 0,
      current_61_90_days: 0,
      current_over_90_days: 0,
      entity_count: result.rows.length
    };

    result.rows.forEach(row => {
      totals.total_outstanding += parseFloat(row.total_outstanding) || 0;
      totals.current_0_30_days += parseFloat(row.current_0_30_days) || 0;
      totals.current_31_60_days += parseFloat(row.current_31_60_days) || 0;
      totals.current_61_90_days += parseFloat(row.current_61_90_days) || 0;
      totals.current_over_90_days += parseFloat(row.current_over_90_days) || 0;
    });

    return {
      success: true,
      data: result.rows,
      totals,
      count: result.rows.length,
      calculatedAt: new Date().toISOString(),
      method: 'voucher_date_based'
    };

  } catch (error) {
    console.error('❌ Error getting realtime aging:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get detailed aging for a specific party (customer or vendor)
 * Shows individual invoices with their ages
 */
async function getPartyAgingDetail(companyGuid, partyName, entityType = 'customer') {
  if (!companyGuid || !partyName) {
    return { success: false, error: 'Missing required parameters' };
  }

  try {
    let voucherTypes;
    if (entityType === 'customer') {
      voucherTypes = "('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')";
    } else {
      voucherTypes = "('Purchase', 'Purchase Invoice', 'Credit Note')";
    }

    const query = `
      SELECT 
        v.voucher_number,
        v.voucher_type,
        v.date as invoice_date,
        v.due_date,
        v.total_amount as invoice_amount,
        COALESCE(v.amount_paid, 0) as amount_paid,
        v.total_amount - COALESCE(v.amount_paid, 0) as outstanding,
        v.payment_status,
        GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days,
        CASE 
          WHEN EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)) <= 30 THEN '0-30 days'
          WHEN EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)) <= 60 THEN '31-60 days'
          WHEN EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)) <= 90 THEN '61-90 days'
          ELSE 'Over 90 days'
        END as aging_bucket,
        v.narration
      FROM vouchers v
      WHERE v.company_guid = $1
        AND LOWER(v.party_name) = LOWER($2)
        AND v.voucher_type IN ${voucherTypes}
        AND v.is_cancelled = FALSE
        AND v.total_amount > 0
        AND (v.payment_status IS NULL OR v.payment_status != 'PAID')
      ORDER BY v.date ASC
    `;

    const result = await pool.query(query, [companyGuid, partyName]);

    // Calculate summary
    const summary = {
      party_name: partyName,
      entity_type: entityType,
      total_invoices: result.rows.length,
      total_outstanding: 0,
      by_bucket: {
        '0-30 days': 0,
        '31-60 days': 0,
        '61-90 days': 0,
        'Over 90 days': 0
      },
      oldest_invoice: null,
      newest_invoice: null
    };

    result.rows.forEach(row => {
      const outstanding = parseFloat(row.outstanding) || 0;
      summary.total_outstanding += outstanding;
      summary.by_bucket[row.aging_bucket] += outstanding;
      
      if (!summary.oldest_invoice || row.invoice_date < summary.oldest_invoice) {
        summary.oldest_invoice = row.invoice_date;
      }
      if (!summary.newest_invoice || row.invoice_date > summary.newest_invoice) {
        summary.newest_invoice = row.invoice_date;
      }
    });

    return {
      success: true,
      summary,
      invoices: result.rows,
      count: result.rows.length
    };

  } catch (error) {
    console.error('❌ Error getting party aging detail:', error);
    return { success: false, error: error.message };
  }
}

/**
 * FALLBACK: Calculate aging from transactions table
 * Used when vouchers table is empty or not synced
 * Still uses actual transaction dates (not synced_at)
 */
async function calculateTransactionBasedAging(companyGuid) {
  if (!companyGuid) {
    return { success: false, error: 'No company GUID' };
  }

  console.log(`📅 Calculating transaction-based aging for company: ${companyGuid}...`);

  try {
    // Clear previous aging data
    await pool.query(
      'DELETE FROM outstanding_aging WHERE company_guid = $1',
      [companyGuid]
    );

    // Calculate aging from transactions table using actual date field
    const agingQuery = `
      INSERT INTO outstanding_aging (
        customer_id,
        vendor_id,
        entity_type,
        current_0_30_days,
        current_31_60_days,
        current_61_90_days,
        current_over_90_days,
        total_outstanding,
        company_guid,
        calculated_at
      )
      SELECT 
        c.id as customer_id,
        NULL as vendor_id,
        'customer' as entity_type,
        COALESCE(SUM(CASE 
          WHEN EXTRACT(DAY FROM NOW() - t.date) <= 30 THEN ABS(t.amount) 
          ELSE 0 
        END), 0) as current_0_30_days,
        COALESCE(SUM(CASE 
          WHEN EXTRACT(DAY FROM NOW() - t.date) > 30 
           AND EXTRACT(DAY FROM NOW() - t.date) <= 60 THEN ABS(t.amount) 
          ELSE 0 
        END), 0) as current_31_60_days,
        COALESCE(SUM(CASE 
          WHEN EXTRACT(DAY FROM NOW() - t.date) > 60 
           AND EXTRACT(DAY FROM NOW() - t.date) <= 90 THEN ABS(t.amount) 
          ELSE 0 
        END), 0) as current_61_90_days,
        COALESCE(SUM(CASE 
          WHEN EXTRACT(DAY FROM NOW() - t.date) > 90 THEN ABS(t.amount) 
          ELSE 0 
        END), 0) as current_over_90_days,
        COALESCE(SUM(ABS(t.amount)), 0) as total_outstanding,
        $1 as company_guid,
        NOW() as calculated_at
      FROM transactions t
      JOIN customers c ON LOWER(c.name) = LOWER(t.party_name) AND c.company_guid = $1
      WHERE t.company_guid = $1
        AND t.voucher_type IN ('Sales', 'Invoice')
        AND t.amount > 0
        AND t.date IS NOT NULL
      GROUP BY c.id
      HAVING SUM(ABS(t.amount)) > 0
    `;

    await pool.query(agingQuery, [companyGuid]);

    console.log(`✅ Transaction-based aging calculated`);
    return { success: true, method: 'transaction_date_based' };

  } catch (error) {
    console.error('❌ Error calculating transaction-based aging:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  calculateVoucherBasedAging,
  getAgingSummaryRealtime,
  getPartyAgingDetail,
  calculateTransactionBasedAging
};
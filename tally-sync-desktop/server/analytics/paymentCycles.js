const { pool } = require('../db/postgres');

// Calculate settlement cycles for vendors
async function calculateVendorSettlementCycles(companyGuid) {
  try {
    if (!companyGuid) {
      console.warn('⚠️ No company GUID provided for settlement cycles calculation');
      return;
    }
    
    console.log(`Calculating vendor settlement cycles for company: ${companyGuid}...`);
    
    // Delete existing cycles for this company - Cast to VARCHAR
    await pool.query('DELETE FROM payment_cycles WHERE company_guid = CAST($1 AS VARCHAR)', [companyGuid]);
    
    const query = `
      WITH vendor_payments AS (
        SELECT 
          v.id as vendor_id,
          t.date,
          t.amount,
          LAG(t.date) OVER (PARTITION BY v.id ORDER BY t.date) as prev_payment_date
        FROM vendors v
        JOIN transactions t ON t.party_name = v.name
        WHERE t.voucher_type LIKE '%Payment%'
          AND v.company_guid = CAST($1 AS VARCHAR)
          AND t.company_guid = CAST($1 AS VARCHAR)
      ),
      settlement_data AS (
        SELECT 
          vendor_id,
          date - prev_payment_date as settlement_days
        FROM vendor_payments
        WHERE prev_payment_date IS NOT NULL
      )
      INSERT INTO payment_cycles (
        vendor_id, 
        entity_type,
        avg_settlement_days,
        min_settlement_days,
        max_settlement_days,
        payment_count,
        company_guid,
        calculated_at
      )
      SELECT 
        vendor_id,
        'vendor',
        AVG(settlement_days)::NUMERIC(10,2),
        MIN(settlement_days),
        MAX(settlement_days),
        COUNT(*),
        CAST($1 AS VARCHAR),
        NOW()
      FROM settlement_data
      GROUP BY vendor_id
      ON CONFLICT DO NOTHING
    `;
    
    const result = await pool.query(query, [companyGuid]);
    console.log('Vendor settlement cycles calculated');
    return result;
  } catch (error) {
    console.error('Error calculating settlement cycles:', error);
    throw error;
  }
}

// Calculate outstanding aging - CORRECTED VERSION
// Uses actual voucher/invoice dates instead of synced_at
async function calculateOutstandingAging(companyGuid) {
  try {
    if (!companyGuid) {
      console.warn('⚠️ No company GUID provided for aging calculation');
      return;
    }
    
    console.log(`📅 Calculating outstanding aging for company: ${companyGuid}...`);
    
    // Clear previous rows for this company only
    await pool.query('DELETE FROM outstanding_aging WHERE company_guid = $1', [companyGuid]);
    
    // Check if vouchers table has data
    const voucherCheck = await pool.query(
      'SELECT COUNT(*) as count FROM vouchers WHERE company_guid = $1',
      [companyGuid]
    );
    const hasVouchers = parseInt(voucherCheck.rows[0]?.count || 0) > 0;
    
    if (hasVouchers) {
      // =========================================================
      // PREFERRED: Use vouchers table with actual invoice dates
      // =========================================================
      console.log('   Using voucher-based aging (correct method)');
      
      // For customers (receivables) - Sales invoices
      const customerQuery = `
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
            COALESCE(v.amount_outstanding, v.total_amount) as outstanding_amount,
            GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days
          FROM vouchers v
          WHERE v.company_guid = $1
            AND v.voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')
            AND v.is_cancelled = FALSE
            AND COALESCE(v.amount_outstanding, v.total_amount) > 0
            AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
        ) aged_vouchers
        JOIN customers c ON LOWER(c.name) = LOWER(aged_vouchers.party_name) 
          AND c.company_guid = $1
        GROUP BY c.id
        HAVING SUM(outstanding_amount) > 0
        ON CONFLICT DO NOTHING
      `;
      
      // For vendors (payables) - Purchase invoices
      const vendorQuery = `
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
          vd.id as vendor_id,
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
            COALESCE(v.amount_outstanding, v.total_amount) as outstanding_amount,
            GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days
          FROM vouchers v
          WHERE v.company_guid = $1
            AND v.voucher_type IN ('Purchase', 'Purchase Invoice', 'Credit Note')
            AND v.is_cancelled = FALSE
            AND COALESCE(v.amount_outstanding, v.total_amount) > 0
            AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
        ) aged_vouchers
        JOIN vendors vd ON LOWER(vd.name) = LOWER(aged_vouchers.party_name) 
          AND vd.company_guid = $1
        GROUP BY vd.id
        HAVING SUM(outstanding_amount) > 0
        ON CONFLICT DO NOTHING
      `;
      
      const customerResult = await pool.query(customerQuery, [companyGuid]);
      const vendorResult = await pool.query(vendorQuery, [companyGuid]);
      
      console.log(`✅ Voucher-based aging calculated:`);
      console.log(`   Customers (receivables): ${customerResult.rowCount} records`);
      console.log(`   Vendors (payables): ${vendorResult.rowCount} records`);
      
      return { vendorResult, customerResult, method: 'voucher_date_based' };
      
    } else {
      // =========================================================
      // FALLBACK: Use transactions table with actual date field
      // Still correct - uses transaction date, not synced_at
      // =========================================================
      console.log('   Using transaction-based aging (fallback - no vouchers found)');
      
      // For customers using transactions
      const customerQuery = `
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
          c.id,
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
        ON CONFLICT DO NOTHING
      `;
      
      // For vendors using transactions
      const vendorQuery = `
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
          v.id,
          'vendor' as entity_type,
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
        JOIN vendors v ON LOWER(v.name) = LOWER(t.party_name) AND v.company_guid = $1
        WHERE t.company_guid = $1
          AND t.voucher_type IN ('Purchase', 'Purchase Invoice')
          AND t.amount > 0
          AND t.date IS NOT NULL
        GROUP BY v.id
        HAVING SUM(ABS(t.amount)) > 0
        ON CONFLICT DO NOTHING
      `;
      
      const customerResult = await pool.query(customerQuery, [companyGuid]);
      const vendorResult = await pool.query(vendorQuery, [companyGuid]);
      
      console.log(`✅ Transaction-based aging calculated (fallback):`);
      console.log(`   Customers (receivables): ${customerResult.rowCount} records`);
      console.log(`   Vendors (payables): ${vendorResult.rowCount} records`);
      
      return { vendorResult, customerResult, method: 'transaction_date_based' };
    }
  } catch (error) {
    console.error('❌ Error calculating aging:', error);
    throw error;
  }
}

// Calculate vendor scores
async function calculateVendorScores(companyGuid) {
  try {
    if (!companyGuid) {
      console.warn('⚠️ No company GUID provided for vendor scores calculation');
      return;
    }
    
    console.log(`Calculating vendor scores for company: ${companyGuid}...`);
    
    // Delete existing scores for this company - Cast to VARCHAR
    await pool.query('DELETE FROM vendor_scores WHERE company_guid = CAST($1 AS VARCHAR)', [companyGuid]);
    
    const query = `
      WITH vendor_metrics AS (
        SELECT 
          v.id as vendor_id,
          COUNT(t.id) as transaction_count,
          AVG(t.amount) as avg_amount,
          SUM(t.amount) as total_amount,
          COALESCE(pc.on_time_percentage, 50) as on_time_pct
        FROM vendors v
        LEFT JOIN transactions t ON t.party_name = v.name AND t.company_guid = CAST($1 AS VARCHAR)
        LEFT JOIN payment_cycles pc ON pc.vendor_id = v.id AND pc.company_guid = CAST($1 AS VARCHAR)
        WHERE v.company_guid = CAST($1 AS VARCHAR)
        GROUP BY v.id, pc.on_time_percentage
      )
      INSERT INTO vendor_scores (
        vendor_id,
        reliability_score,
        payment_history_score,
        volume_score,
        overall_score,
        risk_level,
        company_guid,
        calculated_at
      )
      SELECT 
        vendor_id,
        on_time_pct,
        CASE 
          WHEN transaction_count > 10 THEN 80
          WHEN transaction_count > 5 THEN 60
          ELSE 40
        END,
        CASE 
          WHEN total_amount > 100000 THEN 90
          WHEN total_amount > 50000 THEN 70
          ELSE 50
        END,
        (on_time_pct + 
         CASE WHEN transaction_count > 10 THEN 80 ELSE 50 END + 
         CASE WHEN total_amount > 50000 THEN 70 ELSE 50 END) / 3,
        CASE 
          WHEN (on_time_pct + 50) / 2 > 70 THEN 'low'
          WHEN (on_time_pct + 50) / 2 > 40 THEN 'medium'
          ELSE 'high'
        END,
        CAST($1 AS VARCHAR),
        NOW()
      FROM vendor_metrics
      ON CONFLICT (vendor_id) 
      DO UPDATE SET
        reliability_score = EXCLUDED.reliability_score,
        payment_history_score = EXCLUDED.payment_history_score,
        volume_score = EXCLUDED.volume_score,
        overall_score = EXCLUDED.overall_score,
        risk_level = EXCLUDED.risk_level,
        company_guid = EXCLUDED.company_guid,
        calculated_at = NOW()
    `;
    
    const result = await pool.query(query, [companyGuid]);
    console.log('Vendor scores calculated');
    return result;
  } catch (error) {
    console.error('Error calculating scores:', error);
    throw error;
  }
}

module.exports = {
  calculateVendorSettlementCycles,
  calculateOutstandingAging,
  calculateVendorScores
};
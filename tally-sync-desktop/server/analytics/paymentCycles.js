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

// Calculate outstanding aging
async function calculateOutstandingAging(companyGuid) {
  try {
    if (!companyGuid) {
      console.warn('⚠️ No company GUID provided for aging calculation');
      return;
    }
    
    console.log(`Calculating outstanding aging for company: ${companyGuid}...`);
    
    // Clear previous rows for this company only - Cast to VARCHAR explicitly
    await pool.query('DELETE FROM outstanding_aging WHERE company_guid = CAST($1 AS VARCHAR)', [companyGuid]);
    
    // For vendors (payables) - Cast company_guid to VARCHAR to match column type
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
        'vendor'::VARCHAR,
        CASE WHEN v.synced_at > NOW() - INTERVAL '30 days' 
          THEN v.current_balance ELSE 0 END,
        CASE WHEN v.synced_at BETWEEN NOW() - INTERVAL '60 days' 
          AND NOW() - INTERVAL '30 days' 
          THEN v.current_balance ELSE 0 END,
        CASE WHEN v.synced_at BETWEEN NOW() - INTERVAL '90 days' 
          AND NOW() - INTERVAL '60 days' 
          THEN v.current_balance ELSE 0 END,
        CASE WHEN v.synced_at < NOW() - INTERVAL '90 days' 
          THEN v.current_balance ELSE 0 END,
        v.current_balance,
        CAST($1 AS VARCHAR),
        NOW()
      FROM vendors v
      WHERE v.current_balance > 0
        AND v.company_guid = CAST($1 AS VARCHAR)
      ON CONFLICT DO NOTHING
    `;
    
    // For customers (receivables) - Cast company_guid to VARCHAR to match column type
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
        'customer'::VARCHAR,
        CASE WHEN c.synced_at > NOW() - INTERVAL '30 days' 
          THEN ABS(c.current_balance) ELSE 0 END,
        CASE WHEN c.synced_at BETWEEN NOW() - INTERVAL '60 days' 
          AND NOW() - INTERVAL '30 days' 
          THEN ABS(c.current_balance) ELSE 0 END,
        CASE WHEN c.synced_at BETWEEN NOW() - INTERVAL '90 days' 
          AND NOW() - INTERVAL '60 days' 
          THEN ABS(c.current_balance) ELSE 0 END,
        CASE WHEN c.synced_at < NOW() - INTERVAL '90 days' 
          THEN ABS(c.current_balance) ELSE 0 END,
        ABS(c.current_balance),
        CAST($1 AS VARCHAR),
        NOW()
      FROM customers c
      WHERE c.current_balance IS NOT NULL
        AND c.company_guid = CAST($1 AS VARCHAR)
      ON CONFLICT DO NOTHING
    `;
    
    const vendorResult = await pool.query(vendorQuery, [companyGuid]);
    const customerResult = await pool.query(customerQuery, [companyGuid]);
    console.log('Outstanding aging calculated for vendors and customers');
    return { vendorResult, customerResult };
  } catch (error) {
    console.error('Error calculating aging:', error);
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

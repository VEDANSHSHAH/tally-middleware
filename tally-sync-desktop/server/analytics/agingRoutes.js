/**
 * AGING ROUTES - Corrected Invoice-Based Aging
 * ==============================================
 * 
 * Provides endpoints for proper aging calculation based on
 * actual invoice dates (not sync dates).
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/postgres');

// Import the corrected aging calculation module
let agingCalculation;
try {
  agingCalculation = require('./agingCalculation');
} catch (err) {
  console.warn('⚠️ agingCalculation module not found, using inline queries');
}

/**
 * Helper function to check if vouchers table has data
 */
async function checkVouchersTable(companyGuid) {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM vouchers WHERE company_guid = $1',
      [companyGuid]
    );
    const count = parseInt(result.rows[0]?.count || 0);
    console.log(`📊 Vouchers check for ${companyGuid}: ${count} records`);
    return count > 0;
  } catch (err) {
    // Table doesn't exist or other error - fall back to transactions
    console.log('Vouchers table check failed, using transactions:', err.message);
    return false;
  }
}

/**
 * GET /api/aging/summary
 * Get aging summary for all parties (realtime calculation)
 * 
 * Query params:
 *   - type: 'customer', 'vendor', or 'all' (default: 'all')
 */
router.get('/summary', async (req, res) => {
  try {
    const companyGuid = req.headers['x-company-guid'] || req.query.companyGuid;
    const entityType = req.query.type || 'all';

    if (!companyGuid) {
      return res.status(400).json({
        success: false,
        error: 'Company GUID required'
      });
    }

    // Check if vouchers table has data
    const hasVouchers = await checkVouchersTable(companyGuid);

    let query;
    let dataSource;

    if (hasVouchers) {
      // Use vouchers table (preferred)
      dataSource = 'vouchers';
      
      // Build voucher type filter
      let voucherTypes;
      if (entityType === 'customer' || entityType === 'receivables') {
        voucherTypes = "('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')";
      } else if (entityType === 'vendor' || entityType === 'payables') {
        voucherTypes = "('Purchase', 'Purchase Invoice', 'Credit Note')";
      } else {
        voucherTypes = "('Sales', 'Invoice', 'Sales Invoice', 'Debit Note', 'Purchase', 'Purchase Invoice', 'Credit Note')";
      }

      query = `
        SELECT 
          party_name as entity_name,
          CASE 
            WHEN voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note') THEN 'customer'
            ELSE 'vendor'
          END as entity_type,
          COUNT(*) as invoice_count,
          SUM(CASE WHEN age_days <= 30 THEN outstanding ELSE 0 END)::NUMERIC(15,2) as current_0_30_days,
          SUM(CASE WHEN age_days > 30 AND age_days <= 60 THEN outstanding ELSE 0 END)::NUMERIC(15,2) as current_31_60_days,
          SUM(CASE WHEN age_days > 60 AND age_days <= 90 THEN outstanding ELSE 0 END)::NUMERIC(15,2) as current_61_90_days,
          SUM(CASE WHEN age_days > 90 THEN outstanding ELSE 0 END)::NUMERIC(15,2) as current_over_90_days,
          SUM(outstanding)::NUMERIC(15,2) as total_outstanding,
          MIN(date) as oldest_invoice_date,
          MAX(date) as newest_invoice_date,
          MAX(age_days) as max_age_days
        FROM (
          SELECT 
            v.party_name,
            v.voucher_type,
            v.date,
            v.due_date,
            -- Use total_amount if amount_outstanding is 0 or NULL
            CASE 
              WHEN COALESCE(v.amount_outstanding, 0) = 0 THEN v.total_amount
              ELSE v.amount_outstanding
            END as outstanding,
            GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days
          FROM vouchers v
          WHERE v.company_guid = $1
            AND v.voucher_type IN ${voucherTypes}
            AND v.is_cancelled = FALSE
            AND v.total_amount > 0
            AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
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
    } else {
      // Fallback to transactions table
      dataSource = 'transactions';
      
      let voucherTypes;
      if (entityType === 'customer' || entityType === 'receivables') {
        voucherTypes = "('Sales', 'Invoice')";
      } else if (entityType === 'vendor' || entityType === 'payables') {
        voucherTypes = "('Purchase', 'Purchase Invoice')";
      } else {
        voucherTypes = "('Sales', 'Invoice', 'Purchase', 'Purchase Invoice')";
      }

      query = `
        SELECT 
          party_name as entity_name,
          CASE 
            WHEN voucher_type IN ('Sales', 'Invoice') THEN 'customer'
            ELSE 'vendor'
          END as entity_type,
          COUNT(*) as invoice_count,
          SUM(CASE WHEN age_days <= 30 THEN amount ELSE 0 END)::NUMERIC(15,2) as current_0_30_days,
          SUM(CASE WHEN age_days > 30 AND age_days <= 60 THEN amount ELSE 0 END)::NUMERIC(15,2) as current_31_60_days,
          SUM(CASE WHEN age_days > 60 AND age_days <= 90 THEN amount ELSE 0 END)::NUMERIC(15,2) as current_61_90_days,
          SUM(CASE WHEN age_days > 90 THEN amount ELSE 0 END)::NUMERIC(15,2) as current_over_90_days,
          SUM(amount)::NUMERIC(15,2) as total_outstanding,
          MIN(date) as oldest_invoice_date,
          MAX(date) as newest_invoice_date,
          MAX(age_days) as max_age_days
        FROM (
          SELECT 
            t.party_name,
            t.voucher_type,
            t.date,
            ABS(t.amount) as amount,
            GREATEST(0, EXTRACT(DAY FROM NOW() - t.date))::INTEGER as age_days
          FROM transactions t
          WHERE t.company_guid = $1
            AND t.voucher_type IN ${voucherTypes}
            AND t.date IS NOT NULL
            AND t.amount > 0
        ) aged_invoices
        WHERE party_name IS NOT NULL
        GROUP BY party_name, 
          CASE 
            WHEN voucher_type IN ('Sales', 'Invoice') THEN 'customer'
            ELSE 'vendor'
          END
        HAVING SUM(amount) > 0
        ORDER BY SUM(amount) DESC
      `;
    }

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

    res.json({
      success: true,
      data: result.rows,
      totals,
      count: result.rows.length,
      calculatedAt: new Date().toISOString(),
      dataSource: dataSource
    });

  } catch (error) {
    console.error('Error getting aging summary:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/aging/party/:partyName
 * Get detailed aging for a specific party with individual invoices
 * 
 * Query params:
 *   - type: 'customer' or 'vendor' (default: 'customer')
 */
router.get('/party/:partyName', async (req, res) => {
  try {
    const companyGuid = req.headers['x-company-guid'] || req.query.companyGuid;
    const partyName = decodeURIComponent(req.params.partyName);
    const entityType = req.query.type || 'customer';

    if (!companyGuid) {
      return res.status(400).json({
        success: false,
        error: 'Company GUID required'
      });
    }

    let voucherTypes;
    if (entityType === 'customer') {
      voucherTypes = "('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')";
    } else {
      voucherTypes = "('Purchase', 'Purchase Invoice', 'Credit Note')";
    }

    const query = `
      SELECT 
        v.id,
        v.voucher_number,
        v.voucher_type,
        v.date as invoice_date,
        v.due_date,
        v.total_amount as invoice_amount,
        COALESCE(v.amount_paid, 0) as amount_paid,
        COALESCE(v.amount_outstanding, v.total_amount) as outstanding,
        v.payment_status,
        GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days,
        CASE 
          WHEN EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)) <= 30 THEN '0-30 days'
          WHEN EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)) <= 60 THEN '31-60 days'
          WHEN EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)) <= 90 THEN '61-90 days'
          ELSE 'Over 90 days'
        END as aging_bucket,
        v.narration,
        v.reference_number
      FROM vouchers v
      WHERE v.company_guid = $1
        AND LOWER(v.party_name) = LOWER($2)
        AND v.voucher_type IN ${voucherTypes}
        AND v.is_cancelled = FALSE
        AND COALESCE(v.amount_outstanding, v.total_amount) > 0
        AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
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
      newest_invoice: null,
      average_age_days: 0
    };

    let totalAgeDays = 0;
    result.rows.forEach(row => {
      const outstanding = parseFloat(row.outstanding) || 0;
      summary.total_outstanding += outstanding;
      summary.by_bucket[row.aging_bucket] += outstanding;
      totalAgeDays += parseInt(row.age_days) || 0;
      
      if (!summary.oldest_invoice || row.invoice_date < summary.oldest_invoice) {
        summary.oldest_invoice = row.invoice_date;
      }
      if (!summary.newest_invoice || row.invoice_date > summary.newest_invoice) {
        summary.newest_invoice = row.invoice_date;
      }
    });

    if (result.rows.length > 0) {
      summary.average_age_days = Math.round(totalAgeDays / result.rows.length);
    }

    res.json({
      success: true,
      summary,
      invoices: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error('Error getting party aging detail:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/aging/debug
 * Debug endpoint to test raw voucher data
 */
router.get('/debug', async (req, res) => {
  try {
    const companyGuid = req.headers['x-company-guid'] || req.query.companyGuid;

    if (!companyGuid) {
      return res.status(400).json({ error: 'Company GUID required' });
    }

    // Test basic count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE is_cancelled = FALSE) as not_cancelled,
              COUNT(*) FILTER (WHERE total_amount > 0) as has_amount,
              COUNT(*) FILTER (WHERE payment_status NOT IN ('PAID', 'Fully Paid')) as not_paid,
              COUNT(*) FILTER (WHERE payment_status IS NULL) as null_status,
              COUNT(*) FILTER (WHERE voucher_type = 'Sales') as sales_type,
              COUNT(*) FILTER (WHERE party_name IS NOT NULL) as has_party_name,
              COUNT(*) FILTER (WHERE date IS NOT NULL) as has_date
       FROM vouchers WHERE company_guid = $1`,
      [companyGuid]
    );

    // Test the actual aging calculation
    const agingTest = await pool.query(
      `SELECT 
         CASE 
           WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 30 THEN '0-30 days'
           WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 60 THEN '31-60 days'
           WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 90 THEN '61-90 days'
           ELSE 'Over 90 days'
         END as bucket,
         COUNT(*) as count,
         SUM(CASE 
           WHEN COALESCE(v.amount_outstanding, 0) = 0 THEN v.total_amount
           ELSE v.amount_outstanding
         END)::NUMERIC(15,2) as total_amount
       FROM vouchers v
       WHERE v.company_guid = $1
         AND v.is_cancelled = FALSE
         AND v.total_amount > 0
         AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
       GROUP BY bucket
       ORDER BY bucket`,
      [companyGuid]
    );

    // Sample data grouped
    const sampleData = await pool.query(
      `SELECT 
         v.voucher_type,
         v.payment_status,
         v.is_cancelled,
         v.total_amount,
         v.amount_outstanding,
         COUNT(*) as count
       FROM vouchers v
       WHERE v.company_guid = $1
       GROUP BY v.voucher_type, v.payment_status, v.is_cancelled, v.total_amount, v.amount_outstanding
       LIMIT 20`,
      [companyGuid]
    );

    res.json({
      success: true,
      counts: countResult.rows[0],
      agingBuckets: agingTest.rows,
      sampleData: sampleData.rows
    });

  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

/**
 * GET /api/aging/buckets
 * Get aggregated aging by bucket across all parties
 */
router.get('/buckets', async (req, res) => {
  try {
    const companyGuid = req.headers['x-company-guid'] || req.query.companyGuid;
    const entityType = req.query.type || 'all';

    console.log(`📊 /api/aging/buckets called - companyGuid: ${companyGuid}, entityType: ${entityType}`);

    if (!companyGuid) {
      return res.status(400).json({
        success: false,
        error: 'Company GUID required'
      });
    }

    // Check if vouchers table has data
    const hasVouchers = await checkVouchersTable(companyGuid);
    console.log(`📊 hasVouchers: ${hasVouchers}`);

    let query;
    let dataSource;

    if (hasVouchers) {
      // Use vouchers table (preferred)
      dataSource = 'vouchers';
      let typeFilter = '';
      if (entityType === 'customer' || entityType === 'receivables') {
        typeFilter = "AND v.voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')";
      } else if (entityType === 'vendor' || entityType === 'payables') {
        typeFilter = "AND v.voucher_type IN ('Purchase', 'Purchase Invoice', 'Credit Note')";
      }
      
      console.log(`📊 typeFilter: "${typeFilter}"`);

      query = `
        SELECT 
          bucket,
          COUNT(*) as invoice_count,
          COUNT(DISTINCT party_name) as party_count,
          SUM(outstanding)::NUMERIC(15,2) as total_amount,
          AVG(outstanding)::NUMERIC(15,2) as avg_amount,
          MIN(outstanding)::NUMERIC(15,2) as min_amount,
          MAX(outstanding)::NUMERIC(15,2) as max_amount
        FROM (
          SELECT 
            v.party_name,
            -- Use total_amount if amount_outstanding is 0 or NULL
            CASE 
              WHEN COALESCE(v.amount_outstanding, 0) = 0 THEN v.total_amount
              ELSE v.amount_outstanding
            END as outstanding,
            GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date)))::INTEGER as age_days,
            CASE 
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 30 THEN '0-30 days'
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 60 THEN '31-60 days'
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 90 THEN '61-90 days'
              ELSE 'Over 90 days'
            END as bucket,
            CASE 
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 30 THEN 1
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 60 THEN 2
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - COALESCE(v.due_date, v.date))) <= 90 THEN 3
              ELSE 4
            END as bucket_order
          FROM vouchers v
          WHERE v.company_guid = $1
            AND v.is_cancelled = FALSE
            AND v.total_amount > 0
            AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
            ${typeFilter}
        ) aged
        GROUP BY bucket, bucket_order
        ORDER BY bucket_order
      `;
    } else {
      // Fallback to transactions table
      dataSource = 'transactions';
      let typeFilter = '';
      if (entityType === 'customer' || entityType === 'receivables') {
        typeFilter = "AND t.voucher_type IN ('Sales', 'Invoice')";
      } else if (entityType === 'vendor' || entityType === 'payables') {
        typeFilter = "AND t.voucher_type IN ('Purchase', 'Purchase Invoice')";
      }

      query = `
        SELECT 
          bucket,
          COUNT(*) as invoice_count,
          COUNT(DISTINCT party_name) as party_count,
          SUM(amount)::NUMERIC(15,2) as total_amount,
          AVG(amount)::NUMERIC(15,2) as avg_amount,
          MIN(amount)::NUMERIC(15,2) as min_amount,
          MAX(amount)::NUMERIC(15,2) as max_amount
        FROM (
          SELECT 
            t.party_name,
            ABS(t.amount) as amount,
            GREATEST(0, EXTRACT(DAY FROM NOW() - t.date))::INTEGER as age_days,
            CASE 
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - t.date)) <= 30 THEN '0-30 days'
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - t.date)) <= 60 THEN '31-60 days'
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - t.date)) <= 90 THEN '61-90 days'
              ELSE 'Over 90 days'
            END as bucket,
            CASE 
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - t.date)) <= 30 THEN 1
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - t.date)) <= 60 THEN 2
              WHEN GREATEST(0, EXTRACT(DAY FROM NOW() - t.date)) <= 90 THEN 3
              ELSE 4
            END as bucket_order
          FROM transactions t
          WHERE t.company_guid = $1
            AND t.date IS NOT NULL
            AND t.amount > 0
            ${typeFilter}
        ) aged
        GROUP BY bucket, bucket_order
        ORDER BY bucket_order
      `;
    }

    const result = await pool.query(query, [companyGuid]);
    
    console.log(`📊 Query returned ${result.rows.length} buckets:`, result.rows);

    // Calculate grand total
    const grandTotal = result.rows.reduce((sum, row) => 
      sum + (parseFloat(row.total_amount) || 0), 0
    );

    // Add percentage to each bucket
    const bucketsWithPercentage = result.rows.map(row => ({
      ...row,
      percentage: grandTotal > 0 
        ? ((parseFloat(row.total_amount) / grandTotal) * 100).toFixed(1) + '%'
        : '0%'
    }));

    res.json({
      success: true,
      buckets: bucketsWithPercentage,
      grandTotal: grandTotal.toFixed(2),
      calculatedAt: new Date().toISOString(),
      dataSource: dataSource
    });

  } catch (error) {
    console.error('Error getting aging buckets:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/aging/recalculate
 * Trigger recalculation of aging (stores in outstanding_aging table)
 */
router.post('/recalculate', async (req, res) => {
  try {
    const companyGuid = req.headers['x-company-guid'] || req.body.companyGuid;

    if (!companyGuid) {
      return res.status(400).json({
        success: false,
        error: 'Company GUID required'
      });
    }

    // Import and use the corrected aging calculation
    const { calculateOutstandingAging } = require('./paymentCycles');
    const result = await calculateOutstandingAging(companyGuid);

    res.json({
      success: true,
      message: 'Aging recalculated successfully',
      result,
      calculatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error recalculating aging:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/aging/overdue
 * Get all overdue invoices (past due date)
 */
router.get('/overdue', async (req, res) => {
  try {
    const companyGuid = req.headers['x-company-guid'] || req.query.companyGuid;
    const entityType = req.query.type || 'all';
    const limit = parseInt(req.query.limit) || 100;

    if (!companyGuid) {
      return res.status(400).json({
        success: false,
        error: 'Company GUID required'
      });
    }

    let typeFilter = '';
    if (entityType === 'customer' || entityType === 'receivables') {
      typeFilter = "AND v.voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note')";
    } else if (entityType === 'vendor' || entityType === 'payables') {
      typeFilter = "AND v.voucher_type IN ('Purchase', 'Purchase Invoice', 'Credit Note')";
    }

    const query = `
      SELECT 
        v.id,
        v.voucher_number,
        v.voucher_type,
        v.party_name,
        v.date as invoice_date,
        v.due_date,
        v.total_amount as invoice_amount,
        COALESCE(v.amount_outstanding, v.total_amount) as outstanding,
        (NOW()::DATE - v.due_date) as days_overdue,
        CASE 
          WHEN v.voucher_type IN ('Sales', 'Invoice', 'Sales Invoice', 'Debit Note') THEN 'customer'
          ELSE 'vendor'
        END as entity_type
      FROM vouchers v
      WHERE v.company_guid = $1
        AND v.is_cancelled = FALSE
        AND v.due_date IS NOT NULL
        AND v.due_date < NOW()::DATE
        AND COALESCE(v.amount_outstanding, v.total_amount) > 0
        AND (v.payment_status IS NULL OR v.payment_status NOT IN ('PAID', 'Fully Paid'))
        ${typeFilter}
      ORDER BY (NOW()::DATE - v.due_date) DESC, v.total_amount DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [companyGuid, limit]);

    // Calculate summary
    const totalOverdue = result.rows.reduce((sum, row) => 
      sum + (parseFloat(row.outstanding) || 0), 0
    );

    res.json({
      success: true,
      overdue: result.rows,
      count: result.rows.length,
      totalOverdue: totalOverdue.toFixed(2),
      calculatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error getting overdue invoices:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
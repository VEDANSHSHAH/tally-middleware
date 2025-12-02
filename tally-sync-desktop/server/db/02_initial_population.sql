-- =====================================================
-- INITIAL POPULATION - Run once after migrations
-- =====================================================

-- 1) Populate payment_references from voucher_line_items
INSERT INTO payment_references (
    company_guid,
    payment_voucher_id,
    payment_voucher_guid,
    payment_voucher_number,
    payment_date,
    invoice_voucher_id,
    invoice_voucher_guid,
    invoice_voucher_number,
    invoice_date,
    allocated_amount,
    allocation_type,
    party_ledger_id,
    party_name,
    synced_from_tally
)
SELECT DISTINCT
    pv.company_guid,
    pv.id AS payment_voucher_id,
    pv.voucher_guid AS payment_voucher_guid,
    pv.voucher_number AS payment_voucher_number,
    pv.date AS payment_date,
    iv.id AS invoice_voucher_id,
    iv.voucher_guid AS invoice_voucher_guid,
    vli.reference_name AS invoice_voucher_number,
    vli.reference_date AS invoice_date,
    vli.reference_amount AS allocated_amount,
    vli.reference_type AS allocation_type,
    pv.party_ledger_id,
    pv.party_name,
    TRUE
FROM voucher_line_items vli
JOIN vouchers pv ON vli.voucher_id = pv.id
LEFT JOIN vouchers iv ON iv.voucher_number = vli.reference_name 
    AND iv.company_guid = pv.company_guid
    AND iv.party_ledger_id = pv.party_ledger_id
WHERE pv.voucher_type IN ('RECEIPT', 'Payment Received')
  AND vli.reference_name IS NOT NULL
  AND vli.reference_amount IS NOT NULL
  AND vli.reference_amount > 0
ON CONFLICT DO NOTHING;

-- 2) Calculate voucher payment status
UPDATE vouchers v
SET 
    amount_paid = COALESCE((
        SELECT SUM(pr.allocated_amount)
        FROM payment_references pr
        WHERE pr.invoice_voucher_id = v.id
          AND pr.is_active = TRUE
    ), 0),
    amount_outstanding = v.total_amount - COALESCE((
        SELECT SUM(pr.allocated_amount)
        FROM payment_references pr
        WHERE pr.invoice_voucher_id = v.id
          AND pr.is_active = TRUE
    ), 0),
    payment_status = CASE
        WHEN v.is_cancelled THEN 'CANCELLED'
        WHEN COALESCE((
            SELECT SUM(pr.allocated_amount)
            FROM payment_references pr
            WHERE pr.invoice_voucher_id = v.id
              AND pr.is_active = TRUE
        ), 0) >= v.total_amount THEN 'PAID'
        WHEN COALESCE((
            SELECT SUM(pr.allocated_amount)
            FROM payment_references pr
            WHERE pr.invoice_voucher_id = v.id
              AND pr.is_active = TRUE
        ), 0) > 0 THEN 'PARTIAL'
        ELSE 'UNPAID'
    END,
    has_billwise_allocation = EXISTS(
        SELECT 1 FROM payment_references pr
        WHERE pr.invoice_voucher_id = v.id
          AND pr.is_active = TRUE
    ),
    billwise_allocated_amount = COALESCE((
        SELECT SUM(pr.allocated_amount)
        FROM payment_references pr
        WHERE pr.invoice_voucher_id = v.id
          AND pr.is_active = TRUE
    ), 0),
    days_since_due = CASE 
        WHEN v.due_date IS NOT NULL THEN CURRENT_DATE - v.due_date
        ELSE CURRENT_DATE - v.date
    END,
    aging_bucket = CASE 
        WHEN CURRENT_DATE - COALESCE(v.due_date, v.date) <= 30 THEN '0-30'
        WHEN CURRENT_DATE - COALESCE(v.due_date, v.date) <= 60 THEN '31-60'
        WHEN CURRENT_DATE - COALESCE(v.due_date, v.date) <= 90 THEN '61-90'
        ELSE '90+'
    END,
    payment_computed_at = NOW()
WHERE v.voucher_type IN ('SALES', 'Invoice', 'Sales Invoice')
  AND v.is_cancelled = FALSE;

-- 3) Calculate ledger aging fields
UPDATE ledgers l
SET 
    oldest_unpaid_date = (
        SELECT MIN(v.date)
        FROM vouchers v
        WHERE v.party_ledger_id = l.id
          AND v.voucher_type IN ('SALES', 'Invoice')
          AND v.is_cancelled = FALSE
          AND v.payment_status IN ('UNPAID', 'PARTIAL')
    ),
    days_overdue = CASE 
        WHEN (
            SELECT MIN(v.date)
            FROM vouchers v
            WHERE v.party_ledger_id = l.id
              AND v.voucher_type IN ('SALES', 'Invoice')
              AND v.is_cancelled = FALSE
              AND v.payment_status IN ('UNPAID', 'PARTIAL')
        ) IS NOT NULL 
        THEN CURRENT_DATE - (
            SELECT MIN(v.date)
            FROM vouchers v
            WHERE v.party_ledger_id = l.id
              AND v.voucher_type IN ('SALES', 'Invoice')
              AND v.is_cancelled = FALSE
              AND v.payment_status IN ('UNPAID', 'PARTIAL')
        )
        ELSE 0
    END,
    avg_payment_days = (
        SELECT AVG(pr.payment_date - iv.date)::INTEGER
        FROM payment_references pr
        JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
        WHERE pr.party_ledger_id = l.id
          AND pr.is_active = TRUE
        LIMIT 100
    ),
    last_payment_date = (
        SELECT MAX(pr.payment_date)
        FROM payment_references pr
        WHERE pr.party_ledger_id = l.id
          AND pr.is_active = TRUE
    ),
    total_invoices = (
        SELECT COUNT(*)
        FROM vouchers v
        WHERE v.party_ledger_id = l.id
          AND v.voucher_type IN ('SALES', 'Invoice')
          AND v.is_cancelled = FALSE
    ),
    total_receipts = (
        SELECT COUNT(DISTINCT pr.payment_voucher_id)
        FROM payment_references pr
        WHERE pr.party_ledger_id = l.id
          AND pr.is_active = TRUE
    ),
    payment_behavior = CASE
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) IS NULL THEN 'UNKNOWN'
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) <= 15 THEN 'EXCELLENT'
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) <= 30 THEN 'GOOD'
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) <= 45 THEN 'AVERAGE'
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) <= 60 THEN 'POOR'
        ELSE 'CRITICAL'
    END,
    payment_risk_score = CASE
        WHEN l.current_balance <= 0 THEN 0.00
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) IS NULL THEN 0.50
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) <= 30 THEN 0.10
        WHEN (
            SELECT AVG(pr.payment_date - iv.date)::INTEGER
            FROM payment_references pr
            JOIN vouchers iv ON pr.invoice_voucher_id = iv.id
            WHERE pr.party_ledger_id = l.id
              AND pr.is_active = TRUE
            LIMIT 100
        ) <= 60 THEN 0.30
        ELSE 0.70
    END,
    aging_computed_at = NOW()
WHERE l.parent_group IN ('Sundry Debtors', 'Sundry Creditors')
  AND l.active = TRUE;

-- 4) Calculate initial dashboard metrics
INSERT INTO dashboard_metrics (
    company_guid,
    total_receivable,
    receivable_0_30,
    receivable_31_60,
    receivable_61_90,
    receivable_90_plus,
    customer_count,
    overdue_customer_count,
    total_payable,
    payable_0_30,
    payable_31_60,
    payable_61_90,
    payable_90_plus,
    vendor_count,
    cash_balance,
    bank_balance,
    top_overdue_customers,
    critical_alerts,
    alert_count,
    calculated_at,
    data_as_of_date
)
SELECT 
    c.company_guid,
    COALESCE((
        SELECT SUM(l.current_balance)
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Sundry Debtors'
          AND l.current_balance > 0
    ), 0) AS total_receivable,
    COALESCE((
        SELECT SUM(v.amount_outstanding)
        FROM vouchers v
        WHERE v.company_guid = c.company_guid
          AND v.voucher_type IN ('SALES', 'Invoice')
          AND v.aging_bucket = '0-30'
          AND v.payment_status IN ('UNPAID', 'PARTIAL')
    ), 0) AS receivable_0_30,
    COALESCE((
        SELECT SUM(v.amount_outstanding)
        FROM vouchers v
        WHERE v.company_guid = c.company_guid
          AND v.voucher_type IN ('SALES', 'Invoice')
          AND v.aging_bucket = '31-60'
          AND v.payment_status IN ('UNPAID', 'PARTIAL')
    ), 0) AS receivable_31_60,
    COALESCE((
        SELECT SUM(v.amount_outstanding)
        FROM vouchers v
        WHERE v.company_guid = c.company_guid
          AND v.voucher_type IN ('SALES', 'Invoice')
          AND v.aging_bucket = '61-90'
          AND v.payment_status IN ('UNPAID', 'PARTIAL')
    ), 0) AS receivable_61_90,
    COALESCE((
        SELECT SUM(v.amount_outstanding)
        FROM vouchers v
        WHERE v.company_guid = c.company_guid
          AND v.voucher_type IN ('SALES', 'Invoice')
          AND v.aging_bucket = '90+'
          AND v.payment_status IN ('UNPAID', 'PARTIAL')
    ), 0) AS receivable_90_plus,
    COALESCE((
        SELECT COUNT(*)
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Sundry Debtors'
          AND l.current_balance > 0
    ), 0) AS customer_count,
    COALESCE((
        SELECT COUNT(*)
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Sundry Debtors'
          AND l.days_overdue > 0
    ), 0) AS overdue_customer_count,
    COALESCE((
        SELECT SUM(ABS(l.current_balance))
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Sundry Creditors'
          AND l.current_balance < 0
    ), 0) AS total_payable,
    0 AS payable_0_30,
    0 AS payable_31_60,
    0 AS payable_61_90,
    0 AS payable_90_plus,
    COALESCE((
        SELECT COUNT(*)
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Sundry Creditors'
          AND l.current_balance < 0
    ), 0) AS vendor_count,
    COALESCE((
        SELECT SUM(l.current_balance)
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Cash-in-Hand'
    ), 0) AS cash_balance,
    COALESCE((
        SELECT SUM(l.current_balance)
        FROM ledgers l
        WHERE l.company_guid = c.company_guid
          AND l.parent_group = 'Bank Accounts'
    ), 0) AS bank_balance,
    COALESCE((
        SELECT jsonb_agg(row_to_json(t))
        FROM (
            SELECT 
                l.name,
                l.current_balance AS outstanding,
                l.days_overdue,
                l.payment_behavior
            FROM ledgers l
            WHERE l.company_guid = c.company_guid
              AND l.parent_group = 'Sundry Debtors'
              AND l.current_balance > 0
            ORDER BY l.current_balance DESC
            LIMIT 5
        ) t
    ), '[]'::jsonb) AS top_overdue_customers,
    '[]'::jsonb AS critical_alerts,
    0 AS alert_count,
    NOW() AS calculated_at,
    CURRENT_DATE AS data_as_of_date
FROM companies c
WHERE c.active = TRUE
ON CONFLICT (company_guid, data_as_of_date) 
DO UPDATE SET
    total_receivable = EXCLUDED.total_receivable,
    receivable_0_30 = EXCLUDED.receivable_0_30,
    receivable_31_60 = EXCLUDED.receivable_31_60,
    receivable_61_90 = EXCLUDED.receivable_61_90,
    receivable_90_plus = EXCLUDED.receivable_90_plus,
    customer_count = EXCLUDED.customer_count,
    calculated_at = EXCLUDED.calculated_at;

-- Verification summary
DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '==========================================';
    RAISE NOTICE '✅ INITIAL POPULATION COMPLETED!';
    RAISE NOTICE '==========================================';
    RAISE NOTICE '';
    RAISE NOTICE 'Summary:';
    RAISE NOTICE '  payment_references: % rows', (SELECT COUNT(*) FROM payment_references);
    RAISE NOTICE '  vouchers with payment_status: % rows', (SELECT COUNT(*) FROM vouchers WHERE payment_status IS NOT NULL);
    RAISE NOTICE '  ledgers with aging data: % rows', (SELECT COUNT(*) FROM ledgers WHERE aging_computed_at IS NOT NULL);
    RAISE NOTICE '  dashboard_metrics: % rows', (SELECT COUNT(*) FROM dashboard_metrics);
    RAISE NOTICE '';
    RAISE NOTICE '==========================================';
END $$;

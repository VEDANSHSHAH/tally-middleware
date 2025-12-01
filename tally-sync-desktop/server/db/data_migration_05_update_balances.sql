-- =====================================================
-- DATA MIGRATION: UPDATE LEDGER CURRENT BALANCES FROM LINE ITEMS
-- =====================================================

DO $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    RAISE NOTICE '📊 Recalculating ledger balances from line items...';
    
    UPDATE ledgers l
    SET current_balance = COALESCE((
        SELECT SUM(debit_amount - credit_amount)
        FROM voucher_line_items li
        WHERE li.ledger_id = l.id
    ), 0)
    WHERE EXISTS (
        SELECT 1 FROM voucher_line_items WHERE ledger_id = l.id
    );
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE '✅ Updated balances for % ledgers', updated_count;
END $$;


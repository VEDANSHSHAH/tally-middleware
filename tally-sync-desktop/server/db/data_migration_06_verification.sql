-- =====================================================
-- DATA MIGRATION: VERIFICATION QUERIES AND INTEGRITY CHECKS
-- =====================================================

-- Show migration statistics
DO $$
DECLARE
    ledger_count INTEGER;
    voucher_count INTEGER;
    line_item_count INTEGER;
    old_vendor_count INTEGER := 0;
    old_customer_count INTEGER := 0;
    old_transaction_count INTEGER := 0;
BEGIN
    -- Count new records
    SELECT COUNT(*) INTO ledger_count FROM ledgers;
    SELECT COUNT(*) INTO voucher_count FROM vouchers;
    SELECT COUNT(*) INTO line_item_count FROM voucher_line_items;
    
    -- Count old records if tables exist
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vendors') THEN
        SELECT COUNT(*) INTO old_vendor_count FROM vendors;
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers') THEN
        SELECT COUNT(*) INTO old_customer_count FROM customers;
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') THEN
        SELECT COUNT(*) INTO old_transaction_count FROM transactions;
    END IF;
    
    RAISE NOTICE '';
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'MIGRATION SUMMARY';
    RAISE NOTICE '=====================================================';
    RAISE NOTICE '';
    RAISE NOTICE 'Old Structure:';
    RAISE NOTICE '  vendors: %', old_vendor_count;
    RAISE NOTICE '  customers: %', old_customer_count;
    RAISE NOTICE '  transactions: %', old_transaction_count;
    RAISE NOTICE '';
    RAISE NOTICE 'New Structure:';
    RAISE NOTICE '  ledgers: %', ledger_count;
    RAISE NOTICE '  vouchers: %', voucher_count;
    RAISE NOTICE '  voucher_line_items: %', line_item_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Expected: voucher_line_items should be ~2x transactions';
    RAISE NOTICE '(Each transaction becomes 1 voucher with 2 line items)';
    RAISE NOTICE '';
END $$;

-- Data integrity checks
DO $$
DECLARE
    unbalanced_count INTEGER;
    orphan_lines INTEGER;
    missing_ledgers INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE 'Running data integrity checks...';
    RAISE NOTICE '';
    
    -- Check 1: Unbalanced vouchers (debit != credit)
    SELECT COUNT(*) INTO unbalanced_count
    FROM (
        SELECT voucher_id
        FROM voucher_line_items
        GROUP BY voucher_id
        HAVING ABS(SUM(debit_amount) - SUM(credit_amount)) > 0.01
    ) unbalanced;
    
    IF unbalanced_count > 0 THEN
        RAISE WARNING 'Found % unbalanced vouchers (debit != credit)', unbalanced_count;
    ELSE
        RAISE NOTICE 'All vouchers are balanced';
    END IF;
    
    -- Check 2: Orphan line items (voucher_id doesn't exist)
    SELECT COUNT(*) INTO orphan_lines
    FROM voucher_line_items li
    WHERE NOT EXISTS (
        SELECT 1 FROM vouchers v WHERE v.id = li.voucher_id
    );
    
    IF orphan_lines > 0 THEN
        RAISE WARNING 'Found % orphan line items', orphan_lines;
    ELSE
        RAISE NOTICE 'No orphan line items found';
    END IF;
    
    -- Check 3: Missing ledger references
    SELECT COUNT(*) INTO missing_ledgers
    FROM voucher_line_items li
    WHERE NOT EXISTS (
        SELECT 1 FROM ledgers l WHERE l.id = li.ledger_id
    );
    
    IF missing_ledgers > 0 THEN
        RAISE WARNING 'Found % line items with invalid ledger_id', missing_ledgers;
    ELSE
        RAISE NOTICE 'All ledger references are valid';
    END IF;
    
    RAISE NOTICE '';
END $$;

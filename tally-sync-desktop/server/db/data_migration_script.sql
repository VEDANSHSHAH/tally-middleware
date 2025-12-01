-- =====================================================
-- DATA MIGRATION SCRIPT
-- =====================================================
-- Purpose: Migrate data from old flat structure to new normalized structure
-- Run AFTER: complete_schema_migration.sql
--
-- This script has been split into logical sections for maintainability:
--   - data_migration_01_safety_checks.sql
--   - data_migration_02_migrate_vendors.sql
--   - data_migration_03_migrate_customers.sql
--   - data_migration_04_migrate_transactions.sql
--   - data_migration_05_update_balances.sql
--   - data_migration_06_verification.sql
--   - data_migration_07_next_steps.sql
--
-- This main file combines all sections for execution via Node.js

-- =====================================================
-- 1. SAFETY CHECKS
-- =====================================================

-- Check if new tables exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ledgers') THEN
        RAISE EXCEPTION 'New tables not found! Run complete_schema_migration.sql first';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vouchers') THEN
        RAISE EXCEPTION 'Vouchers table not found! Run complete_schema_migration.sql first';
    END IF;
END $$;

-- =====================================================
-- 2. MIGRATE VENDORS → LEDGERS
-- =====================================================

DO $$
DECLARE
    migrated_count INTEGER := 0;
BEGIN
    RAISE NOTICE '📦 Starting vendors migration...';
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vendors') THEN
        INSERT INTO ledgers (
            guid,
            company_guid,
            name,
            parent_group,
            ledger_type,
            opening_balance,
            opening_balance_type,
            current_balance,
            current_balance_type,
            maintain_billwise,
            synced_at,
            created_at,
            updated_at
        )
        SELECT 
            COALESCE(guid, gen_random_uuid()::VARCHAR) as guid,
            COALESCE(company_guid, (SELECT company_guid FROM companies LIMIT 1)) as company_guid,
            name,
            'Sundry Creditors' as parent_group,
            'Vendor' as ledger_type,
            COALESCE(opening_balance, 0),
            CASE WHEN COALESCE(opening_balance, 0) >= 0 THEN 'Cr' ELSE 'Dr' END,
            COALESCE(current_balance, 0),
            CASE WHEN COALESCE(current_balance, 0) >= 0 THEN 'Cr' ELSE 'Dr' END,
            TRUE as maintain_billwise,
            synced_at,
            created_at,
            COALESCE(updated_at, created_at)
        FROM vendors
        WHERE COALESCE(company_guid, (SELECT company_guid FROM companies LIMIT 1)) IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM ledgers 
            WHERE ledgers.guid = vendors.guid 
            AND ledgers.company_guid = COALESCE(vendors.company_guid, (SELECT company_guid FROM companies LIMIT 1))
        );
        
        GET DIAGNOSTICS migrated_count = ROW_COUNT;
        RAISE NOTICE '✅ Migrated % vendors to ledgers', migrated_count;
    ELSE
        RAISE NOTICE '⚠️ vendors table not found, skipping...';
    END IF;
END $$;

-- =====================================================
-- 3. MIGRATE CUSTOMERS → LEDGERS
-- =====================================================

DO $$
DECLARE
    migrated_count INTEGER := 0;
BEGIN
    RAISE NOTICE '📦 Starting customers migration...';
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers') THEN
        INSERT INTO ledgers (
            guid,
            company_guid,
            name,
            parent_group,
            ledger_type,
            opening_balance,
            opening_balance_type,
            current_balance,
            current_balance_type,
            maintain_billwise,
            synced_at,
            created_at,
            updated_at
        )
        SELECT 
            COALESCE(guid, gen_random_uuid()::VARCHAR) as guid,
            COALESCE(company_guid, (SELECT company_guid FROM companies LIMIT 1)) as company_guid,
            name,
            'Sundry Debtors' as parent_group,
            'Customer' as ledger_type,
            COALESCE(opening_balance, 0),
            CASE WHEN COALESCE(opening_balance, 0) >= 0 THEN 'Dr' ELSE 'Cr' END,
            COALESCE(current_balance, 0),
            CASE WHEN COALESCE(current_balance, 0) >= 0 THEN 'Dr' ELSE 'Cr' END,
            TRUE as maintain_billwise,
            synced_at,
            created_at,
            COALESCE(updated_at, created_at)
        FROM customers
        WHERE COALESCE(company_guid, (SELECT company_guid FROM companies LIMIT 1)) IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM ledgers 
            WHERE ledgers.guid = customers.guid 
            AND ledgers.company_guid = COALESCE(customers.company_guid, (SELECT company_guid FROM companies LIMIT 1))
        );
        
        GET DIAGNOSTICS migrated_count = ROW_COUNT;
        RAISE NOTICE '✅ Migrated % customers to ledgers', migrated_count;
    ELSE
        RAISE NOTICE '⚠️ customers table not found, skipping...';
    END IF;
END $$;

-- =====================================================
-- 4. MIGRATE TRANSACTIONS → VOUCHERS + LINE ITEMS
-- =====================================================

DO $$
DECLARE
    migrated_vouchers INTEGER := 0;
    migrated_lines INTEGER := 0;
    voucher_rec RECORD;
    voucher_id_temp INTEGER;
    ledger_id_temp INTEGER;
    sales_ledger_id INTEGER;
    company_guid_temp VARCHAR(255);
BEGIN
    RAISE NOTICE '📦 Starting transactions migration...';
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') THEN
        
        -- Step 1: Create a temporary "Sales" ledger if it doesn't exist
        -- (for credit entries in double-entry)
        FOR company_guid_temp IN SELECT DISTINCT company_guid FROM transactions WHERE company_guid IS NOT NULL
        LOOP
            SELECT id INTO sales_ledger_id
            FROM ledgers
            WHERE name = 'Sales' 
            AND parent_group = 'Sales Accounts'
            AND company_guid = company_guid_temp
            LIMIT 1;
            
            IF sales_ledger_id IS NULL THEN
                INSERT INTO ledgers (
                    guid, company_guid, name, parent_group, 
                    ledger_type, is_revenue, current_balance
                )
                VALUES (
                    gen_random_uuid()::VARCHAR,
                    company_guid_temp,
                    'Sales',
                    'Sales Accounts',
                    'Income',
                    TRUE,
                    0
                )
                RETURNING id INTO sales_ledger_id;
                
                RAISE NOTICE '📝 Created default "Sales" ledger for company %', company_guid_temp;
            END IF;
        END LOOP;
        
        -- Step 2: Migrate to vouchers table
        FOR voucher_rec IN
            SELECT 
                t.id,
                t.guid,
                t.company_guid,
                t.voucher_number,
                t.voucher_type,
                t.date,
                t.party_name,
                t.amount,
                t.narration,
                t.item_name,
                t.synced_at,
                t.created_at,
                l.id as party_ledger_id
            FROM transactions t
            LEFT JOIN ledgers l ON 
                l.name = t.party_name 
                AND l.company_guid = COALESCE(t.company_guid, (SELECT company_guid FROM companies LIMIT 1))
            WHERE COALESCE(t.company_guid, (SELECT company_guid FROM companies LIMIT 1)) IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM vouchers 
                WHERE vouchers.voucher_guid = t.guid
                AND vouchers.company_guid = COALESCE(t.company_guid, (SELECT company_guid FROM companies LIMIT 1))
            )
            ORDER BY t.id
        LOOP
            -- Insert voucher header
            INSERT INTO vouchers (
                voucher_guid,
                company_guid,
                voucher_number,
                voucher_type,
                date,
                party_ledger_id,
                party_name,
                total_amount,
                gross_amount,
                narration,
                synced_at,
                created_at,
                updated_at
            )
            VALUES (
                voucher_rec.guid,
                COALESCE(voucher_rec.company_guid, (SELECT company_guid FROM companies LIMIT 1)),
                COALESCE(voucher_rec.voucher_number, 'MIGR-' || voucher_rec.id::TEXT),
                voucher_rec.voucher_type,
                voucher_rec.date,
                voucher_rec.party_ledger_id,
                voucher_rec.party_name,
                ABS(voucher_rec.amount),
                ABS(voucher_rec.amount),
                voucher_rec.narration,
                voucher_rec.synced_at,
                voucher_rec.created_at,
                COALESCE(voucher_rec.created_at, NOW())
            )
            RETURNING id INTO voucher_id_temp;
            
            migrated_vouchers := migrated_vouchers + 1;
            
            -- Get sales ledger for this company
            SELECT id INTO sales_ledger_id
            FROM ledgers
            WHERE name = 'Sales' 
            AND parent_group = 'Sales Accounts'
            AND company_guid = voucher_rec.company_guid
            LIMIT 1;
            
            -- Insert line items (double-entry)
            -- Line 1: Party Debit (Customer owes us)
            IF voucher_rec.party_ledger_id IS NOT NULL THEN
                INSERT INTO voucher_line_items (
                    line_guid,
                    voucher_id,
                    company_guid,
                    line_number,
                    ledger_id,
                    ledger_name,
                    debit_amount,
                    credit_amount,
                    amount
                )
                VALUES (
                    gen_random_uuid()::VARCHAR,
                    voucher_id_temp,
                    COALESCE(voucher_rec.company_guid, (SELECT company_guid FROM companies LIMIT 1)),
                    1,
                    voucher_rec.party_ledger_id,
                    voucher_rec.party_name,
                    ABS(voucher_rec.amount),
                    0,
                    ABS(voucher_rec.amount)
                );
                
                migrated_lines := migrated_lines + 1;
            END IF;
            
            -- Line 2: Sales Credit
            IF sales_ledger_id IS NOT NULL THEN
                INSERT INTO voucher_line_items (
                    line_guid,
                    voucher_id,
                    company_guid,
                    line_number,
                    ledger_id,
                    ledger_name,
                    debit_amount,
                    credit_amount,
                    amount,
                    item_name
                )
                VALUES (
                    gen_random_uuid()::VARCHAR,
                    voucher_id_temp,
                    COALESCE(voucher_rec.company_guid, (SELECT company_guid FROM companies LIMIT 1)),
                    2,
                    sales_ledger_id,
                    'Sales',
                    0,
                    ABS(voucher_rec.amount),
                    ABS(voucher_rec.amount),
                    voucher_rec.item_name
                );
                
                migrated_lines := migrated_lines + 1;
            END IF;
            
            -- Progress indicator every 100 vouchers
            IF migrated_vouchers % 100 = 0 THEN
                RAISE NOTICE '  Progress: % vouchers migrated...', migrated_vouchers;
            END IF;
        END LOOP;
        
        RAISE NOTICE '✅ Migrated % vouchers and % line items', migrated_vouchers, migrated_lines;
    ELSE
        RAISE NOTICE '⚠️ transactions table not found, skipping...';
    END IF;
END $$;

-- =====================================================
-- 5. UPDATE LEDGER CURRENT BALANCES FROM LINE ITEMS
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

-- =====================================================
-- 6. VERIFICATION QUERIES AND INTEGRITY CHECKS
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
    RAISE NOTICE '🔍 Running data integrity checks...';
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
        RAISE WARNING '⚠️ Found % unbalanced vouchers (debit ≠ credit)', unbalanced_count;
    ELSE
        RAISE NOTICE '✅ All vouchers are balanced';
    END IF;
    
    -- Check 2: Orphan line items (voucher_id doesn't exist)
    SELECT COUNT(*) INTO orphan_lines
    FROM voucher_line_items li
    WHERE NOT EXISTS (
        SELECT 1 FROM vouchers v WHERE v.id = li.voucher_id
    );
    
    IF orphan_lines > 0 THEN
        RAISE WARNING '⚠️ Found % orphan line items', orphan_lines;
    ELSE
        RAISE NOTICE '✅ No orphan line items found';
    END IF;
    
    -- Check 3: Missing ledger references
    SELECT COUNT(*) INTO missing_ledgers
    FROM voucher_line_items li
    WHERE NOT EXISTS (
        SELECT 1 FROM ledgers l WHERE l.id = li.ledger_id
    );
    
    IF missing_ledgers > 0 THEN
        RAISE WARNING '⚠️ Found % line items with invalid ledger_id', missing_ledgers;
    ELSE
        RAISE NOTICE '✅ All ledger references are valid';
    END IF;
    
    RAISE NOTICE '';
END $$;

-- =====================================================
-- 7. NEXT STEPS
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'MIGRATION COMPLETED!';
    RAISE NOTICE '=====================================================';
    RAISE NOTICE '';
    RAISE NOTICE 'Next Steps:';
    RAISE NOTICE '  1. ✅ Review the migration summary above';
    RAISE NOTICE '  2. ✅ Check data integrity warnings (if any)';
    RAISE NOTICE '  3. ⚠️  Test queries on new structure';
    RAISE NOTICE '  4. ⚠️  Update backend sync code';
    RAISE NOTICE '  5. ⚠️  Update API endpoints';
    RAISE NOTICE '  6. ⚠️  Test with Tally sync';
    RAISE NOTICE '';
    RAISE NOTICE 'After thorough testing:';
    RAISE NOTICE '  7. 🗑️  Drop old tables (ONLY after testing!):';
    RAISE NOTICE '      DROP TABLE transactions CASCADE;';
    RAISE NOTICE '      DROP TABLE vendors CASCADE;';
    RAISE NOTICE '      DROP TABLE customers CASCADE;';
    RAISE NOTICE '';
    RAISE NOTICE 'WARNING: DO NOT drop old tables until fully tested!';
    RAISE NOTICE '=====================================================';
END $$;

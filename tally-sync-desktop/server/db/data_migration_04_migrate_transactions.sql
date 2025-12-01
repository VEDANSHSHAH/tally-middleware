-- =====================================================
-- DATA MIGRATION: MIGRATE TRANSACTIONS → VOUCHERS + LINE ITEMS
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


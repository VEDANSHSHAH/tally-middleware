-- =====================================================
-- DATA MIGRATION: MIGRATE VENDORS -> LEDGERS
-- =====================================================

DO $$
DECLARE
    migrated_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Starting vendors migration...';
    
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
        RAISE NOTICE 'Migrated % vendors to ledgers', migrated_count;
    ELSE
        RAISE NOTICE 'vendors table not found, skipping...';
    END IF;
END $$;

-- =====================================================
-- DATA MIGRATION: SAFETY CHECKS
-- =====================================================
-- Purpose: Verify that required tables exist before migration

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


-- =====================================================
-- DATA MIGRATION: NEXT STEPS
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'MIGRATION COMPLETED!';
    RAISE NOTICE '=====================================================';
    RAISE NOTICE '';
    RAISE NOTICE 'Next Steps:';
    RAISE NOTICE '  1. Review the migration summary above';
    RAISE NOTICE '  2. Check data integrity warnings (if any)';
    RAISE NOTICE '  3. Test queries on new structure';
    RAISE NOTICE '  4. Update backend sync code';
    RAISE NOTICE '  5. Update API endpoints';
    RAISE NOTICE '  6. Test with Tally sync';
    RAISE NOTICE '';
    RAISE NOTICE 'After thorough testing:';
    RAISE NOTICE '  7. Drop old tables (ONLY after testing!):';
    RAISE NOTICE '      DROP TABLE transactions CASCADE;';
    RAISE NOTICE '      DROP TABLE vendors CASCADE;';
    RAISE NOTICE '      DROP TABLE customers CASCADE;';
    RAISE NOTICE '';
    RAISE NOTICE 'WARNING: DO NOT drop old tables until fully tested!';
    RAISE NOTICE '=====================================================';
END $$;

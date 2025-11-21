// Script to verify data isolation by company GUID
const { pool } = require('./server/db/postgres');
const fs = require('fs');
const path = require('path');

async function verifyDataIsolation() {
  try {
    console.log('🔍 Verifying Data Isolation by Company GUID...\n');
    
    // Load config to get current company
    const configPath = path.join(__dirname, 'config.json');
    let config = null;
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    if (!config || !config.company || !config.company.guid) {
      console.log('❌ No company selected in config.json\n');
      return;
    }
    
    const currentCompanyGuid = config.company.guid;
    const currentCompanyName = config.company.name;
    
    console.log(`📋 Current Company: ${currentCompanyName} (${currentCompanyGuid})\n`);
    
    // Check for data from other companies
    console.log('📊 Checking for data isolation issues...\n');
    
    // 1. Check vendors
    const vendorCheck = await pool.query(`
      SELECT 
        company_guid,
        COUNT(*) as count,
        COUNT(CASE WHEN company_guid IS NULL THEN 1 END) as null_count,
        COUNT(CASE WHEN company_guid != $1 THEN 1 END) as other_company_count
      FROM vendors
      GROUP BY company_guid
    `, [currentCompanyGuid]);
    
    console.log('📦 VENDORS:');
    console.log('─'.repeat(60));
    vendorCheck.rows.forEach(row => {
      if (row.company_guid === null) {
        console.log(`  ⚠️  NULL company_guid: ${row.count} vendors`);
      } else if (row.company_guid === currentCompanyGuid) {
        console.log(`  ✅ ${currentCompanyName}: ${row.count} vendors`);
      } else {
        console.log(`  ❌ Other company (${row.company_guid}): ${row.count} vendors`);
      }
    });
    console.log('');
    
    // 2. Check customers
    const customerCheck = await pool.query(`
      SELECT 
        company_guid,
        COUNT(*) as count,
        COUNT(CASE WHEN company_guid IS NULL THEN 1 END) as null_count,
        COUNT(CASE WHEN company_guid != $1 THEN 1 END) as other_company_count
      FROM customers
      GROUP BY company_guid
    `, [currentCompanyGuid]);
    
    console.log('👥 CUSTOMERS:');
    console.log('─'.repeat(60));
    customerCheck.rows.forEach(row => {
      if (row.company_guid === null) {
        console.log(`  ⚠️  NULL company_guid: ${row.count} customers`);
      } else if (row.company_guid === currentCompanyGuid) {
        console.log(`  ✅ ${currentCompanyName}: ${row.count} customers`);
      } else {
        console.log(`  ❌ Other company (${row.company_guid}): ${row.count} customers`);
      }
    });
    console.log('');
    
    // 3. Check transactions
    const transactionCheck = await pool.query(`
      SELECT 
        company_guid,
        COUNT(*) as count,
        COUNT(CASE WHEN company_guid IS NULL THEN 1 END) as null_count,
        COUNT(CASE WHEN company_guid != $1 THEN 1 END) as other_company_count
      FROM transactions
      GROUP BY company_guid
    `, [currentCompanyGuid]);
    
    console.log('💰 TRANSACTIONS:');
    console.log('─'.repeat(60));
    transactionCheck.rows.forEach(row => {
      if (row.company_guid === null) {
        console.log(`  ⚠️  NULL company_guid: ${row.count} transactions`);
      } else if (row.company_guid === currentCompanyGuid) {
        console.log(`  ✅ ${currentCompanyName}: ${row.count} transactions`);
      } else {
        console.log(`  ❌ Other company (${row.company_guid}): ${row.count} transactions`);
      }
    });
    console.log('');
    
    // 4. Check for duplicate GUIDs across companies (should not happen)
    console.log('🔍 Checking for duplicate GUIDs across companies...\n');
    
    const duplicateVendors = await pool.query(`
      SELECT guid, COUNT(DISTINCT company_guid) as company_count, 
             STRING_AGG(DISTINCT company_guid::TEXT, ', ') as company_guids
      FROM vendors
      WHERE company_guid IS NOT NULL
      GROUP BY guid
      HAVING COUNT(DISTINCT company_guid) > 1
    `);
    
    if (duplicateVendors.rows.length > 0) {
      console.log('  ❌ Found vendors with same GUID in multiple companies:');
      duplicateVendors.rows.forEach(row => {
        console.log(`     GUID: ${row.guid} → Companies: ${row.company_guids}`);
      });
    } else {
      console.log('  ✅ No duplicate vendor GUIDs across companies');
    }
    
    const duplicateCustomers = await pool.query(`
      SELECT guid, COUNT(DISTINCT company_guid) as company_count,
             STRING_AGG(DISTINCT company_guid::TEXT, ', ') as company_guids
      FROM customers
      WHERE company_guid IS NOT NULL
      GROUP BY guid
      HAVING COUNT(DISTINCT company_guid) > 1
    `);
    
    if (duplicateCustomers.rows.length > 0) {
      console.log('  ❌ Found customers with same GUID in multiple companies:');
      duplicateCustomers.rows.forEach(row => {
        console.log(`     GUID: ${row.guid} → Companies: ${row.company_guids}`);
      });
    } else {
      console.log('  ✅ No duplicate customer GUIDs across companies');
    }
    
    const duplicateTransactions = await pool.query(`
      SELECT guid, COUNT(DISTINCT company_guid) as company_count,
             STRING_AGG(DISTINCT company_guid::TEXT, ', ') as company_guids
      FROM transactions
      WHERE company_guid IS NOT NULL
      GROUP BY guid
      HAVING COUNT(DISTINCT company_guid) > 1
    `);
    
    if (duplicateTransactions.rows.length > 0) {
      console.log('  ❌ Found transactions with same GUID in multiple companies:');
      duplicateTransactions.rows.forEach(row => {
        console.log(`     GUID: ${row.guid} → Companies: ${row.company_guids}`);
      });
    } else {
      console.log('  ✅ No duplicate transaction GUIDs across companies');
    }
    
    console.log('\n✅ Verification completed!');
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

verifyDataIsolation();



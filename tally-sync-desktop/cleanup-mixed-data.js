// Script to clean up mixed data by company GUID
// This will help separate data that was synced before company filtering was added

const { pool } = require('./server/db/postgres');
const fs = require('fs');
const path = require('path');

async function cleanupMixedData() {
  try {
    console.log('🧹 Starting data cleanup...\n');
    
    // Load config to get current company
    const configPath = path.join(__dirname, 'config.json');
    let config = null;
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    if (!config || !config.company || !config.company.guid) {
      console.log('❌ No company selected in config.json');
      console.log('💡 Please run setup wizard first to select a company\n');
      return;
    }
    
    const currentCompanyGuid = config.company.guid;
    const currentCompanyName = config.company.name;
    
    console.log(`📋 Current company: ${currentCompanyName} (${currentCompanyGuid})\n`);
    
    // Show data distribution
    console.log('📊 Current data distribution:');
    const vendorStats = await pool.query(`
      SELECT company_guid, COUNT(*) as count 
      FROM vendors 
      GROUP BY company_guid
    `);
    console.log('Vendors:', vendorStats.rows);
    
    const customerStats = await pool.query(`
      SELECT company_guid, COUNT(*) as count 
      FROM customers 
      GROUP BY company_guid
    `);
    console.log('Customers:', customerStats.rows);
    
    const transactionStats = await pool.query(`
      SELECT company_guid, COUNT(*) as count 
      FROM transactions 
      GROUP BY company_guid
    `);
    console.log('Transactions:', transactionStats.rows);
    console.log('\n');
    
    // Ask user what to do
    console.log('⚠️  WARNING: This will delete data!');
    console.log('Options:');
    console.log('1. Delete all NULL company_guid data (old data)');
    console.log('2. Delete all data NOT matching current company');
    console.log('3. Show data distribution only (no changes)');
    console.log('\n');
    console.log('💡 To use this script, edit it and uncomment the cleanup section you want.\n');
    
    // Option 1: Delete NULL company_guid (old data)
    // Uncomment below to enable:
    /*
    console.log('🗑️  Deleting NULL company_guid data...');
    const nullVendors = await pool.query('DELETE FROM vendors WHERE company_guid IS NULL RETURNING id');
    const nullCustomers = await pool.query('DELETE FROM customers WHERE company_guid IS NULL RETURNING id');
    const nullTransactions = await pool.query('DELETE FROM transactions WHERE company_guid IS NULL RETURNING id');
    console.log(`✅ Deleted: ${nullVendors.rowCount} vendors, ${nullCustomers.rowCount} customers, ${nullTransactions.rowCount} transactions`);
    */
    
    // Option 2: Delete all data NOT matching current company
    // Uncomment below to enable:
    /*
    console.log(`🗑️  Deleting all data NOT matching ${currentCompanyName}...`);
    const otherVendors = await pool.query('DELETE FROM vendors WHERE company_guid != $1 OR company_guid IS NULL RETURNING id', [currentCompanyGuid]);
    const otherCustomers = await pool.query('DELETE FROM customers WHERE company_guid != $1 OR company_guid IS NULL RETURNING id', [currentCompanyGuid]);
    const otherTransactions = await pool.query('DELETE FROM transactions WHERE company_guid != $1 OR company_guid IS NULL RETURNING id', [currentCompanyGuid]);
    console.log(`✅ Deleted: ${otherVendors.rowCount} vendors, ${otherCustomers.rowCount} customers, ${otherTransactions.rowCount} transactions`);
    */
    
    console.log('✅ Cleanup script completed (no changes made - edit script to enable cleanup)');
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

cleanupMixedData();



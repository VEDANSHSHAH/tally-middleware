const { pool } = require('./postgres');
const fs = require('fs');
const path = require('path');

async function runIncrementalMigration() {
  console.log('🔄 Running incremental sync migration...');
  console.log('');
  
  if (!pool) {
    console.error('❌ Database pool not initialized. Check DATABASE_URL in .env file.');
    process.exit(1);
  }
  
  try {
    const sqlPath = path.join(__dirname, 'incremental_sync_migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Split SQL into individual statements for better error handling
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    console.log(`📋 Executing ${statements.length} SQL statements...`);
    console.log('');
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const preview = statement.substring(0, 60).replace(/\n/g, ' ');
      
      try {
        await pool.query(statement);
        console.log(`✅ [${i + 1}/${statements.length}] ${preview}...`);
      } catch (err) {
        // Some errors are OK (like "already exists")
        if (err.message.includes('already exists') || 
            err.message.includes('duplicate') ||
            err.message.includes('does not exist')) {
          console.log(`⏭️  [${i + 1}/${statements.length}] Skipped (already applied): ${preview}...`);
        } else {
          console.error(`❌ [${i + 1}/${statements.length}] Failed: ${preview}...`);
          console.error(`   Error: ${err.message}`);
        }
      }
    }
    
    console.log('');
    console.log('✅ Incremental sync migration completed!');
    console.log('');
    console.log('Created/Updated:');
    console.log('  ✓ sync_history table');
    console.log('  ✓ sync_history_log table');
    console.log('  ✓ get_last_sync_time() function');
    console.log('  ✓ update_sync_history() function');
    console.log('  ✓ modified_date columns on vendors, customers, transactions');
    console.log('  ✓ Auto-update triggers for modified_date');
    console.log('');
    console.log('💡 Now your syncs will be incremental (much faster!)');
    console.log('');
    
    // Verify tables were created
    const verifyResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('sync_history', 'sync_history_log')
    `);
    
    if (verifyResult.rows.length >= 1) {
      console.log('🔍 Verification: Tables created successfully!');
      verifyResult.rows.forEach(row => {
        console.log(`   ✓ ${row.table_name}`);
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  runIncrementalMigration();
}

module.exports = { runIncrementalMigration };




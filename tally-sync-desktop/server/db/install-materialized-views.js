const { pool } = require('./postgres');
const fs = require('fs');
const path = require('path');

async function installMaterializedViews() {
  console.log('📊 Installing materialized views...');
  
  if (!pool) {
    console.warn('⚠️ Database pool not initialized. Skipping materialized views.');
    return { success: false, error: 'No database connection' };
  }
  
  try {
    // Read SQL file
    const sqlPath = path.join(__dirname, 'materialized_views.sql');
    
    if (!fs.existsSync(sqlPath)) {
      console.warn('⚠️ materialized_views.sql not found. Skipping.');
      return { success: false, error: 'SQL file not found' };
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Split into statements and execute
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    
    for (const statement of statements) {
      try {
        await pool.query(statement);
        successCount++;
      } catch (err) {
        // Ignore "already exists" or "does not exist" errors
        if (err.message.includes('already exists') || 
            err.message.includes('does not exist') ||
            err.message.includes('duplicate')) {
          skipCount++;
        } else {
          errorCount++;
          // Only log non-trivial errors
          if (!err.message.includes('relation') && !err.message.includes('index')) {
            console.warn('⚠️ Statement error:', err.message.substring(0, 100));
          }
        }
      }
    }
    
    console.log('✅ Materialized views installation completed!');
    console.log(`   ✓ ${successCount} statements executed`);
    if (skipCount > 0) console.log(`   ⏭️ ${skipCount} statements skipped (already exist)`);
    if (errorCount > 0) console.log(`   ⚠️ ${errorCount} statements had errors`);
    console.log('');
    console.log('Created views:');
    console.log('  - mv_vendor_aging_summary');
    console.log('  - mv_customer_aging_summary');
    console.log('  - mv_transaction_summary');
    console.log('  - mv_vendor_scores_summary');
    
    return { success: true, successCount, skipCount, errorCount };
  } catch (error) {
    console.error('❌ Error installing materialized views:', error.message);
    return { success: false, error: error.message };
  }
}

// Check if materialized views exist
async function checkMaterializedViewsExist() {
  if (!pool) return false;
  
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM pg_matviews
      WHERE matviewname IN (
        'mv_vendor_aging_summary',
        'mv_customer_aging_summary',
        'mv_transaction_summary',
        'mv_vendor_scores_summary'
      )
    `);
    return parseInt(result.rows[0]?.count || 0) >= 4;
  } catch (error) {
    return false;
  }
}

// Refresh all materialized views
async function refreshAllViews() {
  if (!pool) {
    console.warn('⚠️ Cannot refresh views - no database connection');
    return { success: false, error: 'No database connection' };
  }
  
  const startTime = Date.now();
  
  try {
    // Check if views exist first
    const viewsExist = await checkMaterializedViewsExist();
    if (!viewsExist) {
      console.log('⚠️ Materialized views not found, installing...');
      await installMaterializedViews();
    }
    
    // Refresh using the database function
    const result = await pool.query('SELECT refresh_all_materialized_views() as result');
    const duration = Date.now() - startTime;
    
    console.log(`✅ Materialized views refreshed in ${duration}ms`);
    return { success: true, duration, message: result.rows[0]?.result };
  } catch (error) {
    // If function doesn't exist, try direct refresh
    if (error.message.includes('does not exist')) {
      console.log('⚠️ Refresh function not found, using direct refresh...');
      try {
        await pool.query('REFRESH MATERIALIZED VIEW mv_vendor_aging_summary');
        await pool.query('REFRESH MATERIALIZED VIEW mv_customer_aging_summary');
        await pool.query('REFRESH MATERIALIZED VIEW mv_transaction_summary');
        await pool.query('REFRESH MATERIALIZED VIEW mv_vendor_scores_summary');
        
        const duration = Date.now() - startTime;
        console.log(`✅ Materialized views refreshed in ${duration}ms (direct)`);
        return { success: true, duration };
      } catch (innerError) {
        // Views don't exist, install them
        if (innerError.message.includes('does not exist')) {
          console.log('⚠️ Views not found, installing...');
          return await installMaterializedViews();
        }
        throw innerError;
      }
    }
    
    console.error('❌ Error refreshing materialized views:', error.message);
    return { success: false, error: error.message };
  }
}

// Run if called directly
if (require.main === module) {
  installMaterializedViews().then(result => {
    if (result.success) {
      console.log('\n💡 Views will be automatically refreshed after each sync');
      process.exit(0);
    } else {
      process.exit(1);
    }
  });
}

module.exports = { 
  installMaterializedViews, 
  refreshAllViews, 
  checkMaterializedViewsExist 
};




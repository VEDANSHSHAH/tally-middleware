const { pool } = require('./postgres');

async function testTables() {
  try {
    console.log('🔍 Checking database tables...\n');
    
    // Check all tables
    const tables = [
      'vendors',
      'customers', 
      'transactions',
      'payment_cycles',
      'outstanding_aging',
      'vendor_scores',
      'payment_anomalies',
      'ai_insights',
      'cashflow_predictions'
    ];
    
    for (const table of tables) {
      const result = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = '${table}'
        );
      `);
      
      const exists = result.rows[0].exists;
      console.log(`${exists ? '✅' : '❌'} ${table}`);
    }
    
    console.log('\n🎉 Database setup complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testTables();
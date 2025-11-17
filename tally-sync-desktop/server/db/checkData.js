const { pool } = require('./postgres');

async function checkData() {
  try {
    console.log('🔍 Checking data in analytics tables...\n');
    
    // Check payment_cycles
    const cycles = await pool.query('SELECT COUNT(*) FROM payment_cycles');
    console.log(`📊 Payment Cycles: ${cycles.rows[0].count} records`);
    
    // Check outstanding_aging
    const aging = await pool.query('SELECT COUNT(*) FROM outstanding_aging');
    console.log(`📊 Outstanding Aging: ${aging.rows[0].count} records`);
    
    // Check vendor_scores
    const scores = await pool.query('SELECT COUNT(*) FROM vendor_scores');
    console.log(`📊 Vendor Scores: ${scores.rows[0].count} records`);
    
    // Check ai_insights
    const insights = await pool.query('SELECT COUNT(*) FROM ai_insights');
    console.log(`📊 AI Insights: ${insights.rows[0].count} records`);
    
    // Check existing data
    console.log('\n📋 Existing Data:');
    const vendors = await pool.query('SELECT COUNT(*) FROM vendors');
    console.log(`   Vendors: ${vendors.rows[0].count}`);
    
    const customers = await pool.query('SELECT COUNT(*) FROM customers');
    console.log(`   Customers: ${customers.rows[0].count}`);
    
    const transactions = await pool.query('SELECT COUNT(*) FROM transactions');
    console.log(`   Transactions: ${transactions.rows[0].count}`);
    
    // Show vendor scores if any
    if (parseInt(scores.rows[0].count) > 0) {
      console.log('\n🏆 Vendor Scores:');
      const scoreData = await pool.query(`
        SELECT 
          vs.overall_score,
          vs.risk_level,
          v.name
        FROM vendor_scores vs
        JOIN vendors v ON v.id = vs.vendor_id
        ORDER BY vs.overall_score DESC
      `);
      
      scoreData.rows.forEach(row => {
        console.log(`   ${row.name}: Score ${row.overall_score}/100 (Risk: ${row.risk_level})`);
      });
    }
    
    console.log('\n✅ Data check complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkData();
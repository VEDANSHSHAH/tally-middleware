const { pool } = require('./postgres');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');
    
    const sql = fs.readFileSync(
      path.join(__dirname, 'migrations.sql'),
      'utf8'
    );
    
    await pool.query(sql);
    
    console.log('✅ Migrations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
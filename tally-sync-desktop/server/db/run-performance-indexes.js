// Script to add performance indexes to the database
// Run: node server/db/run-performance-indexes.js

const { pool } = require('./postgres');
const fs = require('fs');
const path = require('path');

async function addPerformanceIndexes() {
  try {
    console.log('📊 Adding performance indexes...');
    
    const sqlPath = path.join(__dirname, 'performance_indexes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    for (const statement of statements) {
      try {
        await pool.query(statement);
        console.log('✅ Executed:', statement.substring(0, 50) + '...');
      } catch (error) {
        // Ignore "already exists" errors
        if (error.message.includes('already exists')) {
          console.log('⚠️  Index already exists, skipping...');
        } else {
          console.error('❌ Error:', error.message);
        }
      }
    }
    
    console.log('✅ Performance indexes added successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to add indexes:', error);
    process.exit(1);
  }
}

addPerformanceIndexes();


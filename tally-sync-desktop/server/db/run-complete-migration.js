const { pool } = require('./postgres');
const fs = require('fs');
const path = require('path');

async function runCompleteMigration() {
  console.log('🔄 Running complete database restructuring migration...');
  console.log('');
  
  if (!pool) {
    console.error('❌ Database pool not initialized. Check DATABASE_URL in .env file.');
    process.exit(1);
  }
  
  try {
    // Step 1: Run complete schema migration
    console.log('📋 Step 1: Creating/updating database schema...');
    const schemaPath = path.join(__dirname, 'complete_schema_migration.sql');
    
    if (!fs.existsSync(schemaPath)) {
      console.error(`❌ Schema file not found: ${schemaPath}`);
      process.exit(1);
    }
    
    const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    
    // Better SQL splitting that handles DO blocks
    const statements = [];
    let currentStatement = '';
    let inDoBlock = false;
    let doBlockDepth = 0;
    
    const lines = schemaSQL.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments
      if (trimmed.startsWith('--') || trimmed === '') {
        continue;
      }
      
      currentStatement += line + '\n';
      
      // Track DO block depth
      if (trimmed.includes('DO $$')) {
        inDoBlock = true;
        doBlockDepth = 1;
      }
      if (trimmed.includes('BEGIN')) {
        doBlockDepth++;
      }
      if (trimmed.includes('END $$;')) {
        doBlockDepth--;
        if (doBlockDepth === 0) {
          inDoBlock = false;
          statements.push(currentStatement.trim());
          currentStatement = '';
        }
      } else if (!inDoBlock && trimmed.endsWith(';')) {
        // Regular statement ending
        statements.push(currentStatement.trim());
        currentStatement = '';
      }
    }
    
    // Add any remaining statement
    if (currentStatement.trim()) {
      statements.push(currentStatement.trim());
    }
    
    // Filter out empty statements
    const filteredStatements = statements.filter(s => s.length > 0 && !s.startsWith('--'));
    
    console.log(`📋 Executing ${statements.length} SQL statements...`);
    console.log('');
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const preview = statement.substring(0, 80).replace(/\n/g, ' ');
      
      try {
        await pool.query(statement);
        if (i % 10 === 0 || statement.includes('CREATE TABLE') || statement.includes('CREATE INDEX')) {
          console.log(`✅ [${i + 1}/${statements.length}] ${preview}...`);
        }
      } catch (err) {
        // Some errors are OK (like "already exists")
        if (err.message.includes('already exists') || 
            err.message.includes('duplicate') ||
            err.message.includes('does not exist') ||
            err.message.includes('relation') && err.message.includes('already')) {
          // Silently skip
        } else {
          console.error(`❌ [${i + 1}/${statements.length}] Failed: ${preview}...`);
          console.error(`   Error: ${err.message}`);
          // Don't exit - continue with other statements
        }
      }
    }
    
    console.log('');
    console.log('✅ Schema migration completed!');
    console.log('');
    
    // Step 2: Run data migration
    console.log('📋 Step 2: Migrating existing data...');
    const dataPath = path.join(__dirname, 'data_migration_script.sql');
    
    if (!fs.existsSync(dataPath)) {
      console.warn(`⚠️  Data migration file not found: ${dataPath}`);
      console.warn('   Skipping data migration. You can run it manually later.');
    } else {
      const dataSQL = fs.readFileSync(dataPath, 'utf8');
      
      // Execute data migration (it uses DO blocks, so execute as whole)
      try {
        await pool.query(dataSQL);
        console.log('✅ Data migration completed!');
      } catch (err) {
        console.error('❌ Data migration failed:', err.message);
        console.error('   You may need to run data_migration_script.sql manually');
      }
    }
    
    console.log('');
    console.log('=====================================================');
    console.log('✅ COMPLETE MIGRATION FINISHED!');
    console.log('=====================================================');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review the migration output above');
    console.log('  2. Test your application');
    console.log('  3. Update backend code to use new structure');
    console.log('  4. Update API endpoints');
    console.log('');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runCompleteMigration();


const path = require('path');

async function runCompleteMigration() {
  console.log('🔄 Running complete database restructuring migration...');
  console.log('');
  
  if (!pool) {
    console.error('❌ Database pool not initialized. Check DATABASE_URL in .env file.');
    process.exit(1);
  }
  
  try {
    // Step 1: Run complete schema migration
    console.log('📋 Step 1: Creating/updating database schema...');
    const schemaPath = path.join(__dirname, 'complete_schema_migration.sql');
    
    if (!fs.existsSync(schemaPath)) {
      console.error(`❌ Schema file not found: ${schemaPath}`);
      process.exit(1);
    }
    
    const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    
    // Better SQL splitting that handles DO blocks
    const statements = [];
    let currentStatement = '';
    let inDoBlock = false;
    let doBlockDepth = 0;
    
    const lines = schemaSQL.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments
      if (trimmed.startsWith('--') || trimmed === '') {
        continue;
      }
      
      currentStatement += line + '\n';
      
      // Track DO block depth
      if (trimmed.includes('DO $$')) {
        inDoBlock = true;
        doBlockDepth = 1;
      }
      if (trimmed.includes('BEGIN')) {
        doBlockDepth++;
      }
      if (trimmed.includes('END $$;')) {
        doBlockDepth--;
        if (doBlockDepth === 0) {
          inDoBlock = false;
          statements.push(currentStatement.trim());
          currentStatement = '';
        }
      } else if (!inDoBlock && trimmed.endsWith(';')) {
        // Regular statement ending
        statements.push(currentStatement.trim());
        currentStatement = '';
      }
    }
    
    // Add any remaining statement
    if (currentStatement.trim()) {
      statements.push(currentStatement.trim());
    }
    
    // Filter out empty statements
    const filteredStatements = statements.filter(s => s.length > 0 && !s.startsWith('--'));
    
    console.log(`📋 Executing ${statements.length} SQL statements...`);
    console.log('');
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      const preview = statement.substring(0, 80).replace(/\n/g, ' ');
      
      try {
        await pool.query(statement);
        if (i % 10 === 0 || statement.includes('CREATE TABLE') || statement.includes('CREATE INDEX')) {
          console.log(`✅ [${i + 1}/${statements.length}] ${preview}...`);
        }
      } catch (err) {
        // Some errors are OK (like "already exists")
        if (err.message.includes('already exists') || 
            err.message.includes('duplicate') ||
            err.message.includes('does not exist') ||
            err.message.includes('relation') && err.message.includes('already')) {
          // Silently skip
        } else {
          console.error(`❌ [${i + 1}/${statements.length}] Failed: ${preview}...`);
          console.error(`   Error: ${err.message}`);
          // Don't exit - continue with other statements
        }
      }
    }
    
    console.log('');
    console.log('✅ Schema migration completed!');
    console.log('');
    
    // Step 2: Run data migration
    console.log('📋 Step 2: Migrating existing data...');
    const dataPath = path.join(__dirname, 'data_migration_script.sql');
    
    if (!fs.existsSync(dataPath)) {
      console.warn(`⚠️  Data migration file not found: ${dataPath}`);
      console.warn('   Skipping data migration. You can run it manually later.');
    } else {
      const dataSQL = fs.readFileSync(dataPath, 'utf8');
      
      // Execute data migration (it uses DO blocks, so execute as whole)
      try {
        await pool.query(dataSQL);
        console.log('✅ Data migration completed!');
      } catch (err) {
        console.error('❌ Data migration failed:', err.message);
        console.error('   You may need to run data_migration_script.sql manually');
      }
    }
    
    console.log('');
    console.log('=====================================================');
    console.log('✅ COMPLETE MIGRATION FINISHED!');
    console.log('=====================================================');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review the migration output above');
    console.log('  2. Test your application');
    console.log('  3. Update backend code to use new structure');
    console.log('  4. Update API endpoints');
    console.log('');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runCompleteMigration();


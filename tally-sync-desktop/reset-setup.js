// Quick script to reset setup and show setup wizard
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');

console.log('🔄 Resetting company setup...\n');

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('📋 Current company:', config.company?.name || 'Unknown');
    console.log('🆔 Current GUID:', config.company?.guid || 'None');
    console.log('\n🗑️  Deleting config.json...');
    
    fs.unlinkSync(configPath);
    console.log('✅ config.json deleted successfully!');
    console.log('\n💡 Next steps:');
    console.log('   1. Restart your Electron app');
    console.log('   2. Setup wizard will appear automatically');
    console.log('   3. You can select a different company or re-enter details\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
} else {
  console.log('ℹ️  config.json does not exist');
  console.log('💡 Setup wizard should show when you launch the app\n');
}



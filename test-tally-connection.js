// Quick test to check if Tally is accessible
const axios = require('axios');

async function testTallyConnection() {
  const tallyUrl = 'http://localhost:9000';
  
  console.log('🧪 Testing Tally Connection...\n');
  console.log(`📍 Testing: ${tallyUrl}\n`);
  
  // Simple test request
  const simpleRequest = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Data</TYPE>
        <ID>TestConnection</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  try {
    console.log('📡 Sending test request to Tally...');
    const response = await axios.post(tallyUrl, simpleRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 3000  // Short timeout for quick test
    });
    
    console.log('✅ Tally is responding!');
    console.log('📄 Response:', response.data.substring(0, 200));
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Connection refused!');
      console.error('\n💡 Tally is NOT running or NOT accessible on port 9000.');
      console.error('\n📋 Please check:');
      console.error('   1. Is Tally application running?');
      console.error('   2. Is a company open in Tally?');
      console.error('   3. Is ODBC enabled in Tally?');
      console.error('      → Press F12 in Tally');
      console.error('      → Go to "Advanced Configuration"');
      console.error('      → Enable "ODBC Server"');
      console.error('      → Set port to 9000');
      console.error('   4. Is port 9000 blocked by firewall?');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('❌ Request timed out!');
      console.error('\n💡 Tally is not responding.');
      console.error('\n📋 Please check:');
      console.error('   1. Is Tally application running?');
      console.error('   2. Is a company open in Tally?');
      console.error('   3. Is ODBC enabled? (F12 → Advanced Configuration)');
    } else {
      console.error('❌ Error:', error.message);
    }
    return false;
  }
}

testTallyConnection();



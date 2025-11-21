const axios = require('axios');

async function testGuidFetch() {
  const tallyUrl = 'http://localhost:9000';
  
  console.log('🧪 Testing GUID fetch from Tally...\n');
  
  // Method 1: Company Info Request
  const xml1 = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Data</TYPE>
        <ID>CompanyInfo</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <REPORT NAME="CompanyGUID">
                <FORMS>Form1</FORMS>
              </REPORT>
              <FORM NAME="Form1">
                <PARTS>Part1</PARTS>
              </FORM>
              <PART NAME="Part1">
                <LINES>Line1</LINES>
              </PART>
              <LINE NAME="Line1">
                <FIELDS>Field1, Field2</FIELDS>
              </LINE>
              <FIELD NAME="Field1">
                <SET>##SVCURRENTCOMPANY</SET>
              </FIELD>
              <FIELD NAME="Field2">
                <SET>##SVCURRENTCOMPANYGUID</SET>
              </FIELD>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  try {
    console.log('📡 Method 1: Direct GUID request...');
    const response1 = await axios.post(tallyUrl, xml1, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 5000
    });
    
    console.log('✅ Response received!\n');
    console.log('📄 RAW RESPONSE:');
    console.log('─'.repeat(80));
    console.log(response1.data);
    console.log('─'.repeat(80));
    console.log('\n');
    
    // Try to extract GUID
    const data = response1.data;
    
    // Pattern 1: Look for GUID tag
    const guidMatch1 = data.match(/<GUID[^>]*>([^<]+)<\/GUID>/i);
    const guidMatch2 = data.match(/##SVCURRENTCOMPANYGUID[^>]*>([^<]+)</i);
    const guidMatch3 = data.match(/GUID.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    
    // Pattern 2: Look for Company Name
    const nameMatch1 = data.match(/<NAME[^>]*>([^<]+)<\/NAME>/i);
    const nameMatch2 = data.match(/##SVCURRENTCOMPANY[^>]*>([^<]+)</i);
    const nameMatch3 = data.match(/<COMPANY[^>]*>([^<]+)<\/COMPANY>/i);
    
    console.log('🔍 EXTRACTION RESULTS:');
    console.log('─'.repeat(80));
    
    if (guidMatch1) {
      console.log('✅ GUID (Pattern 1):', guidMatch1[1]);
    }
    if (guidMatch2) {
      console.log('✅ GUID (Pattern 2):', guidMatch2[1]);
    }
    if (guidMatch3) {
      console.log('✅ GUID (Pattern 3):', guidMatch3[1]);
    }
    
    if (nameMatch1) {
      console.log('✅ Company Name (Pattern 1):', nameMatch1[1]);
    }
    if (nameMatch2) {
      console.log('✅ Company Name (Pattern 2):', nameMatch2[1]);
    }
    if (nameMatch3) {
      console.log('✅ Company Name (Pattern 3):', nameMatch3[1]);
    }
    
    if (!guidMatch1 && !guidMatch2 && !guidMatch3) {
      console.log('❌ Could not extract GUID from response');
      console.log('⚠️ Let\'s try alternate method...\n');
      
      // Method 2: Company Details
      const xml2 = `
        <ENVELOPE>
          <HEADER>
            <VERSION>1</VERSION>
            <TALLYREQUEST>Export</TALLYREQUEST>
            <TYPE>Data</TYPE>
            <ID>CompanyDetails</ID>
          </HEADER>
          <BODY>
            <DESC>
              <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              </STATICVARIABLES>
              <TDL>
                <TDLMESSAGE>
                  <COLLECTION NAME="CompanyCollection">
                    <TYPE>Company</TYPE>
                    <FETCH>GUID, Name, MailingName</FETCH>
                  </COLLECTION>
                </TDLMESSAGE>
              </TDL>
            </DESC>
          </BODY>
        </ENVELOPE>
      `;
      
      console.log('📡 Method 2: Company Collection...');
      const response2 = await axios.post(tallyUrl, xml2, {
        headers: { 'Content-Type': 'application/xml' },
        timeout: 5000
      });
      
      console.log('✅ Response received!\n');
      console.log('📄 RAW RESPONSE:');
      console.log('─'.repeat(80));
      console.log(response2.data);
      console.log('─'.repeat(80));
    }
    
    console.log('\n✅ Test completed!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('\n⚠️ Make sure:');
    console.error('   1. Tally is running');
    console.error('   2. ODBC is enabled (F12 → Advanced Configuration)');
    console.error('   3. Port 9000 is accessible');
  }
}

testGuidFetch();




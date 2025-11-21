// Test script to see what Tally returns for current company
const axios = require('axios');

async function testCurrentCompany() {
  const tallyUrl = 'http://localhost:9000';
  
  console.log('🧪 Testing Current Company Detection...\n');
  console.log('⚠️ Make sure "Efgh" is open in Tally!\n');
  
  // Method 1: Current Company Request
  const xml1 = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Data</TYPE>
        <ID>CurrentCompanyInfo</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <REPORT NAME="CurrentCompany">
                <FORMS>CompanyForm</FORMS>
              </REPORT>
              <FORM NAME="CompanyForm">
                <PARTS>CompanyPart</PARTS>
              </FORM>
              <PART NAME="CompanyPart">
                <LINES>CompanyLine</LINES>
              </PART>
              <LINE NAME="CompanyLine">
                <FIELDS>CompanyName, CompanyGUID</FIELDS>
              </LINE>
              <FIELD NAME="CompanyName">
                <SET>##SVCURRENTCOMPANY</SET>
              </FIELD>
              <FIELD NAME="CompanyGUID">
                <SET>##SVCURRENTCOMPANYGUID</SET>
              </FIELD>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  // Method 2: Simple Company Info
  const xml2 = `
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
            <SVCURRENTCOMPANY>##SVCURRENTCOMPANY</SVCURRENTCOMPANY>
          </STATICVARIABLES>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  // Method 3: Get Company Object directly
  const xml3 = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Object</TYPE>
        <ID>CurrentCompany</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            <SVFROMDATE TYPE="DATE">20240101</SVFROMDATE>
            <SVTODATE TYPE="DATE">20241231</SVTODATE>
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <OBJECT NAME="CurrentCompany" TYPE="Company">
                <FETCH>NAME, GUID, REMOTECMPID</FETCH>
              </OBJECT>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  try {
    console.log('📡 Method 1: Current Company Report...');
    const response1 = await axios.post(tallyUrl, xml1, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 5000
    });
    console.log('✅ Response received!\n');
    console.log('📄 FULL RESPONSE:');
    console.log('─'.repeat(80));
    console.log(response1.data);
    console.log('─'.repeat(80));
    console.log('\n');
    
    // Try to extract
    const guidMatch = response1.data.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi);
    const nameMatch = response1.data.match(/<COMPANYNAME[^>]*>([^<]+)<\/COMPANYNAME>/i) ||
                      response1.data.match(/<FIELD1[^>]*>([^<]+)<\/FIELD1>/i);
    
    console.log('🔍 EXTRACTION:');
    if (guidMatch) {
      console.log('✅ GUIDs found:', guidMatch);
    }
    if (nameMatch) {
      console.log('✅ Name found:', nameMatch[1]);
    }
    console.log('\n');
    
  } catch (error) {
    console.error('❌ Method 1 failed:', error.message);
  }
  
  try {
    console.log('📡 Method 2: Simple Company Info...');
    const response2 = await axios.post(tallyUrl, xml2, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 5000
    });
    console.log('✅ Response received!\n');
    console.log('📄 FULL RESPONSE:');
    console.log('─'.repeat(80));
    console.log(response2.data);
    console.log('─'.repeat(80));
    console.log('\n');
  } catch (error) {
    console.error('❌ Method 2 failed:', error.message);
  }
  
  try {
    console.log('📡 Method 3: Company Object...');
    const response3 = await axios.post(tallyUrl, xml3, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 5000
    });
    console.log('✅ Response received!\n');
    console.log('📄 FULL RESPONSE:');
    console.log('─'.repeat(80));
    console.log(response3.data);
    console.log('─'.repeat(80));
    console.log('\n');
  } catch (error) {
    console.error('❌ Method 3 failed:', error.message);
  }
  
  console.log('\n✅ Test completed!');
  console.log('💡 Check the responses above to see what Tally is returning.');
}

testCurrentCompany();



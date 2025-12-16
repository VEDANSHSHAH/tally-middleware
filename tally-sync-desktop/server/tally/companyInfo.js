const axios = require('axios');
const xml2js = require('xml2js');
const { extractValue, escapeXml } = require('../utils/tallyHelpers');

async function getCompanyInfo(preferredCompanyName = null) {
  const tallyUrl = process.env.TALLY_URL || 'http://localhost:9000';
  const companyTag = preferredCompanyName
    ? `<SVCURRENTCOMPANY>${escapeXml(preferredCompanyName)}</SVCURRENTCOMPANY>`
    : '';
  
  // Method 1: Simple Collection request - SAFE, won't crash Tally
  const xmlRequest1 = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>CompanyCollection</ID>
        </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            ${companyTag}
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="CompanyCollection">
                <TYPE>Company</TYPE>
                <FETCH>NAME, GUID, REMOTECMPID</FETCH>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  // Method 2: Try extracting from vendor data (SAFE fallback)
  // This method gets a vendor and extracts company info from it
  const xmlRequest2 = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>VendorCollection</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            ${companyTag}
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="VendorList">
                <TYPE>Ledger</TYPE>
                <CHILDOF>Sundry Creditors</CHILDOF>
                <FETCH>GUID, Name</FETCH>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  // Method 3: Get all companies and find the one matching current company name
  const xmlRequest3 = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>Company Collection</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            ${companyTag}
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="Company Collection">
                <TYPE>Company</TYPE>
                <FETCH>NAME, REMOTECMPID, GUID</FETCH>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  // Try Method 1 first - Simple Collection (SAFE, won't crash Tally)
  try {
    const response = await axios.post(tallyUrl, xmlRequest1, {
      headers: { 
        'Content-Type': 'application/xml',
        'Accept': 'application/xml'
      },
      timeout: 30000 // Increased to 30 seconds - Tally can be slow
    });
    
    const data = response.data;
    console.log('📄 Raw Tally Response (Method 1 - Collection):', data.substring(0, 500));
    
    // Parse XML
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(data);
    
    // Extract from Company Collection
    const companies = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    if (!companies) {
      console.warn('⚠️ No companies in collection response');
    } else {
      const companyArray = Array.isArray(companies) ? companies : [companies];
      
      // Get the first company (usually the currently open one)
      // If multiple companies, we'll need to identify which is current
      const company = companyArray[0];
      
      let guid = extractValue(company?.GUID);
      if (!guid && company?.$?.GUID) {
        guid = company.$.GUID;
      }
      if (!guid && company?.GUID?._) {
        guid = company.GUID._;
      }
      if (!guid) {
        guid = extractValue(company?.REMOTECMPID) || company?.$?.REMOTECMPID;
      }
      if (!guid) {
        guid = extractValue(company?.REMOTECMPID) || company?.$?.REMOTECMPID;
      }
      if (!guid) {
        guid = extractValue(company?.REMOTECMPID) || company?.$?.REMOTECMPID;
      }
      
      let name = extractValue(company?.NAME);
      if (!name && company?.$?.NAME) {
        name = company.$.NAME;
      }
      if (!name) {
        name = extractValue(company?.REMOTECMPID);
      }
      if (!name && company?.$?.REMOTECMPID) {
        name = company.$.REMOTECMPID;
      }
      
      if (guid) {
        // If multiple companies, try to identify current one by checking all
        if (companyArray.length > 1) {
          console.log(`⚠️ Multiple companies found (${companyArray.length}). Using first one: ${name || 'Unknown'}`);
        } else {
          console.log(`✅ Detected Company (Method 1 - Collection): ${name || 'Unknown'}`);
        }
        console.log(`✅ GUID: ${guid}`);
        return { guid, name: name || 'Unknown Company' };
      }
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Cannot connect to Tally on port 9000. Is Tally running?');
      return null;
    } else if (error.code === 'ETIMEDOUT') {
      console.error('❌ Tally connection timed out. Is Tally responding?');
      return null;
    }
    console.warn('⚠️ Method 1 (Collection) failed:', error.message);
  }
  
  // Try Method 2 - Extract from vendor data (fallback)
  try {
    const response = await axios.post(tallyUrl, xmlRequest2, {
      headers: { 
        'Content-Type': 'application/xml',
        'Accept': 'application/xml'
      },
      timeout: 30000 // Increased to 30 seconds - Tally can be slow
    });
    
    const data = response.data;
    console.log('📄 Raw Tally Response (Method 2 - Vendor):', data.substring(0, 500));
    
    // Parse XML
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(data);
    
    // Extract vendor GUID - company GUID is usually embedded
    const vendors = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER;
    if (vendors) {
      const vendorArray = Array.isArray(vendors) ? vendors : [vendors];
      if (vendorArray.length > 0) {
        const vendor = vendorArray[0];
        let vendorGuid = extractValue(vendor?.GUID);
        if (!vendorGuid && vendor?.$?.GUID) {
          vendorGuid = vendor.$.GUID;
        }
        
        if (vendorGuid) {
          // Company GUID is typically the first part of vendor GUID
          // This is a fallback method - not ideal but safer
          console.warn('⚠️ Using Method 2 (Vendor-based) - less reliable');
          console.warn('⚠️ Cannot reliably extract company GUID from vendor data');
          // Return null to try next method
        }
      }
    }
  } catch (error) {
    console.warn('⚠️ Method 2 (Vendor) failed:', error.message);
  }
  
  // Method 3: Get all companies and try to identify current one (LAST RESORT)
  // NOTE: Removed Object request as it can crash Tally with memory access violation
  // This is unreliable - we'll try to get current company name first
  try {
    // First, get current company name
    const currentNameResponse = await axios.post(tallyUrl, `
      <ENVELOPE>
        <HEADER>
          <VERSION>1</VERSION>
          <TALLYREQUEST>Export</TALLYREQUEST>
          <TYPE>Data</TYPE>
          <ID>CurrentCompanyName</ID>
        </HEADER>
        <BODY>
          <DESC>
            <STATICVARIABLES>
              <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
              ${companyTag}
            </STATICVARIABLES>
            <TDL>
              <TDLMESSAGE>
                <REPORT NAME="CurrentName">
                  <FORMS>Form1</FORMS>
                </REPORT>
                <FORM NAME="Form1">
                  <PARTS>Part1</PARTS>
                </FORM>
                <PART NAME="Part1">
                  <LINES>Line1</LINES>
                </PART>
                <LINE NAME="Line1">
                  <FIELDS>CurrentName</FIELDS>
                </LINE>
                <FIELD NAME="CurrentName">
                  <SET>##SVCURRENTCOMPANY</SET>
                </FIELD>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000 // Increased to 30 seconds - Tally can be slow
    });
    
    const currentNameData = currentNameResponse.data;
    const currentNameMatch = currentNameData.match(/<CURRENTNAME[^>]*>([^<]+)<\/CURRENTNAME>/i) ||
                             currentNameData.match(/<FIELD1[^>]*>([^<]+)<\/FIELD1>/i);
    const currentCompanyName = currentNameMatch ? currentNameMatch[1].trim() : null;
    
    // Now get all companies and match by name
    const response = await axios.post(tallyUrl, xmlRequest3, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000 // Increased to 30 seconds - Tally can be slow
    });
    
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    
    const companies = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    if (!companies) {
      console.warn('⚠️ No companies returned from Tally');
      return null;
    }
    
    const companyArray = Array.isArray(companies) ? companies : [companies];
    
    // If we have current company name, try to match it
    if (currentCompanyName) {
      for (const company of companyArray) {
        let name = extractValue(company?.NAME);
        if (!name && company?.$?.NAME) {
          name = company.$.NAME;
        }
        if (!name) {
          name = extractValue(company?.REMOTECMPID);
        }
        if (!name && company?.$?.REMOTECMPID) {
          name = company.$.REMOTECMPID;
        }
        
        if (name && name.toLowerCase() === currentCompanyName.toLowerCase()) {
          let guid = extractValue(company?.GUID);
          if (!guid && company?.$?.GUID) {
            guid = company.$.GUID;
          }
          if (!guid && company?.GUID?._) {
            guid = company.GUID._;
          }
          if (!guid) {
            guid = extractValue(company?.REMOTECMPID) || company?.$?.REMOTECMPID;
          }
          
          if (guid) {
            console.log(`✅ Detected CURRENT Company (Method 4 - Matched by name): ${name}`);
            console.log(`✅ GUID: ${guid}`);
            return { guid, name };
          }
        }
      }
    }
    
    // Last resort: use first company (unreliable!)
    const company = companyArray[0];
    let guid = extractValue(company?.GUID);
    if (!guid && company?.$?.GUID) {
      guid = company.$.GUID;
    }
    if (!guid && company?.GUID?._) {
      guid = company.GUID._;
    }
    if (!guid) {
      guid = extractValue(company?.REMOTECMPID) || company?.$?.REMOTECMPID;
    }
    
    let name = extractValue(company?.NAME);
    if (!name && company?.$?.NAME) {
      name = company.$.NAME;
    }
    if (!name) {
      name = extractValue(company?.REMOTECMPID);
    }
    if (!name && company?.$?.REMOTECMPID) {
      name = company.$.REMOTECMPID;
    }
    
    if (guid) {
      console.warn(`⚠️ Using Method 3 (LAST RESORT - unreliable!) - Detected: ${name || 'Unknown'}`);
      console.warn(`⚠️ GUID: ${guid} - This may not be the currently open company!`);
      console.warn(`⚠️ Please ensure the correct company is open in Tally`);
      return { guid, name: name || 'Unknown Company' };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error fetching company info (Method 3):', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Connection refused - Is Tally running on port 9000?');
    }
    return null;
  }
}

// Get all companies from Tally
async function getAllCompanies(preferredCompanyName = null) {
  const tallyUrl = process.env.TALLY_URL || 'http://localhost:9000';
  const companyTag = preferredCompanyName
    ? `<SVCURRENTCOMPANY>${escapeXml(preferredCompanyName)}</SVCURRENTCOMPANY>`
    : '';
  
  const xmlRequest = `
    <ENVELOPE>
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>Company Collection</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
            ${companyTag}
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              <COLLECTION NAME="Company Collection">
                <TYPE>Company</TYPE>
                <FETCH>NAME, REMOTECMPID, GUID</FETCH>
              </COLLECTION>
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>
    </ENVELOPE>
  `;
  
  try {
    const response = await axios.post(tallyUrl, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000 // Increased to 30 seconds - Tally can be slow
    });
    
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    
    const companies = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    if (!companies) {
      console.warn('⚠️ No companies returned from Tally');
      return [];
    }
    
    const companyArray = Array.isArray(companies) ? companies : [companies];
    
    // Extract all companies
    const allCompanies = companyArray.map(company => {
      // Try multiple ways to extract GUID
      let guid = extractValue(company?.GUID);
      if (!guid && company?.$?.GUID) {
        guid = company.$.GUID;
      }
      if (!guid && company?.GUID?._) {
        guid = company.GUID._;
      }
      
      // Try multiple ways to extract name
      let name = extractValue(company?.NAME);
      if (!name && company?.$?.NAME) {
        name = company.$.NAME;
      }
      if (!name) {
        name = extractValue(company?.REMOTECMPID);
      }
      if (!name && company?.$?.REMOTECMPID) {
        name = company.$.REMOTECMPID;
      }
      
      return {
        guid: guid || null,
        name: name || 'Unknown Company'
      };
    }).filter(company => company.guid); // Only return companies with valid GUIDs
    
    console.log(`✅ Found ${allCompanies.length} companies in Tally`);
    return allCompanies;
  } catch (error) {
    console.error('❌ Error fetching all companies:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Connection refused - Is Tally running on port 9000?');
      console.error('   Make sure:\n   1. Tally application is running\n   2. A company is open in Tally\n   3. ODBC is enabled (F12 → Advanced Configuration → Enable ODBC Server)');
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      console.error('❌ Connection timed out - Tally may be slow to respond or not running');
      console.error('   The timeout was set to 30 seconds. If Tally is running but slow, try:\n   1. Closing and reopening Tally\n   2. Restarting the middleware server');
    } else {
      console.error('❌ Unexpected error:', error.code || 'UNKNOWN');
    }
    throw error; // Re-throw to let the endpoint handle it properly
  }
}

module.exports = { getCompanyInfo, getAllCompanies };

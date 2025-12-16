function registerCompanyRoutes(app, deps) {
  const {
    axios,
    currentCompanyTag,
    fs,
    TALLY_URL,
    pool,
    getCompanyInfo,
    getAllCompanies,
    loadConfig,
    saveConfig,
    CONFIG_FILE,
    DEFAULT_BUSINESS_ID,
    DEFAULT_BUSINESS_NAME,
    xml2js
  } = deps;

// Test endpoint
app.get('/api/test', (req, res) => {
  const dbStatus = pool ? 'Connected' : 'Not configured (DATABASE_URL missing)';
  res.json({
    message: 'Tally Middleware is running',
    timestamp: new Date(),
    database: dbStatus,
    databaseUrl: process.env.DATABASE_URL ? 'Configured' : 'Missing',
    tallyUrl: TALLY_URL,
    status: 'ok'
  });
});

// Test ODBC connection to Tally
app.get('/api/test-odbc', async (req, res) => {
  try {
    console.log('🔍 Testing ODBC connection to Tally...');
    const startTime = Date.now();
    const config = loadConfig();
    const companyTag = currentCompanyTag(config);

    // Try a simple request to Tally
    const testXml = `
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
                  <FETCH>NAME, GUID</FETCH>
                </COLLECTION>
              </TDLMESSAGE>
            </TDL>
          </DESC>
        </BODY>
      </ENVELOPE>
    `;

    const response = await axios.post(TALLY_URL, testXml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000 // 15 seconds for test
    });

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // Try to parse response
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);

    const companies = result?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    const companyCount = companies ? (Array.isArray(companies) ? companies.length : 1) : 0;

    res.json({
      success: true,
      message: 'ODBC connection successful',
      tallyUrl: TALLY_URL,
      responseTime: `${responseTime}ms`,
      companiesFound: companyCount,
      status: 'connected'
    });
  } catch (error) {
    console.error('❌ ODBC test failed:', error.message);

    let errorDetails = {
      success: false,
      message: 'ODBC connection failed',
      tallyUrl: TALLY_URL,
      error: error.message
    };

    if (error.code === 'ECONNREFUSED') {
      errorDetails.status = 'connection_refused';
      errorDetails.details = 'Cannot connect to Tally on port 9000. Make sure:\n1. Tally is running\n2. A company is open in Tally\n3. ODBC is enabled (F12 → Advanced Configuration → Enable ODBC Server)';
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      errorDetails.status = 'timeout';
      errorDetails.details = 'Connection timed out. Tally may be slow to respond or not running.';
    } else {
      errorDetails.status = 'error';
      errorDetails.details = error.message;
    }

    res.status(500).json(errorDetails);
  }
});

// TEMPORARY: Test compression endpoint
app.get('/api/test-compression', (req, res) => {
  // Generate large data > 1KB
  const data = {
    message: 'Compression test',
    items: Array(100).fill({ id: 1, name: 'Test Item', description: 'This is a test item to generate enough data for compression to kick in.' })
  };
  res.json(data);
});

// ==================== COMPANY SETUP ENDPOINTS ====================

// Detect all companies from Tally
app.get('/api/company/detect', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('🔍 Company detect endpoint called - fetching all companies');
    console.log(`📡 Connecting to Tally at: ${TALLY_URL}`);

    const config = loadConfig();
    const companies = await getAllCompanies(config?.company?.name);
    const responseTime = Date.now() - startTime;

    if (companies && companies.length > 0) {
      console.log(`✅ Found ${companies.length} companies (took ${responseTime}ms)`);
      res.json({
        success: true,
        companies: companies,
        count: companies.length,
        responseTime: `${responseTime}ms`
      });
    } else {
      console.warn(`⚠️ No companies found (took ${responseTime}ms)`);
      res.json({
        success: false,
        error: 'Could not detect any companies from Tally.\n\nPlease check:\n1. Is Tally application running?\n2. Is a company open in Tally?\n3. Is ODBC enabled? (Press F12 in Tally → Advanced Configuration → Enable ODBC Server)\n4. Is port 9000 accessible?\n\nYou can test the ODBC connection using the /api/test-odbc endpoint.'
      });
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`❌ Company detect error (took ${responseTime}ms):`, error.message);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      stack: error.stack?.substring(0, 200)
    });

    let errorMessage = error.message;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Cannot connect to Tally on port 9000.\n\nPlease:\n1. Open Tally application\n2. Open a company in Tally\n3. Enable ODBC: Press F12 → Advanced Configuration → Enable ODBC Server\n4. Check if Tally is listening on port 9000';
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      errorMessage = `Tally connection timed out after ${responseTime}ms.\n\nPlease:\n1. Make sure Tally is running\n2. Open a company in Tally\n3. Enable ODBC: Press F12 → Advanced Configuration → Enable ODBC Server\n4. Check if port 9000 is blocked by firewall\n5. Try the /api/test-odbc endpoint to verify connection`;
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
      errorCode: error.code,
      responseTime: `${responseTime}ms`
    });
  }
});

// Verify manual entry against Tally
app.post('/api/company/verify', async (req, res) => {
  try {
    const { name, guid } = req.body;

    if (!name || !guid) {
      return res.json({
        success: false,
        error: 'Company name and GUID are required'
      });
    }

    // Try to get info from Tally
    const tallyInfo = await getCompanyInfo(name);

    if (tallyInfo && tallyInfo.guid) {
      const tallyGuid = tallyInfo.guid.toLowerCase();
      const inputGuid = guid.toLowerCase();
      const tallyName = tallyInfo.name.toLowerCase();
      const inputName = name.toLowerCase();

      // Check if GUID matches
      if (tallyGuid === inputGuid) {
        // Check if name matches
        if (tallyName === inputName) {
          res.json({
            success: true,
            match: true,
            message: 'Perfect match! Company name and GUID verified.'
          });
        } else {
          res.json({
            success: true,
            match: false,
            warning: `GUID matches, but name differs. Tally shows: "${tallyInfo.name}". You entered: "${name}". Please verify.`
          });
        }
      } else {
        res.json({
          success: true,
          match: false,
          warning: `GUID mismatch! Tally company GUID is "${tallyInfo.guid}". You entered: "${guid}". Please check.`
        });
      }
    } else {
      // Tally not available, allow manual entry
      res.json({
        success: true,
        match: false,
        warning: 'Could not verify with Tally. Make sure Tally is running. You can still proceed with manual entry.'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Save company setup
app.post('/api/company/setup', async (req, res) => {
  try {
    const { name, guid, mode } = req.body;

    if (!name || !guid) {
      return res.json({
        success: false,
        error: 'Company name and GUID are required'
      });
    }

    // Save config
    const config = {
      company: {
        name,
        guid,
        mode,
        setupAt: new Date().toISOString()
      }
    };

    saveConfig(config);

    // Register in database
    await pool.query(`
      INSERT INTO companies (company_guid, company_name, verified)
      VALUES ($1, $2, $3)
      ON CONFLICT (company_guid) 
      DO UPDATE SET company_name = $2, verified = $3
    `, [guid, name, mode === 'auto']);

    res.json({
      success: true,
      message: 'Company setup completed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get current company config
app.get('/api/company/config', (req, res) => {
  const config = loadConfig();
  res.json({
    success: true,
    config: config || null
  });
});

// Reset company config (for settings)
app.post('/api/company/reset', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
    res.json({
      success: true,
      message: 'Company config reset successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


}

module.exports = registerCompanyRoutes;

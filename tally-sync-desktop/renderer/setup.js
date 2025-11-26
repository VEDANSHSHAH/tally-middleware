// Get API URL from electronAPI if available, otherwise use default
let API_URL = 'http://localhost:3000/api';

// Initialize API URL on page load
(async () => {
  if (window.electronAPI && window.electronAPI.getApiUrl) {
    try {
      API_URL = await window.electronAPI.getApiUrl();
      console.log('API URL:', API_URL);
    } catch (error) {
      console.warn('Could not get API URL from main process, using default:', error);
    }
  }
})();

// Tab Switching Logic
const tabButtons = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    // Remove active class from all
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    // Add active class to clicked
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(`${tabId}-tab`).classList.add('active');
  });
});

// ==================== AUTO DETECT TAB ====================
const autoDetectBtn = document.getElementById('auto-detect-btn');
const detectStatus = document.getElementById('detect-status');
const companySelectContainer = document.getElementById('company-selection-container');
const companySelect = document.getElementById('company-select');
const detectedInfo = document.getElementById('detected-info');
const detectedName = document.getElementById('detected-name');
const detectedGuid = document.getElementById('detected-guid');
const useDetectedBtn = document.getElementById('use-detected-btn');
const autoError = document.getElementById('auto-error');
const autoErrorMsg = document.getElementById('auto-error-msg');

let selectedAutoCompany = null;

autoDetectBtn.addEventListener('click', async () => {
  // Reset UI
  detectStatus.style.display = 'block';
  detectStatus.innerHTML = '<span class="loading-spinner"></span> Connecting to server...';
  companySelectContainer.style.display = 'none';
  detectedInfo.style.display = 'none';
  autoError.style.display = 'none';
  useDetectedBtn.disabled = true;

  try {
    // First check if server is up with retry logic
    let testRes = null;
    let retries = 0;
    const maxRetries = 5;
    
    while (retries < maxRetries) {
      try {
        // Create a timeout promise
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), 2000)
        );
        
        // Race between fetch and timeout
        testRes = await Promise.race([
          fetch(`${API_URL}/test`),
          timeoutPromise
        ]);
        
        if (testRes && testRes.ok) break;
      } catch (err) {
        if (retries < maxRetries - 1) {
          detectStatus.innerHTML = `<span class="loading-spinner"></span> Waiting for server... (${retries + 1}/${maxRetries})`;
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;
          continue;
        } else {
          const port = API_URL.match(/:(\d+)/)?.[1] || '3000';
          throw new Error(`Could not connect to the server. Make sure:\n1. The backend server is running on port ${port}\n2. Check the console for server errors`);
        }
      }
      retries++;
    }
    
    if (!testRes || !testRes.ok) {
      const port = API_URL.match(/:(\d+)/)?.[1] || '3000';
      throw new Error(`Server not ready. Make sure the backend server is running on port ${port}.`);
    }
    
    detectStatus.innerHTML = '<span class="loading-spinner"></span> Detecting Tally company...';

    // Try to detect company
    const response = await fetch(`${API_URL}/company/detect`);
    
    if (!response.ok) {
      // Try to get error message from response
      let errorMsg = 'Server error occurred';
      try {
        const errorData = await response.json();
        errorMsg = errorData.error || errorMsg;
      } catch (e) {
        errorMsg = `HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();

    if (data.success && data.companies && data.companies.length > 0) {
      detectStatus.style.display = 'none';

      if (data.companies.length === 1) {
        // Single company found
        const company = data.companies[0];
        selectedAutoCompany = company;

        detectedName.textContent = company.name;
        detectedGuid.textContent = company.guid;
        detectedInfo.style.display = 'block';
        useDetectedBtn.disabled = false;
      } else {
        // Multiple companies found
        companySelect.innerHTML = '<option value="">-- Select a Company --</option>';
        data.companies.forEach(company => {
          const option = document.createElement('option');
          option.value = JSON.stringify(company);
          option.textContent = company.name;
          companySelect.appendChild(option);
        });
        companySelectContainer.style.display = 'block';
      }
    } else {
      detectStatus.style.display = 'none';
      // Show server error message if available
      const errorMsg = data.error || 'No company detected. Please make sure Tally is running and a company is open.';
      autoErrorMsg.innerHTML = errorMsg.replace(/\n/g, '<br>');
      autoError.style.display = 'block';
    }
  } catch (error) {
    console.error('Auto-detect failed:', error);
    detectStatus.style.display = 'none';
    // Show detailed error message
    let errorMsg = error.message || 'Could not connect to Tally.';
    
    // Provide helpful guidance based on error type
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      const port = API_URL.match(/:(\d+)/)?.[1] || '3000';
      errorMsg = `Could not connect to the server. Make sure:\n1. The backend server is running on port ${port}\n2. Check the console for server errors`;
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('port 9000')) {
      errorMsg = 'Cannot connect to Tally on port 9000.\n\nPlease:\n1. Open Tally application\n2. Open a company in Tally\n3. Enable ODBC: Press F12 → Advanced Configuration → Enable ODBC Server';
    } else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
      errorMsg = 'Tally connection timed out.\n\nPlease:\n1. Make sure Tally is running\n2. Open a company in Tally\n3. Enable ODBC: Press F12 → Advanced Configuration → Enable ODBC Server\n4. Check if port 9000 is blocked by firewall';
    }
    
    autoErrorMsg.textContent = errorMsg;
    autoError.style.display = 'block';
  }
});

// Handle dropdown selection
companySelect.addEventListener('change', (e) => {
  if (e.target.value) {
    const selected = JSON.parse(e.target.value);
    selectedAutoCompany = selected;

    detectedName.textContent = selected.name;
    detectedGuid.textContent = selected.guid;
    detectedInfo.style.display = 'block';
    useDetectedBtn.disabled = false;
  } else {
    selectedAutoCompany = null;
    detectedInfo.style.display = 'none';
    useDetectedBtn.disabled = true;
  }
});

// Save Auto-Detected Company
useDetectedBtn.addEventListener('click', async () => {
  if (!selectedAutoCompany) return;

  useDetectedBtn.disabled = true;
  useDetectedBtn.textContent = 'Saving...';

  try {
    const response = await fetch(`${API_URL}/company/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: selectedAutoCompany.name,
        guid: selectedAutoCompany.guid,
        mode: 'auto'
      })
    });
    const data = await response.json();

    if (data.success) {
      // Use Electron IPC for navigation if available, otherwise fallback to location
      if (window.electronAPI && window.electronAPI.navigateTo) {
        window.electronAPI.navigateTo('index.html').catch(() => {
          // Fallback to location if IPC fails
          setTimeout(() => {
            window.location.replace('index.html');
          }, 100);
        });
      } else {
        // Fallback for non-Electron environments
        setTimeout(() => {
          window.location.replace('index.html');
        }, 100);
      }
    } else {
      autoErrorMsg.textContent = data.error || 'Failed to save';
      autoError.style.display = 'block';
      useDetectedBtn.disabled = false;
      useDetectedBtn.textContent = '✅ Use This Company';
    }
  } catch (error) {
    autoErrorMsg.textContent = 'Save error: ' + error.message;
    autoError.style.display = 'block';
    useDetectedBtn.disabled = false;
    useDetectedBtn.textContent = '✅ Use This Company';
  }
});

// ==================== MANUAL ENTRY TAB ====================
const manualName = document.getElementById('manual-name');
const manualGuid = document.getElementById('manual-guid');
const verifyBtn = document.getElementById('verify-btn');
const manualForm = document.getElementById('manual-form');
const manualWarning = document.getElementById('manual-warning');
const manualError = document.getElementById('manual-error');
const manualSuccess = document.getElementById('manual-success');

function showManualMessage(type, text) {
  manualWarning.style.display = 'none';
  manualError.style.display = 'none';
  manualSuccess.style.display = 'none';

  if (type === 'warning') {
    document.getElementById('manual-warning-msg').textContent = text;
    manualWarning.style.display = 'block';
  } else if (type === 'error') {
    document.getElementById('manual-error-msg').textContent = text;
    manualError.style.display = 'block';
  } else if (type === 'success') {
    manualSuccess.style.display = 'block';
  }
}

verifyBtn.addEventListener('click', async () => {
  const name = manualName.value.trim();
  const guid = manualGuid.value.trim();

  if (!name || !guid) {
    showManualMessage('error', 'Please enter both Company Name and GUID');
    return;
  }

  verifyBtn.disabled = true;
  verifyBtn.innerHTML = 'Verifying...';

  try {
    const response = await fetch(`${API_URL}/company/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, guid })
    });
    const data = await response.json();

    if (data.success) {
      if (data.match) {
        showManualMessage('success', data.message);
      } else if (data.warning) {
        showManualMessage('warning', data.warning);
      }
    } else {
      showManualMessage('error', data.error || 'Verification failed');
    }
  } catch (error) {
    showManualMessage('error', 'Verification error: ' + error.message);
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.innerHTML = '🔍 Verify with Tally';
  }
});

manualForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = manualName.value.trim();
  const guid = manualGuid.value.trim();

  if (!name || !guid) {
    showManualMessage('error', 'Please enter both Company Name and GUID');
    return;
  }

  const saveBtn = manualForm.querySelector('button[type="submit"]');
  saveBtn.disabled = true;
  saveBtn.innerHTML = 'Saving...';

  try {
    const response = await fetch(`${API_URL}/company/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, guid, mode: 'manual' })
    });
    const data = await response.json();

    if (data.success) {
      // Use Electron IPC for navigation if available, otherwise fallback to location
      if (window.electronAPI && window.electronAPI.navigateTo) {
        window.electronAPI.navigateTo('index.html').catch(() => {
          // Fallback to location if IPC fails
          setTimeout(() => {
            window.location.replace('index.html');
          }, 100);
        });
      } else {
        // Fallback for non-Electron environments
        setTimeout(() => {
          window.location.replace('index.html');
        }, 100);
      }
    } else {
      showManualMessage('error', data.error || 'Failed to save');
      saveBtn.disabled = false;
      saveBtn.innerHTML = '💾 Save & Continue';
    }
  } catch (error) {
    showManualMessage('error', 'Save error: ' + error.message);
    saveBtn.disabled = false;
    saveBtn.innerHTML = '💾 Save & Continue';
  }
});

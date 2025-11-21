const API_URL = 'http://localhost:8000/api';

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
  detectStatus.innerHTML = '<span class="loading-spinner"></span> Detecting Tally company...';
  companySelectContainer.style.display = 'none';
  detectedInfo.style.display = 'none';
  autoError.style.display = 'none';
  useDetectedBtn.disabled = true;

  try {
    // First check if server is up
    const testRes = await fetch(`${API_URL}/test`);
    if (!testRes.ok) throw new Error('Server not ready');

    // Try to detect company
    const response = await fetch(`${API_URL}/company/detect`);
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
      autoErrorMsg.textContent = 'No company detected. Please make sure Tally is running and a company is open.';
      autoError.style.display = 'block';
    }
  } catch (error) {
    console.error('Auto-detect failed:', error);
    detectStatus.style.display = 'none';
    autoErrorMsg.textContent = 'Could not connect to Tally. Please check if Tally is running.';
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

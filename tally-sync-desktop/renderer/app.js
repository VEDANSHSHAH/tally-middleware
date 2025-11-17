// API base URL
const API_URL = 'http://localhost:3000/api';

// DOM elements
const connectionStatus = document.getElementById('connection-status');
const lastSync = document.getElementById('last-sync');
const vendorCount = document.getElementById('vendor-count');
const vendorAmount = document.getElementById('vendor-amount');
const customerCount = document.getElementById('customer-count');
const customerAmount = document.getElementById('customer-amount');
const transactionCount = document.getElementById('transaction-count');
const transactionAmount = document.getElementById('transaction-amount');
const logEntries = document.getElementById('log-entries');
const syncBtn = document.getElementById('sync-btn');
const refreshBtn = document.getElementById('refresh-btn');
const vendorScoresContainer = document.getElementById('vendor-scores-container');
const agingContainer = document.getElementById('aging-container');

// Add log entry
function addLog(message) {
  const entry = document.createElement('p');
  entry.className = 'log-entry';
  entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  logEntries.insertBefore(entry, logEntries.firstChild);
  
  // Keep only last 10 entries
  while (logEntries.children.length > 10) {
    logEntries.removeChild(logEntries.lastChild);
  }
}

// Format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0
  }).format(amount || 0);
}

// Test server connection
async function testConnection() {
  try {
    const response = await fetch(`${API_URL}/test`);
    const data = await response.json();
    
    if (data.message) {
      connectionStatus.textContent = 'Connected to Tally';
      connectionStatus.style.color = '#28a745';
      addLog('✅ Connected to backend server');
      return true;
    }
  } catch (error) {
    connectionStatus.textContent = 'Connection Failed';
    connectionStatus.style.color = '#dc3545';
    addLog('❌ Failed to connect to backend');
    return false;
  }
}

// Fetch and display stats
async function fetchStats() {
  try {
    const response = await fetch(`${API_URL}/stats`);
    const data = await response.json();
    
    if (data.success) {
      const { vendors, customers, transactions } = data.stats;
      
      // Update vendors
      vendorCount.textContent = vendors.total_vendors || 0;
      vendorAmount.textContent = formatCurrency(vendors.total_payables);
      
      // Update customers
      customerCount.textContent = customers.total_customers || 0;
      customerAmount.textContent = formatCurrency(customers.total_receivables);
      
      // Update transactions
      transactionCount.textContent = transactions.total_transactions || 0;
      const totalAmount = (transactions.total_payments || 0) + (transactions.total_receipts || 0);
      transactionAmount.textContent = formatCurrency(totalAmount);
      
      // Update last sync
      if (data.stats.last_sync) {
        const syncDate = new Date(data.stats.last_sync);
        const now = new Date();
        const diffMinutes = Math.floor((now - syncDate) / 60000);
        
        if (diffMinutes < 1) {
          lastSync.textContent = 'Just now';
        } else if (diffMinutes < 60) {
          lastSync.textContent = `${diffMinutes} min ago`;
        } else {
          lastSync.textContent = syncDate.toLocaleTimeString();
        }
      }
      
      addLog('📊 Stats updated successfully');
    }
  } catch (error) {
    console.error('Error fetching stats:', error);
    addLog('❌ Failed to fetch stats');
  }
}

// ⭐ NEW: Fetch and display vendor scores
async function fetchVendorScores() {
  try {
    const response = await fetch(`${API_URL}/analytics/vendor-scores`);
    const data = await response.json();
    
    if (data.success && data.count > 0) {
      vendorScoresContainer.innerHTML = '';
      
      data.data.forEach(vendor => {
        const scoreItem = document.createElement('div');
        scoreItem.className = 'vendor-score-item';
        
        const riskClass = `risk-${vendor.risk_level}`;
        
        scoreItem.innerHTML = `
          <div class="vendor-score-info">
            <div class="vendor-name">${vendor.vendor_name}</div>
            <div class="vendor-balance">Balance: ${formatCurrency(vendor.current_balance)}</div>
          </div>
          <div class="vendor-score-badge ${riskClass}">
            <div class="score-value">${Math.round(vendor.overall_score)}</div>
            <div class="score-label">Score</div>
          </div>
        `;
        
        vendorScoresContainer.appendChild(scoreItem);
      });
      
      addLog('🏆 Vendor scores loaded');
    } else {
      vendorScoresContainer.innerHTML = '<p class="no-data">No vendor scores available yet</p>';
    }
  } catch (error) {
    console.error('Error fetching vendor scores:', error);
    vendorScoresContainer.innerHTML = '<p class="no-data">Failed to load vendor scores</p>';
  }
}

// ⭐ NEW: Fetch and display aging analysis
async function fetchAging() {
  try {
    const response = await fetch(`${API_URL}/analytics/aging`);
    const data = await response.json();
    
    if (data.success && data.count > 0) {
      agingContainer.innerHTML = '';
      
      data.data.forEach(item => {
        const agingItem = document.createElement('div');
        agingItem.className = 'aging-item';
        
        agingItem.innerHTML = `
          <div class="aging-header">
            <span class="aging-entity-name">${item.entity_name}</span>
            <span class="aging-total">${formatCurrency(item.total_outstanding)}</span>
          </div>
          <div class="aging-breakdown">
            <div class="aging-bucket">
              <div class="bucket-label">0-30 Days</div>
              <div class="bucket-amount">${formatCurrency(item.current_0_30_days)}</div>
            </div>
            <div class="aging-bucket">
              <div class="bucket-label">31-60 Days</div>
              <div class="bucket-amount">${formatCurrency(item.current_31_60_days)}</div>
            </div>
            <div class="aging-bucket">
              <div class="bucket-label">61-90 Days</div>
              <div class="bucket-amount">${formatCurrency(item.current_61_90_days)}</div>
            </div>
            <div class="aging-bucket">
              <div class="bucket-label">90+ Days</div>
              <div class="bucket-amount">${formatCurrency(item.current_over_90_days)}</div>
            </div>
          </div>
        `;
        
        agingContainer.appendChild(agingItem);
      });
      
      addLog('📅 Aging analysis loaded');
    } else {
      agingContainer.innerHTML = '<p class="no-data">No aging data available yet</p>';
    }
  } catch (error) {
    console.error('Error fetching aging:', error);
    agingContainer.innerHTML = '<p class="no-data">Failed to load aging data</p>';
  }
}

// Manual sync
async function syncNow() {
  syncBtn.disabled = true;
  syncBtn.textContent = '🔄 Syncing...';
  addLog('🔄 Starting manual sync...');
  
  try {
    // Sync vendors
    addLog('📦 Syncing vendors...');
    await fetch(`${API_URL}/sync/vendors`, { method: 'POST' });
    
    // Sync customers
    addLog('👥 Syncing customers...');
    await fetch(`${API_URL}/sync/customers`, { method: 'POST' });
    
    // Sync transactions
    addLog('💰 Syncing transactions...');
    await fetch(`${API_URL}/sync/transactions`, { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    // Calculate analytics
    addLog('📊 Calculating analytics...');
    await fetch(`${API_URL}/analytics/calculate`, { method: 'POST' });
    
    addLog('✅ Sync completed successfully!');
    
    // Refresh all data
    await refresh();
  } catch (error) {
    console.error('Sync error:', error);
    addLog('❌ Sync failed: ' + error.message);
  } finally {
    syncBtn.disabled = false;
    syncBtn.innerHTML = '<span>🔄</span> Sync Now';
  }
}

// Refresh all data
async function refresh() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '♻️ Refreshing...';
  
  await fetchStats();
  await fetchVendorScores();
  await fetchAging();
  
  refreshBtn.disabled = false;
  refreshBtn.innerHTML = '<span>♻️</span> Refresh';
}

// Event listeners
syncBtn.addEventListener('click', syncNow);
refreshBtn.addEventListener('click', refresh);

// Initialize
async function init() {
  addLog('🚀 Application started');
  
  // Test connection
  const connected = await testConnection();
  
  if (connected) {
    // Fetch initial data
    await fetchStats();
    await fetchVendorScores();
    await fetchAging();
    
    // Auto-refresh every 30 seconds
    setInterval(async () => {
      await fetchStats();
      await fetchVendorScores();
      await fetchAging();
    }, 30000);
  } else {
    addLog('⚠️ Retrying connection in 5 seconds...');
    setTimeout(init, 5000);
  }
}

// Start the app
init();
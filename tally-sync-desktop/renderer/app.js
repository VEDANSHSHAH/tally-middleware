// Get API URL from electronAPI if available, otherwise use default
let API_URL = 'http://localhost:3000/api';
const AI_API_URL = 'https://tally-middleware-production-7856.up.railway.app';

// Initialize API URL on page load (wait for it to complete)
let apiUrlInitialized = false;
(async () => {
  if (window.electronAPI && window.electronAPI.getApiUrl) {
    try {
      API_URL = await window.electronAPI.getApiUrl();
      console.log('API URL initialized:', API_URL);
    } catch (error) {
      console.warn('Could not get API URL from main process, using default:', error);
    }
  }
  apiUrlInitialized = true;
})();

// Core DOM elements
const connectionStatus = document.getElementById('connection-status');
const lastSync = document.getElementById('last-sync');
const businessNameEl = document.getElementById('business-name');
const businessIdEl = document.getElementById('business-id');
const vendorCount = document.getElementById('vendor-count');
const vendorAmount = document.getElementById('vendor-amount');
const customerCount = document.getElementById('customer-count');
const customerAmount = document.getElementById('customer-amount');
const salesTotal = document.getElementById('sales-total');
const salesPillValue = document.getElementById('sales-pill-value');
const salesBreakdown = document.getElementById('sales-breakdown');
let salesGroupSummaryData = null; // Track if we have Sales Group Summary data
const salesGroupSummary = document.getElementById('sales-group-summary');
const transactionsList = document.getElementById('transactions-list');
const agingContainer = document.getElementById('aging-container');
const agingNameFilter = document.getElementById('aging-name-filter');
const agingPagination = document.getElementById('aging-pagination');
const performanceDashboard = document.getElementById('performance-dashboard');
const revenueTrendsContainer = document.getElementById('revenue-trends');
const collectionPriorityContainer = document.getElementById('collection-priority');
const overdueAnalysisContainer = document.getElementById('overdue-analysis');
const paymentPatternsContainer = document.getElementById('payment-patterns');
const txSearchForm = document.getElementById('transaction-search-form');
const txSearchResults = document.getElementById('transaction-search-results');
const txPartyInput = document.getElementById('tx-party');
const txVoucherInput = document.getElementById('tx-voucher-number');
const txFromDateInput = document.getElementById('tx-from-date');
const txToDateInput = document.getElementById('tx-to-date');
const txMinAmountInput = document.getElementById('tx-min-amount');
const txMaxAmountInput = document.getElementById('tx-max-amount');
const txVoucherTypeInput = document.getElementById('tx-voucher-type');
const txClearBtn = document.getElementById('tx-clear');
const logEntries = document.getElementById('log-entries');
const syncBtn = document.getElementById('sync-btn');
const refreshBtn = document.getElementById('refresh-btn');

// Filters and cards
const customerAmountFilter = document.getElementById('customer-amount-filter');
const customerActivityFilter = document.getElementById('customer-activity-filter');
const collectionCustomer = document.getElementById('collection-customer');
const collectionAmount = document.getElementById('collection-amount');
const collectionCountdown = document.getElementById('collection-countdown');
const collectionNote = document.getElementById('collection-note');
const formulaOpening = document.getElementById('formula-opening');
const formulaSales = document.getElementById('formula-sales');
const formulaReceipts = document.getElementById('formula-receipts');
const formulaClosing = document.getElementById('formula-closing');

// Ask-AI modal
const aiSearchBtn = document.getElementById('ai-search-btn');
const aiModal = document.getElementById('ai-modal');
const aiModalClose = document.getElementById('ai-modal-close');
const aiModalCancel = document.getElementById('ai-modal-cancel');
const aiQueryForm = document.getElementById('ai-query-form');
const aiQuestionInput = document.getElementById('ai-question');
const aiAnswerBox = document.getElementById('ai-answer');
const aiQuerySubmit = document.getElementById('ai-query-submit');

// AI insights modal
const aiInsightsOpenBtn = document.getElementById('open-ai-insights');
const aiInsightsModal = document.getElementById('ai-insights-modal');
const aiInsightsClose = document.getElementById('ai-insights-close');
const aiInsightsStatus = document.getElementById('ai-insights-status');
const aiInsightsList = document.getElementById('ai-insights-list');

// Aging filter tabs
const agingTabs = document.querySelectorAll('.aging-tab');

// Data caches
let customersCache = [];
let transactionsCache = [];
let customerActivityMap = new Map();
let agingData = [];
let agingFilter = 'vendors';
let agingPage = 1;
let aiInsightsLoaded = false;
let collectionTarget = null;
let collectionTimerInterval = null;
const AGING_PAGE_SIZE = 4;
const AGING_MAX_VISIBLE_PAGES = 4;

// Transactions Pagination state
let txCurrentPage = 1;
let txPageSize = 50;
let txTotalPages = 1;
let txTotalRecords = 0;
let transactionsPaginated = [];
let txSearchHasRun = false;

// Performance metrics tracking
const performanceMetrics = {
  connectionPing: null,
  lastStatsFetch: null,
  lastCustomersFetch: null,
  lastTransactionsFetch: null,
  lastAgingFetch: null,
  totalDataSize: 0,
  apiCallCount: 0
};

// Activity log configuration
const LOG_MAX_ENTRIES = 25; // Increased from 12 to keep more history
const LOG_FADE_DELAY = 30000; // 30 seconds before starting to fade old entries

// Logging helper with sync mode support
function addLog(message, replace = false) {
  // Add emoji based on sync mode if not already present
  let displayMessage = message;
  if (!message.startsWith('⚡') && !message.startsWith('📦') && !message.startsWith('✅') && 
      !message.startsWith('❌') && !message.startsWith('🔄') && !message.startsWith('📊') &&
      !message.startsWith('⚠️') && !message.startsWith('📄')) {
    if (message.includes('incremental')) {
      displayMessage = '⚡ ' + message;
    } else if (message.includes('full sync') || message.includes('full mode') || message.includes('FULL')) {
      displayMessage = '📦 ' + message;
    }
  }
  
  const entry = document.createElement('p');
  entry.className = 'log-entry';
  const timestamp = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `${timestamp} - ${displayMessage}`;
  entry.dataset.timestamp = Date.now();
  
  // If replace=true, replace the last log entry instead of adding new one
  if (replace && logEntries.firstChild) {
    logEntries.replaceChild(entry, logEntries.firstChild);
  } else {
    logEntries.insertBefore(entry, logEntries.firstChild);
  }
  
  // Keep more entries (increased capacity)
  while (logEntries.children.length > LOG_MAX_ENTRIES) {
    logEntries.removeChild(logEntries.lastChild);
  }
  
  // Add visual fade effect to older entries
  updateLogEntryStyles();
}

// Update styles for log entries based on age
function updateLogEntryStyles() {
  const entries = logEntries.querySelectorAll('.log-entry');
  const now = Date.now();
  
  entries.forEach((entry, index) => {
    const timestamp = parseInt(entry.dataset.timestamp) || now;
    const age = now - timestamp;
    
    // Add visual hierarchy - newer entries are brighter
    if (index === 0) {
      entry.style.opacity = '1';
      entry.style.fontWeight = '500';
    } else if (index < 5) {
      entry.style.opacity = '0.9';
      entry.style.fontWeight = 'normal';
    } else if (index < 10) {
      entry.style.opacity = '0.7';
    } else {
      entry.style.opacity = '0.5';
    }
  });
}

// Helper function to measure API call performance
async function measureApiCall(endpoint, fetchOptions = {}) {
  const startTime = performance.now();
  const startMemory = performance.memory ? performance.memory.usedJSHeapSize : 0;
  
  try {
    const response = await fetch(endpoint, fetchOptions);
    const endTime = performance.now();
    const responseTime = endTime - startTime;
    
    // Get response size
    const contentLength = response.headers.get('content-length');
    const responseSize = contentLength ? parseInt(contentLength) : 0;
    
    // Clone response to read body without consuming it
    const clonedResponse = response.clone();
    const data = await clonedResponse.json();
    
    const endMemory = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const memoryUsed = endMemory - startMemory;
    
    // Calculate data size from JSON
    const jsonSize = new Blob([JSON.stringify(data)]).size;
    
    performanceMetrics.apiCallCount++;
    performanceMetrics.totalDataSize += jsonSize;
    
    return {
      data,
      response,
      metrics: {
        responseTime: Math.round(responseTime),
        responseSize: jsonSize,
        memoryUsed: memoryUsed > 0 ? Math.round(memoryUsed / 1024) : null, // KB
        timestamp: new Date().toISOString()
      }
    };
  } catch (err) {
    const endTime = performance.now();
    const responseTime = endTime - startTime;
    console.error(`API call failed: ${endpoint}`, {
      error: err,
      responseTime: Math.round(responseTime)
    });
    throw err; // Re-throw original error
  }
}

function formatCurrency(amount) {
  const normalizedAmount = Math.abs(Number(amount) || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0
  }).format(normalizedAmount);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Display performance metrics
function displayPerformanceMetrics() {
  const metrics = performanceMetrics;
  const totalTime = [
    metrics.lastStatsFetch?.responseTime || 0,
    metrics.lastCustomersFetch?.responseTime || 0,
    metrics.lastTransactionsFetch?.responseTime || 0,
    metrics.lastAgingFetch?.responseTime || 0
  ].reduce((a, b) => a + b, 0);
  
  console.log('\n📊 ===== PERFORMANCE METRICS =====');
  console.log(`🔌 Connection Ping: ${metrics.connectionPing ? metrics.connectionPing + 'ms' : 'N/A'}`);
  console.log(`📈 Stats API: ${metrics.lastStatsFetch ? metrics.lastStatsFetch.responseTime + 'ms' : 'N/A'}`);
  console.log(`👥 Customers API: ${metrics.lastCustomersFetch ? metrics.lastCustomersFetch.responseTime + 'ms' : 'N/A'}`);
  console.log(`💰 Transactions API: ${metrics.lastTransactionsFetch ? metrics.lastTransactionsFetch.responseTime + 'ms' : 'N/A'}`);
  console.log(`📊 Aging API: ${metrics.lastAgingFetch ? metrics.lastAgingFetch.responseTime + 'ms' : 'N/A'}`);
  console.log(`⏱️  Total API Time: ${totalTime}ms`);
  console.log(`📦 Total Data Size: ${formatBytes(metrics.totalDataSize)}`);
  console.log(`🔢 API Calls: ${metrics.apiCallCount}`);
  console.log('===================================\n');
}

agingTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    agingTabs.forEach(btn => btn.classList.remove('active'));
    tab.classList.add('active');
    agingFilter = tab.dataset.view;
    agingPage = 1;
    renderAging();
  });
});

customerAmountFilter?.addEventListener('change', () => renderSalesBreakdown());
customerActivityFilter?.addEventListener('change', () => renderSalesBreakdown());
agingNameFilter?.addEventListener('input', () => {
  agingPage = 1;
  renderAging();
});
txSearchForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  runTransactionSearch();
});
txClearBtn?.addEventListener('click', () => {
  txSearchForm?.reset();
  runTransactionSearch();
});

function openAskAIModal() {
  aiModal.classList.remove('hidden');
  aiAnswerBox.classList.add('hidden');
  aiAnswerBox.textContent = '';
  aiQuestionInput.value = '';
  aiQuestionInput.focus();
}

function closeAskAIModal() {
  aiModal.classList.add('hidden');
  aiQuerySubmit.disabled = false;
  aiQuerySubmit.textContent = 'Ask AI';
}

aiSearchBtn?.addEventListener('click', openAskAIModal);
aiModalClose?.addEventListener('click', closeAskAIModal);
aiModalCancel?.addEventListener('click', closeAskAIModal);
aiModal?.addEventListener('click', (event) => {
  if (event.target === aiModal || event.target.classList.contains('ai-modal-backdrop')) {
    closeAskAIModal();
  }
});

function openAiInsightsModal() {
  aiInsightsModal.classList.remove('hidden');
  if (!aiInsightsLoaded) {
    fetchAIInsights(true);
  }
}

function closeAiInsightsModal() {
  aiInsightsModal.classList.add('hidden');
}

aiInsightsOpenBtn?.addEventListener('click', openAiInsightsModal);
aiInsightsClose?.addEventListener('click', closeAiInsightsModal);
aiInsightsModal?.addEventListener('click', (event) => {
  if (event.target === aiInsightsModal || event.target.classList.contains('ai-modal-backdrop')) {
    closeAiInsightsModal();
  }
});

async function testConnection(retries = 5, interval = 1000) {
  // Show connecting state initially
  if (connectionStatus) {
    connectionStatus.textContent = 'Connecting...';
    connectionStatus.style.color = '#ffc107';
  }

  console.log(`🔍 Testing connection to: ${API_URL}/test`);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const startTime = performance.now();
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout')), 5000) // Increased timeout to 5s
      );
      
      // Race between fetch and timeout
      const response = await Promise.race([
        fetch(`${API_URL}/test`),
        timeoutPromise
      ]);
      
      const endTime = performance.now();
      const pingTime = Math.round(endTime - startTime);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      if (data.message) {
        // Store ping time
        performanceMetrics.connectionPing = pingTime;
        
        if (connectionStatus) {
          connectionStatus.innerHTML = `Connected to Tally <span style="font-size: 0.85em; color: #666; font-weight: normal;">(${pingTime}ms)</span>`;
          connectionStatus.style.color = '#28a745';
        }
        addLog(`Connected to backend server (ping: ${pingTime}ms)`);
        console.log(`✅ Connection successful! Ping: ${pingTime}ms`);
        return true;
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      const errorMsg = error.message || error.toString();
      console.error(`❌ Connection test attempt ${attempt + 1}/${retries} failed:`, errorMsg);
      console.error(`   API URL: ${API_URL}/test`);
      
      // If not the last attempt, wait before retrying
      if (attempt < retries - 1) {
        if (connectionStatus) {
          connectionStatus.textContent = `Connecting... (${attempt + 1}/${retries})`;
          connectionStatus.style.color = '#ffc107';
        }
        addLog(`Connection attempt ${attempt + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, interval));
        continue;
      } else {
        // Last attempt failed
        console.error(`❌ All connection attempts failed. Last error: ${errorMsg}`);
        if (connectionStatus) {
          connectionStatus.textContent = 'Connection Failed';
          connectionStatus.style.color = '#dc3545';
        }
        addLog(`Failed to connect: ${errorMsg}`);
      }
    }
  }

  // All retries failed
  return false;
}

// Fetch Sales Group Summary from Tally
async function fetchSalesGroupSummary() {
  try {
    console.log(`📡 Fetching Sales Group Summary from: ${API_URL}/sales/group-summary`);
    const result = await measureApiCall(`${API_URL}/sales/group-summary`);
    const { data, metrics } = result;
    
    if (!data.success) {
      const errorMsg = data.error || 'Sales Group Summary API failed';
      console.error('❌ Sales Group Summary API returned error:', errorMsg);
      
      // Show hint if groups/ledgers need to be synced
      if (data.hint && salesTotal) {
        salesTotal.textContent = 'Sync Required';
        const salesPeriod = document.getElementById('sales-period');
        if (salesPeriod) {
          salesPeriod.textContent = data.hint;
        }
        console.warn('⚠️', data.hint);
        addLog(`⚠️ ${data.hint}`);
      }
      
      // Still try to show data if available (even if success=false)
      if (data.data && salesTotal) {
        const salesData = data.data;
        salesTotal.textContent = salesData.closingBalance.formatted;
      }
      
      return null;
    }
    
    console.log(`✅ Sales Group Summary API: ${metrics.responseTime}ms | Size: ${formatBytes(metrics.responseSize)}`);
    addLog(`Sales Group Summary fetched: ${metrics.responseTime}ms`);
    
    // Update the Total Sales card with Tally data
    if (data.data && salesTotal) {
      salesGroupSummaryData = data.data; // Store the data
      const salesData = data.data;
      salesTotal.textContent = salesData.closingBalance.formatted;
      
      // Update the period label
      const salesPeriod = document.getElementById('sales-period');
      if (salesPeriod) {
        salesPeriod.textContent = `${salesData.period.fromFormatted} to ${salesData.period.toFormatted}`;
      }
      
      // Update the balance type label
      const salesBalanceType = document.getElementById('sales-balance-type');
      if (salesBalanceType) {
        salesBalanceType.textContent = `Closing Balance (${salesData.closingBalance.type})`;
      }
      
      // Log calculation method
      if (salesData.calculation_method) {
        console.log(`📊 Calculation method: ${salesData.calculation_method}`);
        console.log(`   Ledgers: ${salesData.ledgerCount || 0}`);
      }
      
      console.log(`✅ Sales Group Summary updated: ${salesData.closingBalance.formatted}`);
    }
    
    return data.data;
  } catch (error) {
    const errorMsg = error.message || error.toString();
    console.error('❌ Sales Group Summary fetch error:', errorMsg);
    addLog(`❌ Sales Group Summary fetch failed: ${errorMsg}`);
    // Don't throw - allow other data to load
    return null;
  }
}

async function fetchStats() {
  try {
    console.log(`📡 Fetching stats from: ${API_URL}/stats`);
    const result = await measureApiCall(`${API_URL}/stats`);
    const { data, metrics } = result;
    
    if (!data.success) {
      const errorMsg = data.error || 'Stats request failed';
      console.error('❌ Stats API returned error:', errorMsg);
      throw new Error(errorMsg);
    }
    
    performanceMetrics.lastStatsFetch = metrics;
    console.log(`✅ Stats API: ${metrics.responseTime}ms | Size: ${formatBytes(metrics.responseSize)}`);
    addLog(`Stats fetched: ${metrics.responseTime}ms (${formatBytes(metrics.responseSize)})`);

    const { vendors, customers, transactions, business } = data.stats;
  
    // Display company info if available
    if (data.company) {
      const companyInfoEl = document.getElementById('company-info');
      const companyNameEl = document.getElementById('company-name-display');
      const companyGuidEl = document.getElementById('company-guid-display');
      
      if (companyInfoEl && companyNameEl && companyGuidEl) {
        companyNameEl.textContent = data.company.name || 'Unknown';
        companyGuidEl.textContent = data.company.guid || '-';
        companyInfoEl.style.display = 'block';
      }
    }
    
    if (businessNameEl) {
      businessNameEl.textContent = (business && business.name) || 'Unknown business';
    }
    if (businessIdEl) {
      businessIdEl.textContent = business?.id ? `ID: ${business.id}` : 'ID unavailable';
    }
    vendorCount.textContent = vendors.total_vendors || 0;
    vendorAmount.textContent = formatCurrency(vendors.total_payables || 0);
    customerCount.textContent = customers.total_customers || 0;
    customerAmount.textContent = formatCurrency(Math.abs(customers.total_receivables || 0));
    
    // Don't fetch Sales Group Summary here - it will be fetched at the end of loadDashboardData
    // to ensure it takes precedence over any other sales calculations

    const syncCandidates = [
      vendors.last_vendor_sync,
      customers.last_customer_sync,
      transactions ? transactions.last_transaction_sync : null,
      data.stats.last_sync
    ].filter(Boolean).map(date => new Date(date).getTime());

    if (syncCandidates.length) {
      const syncDate = new Date(Math.max(...syncCandidates));
      const diffMinutes = Math.floor((Date.now() - syncDate.getTime()) / 60000);
      if (diffMinutes < 1) lastSync.textContent = 'Just now';
      else if (diffMinutes < 60) lastSync.textContent = `${diffMinutes} min ago`;
      else lastSync.textContent = syncDate.toLocaleTimeString();
    }

    addLog('Stats updated');
  } catch (error) {
    const errorMsg = error.message || error.toString();
    console.error('❌ Stats fetch error:', errorMsg);
    console.error('   API URL:', `${API_URL}/stats`);
    console.error('   Full error:', error);
    addLog(`❌ Stats fetch failed: ${errorMsg}`);
    throw error;
  }
}

async function fetchCustomers() {
  try {
    console.log(`📡 Fetching customers from: ${API_URL}/customers`);
    const result = await measureApiCall(`${API_URL}/customers`);
    const { data, metrics } = result;
    
    if (!data.success) {
      const errorMsg = data.error || 'Customer API failed';
      console.error('❌ Customers API returned error:', errorMsg);
      throw new Error(errorMsg);
    }

    customersCache = data.customers || [];
    performanceMetrics.lastCustomersFetch = metrics;
    console.log(`✅ Customers API: ${metrics.responseTime}ms | Records: ${customersCache.length} | Size: ${formatBytes(metrics.responseSize)}`);
    addLog(`Customers fetched: ${metrics.responseTime}ms | ${customersCache.length} records (${formatBytes(metrics.responseSize)})`);
    
    renderSalesBreakdown();
    updateFormula();
  } catch (error) {
    const errorMsg = error.message || error.toString();
    console.error('❌ Customers fetch error:', errorMsg);
    console.error('   API URL:', `${API_URL}/customers`);
    addLog(`❌ Customers fetch failed: ${errorMsg}`);
    throw error;
  }
}

async function fetchTransactions(page = 1, limit = 50) {
  try {
    const url = `${API_URL}/transactions?page=${page}&limit=${limit}`;
    console.log(`📡 Fetching transactions page ${page} (${limit} per page)...`);
    
    const result = await measureApiCall(url);
    const { data, metrics } = result;
    
    if (!data.success) throw new Error(data.error || 'Transaction API failed');

    // Update pagination state
    txCurrentPage = data.page || 1;
    txPageSize = data.limit || limit;
    txTotalPages = data.totalPages || 1;
    txTotalRecords = data.totalRecords || 0;
    transactionsPaginated = data.transactions || [];
    
    // Also update legacy cache for backward compatibility
    transactionsCache = transactionsPaginated;
    
    performanceMetrics.lastTransactionsFetch = metrics;
    console.log(`📊 Transactions API: ${metrics.responseTime}ms | Page: ${txCurrentPage}/${txTotalPages} | Records: ${transactionsPaginated.length}/${txTotalRecords} | Size: ${formatBytes(metrics.responseSize)}`);
    addLog(`📄 Transactions: ${metrics.responseTime}ms | Page ${txCurrentPage}/${txTotalPages} (${transactionsPaginated.length} of ${txTotalRecords.toLocaleString()} records)`);
    
    // Build customer activity map from current page
    customerActivityMap = new Map();
    transactionsPaginated.forEach(tx => {
      if (!tx.party_name || !tx.date) return;
      const txDate = new Date(tx.date);
      const existing = customerActivityMap.get(tx.party_name);
      if (!existing || txDate > existing) {
        customerActivityMap.set(tx.party_name, txDate);
      }
    });
    
    renderSalesBreakdown();
    updateFormula();
    renderTransactionsWithPagination();
    
    return data;
  } catch (error) {
    console.error('Transactions fetch error:', error);
    if (transactionsList) {
      transactionsList.innerHTML = `<p class="no-data" style="color: #ff6347;">❌ Error: ${error.message}</p>`;
    }
    throw error;
  }
}

// Render transactions with pagination controls
function renderTransactionsWithPagination() {
  if (!transactionsList) return;

  if (!transactionsPaginated || transactionsPaginated.length === 0) {
    transactionsList.innerHTML = '<p class="no-data">No transactions found on this page</p>';
    renderTxPaginationControls();
    return;
  }

  // Render transaction table
  let html = `
    <div class="transactions-table-container">
      <table class="transaction-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Voucher #</th>
            <th>Party</th>
            <th>Amount</th>
            <th>Narration</th>
          </tr>
        </thead>
        <tbody>
  `;

  transactionsPaginated.forEach(txn => {
    const date = new Date(txn.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const amount = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(Math.abs(txn.amount));
    const amountClass = txn.amount >= 0 ? 'amount-positive' : 'amount-negative';
    const narration = txn.narration ? (txn.narration.length > 40 ? txn.narration.substring(0, 40) + '...' : txn.narration) : '-';

    html += `
      <tr>
        <td>${date}</td>
        <td><span class="voucher-type-badge">${txn.voucher_type || 'Unknown'}</span></td>
        <td>${txn.voucher_number || '-'}</td>
        <td class="party-name">${txn.party_name || '-'}</td>
        <td class="${amountClass}">${amount}</td>
        <td class="narration" title="${txn.narration || ''}">${narration}</td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  transactionsList.innerHTML = html;

  // Render pagination controls
  renderTxPaginationControls();
}

// Render pagination controls for transactions
function renderTxPaginationControls() {
  // Find or create pagination container
  let paginationContainer = document.getElementById('transactions-pagination');
  
  if (!paginationContainer) {
    const transactionsCard = transactionsList?.closest('.card');
    if (transactionsCard) {
      paginationContainer = document.createElement('div');
      paginationContainer.id = 'transactions-pagination';
      paginationContainer.className = 'pagination-controls';
      transactionsCard.appendChild(paginationContainer);
    } else {
      return; // Can't add pagination without parent card
    }
  }

  // Build pagination HTML
  const html = `
    <div class="pagination-info">
      <span class="pagination-page">Page ${txCurrentPage} of ${txTotalPages}</span>
      <span class="pagination-count">${txTotalRecords.toLocaleString()} total transactions</span>
    </div>
    <div class="pagination-buttons">
      <button class="pagination-btn" onclick="goToTxPage(1)" ${txCurrentPage === 1 ? 'disabled' : ''}>
        ⏮️ First
      </button>
      <button class="pagination-btn" onclick="goToTxPage(${txCurrentPage - 1})" ${txCurrentPage === 1 ? 'disabled' : ''}>
        ◀️ Prev
      </button>
      <span class="page-numbers">
        ${generateTxPageNumbers()}
      </span>
      <button class="pagination-btn" onclick="goToTxPage(${txCurrentPage + 1})" ${txCurrentPage >= txTotalPages ? 'disabled' : ''}>
        Next ▶️
      </button>
      <button class="pagination-btn" onclick="goToTxPage(${txTotalPages})" ${txCurrentPage >= txTotalPages ? 'disabled' : ''}>
        Last ⏭️
      </button>
    </div>
    <div class="pagination-pagesize">
      <label>Show:</label>
      <select id="tx-pagesize-select" onchange="changeTxPageSize(this.value)">
        <option value="25" ${txPageSize === 25 ? 'selected' : ''}>25</option>
        <option value="50" ${txPageSize === 50 ? 'selected' : ''}>50</option>
        <option value="100" ${txPageSize === 100 ? 'selected' : ''}>100</option>
        <option value="200" ${txPageSize === 200 ? 'selected' : ''}>200</option>
      </select>
      <span>per page</span>
    </div>
  `;

  paginationContainer.innerHTML = html;
}

// Generate page number buttons (show current +/- 2 pages)
function generateTxPageNumbers() {
  if (txTotalPages <= 1) return `<button class="page-number active">1</button>`;
  
  let pages = [];
  const startPage = Math.max(1, txCurrentPage - 2);
  const endPage = Math.min(txTotalPages, txCurrentPage + 2);

  if (startPage > 1) {
    pages.push('<span class="page-ellipsis">...</span>');
  }

  for (let i = startPage; i <= endPage; i++) {
    pages.push(`
      <button class="page-number ${i === txCurrentPage ? 'active' : ''}" onclick="goToTxPage(${i})">
        ${i}
      </button>
    `);
  }

  if (endPage < txTotalPages) {
    pages.push('<span class="page-ellipsis">...</span>');
  }

  return pages.join('');
}

// Navigation functions for transactions pagination
function goToTxPage(page) {
  if (page < 1 || page > txTotalPages || page === txCurrentPage) return;
  addLog(`📄 Loading transactions page ${page}...`);
  fetchTransactions(page, txPageSize);
}

function changeTxPageSize(newSize) {
  txPageSize = parseInt(newSize);
  txCurrentPage = 1; // Reset to first page
  addLog(`📏 Changed page size to ${txPageSize}`);
  fetchTransactions(1, txPageSize);
}

// Make pagination functions globally available
window.goToTxPage = goToTxPage;
window.changeTxPageSize = changeTxPageSize;

async function fetchAging() {
  try {
    const result = await measureApiCall(`${API_URL}/analytics/aging`);
    const { data, metrics } = result;
    
    if (!data.success) throw new Error('Aging API failed');

    agingData = data.data || [];
    performanceMetrics.lastAgingFetch = metrics;
    console.log(`📊 Aging API: ${metrics.responseTime}ms | Records: ${agingData.length} | Size: ${formatBytes(metrics.responseSize)}`);
    addLog(`Aging analysis: ${metrics.responseTime}ms | ${agingData.length} records (${formatBytes(metrics.responseSize)})`);
    
    agingPage = 1;
    renderAging();
  } catch (error) {
    console.error('Aging fetch error:', error);
    throw error;
  }
}

async function renderPerformanceDashboard() {
  if (!performanceDashboard) return;
  performanceDashboard.innerHTML = '<p class="loading">Loading performance metrics...</p>';

  try {
    const { data } = await measureApiCall(`${API_URL}/dashboard/performance`);
    if (!data.success) {
      performanceDashboard.innerHTML = '<p class="no-data">Performance data unavailable</p>';
      return;
    }

    const stats = data.stats || [];
    const history = data.history || [];

    const statCards = stats.length
      ? stats.map(stat => {
          const totalSyncs = Number(stat.total_syncs) || 0;
          const avgDuration = stat.avg_duration ? Math.round(Number(stat.avg_duration) / 1000) : 0;
          const avgRecords = stat.avg_records ? Math.round(Number(stat.avg_records)) : 0;
          const successRate = totalSyncs
            ? (((totalSyncs - (Number(stat.error_count) || 0)) / totalSyncs) * 100).toFixed(1)
            : '0.0';

          return `
            <div class="performance-card">
              <h4>${stat.data_type || 'Unknown'}</h4>
              <div class="metric">
                <span class="label">Avg Duration</span>
                <span class="value">${avgDuration}s</span>
              </div>
              <div class="metric">
                <span class="label">Avg Records</span>
                <span class="value">${avgRecords.toLocaleString()}</span>
              </div>
              <div class="metric">
                <span class="label">Success Rate</span>
                <span class="value">${successRate}%</span>
              </div>
            </div>
          `;
        }).join('')
      : '<p class="no-data">No sync stats yet</p>';

    const historyRows = history.slice(0, 6).map(entry => {
      const when = entry.last_sync_at ? new Date(entry.last_sync_at).toLocaleString() : '—';
      const duration = entry.sync_duration_ms ? `${Math.round(entry.sync_duration_ms / 1000)}s` : '—';
      const hoursAgo = typeof entry.hours_ago === 'number' ? `${entry.hours_ago.toFixed(1)}h ago` : '';
      return `
        <tr>
          <td>${entry.data_type || 'Unknown'}</td>
          <td>${when}</td>
          <td>${duration}</td>
          <td>${entry.sync_mode || 'N/A'}</td>
          <td>${hoursAgo}</td>
        </tr>
      `;
    }).join('');

    const historyTable = historyRows
      ? `
        <table class="analytics-table">
          <thead>
            <tr>
              <th>Data Type</th>
              <th>Last Sync</th>
              <th>Duration</th>
              <th>Mode</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${historyRows}</tbody>
        </table>
      `
      : '<p class="no-data">No recent syncs yet</p>';

    performanceDashboard.innerHTML = `
      <div class="performance-cards">${statCards}</div>
      ${historyTable}
    `;
  } catch (error) {
    console.error('Performance dashboard error:', error);
    performanceDashboard.innerHTML = '<p class="no-data">Performance data unavailable</p>';
  }
}

async function renderPaymentPatterns() {
  if (!paymentPatternsContainer) return;
  paymentPatternsContainer.innerHTML = '<p class="loading">Loading payment patterns...</p>';

  try {
    const { data } = await measureApiCall(`${API_URL}/analytics/payment-patterns`);
    if (!data.success || !data.patterns?.length) {
      paymentPatternsContainer.innerHTML = '<p class="no-data">No payment patterns yet</p>';
      return;
    }

    const rows = data.patterns.map(pattern => {
      const avgCycle = Math.round(pattern.avg_payment_cycle || 0);
      const reliability = Math.max(0, Math.min(100, pattern.reliability_score || 0));
      const riskClass = pattern.risk_level === 'high' ? 'risk-high' :
        pattern.risk_level === 'medium' ? 'risk-medium' : 'risk-low';
      const nextPayment = pattern.predicted_next_payment
        ? new Date(pattern.predicted_next_payment).toLocaleDateString()
        : '—';
      const lastPayment = pattern.last_payment_date
        ? new Date(pattern.last_payment_date).toLocaleDateString()
        : '—';
      const statusLabel = pattern.days_overdue > 0 ? `${pattern.days_overdue}d overdue` : 'On track';

      return `
        <tr>
          <td><strong>${pattern.party_name}</strong></td>
          <td>${avgCycle} days</td>
          <td>
            <div class="reliability-bar">
              <div class="reliability-fill" style="width: ${reliability}%"></div>
            </div>
            <span>${reliability}%</span>
          </td>
          <td>${lastPayment}</td>
          <td>${nextPayment}</td>
          <td><span class="risk-badge ${riskClass}">${statusLabel}</span></td>
        </tr>
      `;
    }).join('');

    paymentPatternsContainer.innerHTML = `
      <table class="analytics-table payment-patterns-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Payment Cycle</th>
            <th>Reliability</th>
            <th>Last Payment</th>
            <th>Next Expected</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (error) {
    console.error('Payment patterns error:', error);
    paymentPatternsContainer.innerHTML = '<p class="no-data">Unable to load payment patterns</p>';
  }
}

async function renderRevenueTrends() {
  if (!revenueTrendsContainer) return;
  revenueTrendsContainer.innerHTML = '<p class="loading">Loading revenue trends...</p>';

  try {
    const { data } = await measureApiCall(`${API_URL}/analytics/revenue-trends`);
    if (!data.success) {
      revenueTrendsContainer.innerHTML = '<p class="no-data">Revenue trends unavailable</p>';
      return;
    }

    const trends = data.trends || [];
    const summary = data.summary || {};
    const forecast = data.forecast || [];

    const trendRows = trends.map(row => {
      const monthLabel = row.month ? new Date(row.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'Month';
      const growth = typeof row.growth_rate === 'number' && isFinite(row.growth_rate)
        ? `${row.growth_rate.toFixed(1)}%`
        : '—';
      return `
        <tr>
          <td>${monthLabel}</td>
          <td>${formatCurrency(row.revenue || 0)}</td>
          <td>${row.unique_customers || 0}</td>
          <td>${row.transaction_count || 0}</td>
          <td>${growth}</td>
        </tr>
      `;
    }).join('');

    const forecastCards = forecast.map(item => {
      const label = item.month ? new Date(item.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'Upcoming';
      return `
        <div class="forecast-card">
          <span class="summary-label">${label}</span>
          <strong>${formatCurrency(item.forecasted_revenue || 0)}</strong>
        </div>
      `;
    }).join('');

    revenueTrendsContainer.innerHTML = `
      <div class="overdue-summary">
        <div class="summary-tile">
          <span>Current Month</span>
          <strong>${formatCurrency(summary.current_month || 0)}</strong>
        </div>
        <div class="summary-tile">
          <span>Avg Monthly</span>
          <strong>${formatCurrency(summary.avg_monthly || 0)}</strong>
        </div>
        <div class="summary-tile">
          <span>Growth Rate</span>
          <strong class="trend-chip">${typeof summary.growth_rate === 'number' ? summary.growth_rate.toFixed(1) + '% MoM' : '—'}</strong>
        </div>
      </div>
      ${trends.length ? `
        <table class="analytics-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Revenue</th>
              <th>Unique Customers</th>
              <th>Transactions</th>
              <th>Growth</th>
            </tr>
          </thead>
          <tbody>${trendRows}</tbody>
        </table>
      ` : '<p class="no-data">No revenue data yet</p>'}
      ${forecastCards ? `<div class="forecast-list">${forecastCards}</div>` : ''}
    `;
  } catch (error) {
    console.error('Revenue trends error:', error);
    revenueTrendsContainer.innerHTML = '<p class="no-data">Revenue trends unavailable</p>';
  }
}

async function renderCollectionPriority() {
  if (!collectionPriorityContainer) return;
  collectionPriorityContainer.innerHTML = '<p class="loading">Loading priority list...</p>';

  try {
    const { data } = await measureApiCall(`${API_URL}/analytics/collection-priority`);
    if (!data.success || !data.priorities?.length) {
      collectionPriorityContainer.innerHTML = '<p class="no-data">No collections pending</p>';
      return;
    }

    const rows = data.priorities.map(item => {
      const risk = Number(item.risk_score) || 0;
      const riskClass = risk > 70 ? 'risk-high' : risk > 40 ? 'risk-medium' : 'risk-low';
      const daysSince = item.days_since_payment ? `${Math.round(item.days_since_payment)}d` : '—';
      return `
        <tr>
          <td><strong>${item.name}</strong></td>
          <td>${formatCurrency(item.total_outstanding || 0)}</td>
          <td>${formatCurrency(item.current_over_90_days || 0)}</td>
          <td>${daysSince}</td>
          <td><span class="risk-badge ${riskClass}">${Math.round(risk)}%</span></td>
        </tr>
      `;
    }).join('');

    collectionPriorityContainer.innerHTML = `
      <table class="analytics-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Outstanding</th>
            <th>90+ Bucket</th>
            <th>Days Since Payment</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (error) {
    console.error('Collection priority error:', error);
    collectionPriorityContainer.innerHTML = '<p class="no-data">Unable to load collection priorities</p>';
  }
}

async function renderOverdueAnalysis() {
  if (!overdueAnalysisContainer) return;
  overdueAnalysisContainer.innerHTML = '<p class="loading">Loading overdue analysis...</p>';

  try {
    const { data } = await measureApiCall(`${API_URL}/analytics/overdue-analysis`);
    if (!data.success) {
      overdueAnalysisContainer.innerHTML = '<p class="no-data">Overdue analysis unavailable</p>';
      return;
    }

    const summary = data.data?.summary || {};
    const top = data.data?.top_overdue || [];

    const summaryTiles = `
      <div class="summary-tile">
        <span>Total Overdue</span>
        <strong>${formatCurrency(summary.total_overdue || 0)}</strong>
      </div>
      <div class="summary-tile">
        <span>31-60 Days</span>
        <strong>${formatCurrency(summary.overdue_30_60 || 0)}</strong>
      </div>
      <div class="summary-tile">
        <span>61-90 Days</span>
        <strong>${formatCurrency(summary.overdue_60_90 || 0)}</strong>
      </div>
      <div class="summary-tile">
        <span>90+ Days</span>
        <strong>${formatCurrency(summary.overdue_90_plus || 0)}</strong>
      </div>
      <div class="summary-tile">
        <span>Customers</span>
        <strong>${summary.overdue_customers || 0}</strong>
      </div>
    `;

    const rows = Array.isArray(top) && top.length
      ? top.map(item => `
        <tr>
          <td>${item.entity_name}</td>
          <td>${formatCurrency(item.overdue_amount || 0)}</td>
          <td>${formatCurrency(item.current_31_60_days || 0)}</td>
          <td>${formatCurrency(item.current_61_90_days || 0)}</td>
          <td>${formatCurrency(item.current_over_90_days || 0)}</td>
        </tr>
      `).join('')
      : '';

    overdueAnalysisContainer.innerHTML = `
      <div class="overdue-summary">${summaryTiles}</div>
      ${rows ? `
        <table class="analytics-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Overdue Total</th>
              <th>31-60</th>
              <th>61-90</th>
              <th>90+</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<p class="no-data">No overdue customers</p>'}
    `;
  } catch (error) {
    console.error('Overdue analysis error:', error);
    overdueAnalysisContainer.innerHTML = '<p class="no-data">Overdue analysis unavailable</p>';
  }
}

async function loadAdvancedAnalytics() {
  const loaders = [
    renderPerformanceDashboard(),
    renderRevenueTrends(),
    renderCollectionPriority(),
    renderOverdueAnalysis(),
    renderPaymentPatterns()
  ];
  await Promise.allSettled(loaders);
}

function renderRecentTransactions() {
  if (!transactionsList) return;

  if (!transactionsCache.length) {
    transactionsList.innerHTML = '<p class="no-data">No transactions synced yet</p>';
    return;
  }

  const rows = transactionsCache.slice(0, 5).map(tx => {
    const title = tx.party_name || 'Unnamed voucher';
    const voucherMeta = [
      tx.voucher_type || 'Voucher',
      tx.voucher_number ? `#${tx.voucher_number}` : null
    ].filter(Boolean).join(' • ');
    const itemDetails = [];
    if (tx.item_name) itemDetails.push(tx.item_name);
    if (tx.item_code) itemDetails.push(`Code ${tx.item_code}`);
    const itemMeta = itemDetails.length
      ? `<p class="transaction-meta small">${itemDetails.join(' • ')}</p>`
      : '';
    const displayDate = tx.date ? new Date(tx.date).toLocaleDateString() : 'No date';

    return `
      <div class="transaction-row">
        <div>
          <strong>${title}</strong>
          <p class="transaction-meta">${voucherMeta || 'Voucher'}</p>
          ${itemMeta}
        </div>
        <div class="transaction-right">
          <span class="transaction-amount">${formatCurrency(tx.amount)}</span>
          <span class="transaction-date">${displayDate}</span>
        </div>
      </div>
    `;
  }).join('');

  transactionsList.innerHTML = rows;
}

async function runTransactionSearch(auto = false) {
  if (!txSearchResults) return;
  if (auto && txSearchHasRun) return;

  const params = new URLSearchParams();
  const addParam = (key, value) => {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, value);
    }
  };

  addParam('party', txPartyInput?.value.trim());
  addParam('voucherNumber', txVoucherInput?.value.trim());
  addParam('fromDate', txFromDateInput?.value);
  addParam('toDate', txToDateInput?.value);
  addParam('minAmount', txMinAmountInput?.value);
  addParam('maxAmount', txMaxAmountInput?.value);
  addParam('voucherType', txVoucherTypeInput?.value.trim());
  params.append('limit', 25);

  const queryString = params.toString();
  const url = queryString ? `${API_URL}/transactions/search?${queryString}` : `${API_URL}/transactions/search`;

  txSearchResults.innerHTML = '<p class="loading">Searching transactions...</p>';

  try {
    const { data } = await measureApiCall(url);
    if (!data.success) {
      txSearchResults.innerHTML = '<p class="no-data">Search unavailable</p>';
      return;
    }

    if (!data.transactions || !data.transactions.length) {
      txSearchResults.innerHTML = '<p class="no-data">No transactions match your filters</p>';
      return;
    }

    const rows = data.transactions.map(tx => {
      const voucherMeta = [
        tx.voucher_type || 'Voucher',
        tx.voucher_number ? `#${tx.voucher_number}` : null
      ].filter(Boolean).join(' �?� ');
      const displayDate = tx.date ? new Date(tx.date).toLocaleDateString() : 'No date';
      return `
        <tr>
          <td>${tx.party_name || 'Unnamed'}</td>
          <td>${voucherMeta}</td>
          <td>${formatCurrency(tx.amount)}</td>
          <td>${displayDate}</td>
          <td>${tx.narration || ''}</td>
        </tr>
      `;
    }).join('');

    txSearchResults.innerHTML = `
      <table class="analytics-table">
        <thead>
          <tr>
            <th>Party</th>
            <th>Voucher</th>
            <th>Amount</th>
            <th>Date</th>
            <th>Narration</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    txSearchHasRun = true;
  } catch (error) {
    console.error('Transaction search error:', error);
    txSearchResults.innerHTML = '<p class="no-data">Search failed. Try again.</p>';
  }
}

function renderSalesBreakdown() {
  if (!customersCache.length) {
    salesBreakdown.innerHTML = '<p class="no-data">No customer data yet</p>';
    // Only update sales total if we don't have Sales Group Summary data
    if (!salesGroupSummaryData && salesTotal) {
      salesTotal.textContent = formatCurrency(0);
    }
    salesPillValue.textContent = formatCurrency(0);
    return;
  }

  const overallTotal = customersCache.reduce((sum, customer) => {
    return sum + Math.max(Number(customer.current_balance) || 0, 0);
  }, 0);
  
  // DON'T overwrite sales total if we have Sales Group Summary data from Tally
  // The Sales Group Summary shows the actual sales amount, not customer receivables
  if (!salesGroupSummaryData && salesTotal) {
    salesTotal.textContent = formatCurrency(overallTotal);
  }

  let dataset = customersCache.map(customer => ({
    name: customer.name,
    amount: Math.max(Number(customer.current_balance) || 0, 0),
    opening: Number(customer.opening_balance) || 0,
    lastActivity: customerActivityMap.get(customer.name)
  }));

  const amountFilter = customerAmountFilter?.value || 'all';
  dataset = dataset.filter(item => {
    if (amountFilter === 'high') return item.amount >= 25000;
    if (amountFilter === 'mid') return item.amount >= 10000 && item.amount < 25000;
    if (amountFilter === 'low') return item.amount > 0 && item.amount < 10000;
    return true;
  });

  const activityFilter = customerActivityFilter?.value || 'all';
  dataset = dataset.filter(item => {
    if (!item.lastActivity) return activityFilter === 'dormant';
    const days = (Date.now() - item.lastActivity.getTime()) / 86400000;
    if (activityFilter === 'active') return days <= 30;
    if (activityFilter === 'dormant') return days > 30;
    return true;
  });

  if (!dataset.length) {
    salesBreakdown.innerHTML = '<p class="no-data">No customers match the selected filters</p>';
    salesPillValue.textContent = formatCurrency(0);
    return;
  }

  const filteredTotal = dataset.reduce((sum, item) => sum + item.amount, 0);
  salesPillValue.textContent = formatCurrency(filteredTotal);

  const rows = dataset.slice(0, 8).map(customer => {
    const lastSeen = customer.lastActivity
      ? `Updated ${customer.lastActivity.toLocaleDateString()}`
      : 'No recent activity';
    return `
      <div class="sales-row">
        <div>
          <strong>${customer.name}</strong>
          <p class="sales-meta">${lastSeen}</p>
        </div>
        <span>${formatCurrency(customer.amount)}</span>
      </div>
    `;
  }).join('');

  salesBreakdown.innerHTML = rows;
}

function renderAging() {
  if (!agingData.length) {
    agingContainer.innerHTML = '<p class="no-data">No aging data available yet</p>';
    updateAgingPagination(0);
    updateCollectionTarget(null);
    return;
  }

  let filtered = agingData.filter(item => {
    if (agingFilter === 'vendors') return item.entity_type === 'vendor';
    if (agingFilter === 'customers') return item.entity_type === 'customer';
    return true;
  });

  const searchTerm = agingNameFilter?.value.trim().toLowerCase() || '';
  if (searchTerm) {
    filtered = filtered.filter(item =>
      (item.entity_name || '').toLowerCase().includes(searchTerm)
    );
  }

  if (!filtered.length) {
    const message = searchTerm ? 'No names match this search' : 'No records for this filter';
    agingContainer.innerHTML = `<p class="no-data">${message}</p>`;
    updateAgingPagination(0);
    updateCollectionTarget(null);
    return;
  }

  const totalPages = Math.ceil(filtered.length / AGING_PAGE_SIZE);
  agingPage = Math.max(1, Math.min(agingPage, totalPages));
  const start = (agingPage - 1) * AGING_PAGE_SIZE;
  const entries = filtered.slice(start, start + AGING_PAGE_SIZE).map(item => `
    <div class="aging-item">
      <div class="aging-header">
        <p class="aging-entity-name">${item.entity_name || 'Unnamed'}</p>
        <p class="aging-total">${formatCurrency(item.total_outstanding)}</p>
      </div>
      <div class="aging-breakdown">
        <div class="aging-bucket">
          <p class="bucket-label">0-30 Days</p>
          <p class="bucket-amount">${formatCurrency(item.current_0_30_days)}</p>
        </div>
        <div class="aging-bucket">
          <p class="bucket-label">31-60 Days</p>
          <p class="bucket-amount">${formatCurrency(item.current_31_60_days)}</p>
        </div>
        <div class="aging-bucket">
          <p class="bucket-label">61-90 Days</p>
          <p class="bucket-amount">${formatCurrency(item.current_61_90_days)}</p>
        </div>
        <div class="aging-bucket">
          <p class="bucket-label">90+ Days</p>
          <p class="bucket-amount">${formatCurrency(item.current_over_90_days)}</p>
        </div>
      </div>
    </div>
  `).join('');

  agingContainer.innerHTML = entries;
  updateCollectionTarget(filtered);
  updateAgingPagination(totalPages);
}

function updateAgingPagination(totalPages) {
  if (!agingPagination) return;
  if (totalPages <= 1) {
    agingPagination.innerHTML = '';
    agingPagination.style.display = 'none';
    return;
  }

  agingPagination.style.display = 'flex';
  const maxButtons = AGING_MAX_VISIBLE_PAGES;
  const halfWindow = Math.floor(maxButtons / 2);
  let startPage = Math.max(1, agingPage - halfWindow);
  let endPage = startPage + maxButtons - 1;

  if (endPage > totalPages) {
    endPage = totalPages;
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  const buttons = [];
  for (let page = startPage; page <= endPage; page += 1) {
    buttons.push(`
      <button class="aging-page-btn ${page === agingPage ? 'active' : ''}" data-page="${page}">
        ${page}
      </button>
    `);
  }

  agingPagination.innerHTML = buttons.join('');
  agingPagination.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => {
      const nextPage = Number(button.dataset.page);
      if (nextPage === agingPage) return;
      agingPage = nextPage;
      renderAging();
    });
  });
}

function updateCollectionTarget(data) {
  if (!collectionCustomer || !collectionCountdown) return;
  const list = data || [];
  if (!list.length) {
    collectionCustomer.textContent = '--';
    collectionAmount.textContent = formatCurrency(0);
    collectionCountdown.textContent = '--';
    collectionNote.textContent = 'Awaiting analytics';
    clearInterval(collectionTimerInterval);
    return;
  }

  const candidates = list.filter(item => item.entity_type === 'customer' && item.total_outstanding > 0);
  const ordered = (candidates.length ? candidates : list).slice().sort((a, b) => {
    const aValue = (a.current_0_30_days || 0) + (a.current_31_60_days || 0);
    const bValue = (b.current_0_30_days || 0) + (b.current_31_60_days || 0);
    return bValue - aValue;
  });
  const target = ordered[0];
  const dueAmount = target.current_0_30_days || target.current_31_60_days || target.current_61_90_days || target.current_over_90_days || target.total_outstanding;

  const baseDate = target.calculated_at ? new Date(target.calculated_at) : new Date();
  const bucketLabel = target.current_0_30_days > 0 ? '0-30 days' :
    target.current_31_60_days > 0 ? '31-60 days' :
      target.current_61_90_days > 0 ? '61-90 days' : '90+ days';
  const bucketDays = bucketLabel === '0-30 days' ? 30 :
    bucketLabel === '31-60 days' ? 60 :
      bucketLabel === '61-90 days' ? 90 : 120;
  const dueDate = new Date(baseDate.getTime() + bucketDays * 86400000);

  collectionCustomer.textContent = target.entity_name || 'Unnamed';
  collectionAmount.textContent = formatCurrency(dueAmount);
  collectionNote.textContent = `${bucketLabel} bucket`;
  collectionTarget = { dueDate };
  startCollectionCountdown();
}

function startCollectionCountdown() {
  if (!collectionCountdown || !collectionTarget) return;
  clearInterval(collectionTimerInterval);

  const update = () => {
    const diff = collectionTarget.dueDate.getTime() - Date.now();
    if (diff <= 0) {
      collectionCountdown.textContent = 'Due now';
      return;
    }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    collectionCountdown.textContent = `${days}d ${hours}h ${minutes}m`;
  };

  update();
  collectionTimerInterval = setInterval(update, 60000);
}

function updateFormula() {
  if (!customersCache.length) {
    formulaOpening.textContent = formatCurrency(0);
    formulaSales.textContent = formatCurrency(0);
    formulaReceipts.textContent = formatCurrency(0);
    formulaClosing.textContent = formatCurrency(0);
    return;
  }

  const opening = customersCache.reduce((sum, customer) => sum + (Number(customer.opening_balance) || 0), 0);
  const closing = customersCache.reduce((sum, customer) => sum + Math.max(Number(customer.current_balance) || 0, 0), 0);
  const receipts = transactionsCache
    .filter(tx => (tx.voucher_type || '').toLowerCase().includes('receipt'))
    .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  const salesPlusGST = Math.max(closing + receipts - opening, 0);

  formulaOpening.textContent = formatCurrency(opening);
  formulaSales.textContent = formatCurrency(salesPlusGST);
  formulaReceipts.textContent = formatCurrency(receipts);
  formulaClosing.textContent = formatCurrency(closing);
}

async function fetchAIInsights(force = false) {
  if (aiInsightsLoaded && !force) return;
  if (!aiInsightsStatus) return;

  aiInsightsStatus.textContent = 'Loading insights...';
  aiInsightsStatus.classList.remove('hidden');
  aiInsightsList.innerHTML = '';

  try {
    const response = await fetch(`${AI_API_URL}/ai/insights`);
    const data = await response.json();
    const insights = data.success ? (data.insights || []) : [];
    displayAIInsights(insights);
    aiInsightsLoaded = true;
    aiInsightsStatus.textContent = `Updated at ${new Date().toLocaleTimeString()}`;
    addLog('AI insights fetched on demand');
  } catch (error) {
    console.error('Error fetching AI insights:', error);
    aiInsightsStatus.textContent = 'Failed to load AI insights';
  }
}

function displayAIInsights(insights = []) {
  if (!aiInsightsList) return;
  if (!insights.length) {
    aiInsightsList.innerHTML = '<p class="no-data">No AI insights yet</p>';
    return;
  }

  aiInsightsList.innerHTML = insights.map(insight => {
    const riskLevel = (insight.risk_level || insight.severity || 'analysis').toLowerCase();
    const riskColor = riskLevel === 'low' ? '#4CAF50' :
      riskLevel === 'medium' ? '#FF9800' : '#F44336';
    const heading = insight.vendor_name || insight.title || 'Business Insight';
    const description = insight.description || insight.insight || insight.text || 'No description provided';
    return `
      <div class="ai-insight-item">
        <div class="ai-insight-header">
          <strong>${heading}</strong>
          <span class="ai-risk-badge" style="background:${riskColor}">
            ${riskLevel.toUpperCase()}
          </span>
        </div>
        <div class="ai-insight-text">${description.replace(/\n/g, '<br>')}</div>
      </div>
    `;
  }).join('');
}

async function askAIQuestion(question) {
  // Gather context from the current dashboard state
  const context = {
    vendors: {
      count: vendorCount.textContent,
      payables: vendorAmount.textContent
    },
    customers: {
      count: customerCount.textContent,
      receivables: customerAmount.textContent,
      totalSales: salesTotal.textContent
    },
    recentTransactions: transactionsCache.slice(0, 5).map(t =>
      `${t.party_name}: ${formatCurrency(t.amount)} (${t.voucher_type})`
    ).join(', '),
    topCustomers: customersCache.slice(0, 5).map(c =>
      `${c.name}: ${formatCurrency(c.current_balance)}`
    ).join(', ')
  };

  const contextString = `
    Context:
    - Total Payables: ${context.vendors.payables} (${context.vendors.count} vendors)
    - Total Receivables: ${context.customers.receivables} (${context.customers.count} customers)
    - Total Sales: ${context.customers.totalSales}
    - Recent Transactions: ${context.recentTransactions}
    - Top Customers: ${context.topCustomers}
    
    User Question: ${question}
  `.trim();

  console.log('Sending to AI:', contextString);

  const url = `${AI_API_URL}/ai/chat?question=${encodeURIComponent(contextString)}`;
  const response = await fetch(url, { method: 'POST' });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.detail || data.error || 'AI service unavailable');
  }
  return data.answer || data.message || 'No answer returned';
}

// Progress polling for transaction sync
let progressInterval = null;

async function pollSyncProgress() {
  try {
    const response = await fetch(`${API_URL}/sync/progress`);
    const progress = await response.json();
    
    if (progress.transaction.inProgress) {
      const { current, total, percentage, currentBatch, totalBatches, estimatedTimeRemaining } = progress.transaction;
      
      let timeStr = '';
      if (estimatedTimeRemaining && estimatedTimeRemaining > 0) {
        const seconds = Math.round(estimatedTimeRemaining / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        timeStr = minutes > 0 ? `~${minutes}m ${remainingSeconds}s left` : `~${seconds}s left`;
      }
      
      // Update button with clear percentage
      const percentDisplay = percentage || Math.round((current / Math.max(total, 1)) * 100);
      syncBtn.textContent = `Syncing... 💰 ${percentDisplay}% ${timeStr}`;
      
      // Update log with batch info (replace previous progress log)
      const batchInfo = totalBatches > 1 ? ` (batch ${currentBatch}/${totalBatches})` : '';
      addLog(`📊 Transactions: ${current}/${total} (${percentDisplay}%)${batchInfo} ${timeStr}`, true);
    }
  } catch (error) {
    // Silently ignore polling errors during sync
  }
}

function startProgressPolling() {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(pollSyncProgress, 1000); // Poll every second
}

function stopProgressPolling() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

async function syncNow() {
  // Check if auto-sync is running
  if (lastAutoSyncStatus.isRunning) {
    addLog('⚠️ Cannot start manual sync - auto-sync is running');
    alert('Auto-sync is currently running. Please wait for it to complete.');
    return;
  }
  
  // Mark manual sync as running
  isManualSyncRunning = true;
  const manualSyncStartTime = Date.now();
  setSyncButtonState('manual-sync');
  addLog('🔄 Starting MANUAL sync...');

  try {
    // Notify backend that manual sync is starting (to delay auto-sync)
    await fetch(`${API_URL}/sync/manual-start`, { method: 'POST' }).catch(() => {});
    
    // Sync groups (required for accurate Sales Accounts calculation)
    syncBtn.textContent = 'Syncing... 📊 groups';
    addLog('📊 Syncing groups from Tally...');
    const groupsResponse = await fetch(`${API_URL}/sync/groups`, { method: 'POST' });
    const groupsData = await groupsResponse.json();
    if (groupsData.success) {
      addLog(`📊 Groups: ${groupsData.count || 0} synced`);
    } else {
      addLog(`⚠️ Groups sync: ${groupsData.error || 'Failed'}`);
    }
    
    // Sync ledgers (required for accurate Sales Accounts calculation)
    syncBtn.textContent = 'Syncing... 📋 ledgers';
    addLog('📋 Syncing ledgers from Tally...');
    const ledgersResponse = await fetch(`${API_URL}/sync/ledgers`, { method: 'POST' });
    const ledgersData = await ledgersResponse.json();
    if (ledgersData.success) {
      addLog(`📋 Ledgers: ${ledgersData.count || 0} synced`);
    } else {
      addLog(`⚠️ Ledgers sync: ${ledgersData.error || 'Failed'}`);
    }
    
    // Sync vendors
    syncBtn.textContent = 'Syncing... 📦 vendors';
    const vendorResponse = await fetch(`${API_URL}/sync/vendors`, { method: 'POST' });
    const vendorData = await vendorResponse.json();
    if (!vendorData.success) {
      throw new Error(vendorData.error || 'Vendor sync failed');
    }
    addLog(`📦 Vendors: ${vendorData.count || 0} synced`);
    
    // Sync customers
    syncBtn.textContent = 'Syncing... 👥 customers';
    const customerResponse = await fetch(`${API_URL}/sync/customers`, { method: 'POST' });
    const customerData = await customerResponse.json();
    if (!customerData.success) {
      throw new Error(customerData.error || 'Customer sync failed');
    }
    addLog(`👥 Customers: ${customerData.count || 0} synced`);
    
    // Sync transactions with progress tracking
    syncBtn.textContent = 'Syncing... 💰 transactions (0%)';
    addLog('💰 Syncing transactions...');
    startProgressPolling(); // Start polling for progress updates
    
    const transactionResponse = await fetch(`${API_URL}/sync/transactions`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({}) 
    });
    
    stopProgressPolling(); // Stop polling when done
    
    if (!transactionResponse.ok) {
      const errorText = await transactionResponse.text();
      throw new Error(`Transaction sync failed: ${errorText}`);
    }
    
    const transactionData = await transactionResponse.json();
    if (!transactionData.success) {
      throw new Error(transactionData.error || 'Transaction sync failed');
    }
    
    // Build informative sync message with mode indicator
    const syncMode = transactionData.syncMode || 'full';
    const modeEmoji = syncMode === 'incremental' ? '⚡' : '📦';
    const modeLabel = syncMode === 'incremental' ? 'INCREMENTAL' : 'FULL';
    const syncMsg = `${modeEmoji} Transactions: ${transactionData.count || 0} synced (${modeLabel})`;
    const periodMsg = transactionData.period ? ` [${transactionData.period.from} → ${transactionData.period.to}]` : '';
    const durationMsg = transactionData.duration ? ` in ${transactionData.duration}` : '';
    const errorMsg = transactionData.errorCount > 0 ? ` [${transactionData.errorCount} errors]` : '';
    addLog(syncMsg + periodMsg + durationMsg + errorMsg);
    
    // Calculate analytics
    syncBtn.textContent = 'Syncing... 📊 analytics';
    await fetch(`${API_URL}/analytics/calculate`, { method: 'POST' });
    addLog('📊 Analytics refreshed');

    const totalManualDuration = Date.now() - manualSyncStartTime;
    lastManualSyncTime = Date.now();
    aiInsightsLoaded = false;
    addLog(`✅ MANUAL sync completed in ${formatDuration(totalManualDuration)}`);
    
    // Notify backend that manual sync completed (to delay next auto-sync)
    await fetch(`${API_URL}/sync/manual-complete`, { method: 'POST' }).catch(() => {});
    
    await loadDashboardData();
  } catch (error) {
    console.error('Sync error:', error);
    stopProgressPolling();
    const totalManualDuration = Date.now() - manualSyncStartTime;
    addLog(`❌ MANUAL sync failed after ${formatDuration(totalManualDuration)}: ${error.message}`);
    
    // Check if it's a company mismatch error
    if (error.message.includes('Company mismatch')) {
      const errorMsg = error.message.replace(/\n/g, '\n');
      if (confirm(`${errorMsg}\n\nWould you like to change company selection?`)) {
        window.location.href = 'setup.html';
      }
    } else {
      alert(`Sync Error: ${error.message}\n\nMake sure:\n1. The correct company is open in Tally\n2. Tally ODBC is enabled\n3. You selected the matching company in the setup wizard`);
    }
  } finally {
    stopProgressPolling();
    isManualSyncRunning = false;
    setSyncButtonState('normal');
  }
}

async function loadDashboardData() {
  const loadStartTime = performance.now();
  
  try {
    await fetchStats();
    await fetchCustomers();
    await fetchTransactions();
    await fetchAging();
    
    // Fetch Sales Group Summary LAST to ensure it takes precedence
    // This will overwrite any sales values set by other functions
    await fetchSalesGroupSummary();
    await loadAdvancedAnalytics();
    
    const loadEndTime = performance.now();
    const totalLoadTime = Math.round(loadEndTime - loadStartTime);
    console.log(`⏱️  Total Dashboard Load Time: ${totalLoadTime}ms`);
    addLog(`✅ Dashboard loaded in ${totalLoadTime}ms`);
    
    // Display comprehensive performance metrics
    displayPerformanceMetrics();
    runTransactionSearch(true);
  } catch (error) {
    const loadEndTime = performance.now();
    const totalLoadTime = Math.round(loadEndTime - loadStartTime);
    console.error(`❌ Dashboard load failed after ${totalLoadTime}ms:`, error);
    throw error;
  }
}

async function refresh() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Refreshing...';
  await loadDashboardData();
  refreshBtn.disabled = false;
  refreshBtn.textContent = 'Refresh';
}

syncBtn.addEventListener('click', syncNow);
refreshBtn.addEventListener('click', refresh);

// ==================== AUTO-SYNC STATUS MONITORING ====================

let autoSyncPollInterval = null;
let lastAutoSyncStatus = { isRunning: false };

// Format duration in human readable format
function formatDuration(ms) {
  if (!ms) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// Track manual sync state to avoid conflicts
let isManualSyncRunning = false;
let lastManualSyncTime = null;

// Poll for auto-sync status
async function pollAutoSyncStatus() {
  try {
    // Skip polling if manual sync is running - don't interfere with it
    if (isManualSyncRunning) {
      return;
    }
    
    const response = await fetch(`${API_URL}/sync/auto-status`);
    const data = await response.json();
    
    if (data.success && data.autoSync) {
      const status = data.autoSync;
      
      // Check if auto-sync just started
      if (status.isRunning && !lastAutoSyncStatus.isRunning) {
        addLog('🔄 AUTO-SYNC started in background...');
        setSyncButtonState('auto-sync');
      }
      
      // Update button and log during auto-sync (only if not manually syncing)
      if (status.isRunning && !isManualSyncRunning) {
        const elapsed = formatDuration(status.elapsedMs);
        const stepEmoji = {
          'vendors': '📦',
          'customers': '👥',
          'transactions': '💰',
          'analytics': '📊',
          'starting': '🔄'
        }[status.currentStep] || '🔄';
        
        syncBtn.textContent = `Auto-Syncing... ${stepEmoji} ${status.currentStep || ''} (${elapsed})`;
        syncBtn.disabled = true;
      }
      
      // Check if auto-sync just completed
      if (!status.isRunning && lastAutoSyncStatus.isRunning) {
        const duration = formatDuration(status.lastDuration);
        if (status.lastError) {
          addLog(`❌ AUTO-SYNC failed: ${status.lastError}`);
        } else {
          // Show detailed results
          const results = status.results || {};
          const vendorCount = results.vendors?.count || 0;
          const customerCount = results.customers?.count || 0;
          const txCount = results.transactions?.count || 0;
          const txMode = results.transactions?.mode || 'full';
          const modeEmoji = txMode === 'incremental' ? '⚡' : '📦';
          
          addLog(`✅ AUTO-SYNC completed in ${duration}`);
          addLog(`   ${modeEmoji} Tx: ${txCount} (${txMode}) | V: ${vendorCount} | C: ${customerCount}`);
        }
        setSyncButtonState('normal');
        // Refresh dashboard after auto-sync completes
        await loadDashboardData();
      }
      
      // Show next sync time info
      if (!status.isRunning && status.nextSyncIn) {
        const nextSyncMins = Math.ceil(status.nextSyncIn / 60000);
        if (nextSyncMins > 0 && nextSyncMins <= 5) {
          syncBtn.title = `Next auto-sync in ~${nextSyncMins} minute${nextSyncMins > 1 ? 's' : ''}`;
        }
      }
      
      lastAutoSyncStatus = status;
    }
  } catch (error) {
    // Don't spam console with polling errors
    if (!error.message.includes('fetch')) {
      console.error('Error polling auto-sync status:', error);
    }
  }
}

// Set sync button state based on sync type
function setSyncButtonState(state) {
  switch (state) {
    case 'auto-sync':
      syncBtn.disabled = true;
      syncBtn.textContent = 'Auto-Syncing...';
      syncBtn.style.opacity = '0.7';
      syncBtn.style.cursor = 'not-allowed';
      syncBtn.style.background = 'linear-gradient(135deg, #6c757d 0%, #495057 100%)';
      syncBtn.title = 'Auto-sync is running in background. Please wait...';
      break;
    case 'manual-sync':
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing...';
      syncBtn.style.opacity = '0.9';
      syncBtn.style.cursor = 'wait';
      syncBtn.style.background = '';
      syncBtn.title = 'Manual sync in progress...';
      break;
    case 'normal':
    default:
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
      syncBtn.style.opacity = '1';
      syncBtn.style.cursor = 'pointer';
      syncBtn.style.background = '';
      syncBtn.title = 'Click to sync data from Tally';
      break;
  }
}

// Start polling for auto-sync status
function startAutoSyncPolling() {
  if (autoSyncPollInterval) clearInterval(autoSyncPollInterval);
  autoSyncPollInterval = setInterval(pollAutoSyncStatus, 2000); // Poll every 2 seconds
  pollAutoSyncStatus(); // Poll immediately
}

// Stop polling
function stopAutoSyncPolling() {
  if (autoSyncPollInterval) {
    clearInterval(autoSyncPollInterval);
    autoSyncPollInterval = null;
  }
}

// Start auto-sync polling when app loads
startAutoSyncPolling();

// Settings button - reset setup and show setup wizard
document.getElementById('settings-btn')?.addEventListener('click', () => {
  if (confirm('Do you want to change company settings? This will reset the current company and show the setup wizard.')) {
    fetch(`${API_URL}/company/reset`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          console.log('✅ Company config reset successfully');
          // Redirect to setup wizard
          window.location.href = 'setup.html';
        } else {
          throw new Error(data.error || 'Failed to reset');
        }
      })
      .catch(err => {
        console.error('Reset error:', err);
        alert('Error resetting settings: ' + err.message + '\n\nYou can manually delete config.json file to reset.');
      });
  }
});
aiQueryForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = aiQuestionInput.value.trim();
  if (!question) return;

  aiQuerySubmit.disabled = true;
  aiQuerySubmit.textContent = 'Thinking...';
  aiAnswerBox.classList.remove('hidden');
  aiAnswerBox.textContent = 'Analyzing your Tally data...';

  try {
    const answer = await askAIQuestion(question);
    aiAnswerBox.textContent = answer;
  } catch (error) {
    console.error('AI chat error:', error);
    aiAnswerBox.textContent = `Could not fetch an answer: ${error.message}`;
  } finally {
    aiQuerySubmit.disabled = false;
    aiQuerySubmit.textContent = 'Ask AI';
  }
});

async function init() {
  addLog('Application started');
  console.log('🚀 Initializing application...');
  console.log(`📍 Current API_URL: ${API_URL}`);
  
  // Wait for API_URL to be initialized (max 3 seconds)
  let waitTime = 0;
  while (!apiUrlInitialized && waitTime < 3000) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waitTime += 100;
  }
  
  // Ensure API_URL is set (double-check)
  if (window.electronAPI && window.electronAPI.getApiUrl) {
    try {
      const newApiUrl = await window.electronAPI.getApiUrl();
      if (newApiUrl && newApiUrl !== API_URL) {
        API_URL = newApiUrl;
        console.log('✅ API URL updated from main process:', API_URL);
      }
    } catch (error) {
      console.warn('⚠️ Could not get API URL from main process, using default:', error);
    }
  }
  
  console.log(`🔗 Final API_URL: ${API_URL}`);
  
  // Test connection with retries (5 attempts, 1 second apart)
  console.log('🔍 Starting connection test...');
  const connected = await testConnection(5, 1000);
  
  if (!connected) {
    // If still not connected, try to load data anyway (maybe test endpoint has issues)
    console.warn('⚠️ Connection test failed, but attempting to load data anyway...');
    addLog('Connection test failed, trying to fetch data...');
    
    // Try to fetch stats directly to see if server is actually up
    try {
      const testResponse = await fetch(`${API_URL}/stats`);
      if (testResponse.ok) {
        console.log('✅ Server is actually responding! Connection test may have false negative.');
        if (connectionStatus) {
          connectionStatus.textContent = 'Connected to Tally';
          connectionStatus.style.color = '#28a745';
        }
        // Server is up, proceed with data loading
        await loadDashboardData();
        setInterval(loadDashboardData, 30000);
        return;
      }
    } catch (directError) {
      console.error('❌ Direct API call also failed:', directError);
    }
    
    // If still not connected, retry with longer intervals
    addLog('Retrying connection in 5 seconds...');
    setTimeout(() => {
      testConnection(3, 2000).then(connected => {
        if (connected) {
          loadDashboardData().catch(error => {
            console.error('Error loading dashboard:', error);
            addLog('Failed to load data: ' + error.message);
          });
          setInterval(loadDashboardData, 30000);
        } else {
          addLog('❌ Still unable to connect. Check if server is running on port 3000.');
        }
      });
    }, 5000);
    return;
  }

  // Connection successful, load data
  console.log('✅ Connection successful, loading dashboard data...');
  try {
    await loadDashboardData();
    console.log('✅ Dashboard data loaded successfully');
  } catch (error) {
    console.error('❌ Error loading dashboard:', error);
    addLog('Failed to load data: ' + error.message);
    // Show error in connection status
    if (connectionStatus) {
      connectionStatus.textContent = 'Connected but data fetch failed';
      connectionStatus.style.color = '#ff9800';
    }
  }

  setInterval(loadDashboardData, 30000);
}

// Diagnostic function - can be called from console: window.checkServerStatus()
window.checkServerStatus = async function() {
  console.log('\n🔍 ===== SERVER DIAGNOSTICS =====');
  console.log(`📍 API URL: ${API_URL}`);
  console.log(`🔗 Test endpoint: ${API_URL}/test`);
  console.log(`📊 Stats endpoint: ${API_URL}/stats`);
  
  // Test connection
  try {
    const start = performance.now();
    const response = await fetch(`${API_URL}/test`);
    const time = Math.round(performance.now() - start);
    const data = await response.json();
    console.log(`✅ Test endpoint: OK (${time}ms)`);
    console.log(`   Response:`, data);
  } catch (error) {
    console.error(`❌ Test endpoint: FAILED`);
    console.error(`   Error:`, error.message);
  }
  
  // Test stats
  try {
    const start = performance.now();
    const response = await fetch(`${API_URL}/stats`);
    const time = Math.round(performance.now() - start);
    const data = await response.json();
    console.log(`✅ Stats endpoint: OK (${time}ms)`);
    console.log(`   Success:`, data.success);
    if (!data.success) {
      console.error(`   Error:`, data.error);
    }
  } catch (error) {
    console.error(`❌ Stats endpoint: FAILED`);
    console.error(`   Error:`, error.message);
  }
  
  console.log('================================\n');
};

init();

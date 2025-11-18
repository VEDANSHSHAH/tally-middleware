// API base URLs
const API_URL = 'http://localhost:8000/api';
const AI_API_URL = 'https://tally-middleware-production-7856.up.railway.app';

// Core DOM elements
const connectionStatus = document.getElementById('connection-status');
const lastSync = document.getElementById('last-sync');
const vendorCount = document.getElementById('vendor-count');
const vendorAmount = document.getElementById('vendor-amount');
const customerCount = document.getElementById('customer-count');
const customerAmount = document.getElementById('customer-amount');
const salesTotal = document.getElementById('sales-total');
const salesPillValue = document.getElementById('sales-pill-value');
const salesBreakdown = document.getElementById('sales-breakdown');
const agingContainer = document.getElementById('aging-container');
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
let aiInsightsLoaded = false;
let collectionTarget = null;
let collectionTimerInterval = null;

// Logging helper
function addLog(message) {
  const entry = document.createElement('p');
  entry.className = 'log-entry';
  entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  logEntries.insertBefore(entry, logEntries.firstChild);
  while (logEntries.children.length > 12) {
    logEntries.removeChild(logEntries.lastChild);
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

agingTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    agingTabs.forEach(btn => btn.classList.remove('active'));
    tab.classList.add('active');
    agingFilter = tab.dataset.view;
    renderAging();
  });
});

customerAmountFilter?.addEventListener('change', () => renderSalesBreakdown());
customerActivityFilter?.addEventListener('change', () => renderSalesBreakdown());

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

async function testConnection() {
  try {
    const response = await fetch(`${API_URL}/test`);
    const data = await response.json();
    if (data.message) {
      connectionStatus.textContent = 'Connected to Tally';
      connectionStatus.style.color = '#28a745';
      addLog('Connected to backend server');
      return true;
    }
  } catch (error) {
    console.error('Connection test failed:', error);
  }

  connectionStatus.textContent = 'Connection Failed';
  connectionStatus.style.color = '#dc3545';
  addLog('Failed to connect to backend');
  return false;
}

async function fetchStats() {
  const response = await fetch(`${API_URL}/stats`);
  const data = await response.json();
  if (!data.success) throw new Error('Stats request failed');

  const { vendors, customers, transactions } = data.stats;
  vendorCount.textContent = vendors.total_vendors || 0;
  vendorAmount.textContent = formatCurrency(vendors.total_payables || 0);
  customerCount.textContent = customers.total_customers || 0;
  customerAmount.textContent = formatCurrency(Math.abs(customers.total_receivables || 0));

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
}

async function fetchCustomers() {
  const response = await fetch(`${API_URL}/customers`);
  const data = await response.json();
  if (!data.success) throw new Error('Customer API failed');

  customersCache = data.customers || [];
  renderSalesBreakdown();
  updateFormula();
  addLog('Sales snapshot refreshed');
}

async function fetchTransactions() {
  const response = await fetch(`${API_URL}/transactions?limit=500`);
  const data = await response.json();
  if (!data.success) throw new Error('Transaction API failed');

  transactionsCache = data.transactions || [];
  customerActivityMap = new Map();
  transactionsCache.forEach(tx => {
    if (!tx.party_name || !tx.date) return;
    const txDate = new Date(tx.date);
    const existing = customerActivityMap.get(tx.party_name);
    if (!existing || txDate > existing) {
      customerActivityMap.set(tx.party_name, txDate);
    }
  });
  renderSalesBreakdown();
  updateFormula();
}

async function fetchAging() {
  const response = await fetch(`${API_URL}/analytics/aging`);
  const data = await response.json();
  if (!data.success) throw new Error('Aging API failed');

  agingData = data.data || [];
  renderAging();
  addLog('Aging analysis loaded');
}

function renderSalesBreakdown() {
  if (!customersCache.length) {
    salesBreakdown.innerHTML = '<p class="no-data">No customer data yet</p>';
    salesTotal.textContent = formatCurrency(0);
    salesPillValue.textContent = formatCurrency(0);
    return;
  }

  const overallTotal = customersCache.reduce((sum, customer) => {
    return sum + Math.max(Number(customer.current_balance) || 0, 0);
  }, 0);
  salesTotal.textContent = formatCurrency(overallTotal);

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
    updateCollectionTarget(null);
    return;
  }

  const filtered = agingData.filter(item => {
    if (agingFilter === 'vendors') return item.entity_type === 'vendor';
    if (agingFilter === 'customers') return item.entity_type === 'customer';
    return true;
  });

  if (!filtered.length) {
    agingContainer.innerHTML = '<p class="no-data">No records for this filter</p>';
    updateCollectionTarget(null);
    return;
  }

  const entries = filtered.slice(0, 5).map(item => `
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
  updateCollectionTarget(agingData);
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
  const url = `${AI_API_URL}/ai/chat?question=${encodeURIComponent(question)}`;
  const response = await fetch(url, { method: 'POST' });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.detail || data.error || 'AI service unavailable');
  }
  return data.answer || data.message || 'No answer returned';
}

async function syncNow() {
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing...';
  addLog('Starting manual sync');

  try {
    await fetch(`${API_URL}/sync/vendors`, { method: 'POST' });
    await fetch(`${API_URL}/sync/customers`, { method: 'POST' });
    await fetch(`${API_URL}/sync/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    await fetch(`${API_URL}/analytics/calculate`, { method: 'POST' });

    aiInsightsLoaded = false;
    addLog('Sync completed');
    await loadDashboardData();
  } catch (error) {
    console.error('Sync error:', error);
    addLog(`Sync failed: ${error.message}`);
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  }
}

async function loadDashboardData() {
  await fetchStats();
  await fetchCustomers();
  await fetchTransactions();
  await fetchAging();
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
  const connected = await testConnection();
  if (!connected) {
    addLog('Retrying connection in 5 seconds');
    setTimeout(init, 5000);
    return;
  }

  try {
    await loadDashboardData();
  } catch (error) {
    console.error('Error loading dashboard:', error);
    addLog('Failed to load data: ' + error.message);
  }

  setInterval(loadDashboardData, 30000);
}

init();

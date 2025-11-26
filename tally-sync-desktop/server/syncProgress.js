// Sync progress tracking module
// Allows real-time progress monitoring for long-running sync operations

const syncProgress = {
  transaction: {
    inProgress: false,
    total: 0,
    current: 0,
    percentage: 0,
    startTime: null,
    estimatedTimeRemaining: null,
    currentBatch: 0,
    totalBatches: 0
  },
  customer: {
    inProgress: false,
    total: 0,
    current: 0,
    percentage: 0
  },
  vendor: {
    inProgress: false,
    total: 0,
    current: 0,
    percentage: 0
  }
};

function updateProgress(type, data) {
  if (!syncProgress[type]) return;
  
  Object.assign(syncProgress[type], data);
  
  // Calculate percentage
  if (data.total && data.current !== undefined) {
    syncProgress[type].percentage = Math.round((data.current / data.total) * 100);
  }
  
  // Calculate estimated time remaining
  if (data.startTime && data.current > 0 && data.total > 0) {
    const elapsed = Date.now() - data.startTime;
    const rate = data.current / elapsed; // items per ms
    const remaining = data.total - data.current;
    syncProgress[type].estimatedTimeRemaining = Math.round(remaining / rate); // ms
  }
}

function getProgress(type) {
  return type ? syncProgress[type] : syncProgress;
}

function resetProgress(type) {
  if (type && syncProgress[type]) {
    syncProgress[type] = {
      inProgress: false,
      total: 0,
      current: 0,
      percentage: 0,
      startTime: null,
      estimatedTimeRemaining: null,
      currentBatch: 0,
      totalBatches: 0
    };
  }
}

module.exports = {
  updateProgress,
  getProgress,
  resetProgress
};


// Simple in-memory cache implementation for API responses
// TTL-based expiration with automatic cleanup
// Includes size limits and memory monitoring to prevent crashes on low-memory devices

class Cache {
  constructor() {
    this.cache = new Map();
    this.timers = new Map();
    this.MAX_CACHE_SIZE_MB = 100; // Max 100MB per cache entry
    this.MAX_TOTAL_CACHE_MB = 500; // Max 500MB total cache
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null if expired/not found
   */
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    // Check if expired
    if (Date.now() > item.expiresAt) {
      this.delete(key);
      return null;
    }

    return item.value;
  }

  /**
   * Calculate size of data in MB
   * @param {any} data - Data to calculate size for
   * @returns {number} - Size in MB
   */
  calculateSizeMB(data) {
    const jsonString = JSON.stringify(data);
    const bytes = new Blob([jsonString]).size;
    return bytes / (1024 * 1024); // Convert to MB
  }

  /**
   * Get total cache size in MB
   * @returns {number} - Total cache size in MB
   */
  getTotalCacheSizeMB() {
    let totalSize = 0;
    this.cache.forEach(item => {
      if (item.sizeMB) {
        totalSize += item.sizeMB;
      }
    });
    return totalSize;
  }

  /**
   * Check available memory
   * @returns {object} - Memory info
   */
  checkMemory() {
    const memUsage = process.memoryUsage();
    const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
    const heapTotalMB = memUsage.heapTotal / (1024 * 1024);
    const heapLimitMB = memUsage.rss / (1024 * 1024); // Approximate heap limit
    
    return {
      heapUsedMB: Math.round(heapUsedMB),
      heapTotalMB: Math.round(heapTotalMB),
      heapLimitMB: Math.round(heapLimitMB),
      percentUsed: Math.round((heapUsedMB / heapTotalMB) * 100)
    };
  }

  /**
   * Set value in cache with TTL
   * Smart caching: Skips cache if data is too large or memory is low
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlMs - Time to live in milliseconds
   * @returns {boolean} - True if cached, false if skipped
   */
  set(key, value, ttlMs = 300000) { // Default 5 minutes
    // Calculate size of data
    const sizeMB = this.calculateSizeMB(value);
    
    // Check if data is too large for a single cache entry
    if (sizeMB > this.MAX_CACHE_SIZE_MB) {
      console.log(`⚠️  Cache skipped for ${key}: Data too large (${Math.round(sizeMB)}MB > ${this.MAX_CACHE_SIZE_MB}MB limit)`);
      console.log(`   → Using database instead of cache for this request`);
      return false;
    }

    // Check total cache size
    const totalCacheSize = this.getTotalCacheSizeMB();
    if (totalCacheSize + sizeMB > this.MAX_TOTAL_CACHE_MB) {
      console.log(`⚠️  Cache skipped for ${key}: Total cache would exceed limit (${Math.round(totalCacheSize + sizeMB)}MB > ${this.MAX_TOTAL_CACHE_MB}MB)`);
      console.log(`   → Using database instead of cache for this request`);
      return false;
    }

    // Check available memory
    const memInfo = this.checkMemory();
    if (memInfo.percentUsed > 80) {
      console.log(`⚠️  Cache skipped for ${key}: Memory usage high (${memInfo.percentUsed}% - ${memInfo.heapUsedMB}MB/${memInfo.heapTotalMB}MB)`);
      console.log(`   → Using database instead of cache to prevent memory issues`);
      return false;
    }

    // Clear existing timer if any
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    const expiresAt = Date.now() + ttlMs;
    this.cache.set(key, { value, expiresAt, sizeMB });

    // Set timer to auto-delete
    const timer = setTimeout(() => {
      this.delete(key);
    }, ttlMs);
    this.timers.set(key, timer);

    console.log(`✅ Cached ${key}: ${Math.round(sizeMB * 100) / 100}MB (Total cache: ${Math.round((totalCacheSize + sizeMB) * 100) / 100}MB/${this.MAX_TOTAL_CACHE_MB}MB)`);
    return true;
  }

  /**
   * Delete a cache entry
   * @param {string} key - Cache key
   */
  delete(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear() {
    // Clear all timers
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    this.cache.clear();
  }

  /**
   * Delete all entries matching a pattern
   * @param {string} pattern - Pattern to match (e.g., 'stats:*')
   */
  deletePattern(pattern) {
    const regex = new RegExp(pattern.replace('*', '.*'));
    const keysToDelete = [];
    
    this.cache.forEach((_, key) => {
      if (regex.test(key)) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => this.delete(key));
  }

  /**
   * Get cache statistics
   * @returns {object} - Cache stats
   */
  getStats() {
    const now = Date.now();
    let expired = 0;
    let active = 0;

    this.cache.forEach(item => {
      if (Date.now() > item.expiresAt) {
        expired++;
      } else {
        active++;
      }
    });

    const memInfo = this.checkMemory();
    const totalCacheSizeMB = this.getTotalCacheSizeMB();

    return {
      total: this.cache.size,
      active,
      expired,
      timers: this.timers.size,
      totalCacheSizeMB: Math.round(totalCacheSizeMB * 100) / 100,
      maxCacheSizeMB: this.MAX_CACHE_SIZE_MB,
      maxTotalCacheMB: this.MAX_TOTAL_CACHE_MB,
      memory: memInfo
    };
  }
}

// Export singleton instance
const cache = new Cache();

module.exports = cache;


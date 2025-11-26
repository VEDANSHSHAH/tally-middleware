# Smart Cache & Sync Date Range Fix

## Problems Fixed

### Problem 1: Cache Memory Overflow on Low-Memory Devices
**Issue**: Cache had no size limits, could crash devices with limited RAM

**Before**:
```javascript
// No size checks - cached everything regardless of size
cache.set(key, value, ttlMs);
// Could cache 500MB+ datasets and crash the app
```

**After**:
```javascript
// Smart caching with size limits and memory monitoring
cache.set(key, value, ttlMs);
// - Checks data size before caching
// - Checks total cache size
// - Checks available memory
// - Skips cache if any limit exceeded
// - Falls back to database (slower but safe)
```

### Problem 2: Missing Data When Syncing After Long Periods
**Issue**: Only last 14 days synced by default - missed data if not synced for 50+ days

**Before**:
```javascript
// Always synced only last 14 days
const fromDate = startDate || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

// Example: Last sync 50 days ago
// → Only last 14 days synced
// → 36 days of data LOST! ❌
```

**After**:
```javascript
// Syncs from last_sync date - gets ALL unsynced data
const lastSyncResult = await pool.query(
  'SELECT last_sync FROM companies WHERE company_guid = $1',
  [companyGuid]
);

if (lastSyncResult.rows[0]?.last_sync) {
  fromDate = lastSyncResult.rows[0].last_sync;
}

// Example: Last sync 50 days ago
// → Syncs all 50 days
// → NO data lost! ✅
```

---

## Smart Cache Implementation

### Cache Limits

```javascript
MAX_CACHE_SIZE_MB = 100;      // Max 100MB per cache entry
MAX_TOTAL_CACHE_MB = 500;     // Max 500MB total cache
```

### Size Check

```javascript
calculateSizeMB(data) {
  const jsonString = JSON.stringify(data);
  const bytes = new Blob([jsonString]).size;
  return bytes / (1024 * 1024);
}
```

### Memory Monitoring

```javascript
checkMemory() {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
  const heapTotalMB = memUsage.heapTotal / (1024 * 1024);
  const percentUsed = (heapUsedMB / heapTotalMB) * 100;
  
  return { heapUsedMB, heapTotalMB, percentUsed };
}
```

### Smart Caching Logic

```javascript
set(key, value, ttlMs = 300000) {
  // 1. Calculate size
  const sizeMB = this.calculateSizeMB(value);
  
  // 2. Check if too large for single entry
  if (sizeMB > this.MAX_CACHE_SIZE_MB) {
    console.log(`⚠️  Cache skipped: Data too large (${sizeMB}MB > 100MB)`);
    return false; // Use database instead
  }
  
  // 3. Check total cache size
  const totalCacheSize = this.getTotalCacheSizeMB();
  if (totalCacheSize + sizeMB > this.MAX_TOTAL_CACHE_MB) {
    console.log(`⚠️  Cache skipped: Would exceed limit (${totalCacheSize + sizeMB}MB > 500MB)`);
    return false; // Use database instead
  }
  
  // 4. Check available memory
  const memInfo = this.checkMemory();
  if (memInfo.percentUsed > 80) {
    console.log(`⚠️  Cache skipped: Memory high (${memInfo.percentUsed}%)`);
    return false; // Use database to prevent crash
  }
  
  // 5. Safe to cache
  this.cache.set(key, { value, expiresAt, sizeMB });
  console.log(`✅ Cached ${key}: ${sizeMB}MB`);
  return true;
}
```

---

## Smart Sync Date Range

### Database Schema

```sql
CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  company_guid VARCHAR(255) UNIQUE NOT NULL,
  company_name VARCHAR(500) NOT NULL,
  last_sync TIMESTAMP,  -- Tracks last successful sync
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Sync Logic

```javascript
// 1. Check if user specified date range
if (startDate) {
  fromDate = startDate; // Use user's date
} else {
  // 2. Check last sync date from database
  const lastSyncResult = await pool.query(
    'SELECT last_sync FROM companies WHERE company_guid = $1',
    [companyGuid]
  );

  if (lastSyncResult.rows[0]?.last_sync) {
    // 3. Sync from last sync date (ALL unsynced data)
    fromDate = lastSyncResult.rows[0].last_sync;
    console.log(`📅 Last sync: ${fromDate} - syncing all data since then`);
  } else {
    // 4. First sync - sync last 365 days (1 year)
    fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    console.log(`📅 First sync - syncing last 365 days`);
    console.log(`   💡 To sync older data, use date range picker`);
  }
}

// 5. After successful sync, update last_sync timestamp
await pool.query(
  'UPDATE companies SET last_sync = NOW() WHERE company_guid = $1',
  [companyGuid]
);
```

---

## Usage Examples

### Example 1: Normal Device, Small Dataset

```
Request: GET /api/customers
Data size: 5MB
Total cache: 20MB
Memory: 40% used

✅ Cached (5MB) - Fast response (8ms)
```

### Example 2: Low-Memory Device, Large Dataset

```
Request: GET /api/transactions (50,000 records)
Data size: 150MB (exceeds 100MB limit)
Memory: 75% used

⚠️  Cache skipped: Data too large (150MB > 100MB limit)
→ Using database instead (slower but safe)
→ No crash! ✅
```

### Example 3: High Memory Usage

```
Request: GET /api/customers
Data size: 30MB
Total cache: 100MB
Memory: 85% used (high!)

⚠️  Cache skipped: Memory usage high (85%)
→ Using database to prevent crash
→ No crash! ✅
```

### Example 4: First Sync Ever

```
Status: Never synced before
Action: Click "Sync Now"

📅 First sync detected - syncing last 365 days (from 2024-11-24)
💡 To sync older data, use date range picker

✅ Synced 1,234 transactions
✅ Updated last_sync timestamp
```

### Example 5: Regular Sync (Last synced 7 days ago)

```
Status: Last synced on 2025-11-17
Action: Click "Sync Now" (no date range specified)

📅 Last sync was on 2025-11-17 - syncing all data since then
📅 Syncing transactions from 2025-11-17 to 2025-11-24

✅ Synced 234 transactions (last 7 days)
✅ Updated last_sync timestamp
```

### Example 6: Long Gap (Last synced 50 days ago)

```
Status: Last synced on 2025-10-05
Action: Click "Sync Now"

📅 Last sync was on 2025-10-05 - syncing all data since then
📅 Syncing transactions from 2025-10-05 to 2025-11-24

✅ Synced 5,678 transactions (ALL 50 days)
✅ NO data lost! ✅
✅ Updated last_sync timestamp
```

---

## Benefits

### Smart Cache

1. **Prevents Crashes**:
   - Won't cache datasets larger than 100MB
   - Monitors memory usage (skips cache if >80%)
   - Safe for low-memory devices

2. **Falls Back Gracefully**:
   - Large datasets → Use database (slower but safe)
   - High memory → Use database (prevents crash)
   - Logs warning so user knows

3. **Efficient for Normal Use**:
   - Small datasets (< 100MB) → Fast cache
   - Normal memory → Fast cache
   - Large datasets → Database (slower but safe)

### Smart Sync

1. **No Data Loss**:
   - Syncs from last_sync date
   - Gets ALL unsynced data
   - No 14-day limit

2. **Efficient**:
   - Only syncs new data (not already synced)
   - Reduces API calls to Tally
   - Faster sync times

3. **Flexible**:
   - User can still specify custom date range
   - First sync gets last 365 days (not overwhelming)
   - Can manually sync older data via date picker

---

## Migration Guide

### No Changes Required!

The fixes are **backward compatible**:

1. **Cache**:
   - Existing cache keys work as before
   - Just adds safety checks
   - No code changes needed

2. **Sync**:
   - Uses existing `last_sync` column
   - Falls back to 365 days if no last_sync
   - No schema changes needed

### Database Update (Automatic)

```sql
-- Already exists in schema
CREATE TABLE companies (
  ...
  last_sync TIMESTAMP,
  ...
);
```

No migration needed - column already exists!

---

## Configuration

### Adjusting Cache Limits

Edit `tally-sync-desktop/server/cache.js`:

```javascript
this.MAX_CACHE_SIZE_MB = 100;  // Change to 50 for very low-memory devices
this.MAX_TOTAL_CACHE_MB = 500; // Change to 200 for very low-memory devices
```

### Adjusting Memory Threshold

Edit `tally-sync-desktop/server/cache.js`:

```javascript
if (memInfo.percentUsed > 80) {  // Change to 70 for more conservative
  console.log(`⚠️  Cache skipped: Memory high`);
  return false;
}
```

### Adjusting First Sync Range

Edit `tally-sync-desktop/server/server.js`:

```javascript
// Change 365 to 180 for 6 months, or 90 for 3 months
fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
```

---

## Testing

### Test 1: Large Dataset Cache Skip

```bash
# Generate 100,000 transactions (should skip cache)
npm run dev
# Click "Sync Now"
# Check console for: "⚠️ Cache skipped: Data too large"
```

### Test 2: Low Memory Cache Skip

```bash
# Run app with limited memory
node --max-old-space-size=512 tally-sync-desktop/server/server.js
# Load large dataset
# Check console for: "⚠️ Cache skipped: Memory high"
```

### Test 3: First Sync

```sql
-- Clear last_sync
UPDATE companies SET last_sync = NULL WHERE company_guid = 'your-guid';
```

```bash
# Click "Sync Now"
# Should sync last 365 days
# Check console for: "📅 First sync detected - syncing last 365 days"
```

### Test 4: Regular Sync

```bash
# After first sync, sync again
# Should only sync new data since last_sync
# Check console for: "📅 Last sync was on YYYY-MM-DD - syncing all data since then"
```

---

## Monitoring

### Check Cache Stats

```bash
curl http://localhost:3000/api/cache/stats
```

Response:
```json
{
  "total": 5,
  "active": 5,
  "expired": 0,
  "timers": 5,
  "totalCacheSizeMB": 45.23,
  "maxCacheSizeMB": 100,
  "maxTotalCacheMB": 500,
  "memory": {
    "heapUsedMB": 234,
    "heapTotalMB": 512,
    "percentUsed": 45
  }
}
```

### Check Last Sync Time

```sql
SELECT company_name, last_sync, 
       NOW() - last_sync AS time_since_last_sync
FROM companies;
```

---

## Summary

| Fix | Before | After |
|-----|--------|-------|
| **Cache Size** | No limit (could crash) | Max 100MB per entry, 500MB total |
| **Memory Check** | No check (could crash) | Skips cache if >80% memory used |
| **Sync Range** | Fixed 14 days (data loss) | From last_sync (no data loss) |
| **First Sync** | Last 14 days only | Last 365 days (1 year) |
| **Regular Sync** | Last 14 days only | All data since last sync |

**Result**: 
- ✅ No more crashes on low-memory devices
- ✅ No more data loss from long sync gaps
- ✅ Efficient syncing (only new data)
- ✅ Safe fallback to database for large datasets

---

**All fixes are production-ready and backward compatible!** 🎯


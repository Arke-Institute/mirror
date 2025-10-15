# Arke IPFS Mirror Architecture

## Overview

The Arke IPFS Mirror maintains a local replica of the Arke IPFS entity system by synchronizing data from the Arke API. It operates in two phases: bulk synchronization and continuous polling, with periodic snapshot refresh to prevent unbounded data growth.

## System Architecture

### Data Storage

The mirror maintains two local files:

1. **State File** (`mirror-state.json`): Tracks synchronization state
2. **Data File** (`mirror-data.jsonl`): JSONL file containing entity data

### Mirror Phases

#### Phase 1: Bulk Sync
On first run, the mirror downloads the latest snapshot from `/snapshot/latest` to establish the initial state:

```
GET /snapshot/latest
→ Returns all entities with current versions
→ Stores event_cid as cursor for subsequent polling
```

#### Phase 2: Continuous Polling
The mirror polls `/events` to discover new events since the last known cursor:

```
GET /events?limit=100&cursor={next_cursor}
→ Walk backwards from HEAD until finding known cursor
→ Append new events in chronological order
→ Update cursor to most recent event
```

**Exponential Backoff:**
- No updates detected → double backoff (30s to 600s max)
- Updates detected → reset to minimum backoff (30s)

## Periodic Snapshot Refresh (New Feature)

### The Problem

Without periodic refresh, the JSONL file grows unbounded:

```
Initial snapshot:  100 entities
Entity A updated:  +50 events (50 lines in JSONL)
Entity B updated:  +30 events (30 lines in JSONL)
After 1 month:     ~100,000 lines for 100 entities
```

**Result:** The file contains every historical event, but most users only need current state.

### The Solution

Every 12 hours (configurable), the mirror checks for new snapshots and compacts the data file:

```
1. Check snapshot headers (x-snapshot-seq)
2. If new snapshot available (seq > last_snapshot_seq):
   a. Download full snapshot
   b. Truncate JSONL file
   c. Write current state only (N entities)
   d. Update cursor to snapshot event_cid
   e. Continue polling from new cursor
```

**Result:** JSONL stays bounded at ~N entities instead of N × M updates.

### Implementation Details

#### State Tracking

Two new fields added to `MirrorState`:

```typescript
interface MirrorState {
  // ... existing fields ...
  last_snapshot_seq: number | null;        // Sequence number of last integrated snapshot
  last_snapshot_check_time: string | null; // When we last checked for new snapshot
}
```

#### Efficient Header Checks

The system uses HTTP headers to detect new snapshots without downloading the body:

```typescript
// Check headers only (efficient)
const response = await fetch('/snapshot/latest');
const newSeq = parseInt(response.headers.get('x-snapshot-seq'));
const newCount = parseInt(response.headers.get('x-snapshot-count'));

// Only download body if sequence increased
if (newSeq > state.last_snapshot_seq) {
  const snapshot = await response.json();
  // Perform compaction...
}
```

**Headers Available:**
- `x-snapshot-cid`: CID of the snapshot
- `x-snapshot-seq`: Sequence number (increments with each new snapshot)
- `x-snapshot-count`: Total entity count

#### Compaction Process

When a newer snapshot is detected:

```typescript
async checkAndRefreshSnapshot() {
  1. Fetch /snapshot/latest
  2. Check x-snapshot-seq header
  3. If newSeq > lastSeq:
     a. Download full snapshot body
     b. writeFileSync(dataFile, '') // Truncate
     c. Write all snapshot.entries
     d. Update state.cursor_event_cid = snapshot.event_cid
     e. Update state.last_snapshot_seq = snapshot.seq
     f. Save state
}
```

#### Polling Integration

The refresh check is integrated into the poll loop:

```typescript
async pollLoop() {
  while (true) {
    // Check if 12 hours passed since last snapshot check
    const timeSinceLastCheck = now - lastCheckTime;

    if (timeSinceLastCheck >= snapshotRefreshInterval) {
      await checkAndRefreshSnapshot();
    }

    // Normal event polling
    await syncFromCursor();

    await sleep(backoff_seconds);
  }
}
```

## Comparison: Old vs. New Mirror

### Old Mirror Behavior

```
Time 0:    Snapshot with 100 entities → 100 lines in JSONL
Hour 1:    5 updates → 105 lines
Hour 2:    8 updates → 113 lines
Hour 12:   50 updates → 150 lines
Day 1:     200 updates → 300 lines
Week 1:    1400 updates → 1500 lines
Month 1:   6000 updates → 6100 lines
```

**Problem:** File grows linearly with update frequency, not entity count.

### New Mirror Behavior

```
Time 0:    Snapshot with 100 entities → 100 lines
Hour 1:    5 updates → 105 lines
Hour 2:    8 updates → 113 lines
Hour 12:   Snapshot refresh → 100 lines (reset!)
Hour 13:   3 updates → 103 lines
Day 1:     Snapshot refresh → 100 lines
Week 1:    Snapshot refreshes every 12h → ~100-150 lines average
Month 1:   Snapshot refreshes every 12h → ~100-150 lines average
```

**Solution:** File size bounded by entity count + updates since last snapshot.

## Data Integrity Guarantees

### No Data Loss

Events occurring between snapshots are captured via continuous polling:

```
Snapshot 1 (seq=1) at 10:00 AM
  ↓
Updates at 10:15, 10:30, 10:45 → captured by polling
  ↓
Snapshot 2 (seq=2) at 11:00 AM
  ↓
Refresh at 11:00 AM:
  - Downloads snapshot 2
  - Cursor moves to snapshot 2 event_cid
  - Subsequent polls capture events after 11:00 AM
```

**Result:** All events are processed; no gaps in the event stream.

### Cursor Continuity

The cursor tracks position in the event stream:

```
Initial:     cursor = snapshot.event_cid (e.g., event #1000)
Poll 1:      Finds events #1001-1005 → cursor = event #1005
Poll 2:      Finds events #1006-1010 → cursor = event #1010
Snapshot:    New snapshot built from event #1050
Refresh:     cursor = snapshot.event_cid (event #1050)
Poll 3:      Finds events #1051-1055 → cursor = event #1055
```

**Guarantee:** The cursor always points to the last event we've integrated, ensuring no missed updates.

## Configuration

### Refresh Interval

Default: 12 hours (`12 * 60 * 60 * 1000` ms)

To change (in `src/mirror.ts`):

```typescript
private snapshotRefreshInterval = 6 * 60 * 60 * 1000; // 6 hours
```

For testing with 30-second intervals:

```typescript
private snapshotRefreshInterval = 30 * 1000; // 30 seconds
```

### Environment Variables

```bash
ARKE_API_URL=http://localhost:3000  # API base URL
STATE_FILE_PATH=/data/state.json    # Custom state file path
DATA_FILE_PATH=/data/data.jsonl     # Custom data file path
```

## Performance Characteristics

### Network Efficiency

**Header Check (when no new snapshot):**
- Request: HEAD-like behavior
- Response: ~200 bytes (headers only)
- Body: Aborted before download
- Time: ~50-100ms

**Full Refresh (when new snapshot found):**
- Request: GET /snapshot/latest
- Response: ~600 KB for 2500 entities
- Time: ~1-2 seconds
- Frequency: Every 12 hours (or when snapshot created)

### Storage Efficiency

**Example: 2500 entities with frequent updates**

Old mirror after 30 days:
```
2500 entities × 100 avg updates = 250,000 events
~100 bytes per event = 25 MB
```

New mirror after 30 days:
```
2500 entities (current state)
+ ~50 events since last refresh (12h window)
= 2550 entries × 100 bytes = 255 KB
```

**Reduction:** 98% smaller file size for same data.

## Monitoring

### Logs

The mirror logs snapshot refresh activity:

```
=== Checking for new snapshot ===
Current snapshot (seq 1) is not newer than last integrated (seq 1)
```

When a new snapshot is found:

```
=== Checking for new snapshot ===
Found newer snapshot!
  - Previous seq: 1
  - New seq: 2
  - Time: 2025-10-15T22:34:41Z
  - Total entities: 2625
Compacting data file with snapshot entries...
Compaction complete: 2625 entities written
```

### State Inspection

Check current state:

```bash
cat mirror-state.json | jq .
```

Output:
```json
{
  "phase": "polling",
  "cursor_event_cid": "bafyreib...",
  "connected": true,
  "backoff_seconds": 30,
  "last_poll_time": "2025-10-15T22:35:13Z",
  "total_entities": 2625,
  "last_snapshot_seq": 2,
  "last_snapshot_check_time": "2025-10-15T22:35:13Z"
}
```

## Migration from Old Mirror

If migrating from a mirror without snapshot refresh:

1. **Backup existing data:**
   ```bash
   cp mirror-data.jsonl mirror-data.jsonl.backup
   ```

2. **Let new mirror run:**
   - On first snapshot refresh, JSONL will be compacted
   - Historical events replaced with current state
   - Backup preserved for historical analysis if needed

3. **Verify:**
   ```bash
   # Check line count before
   wc -l mirror-data.jsonl.backup

   # Check line count after first refresh
   wc -l mirror-data.jsonl
   ```

## Summary

The periodic snapshot refresh feature provides:

✅ **Bounded storage** - JSONL file size proportional to entity count, not update frequency
✅ **Efficient checks** - Header-only requests when no new snapshot available
✅ **No data loss** - Continuous polling captures all events between snapshots
✅ **Automatic compaction** - Every 12 hours, file is optimized without manual intervention
✅ **Configurable** - Refresh interval adjustable for different deployment needs

This makes the mirror suitable for long-term operation without manual maintenance or unbounded disk usage.

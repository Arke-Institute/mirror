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

## Catchup Logic: How the Mirror Stays Synchronized

The mirror's catchup mechanism ensures eventual consistency regardless of how far behind it falls. The system uses a **backwards-walking algorithm** to efficiently discover all missed events.

### Core Algorithm: syncFromCursor()

The `syncFromCursor()` method implements the catchup logic:

```typescript
async syncFromCursor() {
  const cursor_event_cid = this.state.cursor_event_cid;  // Last known event
  let apiCursor = undefined;
  const newEvents = [];

  // Walk backwards from HEAD until finding our cursor
  while (true) {
    const response = await fetch(`/events?limit=100&cursor=${apiCursor}`);
    const data = await response.json();

    for (const event of data.items) {
      if (event.event_cid === cursor_event_cid) {
        // Found where we left off!
        foundCursor = true;
        break;
      } else {
        // New event we haven't seen yet
        newEvents.push(event);
      }
    }

    if (foundCursor) break;
    if (!data.has_more) break;  // Reached genesis

    apiCursor = data.next_cursor;  // Continue backwards
  }

  // Append events in chronological order (reverse the backwards walk)
  for (const event of newEvents.reverse()) {
    this.appendData(event);
  }

  // Update cursor to most recent event
  this.state.cursor_event_cid = newEvents[newEvents.length - 1].event_cid;
}
```

### How It Works

**Step 1: Start from HEAD (Most Recent)**
```
Current HEAD: event #1050
Mirror cursor: event #1000
```

**Step 2: Walk Backwards Through Pagination**
```
Request 1: GET /events?limit=100
  Returns: events #1050-951 (100 events)
  Check each: #1050, #1049, ..., #951
  Found cursor? No → Continue

Request 2: GET /events?limit=100&cursor={next}
  Returns: events #950-1000
  Check each: #950, #951, ..., #1000
  Found cursor? Yes! → Stop
```

**Step 3: Accumulate Missed Events**
```
newEvents = [#1050, #1049, #1048, ..., #1001]
Total accumulated: 50 events
```

**Step 4: Replay in Chronological Order**
```
Reverse array: [#1001, #1002, ..., #1050]
Append to JSONL in order
Update cursor to #1050
```

### Catchup Scenarios

#### Scenario 1: Mirror Down for 1 Hour (50 Events Behind)

```
Last known cursor: event #1000
Current HEAD: event #1050
Gap: 50 events

Catchup Process:
  - Pagination cycles: 1 (all events in first 100-item page)
  - Events replayed: 50
  - Time to catchup: ~2 seconds
  - Result: cursor updated to #1050
```

#### Scenario 2: Mirror Down for 1 Day (2,000 Events Behind)

```
Last known cursor: event #1000
Current HEAD: event #3000
Gap: 2,000 events

Catchup Process:
  - Pagination cycles: 20 (2000 events ÷ 100 per page)
  - Events replayed: 2,000
  - Network requests: 20
  - Time to catchup: ~30-60 seconds
  - Result: cursor updated to #3000
```

#### Scenario 3: Mirror Down for 1 Week (10,000 Events Behind)

```
Last known cursor: event #1000
Current HEAD: event #11000
Gap: 10,000 events

Catchup Process:
  - Pagination cycles: 100 (10,000 events ÷ 100 per page)
  - Events replayed: 10,000
  - Network requests: 100
  - Time to catchup: ~5-10 minutes
  - JSONL file growth: 10,000 lines added
  - Result: cursor updated to #11000
```

### Fast Catchup via Snapshot Refresh

For large gaps, the **periodic snapshot refresh** provides a more efficient catchup method:

```
Option 1 - Event Replay (Traditional):
  Mirror down for 1 week
  → 10,000 events to download and replay
  → ~1 MB of event data
  → 100 API requests
  → 5-10 minutes to catchup
  → JSONL grows by 10,000 lines

Option 2 - Snapshot Refresh (Efficient):
  Mirror down for 1 week
  → Download latest snapshot instead
  → ~600 KB for 2,500 current entities
  → 1 API request
  → 2 seconds to catchup
  → JSONL set to exactly 2,500 lines (compacted)
```

**When Snapshot Refresh Triggers:**
- Every 12 hours (configurable via `snapshotRefreshInterval`)
- OR when `timeSinceLastCheck >= snapshotRefreshInterval`

**Snapshot Catchup Logic:**
```typescript
if (timeSinceLastCheck >= snapshotRefreshInterval) {
  // Check if newer snapshot available (header-only check)
  const newSeq = parseInt(response.headers.get('x-snapshot-seq'));

  if (newSeq > last_snapshot_seq) {
    // Found newer snapshot - fast catchup!
    const snapshot = await response.json();

    // Truncate JSONL and replace with current state
    writeFileSync(dataFile, '');
    for (const entry of snapshot.entries) {
      appendData(entry);
    }

    // Jump cursor to snapshot position
    cursor_event_cid = snapshot.event_cid;

    // Continue polling from here
    // (No need to replay 10,000 historical events!)
  }
}
```

### Edge Cases

**Cursor Never Found (Genesis Reached)**
```
If the mirror walks all the way back without finding the cursor:
  - Reaches !data.has_more (beginning of event chain)
  - Assumes all events from genesis forward are new
  - Replays entire event history
  - Use case: Fresh mirror or corrupted state
```

**No Events Yet**
```
If /events returns empty:
  - newEvents array is empty
  - No updates appended
  - Cursor remains unchanged
  - Use case: Brand new system with no entities yet
```

**Cursor in Future (Clock Skew)**
```
If saved cursor_event_cid doesn't exist yet:
  - Backwards walk reaches genesis without finding it
  - Replays all events from beginning
  - Eventually syncs when real cursor event appears
  - Use case: Restored from backup with future state
```

### Performance Considerations

**Memory Usage During Catchup:**
```typescript
const newEvents = [];  // Accumulates all missed events in memory

Example: 10,000 missed events
  Each event: ~200 bytes
  Total memory: ~2 MB (acceptable)
```

**Network Efficiency:**
```
Batch size: 100 events per request (configurable via ?limit=100)
Pagination: Sequential (can't parallelize due to cursor dependency)
```

**Disk I/O:**
```typescript
for (const event of newEvents.reverse()) {
  this.appendData(event);  // One write per event
}

Optimization opportunity: Could batch writes for large catchups
Current: 10,000 events = 10,000 appendFileSync calls
Better: Accumulate and write in chunks of 1000
```

### Catchup Strategy Decision Tree

```
Is mirror behind?
  │
  ├─ Yes, < 100 events behind
  │   └─→ Use event replay (syncFromCursor)
  │       Fast, minimal overhead
  │
  ├─ Yes, 100-1000 events behind
  │   └─→ Use event replay (syncFromCursor)
  │       Still efficient, 1-10 API requests
  │
  ├─ Yes, 1000-10000 events behind
  │   └─→ Wait for next snapshot refresh (if within 12h)
  │       OR use event replay if urgent
  │       Snapshot refresh is ~100x more efficient
  │
  └─ Yes, > 10000 events behind
      └─→ Force snapshot refresh
          Downloading snapshot is much faster than
          replaying 10,000+ individual events
```

### Guarantees

**Eventual Consistency:**
- No matter how far behind, mirror will eventually catch up
- All events are processed in chronological order
- No events are skipped or duplicated

**No Data Loss:**
- Cursor tracking ensures continuity
- Even if mirror crashes mid-catchup, it resumes from last saved cursor
- State file is saved after each successful poll iteration

**Idempotency:**
- Re-running catchup with same cursor is safe
- Events already appended won't be duplicated (cursor prevents re-processing)

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

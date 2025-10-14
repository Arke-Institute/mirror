# Entity Mirroring Guide

A comprehensive guide for building and maintaining a mirror of the Arke IPFS entity system.

## Overview

The Arke IPFS system provides two mechanisms for building a complete mirror:
1. **Bulk snapshot access** - Get the majority of historical entities in one request
2. **Incremental polling** - Track new/updated entities in real-time

This guide covers the complete mirroring strategy, including the critical first-poll phase that connects snapshot data with the live chain.

---

## Architecture Context

### The Chain Structure

The system maintains a **single continuous chain** of all entities:
- Each entity is a node in the chain with a `prev` pointer
- The chain head always points to the most recent entity
- Snapshots are point-in-time captures that don't truncate the chain
- After a snapshot, new entities continue linking to the existing chain

### Data Guarantees

**What IS guaranteed:**
- **PI list completeness** - The snapshot contains all PIs that existed at snapshot time
- **Chain continuity** - Every entity links back through prev pointers to the beginning
- **PI uniqueness** - Each PI appears only once in the chain

**What is NOT guaranteed:**
- **Tip CID currency** - The `tip_cid` in snapshot entries may be outdated
- **Version accuracy** - The `ver` field reflects snapshot time, not current state
- **Real-time consistency** - Entities may have been updated since snapshot

**For current data:** Always query the live system via `/resolve/{pi}` or MFS `.tip` files.

---

## Mirroring Strategy

### Phase 1: Initial Bulk Sync

Download the latest snapshot to get the bulk of historical entities.

```bash
# Fetch complete snapshot
curl http://localhost:3000/snapshot/latest > snapshot.json

# Parse and store entities
jq -r '.entries[] | "\(.pi),\(.ver)"' snapshot.json | while IFS=, read pi ver; do
  # Store PI + version in local mirror database
  echo "Storing $pi (v$ver)"
done
```

**Result:** Your mirror now contains 2,000+ entities (in this example, 2,307).

**Local State After Phase 1:**
```
Local Mirror:
  - PIs: [01K7CQ3N..., 01K7CQ3Q..., ..., 01K7CREDR...]
  - Last Chain CID: (none - stored from snapshot)
  - Status: "bulk sync complete, needs chain connection"
```

---

### Phase 2: Chain Connection (Critical First Poll)

After getting the snapshot, you have two **disconnected chains**:

1. **Snapshot chain** - Historical entities ending at snapshot time
2. **Live chain** - Entities created since snapshot (if any)

**Goal:** Walk the live chain backwards until you find overlap with the snapshot data.

#### Algorithm

```python
async def connect_chains(mirror_db, api_base_url):
    """
    Connect the snapshot chain to the live chain.
    Returns the connection point (CID where chains meet).
    """
    seen_pis = set(mirror_db.get_all_pis())  # From snapshot
    cursor = None  # Start from chain head
    new_entities = []

    while True:
        # Fetch recent entities
        url = f"{api_base_url}/entities?limit=100"
        if cursor:
            url += f"&cursor={cursor}"

        response = requests.get(url)
        data = response.json()

        found_overlap = False

        for entity in data['items']:
            pi = entity['pi']

            if pi in seen_pis:
                # Found the connection point!
                found_overlap = True
                print(f"Connected chains at PI: {pi}")
                break
            else:
                # New entity not in snapshot
                new_entities.append(entity)
                seen_pis.add(pi)

        if found_overlap:
            # Chains are connected
            break

        if not data['has_more']:
            # Reached end of chain without finding overlap
            # This shouldn't happen unless snapshot is from different system
            raise Exception("Could not connect chains - no overlap found")

        # Continue walking backwards
        cursor = data['next_cursor']

    # Store new entities in order (reverse since we walked backwards)
    for entity in reversed(new_entities):
        mirror_db.store_entity(entity['pi'], entity['ver'])

    return len(new_entities)
```

#### Example Walkthrough

**Scenario:** Snapshot was built at 2025-10-14 17:45:31Z, we're now polling at 17:50:00Z.

```
Snapshot contains:
  - 01K7CREDR... (v1) ← Last entity in snapshot
  - 01K7CRED6... (v1)
  - ...

Live chain now:
  - 01K7CREG5... (v1) ← NEW (chain head)
  - 01K7CREFS... (v1) ← NEW
  - 01K7CREET... (v1) ← NEW
  - 01K7CREDR... (v1) ← OVERLAP! (also in snapshot)
  - 01K7CRED6... (v1)
  - ...
```

**Poll 1:** `GET /entities?limit=100`
- Returns: [01K7CREG5, 01K7CREFS, 01K7CREET, 01K7CREDR, ...]
- Check: 01K7CREG5 not in mirror → NEW
- Check: 01K7CREFS not in mirror → NEW
- Check: 01K7CREET not in mirror → NEW
- Check: 01K7CREDR **in mirror** → OVERLAP FOUND!
- **Stop here** - chains connected

**Result:**
- Added 3 new entities
- Chains now connected
- Mirror is complete and up-to-date

**Local State After Phase 2:**
```
Local Mirror:
  - PIs: [all from snapshot + 3 new PIs]
  - Last Seen PI: 01K7CREG5...
  - Status: "chains connected, ready for incremental polling"
```

---

### Phase 3: Incremental Polling (Steady State)

Once chains are connected, maintain the mirror with simple periodic polling.

#### Polling Algorithm

```python
async def poll_for_updates(mirror_db, api_base_url):
    """
    Poll for new/updated entities.
    Returns number of new/updated entities found.
    """
    response = requests.get(f"{api_base_url}/entities?limit=50")
    data = response.json()

    updates = 0
    all_seen = True

    for entity in data['items']:
        pi = entity['pi']
        ver = entity['ver']

        local_ver = mirror_db.get_version(pi)

        if local_ver is None:
            # New PI
            mirror_db.store_entity(pi, ver)
            updates += 1
            all_seen = False
        elif local_ver < ver:
            # Updated PI (version increased)
            mirror_db.update_entity(pi, ver)
            updates += 1
            all_seen = False
        # else: Already have this exact version, skip

    return updates, all_seen
```

#### Exponential Backoff

Adjust polling frequency based on activity:

```python
class AdaptivePoller:
    def __init__(self):
        self.backoff_seconds = 30  # Start at 30 seconds
        self.min_backoff = 30
        self.max_backoff = 600  # Cap at 10 minutes

    async def poll_loop(self):
        while True:
            updates, all_seen = await poll_for_updates()

            if updates > 0:
                # Activity detected - reset to minimum
                print(f"Found {updates} updates, resetting backoff")
                self.backoff_seconds = self.min_backoff
            elif all_seen:
                # No new data - increase backoff
                self.backoff_seconds = min(
                    self.backoff_seconds * 2,
                    self.max_backoff
                )
                print(f"No updates, backing off to {self.backoff_seconds}s")

            await asyncio.sleep(self.backoff_seconds)
```

**Backoff schedule:**
- Activity: 30s
- No activity: 30s → 60s → 120s → 240s → 480s → 600s (cap)

---

## Complete Implementation Example

```python
import requests
import asyncio
from typing import Set, Dict

class ArkeIPFSMirror:
    def __init__(self, api_base_url: str):
        self.api_base_url = api_base_url
        self.pis: Dict[str, int] = {}  # pi -> version
        self.connected = False
        self.backoff_seconds = 30

    async def initialize(self):
        """Phase 1 + 2: Bulk sync + chain connection"""
        print("Phase 1: Downloading snapshot...")
        await self.bulk_sync()

        print("Phase 2: Connecting chains...")
        new_count = await self.connect_chains()
        print(f"Connected! Found {new_count} new entities since snapshot")

        self.connected = True

    async def bulk_sync(self):
        """Download and parse snapshot"""
        response = requests.get(f"{self.api_base_url}/snapshot/latest")
        response.raise_for_status()
        snapshot = response.json()

        for entry in snapshot['entries']:
            self.pis[entry['pi']] = entry['ver']

        print(f"Loaded {len(self.pis)} entities from snapshot")

    async def connect_chains(self):
        """Walk live chain until we find overlap with snapshot"""
        cursor = None
        new_entities = []

        while True:
            url = f"{self.api_base_url}/entities?limit=100"
            if cursor:
                url += f"&cursor={cursor}"

            response = requests.get(url)
            data = response.json()

            found_overlap = False

            for entity in data['items']:
                pi = entity['pi']

                if pi in self.pis:
                    # Found connection point
                    found_overlap = True
                    break
                else:
                    new_entities.append(entity)

            if found_overlap or not data.get('has_more'):
                break

            cursor = data['next_cursor']

        # Add new entities (reverse order since we walked backwards)
        for entity in reversed(new_entities):
            self.pis[entity['pi']] = entity['ver']

        return len(new_entities)

    async def poll_loop(self):
        """Phase 3: Incremental polling with backoff"""
        if not self.connected:
            raise Exception("Must call initialize() first")

        min_backoff = 30
        max_backoff = 600

        while True:
            response = requests.get(
                f"{self.api_base_url}/entities?limit=50"
            )
            data = response.json()

            updates = 0
            all_seen = True

            for entity in data['items']:
                pi = entity['pi']
                ver = entity['ver']

                if pi not in self.pis:
                    # New PI
                    self.pis[pi] = ver
                    updates += 1
                    all_seen = False
                    print(f"New entity: {pi} (v{ver})")
                elif self.pis[pi] < ver:
                    # Updated version
                    old_ver = self.pis[pi]
                    self.pis[pi] = ver
                    updates += 1
                    all_seen = False
                    print(f"Updated: {pi} v{old_ver} -> v{ver}")

            if updates > 0:
                self.backoff_seconds = min_backoff
            elif all_seen:
                self.backoff_seconds = min(
                    self.backoff_seconds * 2,
                    max_backoff
                )

            print(f"Poll complete: {updates} updates, next poll in {self.backoff_seconds}s")
            await asyncio.sleep(self.backoff_seconds)

    async def run(self):
        """Complete mirroring workflow"""
        await self.initialize()
        print("Mirror initialized, starting incremental polling...")
        await self.poll_loop()

# Usage
async def main():
    mirror = ArkeIPFSMirror("http://localhost:3000")
    await mirror.run()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Edge Cases and Error Handling

### Snapshot Built During Phase 2

**Scenario:** A new snapshot is built while you're connecting chains.

**Impact:** Minimal - the chain is continuous, so connection will still work.

**Recommendation:** Complete current connection, then optionally fetch new snapshot in background.

### Version Rollbacks

**Scenario:** A PI's version number decreases (shouldn't happen, but defensive programming).

**Handling:**
```python
if local_ver is not None and ver < local_ver:
    # Version decreased - possible data corruption or system issue
    log.warning(f"Version rollback detected: {pi} v{local_ver} -> v{ver}")
    # Keep existing version or flag for manual review
```

### Network Failures

**Handling:**
```python
try:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
except requests.RequestException as e:
    log.error(f"Poll failed: {e}")
    # Don't reset backoff on network errors
    await asyncio.sleep(min_backoff)
    continue
```

### Empty Snapshot (No Data Yet)

**Handling:**
```python
response = requests.get(f"{api_base_url}/snapshot/latest")
if response.status_code == 404:
    # No snapshot exists yet - system is new
    # Skip Phase 1, go straight to Phase 2 (incremental polling)
    self.connected = True
    return
```

---

## Monitoring and Validation

### Key Metrics

Track these metrics to ensure mirror health:

```python
class MirrorMetrics:
    def __init__(self):
        self.total_entities = 0
        self.last_poll_time = None
        self.last_update_time = None
        self.polls_with_no_data = 0
        self.current_backoff = 30

    def report(self):
        return {
            "total_entities": self.total_entities,
            "last_poll": self.last_poll_time,
            "last_update": self.last_update_time,
            "idle_polls": self.polls_with_no_data,
            "backoff_seconds": self.current_backoff,
            "status": "healthy" if self.polls_with_no_data < 10 else "stale"
        }
```

### Validation Queries

Periodically validate mirror completeness:

```bash
# Compare total count
LOCAL_COUNT=$(sqlite3 mirror.db "SELECT COUNT(*) FROM entities")
REMOTE_COUNT=$(curl -s http://localhost:3000/index-pointer | jq .total_count)

if [ "$LOCAL_COUNT" != "$REMOTE_COUNT" ]; then
  echo "Mirror out of sync: local=$LOCAL_COUNT, remote=$REMOTE_COUNT"
fi
```

---

## Periodic Full Refresh

Even with incremental polling, perform occasional full refreshes to catch any missed updates.

### Strategy

```python
class MirrorWithRefresh(ArkeIPFSMirror):
    async def run(self):
        await self.initialize()

        # Schedule daily full refresh
        refresh_task = asyncio.create_task(self.daily_refresh())
        poll_task = asyncio.create_task(self.poll_loop())

        await asyncio.gather(refresh_task, poll_task)

    async def daily_refresh(self):
        """Download fresh snapshot every 24 hours"""
        while True:
            await asyncio.sleep(86400)  # 24 hours

            print("Starting daily full refresh...")
            old_count = len(self.pis)

            # Download fresh snapshot
            response = requests.get(f"{self.api_base_url}/snapshot/latest")
            snapshot = response.json()

            # Merge with existing data
            for entry in snapshot['entries']:
                pi = entry['pi']
                ver = entry['ver']

                if pi not in self.pis:
                    self.pis[pi] = ver
                    print(f"Recovered missed entity: {pi}")

            new_count = len(self.pis)
            print(f"Refresh complete: {old_count} -> {new_count} entities")
```

### Refresh Schedule

- **High-activity systems:** Every 12-24 hours
- **Low-activity systems:** Weekly
- **After disruptions:** Immediate

---

## Performance Considerations

### Bandwidth

**Snapshot download:**
- ~600 KB for 2,300 entities
- ~1.2 seconds transfer time
- Negligible for occasional refresh

**Incremental polling:**
- 50 entities/poll × ~250 bytes/entity = ~12 KB/poll
- At 30s intervals: ~24 KB/minute = ~1.4 MB/hour
- Minimal bandwidth impact

### Storage

**Local database size:**
- Storing just PI + version: ~50 bytes/entity
- 10,000 entities: ~500 KB
- 1,000,000 entities: ~50 MB
- Storage is not a constraint

### CPU

**Snapshot parsing:**
- 2,300 entities parsed in <1 second
- Negligible CPU impact

**Poll processing:**
- 50 entities checked against local DB: <10ms
- Can handle 100+ polls/second if needed

---

## Best Practices

1. **Start with snapshot** - Always begin with bulk sync for efficiency
2. **Validate chain connection** - Ensure Phase 2 completes before Phase 3
3. **Use exponential backoff** - Conserve resources during idle periods
4. **Monitor metrics** - Track polls, updates, and backoff state
5. **Handle errors gracefully** - Don't crash on transient network issues
6. **Periodic full refresh** - Catch any missed updates from network issues
7. **Log significant events** - New entities, version updates, chain connections
8. **Don't trust tip CIDs from snapshot** - Always query live system for current versions

---

## Conclusion

The Arke IPFS mirroring system provides efficient bulk sync via snapshots combined with real-time incremental polling. The critical phase is connecting the snapshot chain to the live chain during the first poll, after which standard incremental polling maintains synchronization.

**Key Takeaways:**
- **Phase 1** (Bulk Sync): Fast download of historical data via snapshot
- **Phase 2** (Chain Connection): Walk live chain backwards to find overlap
- **Phase 3** (Incremental Polling): Maintain sync with adaptive polling
- **Chain continuity is guaranteed** - No gaps in the PI list
- **Tip CIDs are not guaranteed current** - Query live system for versions

For implementation details of specific endpoints, see [API_WALKTHROUGH.md](API_WALKTHROUGH.md).

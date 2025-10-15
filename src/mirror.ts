import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Types
interface EntityEntry {
  pi: string;
  ver: number;
  tip_cid: string;
}

interface SnapshotResponse {
  schema: string;
  seq: number;
  ts: string;
  event_cid: string;
  total_count: number;
  prev_snapshot?: { '/': string };
  entries: EntityEntry[];
  snapshot_time?: string; // Legacy field, may not be present
}

interface EntitiesResponse {
  items: EntityEntry[];
  has_more: boolean;
  next_cursor?: string;
}

interface Event {
  event_cid: string;
  type: 'create' | 'update';
  pi: string;
  ver: number;
  tip_cid: string;
  ts: string;
}

interface EventsResponse {
  items: Event[];
  total_events: number;
  total_pis: number;
  has_more: boolean;
  next_cursor?: string;
}

interface MirrorState {
  phase: 'not_started' | 'bulk_sync' | 'polling';
  cursor_event_cid: string | null; // Most recent event CID we've seen
  connected: boolean;
  backoff_seconds: number;
  last_poll_time: string | null;
  total_entities: number;
  last_snapshot_seq: number | null; // Sequence number of last integrated snapshot
  last_snapshot_check_time: string | null; // When we last checked for new snapshot
}

class ArkeIPFSMirror {
  private apiBaseUrl: string;
  private state: MirrorState;
  private stateFilePath: string;
  private dataFilePath: string;
  private minBackoff = 30;
  private maxBackoff = 600;
  private snapshotRefreshInterval = 30 * 1000; // 30 seconds for testing (normally 12 * 60 * 60 * 1000 for 12 hours)

  constructor(apiBaseUrl: string, stateFilePath?: string, dataFilePath?: string) {
    this.apiBaseUrl = apiBaseUrl;
    this.stateFilePath = stateFilePath || join(dirname(__dirname), 'mirror-state.json');
    this.dataFilePath = dataFilePath || join(dirname(__dirname), 'mirror-data.jsonl');
    this.state = this.loadState();
  }

  private loadState(): MirrorState {
    if (existsSync(this.stateFilePath)) {
      try {
        const data = readFileSync(this.stateFilePath, 'utf-8');
        return JSON.parse(data);
      } catch (error) {
        console.error('Error loading state file, starting fresh:', error);
      }
    }

    return {
      phase: 'not_started',
      cursor_event_cid: null,
      connected: false,
      backoff_seconds: this.minBackoff,
      last_poll_time: null,
      total_entities: 0,
      last_snapshot_seq: null,
      last_snapshot_check_time: null,
    };
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (error) {
      console.error('Error saving state:', error);
    }
  }

  private appendData(data: EntityEntry | Event): void {
    try {
      appendFileSync(this.dataFilePath, JSON.stringify(data) + '\n', 'utf-8');
    } catch (error) {
      console.error('Error appending data:', error);
      throw error;
    }
  }

  // Phase 1: Bulk Sync
  private async bulkSync(): Promise<void> {
    console.log('=== Phase 1: Bulk Sync ===');
    console.log('Downloading snapshot...');

    try {
      const response = await fetch(`${this.apiBaseUrl}/snapshot/latest`);

      if (response.status === 404) {
        console.log('No snapshot exists yet - system is new');
        console.log('Skipping to polling phase');
        this.state.phase = 'polling';
        this.state.connected = true;
        this.saveState();
        return;
      }

      if (!response.ok) {
        throw new Error(`Snapshot fetch failed: ${response.status}`);
      }

      const snapshot = await response.json() as SnapshotResponse;

      console.log(`Snapshot metadata:`);
      console.log(`  - Time: ${snapshot.ts}`);
      console.log(`  - Sequence: ${snapshot.seq}`);
      console.log(`  - Event CID: ${snapshot.event_cid}`);
      console.log(`  - Total entities: ${snapshot.total_count}`);

      // Append entities from snapshot to data file
      for (const entry of snapshot.entries) {
        this.appendData(entry);
        console.log(`  Loaded: ${entry.pi} (v${entry.ver})`);
      }

      // Set cursor to snapshot's event_cid (checkpoint in event stream)
      this.state.cursor_event_cid = snapshot.event_cid;

      this.state.total_entities = snapshot.total_count;
      this.state.last_snapshot_seq = snapshot.seq;
      this.state.last_snapshot_check_time = new Date().toISOString();
      this.state.phase = 'polling';
      this.state.connected = true;
      this.saveState();

      console.log(`\nBulk sync complete: ${this.state.total_entities} entities loaded`);
    } catch (error) {
      console.error('Bulk sync failed:', error);
      throw error;
    }
  }

  // Check for new snapshot and refresh data if available
  private async checkAndRefreshSnapshot(): Promise<boolean> {
    console.log('\n=== Checking for new snapshot ===');

    try {
      // First, check headers only (efficient - doesn't download body)
      const abortController = new AbortController();
      const headResponse = await fetch(`${this.apiBaseUrl}/snapshot/latest`, {
        signal: abortController.signal
      });

      if (headResponse.status === 404) {
        console.log('No snapshot exists yet');
        this.state.last_snapshot_check_time = new Date().toISOString();
        this.saveState();
        abortController.abort(); // Cancel the request
        return false;
      }

      if (!headResponse.ok) {
        abortController.abort();
        throw new Error(`Snapshot fetch failed: ${headResponse.status}`);
      }

      // Read metadata from headers (without downloading body)
      const newSeq = parseInt(headResponse.headers.get('x-snapshot-seq') || '0', 10);
      const newCount = parseInt(headResponse.headers.get('x-snapshot-count') || '0', 10);

      // Check if this snapshot is newer than the last one we integrated
      if (this.state.last_snapshot_seq !== null && newSeq <= this.state.last_snapshot_seq) {
        console.log(`Current snapshot (seq ${newSeq}) is not newer than last integrated (seq ${this.state.last_snapshot_seq})`);
        this.state.last_snapshot_check_time = new Date().toISOString();
        this.saveState();
        abortController.abort(); // Cancel the request - don't download body
        return false;
      }

      console.log(`Found newer snapshot!`);
      console.log(`  - Previous seq: ${this.state.last_snapshot_seq || 'none'}`);
      console.log(`  - New seq: ${newSeq}`);
      console.log(`  - Total entities: ${newCount}`);

      // Now fetch the full snapshot body since we need it
      const snapshot = await headResponse.json() as SnapshotResponse;

      console.log(`  - Time: ${snapshot.ts}`);
      console.log(`  - Event CID: ${snapshot.event_cid}`);

      // Truncate and rewrite the data file with snapshot entries
      console.log('Compacting data file with snapshot entries...');
      writeFileSync(this.dataFilePath, '', 'utf-8'); // Clear file

      for (const entry of snapshot.entries) {
        this.appendData(entry);
      }

      console.log(`Compaction complete: ${snapshot.total_count} entities written`);

      // Update state with new snapshot info
      this.state.cursor_event_cid = snapshot.event_cid;
      this.state.total_entities = snapshot.total_count;
      this.state.last_snapshot_seq = snapshot.seq;
      this.state.last_snapshot_check_time = new Date().toISOString();
      this.saveState();

      return true;
    } catch (error) {
      console.error('Snapshot refresh failed:', error);
      // Update check time even on failure to avoid hammering the API
      this.state.last_snapshot_check_time = new Date().toISOString();
      this.saveState();
      return false;
    }
  }

  // Unified sync: Walk backwards from HEAD until finding cursor
  private async syncFromCursor(): Promise<{ updates: number }> {
    const cursor_event_cid = this.state.cursor_event_cid;
    let apiCursor: string | undefined = undefined;
    const newEvents: Event[] = [];
    let pollCount = 0;

    try {
      while (true) {
        pollCount++;
        let url = `${this.apiBaseUrl}/events?limit=100`;
        if (apiCursor) {
          url += `&cursor=${apiCursor}`;
        }

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Events fetch failed: ${response.status}`);
        }

        const data = await response.json() as EventsResponse;
        let foundCursor = false;

        for (const event of data.items) {
          if (cursor_event_cid && event.event_cid === cursor_event_cid) {
            // Found our cursor! Stop accumulating
            foundCursor = true;
            console.log(`  ✓ Found cursor at event CID: ${event.event_cid}`);
            break;
          } else {
            // New event we haven't seen
            newEvents.push(event);
          }
        }

        if (foundCursor) {
          break;
        }

        if (!data.has_more) {
          // Reached end of chain without finding cursor (fresh system or genesis)
          console.log('  Reached end of chain');
          break;
        }

        apiCursor = data.next_cursor;
      }

      // Append new events in correct order (reverse since we walked backwards)
      const updates = newEvents.length;
      if (updates > 0) {
        console.log(`\nAdding ${updates} new events:`);
        for (const event of newEvents.reverse()) {
          this.appendData(event);
          console.log(`  ${event.type}: ${event.pi} (v${event.ver}) - ${event.event_cid}`);
        }

        // Update cursor to most recent event (last one appended, which is at end of reversed array)
        this.state.cursor_event_cid = newEvents[newEvents.length - 1].event_cid;
        // Note: We don't increment total_entities here since updates can happen to same PI
        // The total_entities from snapshot is a count of unique PIs, not events
      }

      this.state.last_poll_time = new Date().toISOString();
      this.saveState();

      return { updates };
    } catch (error) {
      console.error('Sync from cursor failed:', error);
      throw error;
    }
  }

  // Initialize
  async initialize(): Promise<void> {
    if (this.state.phase === 'not_started') {
      await this.bulkSync();
    }

    if (this.state.phase === 'polling') {
      console.log('\n=== Mirror Already Initialized ===');
      console.log(`  - Total entities: ${this.state.total_entities}`);
      console.log(`  - Last poll: ${this.state.last_poll_time || 'never'}`);
      console.log(`  - Current backoff: ${this.state.backoff_seconds}s`);
    }
  }

  // Main poll loop
  async pollLoop(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Must call initialize() first');
    }

    console.log('\n=== Continuous Polling ===');
    console.log('Starting continuous polling with exponential backoff...\n');

    while (true) {
      console.log(`[${new Date().toISOString()}] Polling for updates...`);

      // Check if we should refresh from snapshot (every 12 hours)
      const now = Date.now();
      const lastCheckTime = this.state.last_snapshot_check_time
        ? new Date(this.state.last_snapshot_check_time).getTime()
        : 0;
      const timeSinceLastCheck = now - lastCheckTime;

      if (timeSinceLastCheck >= this.snapshotRefreshInterval) {
        try {
          await this.checkAndRefreshSnapshot();
        } catch (error) {
          console.error('Snapshot refresh check failed, continuing with regular polling:', error);
        }
      }

      try {
        const { updates } = await this.syncFromCursor();

        if (updates > 0) {
          // Activity detected - reset to minimum
          console.log(`  Found ${updates} updates, resetting backoff`);
          this.state.backoff_seconds = this.minBackoff;
        } else {
          // No new data - increase backoff
          this.state.backoff_seconds = Math.min(
            this.state.backoff_seconds * 2,
            this.maxBackoff
          );
          console.log(`  No updates, backing off to ${this.state.backoff_seconds}s`);
        }

        this.saveState();
      } catch (error) {
        console.error('Poll error:', error);
        // Don't reset backoff on errors, just wait minimum time
        await this.sleep(this.minBackoff * 1000);
        continue;
      }

      console.log(`  Next poll in ${this.state.backoff_seconds}s\n`);
      await this.sleep(this.state.backoff_seconds * 1000);
    }
  }

  // Complete workflow
  async run(): Promise<void> {
    console.log('=== Arke IPFS Mirror Starting ===');
    console.log(`API Base URL: ${this.apiBaseUrl}`);
    console.log(`State File: ${this.stateFilePath}`);
    console.log(`Data File: ${this.dataFilePath}\n`);

    await this.initialize();
    await this.pollLoop();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Utility: Get current stats
  getStats() {
    return {
      phase: this.state.phase,
      total_entities: this.state.total_entities,
      connected: this.state.connected,
      backoff_seconds: this.state.backoff_seconds,
      last_poll_time: this.state.last_poll_time,
    };
  }
}

// Main entry point
async function main() {
  // Get API base URL from environment or use default
  const apiBaseUrl = process.env.ARKE_API_URL || 'http://localhost:3000';

  // Get file paths from environment (for Docker/Fly.io deployment)
  const stateFilePath = process.env.STATE_FILE_PATH;
  const dataFilePath = process.env.DATA_FILE_PATH;

  const mirror = new ArkeIPFSMirror(apiBaseUrl, stateFilePath, dataFilePath);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down gracefully...');
    console.log('Final stats:', mirror.getStats());
    process.exit(0);
  });

  try {
    await mirror.run();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();

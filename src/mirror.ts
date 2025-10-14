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
  entries: EntityEntry[];
  snapshot_time: string;
  total_count: number;
}

interface EntitiesResponse {
  items: EntityEntry[];
  has_more: boolean;
  next_cursor?: string;
}

interface MirrorState {
  phase: 'not_started' | 'bulk_sync' | 'polling';
  cursor_pi: string | null; // Most recent PI we've seen
  connected: boolean;
  backoff_seconds: number;
  last_poll_time: string | null;
  total_entities: number;
}

class ArkeIPFSMirror {
  private apiBaseUrl: string;
  private state: MirrorState;
  private stateFilePath: string;
  private dataFilePath: string;
  private minBackoff = 30;
  private maxBackoff = 600;

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
      cursor_pi: null,
      connected: false,
      backoff_seconds: this.minBackoff,
      last_poll_time: null,
      total_entities: 0,
    };
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (error) {
      console.error('Error saving state:', error);
    }
  }

  private appendEntity(entry: EntityEntry): void {
    try {
      appendFileSync(this.dataFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (error) {
      console.error('Error appending entity:', error);
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
      console.log(`  - Time: ${snapshot.snapshot_time}`);
      console.log(`  - Total entities: ${snapshot.total_count}`);

      // Append entities from snapshot to data file
      for (const entry of snapshot.entries) {
        this.appendEntity(entry);
        console.log(`  Loaded: ${entry.pi} (v${entry.ver})`);
      }

      // Set cursor to most recent entry (first in snapshot)
      if (snapshot.entries.length > 0) {
        this.state.cursor_pi = snapshot.entries[0].pi;
      }

      this.state.total_entities = snapshot.total_count;
      this.state.phase = 'polling';
      this.state.connected = true;
      this.saveState();

      console.log(`\nBulk sync complete: ${this.state.total_entities} entities loaded`);
    } catch (error) {
      console.error('Bulk sync failed:', error);
      throw error;
    }
  }

  // Unified sync: Walk backwards from HEAD until finding cursor
  private async syncFromCursor(): Promise<{ updates: number }> {
    const cursor_pi = this.state.cursor_pi;
    let apiCursor: string | undefined = undefined;
    const newEntities: EntityEntry[] = [];
    let pollCount = 0;

    try {
      while (true) {
        pollCount++;
        let url = `${this.apiBaseUrl}/entities?limit=100`;
        if (apiCursor) {
          url += `&cursor=${apiCursor}`;
        }

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Entities fetch failed: ${response.status}`);
        }

        const data = await response.json() as EntitiesResponse;
        let foundCursor = false;

        for (const entity of data.items) {
          if (cursor_pi && entity.pi === cursor_pi) {
            // Found our cursor! Stop accumulating
            foundCursor = true;
            console.log(`  ✓ Found cursor at PI: ${entity.pi}`);
            break;
          } else {
            // New entity we haven't seen
            newEntities.push(entity);
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

      // Append new entities in correct order (reverse since we walked backwards)
      const updates = newEntities.length;
      if (updates > 0) {
        console.log(`\nAdding ${updates} new entities:`);
        for (const entity of newEntities.reverse()) {
          this.appendEntity(entity);
          console.log(`  New: ${entity.pi} (v${entity.ver})`);
        }

        // Update cursor to most recent entity
        this.state.cursor_pi = newEntities[0].pi;
        this.state.total_entities += updates;
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

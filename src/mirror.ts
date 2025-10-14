import { readFileSync, writeFileSync, existsSync } from 'fs';
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
  phase: 'not_started' | 'bulk_sync' | 'chain_connection' | 'incremental_polling';
  pis: Record<string, number>; // pi -> version
  connected: boolean;
  backoff_seconds: number;
  last_poll_time: string | null;
  total_entities: number;
}

class ArkeIPFSMirror {
  private apiBaseUrl: string;
  private state: MirrorState;
  private stateFilePath: string;
  private minBackoff = 30;
  private maxBackoff = 600;

  constructor(apiBaseUrl: string, stateFilePath?: string) {
    this.apiBaseUrl = apiBaseUrl;
    this.stateFilePath = stateFilePath || join(dirname(__dirname), 'mirror-state.json');
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
      pis: {},
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

  // Phase 1: Bulk Sync
  private async bulkSync(): Promise<void> {
    console.log('=== Phase 1: Bulk Sync ===');
    console.log('Downloading snapshot...');

    try {
      const response = await fetch(`${this.apiBaseUrl}/snapshot/latest`);

      if (response.status === 404) {
        console.log('No snapshot exists yet - system is new');
        console.log('Skipping to chain connection phase');
        this.state.phase = 'chain_connection';
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

      // Load entities from snapshot
      for (const entry of snapshot.entries) {
        this.state.pis[entry.pi] = entry.ver;
        console.log(`  Loaded: ${entry.pi} (v${entry.ver})`);
      }

      this.state.total_entities = Object.keys(this.state.pis).length;
      this.state.phase = 'chain_connection';
      this.saveState();

      console.log(`\nBulk sync complete: ${this.state.total_entities} entities loaded`);
    } catch (error) {
      console.error('Bulk sync failed:', error);
      throw error;
    }
  }

  // Phase 2: Chain Connection
  private async connectChains(): Promise<void> {
    console.log('\n=== Phase 2: Chain Connection ===');
    console.log('Walking live chain backwards to find overlap...');

    const seenPis = new Set(Object.keys(this.state.pis));
    let cursor: string | undefined = undefined;
    const newEntities: EntityEntry[] = [];
    let pollCount = 0;

    try {
      while (true) {
        pollCount++;
        let url = `${this.apiBaseUrl}/entities?limit=100`;
        if (cursor) {
          url += `&cursor=${cursor}`;
        }

        console.log(`  Poll ${pollCount}: fetching...`);
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Entities fetch failed: ${response.status}`);
        }

        const data = await response.json() as EntitiesResponse;
        let foundOverlap = false;

        for (const entity of data.items) {
          if (seenPis.has(entity.pi)) {
            // Found the connection point!
            foundOverlap = true;
            console.log(`  ✓ Connected chains at PI: ${entity.pi}`);
            break;
          } else {
            // New entity not in snapshot
            newEntities.push(entity);
            seenPis.add(entity.pi);
          }
        }

        if (foundOverlap) {
          break;
        }

        if (!data.has_more) {
          // Reached end of chain without finding overlap
          console.log('  Reached end of chain - no overlap needed (fresh system)');
          break;
        }

        cursor = data.next_cursor;
      }

      // Store new entities in order (reverse since we walked backwards)
      console.log(`\nAdding ${newEntities.length} new entities found since snapshot:`);
      for (const entity of newEntities.reverse()) {
        this.state.pis[entity.pi] = entity.ver;
        console.log(`  New: ${entity.pi} (v${entity.ver})`);
      }

      this.state.total_entities = Object.keys(this.state.pis).length;
      this.state.connected = true;
      this.state.phase = 'incremental_polling';
      this.saveState();

      console.log(`\nChain connection complete!`);
      console.log(`  - Total entities: ${this.state.total_entities}`);
      console.log(`  - Ready for incremental polling`);
    } catch (error) {
      console.error('Chain connection failed:', error);
      throw error;
    }
  }

  // Phase 3: Incremental Polling
  private async pollForUpdates(): Promise<{ updates: number; allSeen: boolean }> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/entities?limit=50`);

      if (!response.ok) {
        throw new Error(`Poll failed: ${response.status}`);
      }

      const data = await response.json() as EntitiesResponse;

      let updates = 0;
      let allSeen = true;

      for (const entity of data.items) {
        const { pi, ver } = entity;
        const localVer = this.state.pis[pi];

        if (localVer === undefined) {
          // New PI
          this.state.pis[pi] = ver;
          updates++;
          allSeen = false;
          console.log(`  NEW: ${pi} (v${ver})`);
        } else if (localVer < ver) {
          // Updated PI (version increased)
          console.log(`  UPDATE: ${pi} v${localVer} -> v${ver}`);
          this.state.pis[pi] = ver;
          updates++;
          allSeen = false;
        }
        // else: Already have this exact version, skip
      }

      this.state.total_entities = Object.keys(this.state.pis).length;
      this.state.last_poll_time = new Date().toISOString();
      this.saveState();

      return { updates, allSeen };
    } catch (error) {
      console.error('Poll failed:', error);
      throw error;
    }
  }

  // Initialize: Phase 1 + 2
  async initialize(): Promise<void> {
    if (this.state.phase === 'not_started') {
      await this.bulkSync();
    }

    if (this.state.phase === 'chain_connection' && !this.state.connected) {
      await this.connectChains();
    }

    if (this.state.phase === 'incremental_polling') {
      console.log('\n=== Mirror Already Initialized ===');
      console.log(`  - Total entities: ${this.state.total_entities}`);
      console.log(`  - Last poll: ${this.state.last_poll_time || 'never'}`);
      console.log(`  - Current backoff: ${this.state.backoff_seconds}s`);
    }
  }

  // Main poll loop (Phase 3)
  async pollLoop(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Must call initialize() first');
    }

    console.log('\n=== Phase 3: Incremental Polling ===');
    console.log('Starting continuous polling with exponential backoff...\n');

    while (true) {
      console.log(`[${new Date().toISOString()}] Polling for updates...`);

      try {
        const { updates, allSeen } = await this.pollForUpdates();

        if (updates > 0) {
          // Activity detected - reset to minimum
          console.log(`  Found ${updates} updates, resetting backoff`);
          this.state.backoff_seconds = this.minBackoff;
        } else if (allSeen) {
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
    console.log(`State File: ${this.stateFilePath}\n`);

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

  // Get state file path from environment (for Docker/Fly.io deployment)
  const stateFilePath = process.env.STATE_FILE_PATH;

  const mirror = new ArkeIPFSMirror(apiBaseUrl, stateFilePath);

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

import { GlobalKVStore, WalletClient, StorageUploader, WalletProtocol } from '@bsv/sdk';
import {
  GlossConfig,
  LogEntry,
  CreateLogOptions,
  QueryOptions,
  UploadResult,
  UploadOptions
} from './types.js';

// Protocol identifier for gloss logs
const GLOSS_PROTOCOL_ID: WalletProtocol = [1, 'gloss logs'];

/**
 * GlossClient - Global developer logging client
 *
 * Creates globally discoverable developer logs using BSV blockchain and GlobalKVStore.
 * Each log entry is stored as an individual UTXO enabling granular operations:
 * - Individual log removal
 * - Log updates with history preservation
 * - True blockchain audit trails
 *
 * Key format (UTC):
 *   entry/{YYYY-MM-DD}/{HHmmss-SSS<rand>}
 *
 * Discovery & Pagination:
 *   GlobalKVStore does NOT support key-prefix queries. listDay() scans by protocolID
 *   with paging (limit/skip) and filters client-side by date (and optional tags/controller).
 */
export class GlossClient {
  private kv: GlobalKVStore;
  private config: Required<GlossConfig>;
  private identityKey: string | null = null;

  constructor(config: GlossConfig = {}) {
    // Set defaults
    this.config = {
      wallet: config.wallet ?? new WalletClient('auto', config.walletHost ?? 'http://localhost'),
      networkPreset: config.networkPreset ?? 'mainnet',
      walletMode: config.walletMode ?? 'auto',
      walletHost: config.walletHost ?? 'http://localhost'
    };

    // Initialize GlobalKVStore
    this.kv = new GlobalKVStore({
      wallet: this.config.wallet,
      protocolID: GLOSS_PROTOCOL_ID,
      serviceName: 'ls_kvstore',
      topics: ['tm_kvstore'],
      networkPreset: this.config.networkPreset,
      tokenSetDescription: 'Gloss developer log entry',
      tokenUpdateDescription: 'Updated gloss log entry',
      tokenRemovalDescription: 'Removed gloss log entry'
    });
  }

  /**
   * Initialize and memoize the identity key (called automatically when needed).
   */
  private async ensureIdentityKey(): Promise<string> {
    if (!this.identityKey) {
      const result = await this.config.wallet.getPublicKey({ identityKey: true });
      this.identityKey = result.publicKey;
    }
    return this.identityKey!;
  }

  /**
   * Create a new log entry (UTC date & time).
   *
   * @param text - The log message
   * @param options - Optional configuration
   * @returns The created log entry
   */
  async log(text: string, options: CreateLogOptions = {}): Promise<LogEntry> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
    const key = this.nextIdForDay(day);         // entry/YYYY-MM-DD/HHmmss-SSS<rand>

    const entry: LogEntry = {
      key,
      at: now.toISOString(), // UTC ISO timestamp
      text,
      tags: options.tags ?? [],
      assets: options.assets ?? []
    };

    await this.putEntry(entry);
    return entry;
  }

  /**
   * Get all log entries for a specific UTC date.
   * Alias for listDay(date).
   *
   * @param date - Date in YYYY-MM-DD (UTC) format
   */
  async get(date: string): Promise<LogEntry[]> {
    return this.listDay(date);
  }

  /**
   * List all log entries for a specific UTC date from all users.
   *
   * NOTE: GlobalKVStore.get() cannot prefix-match the key.
   * We page across protocol results (limit/skip) and filter by the date key prefix client-side.
   *
   * @param date - YYYY-MM-DD (UTC)
   * @param options - Optional filters and pagination (see QueryOptions)
   * @returns entries sorted by key (chronological in UTC)
   */
  async listDay(date: string, options: QueryOptions = {}): Promise<LogEntry[]> {
    const keyPrefix = `entry/${date}/`;

    // Store-page scan controls (with guardrails)
    const pageSize = Math.max(1, Math.min(options.pageSize ?? 500, 2000));
    const maxPages = Math.max(1, options.maxPages ?? 20);
    const want = options.limit && options.limit > 0 ? options.limit : undefined;

    let skip = Math.max(0, options.skip ?? 0);
    const out: LogEntry[] = [];

    const consider = (rec: any) => {
      if (!rec?.value || typeof rec.value !== 'string') return;
      if (!rec.key?.startsWith(keyPrefix)) return;
      try {
        const e = JSON.parse(rec.value) as LogEntry;
        if (rec.controller) e.controller = rec.controller;
        out.push(e);
      } catch {
        // ignore malformed entries
      }
    };

    for (let page = 0; page < maxPages; page++) {
      const res = await this.kv.get({
        protocolID: GLOSS_PROTOCOL_ID,
        limit: pageSize,
        skip,
        sortOrder: options.sortOrder ?? 'asc'
      });

      const rows = Array.isArray(res) ? res : res ? [res] : [];
      if (rows.length === 0) break;

      for (const r of rows) consider(r);

      if (want && out.length >= want) break;
      skip += rows.length;
    }

    // Client-side filters
    let filtered = out;

    if (options.controller) {
      filtered = filtered.filter(e => e.controller === options.controller);
    }
    if (options.tags?.length) {
      filtered = filtered.filter(e => e.tags?.some(t => options.tags!.includes(t)));
    }

    // Sort by key (lexicographic aligns with UTC timestamp segment)
    if ((options.sortOrder ?? 'asc') === 'asc') {
      filtered.sort((a, b) => a.key.localeCompare(b.key));
    } else {
      filtered.sort((a, b) => b.key.localeCompare(a.key));
    }

    // Apply final limit after filtering
    if (want) filtered = filtered.slice(0, want);

    return filtered;
  }

  /**
   * List today's log entries from all users (UTC "today").
   */
  async listToday(options: QueryOptions = {}): Promise<LogEntry[]> {
    const today = new Date().toISOString().slice(0, 10);
    return this.listDay(today, options);
  }

  /**
   * Remove a specific log entry by its full key.
   * Only the controller (creator) can remove their own logs.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   * @returns true if removed; false if not found or not owned
   */
  async removeEntry(logKey: string): Promise<boolean> {
    const identityKey = await this.ensureIdentityKey();
    const datePart = logKey.split('/')[0];

    // Scan enough to likely include the target (tune maxPages/pageSize if your day is heavy)
    const myEntries = await this.listDay(datePart, {
      controller: identityKey,
      limit: 10000,
      pageSize: 500,
      maxPages: 40,
      sortOrder: 'asc'
    });

    const entry = myEntries.find(e => e.key === logKey);
    if (!entry) return false;

    await this.kv.remove(`entry/${entry.key}`);
    return true;
  }

  /**
   * Remove an entire day's logs (all your logs for a specific UTC date).
   *
   * @param date - Date in YYYY-MM-DD (UTC) format
   * @returns true if any were removed
   */
  async removeDay(date: string): Promise<boolean> {
    const identityKey = await this.ensureIdentityKey();
    let removedAny = false;

    // Iterate pages until we stop seeing results
    let skip = 0;
    const pageSize = 500;

    while (true) {
      const page = await this.listDay(date, {
        controller: identityKey,
        limit: pageSize,  // desired results after filtering
        skip,
        pageSize,         // store page size
        maxPages: 1,      // scan exactly one store page per loop
        sortOrder: 'asc'
      });

      if (page.length === 0) break;

      for (const entry of page) {
        await this.kv.remove(`entry/${entry.key}`);
        removedAny = true;
      }

      skip += pageSize;
    }

    return removedAny;
  }

  /**
   * Update a specific log entry by spending its UTXO and creating a new one.
   * Only the controller (creator) can update their own logs.
   * The old log becomes part of the spend chain history.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   * @param newText - New text for the log entry
   * @param options - Optional configuration for the updated entry
   * @returns The updated log entry, or undefined if not found/owned
   */
  async updateEntryByKey(
    logKey: string,
    newText: string,
    options: CreateLogOptions = {}
  ): Promise<LogEntry | undefined> {
    const identityKey = await this.ensureIdentityKey();
    const datePart = logKey.split('/')[0];

    const myEntries = await this.listDay(datePart, { controller: identityKey, limit: 1000 });
    const current = myEntries.find(e => e.key === logKey);
    if (!current) return undefined;

    const updated: LogEntry = {
      key: current.key,                 // spend same UTXO key lineage
      at: new Date().toISOString(),     // UTC timestamp for the update
      text: newText,
      tags: options.tags ?? current.tags ?? [],
      assets: options.assets ?? current.assets ?? []
    };

    await this.putEntry(updated); // set() spends prior value
    return updated;
  }

  /**
   * Get the full history of a specific log entry (current + historical versions).
   * Sorted by `at` descending; falls back to key order if needed.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   */
  async getLogHistory(logKey: string): Promise<LogEntry[]> {
    const entryKey = `entry/${logKey}`;
    const result = await this.kv.get({ key: entryKey }, { history: true });

    const history: LogEntry[] = [];

    const ingest = (rec: any) => {
      if (rec?.value) {
        try {
          const cur = JSON.parse(rec.value) as LogEntry;
          if (rec.controller) cur.controller = rec.controller;
          history.push(cur);
        } catch { /* ignore */ }
      }
      if (Array.isArray(rec?.history)) {
        for (const hv of rec.history) {
          try {
            const h = JSON.parse(hv) as LogEntry;
            if (rec.controller) h.controller = rec.controller;
            history.push(h);
          } catch { /* ignore */ }
        }
      }
    };

    if (Array.isArray(result)) {
      if (result[0]) ingest(result[0]);
    } else if (result) {
      ingest(result);
    }

    // Sort newest first by `at` (ISO). Fallback to key (descending).
    history.sort((a, b) => {
      const atA = a.at ?? '';
      const atB = b.at ?? '';
      if (atA && atB) return atA > atB ? -1 : atA < atB ? 1 : 0;
      return a.key > b.key ? -1 : a.key < b.key ? 1 : 0;
    });

    return history;
  }

  /**
   * Upload an asset to UHRP storage and get the URL.
   *
   * retentionMinutes are minutes (default 30 days).
   */
  async uploadAsset(
    data: Uint8Array,
    mimeType: string,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    const uploader = new StorageUploader({
      storageURL: options.storageURL ?? 'https://nanostore.babbage.systems',
      wallet: this.config.wallet
    } as any);

    const res: any = await uploader.publishFile({
      file: { data, type: mimeType },
      retentionPeriod: options.retentionMinutes ?? 60 * 24 * 30 // minutes; 30 days default
    } as any);

    return {
      uhrpURL: String(res.uhrpURL ?? res.url),
      published: Boolean(res.published ?? true)
    };
  }

  /**
   * Create a log entry with an uploaded asset.
   */
  async logWithAsset(
    text: string,
    data: Uint8Array,
    mimeType: string,
    options: CreateLogOptions & UploadOptions = {}
  ): Promise<LogEntry> {
    const uploadResult = await this.uploadAsset(data, mimeType, options);

    return this.log(text, {
      ...options,
      assets: [...(options.assets ?? []), uploadResult.uhrpURL]
    });
  }

  /**
   * Generate a unique UTC log key (internal).
   * Format: YYYY-MM-DD/HHmmss-SSS<rand>
   */
  private nextIdForDay(yyyyMmDd: string): string {
    const now = new Date();
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
    const rand = Math.random().toString(36).slice(2, 6); // reduce collision risk
    return `${yyyyMmDd}/${hours}${minutes}${seconds}-${milliseconds}${rand}`;
  }

  /**
   * Store a log entry (internal).
   * Each call spends/replaces the previous UTXO for this key lineage.
   */
  private async putEntry(entry: LogEntry): Promise<void> {
    const entryKey = `entry/${entry.key}`;
    await this.kv.set(entryKey, JSON.stringify(entry));
  }
}

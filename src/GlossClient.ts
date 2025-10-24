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
 * 
 * Architecture:
 * - Each log() call creates a new token spending the previous day token
 * - Each token contains a single log entry (not a chain of entries)
 * - History traversal reconstructs all logs for a day by following the spend chain
 * - This eliminates data duplication and keeps tokens minimal
 *
 * Key format:
 *   entry/{YYYY-MM-DD}  (day-level key, each log spends previous token)
 *
 * Log Entry format (UTC):
 *   {YYYY-MM-DD}/{HHmmss-SSS<rand>}
 *
 * Discovery:
 *   listDay() queries by day key with history=true to traverse the spend chain
 *   and collect all individual log entries for that day.
 */
export class GlossClient {
  private kv: GlobalKVStore;
  private config: Required<GlossConfig>;
  private identityKey: string | null = null;

  constructor(config: GlossConfig = {}) {
    // Set defaults
    this.config = {
      // Handle special case where running local requires explicit originator
      wallet: config.wallet ?? new WalletClient('auto', config.walletMode === 'local' ? 'http://localhost' : undefined),
      networkPreset: config.networkPreset ?? 'mainnet',
      walletMode: config.walletMode ?? 'auto'
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
   * Each log is stored as a single entry in its own token.
   * History traversal reconstructs the full day.
   *
   * @param text - The log message
   * @param options - Optional configuration
   * @returns The created log entry
   */
  async log(text: string, options: CreateLogOptions = {}): Promise<LogEntry> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const identityKey = await this.ensureIdentityKey();
    const key = this.nextIdForDay(day, now);

    const entry: LogEntry = {
      key,
      at: now.toISOString(),
      text,
      tags: options.tags ?? [],
      assets: options.assets ?? [],
      controller: identityKey
    };

    // Store only this single log entry (not the entire day chain)
    const serialized = JSON.stringify(entry);
    const tags = [...(options.tags ?? []), day]; // Include day as tag for filtering
    await this.kv.set(this.dayKey(day), serialized, { tags });
    
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
   * Uses history traversal to collect individual log entries.
   *
   * @param date - YYYY-MM-DD (UTC)
   * @param options - Optional filters and pagination (see QueryOptions)
   * @returns entries sorted by key (chronological in UTC)
   */
  async listDay(date: string, options: QueryOptions = {}): Promise<LogEntry[]> {
    const dayKey = this.dayKey(date);
    const query: any = { key: dayKey };

    if (options.controller) {
      query.controller = options.controller;
    }

    if (options.tags && options.tags.length > 0) {
      query.tags = options.tags;
      if (options.tagQueryMode) {
        query.tagQueryMode = options.tagQueryMode;
      }
    }

    const getOptions: any = { history: true };
    if (options.includeTxid) {
      getOptions.includeToken = true;
    }

    const result = await this.kv.get(query, getOptions);
    const rows = Array.isArray(result) ? result : result ? [result] : [];

    const tagSet = options.tags && options.tags.length > 0 ? new Set(options.tags) : undefined;
    const logs: LogEntry[] = [];
    const seenKeys = new Set<string>(); // Deduplicate entries

    // Process current and historical entries
    for (const record of rows) {
      const txid = record.token?.txid;
      
      // Process current entry
      if (typeof record?.value === 'string') {
        const log = this.parseLogEntry(record.value, record.controller);
        if (log && !seenKeys.has(log.key)) {
          if (options.controller && log.controller !== options.controller) continue;
          if (tagSet && !this.matchesTagFilter(log.tags ?? [], tagSet, options.tagQueryMode)) continue;
          
          const clonedLog = this.cloneLog(log);
          if (options.includeTxid && txid) {
            clonedLog.txid = txid;
          }
          logs.push(clonedLog);
          seenKeys.add(log.key);
        }
      }

      // Process historical entries
      if (Array.isArray(record?.history)) {
        for (const pastValue of record.history) {
          if (typeof pastValue !== 'string') continue;
          
          const log = this.parseLogEntry(pastValue, record.controller);
          if (log && !seenKeys.has(log.key)) {
            if (options.controller && log.controller !== options.controller) continue;
            if (tagSet && !this.matchesTagFilter(log.tags ?? [], tagSet, options.tagQueryMode)) continue;
            
            const clonedLog = this.cloneLog(log);
            if (options.includeTxid && txid) {
              clonedLog.txid = txid;
            }
            logs.push(clonedLog);
            seenKeys.add(log.key);
          }
        }
      }
    }

    const sortOrder = options.sortOrder ?? 'asc';
    logs.sort((a, b) => a.key.localeCompare(b.key));
    if (sortOrder === 'desc') {
      logs.reverse();
    }

    const skip = Math.max(0, options.skip ?? 0);
    const limited = options.limit && options.limit > 0 ? logs.slice(skip, skip + options.limit) : logs.slice(skip);

    return limited;
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
   * Note: In the new architecture, each log is its own token.
   * To "remove" a specific entry, we need to spend the day token without including that entry.
   * This is complex, so for now this removes the entire day's token.
   * For granular removal, consider using updateEntryByKey to mark as deleted.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   * @returns true if removed; false if not found or not owned
   * @deprecated Consider using removeDay() or marking entries as deleted instead
   */
  async removeEntry(logKey: string): Promise<boolean> {
    // In single-entry architecture, we would need to:
    // 1. Find the specific token containing this log
    // 2. Spend it to remove it
    // This requires token-level removal which isn't straightforward with the current key structure
    // For now, remove the entire day
    const datePart = logKey.split('/')[0];
    return this.removeDay(datePart);
  }

  /**
   * Remove an entire day's logs (all your logs for a specific UTC date).
   *
   * @param date - Date in YYYY-MM-DD (UTC) format
   * @returns true if any were removed
   */
  async removeDay(date: string): Promise<boolean> {
    try {
      await this.kv.remove(this.dayKey(date));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update a specific log entry by spending its UTXO and creating a new one.
   * Only the controller (creator) can update their own logs.
   * The old log becomes part of the spend chain history.
   * The updated entry keeps the same key but has a new timestamp and content.
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
    
    // First, verify the log exists and we own it
    const existing = await this.listDay(datePart, { controller: identityKey });
    const current = existing.find(log => log.key === logKey);
    
    if (!current) return undefined;

    // Create updated entry with same key
    const updated: LogEntry = {
      key: logKey,
      at: new Date().toISOString(),
      text: newText,
      tags: options.tags ?? current.tags ?? [],
      assets: options.assets ?? current.assets ?? [],
      controller: identityKey
    };

    // Store the updated entry (spends the previous token via the day key)
    const serialized = JSON.stringify(updated);
    const tags = [...(updated.tags ?? []), datePart];
    await this.kv.set(this.dayKey(datePart), serialized, { tags });
    
    return updated;
  }

  /**
   * Get the full history of a specific log entry (current + historical versions).
   * Sorted by `at` descending; falls back to key order if needed.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   * @param options - Optional query configuration (only includeTxid is used)
   */
  async getLogHistory(logKey: string, options: Pick<QueryOptions, 'includeTxid'> = {}): Promise<LogEntry[]> {
    const day = logKey.split('/')[0];
    const dayKey = this.dayKey(day);
    
    const getOptions: any = { history: true };
    if (options.includeTxid) {
      getOptions.includeToken = true;
    }
    
    const result = await this.kv.get({ key: dayKey }, getOptions);

    const rows = Array.isArray(result) ? result : result ? [result] : [];
    const history: LogEntry[] = [];

    const ingest = (value: string | undefined, controller?: string, txid?: string) => {
      if (!value) return;
      const log = this.parseLogEntry(value, controller);
      if (!log) return;
      if (log.key !== logKey) return;
      
      const clonedLog = this.cloneLog(log);
      if (options.includeTxid && txid) {
        clonedLog.txid = txid;
      }
      history.push(clonedLog);
    };

    for (const record of rows) {
      if (typeof record?.value === 'string') {
        ingest(record.value, record.controller, record.token?.txid);
      }
      if (Array.isArray(record?.history)) {
        for (const past of record.history) {
          if (typeof past === 'string') {
            ingest(past, record.controller, record.token?.txid);
          }
        }
      }
    }

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
  private nextIdForDay(yyyyMmDd: string, reference?: Date): string {
    const base = reference ?? new Date();
    const hours = String(base.getUTCHours()).padStart(2, '0');
    const minutes = String(base.getUTCMinutes()).padStart(2, '0');
    const seconds = String(base.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(base.getUTCMilliseconds()).padStart(3, '0');
    const rand = Math.random().toString(36).slice(2, 6);
    return `${yyyyMmDd}/${hours}${minutes}${seconds}-${milliseconds}${rand}`;
  }

  /**
   * Store a log entry (internal).
   * Each call spends/replaces the previous UTXO for this key lineage.
   */
  private dayKey(day: string): string {
    return `entry/${day}`;
  }

  private parseLogEntry(value: string, controller?: string): LogEntry | null {
    try {
      const parsed = JSON.parse(value);
      if (parsed == null || typeof parsed !== 'object') {
        return null;
      }
      
      // Handle new format (single entry) or old format (day chain) for backward compatibility
      if (Array.isArray(parsed.logs)) {
        // Old day chain format - extract first log
        // This ensures backward compatibility with data created before this refactor
        if (parsed.logs.length > 0) {
          return this.normalizeLog(parsed.logs[0], controller);
        }
        return null;
      }
      
      return this.normalizeLog(parsed, controller);
    } catch {
      return null;
    }
  }

  private matchesTagFilter(tags: string[], filter: Set<string>, mode: QueryOptions['tagQueryMode']): boolean {
    if (tags.length === 0) {
      return false;
    }

    if (mode === 'all') {
      for (const wanted of filter) {
        if (!tags.includes(wanted)) {
          return false;
        }
      }
      return true;
    }

    for (const tag of tags) {
      if (filter.has(tag)) {
        return true;
      }
    }
    return false;
  }

  private cloneLog(log: LogEntry): LogEntry {
    return {
      key: log.key,
      at: log.at,
      text: log.text,
      tags: log.tags ? [...log.tags] : undefined,
      assets: log.assets ? [...log.assets] : undefined,
      controller: log.controller,
      txid: log.txid
    };
  }

  private normalizeLog(raw: any, controller?: string): LogEntry | null {
    if (raw == null || typeof raw !== 'object') {
      return null;
    }

    const key = typeof raw.key === 'string' ? raw.key : this.nextIdForDay(new Date().toISOString().slice(0, 10));
    const at = typeof raw.at === 'string' ? raw.at : new Date().toISOString();
    const text = typeof raw.text === 'string' ? raw.text : '';
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag: unknown) => typeof tag === 'string') : undefined;
    const assets = Array.isArray(raw.assets) ? raw.assets.filter((asset: unknown) => typeof asset === 'string') : undefined;
    const ctrl = typeof raw.controller === 'string' ? raw.controller : controller;

    if (!key || !text) {
      return null;
    }

    const normalizedKey = key.includes('/') ? key : `${at.slice(0, 10)}/${key}`;

    return {
      key: normalizedKey,
      at,
      text,
      tags,
      assets,
      controller: ctrl
    };
  }
}

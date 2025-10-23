import { GlobalKVStore, WalletClient, StorageUploader, WalletProtocol } from '@bsv/sdk';
import {
  GlossConfig,
  LogEntry,
  CreateLogOptions,
  QueryOptions,
  UploadResult,
  UploadOptions,
  DayChain
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

    const chain = await this.loadDayChain(day, identityKey);
    chain.logs.push(entry);
    this.sortLogs(chain.logs);

    await this.saveDayChain(chain);
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

    const result = await this.kv.get(query);
    const rows = Array.isArray(result) ? result : result ? [result] : [];

    const tagSet = options.tags && options.tags.length > 0 ? new Set(options.tags) : undefined;
    const logs: LogEntry[] = [];

    for (const record of rows) {
      if (typeof record?.value !== 'string') continue;

      const chain = this.parseDayChain(record.value, record.controller);
      if (!chain) continue;

      for (const log of chain.logs) {
        if (options.controller && log.controller !== options.controller) continue;
        if (tagSet && !this.matchesTagFilter(log.tags ?? [], tagSet, options.tagQueryMode)) continue;
        logs.push(this.cloneLog(log));
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
   * Only the controller (creator) can remove their own logs.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   * @returns true if removed; false if not found or not owned
   */
  async removeEntry(logKey: string): Promise<boolean> {
    const identityKey = await this.ensureIdentityKey();
    const datePart = logKey.split('/')[0];
    const chain = await this.loadDayChain(datePart, identityKey);

    const index = chain.logs.findIndex(log => log.key === logKey);
    if (index === -1) return false;

    chain.logs.splice(index, 1);

    if (chain.logs.length === 0) {
      try {
        await this.kv.remove(this.dayKey(datePart));
      } catch {
        return false;
      }
    } else {
      await this.saveDayChain(chain);
    }

    return true;
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
    const chain = await this.loadDayChain(datePart, identityKey);

    const index = chain.logs.findIndex(log => log.key === logKey);
    if (index === -1) return undefined;

    const current = chain.logs[index];
    const updated: LogEntry = {
      key: current.key,
      at: new Date().toISOString(),
      text: newText,
      tags: options.tags ?? current.tags ?? [],
      assets: options.assets ?? current.assets ?? [],
      controller: identityKey
    };

    chain.logs[index] = updated;
    this.sortLogs(chain.logs);

    await this.saveDayChain(chain);
    return updated;
  }

  /**
   * Get the full history of a specific log entry (current + historical versions).
   * Sorted by `at` descending; falls back to key order if needed.
   *
   * @param logKey - Full log key (e.g., "2025-10-07/143022-456abcd")
   */
  async getLogHistory(logKey: string): Promise<LogEntry[]> {
    const day = logKey.split('/')[0];
    const dayKey = this.dayKey(day);
    const result = await this.kv.get({ key: dayKey }, { history: true });

    const rows = Array.isArray(result) ? result : result ? [result] : [];
    const history: LogEntry[] = [];

    const ingest = (value: string | undefined, controller?: string) => {
      if (!value) return;
      const chain = this.parseDayChain(value, controller);
      if (!chain) return;
      for (const log of chain.logs) {
        if (log.key !== logKey) continue;
        history.push(this.cloneLog(log));
      }
    };

    for (const record of rows) {
      if (typeof record?.value === 'string') {
        ingest(record.value, record.controller);
      }
      if (Array.isArray(record?.history)) {
        for (const past of record.history) {
          if (typeof past === 'string') {
            ingest(past, record.controller);
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

  private async loadDayChain(day: string, controller: string): Promise<DayChain> {
    const key = this.dayKey(day);
    const existing = await this.kv.get({ key, controller });
    const entry = Array.isArray(existing) ? existing[0] : existing;

    if (entry && typeof entry.value === 'string') {
      const chain = this.parseDayChain(entry.value, controller);
      if (chain) {
        return chain;
      }
    }

    return { key: day, logs: [] };
  }

  private async saveDayChain(chain: DayChain): Promise<void> {
    const serialized = JSON.stringify(chain);
    const tags = this.collectTags(chain.logs);
    if (tags.length > 0) {
      await this.kv.set(this.dayKey(chain.key), serialized, { tags });
    } else {
      await this.kv.set(this.dayKey(chain.key), serialized);
    }
  }

  private parseDayChain(value: string, controller?: string): DayChain | null {
    try {
      const parsed = JSON.parse(value);

      if (parsed == null || typeof parsed !== 'object') {
        return null;
      }

      if (Array.isArray(parsed.logs)) {
        const logs: LogEntry[] = [];
        for (const raw of parsed.logs) {
          const normalized = this.normalizeLog(raw, controller);
          if (normalized) logs.push(normalized);
        }
        if (logs.length === 0) return null;
        const key = typeof parsed.key === 'string' && parsed.key.length > 0
          ? parsed.key
          : logs[0].key.split('/')[0];
        return { key, logs };
      }

      const single = this.normalizeLog(parsed, controller);
      if (!single) return null;
      const key = single.key.split('/')[0];
      return { key, logs: [single] };
    } catch {
      return null;
    }
  }

  private collectTags(logs: LogEntry[]): string[] {
    const set = new Set<string>();
    for (const log of logs) {
      if (!Array.isArray(log.tags)) continue;
      for (const tag of log.tags) {
        if (typeof tag === 'string' && tag.trim() !== '') {
          set.add(tag);
        }
      }
    }
    return Array.from(set);
  }

  private sortLogs(logs: LogEntry[]): void {
    logs.sort((a, b) => a.key.localeCompare(b.key));
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
      controller: log.controller
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

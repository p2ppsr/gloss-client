import { GlobalKVStore, WalletClient, StorageUploader } from '@bsv/sdk';
import { GlossConfig, LogEntry, DayChain, CreateLogOptions, QueryOptions, UploadResult, UploadOptions } from './types.js';

// Protocol identifier for gloss logs
const GLOSS_PROTOCOL_ID: [1, 'gloss logs'] = [1, 'gloss logs'];

/**
 * GlossClient - Global developer logging client
 * 
 * Creates globally discoverable developer logs using BSV blockchain and GlobalKVStore.
 * Each log entry is stored as an individual UTXO enabling granular operations:
 * - Individual log removal
 * - Log updates with history preservation  
 * - Parallel logging without conflicts
 * - True blockchain audit trails
 * 
 * @example
 * ```typescript
 * const gloss = new GlossClient();
 * 
 * // Create a log entry
 * const entry = await gloss.log('Fixed user authentication bug', { 
 *   tags: ['auth', 'bugfix'] 
 * });
 * 
 * // Update the log entry
 * await gloss.updateEntry('2025-10-07', 'Fixed user authentication bug', 
 *   'Fixed user authentication and authorization bugs');
 * 
 * // View update history
 * const history = await gloss.getLogHistory(entry.key);
 * 
 * // List today's logs from all users
 * const todayLogs = await gloss.listToday();
 * 
 * // Remove a specific log
 * await gloss.removeEntry('2025-10-07', 'Some message to remove');
 * ```
 */
export class GlossClient {
  private kv: GlobalKVStore;
  private config: Required<GlossConfig>;
  private identityKey: string | null = null;

  constructor(config: GlossConfig = {}) {
    // Set defaults
    this.config = {
      wallet: config.wallet ?? new WalletClient(config.walletMode ?? 'auto', `http://${config.walletHost ?? 'localhost'}`),
      networkPreset: config.networkPreset ?? 'mainnet',
      walletHost: config.walletHost ?? 'localhost',
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
   * Initialize the identity key (called automatically when needed)
   */
  private async ensureIdentityKey(): Promise<string> {
    if (!this.identityKey) {
      const result = await this.config.wallet.getPublicKey({ identityKey: true });
      this.identityKey = result.publicKey;
    }
    return this.identityKey!;
  }

  /**
   * Create a new log entry
   * 
   * @param text - The log message
   * @param options - Optional configuration
   * @returns Promise resolving to the created log entry
   */
  async log(text: string, options: CreateLogOptions = {}): Promise<LogEntry> {
    const day = new Date().toISOString().slice(0, 10);
    const key = await this.nextIdForDay(day); // Returns the day itself

    const entry: LogEntry = {
      key,
      at: new Date().toISOString(),
      text,
      tags: options.tags ?? [],
      assets: options.assets ?? []
    };

    await this.putEntry(entry);
    return entry;
  }

  /**
   * Get all log entries for a specific date reconstructed from spend chain
   * 
   * @param key - The date key (e.g., "2025-10-06")
   * @returns Promise resolving to array of log entries for that date
   */
  async get(key: string): Promise<LogEntry[]> {
    return this.listDay(key);
  }

  /**
   * List all log entries for a specific date from all users
   * Queries individual log UTXOs using protocolID
   * 
   * @param date - Date in YYYY-MM-DD format
   * @param options - Optional query filters
   * @returns Promise resolving to array of log entries, sorted chronologically
   */
  async listDay(date: string, options: QueryOptions = {}): Promise<LogEntry[]> {
    // Query all logs using protocolID to get all gloss logs, then filter by date
    const result = await this.kv.get({ protocolID: GLOSS_PROTOCOL_ID });

    const allEntries: LogEntry[] = [];

    if (Array.isArray(result)) {
      // Multiple log entries found
      for (const logResult of result) {
        if (logResult.key?.startsWith(`entry/${date}/`) && logResult.value) {
          try {
            const logEntry = JSON.parse(logResult.value) as LogEntry;
            if (logResult.controller) {
              logEntry.controller = logResult.controller;
            }
            allEntries.push(logEntry);
          } catch (e) {
            console.warn(`Failed to parse log entry: ${logResult.key}`, e);
          }
        }
      }
    } else if (result?.key?.startsWith(`entry/${date}/`) && result?.value) {
      // Single log entry found
      try {
        const logEntry = JSON.parse(result.value) as LogEntry;
        if (result.controller) {
          logEntry.controller = result.controller;
        }
        allEntries.push(logEntry);
      } catch (e) {
        console.warn(`Failed to parse log entry: ${result.key}`, e);
      }
    }

    // Apply filters
    let filtered = allEntries;

    if (options.controller) {
      filtered = filtered.filter(entry => entry.controller === options.controller);
    }

    if (options.tags && options.tags.length > 0) {
      filtered = filtered.filter(entry =>
        entry.tags?.some(tag => options.tags!.includes(tag))
      );
    }

    // Sort by timestamp
    filtered.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    // Apply limit
    if (options.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * List today's log entries from all users
   * 
   * @param options - Optional query filters
   * @returns Promise resolving to array of today's log entries
   */
  async listToday(options: QueryOptions = {}): Promise<LogEntry[]> {
    const today = new Date().toISOString().slice(0, 10);
    return this.listDay(today, options);
  }

  /**
   * Remove a specific log entry by unique key or date+text
   * Only the controller (creator) can remove their own logs
   * 
   * @param keyOrDate - Either full log key (e.g., "2025-10-07/143022-456") or date (e.g., "2025-10-07") 
   * @param entryText - Text of entry to remove (only needed if keyOrDate is a date)
   * @returns Promise resolving to true if removed, false if not found
   */
  async removeEntry(keyOrDate: string, entryText?: string): Promise<boolean> {
    const identityKey = await this.ensureIdentityKey();
    
    let entryToRemove: LogEntry | undefined;
    let entryKey: string;

    if (keyOrDate.includes('/') && !entryText) {
      // Format: "2025-10-07/143022-456" (unique key)
      const [datePart] = keyOrDate.split('/');
      const currentEntries = await this.listDay(datePart, { controller: identityKey });
      
      entryToRemove = currentEntries.find(entry => entry.key === keyOrDate);
      entryKey = `entry/${keyOrDate}`;
    } else if (entryText) {
      // Format: "2025-10-07" + "text to remove" (legacy)
      const currentEntries = await this.listDay(keyOrDate, { controller: identityKey });
      
      entryToRemove = currentEntries.find(entry => entry.text === entryText);
      entryKey = entryToRemove ? `entry/${entryToRemove.key}` : '';
    } else {
      return false; // Invalid parameters
    }

    if (!entryToRemove) {
      return false; // Entry not found or not owned by user
    }

    // Remove the individual UTXO
    await this.kv.remove(entryKey);
    return true;
  }

  /**
   * Remove an entire day's logs (all your logs for a specific date)
   * Only removes logs created by you (your controller)
   * 
   * @param date - Date in YYYY-MM-DD format
   * @returns Promise resolving to true if removed, false if no logs found
   */
  async removeDay(date: string): Promise<boolean> {
    const identityKey = await this.ensureIdentityKey();
    
    // Get all current entries for this user on this date
    const currentEntries = await this.listDay(date, { controller: identityKey });
    
    if (currentEntries.length === 0) {
      return false; // No entries for this date
    }

    // Remove each individual UTXO
    for (const entry of currentEntries) {
      const entryKey = `entry/${entry.key}`;
      await this.kv.remove(entryKey);
    }

    return true;
  }

  /**
   * Update a specific log entry by spending its UTXO and creating a new one
   * Only the controller (creator) can update their own logs
   * The old log becomes part of the spend chain history
   * 
   * @param date - Date in YYYY-MM-DD format
   * @param entryText - Text of the entry to update (for identification)
   * @param newText - New text for the log entry
   * @param options - Optional configuration for the updated entry
   * @returns Promise resolving to the updated log entry, or undefined if not found
   */
  async updateEntry(
    date: string, 
    entryText: string, 
    newText: string, 
    options: CreateLogOptions = {}
  ): Promise<LogEntry | undefined> {
    const identityKey = await this.ensureIdentityKey();
    
    // Get all current entries for this user on this date
    const currentEntries = await this.listDay(date, { controller: identityKey });
    
    if (currentEntries.length === 0) {
      return undefined; // No entries for this date
    }

    // Find the entry to update
    const entryToUpdate = currentEntries.find(entry => entry.text === entryText);
    if (!entryToUpdate) {
      return undefined; // Entry not found
    }

    // Create updated entry with same key (will spend the old UTXO)
    const updatedEntry: LogEntry = {
      key: entryToUpdate.key,
      at: new Date().toISOString(), // New timestamp for the update
      text: newText,
      tags: options.tags ?? entryToUpdate.tags ?? [],
      assets: options.assets ?? entryToUpdate.assets ?? []
    };

    // Store the updated entry (this spends the old UTXO)
    await this.putEntry(updatedEntry);
    
    return updatedEntry;
  }

  /**
   * Get the full history of a specific log entry
   * Returns the current version plus all historical versions from the spend chain
   * 
   * @param logKey - The full log key (e.g., "2025-10-07/143022-456")
   * @returns Promise resolving to array of log entries (current + history)
   */
  async getLogHistory(logKey: string): Promise<LogEntry[]> {
    const entryKey = `entry/${logKey}`;
    const result = await this.kv.get({ key: entryKey }, { history: true });

    const history: LogEntry[] = [];

    if (Array.isArray(result)) {
      // Multiple results - process the first one
      const firstResult = result[0];
      if (firstResult?.value) {
        try {
          const currentEntry = JSON.parse(firstResult.value) as LogEntry;
          if (firstResult.controller) {
            currentEntry.controller = firstResult.controller;
          }
          history.push(currentEntry);
        } catch (e) {
          console.warn(`Failed to parse current log entry: ${firstResult.key}`, e);
        }
      }

      // Add historical versions
      if (firstResult?.history && Array.isArray(firstResult.history)) {
        for (const historicalValue of firstResult.history) {
          try {
            const historicalEntry = JSON.parse(historicalValue) as LogEntry;
            if (firstResult.controller) {
              historicalEntry.controller = firstResult.controller;
            }
            history.push(historicalEntry);
          } catch (e) {
            console.warn(`Failed to parse historical log entry for ${firstResult.key}`, e);
          }
        }
      }
    } else if (result?.value) {
      // Single result
      try {
        const currentEntry = JSON.parse(result.value) as LogEntry;
        if (result.controller) {
          currentEntry.controller = result.controller;
        }
        history.push(currentEntry);
      } catch (e) {
        console.warn(`Failed to parse current log entry: ${result.key}`, e);
      }

      // Add historical versions
      if (result.history && Array.isArray(result.history)) {
        for (const historicalValue of result.history) {
          try {
            const historicalEntry = JSON.parse(historicalValue) as LogEntry;
            if (result.controller) {
              historicalEntry.controller = result.controller;
            }
            history.push(historicalEntry);
          } catch (e) {
            console.warn(`Failed to parse historical log entry for ${result.key}`, e);
          }
        }
      }
    }

    // Sort by timestamp (newest first)
    return history.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }

  /**
   * Upload an asset to UHRP storage and get the URL
   * 
   * @param data - The file data as Uint8Array
   * @param mimeType - MIME type of the file
   * @param options - Upload configuration
   * @returns Promise resolving to upload result with UHRP URL
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
      retentionPeriod: options.retentionMinutes ?? (60 * 24 * 30) // 30 days default
    } as any);

    return {
      uhrpURL: String(res.uhrpURL ?? res.url),
      published: Boolean(res.published ?? true)
    };
  }

  /**
   * Create a log entry with an uploaded asset
   * 
   * @param text - The log message
   * @param data - The file data as Uint8Array
   * @param mimeType - MIME type of the file
   * @param options - Optional configuration
   * @returns Promise resolving to the created log entry with asset URL
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
   * Generate a unique log key (internal method)
   */
  private async nextIdForDay(yyyyMmDd: string): Promise<string> {
    // Create unique timestamp-based key for individual UTXO
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
    
    // Format: YYYY-MM-DD/HHmmss-mmm
    return `${yyyyMmDd}/${hours}${minutes}${seconds}-${milliseconds}`;
  }

  /**
   * Store a log entry (internal method)
   * Each log entry creates its own transaction in the spend chain
   */
  private async putEntry(entry: LogEntry): Promise<void> {
    const dayKey = `entry/${entry.key}`;
    
    // Store just this log entry - it will spend the previous transaction automatically
    await this.kv.set(dayKey, JSON.stringify(entry));
  }
}

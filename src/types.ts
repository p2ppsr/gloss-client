import { WalletInterface } from '@bsv/sdk';

/**
 * Configuration options for GlossClient
 */
export interface GlossConfig {
  /** Wallet interface for BSV operations */
  wallet?: WalletInterface;
  /** BSV network to use */
  networkPreset?: 'mainnet' | 'testnet';
  /** Wallet mode (if using WalletClient) */
  walletMode?: 'auto' | 'local';
}

/**
 * A log entry in the global gloss system
 */
export interface LogEntry {
  /** Date key for the day (e.g., "2025-10-06") */
  key: string;
  /** ISO timestamp when the log was created */
  at: string;
  /** The log message text */
  text: string;
  /** Optional tags for categorization */
  tags?: string[];
  /** Optional UHRP URLs for attached assets */
  assets?: string[];
  /** Identity key of who created this log (for filtering) */
  controller?: string;
  /** Optional transaction ID of the record (only included if requested) */
  txid?: string;
}

/**
 * A day's worth of logs stored as a chain
 */
export interface DayChain {
  /** Date key (e.g., "2025-10-06") */
  key: string;
  /** All log entries for this day, chronologically ordered */
  logs: LogEntry[];
}

/**
 * Options for creating a log entry
 */
export interface CreateLogOptions {
  /** Optional tags for the log entry */
  tags?: string[];
  /** Optional asset URLs to attach */
  assets?: string[];
}

/**
 * Options for querying logs
 */
export interface QueryOptions {
  controller?: string;
  tags?: string[];
  tagQueryMode?: 'all' | 'any';
  // desired number of results returned to the caller, after filtering
  limit?: number;
  // initial offset into the global protocol stream
  skip?: number;
  // store-level sort request
  sortOrder?: 'asc' | 'desc';
  // how many rows to fetch per store scan page
  pageSize?: number;
  // hard cap on store pages to scan
  maxPages?: number;
  // include transaction IDs in the returned log entries
  includeTxid?: boolean;
}

/**
 * Result from uploading an asset
 */
export interface UploadResult {
  /** The UHRP URL of the uploaded asset */
  uhrpURL: string;
  /** Whether the upload was published successfully */
  published: boolean;
}

/**
 * Options for uploading assets
 */
export interface UploadOptions {
  /** UHRP storage URL */
  storageURL?: string;
  /** Retention period in minutes */
  retentionMinutes?: number;
}

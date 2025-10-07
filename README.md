# Gloss

A TypeScript library for creating globally discoverable developer logs using the BSV blockchain and GlobalKVStore protocol.

> **Protocol ID:** `[1, 'gloss logs']`

---

## Overview

Gloss writes small, append-only log entries as individual UTXOs using `GlobalKVStore`. Each entry uses a key of the form:

```
entry/{YYYY-MM-DD}/{HHmmss-SSSxxxx}
```

Because every log is its own UTXO, you get:

* **Granular ops:** independent add/update/remove per entry
* **Parallel writes:** no shared counter to lock
* **History:** updates spend the previous UTXO so history is preserved on-chain
* **Discovery:** anyone can enumerate all Gloss logs by querying the protocol ID

---

## Features

* **Global discovery:** query all logs via the Gloss protocol ID
* **Blockchain-backed:** immutable audit trail via UTXO spend chain
* **Tags:** filter by tags (any-match)
* **Assets:** upload files via UHRP and attach their URLs
* **Controller-aware:** only the creator (identity key) can update/remove
* **Flexible queries:** filter by date, controller, tags, pagination, and sort order

---

## Installation

```bash
npm install gloss-client
```

---

## Quick Start

```ts
import { GlossClient } from 'gloss-client';

const gloss = new GlossClient();

// Create a log
await gloss.log('Fixed authentication bug', { tags: ['auth', 'bugfix'] });

// List today's logs (all users)
const today = await gloss.listToday();
console.log(`Found ${today.length} logs today`);

// List logs for a date (YYYY-MM-DD)
const logs = await gloss.listDay('2025-10-06');

// Update one of your entries by key
await gloss.updateEntryByKey('2025-10-06/143022-456abcd', 'Fixed auth & authorization bugs');

// View spend-chain history of a specific entry key
const history = await gloss.getLogHistory('2025-10-06/143022-456abcd');

// Remove an entry you own
await gloss.removeEntry('2025-10-06/143022-456abcd');
```

---

## Configuration

```ts
import { GlossClient } from 'gloss-client';

const gloss = new GlossClient({
  networkPreset: 'mainnet',         // or 'testnet'
  walletMode: 'auto',               // passed to WalletClient if not provided
  wallet: undefined                 // optional: pass a preconfigured WalletClient
});
```

If you don't pass a wallet, Gloss constructs one as:

```ts
new WalletClient()
```

Gloss will derive your **identity key** on demand via:

```ts
wallet.getPublicKey({ identityKey: true }) // controller
```

---

## API Reference

### `class GlossClient`

#### `log(text: string, options?: CreateLogOptions): Promise<LogEntry>`

Create a new log entry for **today** using a UTC timestamp-based key.

```ts
await gloss.log('Deployed new API endpoint', { tags: ['deployment', 'api'] });
```

#### `get(date: string): Promise<LogEntry[]>`

Alias for `listDay(date)`. Returns **all entries for a date** (`YYYY-MM-DD`).

```ts
const entries = await gloss.get('2025-10-06');
```

#### `listDay(date: string, options?: QueryOptions): Promise<LogEntry[]>`

List entries for a given date across all users. Supports pagination and sorting via GlobalKVStore.

```ts
// All logs on a date
const logs = await gloss.listDay('2025-10-06');

// Filter by controller (identity public key)
const mine = await gloss.listDay('2025-10-06', { controller: '03abc123…' });

// Filter by any-of tags
const auth = await gloss.listDay('2025-10-06', { tags: ['auth', 'security'] });

// Pagination and sort
const page1 = await gloss.listDay('2025-10-06', { limit: 50, skip: 0, sortOrder: 'asc' });
```

#### `listToday(options?: QueryOptions): Promise<LogEntry[]>`

Convenience wrapper for `listDay(<today>)`.

```ts
const todayLogs = await gloss.listToday({ tags: ['frontend'] });
```

#### `updateEntryByKey(logKey: string, newText: string, options?: CreateLogOptions): Promise<LogEntry | undefined>`

Update **your** entry by its full key. The previous UTXO is spent; history is preserved. Returns the updated entry or `undefined` if not found.

```ts
await gloss.updateEntryByKey('2025-10-06/143022-456abcd', 'Finalized release notes', { tags: ['release'] });
```

#### `removeEntry(logKey: string): Promise<boolean>`

Remove **your** specific entry by full key.

```ts
await gloss.removeEntry('2025-10-07/143022-456abcd');
```

#### `removeDay(date: string): Promise<boolean>`

Remove **all of your** entries for a date. Returns `true` if any were removed.

#### `getLogHistory(logKey: string): Promise<LogEntry[]>`

Return the current version **plus** all historical versions for a specific entry key. Sorted newest first.

```ts
const history = await gloss.getLogHistory('2025-10-07/143022-456abcd');
```

#### `uploadAsset(data: Uint8Array, mimeType: string, options?: UploadOptions): Promise<UploadResult>`

Publish a file to UHRP storage (default `https://nanostore.babbage.systems`) and return its URL. Default retention: **30 days**.

```ts
const png = new Uint8Array(/* … */);
const { uhrpURL } = await gloss.uploadAsset(png, 'image/png');
```

#### `logWithAsset(text: string, data: Uint8Array, mimeType: string, options?: CreateLogOptions & UploadOptions): Promise<LogEntry>`

Upload an asset, then create a log that includes the returned UHRP URL.

```ts
await gloss.logWithAsset('Added UI mockup', png, 'image/png', { tags: ['ui', 'design'] });
```

---

## Types

```ts
export interface LogEntry {
  key: string;         // e.g., "2025-10-06/143022-456abcd"
  at: string;          // ISO timestamp (UTC)
  text: string;        // Log message
  tags?: string[];     // Optional tags
  assets?: string[];   // Optional UHRP URLs
  controller?: string; // Creator's identity public key
}

export interface CreateLogOptions {
  tags?: string[];
  assets?: string[];
}

export interface QueryOptions {
  controller?: string; // Identity key to filter by
  tags?: string[];     // Any-of match
  limit?: number;      // Max results per page
  skip?: number;       // Offset for pagination
  sortOrder?: 'asc' | 'desc'; // Sort order
}

export interface UploadOptions {
  storageURL?: string;       // Defaults to https://nanostore.babbage.systems
  retentionMinutes?: number; // Defaults to 30 days
}

export interface UploadResult {
  uhrpURL: string;
  published: boolean;
}
```

---

## Protocol Details

* **Protocol ID:** `[1, 'gloss logs']`
* **Key space:** `entry/{YYYY-MM-DD}/{HHmmss-SSSxxxx}` (UTC timestamp-based; no counters)
* **Storage:** each `set` writes a new UTXO; updates spend the previous one
* **Discovery:** `kv.get({ protocolID: [1, 'gloss logs'] })` enumerates all entries; clients filter by **date** client‑side (prefix lookups are not supported).
* **Pagination:** via `limit`, `skip`, and `sortOrder` in `GlobalKVStore.get`

---

## Behavior & Constraints

* **UTC-based keys:** all dates/times are UTC for consistency across time zones.
* **Ownership:** only the entry's controller (identity key) can update/remove it.
* **Tag filtering:** `tags` filter uses *any-of* semantics.
* **Sorting:** `listDay` respects `sortOrder`; defaults to ascending by key.
* **History:** `getLogHistory` returns current + historical JSON values (newest first).
* **Assets:** default UHRP retention is 30 days unless overridden.

---

## License

Open BSV License

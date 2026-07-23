# Gloss

Gloss is a TypeScript SDK for globally discoverable developer logs backed by
BSV spend-chain history and `GlobalKVStore`.

> Protocol ID: `[1, "gloss logs"]`

## Storage Model

Gloss deliberately uses one active KV token per controller and local calendar
day:

```text
entry/{YYYY-MM-DD}
```

Every `log()` call stores one logical entry as the next value in that day's
lineage. The new transaction spends the controller's previous day token:

```text
T1: Post A
 └─ T2 spends T1: Post B
     └─ T3 spends T2: Post C
```

`listDay()` requests the current value with `history: true` and reconstructs
the day's entries from that spend chain. This keeps the current overlay state
small while retaining an auditable Bitcoin history.

Each logical entry also has a unique entry key:

```text
{YYYY-MM-DD}/{HHmmss-SSSxxxx}
```

Applications must use this logical `key`—not `txid`—as the stable entry
identity.

### Transaction metadata

When `includeTxid` is requested, `txid` means the transaction containing that
exact returned value. The current GlobalKVStore history response provides token
metadata for the lineage tip but returns historical values without their
individual transaction metadata. Therefore:

- the current entry can include `txid`;
- historical entries omit `txid`;
- the current tip TXID is never copied onto historical entries.

This avoids falsely presenting multiple historical posts as the same
transaction. A future GlobalKVStore history API may expose per-step metadata,
at which point Gloss can populate exact historical TXIDs without changing the
meaning of the field.

## Installation

```bash
npm install gloss-client
```

## Quick Start

```ts
import { GlossClient } from "gloss-client";

const gloss = new GlossClient();

await gloss.log("Fixed authentication bug", {
  tags: ["auth", "bugfix"]
});

const today = await gloss.listToday({ includeTxid: true });

for (const entry of today) {
  console.log(entry.key, entry.text, entry.txid ?? "historical");
}
```

## Configuration

```ts
const gloss = new GlossClient({
  networkPreset: "mainnet", // or "testnet"
  walletMode: "auto",
  wallet: undefined         // optional WalletInterface
});
```

If no wallet is supplied, Gloss creates a `WalletClient`. The controller is
the wallet's identity key.

## API

### `log(text, options?)`

Append one entry to the current controller's local-day spend chain.

```ts
await gloss.log("Deployed the new frontend", {
  tags: ["deployment"]
});
```

### `listDay(date, options?)`

Reconstruct entries for a local calendar date across matching controllers.
Results are deduplicated by logical entry key.

```ts
const entries = await gloss.listDay("2026-07-23", {
  controller: "03abc...",
  tags: ["deployment"],
  tagQueryMode: "any",
  sortOrder: "desc",
  includeTxid: true
});
```

Filtering, sorting, `skip`, and `limit` are applied to the reconstructed
logical entries.

### `listToday(options?)`

Call `listDay()` using today's local `YYYY-MM-DD` date.

### `get(date)`

Alias for `listDay(date)`.

### `updateEntryByKey(logKey, newText, options?)`

Append a new revision with the same logical entry key at the tip of the
controller's day lineage. `listDay()` returns the newest revision for that key,
while `getLogHistory()` can reconstruct its revisions.

### `getLogHistory(logKey, options?)`

Return revisions of one logical entry, newest first. Exact TXID metadata is
included only when available for that value.

### `removeDay(date)`

Remove the current controller's active day token.

### `removeEntry(logKey)`

Deprecated. The day-level lineage does not support independently spending an
arbitrary historical entry; this method currently delegates to `removeDay()`.

### `uploadAsset(data, mimeType, options?)`

Publish an asset through UHRP storage. The default storage service is
`https://nanostore.babbage.systems` and the default retention is 30 days.

### `logWithAsset(text, data, mimeType, options?)`

Upload an asset and append a log entry containing its UHRP URL.

## Types

```ts
interface LogEntry {
  key: string;
  at: string;
  text: string;
  tags?: string[];
  assets?: string[];
  controller?: string;
  txid?: string; // exact transaction for this value, when available
}

interface QueryOptions {
  controller?: string;
  tags?: string[];
  tagQueryMode?: "all" | "any";
  limit?: number;
  skip?: number;
  sortOrder?: "asc" | "desc";
  includeTxid?: boolean;
}
```

## Time Semantics

Gloss uses the caller's local calendar date for the day-level KV key. The
entry's `at` timestamp remains an ISO UTC timestamp. This keeps an evening post
on the user's intended local day while retaining an unambiguous event time.

## Concurrency

Writes from one `GlobalKVStore` instance are serialized per day key. Because a
new post spends the previous day token, competing writes from the same
controller on different devices form a double-spend race and depend on
GlobalKVStore's retry and overlay-convergence behavior.

## License

Open BSV License

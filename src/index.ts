/**
 * gloss-logs - Global developer logging library
 * 
 * A TypeScript library for creating globally discoverable developer logs
 * using the BSV blockchain and GlobalKVStore protocol.
 * 
 * @example
 * ```typescript
 * import { GlossClient } from 'gloss-logs';
 * 
 * const gloss = new GlossClient();
 * 
 * // Log a message
 * await gloss.log('Fixed authentication bug', { tags: ['auth', 'bugfix'] });
 * 
 * // List today's logs from all developers
 * const logs = await gloss.listToday();
 * console.log(`Found ${logs.length} logs today`);
 * ```
 */

export { GlossClient } from './GlossClient.js';
export type { 
  GlossConfig, 
  LogEntry, 
  DayChain,
  CreateLogOptions, 
  QueryOptions, 
  UploadResult, 
  UploadOptions 
} from './types.js';

// Re-export the protocol ID constant for advanced use cases
export const GLOSS_PROTOCOL_ID: [1, 'gloss logs'] = [1, 'gloss logs'];

import assert from 'node:assert/strict';
import test from 'node:test';

import { GlossClient } from '../dist/index.js';

const controller = '02test-controller';
const tipTxid = 'a'.repeat(64);
const day = '2026-07-23';

const first = {
  key: `${day}/090000-001aaaa`,
  at: '2026-07-23T16:00:00.001Z',
  text: 'First post',
  tags: [],
  assets: [],
  controller
};

const second = {
  key: `${day}/100000-002bbbb`,
  at: '2026-07-23T17:00:00.002Z',
  text: 'Second post',
  tags: [],
  assets: [],
  controller
};

const revisedFirst = {
  ...first,
  at: '2026-07-23T17:30:00.004Z',
  text: 'First post, revised'
};

const current = {
  key: `${day}/110000-003cccc`,
  at: '2026-07-23T18:00:00.003Z',
  text: 'Current post',
  tags: [],
  assets: [],
  controller
};

function createClient() {
  const wallet = {
    getPublicKey: async () => ({ publicKey: controller })
  };
  const client = new GlossClient({ wallet });
  client.kv = {
    get: async () => [{
      controller,
      value: JSON.stringify(current),
      // Historian returns oldest-to-newest values and includes the tip value.
      history: [
        JSON.stringify(first),
        JSON.stringify(second),
        JSON.stringify(revisedFirst),
        JSON.stringify(current)
      ],
      token: { txid: tipTxid }
    }]
  };
  return client;
}

test('listDay keeps every spend-chain entry and labels only the current value with the tip txid', async () => {
  const entries = await createClient().listDay(day, { includeTxid: true });

  assert.deepEqual(entries.map(entry => entry.key), [
    first.key,
    second.key,
    current.key
  ]);
  assert.equal(entries[0].txid, undefined);
  assert.equal(entries[0].text, revisedFirst.text);
  assert.equal(entries[1].txid, undefined);
  assert.equal(entries[2].txid, tipTxid);
});

test('getLogHistory does not duplicate the current value returned in history', async () => {
  const entries = await createClient().getLogHistory(current.key, { includeTxid: true });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, current.key);
  assert.equal(entries[0].txid, tipTxid);
});

test('getLogHistory returns historical revisions without copying the lineage tip txid', async () => {
  const entries = await createClient().getLogHistory(first.key, { includeTxid: true });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].key, first.key);
  assert.equal(entries[0].text, revisedFirst.text);
  assert.equal(entries[0].txid, undefined);
  assert.equal(entries[1].text, first.text);
  assert.equal(entries[1].txid, undefined);
});

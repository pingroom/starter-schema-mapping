import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readJson } from './storage.js';
import { step } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/mapping.json', import.meta.url));
for (const [scenario, answers, expected] of [
  ['catalog columns mapped', ['live','caption','qty'], 'complete'],
  ['one source reused', ['live','caption','caption'], 'conflict'],
  ['one semantic meaning uncertain', ['live','Unknown','qty'], 'unknown'],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-mapping-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const answer of answers) {
      result = await step(options);
      api.answer(result.readings.find(item => item.status === 'pending').questionId, answer);
      result = await step(options);
    }
    assert.equal(result.status, expected);
    assert.equal(api.calls.filter(call => call.method === 'POST').length, input.targets.length);
    console.log(JSON.stringify({ scenario, status: result.status, duplicateSources: result.duplicateSources, unknownTargetIds: result.unknownTargetIds, mapped: result.mapped, sourceWrites: result.sourceWrites }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with a local mock transport. No phone delivery or source writes.');

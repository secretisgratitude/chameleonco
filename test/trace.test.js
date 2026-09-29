import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traced, todayTrace, traceCounts } from '../src/trace.js';

test('private metadata-only trace records success and generic failure by local day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-test-'));
  process.env.DATA_DIR = directory;
  const at = new Date(2026, 8, 28, 12).getTime();
  try {
    assert.equal(await traced(async () => 'private buyer reply', 'private prompt', {}, { chatId: 7, role: 'closer', reason: 'reply', threadId: 2, now: () => at }), 'private buyer reply');
    await assert.rejects(traced(async () => { throw new Error('secret 429'); }, 'private prompt', {}, { chatId: 7, role: 'critic', reason: 'review', now: () => at }));
    const path = join(directory, 'trace', '7-2026-09-28.jsonl');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, 'utf8'), /private prompt|private buyer reply|secret/);
    assert.deepEqual(await traceCounts(7, at), { closer: 1, critic: 1 });
    assert.equal((await todayTrace(7, at))[1].error, 'rate limited');
  } finally { delete process.env.DATA_DIR; await rm(directory, { recursive: true, force: true }); }
});

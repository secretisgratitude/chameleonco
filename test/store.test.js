import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, privateDir, readJSON, writeJSON, readThreads, writeThreads } from '../src/store.js';

test('dataDir refuses a directory inside the repository', async () => {
  process.env.DATA_DIR = new URL('../private-data', import.meta.url).pathname;
  try { assert.throws(() => dataDir(), /outside the repository/); }
  finally { delete process.env.DATA_DIR; }
});
test('readJSON returns the fallback when the file is missing, and round-trips otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chameleon-store-'));
  try {
    const path = join(dir, 'threads.json');
    assert.deepEqual(await readJSON(path, { threads: [] }), { threads: [] });
    await writeJSON(path, { threads: [{ id: 1 }] });
    assert.deepEqual(await readJSON(path, { threads: [] }), { threads: [{ id: 1 }] });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('stale thread writers merge edits and new threads instead of dropping updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chameleon-merge-'));
  try {
    const path = join(dir, 'threads.json');
    await writeJSON(path, { nextId: 2, threads: [{ id: 1, chatId: 1, status: 'ready', message: 'First' }] });
    const left = await readThreads(path, {}), right = await readThreads(path, {});
    left.threads[0].status = 'sent';
    right.threads[0].message = 'Revised';
    left.threads.push({ id: 2, chatId: 1, message: 'Left' });
    right.threads.push({ id: 2, chatId: 2, message: 'Right' });
    await writeThreads(path, left);
    await writeThreads(path, right);
    const saved = await readJSON(path, {});
    assert.equal(saved.threads[0].status, 'sent');
    assert.equal(saved.threads[0].message, 'Revised');
    assert.equal(saved.threads.length, 3);
    assert.equal(new Set(saved.threads.map(t => t.id)).size, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('privateDir creates the directory with mode 0700', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chameleon-store-'));
  try {
    const target = join(dir, 'nested');
    await privateDir(target);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

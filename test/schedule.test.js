import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextWake, planWake, dueWakes, claimWake } from '../src/schedule.js';

test('recent replies and replans wake in ten minutes; behind pace in three hours; otherwise next local 2 AM', () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  const goal = { target: 3, setAt: now - 86400000, by: '2026-09-29' };
  assert.equal(nextWake([{ status: 'replied', repliedAt: now }], goal, now), now + 600000);
  assert.equal(nextWake([{ status: 're-planned', replannedAt: now - 1000 }], goal, now), now + 600000);
  assert.equal(nextWake([], goal, now), now + 10800000);
  const next = new Date(now); next.setDate(next.getDate() + 1); next.setHours(2, 0, 0, 0);
  assert.equal(nextWake([], null, now), next.getTime());
});
test('persisted due wakes are claimed once per chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-test-'));
  process.env.DATA_DIR = dir;
  const now = new Date(2026, 8, 28, 12).getTime();
  try {
    assert.deepEqual(await dueWakes([1, 2], now), [1, 2]);
    assert.equal(await claimWake(1, now), true);
    assert.equal(await claimWake(1, now), false);
    await planWake(2, [{ status: 'replied', repliedAt: now }], null, now);
    assert.deepEqual(await dueWakes([1, 2], now), []);
    assert.deepEqual(await dueWakes([1, 2], now + 600001), [1, 2]);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

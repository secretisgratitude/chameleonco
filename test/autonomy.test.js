import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGoal, parseGoal, goalPace, ensureGoal, getGoal, setGoal } from '../src/autonomy.js';

const now = Date.UTC(2026, 8, 28, 12);

test('default goal and pace count distinct replied buyers since the goal was set', () => {
  const goal = defaultGoal(now);
  assert.deepEqual(goal, { target: 3, metric: 'replies', by: '2026-10-05', setAt: now });
  const threads = [{ replies: [{ at: now + 1 }, { at: now + 2 }] }, { replies: [{ at: now - 1 }] }];
  assert.deepEqual(goalPace(goal, threads, now + 4 * 86400000), { done: 1, needed: 2, behind: 1, status: 'behind by 1' });
  assert.equal(goalPace(goal, [...threads, { replies: [{ at: now + 2 }] }], now + 4 * 86400000).status, 'on pace');
});

test('goal command accepts a valid date and rejects bad targets and dates', () => {
  assert.deepEqual(parseGoal('4 replies by 2026-10-04', now), { target: 4, metric: 'replies', by: '2026-10-04', setAt: now });
  for (const input of ['0 replies by 2026-10-04', '-1 replies by 2026-10-04', '1 reply by 2026-10-04', '1 replies by 2026-02-30', '1 replies by 2020-01-01', '1 replies by 2026-13-01', '999999999999999999999 replies by 2026-10-04']) assert.throws(() => parseGoal(input, now), /Usage/);
});

test('goals are private, independent by chat, and default creation never overwrites edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autonomy-'));
  process.env.DATA_DIR = dir;
  try {
    await Promise.all([ensureGoal(1, now), ensureGoal(2, now)]);
    await Promise.all([setGoal(1, parseGoal('5 replies by 2026-10-04', now)), ensureGoal(2, now + 86400000)]);
    assert.equal((await getGoal(1)).target, 5);
    assert.equal((await getGoal(2)).target, 3);
    assert.equal((await ensureGoal(1, now)).target, 5);
    assert.equal((await stat(join(dir, 'goals.json'))).mode & 0o777, 0o600);
    assert.equal(Object.keys(JSON.parse(await readFile(join(dir, 'goals.json'), 'utf8'))).length, 2);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

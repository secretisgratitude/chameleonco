import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outcome, updateLessons, chatLessons, sampleAngle, correlation } from '../src/lessons.js';

const DAY = 86400000;
test('seeded Thompson sampling prefers the stronger posterior and excludes unsent angles', () => {
  const threads = [
    ...Array.from({ length: 5 }, (_, i) => ({ angle: 'good', sentAt: 1, replies: [{ at: i + 2 }] })),
    ...Array.from({ length: 5 }, () => ({ angle: 'bad', sentAt: 1, replies: [] })),
    { angle: 'draft-only' }
  ];
  assert.equal(sampleAngle(threads, () => 0.5), 'good');
  assert.equal(sampleAngle([], () => 0.5), null);
});
test('calibration uses resolved outcomes and preserves the evaluation made at send time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'calibration-'));
  process.env.DATA_DIR = dir;
  const now = 20 * DAY;
  try {
    const sent = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, chatId: 1, angle: 'test', sentAt: now - 8 * DAY, sentEvaluation: { score: 90 - i, criteria: { buyerFact: 10 + i } }, evaluation: { score: 0 }, replies: i < 5 ? [] : [{ at: now - DAY }] }));
    assert.equal(correlation(sent.slice(0, 9).map(t => [t.sentEvaluation.score, Number(t.replies.length > 0)])), null);
    const result = await updateLessons(1, sent, now);
    assert.equal(result.calibration.n, 10);
    assert.ok(result.calibration.correlation < -0.8);
    assert.ok(result.calibration.criteria.buyerFact > 0.8);
    assert.equal(result.calibration.at, now);
    assert.equal(result.active[0].status, 'early signal');
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});
test('outcomes wait seven days and count replies even on re-planned threads', () => {
  assert.equal(outcome({ sentAt: 0, replies: [] }, 7 * DAY - 1), 'pending');
  assert.equal(outcome({ sentAt: 0, replies: [] }, 7 * DAY), 'no reply');
  assert.equal(outcome({ sentAt: 0, status: 're-planned', replies: [{ at: DAY }] }, 8 * DAY), 'replied');
});
test('lessons are per chat, private, weighted, capped, and retired with change history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'));
  process.env.DATA_DIR = dir;
  const now = 40 * DAY;
  const threads = Array.from({ length: 12 }, (_, angle) => Array.from({ length: 5 }, (_, i) => ({ id: angle * 5 + i + 1, chatId: 1, angle: `angle-${angle}`, sentAt: now - (angle === 0 ? 29 : 8) * DAY, replies: angle === 1 && i < 3 ? [{ at: now - DAY }] : [] }))).flat();
  threads.push({ id: 999, chatId: 2, angle: 'private', sentAt: now - DAY, replies: [{ at: now }] });
  try {
    const result = await updateLessons(1, threads, now);
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].angle, 'angle-1');
    assert.equal(result.active[0].status, 'early signal');
    assert.equal(result.retired.find(l => l.angle === 'angle-0').reason, 'evidence older than 28 days');
    assert.equal(result.retired.find(l => l.angle === 'angle-2').reason, 'reply rate below half the chat overall rate');
    assert.equal(result.history.length, 12);
    assert.deepEqual(await chatLessons(2), { active: [], retired: [], history: [], calibration: null });
    assert.equal((await stat(join(dir, 'lessons.json'))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(dir, 'lessons.json'), 'utf8'), /private/);
    const unchanged = await updateLessons(1, threads, now);
    assert.equal(unchanged.history.length, 12);
    assert.equal(unchanged.retired.length, 11);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

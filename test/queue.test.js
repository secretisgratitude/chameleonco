import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/queue.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
test('fair scheduling, dependency order, founder limit, and failure isolation', async () => {
  let time = new Date(2026, 8, 28).getTime();
  const q = new JobQueue({ now: () => time, max: 9, perFounder: 2 });
  q.concurrency = 6;
  const seen = [], releases = [];
  const jobs = [];
  for (let round = 0; round < 6; round++) for (let chatId = 1; chatId <= 3; chatId++) jobs.push(q.enqueue({ chatId, priority: 'behind', run: () => new Promise(resolve => { seen.push(chatId); releases.push(resolve); }) }));
  await flush();
  assert.deepEqual(seen.slice(0, 6).sort(), [1, 1, 2, 2, 3, 3]);
  assert.equal(Math.max(...[1, 2, 3].map(id => q.active.get(id))), 2);
  while (jobs.some(job => job.status !== 'done')) { releases.splice(0).forEach(resolve => resolve()); await flush(); }
  await Promise.all(jobs.map(j => j.done));
  const order = [];
  const first = q.enqueue({ chatId: 1, run: () => { order.push('research'); throw new Error('oops'); } });
  const second = q.enqueue({ chatId: 1, dependsOn: first, run: () => { order.push('copy'); } });
  await assert.rejects(first.done);
  await second.done;
  assert.deepEqual(order, ['research', 'copy']);
});
test('AIMD grows under load, halves on 429, obeys ceiling and isolates daily budget', async () => {
  let time = new Date(2026, 8, 28).getTime();
  const q = new JobQueue({ now: () => time, max: 3, budget: 2 });
  const blocked = [];
  const jobs = [1, 1, 1, 2, 2, 2].map(chatId => q.enqueue({ chatId, run: () => new Promise(resolve => blocked.push(resolve)) }));
  await flush();
  time += 30000; q.tick();
  blocked.splice(0).forEach(resolve => resolve()); await flush();
  time += 30000; q.tick();
  assert.ok(q.concurrency <= 3);
  blocked.splice(0).forEach(resolve => resolve()); await flush();
  assert.equal(q.stats(1).budgetUsed, 2);
  assert.equal(q.stats(2).budgetUsed, 2);
  assert.equal(q.stats(1).waiting, 1);
  const reply = q.enqueue({ chatId: 1, priority: 'reply', run: () => 'reply' });
  blocked.splice(0).forEach(resolve => resolve()); await flush();
  assert.equal(await reply.done, 'reply');
  const fail = q.enqueue({ chatId: 3, run: () => { throw new Error('429'); } });
  await assert.rejects(fail.done);
  await flush(); time += 30000; q.tick();
  assert.equal(q.concurrency, 1);
  await assert.rejects(q.enqueue({ chatId: 1, run: () => 'blocked' }).done, /budget reached/);
  time += 86400000; q.tick();
  assert.equal(q.stats(1).budgetUsed <= 1, true);
  while (jobs.some(job => job.status === 'running' || job.status === 'waiting')) { blocked.splice(0).forEach(resolve => resolve()); await flush(); }
  await Promise.allSettled(jobs.map(j => j.done));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladder } from '../src/ladder.js';

const states = threads => ladder(threads).map(r => r.state);
test('empty threads leave G0 current', () => {
  assert.deepEqual(states([]), ['current', 'ahead', 'ahead', 'ahead', 'ahead', 'ahead']);
});
test('named buyer, reply and won thread move the first three gates', () => {
  const t = { to: 'Alex', createdAt: 1704067200000, replies: [{ text: 'We need this', at: 1704153600000 }], status: 'won', wonAt: 1704240000000 };
  assert.deepEqual(states([{ to: 'Alex', createdAt: t.createdAt }]), ['met', 'current', 'ahead', 'ahead', 'ahead', 'ahead']);
  assert.deepEqual(states([{ ...t, status: 'replied' }]), ['met', 'met', 'current', 'ahead', 'ahead', 'ahead']);
  assert.deepEqual(states([t]), ['met', 'met', 'met', 'current', 'ahead', 'ahead']);
  assert.equal(ladder([t])[1].evidence.text, 'a buyer replied');
  assert.equal(ladder([t])[2].evidence.date, '2024-01-03');
});
test('optional price and payment and a second win require their own evidence', () => {
  const won = { to: 'Alex', status: 'won', wonAt: 1704240000000 };
  const rungs = ladder([{ ...won, price: '$10', paid: true }, { to: 'Jo', status: 'won', wonAt: 1704326400000 }]);
  assert.deepEqual(rungs.slice(2).map(r => r.state), ['met', 'met', 'met', 'met']);
  assert.ok(rungs.filter(r => r.state === 'met').every(r => r.evidence?.text));
  assert.equal(ladder([{ to: 'Alex', replies: [{ text: ' ' }], paid: false }])[1].state, 'current');
});

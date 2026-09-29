import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoals, validateGoals, goals } from '../src/goals.js';
import { fundamentalIds } from '../src/fundamentals.js';

const today = '2026-09-28';
function card() {
  const checks = fundamentalIds.map(id => ({ id, pass: id !== 'F1' && id !== 'F2', evidence: 'e', fix: id === 'F1' || id === 'F2' ? 'fix it' : '' }));
  return { checks, fix_first: { id: 'F1', why: 'because' } };
}
function goodGoals() {
  return {
    headline: { goal: 'Get a paying pilot', measure: 'signed pilots', target: 1, by: '2026-10-30' },
    goals: [
      { fixes: 'F1', specific: 'Name the buyer', measure: 'named buyers', target: 1, by: '2026-10-05', relevant: 'unlocks F2' },
      { fixes: 'F2', specific: 'Collect quotes', measure: 'quotes', target: 3, by: '2026-10-12', relevant: 'grounds the offer' }
    ],
    daily: 'Send three messages.',
    review: '2026-10-05'
  };
}

test('parseGoals extracts JSON from surrounding text', () => {
  assert.deepEqual(parseGoals('prose {"a":1} more'), { a: 1 });
});
test('parseGoals rejects text with no JSON', () => assert.throws(() => parseGoals('nope')));

test('validateGoals accepts a well formed goal set', () => {
  assert.equal(validateGoals(goodGoals(), card(), today).goals.length, 2);
});
test('validateGoals rejects a target of 0', () => {
  const bad = goodGoals();
  bad.goals[0].target = 0;
  assert.throws(() => validateGoals(bad, card(), today));
});
test('validateGoals rejects a past date', () => {
  const bad = goodGoals();
  bad.goals[0].by = '2020-01-01';
  assert.throws(() => validateGoals(bad, card(), today));
});
test('validateGoals rejects a malformed date', () => {
  const bad = goodGoals();
  bad.goals[0].by = '10/05/2026';
  assert.throws(() => validateGoals(bad, card(), today));
});
test('validateGoals rejects a goal that fixes a passing fundamental', () => {
  const bad = goodGoals();
  bad.goals[0].fixes = 'F3';
  assert.throws(() => validateGoals(bad, card(), today));
});
test('validateGoals rejects when the first goal does not fix fix_first', () => {
  const bad = goodGoals();
  [bad.goals[0], bad.goals[1]] = [bad.goals[1], bad.goals[0]];
  assert.throws(() => validateGoals(bad, card(), today));
});
test('validateGoals rejects a headline with no target above 0', () => {
  const bad = goodGoals();
  bad.headline.target = 0;
  assert.throws(() => validateGoals(bad, card(), today));
});

test('goals() retries once on an invalid first answer and succeeds on the second', async () => {
  let calls = 0;
  const ask = async () => { calls++; return calls === 1 ? JSON.stringify({ headline: {} }) : JSON.stringify(goodGoals()); };
  const result = await goals(card(), { today, ask });
  assert.equal(calls, 2);
  assert.equal(result.goals[0].fixes, 'F1');
});
test('goals() throws a clear error when both attempts fail', async () => {
  const ask = async () => JSON.stringify({ headline: {} });
  await assert.rejects(goals(card(), { today, ask }), /retry/);
});
test('goals() with the fake engine returns a validated goal set for a fake scorecard', async () => {
  process.env.ENGINE = 'fake';
  const { fundamentals } = await import('../src/fundamentals.js');
  const fakeCard = await fundamentals('=== THE BUSINESS ===\nA fake business.');
  const result = await goals(fakeCard, { today: '2026-09-28' });
  assert.equal(result.goals[0].fixes, fakeCard.fix_first.id);
});

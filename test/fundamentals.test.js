import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFundamentals, validateFundamentals, fundamentals, fundamentalIds } from '../src/fundamentals.js';

function card(overrides = {}) {
  const checks = fundamentalIds.map(id => ({ id, pass: id !== 'F1', evidence: id === 'F1' ? 'no evidence' : 'a quote', fix: id === 'F1' ? 'Name one buyer role.' : '' }));
  return { company: 'Acme', checks, fix_first: { id: 'F1', why: 'It unlocks the rest.' }, too_much: '', ...overrides };
}

test('parseFundamentals extracts JSON from surrounding text', () => {
  assert.deepEqual(parseFundamentals('prose\n{"a":1}\nmore'), { a: 1 });
});
test('parseFundamentals rejects text with no JSON', () => assert.throws(() => parseFundamentals('nope')));
test('parseFundamentals rejects malformed JSON', () => assert.throws(() => parseFundamentals('{a:1}')));

test('validateFundamentals accepts a full, well formed scorecard', () => {
  assert.equal(validateFundamentals(card()).checks.length, 10);
});
test('validateFundamentals rejects a missing fundamental', () => {
  const bad = card();
  bad.checks = bad.checks.filter(check => check.id !== 'F10');
  assert.throws(() => validateFundamentals(bad));
});
test('validateFundamentals rejects a non-boolean pass', () => {
  const bad = card();
  bad.checks[0].pass = 'yes';
  assert.throws(() => validateFundamentals(bad));
});
test('validateFundamentals rejects a missing evidence', () => {
  const bad = card();
  bad.checks[0].evidence = '';
  assert.throws(() => validateFundamentals(bad));
});
test('validateFundamentals rejects a failed check with no fix', () => {
  const bad = card();
  bad.checks[0].fix = '';
  assert.throws(() => validateFundamentals(bad));
});
test('validateFundamentals rejects fix_first naming a passing check', () => {
  const bad = card();
  bad.fix_first = { id: 'F2', why: 'because' };
  assert.throws(() => validateFundamentals(bad));
});
test('validateFundamentals rejects fix_first with no reason', () => {
  const bad = card();
  bad.fix_first = { id: 'F1', why: '' };
  assert.throws(() => validateFundamentals(bad));
});

test('fundamentals() with the fake engine returns a validated scorecard', async () => {
  process.env.ENGINE = 'fake';
  const result = await fundamentals('=== THE BUSINESS ===\nA fake business.');
  assert.equal(result.checks.length, 10);
  assert.equal(result.fix_first.id, 'F1');
  assert.ok(result.checks.every(check => check.pass || check.fix));
});

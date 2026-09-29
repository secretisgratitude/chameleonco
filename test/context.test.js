import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, updateContext, founderContext, blockedContact, contextPrompt } from '../src/context.js';

test('private founder card extracts plan sections and updates preferences, decisions and blocked recipients', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-test-'));
  process.env.DATA_DIR = dir;
  try {
    const card = await createContext(5, '## Business model\nWe sell tools.\n\n## The offer, aligned\nA pilot.\n\n## Where you are (gate)\nOperations leads.\n', 100);
    assert.equal(card.business, 'We sell tools.');
    assert.equal(card.offer, 'A pilot.');
    assert.equal(card.buyer, 'Operations leads.');
    assert.equal((await stat(join(dir, 'context', '5.json'))).mode & 0o777, 0o600);
    await updateContext(5, 'preferences', 'Be brief', 200);
    await updateContext(5, 'decisions', 'Thread #3: won', 300);
    await updateContext(5, 'doNotContact', 'Jane Doe', 400);
    await updateContext(5, 'doNotContact', 'buyer@example.org', 500);
    const saved = await founderContext(5);
    assert.deepEqual(saved.preferences, ['Be brief']);
    assert.deepEqual(saved.decisions, ['Thread #3: won']);
    assert.equal(saved.updatedAt, 500);
    assert.match(contextPrompt(saved), /Founder facts \(trusted/);
    assert.equal(blockedContact(saved, { to: 'jane doe' }), true);
    assert.equal(blockedContact(saved, { to: 'Elsewhere', email: 'BUYER@example.org' }), true);
    assert.equal(blockedContact(saved, { to: 'Another buyer' }), false);
    assert.deepEqual((await createContext(5, '## Business model\nNew business.\n', 600)).doNotContact, ['Jane Doe', 'buyer@example.org']);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

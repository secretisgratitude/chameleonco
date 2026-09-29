import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/ladder.js', import.meta.url), 'utf8');
function node(tag) {
  return { tag, children: [], textContent: '', className: '', append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } };
}
test('met rows need evidence, and the first yes line only renders when claimed', () => {
  const section = node('section');
  const context = { document: { getElementById: () => section, createElement: node } };
  runInNewContext(script + ';globalThis.draw = renderLadder;', context);
  const rungs = [
    { id: 'G0', label: 'buyer', state: 'met' },
    { id: 'G1', label: 'problem', state: 'met', evidence: { text: 'Buyer: Alex', date: '2024-01-01' } },
    { id: 'G2', label: 'yes', state: 'met', evidence: { text: 'Alex: marked won', date: '2024-01-03' } },
    { id: 'G3', label: 'price', state: 'current' }
  ];
  context.draw(rungs, true, 'Ask Alex about price.');
  assert.equal(section.children[1].textContent, "Someone said yes, in writing. That's customer one.");
  const rows = section.children[2].children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children[0].children[1].textContent, 'Buyer: Alex');
  assert.match(rows[0].children[0].children[0].textContent, /2024-01-01/);
  assert.equal(rows[2].children[2].textContent, 'Today: Ask Alex about price.');
  context.draw(rungs, false);
  assert.equal(section.children.length, 2);
  context.draw([{ id: 'G2', label: 'yes', state: 'met' }], true);
  assert.equal(section.children.length, 2);
  assert.equal(section.children[1].children.length, 0);
});

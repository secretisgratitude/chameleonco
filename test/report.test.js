import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReport } from '../src/server.js';

const plan = '## Where you are (gate)\n**At G1.**\n\n## The offer, aligned\n**Run it free for 14 days.**\n\n```drafts\n[{"to":"Jane","org":"Acme","channel":"email","why":"Asked","message":"Hi Jane","source":"https://acme.test","expert":"closer"}]\n```';

test('reports load by id from saved reports and from older run files, never by a bad id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'report-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const saved = '11111111-2222-3333-4444-555555555555', old = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await mkdir(join(dir, 'reports'), { recursive: true });
    await writeFile(join(dir, 'reports', `${saved}.json`), JSON.stringify({ input: 'https://acme.test', createdAt: '2026-09-28T16:00:00.000Z', result: plan }));
    const a = await loadReport(saved);
    assert.equal(a.input, 'https://acme.test');
    assert.deepEqual(a.sections.map(s => s.title), ['Where you are (gate)', 'The offer, aligned']);
    assert.equal(a.drafts[0].to, 'Jane');
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(join(dir, 'runs', `2026-09-28T15-41-17-031Z-${old}.md`), `Input:\nhttps://old.test\n\nResult:\n${plan}`);
    const b = await loadReport(old);
    assert.equal(b.input, 'https://old.test');
    assert.equal(b.createdAt, '2026-09-28T15:41:17.031Z');
    assert.equal(b.drafts.length, 1);
    assert.equal(await loadReport('ffffffff-ffff-ffff-ffff-ffffffffffff'), null);
    assert.equal(await loadReport('../reports/x'), null);
    assert.equal(await loadReport(`${saved}.json`), null);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  }
});

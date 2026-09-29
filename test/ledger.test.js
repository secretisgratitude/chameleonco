import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { parseHistory, parseFindings, linkFindings, updateAutonomy, recordAutonomyOutcome, loadLedger } from '../src/ledger.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
test('groups git history by Cofounder trailer and defaults untagged history to human', () => {
  const commits = parseHistory('abc\x1fdef\x1ffeat: work\x1fDetails\n\nCofounder: adal\n\x1edef\x1f\x1fdocs: note\x1f\x1e');
  assert.equal(commits[0].cofounder, 'adal');
  assert.equal(commits[1].cofounder, 'human');
  assert.deepEqual(commits[0].parents, ['def']);
});
test('links a finding to its unique fix commit; leaves unmatched findings open', () => {
  const findings = parseFindings('review.md', '**DNS rebinding bypasses fetchWebsite IP checks**\n\nDetails\n\n<!-- tenki:finding fp=abc sev=high -->\n\n**Unresolved example without a fix**\n\n<!-- tenki:finding fp=def sev=low -->');
  const commits = [{ hash: '123', subject: 'fix(security): pin fetchWebsite to validated addresses to stop DNS rebinding', body: 'Fix the DNS rebinding IP checks.', cofounder: 'adal' }];
  const linked = linkFindings(findings, commits);
  assert.equal(linked[0].fix.hash, '123');
  assert.equal(linked[1].fix, null);
});
test('autonomy earns approval on three consecutive outcomes and loses it on correction', () => {
  let state = {};
  for (let n = 0; n < 2; n++) state = updateAutonomy(state, 'adal', 'success');
  assert.equal(state.adal.level, 'asks first');
  state = updateAutonomy(state, 'adal', 'success');
  assert.equal(state.adal.level, 'acts, reports after');
  state = updateAutonomy(state, 'adal', 'correction');
  assert.deepEqual(state.adal, { streak: 0, level: 'asks first' });
});
test('loads real review findings, missing threads, and private autonomy storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    const ledger = await loadLedger({ repository, directory });
    assert.equal(ledger.customers, null);
    assert.equal(ledger.findings.length, 17);
    assert.ok(ledger.groups.adal.length > 0);
    assert.ok(ledger.findings.some(f => f.title.includes('DNS rebinding') && f.fix));
    assert.equal(ledger.findings.find(f => f.title.startsWith('Spawn-error')).fix?.subject, 'fix(engine): spawn-error path returns the generic message');
    assert.ok(ledger.findings.find(f => f.title.startsWith('Privacy regex')).fix);
    assert.ok(ledger.findings.find(f => f.title.startsWith('Narrow env')).fix);
    assert.equal((await stat(join(directory, 'autonomy.json'))).mode & 0o777, 0o600);
    await writeFile(join(directory, 'threads.json'), JSON.stringify([{ id: 1, gate: 'G2', expert: 'sales', status: 'replied', message: 'private buyer reply' }]));
    const customers = (await loadLedger({ repository, directory })).customers;
    assert.equal(customers.total, 1);
    assert.equal(customers.replied, 1);
    assert.deepEqual((await loadLedger({ repository, directory })).customerThreads, [{ id: 1, expert: 'sales', gate: 'G1', outcome: 'replied' }]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'autonomy.json'), 'utf8')), {});
    for (let n = 0; n < 3; n++) await recordAutonomyOutcome(directory, 'adal', 'success');
    assert.equal((await loadLedger({ repository, directory })).autonomy.adal.level, 'acts, reports after');
    await recordAutonomyOutcome(directory, 'adal', 'correction');
    assert.equal((await loadLedger({ repository, directory })).autonomy.adal.level, 'asks first');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('GET /ledger and /api/ledger serve branded page and live records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-api-'));
  const prior = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const server = createApp();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await (await fetch(base + '/ledger')).text();
    assert.match(page, /01co Chameleon/);
    assert.match(page, /#EEF3EC/);
    assert.match(page, /id="build-title"/);
    assert.match(page, /id="customer-title"/);
    assert.match(page, /id="ladder"/);
    assert.match(page, /for\(const thread of data\.customerThreads\|\|\[\]\)/);
    assert.match(page, /'Expert: '\+thread\.expert/);
    assert.match(page, /'Gate: '\+thread\.gate/);
    assert.match(page, /'Outcome: '\+thread\.outcome/);
    assert.match(page, /src="\/ladder.js"/);
    assert.ok(page.indexOf('for(const [index,group] of (data.customerLessons||[]).entries())') < page.indexOf('if(data.customers===null)'));
    assert.match(page, /'Retired '\+lesson.angle\+': '\+lesson.replies\+'\/'\+lesson.sends/);
    const response = await fetch(base + '/api/ledger');
    assert.equal(response.status, 200);
    const ledger = await response.json();
    assert.equal(ledger.customers, null);
    assert.deepEqual(ledger.customerLessons, []);
    assert.ok(ledger.merges.every(merge => Number.isInteger(merge.tests)));
    await writeFile(join(directory, 'threads.json'), JSON.stringify([{ to: 'Alex', createdAt: 1704067200000 }]));
    const ladderResponse = await fetch(base + '/api/ladder');
    assert.equal(ladderResponse.status, 200);
    assert.equal((await ladderResponse.json()).rungs[0].state, 'met');
    assert.equal((await (await fetch(base + '/api/ledger')).json()).customers.total, 1);
    await writeFile(join(directory, 'threads.json'), JSON.stringify([{ to: 'Alex Secretbuyer', status: 'replied', replies: [{ text: 'Confidential reply text', at: 1704153600000 }] }]));
    for (const endpoint of ['/api/ladder', '/api/ledger']) {
      const responseText = await (await fetch(base + endpoint)).text();
      assert.doesNotMatch(responseText, /Alex Secretbuyer|Confidential reply text/);
      assert.match(responseText, endpoint === '/api/ladder' ? /a buyer replied/ : /"replied":1/);
    }
    await writeFile(join(directory, 'threads.json'), JSON.stringify({ threads: [
      { id: 1, to: 'Secret One', expert: 'closer', status: 'won', replies: [{ text: 'Private yes' }] },
      { id: 2, to: 'Secret Two', expert: 'researcher', status: 'lost', price: 100, replies: [{ text: 'Private no' }] },
      { id: 3, to: 'Secret Three', status: 'sent', sentAt: 1704067200000 }
    ] }));
    await writeFile(join(directory, 'lessons.json'), JSON.stringify({ 1: { active: [{ angle: 'site-fact', sends: 5, replies: 2, rate: 0.4, status: 'early signal', text: 'Secret One', evidenceThreadIds: [1] }], retired: [{ angle: 'question', sends: 5, replies: 0, rate: 0, reason: 'evidence older than 28 days' }], calibration: { n: 10, correlation: -0.1, at: 100 } } }));
    const responseText = await (await fetch(base + '/api/ledger')).text();
    assert.equal(JSON.parse(responseText).customerLessons[0].active[0].angle, 'site-fact');
    assert.equal(JSON.parse(responseText).customerLessons[0].retired[0].reason, 'evidence older than 28 days');
    assert.doesNotMatch(responseText, /evidenceThreadIds/);
    assert.doesNotMatch(responseText, /Secret One|Secret Two|Secret Three|Private yes|Private no/);
    assert.deepEqual(JSON.parse(responseText).customerThreads, [
      { id: 1, expert: 'closer', gate: 'G2', outcome: 'won' },
      { id: 2, expert: 'researcher', gate: 'G3', outcome: 'lost' },
      { id: 3, expert: 'not recorded', gate: 'G0', outcome: 'sent' }
    ]);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (prior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prior;
    await rm(directory, { recursive: true, force: true });
  }
});

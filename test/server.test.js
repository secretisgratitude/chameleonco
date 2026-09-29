import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

async function withServer(run, fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chameleon-test-'));
  process.env.DATA_DIR = dir;
  const server = createApp({ run, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try { await fn({ base, post, dir }); }
  finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); delete process.env.DATA_DIR; }
}
test('health API returns engine and last web check result', async () => {
  await withServer(async () => '', async ({ base }) => {
    const response = await fetch(base + '/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { engine: 'claude', webOk: false });
  }, { health: () => ({ engine: 'claude', webOk: false }) });
});
test('ladder API reads private threads and claims the G2 line only once', async () => {
  await withServer(async () => '', async ({ base, dir }) => {
    const get = async () => (await fetch(base + '/api/ladder')).json();
    const empty = await get();
    assert.equal(empty.rungs[0].state, 'current');
    assert.equal(empty.showLine, false);
    assert.equal((await fetch(base + '/ledger')).status, 200);
    assert.equal((await fetch(base + '/ladder.js')).status, 200);
    await writeFile(join(dir, 'threads.json'), JSON.stringify({ threads: [{ to: 'Alex', createdAt: 1704067200000, replies: [{ text: 'Yes, we need this', at: 1704153600000 }], status: 'won', wonAt: 1704240000000 }] }), { mode: 0o600 });
    const [first, second] = await Promise.all([get(), get()]);
    assert.deepEqual([first.showLine, second.showLine].sort(), [false, true]);
    assert.equal(first.rungs[2].state, 'met');
    assert.equal(first.rungs[1].evidence.text, 'a buyer replied');
    assert.equal((await get()).showLine, false);
    assert.equal((await stat(join(dir, 'firsts.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(dir, 'firsts.json'), 'utf8')).shown_web, true);
  });
});
test('ladder preserves other firsts keys written by the bot', async () => {
  await withServer(async () => '', async ({ base, dir }) => {
    await writeFile(join(dir, 'firsts.json'), JSON.stringify({ shown_bot: true }), { mode: 0o600 });
    await writeFile(join(dir, 'threads.json'), JSON.stringify({ threads: [{ status: 'won', wonAt: 1704240000000 }] }), { mode: 0o600 });
    assert.equal((await (await fetch(base + '/api/ladder')).json()).showLine, true);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'firsts.json'), 'utf8')), { shown_bot: true, shown_web: true });
  });
});
test('intake to completion, opt-in and private storage', async () => {
  process.env.ENGINE = 'fake';
  const { intake } = await import('../src/intake.js');
  await withServer(intake, async ({ base, post, dir }) => {
    const response = await post('/api/intake', { input: 'We make tools for small teams to find customers.' });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    let plan;
    for (let n = 0; n < 100; n++) {
      plan = await (await fetch(`${base}/api/intake/${id}`)).json();
      if (plan.status !== 'working') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(plan.status, 'done');
    assert.equal(plan.sections.length, 10);
    assert.equal(plan.drafts.length, 3);
    assert.equal(plan.fundamentals.checks.length, 10);
    assert.equal(plan.goals.goals[0].fixes, plan.fundamentals.fix_first.id);
    assert.equal((await post('/api/contact', { id, contact: '@founder_1' })).status, 200);
    assert.equal((await post('/api/contact', { id, contact: 'bad' })).status, 400);
    assert.equal((await post('/api/contact', { id: 'unknown', contact: 'me@example.org' })).status, 404);
    assert.equal((await readFile(join(dir, 'contacts.jsonl'), 'utf8')).split('\n').filter(Boolean).length, 1);
    const files = await readdir(join(dir, 'runs'));
    assert.equal(files.length, 1);
    assert.match(await readFile(join(dir, 'runs', files[0]), 'utf8'), /Input:/);
    assert.equal((await stat(join(dir, 'runs', files[0]))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });
});
test('intake API removes em dashes from all displayed model fields', async () => {
  await withServer(async () => '## Offer\nA pilot — soon.\n```json\n[{"to":"Buyer","channel":"email","message":"Hello — buyer"}]\n```', async ({ base, post }) => {
    const { id } = await (await post('/api/intake', { input: 'A business serving local teams.' })).json();
    let job;
    for (let n = 0; n < 100; n++) {
      job = await (await fetch(`${base}/api/intake/${id}`)).json();
      if (job.status !== 'working') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'done');
    assert.equal(job.drafts[0].message, 'Hello , buyer');
    assert.doesNotMatch(JSON.stringify(job), /—/);
  }, { material: async () => ({ material: 'business' }), scoreFundamentals: async () => ({ evidence: 'Evidence — example' }), planGoals: async () => ({ daily: 'Act — today' }) });
});
test('claude web denial from an injected fake runner is an error, not a saved plan', async () => {
  const previous = process.env.ENGINE;
  process.env.ENGINE = 'claude';
  try {
    for (const denial of ['I could not fetch the website because WebFetch was denied.', 'I couldn\'t fetch https://example.com.', 'I was not granted permission to use WebSearch.', 'I do not have permission to use WebFetch.']) {
      await withServer(async () => `## Plan\n${denial}`, async ({ base, post, dir }) => {
        const { id } = await (await post('/api/intake', { input: 'https://example.com' })).json();
        let job;
        for (let n = 0; n < 100; n++) {
          job = await (await fetch(`${base}/api/intake/${id}`)).json();
          if (job.status !== 'working') break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepEqual({ status: job.status, error: job.error }, { status: 'error', error: 'The engine could not read the web. Try again.' });
        assert.equal(job.result, undefined);
        await assert.rejects(readdir(join(dir, 'runs')), { code: 'ENOENT' });
      });
    }
  } finally {
    if (previous === undefined) delete process.env.ENGINE; else process.env.ENGINE = previous;
  }
});
test('engine spawn errors return a generic message through the intake API', async () => {
  const { think } = await import('../src/engine.js');
  const previousEngine = process.env.ENGINE, previousPath = process.env.PATH;
  process.env.ENGINE = 'claude';
  process.env.PATH = '/nonexistent-chameleon-test-bin';
  try {
    await withServer(think, async ({ base, post }) => {
      const { id } = await (await post('/api/intake', { input: 'A business serving local teams.' })).json();
      let job, response;
      for (let n = 0; n < 100; n++) {
        response = await fetch(`${base}/api/intake/${id}`);
        job = await response.json();
        if (job.status !== 'working') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(response.status, 200);
      assert.equal(job.status, 'error');
      assert.equal(job.error, 'Could not create a plan.');
      assert.deepEqual(Object.keys(job).sort(), ['error', 'seconds', 'status']);
      assert.doesNotMatch(JSON.stringify(job), /ENOENT|spawn claude|nonexistent-chameleon-test-bin/);
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousEngine === undefined) delete process.env.ENGINE; else process.env.ENGINE = previousEngine;
  }
});
test('passes client-supplied tone to the intake runner', async () => {
  let received;
  await withServer(async (input, options) => { received = { input, options }; return '## Questions for you\nNothing'; }, async ({ base, post }) => {
    const input = 'A description of the business.';
    const { id } = await (await post('/api/intake', { input, tone: 'gentle' })).json();
    for (let n = 0; n < 50; n++) {
      const job = await (await fetch(`${base}/api/intake/${id}`)).json();
      if (job.status !== 'working') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(received, { input, options: { tone: 'gentle' } });
  });
});
test('refuses to save private data inside the repository', async () => {
  await withServer(async () => '## Questions for you\nNothing', async ({ base, post }) => {
    process.env.DATA_DIR = new URL('../private-data', import.meta.url).pathname;
    const { id } = await (await post('/api/intake', { input: 'A description of the business.' })).json();
    let run;
    for (let n = 0; n < 50; n++) {
      run = await (await fetch(`${base}/api/intake/${id}`)).json();
      if (run.status !== 'working') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(run.status, 'error');
  });
});
test('evicts oldest finished jobs once the max record count is exceeded, keeping in-flight jobs', async () => {
  let stuckPending;
  const run = input => input === 'stuck job, never resolves, long enough' ? new Promise(() => { stuckPending = true; }) : Promise.resolve('## Questions for you\nx');
  await withServer(run, async ({ base, post }) => {
    // First job stays in-flight for the whole test.
    const stuck = await (await post('/api/intake', { input: 'stuck job, never resolves, long enough' })).json();
    // Two more jobs finish immediately, filling the cap (maxRecords: 3, including the stuck one) with finished records.
    const finishedIds = [];
    for (let n = 0; n < 2; n++) {
      const { id } = await (await post('/api/intake', { input: 'A long enough idea about customers.' })).json();
      let job;
      for (let i = 0; i < 100; i++) {
        job = await (await fetch(`${base}/api/intake/${id}`)).json();
        if (job.status !== 'working') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(job.status, 'done');
      finishedIds.push(id);
    }
    // Adding a 4th job should evict the oldest finished job (finishedIds[0]) but never the in-flight one.
    await post('/api/intake', { input: 'A long enough idea about customers.' });
    const evicted = await (await fetch(`${base}/api/intake/${finishedIds[0]}`)).json();
    assert.equal(evicted.error, 'Run not found.');
    const stuckStatus = await (await fetch(`${base}/api/intake/${stuck.id}`)).json();
    assert.equal(stuckStatus.status, 'working');
  }, { recordTTLMs: 60 * 60 * 1000, maxRecords: 3 });
});
test('limits working jobs, rejects oversized and invalid bodies', async () => {
  await withServer(() => new Promise(() => {}), async ({ post }) => {
    for (let n = 0; n < 10; n++) assert.equal((await post('/api/intake', { input: 'A long enough idea about customers.' })).status, 202);
    assert.equal((await post('/api/intake', { input: 'A long enough idea about customers.' })).status, 429);
    assert.equal((await post('/api/intake', { input: 'x'.repeat(19000) })).status, 413);
    assert.equal((await post('/api/contact', { id: 'x', contact: 'x'.repeat(9000) })).status, 413);
    assert.equal((await post('/api/intake', { input: 'dob: 01/01/1990' })).status, 400);
  });
});
test('accepts a full 6,000-character multi-byte UTF-8 input at the body limit', async () => {
  await withServer(() => new Promise(() => {}), async ({ post }) => {
    // Non-surrogate 3-byte-in-UTF-8 characters (e.g. many CJK code points) are the worst case
    // for the raw byte limit: 6,000 JS `.length` units expand to 18,000 UTF-8 bytes.
    const input = '\u4e2d'.repeat(6000);
    assert.equal(input.length, 6000);
    const response = await post('/api/intake', { input });
    assert.equal(response.status, 202);
  });
});

test('inbound SMS without Twilio send configured replies inline with a prefilled link, logs the lead, and stays silent on STOP', async () => {
  let ran = 0;
  await withServer(async () => { ran++; return ''; }, async ({ base, dir }) => {
    const sms = text => fetch(base + '/sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: '+15551234567', Body: text }) });
    const response = await sms('acme.example <b>& co</b>');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/xml/);
    const xml = await response.text();
    assert.match(xml, /<Message>Hi, I&apos;m 01co.*https:\/\/arautoai\.com\/app\?q=acme\.example%20%3Cb%3E%26%20co%3C%2Fb%3E<\/Message>/);
    assert.doesNotMatch(xml, /<b>/);
    assert.match(await readFile(join(dir, 'leads.jsonl'), 'utf8'), /"channel":"sms","from":"\+15551234567"/);
    assert.equal(await (await sms('STOP')).text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    assert.equal(ran, 0);
  }, { sendSms: null, notify: null });
});

test('inbound SMS with Twilio configured acks at once, then 01co answers by REST and the team hears about it', async () => {
  const sent = [], told = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  await withServer(async () => '', async ({ base, dir }) => {
    const response = await fetch(base + '/sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: '+15551234567', To: '+15104013633', Body: 'can we partner?' }) });
    assert.equal(await response.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    await finished;
    assert.deepEqual(sent, [['+15104013633', '+15551234567', 'Eric will reply today.']]);
    assert.match(told[0], /^Needs you: \+15551234567/);
    assert.match(await readFile(join(dir, 'leads.jsonl'), 'utf8'), /"route":"eric"/);
  }, {
    concierge: async (sender, words) => { assert.equal(sender, 'sms:+15551234567'); return { reply: 'Eric will reply today.', route: 'eric' }; },
    sendSms: async (...args) => { sent.push(args); },
    notify: async text => { told.push(text); setTimeout(done, 20); }
  });
});

test('a short bare domain is accepted and read as a website', async () => {
  let seen;
  await withServer(async input => { seen = input; return '## Questions for you\nNone'; }, async ({ post }) => {
    const response = await post('/api/intake', { input: 'x.ai' });
    assert.equal(response.status, 202);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(seen, 'https://x.ai');
    assert.equal((await post('/api/intake', { input: 'hi' })).status, 400);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { dashChat, dashState } from '../src/dash.js';
import { createApp } from '../src/server.js';
import { createBot } from '../src/bot.js';

const now = 1_700_000_000_000;
function signed(id, date = Math.floor(now / 1000), token = 'test-token') {
  const fields = new URLSearchParams({ auth_date: String(date), user: JSON.stringify({ id }), query_id: 'query' });
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  const check = [...fields].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  fields.set('hash', createHmac('sha256', key).update(check).digest('hex'));
  return fields.toString();
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dash-test-'));
  const previous = Object.fromEntries(['DATA_DIR', 'TELEGRAM_TEAM', 'TELEGRAM_BOT_TOKEN', 'DASH_OPERATOR_CHAT'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { DATA_DIR: dir, TELEGRAM_TEAM: '1', TELEGRAM_BOT_TOKEN: 'test-token' });
  delete process.env.DASH_OPERATOR_CHAT;
  try { await fn(dir); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
}

test('Mini App verifies Telegram signature, age, and allowed chat', async () => fixture(async dir => {
  const req = (header, address = '203.0.113.1') => ({ headers: { 'x-telegram-init-data': header }, socket: { remoteAddress: address } });
  assert.equal(await dashChat(req(signed(1)), now), 1);
  assert.equal(await dashChat(req(signed(2)), now), null);
  await writeFile(join(dir, 'founders.json'), JSON.stringify({ 2: { name: 'Founder' } }));
  assert.equal(await dashChat(req(signed(2)), now), 2);
  assert.equal(await dashChat(req(signed(1).replace('query_id=query', 'query_id=changed')), now), null);
  assert.equal(await dashChat(req(signed(1, now / 1000 - 86401)), now), null);
  assert.equal(await dashChat(req(signed(1, now / 1000 + 1)), now), null);
  assert.equal(await dashChat(req(signed(1) + '&user=%7B%22id%22%3A2%7D'), now), null);
}));

test('operator identity works only on loopback and never overrides invalid Telegram header', async () => fixture(async () => {
  process.env.DASH_OPERATOR_CHAT = '1';
  const req = address => ({ headers: {}, socket: { remoteAddress: address } });
  assert.equal(await dashChat(req('127.0.0.1'), now), 1);
  assert.equal(await dashChat(req('::1'), now), 1);
  assert.equal(await dashChat(req('::ffff:127.0.0.1'), now), null);
  assert.equal(await dashChat(req('203.0.113.1'), now), null);
  assert.equal(await dashChat({ ...req('127.0.0.1'), headers: { 'x-telegram-init-data': 'bad' } }, now), null);
  delete process.env.DASH_OPERATOR_CHAT;
  assert.equal(await dashChat(req('127.0.0.1'), now), null);
}));

test('state returns only the signed chat’s goal, rungs, cards and latest calls without replies', async () => fixture(async dir => {
  const threads = [
    { id: 1, chatId: 1, to: 'One', channel: 'email', why: 'Reason', message: 'Message', source: 'https://example.org', status: 'ready', replies: [{ text: 'Private A', at: now }] },
    { id: 2, chatId: 2, to: 'Two', channel: 'email', message: 'Secret B', status: 'ready', replies: [{ text: 'Private B', at: now }] }
  ];
  await writeFile(join(dir, 'threads.json'), JSON.stringify({ threads }));
  await writeFile(join(dir, 'goals.json'), JSON.stringify({ 1: { target: 3, by: '2023-11-21', setAt: now }, 2: { target: 9, by: '2023-11-21', setAt: now } }));
  await mkdir(join(dir, 'cycles'));
  await writeFile(join(dir, 'cycles', '1-2023-11-14.json'), JSON.stringify({ chatId: 1, calls: [{ item: '#1', why: 'Follow up' }] }));
  await writeFile(join(dir, 'cycles', '2-2023-11-15.json'), JSON.stringify({ chatId: 2, calls: [{ item: '#2', why: 'Private B' }] }));
  await writeFile(join(dir, 'lessons.json'), JSON.stringify({ 1: { active: [{ angle: 'site-fact', sends: 6, replies: 2, rate: 0.4, status: 'early signal', evidenceThreadIds: [1], text: 'Private A' }], retired: [], calibration: { n: 10, correlation: 0.2, at: now } }, 2: { active: [{ angle: 'other-secret', sends: 5, replies: 5, rate: 1 }], retired: [] } }));
  const one = await dashState(1, now);
  assert.equal(one.lessons.active[0].angle, 'site-fact');
  assert.equal(one.lessons.calibration.n, 10);
  assert.doesNotMatch(JSON.stringify(one.lessons), /Private A|evidenceThreadIds|other-secret/);
  assert.deepEqual(one.goal, { target: 3, by: '2023-11-21', done: 1, pace: 'on pace' });
  assert.equal(one.rungs[1].state, 'met');
  assert.deepEqual(one.cards, [{ id: 1, to: 'One', channel: 'email', why: 'Reason', message: 'Message', source: 'https://example.org', status: 'ready' }]);
  assert.deepEqual(one.calls, [{ item: '#1', why: 'Follow up' }]);
  assert.doesNotMatch(JSON.stringify(one), /Private A|Private B|Secret B|Two/);
  process.env.TELEGRAM_TEAM = '1,2';
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    // A live signature uses the current timestamp, unlike the fixed timestamp for pace above.
    const current = Math.floor(Date.now() / 1000);
    const get = async id => (await (await fetch(base + '/api/dash/state', { headers: { 'X-Telegram-Init-Data': signed(id, current) } })).json());
    assert.deepEqual((await get(1)).cards.map(card => card.id), [1]);
    const other = await get(2);
    assert.deepEqual(other.cards.map(card => card.id), [2]);
    assert.doesNotMatch(JSON.stringify(other), /Message|Private A|Follow up/);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('dashboard actions reuse bot editing and email sending rules with a fake transport', async () => fixture(async dir => {
  const delivered = [];
  process.env.TELEGRAM_TEAM = '1,2';
  await writeFile(join(dir, 'threads.json'), JSON.stringify({ nextId: 4, threads: [
    { id: 1, chatId: 1, to: 'Buyer', email: 'buyer@example.com', channel: 'email', message: 'Hello buyer?', status: 'ready' },
    { id: 2, chatId: 2, to: 'Other', email: 'other@example.com', channel: 'email', message: 'Other message', status: 'ready' },
    { id: 3, chatId: 1, to: 'Social', channel: 'x', message: 'Social message', status: 'ready' }
  ] }));
  const api = { sendMessage: async () => {}, answerCallbackQuery: async () => {} };
  const bot = createBot({ allowedChatIds: new Set([1, 2]), api, edit: async (_thread, feedback) => `Edited: ${feedback}`, mailTransport: { sendMail: async value => { delivered.push(value); return { messageId: 'fake' }; } }, smtp: { SMTP_HOST: 'localhost', SMTP_PORT: '2525', SMTP_USER: 'user', SMTP_PASS: 'pass', MAIL_FROM: 'founder@example.com' } });
  const server = createApp({ dashBot: bot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (id, action, value = {}, chat = 1) => fetch(`${base}/api/dash/threads/${id}/${action}`, { method: 'POST', headers: { 'X-Telegram-Init-Data': signed(chat, Math.floor(Date.now() / 1000)), 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await post(2, 'approve', { message: 'Other message' })).status, 404);
    assert.equal((await post(1, 'approve', { message: 'wrong' })).status, 409);
    assert.equal((await post(1, 'edit', { feedback: '' })).status, 400);
    assert.equal((await post(1, 'edit', { feedback: 'warmer' })).status, 200);
    assert.equal((await bot.loadState()).threads[0].message, 'Edited: warmer');
    assert.equal((await post(1, 'approve', { message: 'Hello buyer?' })).status, 409);
    assert.equal((await post(1, 'approve', { message: 'Edited: warmer' })).status, 200);
    assert.equal(delivered.length, 1);
    assert.equal((await bot.loadState()).threads[0].status, 'sent');
    await post(1, 'approve', { message: 'Edited: warmer' });
    assert.equal(delivered.length, 1);
    assert.equal((await post(3, 'approve', { message: 'Social message' })).status, 200);
    assert.equal((await bot.loadState()).threads[2].status, 'ready');
    assert.equal((await post(3, 'done', { message: 'Social message' })).status, 200);
    assert.equal((await bot.loadState()).threads[2].status, 'sent');
    assert.equal((await post(2, 'skip', {}, 2)).status, 200);
    assert.equal((await bot.loadState()).threads[1].status, 'skipped');
    assert.equal((await post(3, 'edit', { feedback: 'late' })).status, 200);
    assert.equal((await bot.loadState()).threads[2].message, 'Social message');
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('dashboard page serves branded responsive Mini App with escaped dynamic HTML', async () => fixture(async () => {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dash`);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const expected of ['#EEF3EC', '#16241A', '#1F7A45', '#E8B04A', '#E3F1E6', 'Bricolage+Grotesque', 'Figtree', 'max-width:420px', 'prefers-color-scheme:dark', 'id="goal"', 'id="ladder"', 'id="cards"', 'id="calls"', 'telegram.org/js/telegram-web-app.js', 'X-Telegram-Init-Data', 'Approve &amp; send', 'data-action="edit"', 'data-action="skip"', 'navigator.clipboard.writeText', 'const esc =']) assert.ok(html.includes(expected), expected);
    assert.doesNotMatch(html.slice(0, html.indexOf('<script>')), /\u2014/);
    assert.match(html, /rel="noopener noreferrer"/);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('dashboard groups ready, sent and skipped cards and merges repeated calls', async () => {
  const html = await readFile(new URL('../public/dash.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const nodes = Object.fromEntries(['goal', 'ladder', 'cards', 'calls', 'notice'].map(id => [id, { innerHTML: '', textContent: '', addEventListener() {} }]));
  const context = { document: { getElementById: id => nodes[id] }, window: {}, fetch: async () => ({ ok: true, json: async () => ({ cards: [], calls: [], rungs: [] }) }) };
  runInNewContext(script, context);
  runInNewContext(`show(${JSON.stringify({ goal: null, rungs: [], cards: [
    { id: 1, to: 'Sent buyer', channel: 'email', status: 'sent', message: 'Sent' },
    { id: 2, to: 'Skipped buyer', channel: 'email', status: 'skipped', message: 'Skipped' },
    { id: 3, to: 'Ready buyer', channel: 'email', status: 're-planned', message: 'Ready' }
  ], calls: Array.from({ length: 12 }, (_, i) => ({ move: 'defer', date: '2026-09-29', why: 'No new evidence yet.', item: `#${i + 14}` })) })})`, context);
  const cards = nodes.cards.innerHTML;
  assert.ok(cards.indexOf('Ready buyer') < cards.indexOf('Sent buyer'));
  assert.match(cards, /Ready for you \(1\)/);
  assert.match(cards, /<details><summary>Sent \(1\)<\/summary>/);
  assert.match(cards, /<details><summary>Skipped \(1\)<\/summary>/);
  assert.equal((nodes.calls.innerHTML.match(/class="panel"/g) || []).length, 1);
  assert.match(nodes.calls.innerHTML, /12 to 2026-09-29 \(#14 to #25\)/);
});

test('dashboard API returns 401 without identity and no private data', async () => fixture(async () => {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/api/dash/state', '/api/dash/threads/1/approve']) {
      const response = await fetch(base + path, { method: path.endsWith('approve') ? 'POST' : 'GET' });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Unauthorized.' });
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('a request relayed through a local tunnel does not get operator access', async () => {
  const saved = { op: process.env.DASH_OPERATOR_CHAT, team: process.env.TELEGRAM_TEAM };
  process.env.DASH_OPERATOR_CHAT = '424242';
  process.env.TELEGRAM_TEAM = '424242';
  try {
  const local = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const tunneled = { headers: { 'cf-connecting-ip': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(await dashChat(local), 424242);
  assert.equal(await dashChat(tunneled), null);
  } finally {
    for (const [key, value] of [['DASH_OPERATOR_CHAT', saved.op], ['TELEGRAM_TEAM', saved.team]]) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('a signed dashboard link admits its own chat, and not after expiry or tampering', async () => {
  const saved = { token: process.env.TELEGRAM_BOT_TOKEN, team: process.env.TELEGRAM_TEAM };
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_TEAM = '424242';
  try {
    const { dashLinkKey } = await import('../src/dash.js');
    const req = key => ({ headers: { 'x-dash-key': key, 'cf-connecting-ip': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } });
    const key = dashLinkKey(424242, Date.now());
    assert.equal(await dashChat(req(key)), 424242);
    assert.equal(await dashChat(req(dashLinkKey(424242, Date.now() - 13 * 3600 * 1000))), null);
    assert.equal(await dashChat(req(key.replace(/.$/, c => (c === 'a' ? 'b' : 'a')))), null);
    assert.equal(await dashChat(req(dashLinkKey(999, Date.now()))), null);
  } finally {
    for (const [k, v] of [['TELEGRAM_BOT_TOKEN', saved.token], ['TELEGRAM_TEAM', saved.team]]) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
});

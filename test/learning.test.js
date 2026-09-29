import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot } from '../src/bot.js';
import { runCycle } from '../src/cycle.js';
import { styleRules, founderStyle } from '../src/learning.js';

import { assessDraft, trigramSimilarity, repeatsDraft } from '../src/learning.js';

test('/learned shows only this chat’s counts, retired reasons, and calibration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learned-command-'));
  process.env.DATA_DIR = dir;
  const sent = [];
  const { writeFile } = await import('node:fs/promises');
  try {
    await writeFile(join(dir, 'lessons.json'), JSON.stringify({ 1: { active: [{ angle: 'site-fact', sends: 10, replies: 3, rate: 0.3, status: 'early signal', text: 'Private buyer text' }], retired: [{ angle: 'question', sends: 5, replies: 0, rate: 0, reason: 'evidence older than 28 days' }], calibration: { n: 10, correlation: -0.2 } }, 2: { active: [{ angle: 'other-chat-secret', sends: 5, replies: 5, rate: 1 }], retired: [] } }));
    const bot = createBot({ allowedChatIds: new Set([1]), api: { sendMessage: async value => sent.push(value) } });
    await bot.handleUpdate({ message: { chat: { id: 1 }, text: '/learned' } });
    assert.match(sent[0].text, /site-fact: 3\/10/);
    assert.match(sent[0].text, /question: 0\/5 replies; evidence older than 28 days/);
    assert.match(sent[0].text, /Calibration: 10 outcomes, correlation -0.20/);
    assert.doesNotMatch(sent[0].text, /Private buyer text|other-chat-secret/);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});
test('trigram repeat filter is per-chat, 30 days, and strict above 0.6', async () => {
  const message = 'Your launch page names three open integration slots this week. Want a short list?';
  const threads = [{ id: 1, chatId: 1, status: 'sent', sentAt: 100, message }];
  assert.equal(trigramSimilarity(message, message), 1);
  assert.equal(trigramSimilarity('one two', 'one two'), 0);
  assert.equal(repeatsDraft(message, 1, threads, 200), true);
  assert.equal(repeatsDraft(message, 2, threads, 200), false);
  assert.equal(repeatsDraft(message, 1, threads, 100 + 31 * 86400000), false);
  assert.equal(repeatsDraft(message, 1, [{ id: 1, chatId: 1, status: 're-planned', sentAt: 100, firstDraft: message, message: 'A different reply?' }], 200, 1), true);
  const item = { to: 'Ada', org: 'Acme', source: 'https://acme.test', channel: 'email', message };
  const critic = async () => JSON.stringify({ score: 95, reasons: [] });
  let seen;
  const rewrite = async prompt => { seen = prompt; return '```drafts\n' + JSON.stringify([{ ...item, message: 'Acme has a buyer interview scheduled next month. Could a pricing benchmark help?', angle: 'pricing-benchmark' }]) + '\n```'; };
  const passed = await assessDraft(item, 1, { critic, rewrite, threads, now: 200 });
  assert.match(seen, /Too similar/);
  assert.equal(passed.item.angle, 'pricing-benchmark');
  const rejected = await assessDraft(item, 1, { critic, rewrite: async () => '```drafts\n' + JSON.stringify([item]) + '\n```', threads, now: 200 });
  assert.equal(rejected.item, null);
  assert.equal(rejected.reason, 'repeat');
});

test('critic passes, rewrites once, or drops below the bar', async () => {
  const item = { to: 'Ada', org: 'Acme', source: 'https://acme.test/page', channel: 'email', message: 'Old?' };
  const pass = await assessDraft(item, 1, { critic: async () => JSON.stringify({ score: 90, reasons: [] }) });
  assert.equal(pass.item.message, 'Old?');
  const scores = [35, 80];
  const rewrite = async () => '```drafts\n' + JSON.stringify([{ ...item, message: 'Acme lists an open slot. Want the details?', angle: 'site-fact' }]) + '\n```';
  const revised = await assessDraft(item, 1, { critic: async () => JSON.stringify({ score: scores.shift(), reasons: ['No useful buyer fact'] }), rewrite });
  assert.equal(revised.item.message, 'Acme lists an open slot. Want the details?');
  assert.equal(revised.evaluation.score, 80);
  const dropped = await assessDraft(item, 1, { critic: async () => JSON.stringify({ score: 20, reasons: ['No value'] }), rewrite });
  assert.equal(dropped.item, null);
  assert.equal(dropped.evaluation.score, 20);
});

test('intake drops repeated drafts rather than exposing a second ready card', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-repeat-'));
  process.env.DATA_DIR = dir;
  const sent = [];
  const item = { to: 'Ada', org: 'Acme', channel: 'email', message: 'Your launch page names three open integration slots this week. Want a short list?' };
  const plan = '```drafts\n' + JSON.stringify([item, item]) + '\n```';
  const bot = createBot({ allowedChatIds: new Set([1]), run: async () => plan,
    critic: async () => JSON.stringify({ score: 90, reasons: [] }), rewrite: async () => plan,
    api: { sendMessage: async value => sent.push(value) } });
  try {
    await bot.handleUpdate({ message: { chat: { id: 1 }, text: '/intake idea' } });
    assert.equal((await bot.loadState()).threads.length, 1);
    assert.equal(sent.filter(value => value.parseMode === 'HTML').length, 1);
    assert.match(sent.at(-1).text, /1 dropped: below bar/);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

test('rejected edit still records feedback and removes ready status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-edit-drop-'));
  process.env.DATA_DIR = dir;
  const plan = '```drafts\n' + JSON.stringify([{ to: 'Ada', channel: 'email', message: 'Hello Ada?' }]) + '\n```';
  const bot = createBot({ allowedChatIds: new Set([1]), run: async () => plan, edit: async () => 'No useful value?', critic: async () => JSON.stringify({ score: 25, reasons: ['No value'] }), rewrite: async () => plan, api: { sendMessage: async () => {} } });
  try {
    // Seed a ready draft without relying on the critic for its initial intake.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'threads.json'), JSON.stringify({ nextId: 2, threads: [{ id: 1, chatId: 1, status: 'ready', channel: 'email', to: 'Ada', message: 'Hello Ada?' }] }));
    await bot.editThread(1, 1, 'Make it useful');
    assert.equal((await bot.loadState()).threads[0].status, 'dropped');
    assert.deepEqual((await styleRules(1)).map(rule => rule.rule), ['Make it useful']);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

test('cycle counts drafts below the bar without making them ready', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-cycle-'));
  process.env.DATA_DIR = dir;
  const { writeFile } = await import('node:fs/promises');
  try {
    await writeFile(join(dir, 'threads.json'), JSON.stringify({ nextId: 2, threads: [{ id: 1, chatId: 1, status: 'replied', to: 'Ada', channel: 'email', message: 'Original', input: 'Business', replies: [{ text: 'Yes', at: 100 }] }] }));
    const engine = async () => '```drafts\n' + JSON.stringify([{ to: 'Ada', channel: 'email', message: 'Original' }]) + '\n```';
    const result = await runCycle(1, { now: 100, engine, critic: async () => JSON.stringify({ score: 20, reasons: ['No value'] }), rewrite: engine });
    assert.equal(result.dropped['below bar'], 1);
    const state = JSON.parse(await readFile(join(dir, 'threads.json'), 'utf8'));
    assert.equal(state.threads[0].status, 'dropped');
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

test('edits create private per-chat newest-first style rules; /rules clear affects only that chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-'));
  process.env.DATA_DIR = dir;
  const sent = [];
  const plan = '```drafts\n' + JSON.stringify([{ to: 'Ada', channel: 'email', message: 'Hi Ada?' }]) + '\n```';
  const bot = createBot({ allowedChatIds: new Set([1, 2]), run: async () => plan, edit: async () => 'Hello Ada?', now: () => 123, api: { sendMessage: async value => sent.push(value), answerCallbackQuery: async () => {} } });
  const update = (chatId, text) => bot.handleUpdate({ message: { chat: { id: chatId }, text } });
  try {
    await update(1, '/intake idea');
    await bot.editThread(1, 1, 'Make it warmer');
    assert.deepEqual(await styleRules(1), [{ rule: 'Make it warmer', at: 123, sourceThreadId: 1 }]);
    assert.deepEqual(await styleRules(2), []);
    assert.match(await founderStyle(1), /Make it warmer/);
    assert.equal((await stat(join(dir, 'style.json'))).mode & 0o777, 0o600);
    await update(1, '/rules');
    assert.equal(sent.at(-1).text, '1. Make it warmer');
    await update(2, '/rules clear');
    assert.equal((await styleRules(1)).length, 1);
    await update(1, '/rules clear');
    assert.deepEqual(await styleRules(1), []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'style.json'), 'utf8'))[1], []);
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
});

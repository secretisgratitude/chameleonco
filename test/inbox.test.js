import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot } from '../src/bot.js';
import { watchInbox } from '../src/inbox.js';

const smtp = { IMAP_HOST: 'imap.gmail.com', IMAP_PORT: '993', SMTP_USER: 'founder@example.com', SMTP_PASS: 'secret' };
const plan = '```drafts\n' + JSON.stringify([{ to: 'Buyer', email: 'buyer@example.com', org: 'Acme', channel: 'email', message: 'Hello Buyer?' }]) + '\n```';
const headers = (id, from, refs, text = '') => Buffer.from(`Message-ID: ${id}\r\nFrom: ${from}\r\nReferences: ${refs}\r\n${text}`);
const messages = [
  { uid: 1, headers: headers('<reply@example.com>', 'Buyer <buyer@example.com>', '<sent@example.com>'), bodyStructure: { type: 'text/plain', part: '1', parameters: { charset: 'utf-8' } } },
  { uid: 2, headers: headers('<unrelated@example.com>', 'buyer@example.com', '<other@example.com>'), bodyStructure: { type: 'text/plain', part: '1' } },
  { uid: 3, headers: headers('<spoof@example.com>', 'attacker@example.com', '<sent@example.com>'), bodyStructure: { type: 'text/plain', part: '1' } },
  { uid: 5, headers: headers('<multi@example.com>', 'attacker@example.com, buyer@example.com', '<sent@example.com>'), bodyStructure: { type: 'text/plain', part: '1' } }
];

async function fixture(fn, { configured = smtp, items = messages, body = 'Yes <great>!\nOn Tue, Buyer wrote:\nsecret\n> quoted', replan } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-test-'));
  process.env.DATA_DIR = dir;
  const calls = [];
  const sent = [];
  const client = {
    connect: async () => { calls.push(['connect']); },
    mailboxOpen: async (...args) => { calls.push(['open', ...args]); },
    search: async (...args) => { calls.push(['search', ...args]); return items.map(item => item.uid); },
    fetchAll: async (...args) => { calls.push(['fetchAll', ...args]); return items; },
    fetchOne: async (...args) => { calls.push(['fetchOne', ...args]); return { bodyParts: new Map([['1', Buffer.from(typeof body === 'function' ? body(args[0]) : body)]]) }; },
    logout: async () => { calls.push(['logout']); }
  };
  const bot = createBot({ allowedChatIds: new Set([1]), smtp: configured,
    api: { sendMessage: async value => { sent.push(value); }, answerCallbackQuery: async () => {} },
    now: () => 1_700_000_000_000, run: async () => plan,
    replan: replan || (async (thread, reply) => `Thanks for saying ${reply.split('\n')[0]}. Next step?`),
    imapClientFactory: async options => { calls.push(['factory', options]); return client; }
  });
  try {
    await bot.handleUpdate({ message: { chat: { id: 1 }, text: '/intake idea' } });
    if (configured === smtp) {
      const state = await bot.loadState();
      state.threads[0].status = 'sent';
      state.threads[0].sentAt = 1_699_999_900_000;
      state.threads[0].emailMessageId = '<sent@example.com>';
      const { writeThreads, dataDir } = await import('../src/store.js');
      await writeThreads(join(dataDir(), 'threads.json'), state);
    }
    await fn({ bot, calls, sent, dir });
  } finally { delete process.env.DATA_DIR; await rm(dir, { recursive: true, force: true }); }
}

test('matching reply is read-only, peek-fetched once, stripped, private and re-planned', async () => {
  await fixture(async ({ bot, calls, sent, dir }) => {
    await bot.checkInbox();
    assert.deepEqual(calls.find(call => call[0] === 'open').slice(1), ['INBOX', { readOnly: true }]);
    assert.equal(calls.find(call => call[0] === 'factory')[1].secure, true);
    assert.deepEqual(calls.find(call => call[0] === 'search')[1], { since: new Date(1_699_999_900_000) });
    assert.deepEqual(calls.find(call => call[0] === 'fetchAll')[2], { headers: ['message-id', 'in-reply-to', 'references', 'from'], bodyStructure: true });
    assert.deepEqual(calls.filter(call => call[0] === 'fetchOne').map(call => call.slice(1)), [[1, { bodyParts: ['1'] }, { uid: true }]]);
    assert.match(sent.at(-2).text, /<b>Reply from Buyer \(Acme\)<\/b>\n<blockquote>Yes &lt;great&gt;!<\/blockquote>/);
    assert.match(sent.at(-1).text, /<pre>Thanks for saying Yes &lt;great&gt;!/);
    assert.deepEqual(sent.at(-1).replyMarkup.inline_keyboard[0].map(button => button.text), ['Approve & send', 'Edit', 'Skip']);
    const thread = (await bot.loadState()).threads[0];
    assert.equal(thread.status, 're-planned');
    assert.deepEqual(thread.replies.map(reply => reply.text), ['Yes <great>!']);
    const path = join(dir, 'inbox-seen.json');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), ['<reply@example.com>']);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await watchInbox({ env: smtp, threads: [{ ...thread, status: 'sent' }], clientFactory: async () => ({
      connect: async () => {}, mailboxOpen: async () => {}, search: async () => [1],
      fetchAll: async () => [messages[0]], fetchOne: async () => { throw Error('duplicate body fetched'); }, logout: async () => {}
    }), onReply: async () => { throw Error('duplicate handled'); } });
    assert.equal(calls.filter(call => call[0] === 'fetchOne').length, 1);
  });
});

test('In-Reply-To alone matches, while quoted lines are removed', async () => {
  await fixture(async ({ bot }) => {
    await bot.checkInbox();
    assert.equal((await bot.loadState()).threads[0].replies[0].text, 'First\nSecond');
  }, { items: [{ ...messages[0], headers: headers('<reply@example.com>', 'buyer@example.com', '', 'In-Reply-To: <sent@example.com>\r\n') }], body: 'First\n> hidden\nSecond' });
});

test('PHI reply is skipped and recorded without aborting subsequent replies', async () => {
  const items = [messages[0], { ...messages[0], uid: 4, headers: headers('<safe@example.com>', 'buyer@example.com', '<sent@example.com>') }];
  await fixture(async ({ bot, sent, dir }) => {
    await bot.checkInbox();
    assert.match(sent.find(message => /skipped/.test(message.text)).text, /personal or patient/);
    assert.equal((await bot.loadState()).threads[0].replies.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'inbox-seen.json'), 'utf8')), ['<reply@example.com>', '<safe@example.com>']);
  }, { items, body: uid => uid === 1 ? 'SSN 123-45-6789' : 'Sounds good', replan: async () => 'Next?' });
});

test('reply text removes > quotes and caps the retained text at 2000 characters', async () => {
  await fixture(async ({ bot }) => {
    await bot.checkInbox();
    const text = (await bot.loadState()).threads[0].replies[0].text;
    assert.equal(text, 'A'.repeat(2000));
  }, { body: 'A'.repeat(2100) + '\n>old quote\nOn Tue wrote:\nolder' });
});

test('missing IMAP settings never create a network client', async () => {
  await fixture(async ({ bot, calls }) => {
    await bot.checkInbox();
    assert.deepEqual(calls, []);
  }, { configured: {} });
});

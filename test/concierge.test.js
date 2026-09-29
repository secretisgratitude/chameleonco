import test from 'node:test';
import assert from 'node:assert/strict';
import { conciergeReply } from '../src/concierge.js';

const appUrl = 'https://app.example/app';

test('01co routes a website to the app with a prefilled link and strips model links', async () => {
  let prompt;
  const { reply, route } = await conciergeReply('t1', 'acme.example', { appUrl, engine: async p => { prompt = p; return '{"reply":"Great, see https://evil.example now.","route":"app"}'; } });
  assert.equal(route, 'app');
  assert.doesNotMatch(reply, /evil/);
  assert.match(reply, /https:\/\/app\.example\/app\?q=acme\.example/);
  assert.match(prompt, /<untrusted_website_data>\nacme\.example/);
});

test('01co routes a partnership ask to Eric and remembers the conversation', async () => {
  let prompt;
  await conciergeReply('t2', 'hello', { appUrl, engine: async () => '{"reply":"Hi there.","route":"none"}' });
  const { reply, route } = await conciergeReply('t2', 'can we partner?', { appUrl, engine: async p => { prompt = p; return '{"reply":"Happy to talk.","route":"eric"}'; } });
  assert.equal(route, 'eric');
  assert.match(reply, /passed this to Eric/);
  assert.match(prompt, /Them: hello/);
});

test('a broken or slow engine falls back to the canned link reply', async () => {
  const broken = await conciergeReply('t3', 'x', { appUrl, engine: async () => 'not json' });
  assert.equal(broken.fallback, true);
  assert.match(broken.reply, /I'm 01co/);
  const slow = await conciergeReply('t4', 'y', { appUrl, timeoutMs: 20, engine: () => new Promise(() => {}) });
  assert.equal(slow.fallback, true);
});

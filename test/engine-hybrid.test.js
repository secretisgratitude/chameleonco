import test from 'node:test';
import assert from 'node:assert/strict';
import { think } from '../src/engine.js';

test('hybrid sends no-web steps to Nebius', async () => {
  const saved = { ...process.env };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); };
  try {
    process.env.NEBIUS_API_KEY = 'test'; process.env.NEBIUS_MODEL = 'deepseek-ai/DeepSeek-V4-Pro';
    assert.equal(await think('offer step', { mode: 'hybrid', web: false }), 'ok');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /chat\/completions$/);
    assert.equal(calls[0].body.model, 'deepseek-ai/DeepSeek-V4-Pro');
  } finally { globalThis.fetch = realFetch; process.env = saved; }
});

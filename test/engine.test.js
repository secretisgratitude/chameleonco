import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { backend, safeChildEnv, think, engineSelfCheck } from '../src/engine.js';

const fixtures = dirname(fileURLToPath(new URL('./fixtures/claude', import.meta.url)));

test('fake backend provides all headings and three drafts', async () => {
  process.env.ENGINE = 'fake';
  const result = await think('a founder', { web: true });
  assert.match(result, /## Questions for you/);
  assert.match(result, /## Next 30 days/);
  const items = JSON.parse(result.match(/```drafts\s*([\s\S]*?)```/)[1]);
  assert.equal(items.length, 3);
  assert.ok(items.every(item => item.expert === 'copywriter'));
});
test('test environment defaults to fake', () => {
  delete process.env.ENGINE;
  process.env.NODE_ENV = 'test';
  assert.equal(backend(), 'fake');
});
test('child environment allowlists benign variables and strips everything else, including secret variants a blocklist would miss', () => {
  assert.deepEqual(safeChildEnv({
    ANTHROPIC_API_KEY: 'a', TELEGRAM_BOT_TOKEN: 'b', PATH: '/bin', NEBIUS_API_KEY: 'c',
    AWS_SECRET_ACCESS_KEY: 'd', OPENAI_API_KEY: 'e', TOKEN: 'f', MY_TOKENS: 'g', X_TOKEN_HEADER: 'h',
    HOME: '/root', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', CLAUDE_CONFIG_DIR: '/x', RANDOM_VAR: 'z'
  }), { PATH: '/bin', HOME: '/root', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', CLAUDE_CONFIG_DIR: '/x' });
});
test('claude is spawned with isolated settings, MCP config, tools and no session persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chameleon-cli-test-'));
  const previousEngine = process.env.ENGINE, previousPath = process.env.PATH;
  await writeFile(join(directory, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  process.env.ENGINE = 'claude';
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    for (const [web, tools] of [[true, 'WebSearch,WebFetch'], [false, '']]) {
      const output = await think('hello', { web, timeoutMs: 5000 });
      assert.deepEqual(output.trimEnd().split('\n'), [
        '-p', '--tools', tools, ...(web ? ['--allowedTools', tools] : []), '--strict-mcp-config', '--setting-sources', '',
        '--safe-mode', '--no-session-persistence'
      ]);
    }
  } finally {
    process.env.PATH = previousPath;
    if (previousEngine === undefined) delete process.env.ENGINE; else process.env.ENGINE = previousEngine;
    await rm(directory, { recursive: true, force: true });
  }
});
test('engine self-check probes the web only in claude mode and handles success, denial and errors', async () => {
  const previous = process.env.ENGINE;
  try {
    process.env.ENGINE = 'fake';
    assert.equal(await engineSelfCheck(() => { throw new Error('should not run'); }), null);
    process.env.ENGINE = 'claude';
    let calls = 0;
    assert.equal(await engineSelfCheck(async (prompt, options) => {
      calls++;
      assert.match(prompt, /https:\/\/example\.com/);
      assert.match(prompt, /<h1>/);
      assert.equal(options.web, true);
      return 'Example Domain';
    }), true);
    assert.equal(calls, 1);
    assert.equal(await engineSelfCheck(async () => 'Permission denied'), false);
    assert.equal(await engineSelfCheck(async () => { throw new Error('spawn failed'); }), false);
  } finally {
    if (previous === undefined) delete process.env.ENGINE; else process.env.ENGINE = previous;
  }
});
test('a missing claude executable returns a generic error rather than a raw spawn error', async () => {
  const previousEngine = process.env.ENGINE, previousPath = process.env.PATH;
  process.env.ENGINE = 'claude';
  process.env.PATH = '/nonexistent-chameleon-test-bin';
  try {
    await assert.rejects(think('hello', { timeoutMs: 5000 }), error => {
      assert.equal(error.message, 'Could not create a plan.');
      return true;
    });
  } finally {
    process.env.PATH = previousPath;
    if (previousEngine === undefined) delete process.env.ENGINE;
    else process.env.ENGINE = previousEngine;
  }
});
test('a failing claude process never leaks its stderr to the caller; think() rejects with a generic message', async () => {
  process.env.ENGINE = 'claude';
  const originalPath = process.env.PATH;
  const originalError = console.error;
  let logged = '';
  console.error = message => { logged += message; };
  process.env.PATH = `${fixtures}:${originalPath}`;
  try {
    await assert.rejects(
      think('hello', { timeoutMs: 5000 }),
      error => {
        assert.equal(error.message, 'Could not create a plan.');
        assert.ok(!error.message.includes('/secret/path'));
        return true;
      }
    );
    assert.match(logged, /\/secret\/path\/leak\.js:42/);
  } finally {
    console.error = originalError;
    process.env.PATH = originalPath;
    delete process.env.ENGINE;
  }
});

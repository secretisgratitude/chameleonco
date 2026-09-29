import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/server.js';

const ALLOWED_NUMBERS = new Set(['112', '85', '33', '21', '19', '12', '27', '5', '45', '3']);
const GATE_LABELS = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'];

async function withServer(fn) {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('GET / serves the story page with sections 1 to 7', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/story`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    for (let n = 1; n <= 7; n++) assert.match(html, new RegExp(`id="section-${n}"`));
  });
});

test('GET /app serves the tool, unchanged', async () => {
  await withServer(async base => {
    const [storyResponse, appResponse, appFile] = await Promise.all([
      fetch(`${base}/story`),
      fetch(`${base}/app`),
      readFile(new URL('../public/app.html', import.meta.url), 'utf8')
    ]);
    assert.equal(appResponse.status, 200);
    assert.match(appResponse.headers.get('content-type'), /text\/html/);
    const appHtml = await appResponse.text();
    assert.equal(appHtml, appFile);
    const storyHtml = await storyResponse.text();
    assert.notEqual(storyHtml, appHtml);
  });
});

test('design pass copy, artwork and favicon appear on the story and app pages', async () => {
  await withServer(async base => {
    const [story, app] = await Promise.all([
      fetch(`${base}/story`).then(response => response.text()),
      fetch(`${base}/app`).then(response => response.text())
    ]);
    assert.ok(story.includes('Earned, not claimed.'));
    assert.ok(!story.includes('27 ,'));
    assert.ok(story.includes('/brand/mascot.png'));
    for (const html of [story, app]) assert.ok(html.includes('href="/brand/favicon.png"'));
    for (const asset of ['mascot.png', 'favicon.png']) {
      const response = await fetch(`${base}/brand/${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/png/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  });
});

test('the story page contains no em dash', async () => {
  await withServer(async base => {
    const html = await (await fetch(`${base}/story`)).text();
    assert.ok(!html.includes('\u2014'), 'expected no em dash (U+2014) anywhere on the page');
  });
});

test('every number on the story page is one of the sourced numbers or a gate label', async () => {
  await withServer(async base => {
    const html = await (await fetch(`${base}/story`)).text();
    // Strip style/script blocks (CSS px values, hex colors' digits via attrs, JS thresholds
    // are not "numbers on the page"), then strip tags and attributes to get visible text only.
    const withoutStyleScript = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
    // "01co" is the co-founder's brand name and "September 2026" is part of the quoted, final
    // post title in the byline (copy is fixed, not a page statistic); drop both before scanning.
    const withoutTags = withoutStyleScript.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '\n')
      .replace(/01co/g, '').replace(/r\/startups, September 2026/g, '');
    for (const match of withoutTags.matchAll(/G?\d+/g)) {
      const token = match[0];
      if (GATE_LABELS.includes(token)) continue;
      assert.ok(ALLOWED_NUMBERS.has(token), `unexpected number "${token}" on the story page`);
    }
  });
});

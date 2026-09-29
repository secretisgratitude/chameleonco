import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('every inline script in public pages compiles', async () => {
  const dir = new URL('../public/', import.meta.url);
  const pages = (await readdir(dir)).filter(name => name.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = await readFile(new URL(page, dir), 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `${page}#${i}` }), `${page} inline script ${i} does not compile`));
  }
});

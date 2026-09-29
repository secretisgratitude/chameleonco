import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const page = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
test('plan renderer displays 01co calls and signs expert drafts', () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = {};
  const element = id => nodes[id] ||= { children: [], hidden: true, textContent: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener() {} };
  const context = { URL, navigator: { clipboard: { writeText() {} } }, document: { getElementById: element, createElement: () => element('node-' + Math.random()), querySelectorAll: () => [] } };
  runInNewContext(script + ';globalThis.renderPlan = render;', context);
  context.renderPlan({ result: 'plan', sections: [{ title: "01co's calls", body: 'Delegate to closer' }], drafts: [{ to: 'buyer', expert: 'closer', message: 'Hi', channel: 'email' }] });
  assert.equal(element('sections').children[0].children[0].textContent, "01co's calls");
  assert.equal(element('drafts').children[0].children[1].textContent, 'Chameleon, as the closer');
});
test('plan sections render script markup escaped in the page markdown renderer', () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = {};
  const element = id => nodes[id] ||= { children: [], hidden: true, textContent: '', innerHTML: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener() {} };
  const context = { URL, navigator: { clipboard: { writeText() {} } }, document: { getElementById: element, createElement: () => element('node-' + Math.random()), querySelectorAll: () => [] } };
  runInNewContext(script + ';globalThis.renderPlan = render;', context);
  context.renderPlan({ result: 'plan', sections: [{ title: 'Questions for you', body: '<script>alert(1)</script>' }], drafts: [] });
  const html = element('sections').children[0].children[1].innerHTML;
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});
test('page includes all required controls and content', () => {
  for (const id of ['hero','gates','intake-form','input','submit','status','working','progress','timer','optin','contact-form','contact','contact-status','plan','sections','drafts','copy-plan','restart','fundamentals','fundamentals-list','goals','goals-headline','goals-list','goals-daily','goals-review']) assert.match(page, new RegExp(`id="${id}"`));
  for (const text of ['ChameleonCo','Built the thing. Validated the problem. Nobody will go first.','Keep me posted','Messages ready to send','Copy message','We read 112 founders']) assert.ok(page.includes(text));
});
test('stuck progress UI: a polling error clears the working panel and timer, not just a terminal status', async () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  function fakeElement(id) {
    if (!elements[id]) elements[id] = { id, hidden: true, textContent: '', value: '', disabled: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
    return elements[id];
  }
  for (const id of ['input', 'submit', 'status', 'working', 'optin', 'plan', 'timer', 'contact', 'contact-form', 'contact-status', 'sections', 'drafts', 'copy-plan', 'restart']) fakeElement(id);
  let intervalCalls = 0, clearedIntervals = 0;
  const context = {
    URL, navigator: { clipboard: { writeText() {} } },
    document: {
      getElementById: fakeElement,
      querySelectorAll: () => []
    },
    setInterval: () => { intervalCalls++; return intervalCalls; },
    clearInterval: () => { clearedIntervals++; },
    setTimeout: (fn, ms) => setTimeout(fn, 0),
    Date,
    fetch: async url => {
      if (url === '/api/intake') return { ok: true, json: async () => ({ id: 'job-1' }) };
      if (String(url).startsWith('/api/intake/')) return { ok: false, json: async () => ({ error: 'Run not found.' }) };
      throw new Error('unexpected fetch ' + url);
    },
    console
  };
  fakeElement('intake-form');
  runInNewContext(script, context);
  const handler = elements['intake-form'].listeners.submit;
  elements.working.hidden = false;
  await handler({ preventDefault() {} });
  assert.equal(elements.working.hidden, true);
  assert.equal(elements.status.textContent, 'Run not found.');
  assert.equal(elements.submit.disabled, false);
});
test('restart prevents an in-flight poll from rendering the old plan', async () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  function element(id) {
    return elements[id] ||= { hidden: true, textContent: '', value: '', disabled: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, replaceChildren() {}, focus() {} };
  }
  let releasePoll, polling;
  const pollStarted = new Promise(resolve => { polling = resolve; });
  const context = {
    URL, Date, console, window: { scrollTo() {} }, navigator: { clipboard: { writeText() {} } },
    document: { getElementById: element, querySelectorAll: () => [] },
    setTimeout: fn => setTimeout(fn, 0), setInterval: () => 1, clearInterval() {},
    fetch: async url => {
      if (url === '/api/intake') return { ok: true, json: async () => ({ id: 'old-job' }) };
      polling();
      return new Promise(resolve => { releasePoll = () => resolve({ ok: true, json: async () => ({ status: 'done', result: 'old plan', sections: [], drafts: [] }) }); });
    }
  };
  runInNewContext(script, context);
  const submit = element('intake-form').listeners.submit({ preventDefault() {} });
  await pollStarted;
  element('restart').listeners.click();
  releasePoll();
  await submit;
  assert.equal(element('plan').hidden, true);
  assert.equal(element('sections').textContent, '');
  assert.equal(element('status').textContent, '');
});
test('both copy actions handle clipboard write failures', () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  function element(id) {
    return elements[id] ||= { hidden: true, textContent: '', listeners: {}, children: [], addEventListener(type, handler) { this.listeners[type] = handler; }, replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } };
  }
  let caught = 0;
  const context = {
    URL, document: { getElementById: element, createElement: tag => element('created-' + tag + '-' + Math.random()), querySelectorAll: () => [] },
    navigator: { clipboard: { writeText() { return { catch(handler) { caught++; handler(new Error('denied')); } }; } } }
  };
  runInNewContext(script + ';globalThis.renderPlan = render;', context);
  context.renderPlan({ result: 'the plan', sections: [], drafts: [{ to: 'someone', message: 'hello', source: 'your material' }] });
  const card = element('drafts').children[0];
  const copy = card.children.find(child => child.textContent === 'Copy message');
  copy.listeners.click();
  assert.equal(element('status').textContent, 'Could not copy to clipboard.');
  element('status').textContent = '';
  element('copy-plan').listeners.click();
  assert.equal(element('status').textContent, 'Could not copy to clipboard.');
  assert.equal(caught, 2);
});
test('forged link placeholders cannot duplicate rendered links', () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { URL, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } };
  runInNewContext(script + ';globalThis.renderMarkdown = markdown;', context);
  const output = context.renderMarkdown('[real](https://example.org) forged \u00010\u0002');
  assert.equal((output.match(/<a /g) || []).length, 1);
  assert.ok(!output.includes('\u0001'));
  assert.ok(!output.includes('\u0002'));
});
test('markdown renderer escapes raw script and rejects unsafe links', () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { URL, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } };
  runInNewContext(script + ';globalThis.renderMarkdown = markdown;', context);
  const output = context.renderMarkdown('<script>alert(1)</script>\n[bad](javascript:alert(1))\n[good](https://example.org)');
  assert.ok(output.includes('&lt;script&gt;'));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('href="javascript:'));
  assert.ok(output.includes('rel="noopener"'));
});

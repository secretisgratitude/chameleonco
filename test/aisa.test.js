import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBuyers, buyerDomain } from '../src/aisa.js';

const reply = results => ({ ok: true, text: async () => JSON.stringify({ result: { content: [{ text: JSON.stringify({ results }) }] } }) });

test('buyerDomain skips social and news hosts', () => {
  assert.equal(buyerDomain({ source: 'https://www.carbon.ms/about' }), 'carbon.ms');
  assert.equal(buyerDomain({ source: 'https://news.ycombinator.com/item?id=1' }), null);
  assert.equal(buyerDomain({ source: 'not a url' }), null);
});

test('verifyBuyers searches by org name and records found and not found', async () => {
  let body;
  const fetchImpl = async (url, options) => { body = JSON.parse(options.body); return reply([
    { call_id: '0', successful: true, customer_cost_micros_usd: 19750, data: { organizations: [{ name: 'Carbon Manufacturing Systems', primary_domain: 'carbon.ms', estimated_num_employees: 12, industry: 'software' }] } },
    { call_id: '1', successful: true, customer_cost_micros_usd: 19750, data: { organizations: [], accounts: [] } }
  ]); };
  const { drafts, cost } = await verifyBuyers([
    { to: 'A', org: 'Carbon', source: 'https://carbon.ms' },
    { to: 'B', org: 'Linkjolt', source: 'https://www.uneed.best/tool/linkjolt' },
    { to: 'C', org: '' }
  ], { key: 'k', fetchImpl });
  const calls = body.params.arguments.calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'post_apollo_mixed_companies_search');
  assert.deepEqual(calls[0].arguments['q_organization_domains_list[]'], ['carbon.ms']);
  assert.equal(calls[1].arguments['q_organization_domains_list[]'], undefined);
  assert.equal(drafts[0].verified.found, true);
  assert.equal(drafts[0].verified.domain, 'carbon.ms');
  assert.equal(drafts[0].verified.matchedBy, 'domain');
  assert.deepEqual(drafts[1].verified, { found: false, by: 'Apollo via AIsa' });
  assert.equal(drafts[2].verified, undefined);
  assert.equal(cost, 0.0395);
});

test('verifyBuyers never counts a shared word as a match', async () => {
  const fetchImpl = async () => reply([{ call_id: '0', successful: true, data: { organizations: [{ name: 'Minimal Tweaks', primary_domain: 'minimaltweaks.com' }, { name: 'Minimal, Inc.', primary_domain: 'minimal.com', estimated_num_employees: 40 }] } }]);
  const { drafts } = await verifyBuyers([{ org: 'Minimal', source: 'https://news.example.org/a' }], { key: 'k', fetchImpl });
  assert.equal(drafts[0].verified.name, 'Minimal, Inc.');
  assert.equal(drafts[0].verified.matchedBy, 'name');
  const none = await verifyBuyers([{ org: 'Minimal', source: 'https://news.example.org/a' }], { key: 'k', fetchImpl: async () => reply([{ call_id: '0', successful: true, data: { organizations: [{ name: 'Minimal Tweaks' }] } }]) });
  assert.equal(none.drafts[0].verified.found, false);
});

test('verifyBuyers makes no call without a key', async () => {
  const list = [{ org: 'Carbon', source: 'https://carbon.ms' }];
  const out = await verifyBuyers(list, { key: '', fetchImpl: () => { throw new Error('called'); } });
  assert.equal(out.drafts, list);
});

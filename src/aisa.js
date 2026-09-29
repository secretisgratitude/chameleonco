// Checks each named buyer's company against Apollo through AIsa's tool router, so a plan
// shows which buyers are real companies and how big they are. About $0.02 per company.
const endpoint = 'https://tools.aisa.one/mcp';
const socialHosts = /(^|\.)(linkedin|twitter|x|ycombinator|github|medium|producthunt|indiehackers|reddit|youtube|substack|google|facebook|instagram|crunchbase|wikipedia|techcrunch|bsky)\.(com|org|co|app)$/i;

export function buyerDomain(draft) {
  try {
    const host = new URL(draft.source).hostname.replace(/^www\./i, '').toLowerCase();
    return socialHosts.test(host) ? null : host;
  } catch { return null; }
}

// A match needs a shared word of 3+ letters between the plan's org and Apollo's name, so a
// news site cited as the source is never passed off as the buyer.
const words = text => new Set(String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
const sameOrg = (a, b) => [...words(a)].some(word => words(b).has(word));
// A confirmed match is the same name once legal suffixes are dropped, never a shared word.
const core = text => [...words(text)].filter(word => !/^(inc|llc|ltd|corp|corporation|company|gmbh|the)$/.test(word)).sort().join(' ');
const exactOrg = (a, b) => core(a) !== '' && core(a) === core(b);

function parse(body) {
  const line = body.trim().startsWith('{') ? body : body.split('\n').find(l => l.startsWith('data:'))?.slice(5) || '{}';
  return JSON.parse(JSON.parse(line).result.content[0].text);
}

export async function verifyBuyers(list, { key = process.env.AISA_API_KEY, limit = 5, fetchImpl = fetch } = {}) {
  if (!key || !Array.isArray(list)) return { drafts: list, cost: 0 };
  const orgs = [...new Set(list.map(draft => typeof draft.org === 'string' ? draft.org.trim() : '').filter(org => org.length >= 3 && org.length <= 80))].slice(0, limit);
  if (!orgs.length) return { drafts: list, cost: 0 };
  const calls = orgs.map((org, i) => {
    const domain = list.map(d => d.org?.trim() === org && buyerDomain(d)).find(host => host && sameOrg(org, host.replace(/\./g, ' ')));
    return { call_id: String(i), tool: 'post_apollo_mixed_companies_search', arguments: { q_organization_name: org, per_page: 5, ...(domain ? { 'q_organization_domains_list[]': [domain] } : {}) } };
  });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'batch_use', arguments: { calls } } }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`AIsa returned ${response.status}.`);
  const checked = new Map();
  let cost = 0;
  for (const result of parse(await response.text()).results || []) {
    cost += (result.customer_cost_micros_usd || 0) / 1e6;
    if (!result.successful) continue;
    const org = orgs[Number(result.call_id)];
    const hosts = new Set(list.filter(d => d.org?.trim() === org).map(buyerDomain).filter(Boolean));
    const match = [...(result.data?.organizations || []), ...(result.data?.accounts || [])].find(item => exactOrg(org, item.name) || (item.primary_domain && hosts.has(item.primary_domain.toLowerCase())));
    checked.set(org, match
      ? { found: true, matchedBy: match.primary_domain && hosts.has(match.primary_domain.toLowerCase()) ? 'domain' : 'name', name: match.name, domain: match.primary_domain || null, employees: match.estimated_num_employees || null, industry: match.industry || null, by: 'Apollo via AIsa' }
      : { found: false, by: 'Apollo via AIsa' });
  }
  return {
    drafts: list.map(draft => checked.has(draft.org?.trim()) ? { ...draft, verified: checked.get(draft.org.trim()) } : draft),
    cost: Math.round(cost * 10000) / 10000
  };
}

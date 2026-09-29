import { createHmac, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getGoal, goalPace } from './autonomy.js';
import { parseTeam } from './bot.js';
import { ladder } from './ladder.js';
import { dataDir, readJSON, readThreads } from './store.js';
import { chatLessons, publicLessons } from './lessons.js';
import { traceCounts } from './trace.js';
import { queueStatus } from './queue.js';

const DAY = 86400;
// A signed link the bot hands the founder, for when the page opens outside Telegram's
// Mini App frame (Telegram for Mac often does). Key = HMAC of chat id and expiry.
function linkSecret() { return createHmac('sha256', 'ChameleonDashLink').update(process.env.TELEGRAM_BOT_TOKEN || '').digest(); }
export function dashLinkKey(chatId, now = Date.now(), ttlMs = 12 * 3600 * 1000) {
  const exp = Math.floor((now + ttlMs) / 1000);
  const mac = createHmac('sha256', linkSecret()).update(`${chatId}.${exp}`).digest('hex');
  return `${chatId}.${exp}.${mac}`;
}
function chatFromLinkKey(value, now) {
  const m = /^(\d{1,20})\.(\d{1,12})\.([a-f0-9]{64})$/.exec(String(value));
  if (!m || !process.env.TELEGRAM_BOT_TOKEN || Number(m[2]) * 1000 < now) return null;
  const expected = createHmac('sha256', linkSecret()).update(`${m[1]}.${m[2]}`).digest();
  return timingSafeEqual(expected, Buffer.from(m[3], 'hex')) ? chatNumber(m[1]) : null;
}
function chatNumber(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
export async function allowedChats() {
  const team = parseTeam(process.env.TELEGRAM_TEAM);
  const founders = await readJSON(join(dataDir(), 'founders.json'), []);
  const values = Array.isArray(founders) ? founders : Array.isArray(founders?.founders) ? founders.founders : Object.keys(founders || {});
  for (const value of values) {
    const id = chatNumber(typeof value === 'object' && value !== null ? value.chatId ?? value.id : value);
    if (id) team.add(id);
  }
  return team;
}
export async function dashChat(req, now = Date.now()) {
  const header = req.headers['x-telegram-init-data'];
  let id;
  if (typeof header === 'string') {
    const params = new URLSearchParams(header);
    const hashes = params.getAll('hash');
    const dates = params.getAll('auth_date');
    const users = params.getAll('user');
    if (hashes.length !== 1 || dates.length !== 1 || users.length !== 1 || !/^[a-f0-9]{64}$/i.test(hashes[0]) || !/^\d+$/.test(dates[0]) || !process.env.TELEGRAM_BOT_TOKEN) return null;
    const age = Math.floor(now / 1000) - Number(dates[0]);
    if (!Number.isFinite(age) || age < 0 || age > DAY) return null;
    const fields = [...params.entries()].filter(([key]) => key !== 'hash');
    if (new Set(fields.map(([key]) => key)).size !== fields.length) return null;
    const check = fields.map(([key, value]) => `${key}=${value}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
    const digest = createHmac('sha256', secret).update(check).digest();
    if (!timingSafeEqual(digest, Buffer.from(hashes[0], 'hex'))) return null;
    try { id = chatNumber(JSON.parse(users[0]).id); } catch { return null; }
  } else if (typeof req.headers['x-dash-key'] === 'string') {
    id = chatFromLinkKey(req.headers['x-dash-key'], now);
  } else if (header === undefined && ['127.0.0.1', '::1'].includes(req.socket.remoteAddress) && !['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'cf-ray'].some(name => req.headers[name] !== undefined)) {
    // A tunnel also connects from localhost; only a request with no proxy headers is the operator's own machine.
    id = chatNumber(process.env.DASH_OPERATOR_CHAT);
  }
  return id && (await allowedChats()).has(id) ? id : null;
}

export async function dashState(chatId, now = Date.now()) {
  const state = await readThreads(join(dataDir(), 'threads.json'), { threads: [] });
  const mine = (state.threads || []).filter(t => t.chatId === chatId);
  const goal = await getGoal(chatId);
  const pace = goal && goalPace(goal, mine, now);
  const directory = join(dataDir(), 'cycles');
  let names = [];
  try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const latest = names.filter(name => new RegExp(`^${chatId}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(name)).sort().at(-1);
  const cycle = latest ? await readJSON(join(directory, latest), null) : null;
  return {
    goal: goal ? { target: goal.target, by: goal.by, done: pace.done, pace: pace.status } : null,
    rungs: ladder(mine),
    cards: mine.map(({ id, to, org, email, expert, channel, why, message, status, source, copyReadyRevision }) => ({ id, to, channel, why, message, status, source, ...(org ? { org } : {}), ...(email ? { email } : {}), ...(expert ? { expert } : {}), ...(copyReadyRevision ? { copyReady: true } : {}) })),
    calls: cycle?.chatId === chatId ? cycle.calls || [] : [],
    lessons: publicLessons(await chatLessons(chatId)),
    traceCounts: await traceCounts(chatId, now),
    queue: await queueStatus(chatId, now)
  };
}

// What the founder is replying to: the post or page behind a draft, so a card can be judged
// without leaving it. Fetches only the thread's own source, only public http(s) hosts.
const previews = new Map();
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[|::)/i;
function strip(html) {
  return String(html ?? '').replace(/<p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();
}
function sourceUrl(thread) {
  for (const value of [thread.source, /\(([a-z0-9-]+(?:\.[a-z0-9-]+)+)\)/i.exec(thread.org || '')?.[1]]) {
    if (!value) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') && !PRIVATE_HOST.test(url.hostname)) return url;
    } catch {}
  }
  return null;
}
async function getText(url, fetchImpl, accept = 'text/html') {
  const response = await fetchImpl(url, { headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; ChameleonPreview/1.0)' }, redirect: 'follow', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.text()).slice(0, 400_000);
}
export async function sourcePreview(thread, fetchImpl = fetch) {
  const url = sourceUrl(thread);
  if (!url) return { kind: 'none', note: thread.source ? String(thread.source) : 'No source recorded.' };
  const key = url.href;
  if (previews.has(key)) return previews.get(key);
  let result;
  try {
    const hn = url.hostname === 'news.ycombinator.com' && url.searchParams.get('id');
    if (hn && /^\d+$/.test(hn)) {
      const item = JSON.parse(await getText(`https://hn.algolia.com/api/v1/items/${hn}`, fetchImpl, 'application/json'));
      result = { kind: 'hn', url: key, title: item.title || '', author: item.author || '', points: item.points ?? null, date: item.created_at || '', text: strip(item.text).slice(0, 1500), link: item.url || '', comments: (item.children || []).length };
    } else if (/(^|\.)(x|twitter)\.com$/.test(url.hostname)) {
      result = { kind: 'x', url: key, title: `X profile ${url.pathname.split('/')[1] ? '@' + url.pathname.split('/')[1] : ''}`.trim(), text: 'X blocks previews. Open the link to see their latest posts.' };
    } else {
      const html = await getText(key, fetchImpl);
      const meta = name => new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)`, 'i').exec(html)?.[1] || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html)?.[1];
      result = { kind: 'page', url: key, title: strip(meta('og:title') || /<title[^>]*>([^<]*)/i.exec(html)?.[1] || url.hostname).slice(0, 200), text: strip(meta('og:description') || meta('description') || '').slice(0, 600) };
    }
  } catch (error) {
    result = { kind: 'error', url: key, title: url.hostname, text: `Could not load a preview (${error.message}). Open the link.` };
  }
  previews.set(key, result);
  return result;
}

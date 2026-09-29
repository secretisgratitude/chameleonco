import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { access, appendFile, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuyers } from './aisa.js';
import { intake, businessMaterial, drafts, sections, guardPersonal, cleanModelText, rejectWebDenial } from './intake.js';
import { backend, engineSelfCheck } from './engine.js';
import { conciergeReply, fallbackReply } from './concierge.js';
import { fundamentals } from './fundamentals.js';
import { goals } from './goals.js';
import { loadLedger } from './ledger.js';
import { dataDir, privateDir, readJSON, writeJSON } from './store.js';
import { ladder } from './ladder.js';
import { dashChat, dashState, sourcePreview } from './dash.js';
import { createBot } from './bot.js';

const story = fileURLToPath(new URL('../public/index.html', import.meta.url));
const app = fileURLToPath(new URL('../public/app.html', import.meta.url));
const ladderScript = fileURLToPath(new URL('../public/ladder.js', import.meta.url));
// Serialize claims so simultaneous page loads do not both display the first yes.
let firstClaim = Promise.resolve();
async function ladderData() {
  const directory = dataDir();
  const state = await readJSON(join(directory, 'threads.json'), { threads: [] });
  const threads = Array.isArray(state) ? state : Array.isArray(state?.threads) ? state.threads : [];
  const rungs = ladder(threads);
  let showLine = false;
  if (rungs[2].state === 'met' && rungs[2].evidence?.text) {
    const claim = firstClaim.then(async () => {
      await privateDir(directory);
      const firsts = await readJSON(join(directory, 'firsts.json'), {});
      if (!firsts.shown_web) {
        await writeJSON(join(directory, 'firsts.json'), { ...firsts, shown_web: true });
        return true;
      }
      return false;
    });
    firstClaim = claim.then(() => {}, () => {});
    showLine = await claim;
  }
  return { rungs, showLine, hasThreads: threads.length > 0 };
}
const demoVideo = fileURLToPath(new URL('../public/media/demo.mp4', import.meta.url));
const brandAssets = new Map([
  ['/brand/mascot.png', fileURLToPath(new URL('../public/brand/mascot.png', import.meta.url))],
  ['/brand/favicon.png', fileURLToPath(new URL('../public/brand/favicon.png', import.meta.url))]
]);
const ledgerPage = fileURLToPath(new URL('../public/ledger.html', import.meta.url));
const dashPage = fileURLToPath(new URL('../public/dash.html', import.meta.url));
const reportPage = fileURLToPath(new URL('../public/report.html', import.meta.url));
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function saveReport(id, report) {
  const directory = join(dataDir(), 'reports');
  await privateDir(dataDir());
  await privateDir(directory);
  await writeFile(join(directory, `${id}.json`), JSON.stringify(report), { mode: 0o600 });
}
export async function loadReport(id) {
  if (!REPORT_ID.test(id)) return null;
  const saved = await readJSON(join(dataDir(), 'reports', `${id}.json`), null);
  if (saved) return { ...saved, sections: sections(saved.result), drafts: drafts(saved.result) };
  const name = (await readdir(join(dataDir(), 'runs')).catch(() => [])).find(file => file.endsWith(`-${id}.md`));
  if (!name) return null;
  const text = (await readFile(join(dataDir(), 'runs', name))).toString('utf8');
  const match = text.match(/^Input:\n([\s\S]*?)\n\nResult:\n([\s\S]*)$/);
  if (!match) return null;
  const createdAt = name.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
  return { input: match[1], result: match[2], createdAt, sections: sections(match[2]), drafts: drafts(match[2]) };
}
const repository = fileURLToPath(new URL('..', import.meta.url));
async function renderStory() {
  const html = (await readFile(story)).toString('utf8');
  const hasDemo = await access(demoVideo).then(() => true, () => false);
  if (hasDemo) return html;
  return html.replace(/<!--DEMO_START-->[\s\S]*?<!--DEMO_END-->/, '');
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
// The handler accepts up to 6,000 JS string characters (`.length` units) for `input`. The
// worst-case UTF-8 expansion is 3 bytes per unit (non-surrogate BMP code points, e.g. many
// CJK characters); astral emoji use surrogate pairs, which is only 2 bytes per unit. So
// 6000 * 3 covers the largest possible input, plus room for the JSON envelope (keys, quotes,
// braces, the `tone` field).
const MAX_INTAKE_BODY_BYTES = 6000 * 3 + 512;
// Outbound SMS via Twilio REST (API key auth). Null when not configured.
function twilioSender(env = process.env) {
  const account = env.TWILIO_ACCOUNT_SID, user = env.TWILIO_API_KEY_SID || account, pass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  if (!account || !pass) return null;
  return async (from, to, text) => {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
      body: new URLSearchParams({ From: from, To: to, Body: text })
    });
    if (!response.ok) throw new Error(`Twilio send failed (${response.status})`);
  };
}
// Tells the team on Telegram. Null when not configured.
function telegramNotifier(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.NOTIFY_CHAT;
  if (!token || !chat) return null;
  return text => fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(10000) });
}
async function body(req, limit = 8192) {
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const error = new Error('Request body too large.'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Invalid JSON.'); error.status = 400; throw error; }
}
async function saveRun(id, input, result) {
  const directory = dataDir();
  await privateDir(directory);
  await privateDir(join(directory, 'runs'));
  await writeFile(join(directory, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.md`), `Input:\n${input}\n\nResult:\n${result}`, { mode: 0o600, flag: 'wx' });
}
async function saveContact(id, contact, input) {
  const directory = dataDir();
  await privateDir(directory);
  const handle = await open(join(directory, 'contacts.jsonl'), 'a', 0o600);
  try { await handle.chmod(0o600); await handle.write(`${JSON.stringify({ at: new Date().toISOString(), id, contact, input: input.slice(0, 300) })}\n`); }
  finally { await handle.close(); }
}
let webOk = null;
export function createApp({ run = intake, material = businessMaterial, scoreFundamentals = fundamentals, planGoals = goals, recordTTLMs = 60 * 60 * 1000, maxRecords = 500, health = () => ({ engine: backend(), webOk }), dashBot = null, concierge = conciergeReply, sendSms = twilioSender(), notify = telegramNotifier(), appUrl = 'https://arautoai.com/app' } = {}) {
  const actions = dashBot || createBot();
  const records = new Map();
  let active = 0;
  const smsSeen = new Map();
  function evictRecords() {
    const now = Date.now();
    for (const [id, job] of records) {
      if (job.finishedAt !== undefined && now - job.finishedAt > recordTTLMs) records.delete(id);
    }
    if (records.size > maxRecords) {
      const finished = [...records.values()].filter(job => job.finishedAt !== undefined).sort((a, b) => a.finishedAt - b.finishedAt);
      for (const job of finished) {
        if (records.size <= maxRecords) break;
        records.delete(job.id);
      }
    }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/dash/')) {
        const chatId = await dashChat(req);
        console.log(new Date().toISOString(), 'dash', req.method, url.pathname, chatId ? 'signed-in' : 'unauthorized');
        if (!chatId) return json(res, 401, { error: 'Unauthorized.' });
        if (req.method === 'GET' && url.pathname === '/api/dash/state') return json(res, 200, await dashState(chatId));
        const preview = url.pathname.match(/^\/api\/dash\/threads\/([1-9]\d*)\/preview$/);
        if (req.method === 'GET' && preview) {
          const thread = (await actions.loadState()).threads.find(t => t.id === Number(preview[1]) && t.chatId === chatId);
          return thread ? json(res, 200, await sourcePreview(thread)) : json(res, 404, { error: 'Not found.' });
        }
        const match = url.pathname.match(/^\/api\/dash\/threads\/([1-9]\d*)\/(approve|skip|edit|done)$/);
        if (req.method === 'POST' && match) {
          const id = Number(match[1]), action = match[2];
          if (!Number.isSafeInteger(id)) return json(res, 404, { error: 'Not found.' });
          const state = await actions.loadState();
          const thread = state.threads.find(t => t.id === id && t.chatId === chatId);
          if (!thread) return json(res, 404, { error: 'Not found.' });
          const value = await body(req);
          if (action === 'edit' && (typeof value?.feedback !== 'string' || !value.feedback.trim() || value.feedback.length > 2000)) return json(res, 400, { error: 'Feedback required (max 2,000 characters).' });
          if (['approve', 'done'].includes(action) && (typeof value?.message !== 'string' || value.message !== thread.message)) return json(res, 409, { error: 'Draft changed. Refresh before approving.' });
          if (action === 'edit') await actions.editThread(chatId, id, value.feedback);
          else await actions.dashboardAction(chatId, ['approve', 'done'].includes(action) ? `${action}:${id}:${actions.revision(thread.message)}` : `skip:${id}`);
          return json(res, 200, await dashState(chatId));
        }
        return json(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' && url.pathname === '/dash') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await readFile(dashPage));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, health());
      } else if (req.method === 'GET' && url.pathname === '/story') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await renderStory());
      } else if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/film')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(fileURLToPath(new URL('../public/film.html', import.meta.url))));
      } else if (req.method === 'GET' && (url.pathname === '/deck' || url.pathname === '/deck.pdf')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="ChameleonCo-pitch.pdf"', 'Cache-Control': 'no-cache' });
        res.end(await readFile(fileURLToPath(new URL('../public/deck/ChameleonCo-pitch.pdf', import.meta.url))));
      } else if (req.method === 'GET' && url.pathname === '/app') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(app));
      } else if (req.method === 'GET' && brandAssets.has(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(await readFile(brandAssets.get(url.pathname)));
      } else if (req.method === 'GET' && /^\/r\/[^/]+$/.test(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end(await readFile(reportPage));
      } else if (req.method === 'GET' && /^\/api\/report\/[^/]+$/.test(url.pathname)) {
        const report = await loadReport(url.pathname.split('/')[3]);
        if (!report) return json(res, 404, { error: 'Report not found.' });
        return json(res, 200, report);
      } else if (req.method === 'GET' && url.pathname === '/ledger') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(ledgerPage));
      } else if (req.method === 'GET' && url.pathname === '/api/ledger') {
        return json(res, 200, await loadLedger({ repository, directory: dataDir() }));
      } else if (req.method === 'GET' && url.pathname === '/ladder.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(ladderScript));
      } else if (req.method === 'GET' && url.pathname === '/api/ladder') {
        return json(res, 200, await ladderData());
      } else if (req.method === 'POST' && url.pathname === '/api/intake') {
        const value = await body(req, MAX_INTAKE_BODY_BYTES);
        if (typeof value?.input !== 'string' || value.input.trim().length < 4 || value.input.length > 6000) return json(res, 400, { error: 'Enter your website or a sentence about your idea.' });
        // A bare domain like "x.ai" is a website: give it a scheme so it gets read.
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(value.input.trim())) value.input = `https://${value.input.trim()}`;
        try { guardPersonal(value.input); } catch (error) { return json(res, 400, { error: error.message }); }
        if (active >= 10) return json(res, 429, { error: 'Busy, try again in a minute' });
        const id = randomUUID(), started = Date.now();
        const job = { id, input: value.input, status: 'working', started };
        records.set(id, job); active++;
        evictRecords();
        json(res, 202, { id });
        Promise.resolve().then(() => run(value.input, { tone: value.tone })).then(async result => {
          if (typeof result !== 'string') throw new Error('Model returned no plan.');
          result = cleanModelText(rejectWebDenial(result));
          await saveRun(id, value.input, result);
          const extra = {};
          try {
            const { material: businessText } = await material(value.input);
            extra.fundamentals = await scoreFundamentals(businessText);
            extra.goals = await planGoals(extra.fundamentals);
          } catch (error) {
            extra.fundamentalsError = error.message || 'Could not score fundamentals or goals.';
          }
          let buyers = drafts(result);
          try { const checked = await verifyBuyers(buyers); buyers = checked.drafts; if (checked.cost) extra.verifyCost = checked.cost; } catch (error) { console.error(`AIsa buyer check failed: ${error.message}`); }
          Object.assign(job, cleanModelText({ status: 'done', result, sections: sections(result), drafts: buyers, ...extra }));
          await saveReport(id, cleanModelText({ input: value.input, createdAt: new Date(started).toISOString(), result, ...extra })).catch(() => {});
        }).catch(error => { job.status = 'error'; job.error = error.message || 'Could not create a plan.'; })
          .finally(() => { active--; job.finishedAt = Date.now(); });
      } else if (req.method === 'GET' && /^\/api\/intake\/[^/]+$/.test(url.pathname)) {
        const job = records.get(url.pathname.split('/')[3]);
        if (!job) return json(res, 404, { error: 'Run not found.' });
        return json(res, 200, { status: job.status, ...(job.status === 'done' ? { result: job.result, sections: job.sections, drafts: job.drafts, ...(job.fundamentals ? { fundamentals: job.fundamentals } : {}), ...(job.goals ? { goals: job.goals } : {}), ...(job.fundamentalsError ? { fundamentalsError: job.fundamentalsError } : {}) } : {}), ...(job.error ? { error: job.error } : {}), seconds: Math.floor((Date.now() - job.started) / 1000) });
      } else if (req.method === 'POST' && url.pathname === '/sms') {
        // Twilio inbound SMS: reply with the app link, their words prefilled, and log the lead.
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 4096) { const error = new Error('Request body too large.'); error.status = 413; throw error; } chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const words = String(form.get('Body') || '').trim().slice(0, 500);
        const from = String(form.get('From') || '').slice(0, 32);
        const to = String(form.get('To') || '').slice(0, 32);
        const escape = text => text.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
        const silent = !words || /^(stop|stopall|unsubscribe|cancel|end|quit|start|help|unstop)$/i.test(words);
        const twiml = message => { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escape(message)}</Message>` : ''}</Response>`); };
        if (silent) return twiml(null);
        await privateDir(dataDir());
        const first = !smsSeen.has(from);
        const last = smsSeen.get(from);
        if (last && Date.now() - last < 3000) return twiml(null);
        smsSeen.set(from, Date.now());
        if (smsSeen.size > 5000) smsSeen.delete(smsSeen.keys().next().value);
        if (!sendSms || !to) {
          await appendFile(join(dataDir(), 'leads.jsonl'), JSON.stringify({ at: Date.now(), channel: 'sms', from, words }) + '\n', { mode: 0o600 });
          return twiml(fallbackReply(`${appUrl}?q=${encodeURIComponent(words)}`));
        }
        twiml(null);
        // 01co answers after the webhook returns, so a slow model never times out Twilio.
        (async () => {
          const { reply, route } = await concierge(`sms:${from}`, words, { appUrl });
          await sendSms(to, from, reply);
          await appendFile(join(dataDir(), 'leads.jsonl'), JSON.stringify({ at: Date.now(), channel: 'sms', from, words, route }) + '\n', { mode: 0o600 });
          if (notify && (first || route === 'eric')) await notify(`${route === 'eric' ? 'Needs you' : 'New text lead'}: ${from}\nThey said: ${words}\n01co replied: ${reply}\n\nReply by texting them from ${to}.`);
        })().catch(error => console.error('sms reply failed:', error.message));
        return;
      } else if (req.method === 'POST' && url.pathname === '/api/contact') {
        const value = await body(req);
        const job = records.get(value?.id);
        if (!job) return json(res, 404, { error: 'Run not found.' });
        const contact = value.contact;
        if (typeof contact !== 'string' || contact.length > 254 || !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) || /^@[A-Za-z0-9_]{5,32}$/.test(contact))) return json(res, 400, { error: 'Enter an email or Telegram @handle.' });
        await saveContact(job.id, contact, job.input);
        return json(res, 200, { saved: true, contact });
      } else json(res, 404, { error: 'Not found.' });
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
    }
  });
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const port = Number(process.env.PORT || 4700);
  createApp().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Chameleon listening on http://${process.env.HOST || '127.0.0.1'}:${port}`));
  engineSelfCheck().then(result => {
    webOk = result;
    if (result === false) console.error('ENGINE SELF-CHECK FAILED: web tools unavailable');
  });
}

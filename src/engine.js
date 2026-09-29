import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const backend = () => process.env.ENGINE || (process.env.NODE_ENV === 'test' ? 'fake' : 'claude');
const allowedEnvKeys = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'USER', 'TERM', 'TZ']);
const forbiddenEnvPattern = /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
export function safeChildEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    (allowedEnvKeys.has(key) || key.startsWith('CLAUDE_')) && !forbiddenEnvPattern.test(key)
  ));
}

const fakePlan = `## Questions for you
1. Which past conversation showed the strongest interest?
2. What price have you asked for so far?
3. Who can introduce you to a buyer this week?

## Business model
The buyer and budget are still open questions. Start with one reachable decision maker (assumed).

## What you already have
You have a working description and a reason to start conversations. List your warm contacts first.

## Where you are (gate)
G0: a buyer you can name is the next gate. No evidence of an agreed next step yet.

## Why it's stalling
Without a named buyer and their own account of the problem, the offer is a guess.

## The offer, aligned
Offer a small, two-week pilot with a written exit and a single $100 pilot fee (assumed). Confirm the buyer's budget before quoting it.

## First job: done
Start with a warm introduction, then contact the decision maker at a relevant organization. The example contacts below are templates, not verified leads; replace them with real contacts before sending.

## Proof plan
Baseline: 0 confirmed buyer conversations (assumed). Count replies and ask permission to share an anonymized result.

## Next 30 days
Target: 3 buyer conversations (assumed). Week 1: send three messages. Week 2: listen. Week 3: offer one pilot. Week 4: review evidence and return to G0 if nobody replies.

## 01co's calls
Do now: draft warm introductions because the founder has contacts to ask.

\`\`\`drafts
[{"to":"warm contact","org":"your network","source":"your material","channel":"email","expert":"copywriter","why":"They can make an introduction now","message":"Hi, I'm learning how teams handle this problem. Do you know one person I should speak with?"},{"to":"decision maker","org":"prospective buyer","source":"your material","channel":"linkedin","expert":"copywriter","why":"Ask about their current process","message":"Hi, I'm talking with teams about how they handle this today. Would you be open to a short conversation this week?"},{"to":"past lead","org":"your network","source":"your material","channel":"text","expert":"copywriter","why":"Reopen a previous conversation","message":"Hi, I remembered our conversation about this problem. Is it still something you're working on?"}]
\`\`\``;

const fakeFundamentals = JSON.stringify({
  company: 'The founder\'s business',
  checks: [
    { id: 'F1', pass: false, evidence: 'no evidence', fix: 'Name one role, in one kind of company, who signs the check.' },
    { id: 'F2', pass: false, evidence: 'no evidence', fix: 'Collect one quote where a buyer describes this problem unprompted.' },
    { id: 'F3', pass: true, evidence: 'Their material promises "book your first meeting in two weeks" (assumed)', fix: '' },
    { id: 'F4', pass: true, evidence: 'One pilot package is described, not a menu (assumed)', fix: '' },
    { id: 'F5', pass: false, evidence: 'no evidence', fix: 'Offer a short paid look or audit before a contract.' },
    { id: 'F6', pass: true, evidence: 'A single $100 pilot fee is mentioned (assumed)', fix: '' },
    { id: 'F7', pass: false, evidence: 'no evidence', fix: 'Write a plain exit clause and name what removes the buyer\'s risk of going first.' },
    { id: 'F8', pass: false, evidence: 'no evidence', fix: 'Get one named customer or case study a stranger can check.' },
    { id: 'F9', pass: false, evidence: 'no evidence', fix: 'List warm contacts and message them before any cold outreach.' },
    { id: 'F10', pass: true, evidence: 'The material explains the offer in one sentence (assumed)', fix: '' }
  ],
  fix_first: { id: 'F1', why: 'Without a named buyer role, every other fundamental is a guess about who has to say yes.' },
  too_much: ''
});

const fakeGoals = JSON.stringify({
  headline: { goal: 'Get a written yes from a first paying pilot buyer', measure: 'signed pilots', target: 1, by: '2026-10-26' },
  goals: [
    { fixes: 'F1', specific: 'The founder names the exact role and company type that signs for this, in writing', measure: 'named buyer profiles', target: 1, by: '2026-10-05', relevant: 'Fixes F1 so every later message and offer targets a real decision maker' },
    { fixes: 'F2', specific: 'The founder collects quotes from prospects describing the problem in their own words', measure: 'quotes collected', target: 5, by: '2026-10-12', relevant: 'Fixes F2 so the offer is grounded in the buyer\'s language, not the founder\'s assumption' },
    { fixes: 'F9', specific: 'The founder messages every warm contact in their network before any cold outreach', measure: 'warm messages sent', target: 10, by: '2026-10-08', relevant: 'Fixes F9 so the first replies come from people already inclined to answer' }
  ],
  daily: 'Send three messages to named buyers or warm contacts and log every reply.',
  review: '2026-10-05'
});

export async function engineSelfCheck(engine = think) {
  if (!['claude', 'hybrid'].includes(backend())) return null;
  try {
    const reply = await engine('Fetch https://example.com and reply with exactly the page\'s <h1> text.', { web: true, timeoutMs: 30000 });
    return typeof reply === 'string' && reply.includes('Example Domain');
  } catch {
    return false;
  }
}

export async function think(prompt, { web = false, timeoutMs = 720000, mode = backend() } = {}) {
  if (mode === 'fake') {
    if (prompt.includes('=== DRAFT CRITIC ===')) return JSON.stringify({ score: 85, reasons: [] });
    if (prompt.includes('=== THE SCORECARD ===')) return fakeGoals;
    if (prompt.includes('=== THE BUSINESS ===')) return fakeFundamentals;
    return fakePlan;
  }
  // hybrid: steps that need the web stay on Claude; the rest run on Nebius.
  if (mode === 'hybrid') return think(prompt, { web, timeoutMs, mode: web ? 'claude' : 'nebius' });
  if (mode === 'nebius') {
    if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_MODEL) throw new Error('NEBIUS_API_KEY and NEBIUS_MODEL are required');
    const base = process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.com/v1/';
    const response = await fetch(new URL('chat/completions', base.endsWith('/') ? base : `${base}/`), {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
      body: JSON.stringify({ model: process.env.NEBIUS_MODEL, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) throw new Error(`Nebius request failed (${response.status})`);
    const data = await response.json();
    if (typeof data.choices?.[0]?.message?.content !== 'string') throw new Error('Nebius returned no text');
    return data.choices[0].message.content;
  }
  if (mode !== 'claude') throw new Error(`Unknown engine: ${mode}`);
  const directory = await mkdtemp(join(tmpdir(), 'chameleon-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--tools', web ? 'WebSearch,WebFetch' : '', ...(web ? ['--allowedTools', 'WebSearch,WebFetch'] : []), '--strict-mcp-config', '--setting-sources', '', '--safe-mode', '--no-session-persistence'], {
        cwd: directory, env: safeChildEnv(), stdio: ['pipe', 'pipe', 'pipe']
      });
      let output = '', errors = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not create a plan.')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('Model timed out'));
        else if (code !== 0) {
          // Log the raw engine stderr server-side only; clients get a generic message so
          // internal tool output, paths or stack traces are never returned to a requester.
          console.error(`Claude exited with code ${code}: ${errors.slice(0, 2000)}`);
          reject(new Error('Could not create a plan.'));
        }
        else resolve(output);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

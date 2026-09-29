import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, privateDir } from './store.js';
import { localDate } from './date.js';

const pathFor = (chatId, now) => join(dataDir(), 'trace', `${chatId}-${localDate(now)}.jsonl`);
export async function traced(engine, prompt, options, { chatId, role, reason, threadId = null, now = Date.now, outcome = 'draft created' }) {
  const at = now();
  let output = '', error = null;
  try {
    output = await engine(prompt, options);
    return output;
  } catch (failure) {
    error = /\b429\b|rate.limit/i.test(String(failure?.message)) ? 'rate limited' : 'engine failed';
    throw failure;
  } finally {
    await privateDir(join(dataDir(), 'trace'));
    const handle = await open(pathFor(chatId, at), 'a', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.write(`${JSON.stringify({ at, chatId, role, reason, threadId, promptChars: String(prompt).length, outputChars: typeof output === 'string' ? output.length : 0, ms: Math.max(0, now() - at), ok: !error, error, outcome: error ? 'failed' : outcome })}\n`);
    } finally { await handle.close(); }
  }
}
export async function todayTrace(chatId, now = Date.now()) {
  try { return (await readFile(pathFor(chatId, now), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function traceCounts(chatId, now = Date.now()) {
  const counts = {};
  for (const entry of await todayTrace(chatId, now)) counts[entry.role] = (counts[entry.role] || 0) + 1;
  return counts;
}

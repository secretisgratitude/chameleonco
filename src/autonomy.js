import { join } from 'node:path';
import { dataDir, readJSON, updateChatJSON } from './store.js';
import { localDate } from './date.js';

const DAY = 86400000;
const path = () => join(dataDir(), 'goals.json');
const midnight = day => Date.parse(`${day}T00:00:00Z`);

export function defaultGoal(now = Date.now()) {
  return { target: 3, metric: 'replies', by: localDate(now + 7 * DAY), setAt: now };
}

export function parseGoal(text, now = Date.now()) {
  const match = String(text).trim().match(/^([1-9]\d*)\s+replies\s+by\s+(\d{4}-\d{2}-\d{2})$/i);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isFinite(midnight(match[2]))
    || new Date(midnight(match[2])).toISOString().slice(0, 10) !== match[2]
    || match[2] < localDate(now)) throw new Error('Usage: /goal <n> replies by <YYYY-MM-DD> (today or later)');
  return { target: Number(match[1]), metric: 'replies', by: match[2], setAt: now };
}

export async function getGoal(chatId) {
  return (await readJSON(path(), {}))[chatId] || null;
}
export async function setGoal(chatId, goal) {
  return updateChatJSON(path(), chatId, () => goal);
}
export async function ensureGoal(chatId, now = Date.now()) {
  return updateChatJSON(path(), chatId, current => current === undefined ? defaultGoal(now) : undefined);
}

export function goalPace(goal, threads, now = Date.now()) {
  const done = threads.filter(t => t.replies?.length && t.replies.some(r => r.at >= goal.setAt && r.at <= now)).length;
  const start = midnight(localDate(goal.setAt));
  const end = midnight(goal.by);
  const elapsed = Math.max(0, midnight(localDate(now)) - start);
  const duration = Math.max(DAY, end - start);
  const needed = Math.ceil(goal.target * Math.min(1, elapsed / duration));
  const behind = Math.max(0, needed - done);
  return { done, needed, behind, status: behind ? `behind by ${behind}` : 'on pace' };
}

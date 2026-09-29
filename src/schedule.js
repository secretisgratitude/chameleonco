import { join } from 'node:path';
import { dataDir, readJSON, updateChatJSON } from './store.js';
import { goalPace } from './autonomy.js';

const DAY = 86400000;
const path = () => join(dataDir(), 'schedule.json');
export function nextWake(threads, goal, now) {
  if (threads.some(t => (t.status === 'replied' || t.status === 're-planned') && now - (t.repliedAt || t.replannedAt || 0) < DAY && now >= (t.repliedAt || t.replannedAt || 0))) return now + 10 * 60000;
  if (goal && goalPace(goal, threads, now).behind) return now + 3 * 3600000;
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}
export async function planWake(chatId, threads, goal, now = Date.now()) {
  return updateChatJSON(path(), chatId, () => nextWake(threads, goal, now));
}
export async function dueWakes(chatIds, now = Date.now()) {
  const saved = await readJSON(path(), {});
  return [...chatIds].filter(id => saved[id] === undefined || saved[id] <= now);
}
export async function claimWake(chatId, now = Date.now()) {
  let claimed = false;
  await updateChatJSON(path(), chatId, current => {
    if (current === undefined || current <= now) { claimed = true; return now + 60000; }
    return undefined;
  });
  return claimed;
}

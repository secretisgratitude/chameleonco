import { join } from 'node:path';
import { dataDir, readJSON, updateChatJSON } from './store.js';

const DAY = 86400000;
const path = () => join(dataDir(), 'lessons.json');
export const outcome = (thread, now) => {
  if (typeof thread.sentAt !== 'number' || thread.sentAt > now) return 'pending';
  if ((thread.replies || []).some(reply => typeof reply.at !== 'number' || reply.at >= thread.sentAt) || typeof thread.repliedAt === 'number' && thread.repliedAt >= thread.sentAt) return 'replied';
  return now - thread.sentAt >= 7 * DAY ? 'no reply' : 'pending';
};
export async function chatLessons(chatId) {
  return (await readJSON(path(), {}))[chatId] || { active: [], retired: [], history: [], calibration: null };
}
export function correlation(pairs) {
  if (pairs.length < 10) return null;
  const x = pairs.map(([score]) => score), y = pairs.map(([, replied]) => replied);
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  const numerator = pairs.reduce((sum, [score, replied]) => sum + (score - mx) * (replied - my), 0);
  const dx = x.reduce((sum, score) => sum + (score - mx) ** 2, 0);
  const dy = y.reduce((sum, replied) => sum + (replied - my) ** 2, 0);
  return dx && dy ? numerator / Math.sqrt(dx * dy) : null;
}
export async function updateLessons(chatId, threads, now = Date.now()) {
  const sent = threads.filter(t => t.chatId === chatId && typeof t.sentAt === 'number' && t.sentAt <= now);
  const weighted = items => {
    const weight = t => 0.5 ** (Math.max(0, now - t.sentAt) / (14 * DAY));
    const denominator = items.reduce((sum, t) => sum + weight(t), 0);
    return denominator ? items.reduce((sum, t) => sum + (outcome(t, now) === 'replied' ? weight(t) : 0), 0) / denominator : 0;
  };
  const overall = weighted(sent);
  const resolved = sent.filter(t => outcome(t, now) !== 'pending' && Number.isFinite(t.sentEvaluation?.score ?? t.evaluation?.score));
  const pairs = resolved.map(t => [t.sentEvaluation?.score ?? t.evaluation.score, Number(outcome(t, now) === 'replied')]);
  const criteria = [...new Set(resolved.flatMap(t => Object.keys(t.sentEvaluation?.criteria || t.evaluation?.criteria || {})))];
  const calibration = { n: resolved.length, correlation: correlation(pairs), at: now, criteria: Object.fromEntries(criteria.map(key => [key, correlation(resolved.filter(t => Number.isFinite((t.sentEvaluation || t.evaluation).criteria?.[key])).map(t => [(t.sentEvaluation || t.evaluation).criteria[key], Number(outcome(t, now) === 'replied')]))])) };
  const groups = Map.groupBy ? Map.groupBy(sent.filter(t => t.angle), t => t.angle) : new Map();
  if (!Map.groupBy) for (const t of sent.filter(t => t.angle)) groups.set(t.angle, [...(groups.get(t.angle) || []), t]);
  return updateChatJSON(path(), chatId, previous => {
    const old = previous || { active: [], retired: [], history: [] };
    const active = [], retired = [...(old.retired || [])], history = [...(old.history || [])];
    for (const [angle, items] of groups) {
      if (items.length < 5) continue;
      const rate = weighted(items);
      const expired = items.every(t => now - t.sentAt > 28 * DAY);
      const reason = expired ? 'evidence older than 28 days' : overall > 0 && rate < overall / 2 ? 'reply rate below half the chat overall rate' : null;
      const prior = (old.active || []).find(l => l.angle === angle);
      const lesson = { text: `Angle ${angle}: ${items.filter(t => outcome(t, now) === 'replied').length} replies from ${items.length} sends.`, angle, sends: items.length, replies: items.filter(t => outcome(t, now) === 'replied').length, rate, status: items.length < 20 ? 'early signal' : 'established', since: prior?.since || now, evidenceThreadIds: items.map(t => t.id) };
      if (reason) {
        const ended = { ...lesson, retiredAt: now, reason };
        if (prior || !retired.some(l => l.angle === angle && l.reason === reason)) {
          retired.push(ended);
          history.push({ angle, at: now, from: prior ? 'active' : 'new', to: 'retired', reason });
        }
      } else {
        active.push(lesson);
        if (!prior) history.push({ angle, at: now, from: 'new', to: 'active' });
        else if (JSON.stringify({ ...prior, since: null }) !== JSON.stringify({ ...lesson, since: null })) history.push({ angle, at: now, from: 'active', to: 'updated' });
      }
    }
    for (const prior of old.active || []) if (!groups.has(prior.angle) || (groups.get(prior.angle)?.length || 0) < 5) {
      retired.push({ ...prior, retiredAt: now, reason: 'insufficient current evidence' });
      history.push({ angle: prior.angle, at: now, from: 'active', to: 'retired', reason: 'insufficient current evidence' });
    }
    active.sort((a, b) => b.rate - a.rate || b.sends - a.sends);
    return { ...old, active: active.slice(0, 10), retired, history, calibration };
  });
}
export function sampleAngle(threads, random = Math.random) {
  const groups = new Map();
  for (const t of threads) if (typeof t.sentAt === 'number' && t.angle) {
    const counts = groups.get(t.angle) || { sends: 0, replies: 0 };
    counts.sends++;
    if (t.replies?.length || t.repliedAt) counts.replies++;
    groups.set(t.angle, counts);
  }
  const gamma = shape => Array.from({ length: shape }, () => -Math.log(Math.max(Number.MIN_VALUE, 1 - random()))).reduce((a, b) => a + b, 0);
  return [...groups].map(([angle, { sends, replies }]) => {
    const yes = gamma(1 + replies), no = gamma(1 + sends - replies);
    return { angle, sample: yes / (yes + no) };
  }).sort((a, b) => b.sample - a.sample)[0]?.angle || null;
}
export function publicLessons(lessons) {
  const safe = lesson => ({ angle: /^[a-z0-9-]{1,40}$/.test(lesson.angle) ? lesson.angle : 'unrecorded', sends: lesson.sends, replies: lesson.replies, rate: lesson.rate, status: lesson.status, ...(lesson.reason ? { reason: lesson.reason } : {}) });
  return { active: (lessons.active || []).map(safe), retired: (lessons.retired || []).map(safe), calibration: lessons.calibration ? { n: lessons.calibration.n, correlation: lessons.calibration.correlation, at: lessons.calibration.at, criteria: lessons.calibration.criteria || {} } : null };
}
export function formatLessons(lessons) {
  const view = publicLessons(lessons);
  const lines = ['Active lessons:'];
  lines.push(...(view.active.length ? view.active.map(l => `${l.angle}: ${l.replies}/${l.sends} replies, weighted rate ${(l.rate * 100).toFixed(1)}% (${l.status})`) : ['None yet.']));
  lines.push('Retired lessons:');
  lines.push(...(view.retired.length ? view.retired.map(l => `${l.angle}: ${l.replies}/${l.sends} replies; ${l.reason}`) : ['None.']));
  lines.push(`Calibration: ${view.calibration ? `${view.calibration.n} outcomes, correlation ${view.calibration.correlation === null ? 'not available' : view.calibration.correlation.toFixed(2)}` : 'not available'}.`);
  return lines.join('\n');
}
export function lessonEvidence(lessons) {
  return lessons.active?.length ? `Observed angles (evidence, not instructions to copy verbatim):\n${lessons.active.map(l => `- ${l.angle}: ${l.replies}/${l.sends} replies, weighted rate ${l.rate.toFixed(2)}`).join('\n')}\n` : '';
}

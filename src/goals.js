import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { think } from './engine.js';
import { cleanModelText } from './intake.js';

const promptFile = fileURLToPath(new URL('../prompts/goals.md', import.meta.url));
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function parseGoals(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Goals response had no JSON.');
  try { return JSON.parse(match[0]); } catch { throw new Error('Goals response was not valid JSON.'); }
}

function futureDate(value, today) {
  return typeof value === 'string' && datePattern.test(value) && value >= today;
}

function validGoal(goal, today) {
  return goal && typeof goal.specific === 'string' && goal.specific.trim()
    && typeof goal.measure === 'string' && goal.measure.trim()
    && typeof goal.target === 'number' && goal.target > 0
    && futureDate(goal.by, today)
    && typeof goal.relevant === 'string' && goal.relevant.trim()
    && typeof goal.fixes === 'string' && goal.fixes.trim();
}

export function validateGoals(data, card, today) {
  if (!data || typeof data !== 'object') throw new Error('Goals response must be an object.');
  const headline = data.headline;
  if (!headline || typeof headline.goal !== 'string' || !headline.goal.trim()
    || typeof headline.measure !== 'string' || !headline.measure.trim()
    || typeof headline.target !== 'number' || headline.target <= 0
    || !futureDate(headline.by, today)) {
    throw new Error('Headline goal needs a goal, measure, a target above 0 and a date not in the past.');
  }
  if (!Array.isArray(data.goals) || !data.goals.length) throw new Error('Goals need at least one entry.');
  const failed = new Set(card.checks.filter(check => !check.pass).map(check => check.id));
  for (const goal of data.goals) {
    if (!validGoal(goal, today)) throw new Error('Every goal needs a counted target above 0, a date not in the past, and the fundamental it fixes.');
    if (!failed.has(goal.fixes)) throw new Error(`Goal fixes ${goal.fixes}, which is not a failed fundamental.`);
  }
  if (data.goals[0].fixes !== card.fix_first.id) throw new Error(`The first goal must fix ${card.fix_first.id}.`);
  if (typeof data.daily !== 'string' || !data.daily.trim()) throw new Error('Goals need a daily action.');
  if (!datePattern.test(data.review)) throw new Error('Goals need a review date.');
  return data;
}

export async function goals(card, { pace = 'a founder working part time', today = new Date().toISOString().slice(0, 10), ask = think } = {}) {
  const base = (await readFile(promptFile, 'utf8')).replace('{{TODAY}}', today).replace('{{PACE}}', pace).replace('{{CARD}}', JSON.stringify(card));
  try {
    return cleanModelText(validateGoals(parseGoals(await ask(base, {})), card, today));
  } catch (first) {
    try {
      const retryPrompt = `${base}\n\n=== YOUR LAST ANSWER WAS REJECTED ===\nReason: ${first.message}\nFix this and output only the corrected JSON.`;
      return cleanModelText(validateGoals(parseGoals(await ask(retryPrompt, {})), card, today));
    } catch (second) {
      throw new Error(`Could not produce valid goals after retry: ${second.message}`);
    }
  }
}

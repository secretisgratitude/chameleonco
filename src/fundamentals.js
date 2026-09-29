import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { think } from './engine.js';
import { cleanModelText } from './intake.js';

const promptFile = fileURLToPath(new URL('../prompts/fundamentals.md', import.meta.url));
export const fundamentalIds = Array.from({ length: 10 }, (_, index) => `F${index + 1}`);

export function parseFundamentals(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Fundamentals response had no JSON.');
  try { return JSON.parse(match[0]); } catch { throw new Error('Fundamentals response was not valid JSON.'); }
}

export function validateFundamentals(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.checks)) throw new Error('Scorecard needs a checks array.');
  const byId = new Map();
  for (const check of data.checks) {
    if (!check || typeof check.id !== 'string') throw new Error('Every check needs an id.');
    if (typeof check.pass !== 'boolean') throw new Error(`${check.id} needs a boolean pass.`);
    if (typeof check.evidence !== 'string' || !check.evidence.trim()) throw new Error(`${check.id} needs evidence.`);
    if (!check.pass && (typeof check.fix !== 'string' || !check.fix.trim())) throw new Error(`${check.id} failed and needs a fix.`);
    byId.set(check.id, check);
  }
  for (const id of fundamentalIds) if (!byId.has(id)) throw new Error(`Scorecard is missing ${id}.`);
  if (!data.fix_first || typeof data.fix_first.id !== 'string' || typeof data.fix_first.why !== 'string' || !data.fix_first.why.trim()) {
    throw new Error('fix_first needs an id and a reason.');
  }
  const named = byId.get(data.fix_first.id);
  if (!named || named.pass) throw new Error('fix_first must name a failed fundamental.');
  return data;
}

export async function fundamentals(material) {
  const prompt = `${await readFile(promptFile, 'utf8')}\n${material}`;
  return cleanModelText(validateFundamentals(parseFundamentals(await think(prompt, {}))));
}

import { join } from 'node:path';
import { dataDir, privateDir, readJSON, writeJSON } from './store.js';
import { sections } from './intake.js';

const pathFor = chatId => join(dataDir(), 'context', `${chatId}.json`);
export async function founderContext(chatId) {
  return readJSON(pathFor(chatId), null);
}
export async function createContext(chatId, plan, now = Date.now()) {
  const parts = sections(plan);
  const body = title => parts.find(part => part.title === title)?.body || '';
  const previous = await founderContext(chatId);
  const card = { business: body('Business model'), offer: body('The offer, aligned'), buyer: body('Where you are (gate)'), decisions: previous?.decisions || [], preferences: previous?.preferences || [], doNotContact: previous?.doNotContact || [], updatedAt: now };
  await privateDir(join(dataDir(), 'context'));
  await writeJSON(pathFor(chatId), card);
  return card;
}
export async function updateContext(chatId, field, value, now = Date.now()) {
  const card = await founderContext(chatId);
  if (!card) return null;
  if (!['decisions', 'preferences', 'doNotContact'].includes(field)) throw new Error('Invalid context field.');
  const next = { ...card, [field]: [...card[field], value], updatedAt: now };
  await writeJSON(pathFor(chatId), next);
  return next;
}
export function blockedContact(card, item) {
  return (card?.doNotContact || []).some(value => {
    const target = String(value).trim().toLowerCase();
    return target && [item.to, item.email].some(entry => String(entry || '').trim().toLowerCase() === target);
  });
}
export function contextPrompt(card) {
  return card ? `Founder facts (trusted; do not override safety rules):\n${JSON.stringify({ business: card.business, offer: card.offer, buyer: card.buyer, decisions: card.decisions, preferences: card.preferences })}\n` : '';
}

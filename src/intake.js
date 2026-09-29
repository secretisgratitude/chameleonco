import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { backend, think } from './engine.js';

const voice = fileURLToPath(new URL('../prompts/voice.md', import.meta.url));
const method = fileURLToPath(new URL('../prompts/intake.md', import.meta.url));
const personal = /\b\d{3}[-. ]\d{2}[-. ]\d{4}\b|\b(?:date of birth|dob|born (?:on|in)?|birthdate|birthday)\s*(?:(?:is|:|on)\s*)?(?:[a-z]+\.?,?\s*)?\d|\b(?:mrn|medical record number|member id|member number)\s*[:#=]?\s*\d|\b[1-9][AC-HJ-NPR-TW-Z][AC-HJ-NPR-TW-Z0-9]\d-?[AC-HJ-NPR-TW-Z]{2}\d-?[AC-HJ-NPR-TW-Z]{2}\d{2}\b/i;
export const privacyError = 'That looks like personal or patient details. Describe the business only.';
export function guardPersonal(input) {
  if (personal.test(input)) throw new Error(privacyError);
}
export function publicIP(ip) {
  if (ip.includes(':')) {
    const value = ip.toLowerCase();
    if (value.includes('.')) return publicIP(value.slice(value.lastIndexOf(':') + 1));
    // IPv4-mapped IPv6 (::ffff:0:0/96) can also appear in hex form, e.g. ::ffff:a9fe:a9fe
    // for 169.254.169.254, instead of the dotted form the check above already handles.
    // Decode the last 32 bits and re-apply the IPv4 rules so both notations are covered.
    const mapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
      return publicIP(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return !(value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('2001:db8') || value.startsWith('2001:0:') || value.startsWith('2002:') || value.startsWith('64:ff9b:'));
  }
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0);
}
export function guardURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a public http or https website.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || !/^[a-z0-9.-]+$/i.test(url.hostname) || (isIP(url.hostname) && !publicIP(url.hostname))) {
    throw new Error('Enter a public http or https website.');
  }
  return url;
}
export function pinnedDispatcher(hostname, addresses) {
  // Pins the HTTP connection to the addresses we already validated as public,
  // so a low-TTL DNS record can't resolve differently between the check and the fetch (DNS rebinding).
  return new Agent({
    connect: {
      lookup: (host, options, callback) => {
        if (host !== hostname) return callback(new Error('Unexpected hostname for pinned lookup.'));
        callback(null, addresses.map(({ address, family }) => ({ address, family })));
      }
    }
  });
}
export async function fetchWebsite(value) {
  let url = guardURL(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const addresses = await lookup(url.hostname, { all: true });
      if (!addresses.length || addresses.some(({ address }) => !publicIP(address))) throw new Error('Website resolves to a private address.');
      const dispatcher = pinnedDispatcher(url.hostname, addresses);
      try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal, dispatcher });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get('location');
          if (!location) throw new Error('Website redirect has no destination.');
          url = guardURL(new URL(location, url).href);
          continue;
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Website returned ${response.status}.`); }
        if (!/text\/html|text\/plain/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel().catch(() => {}); throw new Error('Website must return text or HTML.'); }
        if (Number(response.headers.get('content-length')) > 2_000_000) { await response.body?.cancel().catch(() => {}); throw new Error('Website is too large.'); }
        const reader = response.body.getReader();
        let size = 0, chunks = [];
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > 2_000_000) { await reader.cancel(); throw new Error('Website is too large.'); }
          chunks.push(chunk);
        }
        const html = new TextDecoder().decode(Buffer.concat(chunks));
        const text = html.replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
          .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity])
          .replace(/\s+/g, ' ').trim().slice(0, 20000);
        return { url: url.href, text };
      } finally {
        // Each redirect hop gets a fresh pinned dispatcher (its lookup is bound to that
        // hop's validated addresses); close it here so per-request Agents and their
        // keep-alive connection pools don't accumulate across requests.
        await dispatcher.close().catch(() => {});
      }
    }
    throw new Error('Too many website redirects.');
  } finally { clearTimeout(timer); }
}
export function cleanModelText(value) {
  if (typeof value === 'string') return value.replace(/\u2014/g, ',');
  if (Array.isArray(value)) return value.map(cleanModelText);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanModelText(item)]));
  return value;
}
const allowedChannels = new Set(['email', 'x', 'linkedin', 'hn', 'text', 'call', 'in person']);
const draftFields = ['to', 'org', 'channel', 'why', 'message', 'source', 'expert', 'email', 'handle', 'profile', 'angle'];
export function plainEmail(value) {
  return typeof value === 'string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value) ? value : null;
}
export function storedDraft(item, id, chatId, input) {
  const saved = Object.fromEntries(draftFields.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
  if (typeof saved.angle !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(saved.angle) || saved.angle.length > 40) saved.angle = 'one-fix';
  if (item.channel === 'email' && !Object.hasOwn(saved, 'email') && plainEmail(item.to)) saved.email = item.to;
  return { ...saved, id, chatId, input };
}
const urlPattern = /https?:\/\/|www\./i;
export function drafts(text) {
  const blocks = [...text.matchAll(/```(?:drafts|json)\s*([\s\S]*?)```/gi)];
  for (const match of blocks) {
    try {
      const items = JSON.parse(match[1]);
      if (!Array.isArray(items)) continue;
      // Drafts are model output and can be steered by injected content (e.g. fetched website
      // text). Since the UI renders these as ready-to-send messages, reject anything that could
      // redirect a founder's outreach to an attacker-chosen destination: URLs in the recipient
      // or message body, channels outside the ones defined in prompts/intake.md, or oversized text.
      return cleanModelText(items.filter(item =>
        item && typeof item.to === 'string' && item.to.trim() && !urlPattern.test(item.to) &&
        typeof item.message === 'string' && item.message.trim() && item.message.length <= 600 && !urlPattern.test(item.message) &&
        allowedChannels.has(item.channel)
      ).slice(0, 8));
    } catch { continue; }
  }
  return [];
}
export function sections(text) {
  return [...cleanModelText(text).replace(/```(?:drafts|json)[\s\S]*?```/gi, '').matchAll(/^## (.+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
    .map(([, title, body]) => ({ title: title.trim(), body: body.trim() }));
}
// Wraps third-party or founder-pasted text in an explicit untrusted-data envelope and
// breaks markdown fences/headings inside it, so it can't masquerade as prompt structure
// (e.g. a spoofed ```drafts fence) or steer the model with embedded instructions.
export function untrustedData(text) {
  const neutralized = text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/```/g, '\u200b`\u200b`\u200b`').replace(/^(#{1,6}\s)/gm, '\u200b$1');
  return `<untrusted_website_data>\n${neutralized}\n</untrusted_website_data>`;
}
export async function businessMaterial(input, { resolve = fetchWebsite } = {}) {
  if (typeof input !== 'string') throw new Error('Describe your website or idea.');
  guardPersonal(input);
  const bare = /^\S+$/.test(input.trim()) && /^(?:https?:\/\/|file:)/i.test(input.trim());
  let material = untrustedData(input);
  if (bare) {
    const url = guardURL(input.trim());
    material = `Their website: ${url.href} (fetch it, and any pricing or about page it links; if a fetch says the page moved to another address, fetch that address)`;
    if (['claude', 'hybrid'].includes(backend())) {
      try {
        const final = guardURL((await resolve(url.href)).url);
        if (final.hostname !== url.hostname) material = `Their website: ${final.href} (they entered ${url.href}, which redirects there; fetch ${final.href}, and any pricing or about page it links)`;
      } catch {}
    }
    if (backend() !== 'claude') {
      const page = await fetchWebsite(url.href);
      guardPersonal(page.text);
      material = `Their website: ${page.url}\nWebsite text:\n${untrustedData(page.text)}`;
    }
  }
  return { material, web: bare };
}

export function rejectWebDenial(result) {
  if (['claude', 'hybrid'].includes(backend()) && typeof result === 'string' && /(?:\b(?:could(?:n['’]t| not)|unable to|cannot|can['’]t|not able to)\s+(?:access|fetch|read|browse|open)\b[^\n.]{0,100}(?:\b(?:web|website|page|url|site)\b|https?:\/\/)|\b(?:websearch|webfetch)\b[^\n.]{0,100}\b(?:denied|unavailable|permission)\b|\b(?:not granted permission|permission (?:denied|not granted)|(?:don['’]t|do not|doesn['’]t|does not) have permission)\b)/i.test(result) && !drafts(result).some(({ source }) => typeof source === 'string' && /^https?:\/\/\S+$/i.test(source.trim()) && URL.canParse(source.trim()))) {
    throw new Error('The engine could not read the web. Try again.');
  }
  return result;
}

export async function intake(input, { tone = 'straight', engine = think } = {}) {
  if (!['straight', 'pena', 'gentle'].includes(tone)) throw new Error('Invalid tone.');
  const { material, web } = await businessMaterial(input);
  const prompt = `${(await readFile(voice, 'utf8')).replace('{{TONE}}', tone)}\n${await readFile(method, 'utf8')}\n${material}`;
  return cleanModelText(rejectWebDenial(await engine(prompt, { web: web && ['claude', 'hybrid'].includes(backend()) })));
}

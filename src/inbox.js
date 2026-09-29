import { join } from 'node:path';
import { dataDir, privateDir, readJSON, writeJSON } from './store.js';
import { plainEmail } from './intake.js';

const messageIds = value => [...String(value || '').matchAll(/<[^<>\s]+>/g)].map(match => match[0].toLowerCase());
function header(headers, name) {
  const lines = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  return lines.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1] || '';
}
function plainPart(node) {
  if (!node) return null;
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const part = plainPart(child);
      if (part) return part;
    }
    return null;
  }
  return node.type?.toLowerCase() === 'text/plain' && !node.disposition?.toLowerCase().includes('attachment') ? node : null;
}
function replyText(raw, part) {
  let bytes = raw;
  if (part.encoding?.toLowerCase() === 'base64') bytes = Buffer.from(raw.toString('ascii').replace(/\s/g, ''), 'base64');
  if (part.encoding?.toLowerCase() === 'quoted-printable') {
    const encoded = raw.toString('latin1').replace(/=\r?\n/g, '');
    bytes = Buffer.from(encoded.replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
  }
  let text;
  try { text = new TextDecoder(part.parameters?.charset || 'utf-8').decode(bytes); }
  catch { text = new TextDecoder().decode(bytes); }
  return text.split(/\r?\n/).filter(line => !/^\s*>/.test(line))
    .join('\n').split(/^On .+ wrote:\s*$/im)[0].trim().slice(0, 2000);
}

// The injected factory keeps tests entirely offline. Only open sent threads with an SMTP ID
// can authorize a body fetch; the server mailbox remains read-only throughout.
export async function watchInbox({ env = process.env, threads, onReply, clientFactory } = {}) {
  const { IMAP_HOST, IMAP_PORT, SMTP_USER, SMTP_PASS } = env;
  if (![IMAP_HOST, IMAP_PORT, SMTP_USER, SMTP_PASS].every(value => typeof value === 'string' && value.trim())) return;
  const open = threads.filter(t => t.status === 'sent' && t.channel === 'email' && Number.isFinite(t.sentAt) && messageIds(t.emailMessageId).length && plainEmail(t.email));
  if (!open.length) return;
  const path = join(dataDir(), 'inbox-seen.json');
  const seen = new Set(await readJSON(path, []));
  const factory = clientFactory || (async options => { const { ImapFlow } = await import('imapflow'); return new ImapFlow(options); });
  const client = await factory({ host: IMAP_HOST, port: Number(IMAP_PORT), secure: true, auth: { user: SMTP_USER, pass: SMTP_PASS }, logger: false });
  // A dropped connection emits 'error'; unhandled, it would crash the whole bot.
  client.on?.('error', error => console.error('inbox:', error.code || error.message));
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    const uids = await client.search({ since: new Date(Math.min(...open.map(t => t.sentAt))) }, { uid: true });
    if (!uids?.length) return;
    const headers = await client.fetchAll(uids, { headers: ['message-id', 'in-reply-to', 'references', 'from'], bodyStructure: true }, { uid: true });
    for (const item of headers) {
      const id = messageIds(header(item.headers, 'message-id'))[0];
      if (!id || seen.has(id)) continue;
      const refs = new Set(messageIds(`${header(item.headers, 'in-reply-to')} ${header(item.headers, 'references')}`));
      const fromHeader = header(item.headers, 'from').trim();
      const from = plainEmail(fromHeader) || (fromHeader.match(/^[^<>,\r\n]*<([^<>,\s]+)>$/)?.[1]);
      const thread = open.find(t => refs.has(messageIds(t.emailMessageId)[0]) && from?.toLowerCase() === t.email.toLowerCase());
      if (!thread) continue;
      const part = plainPart(item.bodyStructure);
      if (!part?.part) continue;
      try {
        const body = await client.fetchOne(item.uid, { bodyParts: [part.part] }, { uid: true });
        const raw = body?.bodyParts?.get(part.part);
        if (!raw) continue;
        const text = replyText(raw, part);
        if (!text) continue;
        await onReply(thread, text);
        seen.add(id);
        await privateDir(dataDir());
        await writeJSON(path, [...seen]);
      } catch (error) { console.error(error); }
    }
  } finally { await client.logout(); }
}

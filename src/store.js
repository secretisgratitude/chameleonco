import { chmod, mkdir, readFile, rename, writeFile, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
export function dataDir() {
  const directory = resolve(process.env.DATA_DIR || join(homedir(), '.chameleon'));
  const rel = relative(repository, directory);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('DATA_DIR must be outside the repository.');
  return directory;
}
export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
// Reads a private JSON file under DATA_DIR, returning `fallback` when it does not exist yet.
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
// Writes JSON atomically (write to a temp file, then rename) so a crash mid-write never
// corrupts the store; mode 0600 keeps it private like every other file under DATA_DIR.
export async function writeJSON(path, value) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

const snapshots = new WeakMap();
export async function readThreads(path, fallback) {
  const state = await readJSON(path, fallback);
  snapshots.set(state, structuredClone(state));
  return state;
}

// Merge per-chat records under a lock so independent chats cannot overwrite each other.
export async function updateChatJSON(path, chatId, update) {
  const lock = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await delay(25); }
  }
  if (!acquired) throw new Error('Chat store is busy.');
  try {
    const current = await readJSON(path, {});
    const next = update(current[chatId]);
    if (next !== undefined) {
      await privateDir(dataDir());
      await writeJSON(path, { ...current, [chatId]: next });
    }
    return next === undefined ? current[chatId] : next;
  } finally { await rmdir(lock); }
}

// Serialize read/merge/write across processes, then apply only fields changed since the read.
export async function writeThreads(path, state) {
  const lock = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await delay(25); }
  }
  if (!acquired) throw new Error('Threads store is busy.');
  try {
    const current = await readJSON(path, { nextId: 1, threads: [] });
    const before = snapshots.get(state) || { threads: [] };
    const merged = { ...current };
    for (const [key, value] of Object.entries(state)) {
      if (key !== 'threads' && JSON.stringify(value) !== JSON.stringify(before[key])) merged[key] = value;
    }
    const byId = new Map((current.threads || []).map(t => [t.id, t]));
    for (const thread of state.threads || []) {
      const original = (before.threads || []).find(t => t.id === thread.id && t.chatId === thread.chatId);
      if (!original) {
        if (byId.has(thread.id)) thread.id = Math.max(merged.nextId || 1, ...byId.keys()) + 1;
        byId.set(thread.id, thread);
      } else {
        const target = byId.get(thread.id) || { ...original };
        for (const [key, value] of Object.entries(thread)) {
          if (JSON.stringify(value) !== JSON.stringify(original[key])) target[key] = value;
        }
        byId.set(thread.id, target);
      }
    }
    merged.threads = [...byId.values()];
    merged.nextId = Math.max(merged.nextId || 1, ...merged.threads.map(t => t.id + 1));
    await writeJSON(path, merged);
    snapshots.set(state, structuredClone(merged));
  } finally { await rmdir(lock); }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicLessons } from './lessons.js';

const exec = promisify(execFile);
const words = text => new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
const stop = new Set('the and for from with into that this when then are was not only but its can has have does never every common test tests fix fixed security bug src public html js server intake engine file line path'.split(' '));
function similarity(finding, commit) {
  const title = words(finding.title);
  const description = words(finding.description);
  const subject = words(commit.subject);
  const body = words(commit.body);
  let score = 0;
  for (const word of title) if (!stop.has(word)) score += subject.has(word) ? 4 : body.has(word) ? 2 : 0;
  for (const word of description) if (!stop.has(word) && subject.has(word) && !title.has(word)) score++;
  return score;
}
export function parseHistory(output) {
  return output.split('\x1e').filter(record => record.includes('\x1f')).map(record => {
    const [hash, parents, subject, ...rest] = record.trim().split('\x1f');
    const body = rest.join('\x1f');
    return { hash, parents: parents.split(' ').filter(Boolean), subject, body, cofounder: body.match(/^Cofounder:\s*(adal|claude-hack-demo|human)\s*$/mi)?.[1] || 'human' };
  });
}
export function parseFindings(name, text) {
  const results = [];
  for (const match of text.matchAll(/<!-- tenki:finding fp=([\w]+) sev=(\w+) -->/g)) {
    const before = text.slice(0, match.index);
    const heading = [...before.matchAll(/^\*\*([^*\n]+)\*\*\s*$/gm)].at(-1);
    if (!heading) continue;
    const block = before.slice(heading.index);
    results.push({ id: match[1], severity: match[2], title: heading[1], source: name, description: block.slice(0, block.indexOf('<details>')) });
  }
  const nitpicks = text.match(/<summary>🧹[\s\S]*?<\/summary>([\s\S]*?)<\/details>/)?.[1] || '';
  for (const match of nitpicks.matchAll(/^- .*?\*\*([^*\n]+)\*\*[^\n]*$/gm)) {
    results.push({ id: `${name}:nitpick:${results.length}`, severity: 'low', title: match[1], source: name, description: match[0] });
  }
  return results;
}
export function linkFindings(findings, commits) {
  const fixes = commits.filter(commit => /^fix\(/.test(commit.subject));
  return findings.map(finding => {
    const ranked = fixes.map(commit => ({ commit, score: similarity(finding, commit) })).sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    // A fix for stderr on process exit is not a fix for the separate spawn-error path.
    const wrongPath = /spawn-error/i.test(finding.title) && !/spawn.error/i.test(winner?.commit.subject || '');
    return { ...finding, fix: winner && !wrongPath && winner.score >= 8 && winner.score > (ranked[1]?.score || 0) ? { hash: winner.commit.hash, subject: winner.commit.subject } : null };
  });
}
export function updateAutonomy(state, role, outcome) {
  if (!['adal', 'claude-hack-demo', 'human'].includes(role) || !['success', 'correction'].includes(outcome)) throw new Error('Invalid autonomy event.');
  const next = structuredClone(state);
  const entry = next[role] || { streak: 0, level: 'asks first' };
  entry.streak = outcome === 'correction' ? 0 : entry.streak + 1;
  entry.level = entry.streak >= 3 ? 'acts, reports after' : 'asks first';
  next[role] = entry;
  return next;
}
export async function recordAutonomyOutcome(directory, role, outcome) {
  const path = join(directory, 'autonomy.json');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
  const next = updateAutonomy(state, role, outcome);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, JSON.stringify(next), { mode: 0o600 });
  await chmod(path, 0o600);
  return next[role];
}
export async function loadLedger({ repository, directory, git = exec } = {}) {
  const { stdout } = await git('git', ['log', '--all', '--format=%H%x1f%P%x1f%s%x1f%b%x1e'], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
  const commits = parseHistory(stdout);
  const groups = Object.fromEntries(['adal', 'claude-hack-demo', 'human'].map(role => [role, commits.filter(commit => commit.cofounder === role).map(({ hash, subject }) => ({ hash, subject }))]));
  const reviewDir = join(repository, 'docs');
  const files = (await readdir(reviewDir)).filter(name => /^TENKI-REVIEW-.*\.md$/.test(name)).sort();
  const findings = linkFindings((await Promise.all(files.map(async name => parseFindings(name, await readFile(join(reviewDir, name), 'utf8'))))).flat(), commits);
  const merges = await Promise.all(commits.filter(commit => commit.parents.length > 1).map(async commit => {
    const { stdout: paths } = await git('git', ['ls-tree', '-r', '--name-only', commit.hash, '--', 'test'], { cwd: repository });
    let count = 0;
    for (const path of paths.trim().split('\n').filter(path => path.endsWith('.test.js'))) {
      const { stdout: source } = await git('git', ['show', `${commit.hash}:${path}`], { cwd: repository });
      count += [...source.matchAll(/\b(?:test|it)\s*\(/g)].length;
    }
    return { hash: commit.hash, subject: commit.subject, tests: count };
  }));
  async function optionalJson(name, fallback) {
    try { return JSON.parse(await readFile(join(directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  const threads = await optionalJson('threads.json', null);
  const autonomy = await optionalJson('autonomy.json', {});
  const lessons = await optionalJson('lessons.json', {});
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'autonomy.json'), JSON.stringify(autonomy), { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const items = Array.isArray(threads) ? threads : Array.isArray(threads?.threads) ? threads.threads : null;
  const counts = items && { total: items.length, sent: items.filter(t => Boolean(t.sentAt) || ['sent', 'replied', 're-planned', 'won', 'lost'].includes(t.status)).length, replied: items.filter(t => Boolean(t.repliedAt) || Boolean(t.replies?.length) || ['replied', 're-planned'].includes(t.status)).length, won: items.filter(t => t.status === 'won').length, lost: items.filter(t => t.status === 'lost').length };
  const customerThreads = items?.map(t => ({
    id: t.id ?? null,
    expert: t.expert || 'not recorded',
    gate: t.paid ? 'G4' : t.price !== undefined && t.price !== null && t.price !== '' ? 'G3' : t.status === 'won' ? 'G2' : t.repliedAt || t.replies?.length || ['replied', 're-planned'].includes(t.status) ? 'G1' : 'G0',
    outcome: ['won', 'lost', 'stopped'].includes(t.status) ? t.status : t.sentAt || ['sent', 'replied', 're-planned'].includes(t.status) ? (t.repliedAt || t.replies?.length || ['replied', 're-planned'].includes(t.status) ? 'replied' : 'sent') : 'not sent'
  })) ?? null;
  const customerLessons = Object.values(lessons).map(publicLessons);
  return { groups, findings, merges, customers: counts, customerThreads, customerLessons, autonomy: Object.fromEntries(['adal', 'claude-hack-demo', 'human'].map(role => [role, autonomy[role] || { streak: 0, level: 'asks first' }])) };
}

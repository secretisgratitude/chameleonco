import { backend } from './engine.js';
import { localDate } from './date.js';
import { todayTrace } from './trace.js';

const priorities = { reply: 0, followUp: 1, behind: 2, routine: 3 };
export class JobQueue {
  constructor({ now = Date.now, max = Number(process.env.MAX_CONCURRENCY) || (backend() === 'claude' ? 8 : 100), perFounder = Number(process.env.PER_FOUNDER_MAX) || 5, budget = Number(process.env.FOUNDER_DAILY_BUDGET) || 40, windowMs = 30000 } = {}) {
    this.now = now;
    this.max = Math.max(1, max);
    this.perFounder = Math.max(1, perFounder);
    this.budget = Math.max(1, budget);
    this.windowMs = windowMs;
    this.concurrency = 1;
    this.waiting = [];
    this.running = 0;
    this.active = new Map();
    this.used = new Map();
    this.turn = new Map();
    this.window = [];
    this.baseline = null;
    this.lastTick = now();
    this.day = localDate(now());
  }
  refresh() {
    const day = localDate(this.now());
    if (this.day !== day) { this.day = day; this.used.clear(); }
  }
  stats(chatId) {
    this.refresh();
    return { concurrency: this.concurrency, waiting: this.waiting.filter(j => j.chatId === chatId).length, budgetUsed: this.used.get(chatId) || 0, budget: this.budget };
  }
  enqueue({ chatId, priority = 'routine', run, dependsOn = null, calls = 1 }) {
    if (!Object.hasOwn(priorities, priority)) throw new Error('Unknown priority.');
    const job = { chatId, priority, run, dependsOn, calls, status: 'waiting' };
    job.done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.refresh();
    if (priority !== 'reply' && (this.used.get(chatId) || 0) + calls > this.budget) {
      job.status = 'failed';
      job.reject(new Error('Founder daily engine budget reached; only replies run until tomorrow.'));
    } else {
      this.waiting.push(job);
      this.pump();
    }
    return job;
  }
  tick() {
    if (this.now() - this.lastTick < this.windowMs) return;
    const samples = this.window.map(x => x.ms).sort((a, b) => a - b);
    const median = samples.length ? samples[Math.floor(samples.length / 2)] : 0;
    const errors = this.window.filter(x => x.error).length;
    if (this.window.some(x => x.rateLimit) || errors >= 3 || this.baseline && median > 2 * this.baseline) this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
    else if (this.waiting.length && samples.length && median < 2 * (this.baseline || median + 1)) this.concurrency = Math.min(this.max, this.concurrency + 1);
    if (samples.length && !errors) this.baseline = this.baseline === null ? median : Math.min(this.baseline, median);
    this.window = [];
    this.lastTick = this.now();
    this.pump();
  }
  next() {
    this.refresh();
    for (const priority of Object.keys(priorities)) {
      const eligible = this.waiting.filter(j => j.priority === priority && (!j.dependsOn || j.dependsOn.status !== 'waiting' && j.dependsOn.status !== 'running') && (this.active.get(j.chatId) || 0) < this.perFounder && (priority === 'reply' || (this.used.get(j.chatId) || 0) + j.calls <= this.budget));
      if (!eligible.length) continue;
      const chats = [...new Set(eligible.map(j => j.chatId))];
      const index = (this.turn.get(priority) || 0) % chats.length;
      const job = eligible.find(j => j.chatId === chats[index]);
      this.turn.set(priority, index + 1);
      return job;
    }
    return null;
  }
  pump() {
    while (this.running < this.concurrency) {
      const job = this.next();
      if (!job) return;
      this.waiting.splice(this.waiting.indexOf(job), 1);
      this.running++;
      this.active.set(job.chatId, (this.active.get(job.chatId) || 0) + 1);
      this.used.set(job.chatId, (this.used.get(job.chatId) || 0) + job.calls);
      job.status = 'running';
      const started = this.now();
      Promise.resolve().then(() => job.run()).then(value => { job.status = 'done'; job.resolve(value); }, error => {
        job.status = 'failed'; job.reject(error);
        this.window.push({ ms: this.now() - started, error: true, rateLimit: /\b429\b|rate.limit/i.test(String(error?.message)) });
      }).finally(() => {
        if (job.status === 'done') this.window.push({ ms: this.now() - started, error: false });
        this.running--;
        this.active.set(job.chatId, this.active.get(job.chatId) - 1);
        this.pump();
      });
    }
  }
}
export const runtimeQueue = new JobQueue();
export async function queueStatus(chatId, now = Date.now()) {
  const stats = runtimeQueue.stats(chatId);
  return { ...stats, budgetUsed: Math.max(stats.budgetUsed, (await todayTrace(chatId, now)).length) };
}

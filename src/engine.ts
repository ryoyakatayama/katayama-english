import {
  type Word,
  type Level,
  type Mode,
  type Snapshot,
  type Progress,
  type Attempt,
} from './model.js';
export type Random = () => number;
export function shuffle<T>(
  items: readonly T[],
  rng: Random = Math.random,
): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function eligible(
  words: Word[],
  levels: Level[],
  mode: Mode,
  p: Snapshot,
  now = Date.now(),
): Word[] {
  return words.filter(
    (w) =>
      levels.includes(w.level) &&
      (mode === 'new'
        ? !p[w.key]
        : mode === 'due'
          ? !!p[w.key] && p[w.key].dueAt <= now
          : true),
  );
}
export function priority(w: Word, p: Snapshot): number[] {
  const v = p[w.key];
  return v && v.seen > v.correct && v.streak < 3
    ? [0, v.streak, v.correct / v.seen]
    : [v ? 2 : 1, 0, 0];
}
export function selectWords(
  pool: Word[],
  count: number,
  mode: Mode,
  p: Snapshot,
  rng: Random = Math.random,
): Word[] {
  if (!Number.isInteger(count) || count < 1 || count > pool.length)
    throw new Error(`問題数は1〜${pool.length}問にしてください。`);
  let a = shuffle(pool, rng);
  if (mode === 'weak') {
    a.sort((x, y) => {
      const u = priority(x, p),
        v = priority(y, p);
      return u[0] - v[0] || u[1] - v[1] || u[2] - v[2];
    });
    a = shuffle(a.slice(0, count), rng);
  }
  return a.slice(0, count);
}
export function goalWords(
  pool: Word[],
  count: number,
  today: Set<string>,
  rng: Random = Math.random,
): Word[] {
  if (!Number.isInteger(count) || count < 1 || count > pool.length)
    throw new Error(
      `コースは${count}問、選択範囲は${pool.length}語です。範囲を増やすか目標を下げてください。`,
    );
  const fresh = shuffle(
    pool.filter((w) => !today.has(w.key)),
    rng,
  ).slice(0, count);
  return shuffle(
    [
      ...fresh,
      ...shuffle(
        pool.filter((w) => today.has(w.key)),
        rng,
      ).slice(0, count - fresh.length),
    ],
    rng,
  );
}
export class QuestionFactory {
  previous = new Map<string, string>();
  families = new Map<string, Set<number>>();
  constructor(
    public words: Word[],
    families: string[][],
    public rng: Random = Math.random,
  ) {
    families.forEach((group, i) =>
      group.forEach((word) => {
        if (!this.families.has(word)) this.families.set(word, new Set());
        this.families.get(word)!.add(i);
      }),
    );
  }
  compatible(a: Word, b: Word): boolean {
    return (
      a.pos === b.pos &&
      a.english !== b.english &&
      !a.japanese.includes(b.japanese) &&
      !b.japanese.includes(a.japanese) &&
      ![...(this.families.get(a.english) || [])].some((id) =>
        this.families.get(b.english)?.has(id),
      )
    );
  }
  options(target: Word, levels: Level[]): Word[] {
    const pool = this.words.filter(
      (w) => levels.includes(w.level) && this.compatible(target, w),
    );
    const same = pool.filter((w) => w.level === target.level),
      other = pool.filter((w) => w.level !== target.level);
    for (let attempt = 0; attempt < 100; attempt++) {
      const choices = [target];
      for (const candidate of [
        ...shuffle(same, this.rng),
        ...shuffle(other, this.rng),
      ]) {
        if (choices.every((w) => this.compatible(candidate, w)))
          choices.push(candidate);
        if (choices.length === 6) break;
      }
      const signature = choices
        .map((w) => w.key)
        .sort()
        .join('|');
      if (choices.length === 6 && signature !== this.previous.get(target.key)) {
        this.previous.set(target.key, signature);
        return shuffle(choices, this.rng);
      }
    }
    throw new Error(`${target.english}の選択肢を作成できませんでした。`);
  }
}
export interface Answer {
  word: Word;
  selected: Word | null;
  correct: boolean;
  elapsed: number;
}
export class Quiz {
  index = -1;
  answers: Answer[] = [];
  answered = true;
  finished = false;
  options: Word[] = [];
  started = 0;
  deadline = 0;
  constructor(
    public words: Word[],
    public factory: QuestionFactory,
    public seconds: number,
    public levels: Level[],
    public clock = () => Date.now() / 1000,
  ) {
    if (!words.length || seconds < 3 || seconds > 120)
      throw new Error('制限時間は3〜120秒です。');
  }
  get word() {
    return this.words[this.index];
  }
  get remaining() {
    return Math.max(0, this.deadline - this.clock());
  }
  get mistakes() {
    return this.answers.filter((a) => !a.correct).map((a) => a.word);
  }
  next() {
    if (!this.answered || this.finished) return false;
    if (this.index + 1 === this.words.length) {
      this.finished = true;
      return false;
    }
    this.index++;
    this.options = this.factory.options(this.word, this.levels);
    this.started = this.clock();
    this.deadline = this.started + this.seconds;
    this.answered = false;
    return true;
  }
  answer(index: number | null): Answer | null {
    if (this.answered || this.finished || this.index < 0) return null;
    if (index !== null && (!Number.isInteger(index) || index < 0 || index > 5))
      throw new Error('選択肢が不正です。');
    const elapsed = Math.max(0, this.clock() - this.started);
    const selected =
      index === null || elapsed >= this.seconds ? null : this.options[index];
    const result = {
      word: this.word,
      selected,
      correct: selected?.key === this.word.key,
      elapsed: Math.min(this.seconds, elapsed),
    };
    this.answers.push(result);
    this.answered = true;
    return result;
  }
}
export function advance(
  old: Progress | undefined,
  word: string,
  correct: boolean,
  at: number,
): Progress {
  const streak = correct ? (old?.streak || 0) + 1 : 0;
  return {
    word,
    seen: (old?.seen || 0) + 1,
    correct: (old?.correct || 0) + Number(correct),
    streak,
    lastAt: at,
    dueAt:
      at +
      (correct
        ? [1, 3, 7, 14, 30, 60][Math.min(streak - 1, 5)] * 86400000
        : 600000),
  };
}
export function snapshot(attempts: Attempt[]): Snapshot {
  const p: Snapshot = Object.create(null);
  for (const a of attempts)
    p[a.word] = advance(p[a.word], a.word, a.correct, a.at);
  return p;
}
// Python round(): ties to even, including e.g. 1/8 = 12.5% -> 12%.
export function roundEven(value: number) {
  const n = Math.floor(value),
    f = value - n;
  return f === 0.5 ? n + (n % 2) : Math.round(value);
}
export function accuracy(correct: number, total: number) {
  return total ? `${roundEven((correct / total) * 100)}%` : '—';
}
export function dayKey(date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function daySummary(attempts: Attempt[], day = dayKey()) {
  const rows = attempts.filter((a) => dayKey(new Date(a.at)) === day);
  const keys = new Set(rows.map((a) => a.word));
  return {
    words: keys.size,
    answers: rows.length,
    correct: rows.filter((a) => a.correct).length,
    keys,
  };
}
export function monthSummary(attempts: Attempt[], year: number, month: number) {
  const prefix = `${year.toString().padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-`;
  const rows = attempts.filter((a) =>
    dayKey(new Date(a.at)).startsWith(prefix),
  );
  const days: Record<string, ReturnType<typeof daySummary>> = Object.create(
    null,
  );
  const groups = new Map<string, Attempt[]>();
  for (const a of rows) {
    const k = dayKey(new Date(a.at));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }
  for (const [key, list] of groups) days[key] = daySummary(list, key);
  return {
    days,
    total: Object.values(days).reduce((s, d) => s + d.words, 0),
    unique: new Set(rows.map((a) => a.word)).size,
    answers: rows.length,
    activeDays: groups.size,
  };
}
export function streak(attempts: Attempt[], today = new Date()) {
  const active = new Set(attempts.map((a) => dayKey(new Date(a.at))));
  const day = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    12,
  );
  if (!active.has(dayKey(day))) day.setDate(day.getDate() - 1);
  let n = 0;
  while (active.has(dayKey(day))) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

import {
  LEVELS,
  MODES,
  type Backup,
  type ProfileData,
  type Settings,
  type Word,
} from './model.js';
import { snapshot } from './engine.js';
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const fail = (): never => {
  throw new Error(
    'バックアップの内容が不正です。対応する片山英単語のJSONファイルを選んでください。',
  );
};
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const list = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail();
const str = (v: unknown, max = 200): string =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail();
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : fail();
const num = (v: unknown, min = 0, max = 8640000000000000): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
    ? v
    : fail();
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
export function validateSettings(value: unknown): Settings {
  const v = object(value),
    levels = list(v.levels, 4).map((x) => str(x));
  if (
    new Set(levels).size !== levels.length ||
    levels.some((x) => !Object.hasOwn(LEVELS, x)) ||
    !Object.hasOwn(MODES, str(v.mode))
  )
    fail();
  return {
    levels: levels as Settings['levels'],
    mode: v.mode as Settings['mode'],
    count: integer(v.count, 1, 2000),
    seconds: integer(v.seconds, 3, 120),
    dailyGoal: integer(v.dailyGoal, 1, 2000),
  };
}
export function validateBackup(input: unknown, words: Word[]): Backup {
  const v = object(input);
  if (v.format !== 'katayama-vocabulary') fail();
  if (v.version !== 1)
    throw new Error(
      'このバックアップのバージョンには対応していません。アプリを更新して確認してください。',
    );
  const keys = new Set(words.map((w) => w.key)),
    ids = new Set<string>();
  let total = 0;
  const word = (x: unknown) => {
    const k = str(x);
    if (!keys.has(k)) fail();
    return k;
  };
  const profiles = list(v.profiles, 100).map((item) => {
    const x = object(item),
      p = object(x.profile),
      id = str(p.id, 100),
      name = str(p.name, 40).trim();
    if (!name || ids.has(id)) fail();
    ids.add(id);
    const profile = {
      id,
      name,
      created: num(p.created),
      settings: validateSettings(p.settings),
    };
    const sessionIds = new Map<string, ProfileData['sessions'][number]>();
    const sessions = list(x.sessions, 200000).map((item) => {
      const s = object(item);
      const sid = str(s.id, 100);
      if (s.profileId !== id || sessionIds.has(sid)) fail();
      const row = {
        id: sid,
        profileId: id,
        started: num(s.started),
        ended: s.ended === null ? null : num(s.ended),
        scope: str(s.scope),
        mode: str(s.mode),
        planned: integer(s.planned, 1, 2000),
        completed: bool(s.completed),
      };
      if (
        (row.ended !== null && row.ended < row.started) ||
        (row.completed && row.ended === null)
      )
        fail();
      sessionIds.set(sid, row);
      return row;
    });
    const attemptIds = new Set<string>();
    const counts = new Map<string, number>();
    const attempts = list(x.attempts, 200000).map((item) => {
      if (++total > 250000) fail();
      const a = object(item),
        sid = str(a.sessionId, 100),
        s = sessionIds.get(sid),
        question = integer(a.question, 0, 1999);
      if (
        a.profileId !== id ||
        !s ||
        question >= s.planned ||
        attemptIds.has(`${sid}:${question}`)
      )
        fail();
      attemptIds.add(`${sid}:${question}`);
      counts.set(sid, (counts.get(sid) || 0) + 1);
      const row = {
        sessionId: sid,
        profileId: id,
        question,
        word: word(a.word),
        selected: a.selected === null ? null : word(a.selected),
        correct: bool(a.correct),
        elapsed: num(a.elapsed, 0, 120),
        at: num(a.at),
      };
      if (row.correct !== (row.selected === row.word) || row.at < s!.started)
        fail();
      return row;
    });
    for (const s of sessions) {
      const count = counts.get(s.id) || 0;
      if (s.completed && count !== s.planned) fail();
      for (let i = 0; i < count; i++)
        if (!attemptIds.has(`${s.id}:${i}`)) fail();
    }
    const derived = snapshot(attempts),
      progressKeys = new Set<string>();
    const progress = list(x.progress, 2000).map((item) => {
      const p = object(item),
        key = word(p.word);
      if (progressKeys.has(key)) fail();
      progressKeys.add(key);
      const row = {
        word: key,
        seen: integer(p.seen, 1),
        correct: integer(p.correct),
        streak: integer(p.streak),
        lastAt: num(p.lastAt),
        dueAt: num(p.dueAt),
      };
      const expected = derived[key];
      if (
        !expected ||
        Object.entries(expected).some(
          ([k, val]) => row[k as keyof typeof row] !== val,
        )
      )
        fail();
      return row;
    });
    if (progress.length !== Object.keys(derived).length) fail();
    return { profile, sessions, attempts, progress };
  });
  if (!profiles.length) fail();
  return {
    format: 'katayama-vocabulary',
    version: 1,
    exportedAt: num(v.exportedAt),
    profiles,
  };
}
export function parseBackup(text: string, words: Word[]): Backup {
  if (new Blob([text]).size > MAX_BACKUP_BYTES)
    throw new Error('バックアップは50MB以下にしてください。');
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('JSONを読み取れません。ファイルを確認してください。');
  }
  return validateBackup(input, words);
}

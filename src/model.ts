export const LEVELS = {
  basic: '基礎編',
  advanced: '応用編',
  upper1: '上級Ⅰ',
  upper2: '上級Ⅱ',
} as const;
export const POS = {
  noun: '名詞',
  verb: '動詞',
  adjective: '形容詞',
  adverb: '副詞',
} as const;
export const MODES = {
  random: 'ランダム',
  weak: '苦手優先',
  new: '未学習のみ',
  due: '復習日が来た単語',
} as const;
export type Level = keyof typeof LEVELS;
export type Mode = keyof typeof MODES;
export interface Word {
  key: string;
  english: string;
  japanese: string;
  level: Level;
  pos: keyof typeof POS;
}
export interface Vocabulary {
  version: 1;
  words: Word[];
  families: string[][];
}
export interface Settings {
  levels: Level[];
  mode: Mode;
  count: number;
  seconds: number;
  dailyGoal: number;
}
export const defaults = (): Settings => ({
  levels: ['basic'],
  mode: 'random',
  count: 10,
  seconds: 15,
  dailyGoal: 50,
});
export interface Profile {
  id: string;
  name: string;
  created: number;
  settings: Settings;
}
export interface StudySession {
  id: string;
  profileId: string;
  started: number;
  ended: number | null;
  scope: string;
  mode: string;
  planned: number;
  completed: boolean;
}
export interface Attempt {
  sessionId: string;
  profileId: string;
  question: number;
  word: string;
  selected: string | null;
  correct: boolean;
  elapsed: number;
  at: number;
}
export interface Progress {
  word: string;
  seen: number;
  correct: number;
  streak: number;
  lastAt: number;
  dueAt: number;
}
export type Snapshot = Record<string, Progress>;
export interface ProfileData {
  profile: Profile;
  sessions: StudySession[];
  attempts: Attempt[];
  progress: Progress[];
}
export interface Backup {
  format: 'katayama-vocabulary';
  version: 1;
  exportedAt: number;
  profiles: ProfileData[];
}

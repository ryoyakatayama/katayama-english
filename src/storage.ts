import {
  defaults,
  type ProfileData,
  type Settings,
  type StudySession,
  type Attempt,
  type Backup,
  type Progress,
} from './model.js';
import { advance } from './engine.js';
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error || new Error('保存処理が中断されました。'));
    tx.onerror = () => {
      /* abort reports error */
    };
  });
export class Store {
  constructor(public db: IDBDatabase) {}
  static async open(
    name = `katayama-v1:${new URL('.', location.href).pathname}`,
  ) {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('profiles', { keyPath: 'profile.id' });
      r.result.createObjectStore('meta');
    };
    const db = await request(r);
    db.onversionchange = () => db.close();
    return new Store(db);
  }
  async all(): Promise<ProfileData[]> {
    const tx = this.db.transaction('profiles', 'readonly'),
      complete = done(tx);
    const result = await request(tx.objectStore('profiles').getAll());
    await complete;
    return result;
  }
  async get(id: string): Promise<ProfileData> {
    const tx = this.db.transaction('profiles', 'readonly'),
      complete = done(tx);
    const value = await request(tx.objectStore('profiles').get(id));
    await complete;
    if (!value)
      throw new Error(
        'プロフィールが見つかりません。別のタブで削除された場合は再読み込みしてください。',
      );
    return value;
  }
  async active(id?: string): Promise<string | undefined> {
    const tx = this.db.transaction('meta', id ? 'readwrite' : 'readonly'),
      complete = done(tx),
      s = tx.objectStore('meta');
    const result = await request(id ? s.put(id, 'active') : s.get('active'));
    await complete;
    return id || (result as string | undefined);
  }
  async create(name: string) {
    name = name.trim();
    if (!name || name.length > 40)
      throw new Error('名前を1〜40文字で入力してください。');
    const data: ProfileData = {
      profile: {
        id: crypto.randomUUID(),
        name,
        created: Date.now(),
        settings: defaults(),
      },
      sessions: [],
      attempts: [],
      progress: [],
    };
    const tx = this.db.transaction('profiles', 'readwrite'),
      complete = done(tx);
    tx.objectStore('profiles').add(data);
    await complete;
    return data;
  }
  // One profile document is the atomic unit. Always read the latest inside the write transaction;
  // simultaneous tabs cannot overwrite another tab's attempts or progress.
  private async mutate<T>(
    id: string,
    fn: (data: ProfileData) => T,
  ): Promise<T> {
    const tx = this.db.transaction('profiles', 'readwrite'),
      complete = done(tx),
      s = tx.objectStore('profiles');
    // Attach an immediate rejection handler while awaiting the read request.
    void complete.catch(() => {});
    try {
      const data: ProfileData | undefined = await request(s.get(id));
      if (!data)
        throw new Error(
          'プロフィールが削除されています。再読み込みしてください。',
        );
      const result = fn(data);
      s.put(data);
      await complete;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already complete */
      }
      throw error;
    }
  }
  async rename(id: string, name: string) {
    name = name.trim();
    if (!name || name.length > 40)
      throw new Error('名前を1〜40文字で入力してください。');
    await this.mutate(id, (d) => {
      d.profile.name = name;
    });
  }
  async settings(id: string, value: Settings) {
    await this.mutate(id, (d) => {
      d.profile.settings = value;
    });
  }
  async remove(id: string) {
    const tx = this.db.transaction('profiles', 'readwrite'),
      complete = done(tx);
    tx.objectStore('profiles').delete(id);
    await complete;
  }
  async begin(profileId: string, scope: string, mode: string, planned: number) {
    const session: StudySession = {
      id: crypto.randomUUID(),
      profileId,
      started: Date.now(),
      ended: null,
      scope,
      mode,
      planned,
      completed: false,
    };
    await this.mutate(profileId, (d) => {
      d.sessions.push(session);
    });
    return session;
  }
  async record(a: Attempt) {
    return this.mutate(a.profileId, (d) => {
      const s = d.sessions.find((s) => s.id === a.sessionId);
      if (!s || s.ended !== null || a.question >= s.planned)
        throw new Error('このコースは終了しています。');
      if (
        d.attempts.some(
          (v) => v.sessionId === a.sessionId && v.question === a.question,
        )
      )
        return false;
      const previous = d.progress.findIndex((p) => p.word === a.word);
      const p = advance(d.progress[previous], a.word, a.correct, a.at);
      d.attempts.push(a);
      if (previous < 0) d.progress.push(p);
      else d.progress[previous] = p;
      return true;
    });
  }
  async finish(profileId: string, sid: string, completed = false) {
    await this.mutate(profileId, (d) => {
      const s = d.sessions.find((s) => s.id === sid);
      if (s && s.ended === null) {
        s.ended = Date.now();
        s.completed = completed;
      }
    });
  }
  async export(): Promise<Backup> {
    return {
      format: 'katayama-vocabulary',
      version: 1,
      exportedAt: Date.now(),
      profiles: await this.all(),
    };
  }
  // Caller must pass validateBackup's normalized output. Import adds independent copies.
  async import(backup: Backup) {
    const copies = backup.profiles.map((d) => {
      const id = crypto.randomUUID(),
        sessionIds = new Map(
          d.sessions.map((s) => [s.id, crypto.randomUUID()]),
        );
      return {
        profile: { ...d.profile, id, name: d.profile.name },
        sessions: d.sessions.map((s) => ({
          ...s,
          id: sessionIds.get(s.id)!,
          profileId: id,
        })),
        attempts: d.attempts.map((a) => ({
          ...a,
          sessionId: sessionIds.get(a.sessionId)!,
          profileId: id,
        })),
        progress: d.progress.map((p) => ({ ...p })),
      };
    });
    const tx = this.db.transaction('profiles', 'readwrite'),
      complete = done(tx),
      s = tx.objectStore('profiles');
    void complete.catch(() => {});
    try {
      for (const copy of copies) s.add(copy);
      await complete;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction already aborted */ }
      throw error;
    }
    return copies;
  }
}
export function progressMap(data: ProfileData): Record<string, Progress> {
  return Object.fromEntries(data.progress.map((p) => [p.word, p]));
}

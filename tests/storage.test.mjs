import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { Store } from '../.build/storage.js';
import { parseBackup, validateBackup } from '../.build/backup.js';
const words = JSON.parse(
  await readFile('dist/data/vocabulary.json', 'utf8'),
).words;
async function setup() {
  const s = await Store.open(crypto.randomUUID()),
    p = await s.create('テスト'),
    session = await s.begin(p.profile.id, '基礎編', 'ランダム', 3);
  return { s, p, session };
}
function answer(p, session, question = 0, correct = true) {
  return {
    profileId: p.profile.id,
    sessionId: session.id,
    question,
    word: words[0].key,
    selected: correct ? words[0].key : null,
    correct,
    elapsed: 1,
    at: session.started + question + 1,
  };
}
test('atomic history, duplicate answers, concurrent writes, profile isolation and persistence', async () => {
  const { s, p, session } = await setup(),
    a = answer(p, session);
  assert.equal(await s.record(a), true);
  assert.equal(await s.record(a), false);
  await Promise.all([
    s.record(answer(p, session, 1)),
    s.record(answer(p, session, 2, false)),
  ]);
  const d = await s.get(p.profile.id);
  assert.equal(d.attempts.length, 3);
  assert.equal(d.progress[0].seen, 3);
  assert.equal(d.progress[0].streak, 0);
  const other = await s.create('別の人');
  assert.equal((await s.get(other.profile.id)).attempts.length, 0);
  await s.rename(other.profile.id, '変更済み');
  await s.settings(other.profile.id, {
    ...other.profile.settings,
    dailyGoal: 123,
  });
  const name = s.db.name;
  s.db.close();
  const reopened = await Store.open(name);
  assert.equal((await reopened.get(p.profile.id)).attempts.length, 3);
  assert.equal(
    (await reopened.get(other.profile.id)).profile.settings.dailyGoal,
    123,
  );
  await reopened.remove(p.profile.id);
  await assert.rejects(() => reopened.record(a));
  assert.equal((await reopened.all()).length, 1);
  reopened.db.close();
});
test('full backup round trip, no overwrite, new IDs, safe invalid data rejection', async () => {
  const { s, p, session } = await setup();
  await s.record(answer(p, session));
  await s.finish(p.profile.id, session.id, false);
  const before = await s.export(),
    valid = parseBackup(JSON.stringify(before), words);
  const imported = await s.import(valid);
  assert.equal((await s.all()).length, 2);
  assert.notEqual(imported[0].profile.id, p.profile.id);
  assert.notEqual(imported[0].sessions[0].id, session.id);
  assert.deepEqual(
    (await s.get(p.profile.id)).attempts,
    before.profiles[0].attempts,
  );
  assert.deepEqual(imported[0].progress, before.profiles[0].progress);
  const mutations = [
    (b) => (b.version = 999),
    (b) => (b.profiles[0].profile.settings.dailyGoal = 0),
    (b) => (b.profiles[0].profile.settings.seconds = 1.5),
    (b) => (b.profiles[0].attempts[0].word = 'unknown:noun'),
    (b) => (b.profiles[0].attempts[0].correct = false),
    (b) => (b.profiles[0].progress[0].seen = 200),
    (b) => b.profiles[0].attempts.push(b.profiles[0].attempts[0]),
    (b) => (b.profiles[0].sessions[0].profileId = 'other'),
    (b) => (b.profiles[0].attempts[0].elapsed = Infinity),
    (b) => (b.profiles[0].profile.settings.mode = '__proto__'),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(before);
    mutate(bad);
    assert.throws(() => validateBackup(bad, words));
  }
  for (const bad of ['null', '[]', '{', '{"version":1}'])
    assert.throws(() => parseBackup(bad, words));
  assert.equal((await s.all()).length, 2);
  s.db.close();
});
test('failed profile write rolls back both history and statistics, then retry saves once', async () => {
  const { s, p, session } = await setup(),
    before = await s.get(p.profile.id),
    original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () {
    throw new DOMException('Disk full', 'QuotaExceededError');
  };
  try {
    await assert.rejects(() => s.record(answer(p, session)));
  } finally {
    IDBObjectStore.prototype.put = original;
  }
  assert.deepEqual(await s.get(p.profile.id), before);
  assert.equal(await s.record(answer(p, session)), true);
  assert.equal(await s.record(answer(p, session)), false);
  s.db.close();
});

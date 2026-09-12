import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  QuestionFactory,
  Quiz,
  eligible,
  selectWords,
  goalWords,
  advance,
  daySummary,
  monthSummary,
  streak,
  accuracy,
} from '../.build/engine.js';
import { defaults } from '../.build/model.js';
const v = JSON.parse(await readFile('dist/data/vocabulary.json', 'utf8'));
process.env.TZ = 'Asia/Tokyo';
const fixture = JSON.parse(
  await readFile('tests/python-fixtures.json', 'utf8'),
);
const rng = () => 0.999999;
const word = (key) => v.words.find((w) => w.key === key);
test('all 2,000 original words and all 4,000,000 pairwise exclusions match Python', () => {
  assert.equal(v.words.length, 2000);
  assert.equal(new Set(v.words.map((w) => w.english)).size, 2000);
  const factory = new QuestionFactory(v.words, v.families),
    hash = createHash('sha256');
  for (const a of v.words)
    hash.update(
      Buffer.from(v.words.map((b) => Number(factory.compatible(a, b)))),
    );
  assert.equal(hash.digest('hex'), fixture.compatibilityHash);
});
test('every word produces six distinct, compatible, changing choices in its own level', () => {
  let seed = 831;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const f = new QuestionFactory(v.words, v.families, random);
  for (const w of v.words) {
    const a = f.options(w, [w.level]),
      b = f.options(w, [w.level]);
    assert.equal(a.length, 6);
    assert.equal(new Set(a.map((w) => w.key)).size, 6);
    assert.ok(a.includes(w));
    assert.ok(a.every((x) => x.level === w.level && x.pos === w.pos));
    a.forEach((x, i) =>
      a.slice(i + 1).forEach((y) => assert.ok(f.compatible(x, y))),
    );
    assert.notDeepEqual(a.map((w) => w.key).sort(), b.map((w) => w.key).sort());
  }
});
test('all 15 level combinations and deterministic Python selections', () => {
  const levels = ['basic', 'advanced', 'upper1', 'upper2'];
  for (let mask = 1; mask < 16; mask++) {
    const chosen = levels.filter((_, i) => mask & (1 << i)),
      pool = eligible(v.words, chosen, 'random', {});
    assert.equal(pool.length, chosen.length * 500);
    assert.equal(
      new Set(goalWords(pool, pool.length, new Set()).map((w) => w.key)).size,
      pool.length,
    );
  }
  const pool = fixture.pool.map(word),
    p = Object.fromEntries(
      Object.entries(fixture.progress).map(([k, v]) => [
        k,
        { ...v, dueAt: v.due_at },
      ]),
    );
  for (const mode of ['random', 'weak', 'new', 'due']) {
    assert.deepEqual(
      selectWords(pool, 5, mode, p, rng).map((w) => w.key),
      fixture.selection[mode],
    );
    assert.deepEqual(
      eligible(pool, ['basic'], mode, p, 100).map((w) => w.key),
      fixture.eligibility[mode],
    );
  }
  assert.deepEqual(
    goalWords(pool, 7, new Set(fixture.pool.slice(0, 3)), rng).map(
      (w) => w.key,
    ),
    fixture.goal,
  );
  assert.throws(() => goalWords(pool, 9, new Set()));
  assert.throws(() => selectWords(pool, 0, 'random', {}));
  assert.equal(defaults().dailyGoal, 50);
});
test('grading, exact timeout, duplicate answer and mistakes', () => {
  let now = 100;
  const q = new Quiz(
    v.words.slice(0, 2),
    new QuestionFactory(v.words, v.families),
    3,
    ['basic'],
    () => now,
  );
  assert.equal(q.answer(0), null);
  q.next();
  assert.equal(q.next(), false);
  now = 103;
  assert.equal(q.answer(q.options.indexOf(q.word)).selected, null);
  assert.equal(q.answer(0), null);
  q.next();
  now = 105.999;
  assert.equal(q.answer(q.options.indexOf(q.word)).correct, true);
  q.next();
  assert.equal(q.finished, true);
  assert.deepEqual(q.mistakes, [v.words[0]]);
  assert.equal(accuracy(1, 8), '12%');
  assert.equal(accuracy(3, 8), '38%');
});
test('all review schedule transitions match Python', () => {
  let p;
  for (const a of fixture.updates) {
    p = advance(p, v.words[0].key, a.correct, a.at);
    assert.deepEqual(p, a.expected);
  }
});
test('calendar, leap day, year boundary, monthly totals and streak match Python', () => {
  for (const [day, expected] of Object.entries(fixture.days)) {
    const { keys, ...s } = daySummary(fixture.attempts, day);
    assert.deepEqual(s, expected);
  }
  for (const [key, expected] of Object.entries(fixture.months)) {
    const [year, month] = key.split('-').map(Number),
      actual = monthSummary(fixture.attempts, year, month - 1);
    assert.deepEqual(
      [actual.total, actual.unique, actual.answers, actual.activeDays],
      [expected.total, expected.unique, expected.answers, expected.active_days],
    );
  }
  for (const [day, expected] of Object.entries(fixture.streak))
    assert.equal(
      streak(fixture.attempts, new Date(day + 'T12:00:00')),
      expected,
    );
  const boundary = [
    {
      ...fixture.attempts[0],
      at: new Date(2025, 11, 31, 23, 59, 59, 999).getTime(),
    },
    { ...fixture.attempts[0], at: new Date(2026, 0, 1).getTime() },
  ];
  assert.equal(monthSummary(boundary, 2025, 11).answers, 1);
  assert.equal(monthSummary(boundary, 2026, 0).answers, 1);
});

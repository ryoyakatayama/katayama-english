import {
  LEVELS,
  POS,
  MODES,
  type Vocabulary,
  type ProfileData,
  type Word,
  type Attempt,
  type Backup,
  type Settings,
} from './model.js';
import {
  QuestionFactory,
  Quiz,
  eligible,
  selectWords,
  goalWords,
  shuffle,
  dayKey,
  daySummary,
  monthSummary,
  streak,
  accuracy,
  roundEven,
} from './engine.js';
import { Store, progressMap } from './storage.js';
import { parseBackup, MAX_BACKUP_BYTES, validateSettings } from './backup.js';

const root = document.querySelector<HTMLElement>('#app')!;
const notices = document.querySelector<HTMLElement>('#notices')!;
const esc = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const fmt = (v: number) => v.toLocaleString('ja-JP');
const button = (action: string, text: string, cls = '', extra = '') =>
  `<button type="button" data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
let store: Store,
  data: ProfileData,
  vocabulary: Vocabulary,
  factory: QuestionFactory;
let profiles: ProfileData[] = [],
  screen: 'home' | 'quiz' | 'results' | 'history' | 'settings' = 'home';
let quiz: Quiz | null = null,
  sessionId = '',
  sessionLabel = '',
  pending: Attempt | null = null,
  busy = false,
  timer = 0;
let selectedDay = dayKey(),
  month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let resultPage = 0,
  waiting: ServiceWorker | null = null,
  reloadReady = false,
  offlineReady = false;
let importPreview: Backup | null = null,
  installEvent: (Event & { prompt?: () => Promise<void> }) | null = null;
const changes =
  'BroadcastChannel' in window
    ? new BroadcastChannel(`katayama:${new URL('.', location.href).pathname}`)
    : null;
const announce = () => changes?.postMessage('changed');
function notify(message: string, error = false) {
  notices.innerHTML = `<div class="notice ${error ? 'error' : ''}" role="${error ? 'alert' : 'status'}">${esc(message)}${button('dismiss', '×', 'icon-button', 'aria-label="お知らせを閉じる"')}</div>`;
}
function fail(error: unknown) {
  console.error(error);
  notify(
    error instanceof Error
      ? error.message
      : '処理に失敗しました。空き容量とブラウザ設定を確認してください。',
    true,
  );
}
async function refresh() {
  data = await store.get(data.profile.id);
  profiles = await store.all();
}
function today() {
  return daySummary(data.attempts);
}
function summaryCard() {
  const s = today(),
    goal = data.profile.settings.dailyGoal,
    pct = Math.min(100, Math.floor((s.words / goal) * 100));
  return `
  <section class="goal-card" aria-label="今日の目標">
    <div class="row"><span class="eyebrow">TODAY’S PRACTICE</span>${button('goal-edit', '目標を変更', 'subtle light')}</div>
    <div class="goal-numbers ${s.words>=1000||goal>=1000?'long':''}"><span>${fmt(s.words)}</span><span class="goal-denominator">/ ${fmt(goal)} 語</span><strong>${pct}<small>%</small></strong></div>
    <progress max="${goal}" value="${Math.min(goal, s.words)}" aria-label="今日の目標達成度"></progress>
    <p class="motivation">${s.words >= goal ? '今日の目標達成！ この積み重ねが力になる。' : `あと <b>${fmt(goal - s.words)}語</b>。今日の一歩を、ここから。`}</p>
    ${button('goal', `目標の ${fmt(goal)} 問をはじめる <span aria-hidden="true">↗</span>`, 'primary full')}
    ${button('half', `半分の ${fmt(Math.ceil(goal / 2))} 問に取り組む`, 'half full')}
  </section><div class="habit"><span><b>${streak(data.attempts)}</b> 日連続で学習</span><span>今日の回答 <b>${fmt(s.answers)}</b> 回</span></div>`;
}
function home() {
  const s = data.profile.settings,
    pool = eligible(vocabulary.words, s.levels, s.mode, progressMap(data));
  return `
  <div class="page-heading"><div><p class="eyebrow blue">A LITTLE, EVERY DAY</p><h1>今日も、ひとつ先へ。</h1></div><span class="date">${new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })}</span></div>
  <div class="home-grid"><div>${summaryCard()}<p class="hint">目標・半分コースは、選択範囲の「今日未回答」を優先。通常コースのモードや問題数には影響しません。</p></div>
  <section class="panel practice"><div class="section-title"><h2><span>01</span> 出題範囲</h2>${button('all-levels', 'すべて選択', 'subtle')}</div>
    <fieldset class="levels"><legend class="sr-only">出題するレベル</legend>${Object.entries(
      LEVELS,
    )
      .map(
        ([k, v], i) =>
          `<label class="level ${s.levels.includes(k as keyof typeof LEVELS) ? 'selected' : ''}"><input type="checkbox" name="level" value="${k}" ${s.levels.includes(k as keyof typeof LEVELS) ? 'checked' : ''}><span><b>${v}</b><small>LEVEL ${i + 1} · 500語</small></span></label>`,
      )
      .join('')}</fieldset>
    <h2 class="training-heading"><span>02</span> 通常トレーニング</h2>
    <fieldset class="modes"><legend class="sr-only">出題モード</legend>${Object.entries(
      MODES,
    )
      .map(
        ([k, v]) =>
          `<label><input type="radio" name="mode" value="${k}" ${s.mode === k ? 'checked' : ''}><span>${v}</span></label>`,
      )
      .join('')}</fieldset>
    <div class="fields"><label>問題数 <span class="input-unit"><input id="count" type="number" inputmode="numeric" min="1" max="2000" value="${s.count}"><span>問</span></span></label><label>1問の時間 <span class="input-unit"><input id="seconds" type="number" inputmode="numeric" min="3" max="120" value="${s.seconds}"><span>秒</span></span></label></div>
    <p class="hint">対象 ${fmt(pool.length)} 語 · 制限時間 3〜120秒</p>
    ${button('start', '通常トレーニングをはじめる →', 'outline full')}
  </section></div>
  <p class="footnote">同じ日の同じ単語は1語として集計します。<br>学習記録はこの端末内に保存されます。</p>`;
}
function quizScreen() {
  const q = quiz!,
    a = q.answers.at(-1);
  return `
  <section class="quiz-layout"><div class="row quiz-heading">${button('quit', '終了', 'subtle')}<span>${esc(sessionLabel)}</span><strong>${q.index + 1} <span class="muted">/ ${q.words.length}</span></strong></div>
  <progress class="course-progress" value="${q.index + 1}" max="${q.words.length}" aria-label="コース進捗"></progress>
  <div class="quiz-meta"><span class="badge">${POS[q.word.pos]}</span><span>日本語の意味を選ぼう</span><strong id="timer" role="timer" aria-label="残り時間">${Math.ceil(q.remaining)}秒</strong></div>
  <div class="word-card"><span class="eyebrow">WORD ${String(q.index + 1).padStart(2, '0')}</span><h1>${esc(q.word.english)}</h1><p>${LEVELS[q.word.level]} · 基本的な意味を1つ選択</p></div>
  <progress id="countdown" value="${q.remaining}" max="${q.seconds}" aria-label="残り時間"></progress>
  <div class="choices">${q.options
    .map((w, i) => {
      const correct = q.answered && w.key === q.word.key,
        wrong = q.answered && a?.selected?.key === w.key && !a.correct;
      return button(
        `answer-${i}`,
        `<span class="choice-index">${correct ? '✓' : wrong ? '×' : i + 1}</span><span>${esc(w.japanese)}</span>`,
        `choice ${correct ? 'correct' : wrong ? 'wrong' : ''}`,
        q.answered || busy ? 'disabled' : '',
      );
    })
    .join('')}</div>
  ${
    q.answered
      ? `<div class="feedback ${a!.correct ? 'good' : 'bad'}" role="status"><b>${a!.correct ? '正解！' : a!.selected === null ? '時間切れ' : 'もう一度、覚えよう'}</b><span>${esc(q.word.english)} = ${esc(q.word.japanese)}</span></div>
    ${pending ? `${button('retry-save', '回答をもう一度保存する', 'primary full')}<p class="hint error-text">まだ保存できていません。保存してから次へ進んでください。</p>` : button('next', q.index + 1 === q.words.length ? '結果を見る →' : '次の単語へ →', 'primary full', busy ? 'disabled' : '')}`
      : `<p class="footnote">今日 ${today().words} / ${data.profile.settings.dailyGoal}語 <span class="desktop-hint">· 数字キー 1〜6 で回答</span></p>`
  }
  </section>`;
}
function results() {
  const q = quiz!,
    correct = q.answers.filter((a) => a.correct).length,
    pages = Math.ceil(q.answers.length / 20);
  return `<section class="narrow"><p class="eyebrow blue center">SESSION COMPLETE</p><h1 class="center">トレーニング完了</h1>
  <div class="result-card"><span class="eyebrow">ACCURACY</span><strong>${accuracy(correct, q.answers.length)}</strong><p>正解 ${correct}/${q.answers.length}問 · 回答時間 ${roundEven(q.answers.reduce((s, a) => s + a.elapsed, 0))}秒</p></div>
  <p class="center motivation">今日 ${today().words} / ${data.profile.settings.dailyGoal}語${today().words >= data.profile.settings.dailyGoal ? ' · 目標達成！' : ''}</p>
  ${q.mistakes.length ? button('review', `まちがえた ${q.mistakes.length}語を復習 ↻`, 'primary full') : '<p class="feedback good center">全問正解！</p>'}
  <div class="row result-nav">${button('home', 'ホームへ', 'outline')}${button('history', 'カレンダーを見る', 'outline')}</div><h2>今回の単語</h2>
  <ul class="word-list">${q.answers
    .slice(resultPage * 20, (resultPage + 1) * 20)
    .map(
      (a) =>
        `<li><span class="${a.correct ? 'good-text' : 'error-text'}">${a.correct ? '✓' : '×'}</span><div><b>${esc(a.word.english)}</b><span>${esc(a.word.japanese)}</span></div>${a.selected === null ? '<small>時間切れ</small>' : ''}</li>`,
    )
    .join('')}</ul>
  ${pages > 1 ? `<div class="row">${button('result-prev', '前へ', 'outline', resultPage === 0 ? 'disabled' : '')}<span>${resultPage + 1} / ${pages}</span>${button('result-next', '次へ', 'outline', resultPage + 1 >= pages ? 'disabled' : '')}</div>` : ''}</section>`;
}
function history() {
  const year = month.getFullYear(),
    m = month.getMonth(),
    stats = monthSummary(data.attempts, year, m),
    d = daySummary(data.attempts, selectedDay),
    p = progressMap(data);
  const offset = (month.getDay() + 6) % 7,
    days = new Date(year, m + 1, 0).getDate();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = i - offset + 1;
    if (day < 1 || day > days) {
      cells += '<span class="empty-day"></span>';
      continue;
    }
    const key = dayKey(new Date(year, m, day)),
      n = stats.days[key]?.words || 0;
    cells += button(
      `day-${key}`,
      `<span>${day}</span><small>${n}語</small>`,
      `calendar-day ${n ? 'active' : ''} ${key === selectedDay ? 'chosen' : ''} ${key === dayKey() ? 'today' : ''}`,
      `aria-label="${m + 1}月${day}日、${n}語" aria-pressed="${key === selectedDay}"`,
    );
  }
  const recent = data.sessions
    .filter((s) => data.attempts.some((a) => a.sessionId === s.id))
    .sort((a, b) => b.started - a.started)
    .slice(0, 10);
  return `<div class="page-heading"><div><p class="eyebrow blue">YOUR LEARNING STORY</p><h1>学習カレンダー</h1></div></div><div class="history-grid"><section class="panel">
  <div class="row month-nav">${button('month-prev', '‹', 'icon-button', 'aria-label="前月"')}<h2>${year}年 ${m + 1}月</h2>${button('month-next', '›', 'icon-button', 'aria-label="翌月"')}</div>
  <div class="month-summary"><div><small>月の学習語数（日別合計）</small><strong>${fmt(stats.total)} <small>語</small></strong></div><div><b>学習 ${stats.activeDays}日</b><span>${fmt(stats.answers)}回回答</span></div><p>月内の重複を除くと ${fmt(stats.unique)}語</p></div>
  <div class="row calendar-caption"><span>日付を押して記録を確認</span>${button('this-month', '今月へ', 'subtle')}</div>
  <div class="calendar"><div class="weekdays">${[...'月火水木金土日'].map((x) => `<span>${x}</span>`).join('')}</div><div class="calendar-grid">${cells}</div></div>
  <div class="day-detail" aria-live="polite"><b>${esc(selectedDay.replaceAll('-', ' / '))}${selectedDay === dayKey() ? '（今日）' : ''}</b><div class="row"><strong>${fmt(d.words)}語に取り組みました</strong><span>${d.answers}回回答<br>正答率 ${accuracy(d.correct, d.answers)}</span></div></div><p class="hint">同じ日の同じ単語は1語。別の日は再び1語と数えます。枠付きの日付は今日です。</p></section>
  <div><section class="panel"><h2>コース別の学習状況</h2>${Object.entries(
    LEVELS,
  )
    .map(([key, title]) => {
      const pool = vocabulary.words.filter((w) => w.level === key),
        learned = pool.filter((w) => p[w.key]).length,
        mastered = pool.filter((w) => (p[w.key]?.streak || 0) >= 3).length;
      return `<div class="course-stat"><div class="row"><b>${title}</b><small>${learned}/500語</small></div><progress value="${learned}" max="500" aria-label="${title}の学習済み語数"></progress><small>3連続正解 ${mastered}語</small></div>`;
    })
    .join('')}</section>
  <section class="panel recent"><h2>最近の学習</h2>${
    recent.length
      ? recent
          .map((s) => {
            const rows = data.attempts.filter((a) => a.sessionId === s.id);
            return `<article><div class="row"><b>${new Date(s.started).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</b><small>${s.completed ? '完了' : '途中まで'}</small></div><p>${esc(s.mode)} · 正解 ${rows.filter((a) => a.correct).length}/${rows.length}問</p><small>${esc(s.scope)}</small></article>`;
          })
          .join('')
      : '<p class="hint">最初の1語から、ここに記録が積み重なります。</p>'
  }</section></div></div>`;
}
function settings() {
  return `<section class="narrow"><p class="eyebrow blue">YOUR OWN SPACE</p><h1>プロフィールとデータ</h1>
  <section class="panel"><h2>この端末のプロフィール</h2><p class="hint">記録・目標・設定はプロフィールごとに独立しています。</p>
  <label class="stack">使用中のプロフィール<select id="profile-select">${profiles.map((p) => `<option value="${esc(p.profile.id)}" ${p.profile.id === data.profile.id ? 'selected' : ''}>${esc(p.profile.name)}</option>`).join('')}</select></label>
  <div class="button-grid">${button('profile-add', '＋ 新しく作る', 'outline')}${button('profile-rename', '名前を変更', 'outline')}</div>${button('profile-delete', 'このプロフィールを削除', 'subtle danger')}
  </section><section class="panel"><h2>バックアップ</h2><p class="hint">全プロフィール、学習履歴、苦手情報、設定をまとめて保存します。別の端末へはJSONファイルを移してください。</p>
  ${button('export', '学習データを書き出す ↓', 'primary full')}
  <label class="file-button outline">学習データを読み込む ↑<input id="import-file" type="file" accept=".json,application/json"></label>
  <p class="hint">読み込みは新しいプロフィールとして追加します。現在の記録は上書きしません。同名の場合はプロフィール一覧の別項目になります。</p></section>
  <section class="panel"><h2>アプリとして使う</h2>${installEvent ? button('install', 'この端末にインストール', 'primary full') : ''}<p><b>iPhone</b><br>Safariで開く → 共有 →「ホーム画面に追加」。表示された場合は「Webアプリとして開く」をオンにします。</p><p><b>Android</b><br>Chromeのメニュー →「ホーム画面に追加」または「アプリをインストール」。</p><p><b>PC</b><br>Chrome / Edgeのアドレスバーにあるインストールボタンから追加できます。</p><p class="hint">${offlineReady ? 'オフライン準備完了。初回読み込み後はネット接続なしで学習できます。' : 'オフライン用ファイルを準備中です。初回は通信が必要です。'}</p>
  ${button('persist', '端末に記録を保持するようリクエスト', 'outline full')}<p class="hint">ブラウザの対応状況により許可されない場合もあります。サイトデータの削除・端末故障に備え、定期的に書き出してください。</p></section>
  <section class="panel"><h2>プライバシー</h2><p>学習データは各端末内に保存され、GitHubや開発者のサーバーには送信されません。解析・広告・外部トラッカーは使いません。</p><p class="hint">URLを共有しても記録は共有されません。端末・ブラウザ・公開URLごとに保存領域は別です。プライベートブラウズでは記録が失われることがあります。</p><p class="hint">本アプリの単語とレベルは独自編集です。TOEIC公式の順位表ではありません。</p></section></section>`;
}
function render() {
  root.innerHTML = `<header class="app-header"><a href="#" data-action="home" class="brand" ${screen === 'quiz' ? 'aria-disabled="true"' : ''}><img src="./icons/icon-192.png" width="42" height="42" alt=""><span>片山英単語<small>NuASA · 2,000 WORDS</small></span></a>${screen !== 'quiz' ? button('settings', `<span class="avatar">${esc(data.profile.name.slice(0, 1))}</span><span class="profile-name">${esc(data.profile.name)}</span>`, 'profile-button', 'aria-label="プロフィールとデータ"') : ''}</header>
  <div id="update-banner" class="update-banner" ${waiting || reloadReady ? '' : 'hidden'}>${screen === 'quiz' ? '新しい版があります。コース終了後に更新できます。' : `新しい版を利用できます。 ${button('update', '更新する', 'subtle')}`}</div>
  <main id="main">${{ home, quiz: quizScreen, results, history, settings }[screen]()}</main>
  ${screen !== 'quiz' ? `<nav class="bottom-nav" aria-label="メインメニュー">${button('home', '<span aria-hidden="true">⌂</span> 学習', screen === 'home' ? 'current' : '', screen === 'home' ? 'aria-current="page"' : '')}${button('history', '<span aria-hidden="true">▦</span> 記録', screen === 'history' ? 'current' : '', screen === 'history' ? 'aria-current="page"' : '')}${button('settings', '<span aria-hidden="true">⚙</span> 設定', screen === 'settings' ? 'current' : '', screen === 'settings' ? 'aria-current="page"' : '')}</nav>` : ''}`;
  if (screen === 'quiz' && !quiz!.answered) paintTimer();
}
async function saveHome(normal = false) {
  const s = structuredClone(data.profile.settings);
  if (screen === 'home') {
    s.levels = [
      ...root.querySelectorAll<HTMLInputElement>('input[name=level]:checked'),
    ].map((x) => x.value as Settings['levels'][number]);
    s.mode = root.querySelector<HTMLInputElement>('input[name=mode]:checked')!
      .value as Settings['mode'];
    const count = root.querySelector<HTMLInputElement>('#count')!,
      seconds = root.querySelector<HTMLInputElement>('#seconds')!;
    if (!seconds.checkValidity() || !seconds.value) {
      seconds.reportValidity();
      throw new Error('制限時間は3〜120秒の整数で入力してください。');
    }
    s.seconds = Number(seconds.value);
    if (count.value && count.checkValidity()) s.count = Number(count.value);
    else if (normal) {
      count.reportValidity();
      throw new Error('問題数は1〜2,000の整数で入力してください。');
    }
  }
  validateSettings(s);
  await store.settings(data.profile.id, s);
  data.profile.settings = s;
  announce();
}
async function start(kind: 'normal' | 'goal' | 'half' | 'review') {
  await saveHome(kind === 'normal');
  const s = data.profile.settings;
  if (!s.levels.length) throw new Error('出題範囲を1つ以上選択してください。');
  await refresh();
  let chosen: Word[];
  if (kind === 'review') {
    chosen = shuffle(quiz!.mistakes);
    sessionLabel = 'まちがい復習';
  } else if (kind === 'goal' || kind === 'half') {
    chosen = goalWords(
      vocabulary.words.filter((w) => s.levels.includes(w.level)),
      kind === 'goal' ? s.dailyGoal : Math.ceil(s.dailyGoal / 2),
      today().keys,
    );
    sessionLabel = kind === 'goal' ? '今日の目標コース' : '目標の半分コース';
  } else {
    const pool = eligible(
      vocabulary.words,
      s.levels,
      s.mode,
      progressMap(data),
    );
    if (!pool.length)
      throw new Error(
        'この条件では出題できません。範囲やモードを変えてください。',
      );
    chosen = selectWords(pool, s.count, s.mode, progressMap(data));
    sessionLabel = MODES[s.mode];
  }
  const nextQuiz = new Quiz(chosen, factory, s.seconds, s.levels);
  nextQuiz.next();
  const record = await store.begin(
    data.profile.id,
    s.levels.map((k) => LEVELS[k]).join('・'),
    sessionLabel,
    chosen.length,
  );
  nextQuiz.started = nextQuiz.clock();
  nextQuiz.deadline = nextQuiz.started + s.seconds;
  quiz = nextQuiz;
  sessionId = record.id;
  pending = null;
  screen = 'quiz';
  render();
  window.scrollTo(0, 0);
  tick();
}
function paintTimer() {
  const q = quiz!,
    n = root.querySelector('#timer'),
    bar = root.querySelector<HTMLProgressElement>('#countdown');
  if (n) {
    n.textContent = `${Math.ceil(q.remaining)}秒`;
    n.classList.toggle('error-text', q.remaining <= 3);
  }
  if (bar) bar.value = q.remaining;
}
function tick() {
  clearTimeout(timer);
  if (screen !== 'quiz' || quiz!.answered) return;
  paintTimer();
  if (quiz!.remaining <= 0) {
    void answer(null);
    return;
  }
  timer = window.setTimeout(tick, 50);
}
async function saveAnswer() {
  if (!pending) return;
  await store.record(pending);
  pending = null;
  await refresh();
  announce();
}
async function answer(index: number | null) {
  if (busy || screen !== 'quiz' || quiz!.answered) return;
  const result = quiz!.answer(index);
  if (!result) return;
  clearTimeout(timer);
  busy = true;
  pending = {
    profileId: data.profile.id,
    sessionId,
    question: quiz!.index,
    word: result.word.key,
    selected: result.selected?.key || null,
    correct: result.correct,
    elapsed: result.elapsed,
    at: Date.now(),
  };
  render();
  try {
    await saveAnswer();
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
    render();
    root
      .querySelector<HTMLElement>('.feedback')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
async function next() {
  if (pending || !quiz!.answered) return;
  if (quiz!.next()) {
    render();
    window.scrollTo(0, 0);
    tick();
  } else if (quiz!.finished) {
    await store.finish(data.profile.id, sessionId, true);
    await refresh();
    screen = 'results';
    resultPage = 0;
    render();
    window.scrollTo(0, 0);
    announce();
  }
}
function modal(
  title: string,
  body: string,
  confirmText: string,
  onConfirm: (form: HTMLFormElement) => Promise<void>,
) {
  document.querySelector('dialog')?.remove();
  const d = document.createElement('dialog');
  d.innerHTML = `<form><h2>${esc(title)}</h2>${body}<p class="dialog-error" role="alert"></p><div class="dialog-buttons"><button type="button" data-cancel class="outline">キャンセル</button><button type="submit" class="primary">${esc(confirmText)}</button></div></form>`;
  document.body.append(d);
  d.querySelector('[data-cancel]')!.addEventListener('click', () => d.close());
  d.addEventListener('close', () => d.remove());
  d.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = d.querySelector<HTMLButtonElement>('[type=submit]')!;
    b.disabled = true;
    try {
      await onConfirm(e.target as HTMLFormElement);
      d.close();
    } catch (error) {
      d.querySelector('.dialog-error')!.textContent =
        error instanceof Error ? error.message : '処理に失敗しました。';
      b.disabled = false;
    }
  });
  d.showModal();
}
async function navigate(target: 'home' | 'history' | 'settings') {
  if (screen === 'quiz') return;
  screen = target;
  if (target === 'history') {
    selectedDay = dayKey();
    month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  }
  await refresh();
  render();
  window.scrollTo(0, 0);
}
async function action(name: string) {
  if (name === 'dismiss') {
    notices.innerHTML = '';
    return;
  }
  if (busy) return;
  if (name.startsWith('answer-')) {
    await answer(Number(name.slice(7)));
    return;
  }
  if (name === 'home' || name === 'history' || name === 'settings') {
    await navigate(name);
    return;
  }
  if (name === 'goal-edit') {
    modal(
      '1日の目標',
      `<label class="stack">1日に取り組む単語数<input name="goal" type="number" inputmode="numeric" required min="1" max="2000" value="${data.profile.settings.dailyGoal}"></label>`,
      '保存',
      async (form) => {
        const s = {
          ...data.profile.settings,
          dailyGoal: Number(new FormData(form).get('goal')),
        };
        validateSettings(s);
        await store.settings(data.profile.id, s);
        await refresh();
        render();
        announce();
      },
    );
    return;
  }
  if (name === 'profile-add' || name === 'profile-rename') {
    modal(
      name === 'profile-add' ? 'プロフィール作成' : 'プロフィール名を変更',
      `<label class="stack">名前<input name="name" required maxlength="40" autocomplete="off" value="${name === 'profile-rename' ? esc(data.profile.name) : ''}"></label>`,
      '保存',
      async (form) => {
        const value = String(new FormData(form).get('name'));
        if (name === 'profile-add') {
          data = await store.create(value);
          await store.active(data.profile.id);
        } else await store.rename(data.profile.id, value);
        await refresh();
        render();
        announce();
      },
    );
    return;
  }
  if (name === 'profile-delete') {
    modal(
      'プロフィールを削除',
      `<p>「${esc(data.profile.name)}」の設定と全学習記録をこの端末から削除します。必要な場合は先にバックアップを書き出してください。</p>`,
      '削除する',
      async () => {
        await store.remove(data.profile.id);
        profiles = await store.all();
        data = profiles[0] || (await store.create('マイプロフィール'));
        await store.active(data.profile.id);
        await refresh();
        render();
        announce();
      },
    );
    return;
  }
  if (name === 'quit') {
    modal(
      'トレーニングを終了',
      `<p>回答済みの記録を残してホームへ戻ります。回答中のカウントダウンは続きます。</p>`,
      '終了する',
      async () => {
        if (pending) await saveAnswer();
        await store.finish(data.profile.id, sessionId);
        clearTimeout(timer);
        screen = 'home';
        quiz = null;
        await refresh();
        render();
        announce();
      },
    );
    return;
  }
  busy = true;
  try {
    if (
      name === 'start' ||
      name === 'goal' ||
      name === 'half' ||
      name === 'review'
    )
      await start(name === 'start' ? 'normal' : name);
    else if (name === 'next') await next();
    else if (name === 'retry-save') {
      await saveAnswer();
      render();
    } else if (name === 'all-levels') {
      root
        .querySelectorAll<HTMLInputElement>('[name=level]')
        .forEach((x) => (x.checked = true));
      await saveHome();
      render();
    } else if (name.startsWith('day-')) {
      selectedDay = name.slice(4);
      render();
    } else if (name === 'month-prev' || name === 'month-next') {
      const nextMonth = new Date(
        month.getFullYear(),
        month.getMonth() + (name === 'month-prev' ? -1 : 1),
        1,
      );
      if (nextMonth.getFullYear() >= 1970 && nextMonth.getFullYear() <= 9998) {
        month = nextMonth;
        selectedDay =
          month.getFullYear() === new Date().getFullYear() &&
          month.getMonth() === new Date().getMonth()
            ? dayKey()
            : dayKey(month);
        render();
      }
    } else if (name === 'this-month') {
      month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      selectedDay = dayKey();
      render();
    } else if (name === 'result-prev' || name === 'result-next') {
      resultPage += name === 'result-prev' ? -1 : 1;
      render();
    } else if (name === 'export') {
      const blob = new Blob([JSON.stringify(await store.export(), null, 2)], {
          type: 'application/json',
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = 'vocabulary-backup.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      notify(
        '全プロフィールのバックアップを書き出しました。ファイルを安全な場所に保管してください。',
      );
    } else if (name === 'persist') {
      const ok = await navigator.storage?.persist?.();
      notify(
        ok
          ? '記録の保持が許可されました。バックアップも定期的に保存してください。'
          : 'このブラウザでは保持の許可を得られませんでした。通常の保存は利用できます。バックアップを活用してください。',
      );
    } else if (name === 'update') {
      if (reloadReady) location.reload();
      else waiting?.postMessage({ type: 'SKIP_WAITING' });
    } else if (name === 'install') {
      await installEvent?.prompt?.();
      installEvent = null;
      render();
    }
  } finally {
    busy = false;
    if (screen === 'quiz') render();
  }
}
document.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-action]');
  if (b) {
    e.preventDefault();
    void action(b.dataset.action!).catch(fail);
  }
});
document.addEventListener('keydown', (e) => {
  if (
    document.querySelector('dialog[open]') ||
    (e.target as Element).matches('input,select,textarea') ||
    e.repeat
  )
    return;
  if (screen === 'quiz' && /^[1-6]$/.test(e.key)) {
    e.preventDefault();
    void answer(Number(e.key) - 1);
  } else if (
    screen === 'quiz' &&
    e.key === 'Enter' &&
    quiz!.answered &&
    !(e.target as Element).closest('button')
  ) {
    e.preventDefault();
    void action('next').catch(fail);
  }
});
document.addEventListener('change', (e) => {
  void (async () => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'profile-select') {
      data = await store.get(el.value);
      await store.active(el.value);
      await refresh();
      render();
    } else if (el.matches('[name=level],[name=mode],#count,#seconds')) {
      await saveHome();
      if (el.name === 'level' || el.name === 'mode') {
        const pool = eligible(
          vocabulary.words,
          data.profile.settings.levels,
          data.profile.settings.mode,
          progressMap(data),
        );
        if (pool.length && data.profile.settings.count > pool.length) {
          data.profile.settings.count = pool.length;
          await store.settings(data.profile.id, data.profile.settings);
        }
        render();
      }
    } else if (el.id === 'import-file') {
      const file = el.files?.[0];
      if (!file) return;
      if (file.size > MAX_BACKUP_BYTES)
        throw new Error('バックアップは50MB以下にしてください。');
      importPreview = parseBackup(await file.text(), vocabulary.words);
      el.value = '';
      const preview = importPreview;
      modal(
        'バックアップを読み込む',
        `<p>${preview.profiles.length}プロフィール、${fmt(preview.profiles.reduce((n, p) => n + p.attempts.length, 0))}回答を追加します。既存の記録は変更しません。</p><ul>${preview.profiles.map((p) => `<li>${esc(p.profile.name)}</li>`).join('')}</ul>`,
        '追加して復元',
        async () => {
          await store.import(preview);
          importPreview = null;
          await refresh();
          render();
          announce();
          notify('復元しました。プロフィール一覧から選択してください。');
        },
      );
    }
  })().catch(fail);
});
let lastDay = dayKey();
setInterval(() => {
  if (data && lastDay !== dayKey()) {
    lastDay = dayKey();
    if (screen === 'home' || screen === 'history') render();
  }
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (screen === 'quiz') tick();
    else if (data && (screen === 'home' || screen === 'history'))
      void refresh().then(render).catch(fail);
  }
});
changes?.addEventListener('message', () => {
  if (
    data &&
    (screen === 'home' || screen === 'history') &&
    !document.querySelector('dialog[open]')
  )
    void refresh().then(render).catch(fail);
});
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
});
async function setupPWA() {
  if (!('serviceWorker' in navigator)) {
    notify('このブラウザはオフライン起動に対応していません。');
    return;
  }
  const registration = await navigator.serviceWorker.register('./sw.js', {
    scope: './',
    updateViaCache: 'none',
  });
  let hasController = !!navigator.serviceWorker.controller;
  const update = () => {
    waiting = registration.waiting;
    const banner = root.querySelector<HTMLElement>('#update-banner');
    if (waiting && banner) {
      banner.hidden = false;
      banner.innerHTML =
        screen === 'quiz'
          ? '新しい版があります。コース終了後に更新できます。'
          : `新しい版を利用できます。 ${button('update', '更新する', 'subtle')}`;
    }
  };
  update();
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', update);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasController) {
      reloadReady = true;
      waiting = null;
      if (screen !== 'quiz') location.reload();
    } else {
      hasController = true;
      offlineReady = true;
    }
  });
  await navigator.serviceWorker.ready;
  offlineReady = true;
  window.addEventListener(
    'online',
    () => void registration.update().catch(() => {}),
  );
  window.addEventListener(
    'focus',
    () => void registration.update().catch(() => {}),
  );
}
async function boot() {
  const response = await fetch('./data/vocabulary.json');
  if (!response.ok)
    throw new Error('単語データを読み込めません。初回はネット接続が必要です。');
  vocabulary = await response.json();
  if (vocabulary.words.length !== 2000)
    throw new Error('単語データが不完全です。');
  factory = new QuestionFactory(vocabulary.words, vocabulary.families);
  store = await Store.open();
  profiles = await store.all();
  const active = await store.active();
  data =
    profiles.find((p) => p.profile.id === active) ||
    profiles[0] ||
    (await store.create('マイプロフィール'));
  await store.active(data.profile.id);
  await refresh();
  render();
  void setupPWA().catch(() =>
    notify(
      'オフラインの準備に失敗しました。ネット接続中に再読み込みしてください。',
      true,
    ),
  );
}
void boot().catch((error) => {
  root.innerHTML = `<main class="narrow panel"><h1>片山英単語</h1><p>起動できませんでした。ブラウザの保存設定と空き容量、初回のネット接続を確認してください。</p><p>${esc(error instanceof Error ? error.message : error)}</p><button id="boot-retry">再読み込み</button></main>`;
  document
    .querySelector('#boot-retry')!
    .addEventListener('click', () => location.reload());
});

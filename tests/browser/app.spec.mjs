import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const v = JSON.parse(await readFile('dist/data/vocabulary.json', 'utf8'));
const click = (page, action) =>
  page.locator(`[data-action="${action}"]`).first().click();
async function boot(page) {
  await page.goto('./');
  await expect(
    page.getByRole('heading', { name: '今日も、ひとつ先へ。' }),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function setGoal(page, n) {
  await click(page, 'goal-edit');
  await page.locator('dialog input').fill(String(n));
  await page
    .locator('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(page.locator('dialog')).toHaveCount(0);
}
async function correct(page) {
  const english = await page.locator('.word-card h1').innerText(),
    w = v.words.find((w) => w.english === english);
  await page.locator('.choice').filter({ hasText: w.japanese }).click();
  await expect(page.locator('.feedback')).toContainText('正解');
  await expect(page.locator('[data-action=next]')).toBeEnabled();
}
async function quit(page) {
  await click(page, 'quit');
  await page
    .locator('dialog')
    .getByRole('button', { name: '終了する' })
    .click();
  await expect(page.locator('.goal-card')).toBeVisible();
}
async function db(page) {
  return page.evaluate(async () => {
    const r = indexedDB.open('katayama-v1:/katayama-test/', 1);
    return new Promise((resolve, reject) => {
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const d = r.result,
          t = d.transaction('profiles'),
          q = t.objectStore('profiles').getAll();
        q.onsuccess = () => resolve(q.result);
        t.oncomplete = () => d.close();
      };
    });
  });
}
async function disconnect() {
  // Inspector offline flags do not consistently affect Service Worker requests.
  // Cut the real static server transport for every engine; nothing is mocked.
  await mkdir('work', { recursive: true });
  await writeFile('work/pwa-network-offline', 'offline');
}
test.afterEach(async () => {
  await rm('work/pwa-network-offline', { force: true });
});
test('goal, half course, 6 choices, timeout, retry and calendar preserve the learning flow', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  await expect(page.locator('[data-action=goal]')).toContainText('50');
  await expect(page.locator('[data-action=half]')).toContainText('25');
  await setGoal(page, 3);
  await page.locator('input[value=due]').check();
  await click(page, 'half');
  await expect(page.locator('.quiz-heading')).toContainText('1 / 2');
  await expect(page.locator('.choice')).toHaveCount(6);
  await correct(page);
  await click(page, 'next');
  await correct(page);
  await click(page, 'next');
  await expect(page.locator('.result-card')).toContainText('100%');
  await click(page, 'home');
  await expect(page.locator('.goal-numbers')).toContainText('2');
  await expect(page.locator('input[value=due]')).toBeChecked();
  await expect(page.locator('#count')).toHaveValue('10');
  await page.locator('#seconds').fill('3');
  await page.locator('#seconds').blur();
  await click(page, 'goal');
  await expect(page.locator('.quiz-heading')).toContainText('1 / 3');
  await expect(page.locator('.feedback')).toContainText('時間切れ', {
    timeout: 6000,
  });
  await quit(page);
  await expect(page.locator('.goal-card')).toContainText('今日の目標達成');
  await click(page, 'history');
  await expect(page.locator('.day-detail')).toContainText(
    '3語に取り組みました',
  );
  await expect(page.locator('.month-summary')).toContainText('3回回答');
  await click(page, 'month-prev');
  await expect(page.locator('.month-summary')).toContainText('0回回答');
  await click(page, 'this-month');
  await expect(page.locator('.recent')).toContainText('途中まで');
  await expect(page.locator('.recent')).toContainText('完了');
  expect(errors).toEqual([]);
});
test('profiles, safe import/export, rename, delete and offline reload', async ({
  page,
  context,
  browserName,
}) => {
  const outgoing = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== 'http://127.0.0.1:4173')
      outgoing.push(r.url());
  });
  await boot(page);
  await setGoal(page, 1);
  await click(page, 'goal');
  await correct(page);
  await click(page, 'next');
  await click(page, 'home');
  await click(page, 'settings');
  const downloadPromise = page.waitForEvent('download');
  await click(page, 'export');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('vocabulary-backup.json');
  const file = await download.path();
  const content = JSON.parse(await readFile(file, 'utf8'));
  expect(content.profiles[0].attempts).toHaveLength(1);
  await click(page, 'profile-add');
  await page.locator('dialog input').fill('友人 <test>');
  await page
    .locator('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(page.locator('#profile-select')).toHaveValue(
    (await db(page)).find((p) => p.profile.name === '友人 <test>').profile.id,
  );
  await click(page, 'home');
  await expect(page.locator('.goal-numbers')).toContainText('/ 50 語');
  expect(
    (await db(page)).find((p) => p.profile.name === '友人 <test>').attempts,
  ).toHaveLength(0);
  await click(page, 'settings');
  await click(page, 'profile-rename');
  await page.locator('dialog input').fill('友人の学習');
  await page
    .locator('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await page
    .locator('#import-file')
    .setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"version":99}'),
    });
  await expect(page.locator('#notices')).toContainText('不正');
  expect(await db(page)).toHaveLength(2);
  await click(page, 'dismiss');
  await page.locator('#import-file').setInputFiles(file);
  await expect(page.locator('dialog')).toContainText('1プロフィール');
  await page
    .locator('dialog')
    .getByRole('button', { name: '追加して復元' })
    .click();
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(await db(page)).toHaveLength(3);
  await click(page, 'dismiss');
  const restored = (await db(page)).find(
    (p) =>
      p.profile.id !== content.profiles[0].profile.id &&
      p.attempts.length === 1,
  );
  await page.locator('#profile-select').selectOption(restored.profile.id);
  await expect(page.locator('.profile-name')).toHaveText(restored.profile.name);
  await disconnect(context, browserName);
  await page.reload();
  await expect(page.locator('.goal-card')).toContainText('今日の目標達成');
  expect([0, 503]).toContain(
    await page.evaluate(async () => {
      try {
        return (await fetch('./uncached-network-probe')).status;
      } catch {
        return 0;
      }
    }),
  );
  await click(page, 'goal');
  await correct(page);
  await click(page, 'next');
  await click(page, 'home');
  await click(page, 'settings');
  await click(page, 'profile-delete');
  await page
    .locator('dialog')
    .getByRole('button', { name: '削除する' })
    .click();
  expect(await db(page)).toHaveLength(2);
  expect(
    (await db(page)).find(
      (p) => p.profile.id === content.profiles[0].profile.id,
    ).attempts,
  ).toHaveLength(1);
  expect(outgoing).toEqual([]);
});
test('responsive layout, touch targets, safe manifest and keyboard settings', async ({
  page,
}) => {
  await boot(page);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 600 });
  await click(page, 'settings');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await click(page, 'profile-add');
  await page
    .locator('dialog input')
    .fill('長いプロフィールの名前でも横にはみ出さないことを確認');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator('dialog [data-cancel]').click();
  const manifest = await page.evaluate(async () => {
    const url = document.querySelector('link[rel=manifest]').href;
    return { url, data: await (await fetch(url)).json() };
  });
  expect(manifest.url).toContain('/katayama-test/manifest.webmanifest');
  expect(new URL(manifest.data.start_url, manifest.url).pathname).toBe(
    '/katayama-test/',
  );
  expect(manifest.data.display).toBe('standalone');
  await click(page, 'home');
  await setGoal(page, 1);
  await click(page, 'goal');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const bounds of await page
    .locator('.choice')
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        h: n.getBoundingClientRect().height,
        w: n.getBoundingClientRect().width,
      })),
    ))
    expect(bounds.h).toBeGreaterThanOrEqual(44);
});
test('records survive closing and relaunching the whole browser online', async ({ browserName }) => {
  const { chromium, webkit } = await import('playwright');
  const type = browserName === 'webkit' ? webkit : chromium;
  const folder = await mkdtemp(path.join(os.tmpdir(), 'katayama-pwa-test-'));
  let context;
  try {
    const options = { headless: true, baseURL: 'http://127.0.0.1:4173/katayama-test/' };
    context = await type.launchPersistentContext(folder, options);
    let page = context.pages()[0];
    await boot(page);
    await setGoal(page, 1);
    await click(page, 'goal');
    await correct(page);
    await context.close();
    context = await type.launchPersistentContext(folder, options);
    page = context.pages()[0];
    await boot(page);
    await expect(page.locator('.goal-card')).toContainText('今日の目標達成');
    await click(page, 'history');
    await expect(page.locator('.recent')).toContainText('途中まで');
  } finally {
    await context?.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('records survive closing and relaunching the whole browser offline', async ({
  browserName,
}, testInfo) => {
  const { chromium, webkit } = await import('playwright');
  const type = browserName === 'webkit' ? webkit : chromium;
  const folder = await mkdtemp(path.join(os.tmpdir(), 'katayama-pwa-test-'));
  let context;
  try {
    context = await type.launchPersistentContext(folder, {
      headless: true,
      baseURL:
        testInfo.project.use.baseURL || 'http://127.0.0.1:4173/katayama-test/',
    });
    let page = context.pages()[0];
    await page.goto('http://127.0.0.1:4173/__cache-probe');
    await page.evaluate(async () => {
      await (await caches.open('browser-persistence-probe')).put('/__probe-value', new Response('persisted'));
    });
    await boot(page);
    await setGoal(page, 1);
    await click(page, 'goal');
    await correct(page);
    await context.close();
    context = await type.launchPersistentContext(folder, {
      headless: true,
      baseURL: 'http://127.0.0.1:4173/katayama-test/',
    });
    page = context.pages()[0];
    // Probe the browser's plain Cache API independently of app code and SW.
    await page.goto('http://127.0.0.1:4173/__cache-probe');
    const probe = await page.evaluate(async () => {
      const response = await (await caches.open('browser-persistence-probe')).match('/__probe-value');
      return response ? await response.text() : null;
    });
    console.log(`${browserName}: Cache API value after browser restart = ${JSON.stringify(probe)}`);
    test.skip(browserName === 'webkit' && probe === null,
      'This Playwright WebKit runtime loses a plain Cache API entry across browser restart, independently of the app. Real iPhone cold offline launch remains unverified.');
    expect(probe).toBe('persisted');
    await disconnect();
    await page.goto('./');
    await expect(page.locator('.goal-card')).toContainText('今日の目標達成');
    await click(page, 'history');
    await expect(page.locator('.recent')).toContainText('途中まで');
  } finally {
    await context?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
test('new service worker does not interrupt a quiz in another tab and removes old caches', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'One version transition test against the shared static files',
  );
  await boot(page);
  await setGoal(page, 1);
  const other = await context.newPage();
  await boot(other);
  await click(page, 'goal');
  await correct(page);
  const originalSW = await readFile('dist/sw.js', 'utf8'),
    originalIndex = await readFile('dist/index.html', 'utf8');
  try {
    await writeFile(
      'dist/sw.js',
      originalSW.replace(
        /const VERSION = '([^']+)'/,
        "const VERSION = '$1-update-test'",
      ),
    );
    await writeFile(
      'dist/index.html',
      originalIndex.replace('<title>', '<title>Updated · '),
    );
    await other.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      await r.update();
    });
    await expect(other.locator('#update-banner')).toBeVisible();
    await click(other, 'update');
    await expect(other).toHaveTitle(/Updated/);
    await expect(page.locator('.quiz-layout')).toBeVisible();
    await expect(page.locator('.feedback')).toContainText('正解');
    await click(page, 'next');
    await expect(page.locator('.result-card')).toContainText('100%');
    await click(page, 'update');
    await expect(page).toHaveTitle(/Updated/);
    await expect(page.locator('.goal-card')).toContainText('今日の目標達成');
    const caches = await page.evaluate(() => window.caches.keys());
    expect(
      caches.filter((k) => k.startsWith('katayama-static:/katayama-test/:')),
    ).toHaveLength(1);
    await disconnect();
    await page.reload();
    await expect(page.locator('.goal-card')).toBeVisible();
  } finally {
    await writeFile('dist/sw.js', originalSW);
    await writeFile('dist/index.html', originalIndex);
  }
});

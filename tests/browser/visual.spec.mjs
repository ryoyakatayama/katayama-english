import {test,expect} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
const words=JSON.parse(await readFile('dist/data/vocabulary.json','utf8')).words;
test('visual check of mobile and desktop learning screens',async({page},info)=>{
  test.skip(info.project.name!=='chromium-desktop','One visual artifact set');
  await mkdir('outputs/pwa-preview',{recursive:true});
  await page.goto('./');await expect(page.locator('.goal-card')).toBeVisible();await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.locator('#count').fill('12');await page.locator('#count').blur();await page.locator('[data-action=start]').click();
  for(let i=0;i<12;i++){
    if(i===0){await page.setViewportSize({width:390,height:844});await page.screenshot({path:'outputs/pwa-preview/quiz.png',fullPage:true});}
    const english=await page.locator('.word-card h1').innerText(),word=words.find(w=>w.english===english);
    await page.locator('.choice').filter({hasText:word.japanese}).click();await expect(page.locator('[data-action=next]')).toBeEnabled();await page.locator('[data-action=next]').click();
  }
  await page.locator('[data-action=home]').first().click();await expect(page.locator('.goal-numbers')).toContainText('12');
  await page.screenshot({path:'outputs/pwa-preview/mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:960});await page.screenshot({path:'outputs/pwa-preview/desktop.png',fullPage:true});
  await page.locator('[data-action=history]').first().click();await expect(page.locator('.day-detail')).toContainText('12語');await page.screenshot({path:'outputs/pwa-preview/calendar.png',fullPage:true});
  await page.setViewportSize({width:320,height:740});await page.screenshot({path:'outputs/pwa-preview/calendar-mobile.png',fullPage:true});
  await page.locator('[data-action=home]').first().click();await page.locator('[data-action=goal-edit]').click();await page.locator('dialog input').fill('2000');await page.locator('dialog [type=submit]').click();await expect(page.locator('dialog')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

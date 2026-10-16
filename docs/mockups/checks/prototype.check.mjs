// Prototype smoke check (throwaway, not the product test suite).
// Usage: node docs/mockups/checks/prototype.check.mjs [outDir]
// Needs Playwright: set PLAYWRIGHT_MODULE to its index.mjs if it isn't resolvable, CHROMIUM_PATH for a custom browser.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const SP = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'floty-proto-'));
fs.mkdirSync(`${SP}/shots`, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'floty-prototype.html'), 'utf8');
// Mimic the artifact publish skeleton.
const page_html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style></head><body>${src}</body></html>`;
fs.writeFileSync(`${SP}/wrapped.html`, page_html);
const url = `file://${SP}/wrapped.html`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
console.log(`screenshots: ${SP}/shots`);
let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.log('FAIL', m); } else console.log('ok  ', m); };
for (const [name, vp] of [['mobile', { width: 375, height: 812 }], ['desktop', { width: 1280, height: 820 }]]) {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
    await page.goto(url + '#home');
    await page.waitForTimeout(400);
    const tag = `${name}/${scheme}`;
    const noHScroll = async (v) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${tag} ${v}: no horizontal page scroll`);
    await noHScroll('home');
    ok(await page.locator('#feed-needs .feed-item').count() === 2, `${tag} home: 2 items need OK`);
    ok(await page.locator('.home-ask').isVisible() === (name === 'desktop'), `${tag} home ask bar placement`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-home.png`, fullPage: false });
    // Feed: review + send Lena, then undo via toast
    await page.click('[data-action="lena-review"]');
    ok(await page.locator('#draft-lena').isVisible(), `${tag} draft shown`);
    await page.click('[data-action="lena-review"]');
    ok(await page.locator('#feed-needs .feed-item').count() === 1, `${tag} Lena moved out of needs`);
    await page.click('.toast button');
    ok(await page.locator('#feed-needs .feed-item').count() === 2, `${tag} toast undo restores Lena`);
    // Why sheet
    await page.click('[data-why="rosa"]');
    ok(await page.locator('#sheet h2').innerText().then(t => t.includes('Rosa')), `${tag} Why sheet opens`);
    await page.keyboard.press('Escape');
    ok(await page.locator('#scrim').isHidden(), `${tag} Escape closes sheet`);
    // Chat: Maria flow
    await page.locator(name === 'desktop' ? '.side-link[data-go="chat"]' : '.tab[data-go="chat"]').click();
    ok(await page.locator('[data-card="ruth"]').isVisible(), `${tag} chat seeded with ChangeDiff`);
    await page.click('[data-chip="maria"]');
    await page.waitForSelector('[data-card="maria-slots"]');
    ok(await page.locator('[data-card="maria-slots"] .slot').count() === 4, `${tag} SlotPicker shows 4 options`);
    await page.click('[data-slot="fri-1715"]');
    await page.waitForSelector('[data-card="maria-confirm"]');
    ok(await page.locator('[data-card="maria-confirm"] .notice').innerText().then(t => t.includes('PPD')), `${tag} allergy warning on confirm card`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-chat-confirm.png` });
    await page.click('[data-action="maria-book"]');
    ok(await page.locator('[data-card="maria-booked"]').isVisible(), `${tag} booking card`);
    await noHScroll('chat');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-chat-booked.png` });
    // Calendar Friday shows Maria
    await page.click('[data-card="maria-booked"] [data-action="open-cal-fri"]');
    ok(await page.locator('#cal-title').innerText() === 'Fri, Oct 16', `${tag} calendar opened on Friday`);
    ok(await page.locator('.ev.fresh').count() === 1, `${tag} Maria shown on calendar`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-cal-fri.png` });
    await page.click('.ev.fresh');
    ok(await page.locator('#sheet .notice').isVisible(), `${tag} event sheet shows allergy`);
    await page.click('#sheet [data-action="close-sheet"]');
    // Undo Maria from chat
    await page.locator(name === 'desktop' ? '.side-link[data-go="chat"]' : '.tab[data-go="chat"]').click();
    await page.click('[data-action="maria-undo"]');
    await page.locator(name === 'desktop' ? '.side-link[data-go="calendar"]' : '.tab[data-go="calendar"]').click();
    ok(await page.locator('.ev.fresh').count() === 0, `${tag} undo removes Maria from calendar`);
    // Sarah flow
    await page.locator(name === 'desktop' ? '.side-link[data-go="chat"]' : '.tab[data-go="chat"]').click();
    await page.click('[data-chip="sarah"]');
    await page.waitForSelector('[data-card="sarah"]');
    await page.click('[data-card="sarah"] [data-action="undo-diff"]');
    ok(await page.locator('[data-card="sarah"] .pill').innerText() === 'Undone', `${tag} Sarah undo`);
    // free text
    await page.fill('#composer-input', 'what does tomorrow look like');
    await page.press('#composer-input', 'Enter');
    await page.waitForTimeout(100);
    ok(await page.locator('#chat-chips').isHidden(), `${tag} all chips used`);
    // Calendar Thursday + week + gap + ruth undo
    await page.locator(name === 'desktop' ? '.side-link[data-go="calendar"]' : '.tab[data-go="calendar"]').click();
    await page.click('[data-action="cal-prev"]');
    ok(await page.locator('.nowline').count() === 3, `${tag} Thursday now-line in 3 columns`);
    await noHScroll('calendar');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-cal-thu.png` });
    await page.click('.ev.open >> nth=1');
    ok(await page.locator('#sheet h2').innerText().then(t => t.includes('Priya')), `${tag} gap sheet`);
    await page.click('#sheet [data-action="gap-fill"]');
    await page.click('[data-action="cal-staff"][data-staff="marco"]');
    ok(await page.locator('.col').count() === 1, `${tag} staff filter`);
    await page.click('[data-action="cal-mode"][data-mode="week"]');
    ok(await page.locator('table.week tbody tr').count() === 1, `${tag} week view`);
    await page.click('[data-action="cal-staff"][data-staff="all"]');
    await noHScroll('week');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-week.png` });
    await page.locator(name === 'desktop' ? '.side-link[data-go="home"]' : '.tab[data-go="home"]').click();
    await page.click('[data-action="undo-feed"]');
    await page.click('.tab[data-go="calendar"], .side-link[data-go="calendar"] >> visible=true');
    await page.click('[data-action="cal-mode"][data-mode="day"]');
    ok(await page.locator('[aria-label^="Ruth Okafor"]').getAttribute('aria-label').then(a => a.includes('11–12')), `${tag} Ruth undo updates calendar`);
    // brand
    await page.goto(url + '#brand'); await page.waitForTimeout(300);
    await noHScroll('brand');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-brand.png`, fullPage: false });
    ok(errors.length === 0, `${tag} no console errors ${errors.join(' | ')}`);
    await ctx.close();
  }
}
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

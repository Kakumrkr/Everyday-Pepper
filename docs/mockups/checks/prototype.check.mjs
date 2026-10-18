// Prototype smoke check (throwaway, not the product test suite).
// Usage: node docs/mockups/checks/prototype.check.mjs [outDir]
// Needs Playwright: set PLAYWRIGHT_MODULE to its index.mjs if it isn't resolvable, CHROMIUM_PATH for a custom browser.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const SP = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'pepper-proto-'));
fs.mkdirSync(`${SP}/shots`, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'pepper-prototype.html'), 'utf8');
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
    const nav = async (v) => {
      if (name === 'desktop') await page.click(`.side-link[data-go="${v}"]`);
      else if (['home', 'chat', 'calendar', 'clients'].includes(v)) await page.click(`.tab[data-go="${v}"]`);
      else { await page.click('.tab[data-go="more"]'); await page.click(`.more-list [data-go="${v}"]`); }
    };
    // ---- S2: clients + profile
    await nav('clients');
    ok(await page.locator('#client-list .client-row').count() === 8, `${tag} clients list`);
    await page.fill('#client-search', 'mar');
    ok(await page.locator('#client-list .client-row').count() === 1, `${tag} client search`);
    await page.fill('#client-search', '');
    await page.click('[data-action="open-client"][data-id="maria"]');
    ok(await page.locator('#client-title').innerText() === 'Maria Lopez', `${tag} profile opens`);
    ok(await page.locator('#client-body [data-sensitive]').count() === 1, `${tag} profile shows sensitive allergy`);
    await noHScroll('profile');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-profile.png` });
    // ---- S2: What I know -> delete PPD fact removes it everywhere, undo restores
    await nav('know');
    ok(await page.locator('.fact').count() === 12, `${tag} know lists 12 facts`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-know.png` });
    await page.click('[data-action="fact-edit"][data-id="b-parking"]');
    await page.fill('#fact-edit-b-parking', 'Free parking behind the building');
    await page.click('[data-action="fact-save"]');
    ok(await page.locator('[data-fact="b-parking"]').innerText().then(t => t.includes('Edited by you')), `${tag} fact edit`);
    await page.fill('#know-add-input', 'We close at 3 on Christmas Eve');
    await page.press('#know-add-input', 'Enter');
    ok(await page.locator('.fact').count() === 13, `${tag} fact add`);
    await page.click('[data-action="fact-ask-delete"][data-id="f-ppd"]');
    await page.click('[data-action="fact-delete"][data-id="f-ppd"]');
    ok(await page.locator('[data-fact="f-ppd"]').count() === 0, `${tag} fact deleted`);
    await nav('clients');
    ok(await page.locator('#client-list').innerText().then(t => !t.includes('PPD')), `${tag} deleted fact gone from client list`);
    await nav('calendar');
    await page.click('[data-action="cal-mode"][data-mode="day"]');
    ok(await page.locator('.ev .flag').count() === 0, `${tag} deleted fact gone from calendar`);
    await nav('chat');
    await page.click('[data-action="ask-about"] >> nth=0').catch(() => {});
    await page.fill('#composer-input', 'x'); // keep chat usable
    await page.fill('#composer-input', '');
    await nav('know');
    await page.click('[data-action="fact-ask-delete"][data-id="b-cancel"]');
    await page.click('[data-action="fact-delete"][data-id="b-cancel"]');
    await page.click('.toast button');
    ok(await page.locator('[data-fact="b-cancel"]').count() === 1, `${tag} delete undo restores fact`);
    // ---- S2: autonomy
    await nav('autonomy');
    ok(await page.locator('#aut-bulk-auto').isDisabled(), `${tag} bulk "just do it" locked`);
    ok(await page.locator('#aut-create-ask').isChecked(), `${tag} create defaults to ask`);
    await page.click('label[for="aut-create-notify"]');
    ok(await page.locator('#aut-create-ex').innerText().then(t => t.includes('Undo')), `${tag} autonomy example updates`);
    await noHScroll('autonomy');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-autonomy.png` });
    // ---- S2: team & services + invite validation
    await nav('team');
    ok(await page.locator('#team-body .photo').count() === 4, `${tag} team cards`);
    await page.click('[data-action="invite"]');
    await page.click('#invite-form button[type="submit"]');
    ok(await page.locator('#invite-email-err').isVisible(), `${tag} invite validates email`);
    await page.fill('#invite-email', 'sam@example.com');
    await page.click('#invite-form button[type="submit"]');
    ok(await page.locator('#scrim').isHidden(), `${tag} invite sent`);
    await page.click('[data-action="team-tab"][data-tab="services"]');
    ok(await page.locator('.svc-list li').count() === 11, `${tag} services list`);
    await noHScroll('team');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-team.png` });
    // ---- S2: onboarding
    await page.goto(url + '#home'); await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('[data-action="ob-start"]').click());
    ok(await page.locator('.side').isHidden() && await page.locator('#view-onboarding').isVisible(), `${tag} onboarding is full screen`);
    ok(await page.locator('.flow-actions [data-action="ob-next"]').isDisabled(), `${tag} type required`);
    await page.click('[data-action="ob-type"][data-id="salon"]');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-ob1.png` });
    await page.click('.flow-actions [data-action="ob-next"]');
    await page.click('[data-action="ob-read"]');
    await page.waitForSelector('.flow-actions [data-action="ob-next"]:not([disabled])');
    await page.click('.flow-actions [data-action="ob-next"]');
    await page.uncheck('#ob-svc-keratin');
    await noHScroll('onboarding review');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-ob3.png` });
    await page.click('[data-action="ob-confirm"]');
    ok(await page.locator('.toast').innerText().then(t => t.includes('Created 10 services')), `${tag} confirm creates only ticked services`);
    await page.click('[data-action="ob-src"][data-k="fresha"]');
    await page.click('[data-action="ob-import"]');
    ok(await page.locator('[data-card="import-report"]').isVisible(), `${tag} import report`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-ob4.png` });
    await page.click('.flow-actions [data-action="ob-next"]');
    ok(await page.locator('#ob-link').isVisible(), `${tag} ready step`);
    // ---- S2: booking page incl. race for the last slot
    await page.click('.flow-actions [data-action="book-start"]');
    ok(await page.locator('#view-book .choice-row').count() === 11, `${tag} booking: services with prices`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-book1.png` });
    await page.click('[data-action="book-svc"][data-id="colorgloss"]');
    ok(await page.locator('#view-book .photo').count() === 2, `${tag} booking: stylist photo placeholders`);
    await page.click('[data-action="book-staff"][data-id="jess"]');
    await noHScroll('booking time');
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-book3.png` });
    await page.click('[data-action="book-slot"][data-i="0"]');
    await page.click('#book-form button[type="submit"]');
    ok(await page.locator('#book-name-err').isVisible() && await page.locator('#book-email-err').isVisible(), `${tag} booking: details validated`);
    await page.fill('#book-name', 'Alex Rivera');
    await page.fill('#book-email', 'alex@example.com');
    await page.click('#book-form button[type="submit"]');
    await page.fill('#book-code', '12');
    await page.click('#verify-form button[type="submit"]');
    ok(await page.locator('#book-code-err').isVisible(), `${tag} booking: code validated`);
    await page.fill('#book-code', '482913');
    await page.click('#verify-form button[type="submit"]');
    ok(await page.locator('#view-book .notice').innerText().then(t => t.includes('Someone just booked')), `${tag} booking: last slot taken shows alternatives`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-book-taken.png` });
    await page.click('[data-action="book-alt"][data-i="1"]');
    ok(await page.locator('#view-book h1').innerText().then(t => t.includes("You're booked, Alex")), `${tag} booking: confirmed`);
    await page.screenshot({ path: `${SP}/shots/${name}-${scheme}-book-done.png` });
    await page.click('#view-book [data-go="home"]');
    ok(await page.locator('#view-home').isVisible() && !(await page.locator('#app').getAttribute('data-full')), `${tag} exit preview returns to app`);
    // ---- S2: autonomy change affects chat (book without asking)
    await page.goto(url + '#autonomy'); await page.reload(); await page.waitForTimeout(200);
    await page.click('label[for="aut-create-notify"]');
    await nav('chat');
    await page.click('[data-chip="maria"]');
    await page.waitForSelector('[data-card="maria-slots"]');
    await page.click('[data-slot="fri-1715"]');
    ok(await page.locator('[data-card="maria-booked"]').isVisible() && await page.locator('[data-card="maria-confirm"]').count() === 0, `${tag} "do it and tell me" books without confirm card`);
    await nav('clients');
    await page.click('[data-action="open-client"][data-id="maria"]');
    ok(await page.locator('#client-body').innerText().then(t => t.includes('Fri, Oct 16 · 5:15')), `${tag} profile shows new booking`);
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

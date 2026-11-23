// Mashov (משו"ב) from the server: a headless browser that signs in to Mashov.
// Kept as its own codebase (firebase.json) because the browser is big: the
// other functions don't carry it.
//
// It runs in Google's Tel Aviv region (me-west1), so Mashov sees a sign-in
// from Israel.
//
// Step 1 - mashovLoginTest: only signs in and checks that the teachers' main
// screen opens (nothing is marked, nothing is saved). The result is written to
// classroom_points/classroom-points-v1/meta/mashovTest. Started by hand
// (Cloud Scheduler "run" in me-west1); its own schedule is once a year.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const MASHOV_USER = defineSecret('MASHOV_USER');
const MASHOV_PASS = defineSecret('MASHOV_PASS');

const SETTINGS = {
  loginUrl: 'https://web.mashov.info/teachers/login',
  schoolSearch: 'רחובו',
  schoolOption: 'ממ"ד חב"ד בנים- רחובות'
};

async function launchBrowser(){
  const chromium = require('@sparticuz/chromium');
  const { chromium: pw } = require('playwright-core');
  return pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
}

async function login(page, user, pass, step){
  step('open login page');
  await page.goto(SETTINGS.loginUrl, { waitUntil: 'domcontentloaded' });
  step('choose Mashov sign-in');
  await page.getByText('הזדהות משו"ב').click();
  step('choose school');
  const school = page.getByRole('combobox', { name: 'ביה"ס' });
  await school.click();
  await school.fill(SETTINGS.schoolSearch);
  await page.getByText(SETTINGS.schoolOption).first().click();
  step('user name and password');
  await page.getByRole('textbox', { name: 'שם משתמש / ת.ז' }).fill(user);
  await page.getByRole('textbox', { name: 'סיסמה (משו"ב)' }).fill(pass);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  step('wait for the main screen');
  await page.waitForURL(/\/teachers\/main\//, { timeout: 60000 });
  await dismissCookies(page);
}

// The cookies window of a new browser: only the needed cookies.
async function dismissCookies(page){
  const btn = page.getByRole('button', { name: 'עוגיות חיוניות בלבד' });
  try{ await btn.waitFor({ timeout: 8000 }); await btn.click(); } catch(e){}
}

exports.mashovLoginTest = onSchedule({
  schedule: '0 3 1 1 *',
  timeZone: 'Asia/Jerusalem',
  region: 'me-west1',
  memory: '2GiB',
  timeoutSeconds: 300,
  maxInstances: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async () => {
  // Looks only: signs in, opens today's תפילה lesson and its behaviour events
  // screen - nothing is typed, marked or saved. A picture and the structure of
  // every screen are kept, to build the filling on the real screens.
  const ref = admin.firestore().collection('classroom_points').doc('classroom-points-v1').collection('meta').doc('mashovTest');
  let current = 'start', browser = null, page = null;
  const step = (s) => { current = s; logger.info('mashov test: ' + s); };
  const result = { at: new Date().toISOString(), ok: false, step: '', message: '', screens: [] };
  const keep = async (name) => {
    if (!page) return;
    const scr = { name, url: page.url(), shot: '', aria: '' };
    try{ scr.shot = (await page.screenshot({ type: 'jpeg', quality: 45 })).toString('base64'); } catch(e){}
    try{ scr.aria = (await page.locator('body').ariaSnapshot()).slice(0, 120000); } catch(e){ scr.aria = 'aria failed: ' + e.message; }
    result.screens.push(scr);
  };
  try{
    browser = await launchBrowser();
    page = await browser.newPage({ locale: 'he-IL', viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(30000);
    await login(page, MASHOV_USER.value(), MASHOV_PASS.value(), step);
    await page.waitForTimeout(2500);
    await keep('dashboard');
    step('open today\'s lesson from "המערכת להיום"');
    const item = page.getByText(/תפילה\s*ז2/).last();
    await item.click();
    await page.waitForTimeout(4000);
    await keep('after clicking today\'s תפילה');
    step('open the behaviour events screen (no typing)');
    const ev = page.getByRole('button', { name: /הזנת ארועי התנהגות/ });
    if (await ev.count()){
      await ev.locator('visible=true').first().click();
      await page.waitForTimeout(4000);
      await keep('behaviour events screen');
    }
    result.ok = true;
    result.message = 'looked at the screens - nothing typed or saved';
  } catch(e){
    result.message = String((e && e.message) || e).slice(0, 1500);
    await keep('at the error');
  }
  result.step = current;
  if (browser) await browser.close().catch(() => {});
  // A document holds up to 1MB: the pictures are left out if too big.
  let json = JSON.stringify(result);
  if (json.length > 900000) result.screens.forEach(s => { s.shot = ''; });
  await ref.set(result);
  logger.info('mashov test result: ' + JSON.stringify({ ok: result.ok, step: result.step, message: result.message, screens: result.screens.map(s => s.name + ' ' + s.url) }));
});

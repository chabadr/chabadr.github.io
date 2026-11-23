// Mashov (משו"ב) from the server: a headless browser that signs in to Mashov.
// Kept as its own codebase (firebase.json) because the browser is big: the
// other functions don't carry it.
//
// Step 1 - mashovLoginTest: only signs in and checks that the teachers' main
// screen opens (nothing is marked, nothing is saved). The result is written to
// classroom_points/classroom-points-v1/meta/mashovTest. Started by hand
// (Cloud Scheduler "run"), its schedule is once a year.

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
  await page.getByRole('button', { name: 'הזנת נתוני שיעור' }).waitFor({ timeout: 60000 });
}

exports.mashovLoginTest = onSchedule({
  schedule: '0 3 1 1 *',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1',
  memory: '2GiB',
  timeoutSeconds: 300,
  maxInstances: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async () => {
  const ref = admin.firestore().collection('classroom_points').doc('classroom-points-v1').collection('meta').doc('mashovTest');
  let current = 'start', browser = null, page = null;
  const step = (s) => { current = s; logger.info('mashov test: ' + s); };
  const result = { at: new Date().toISOString(), ok: false, step: '', message: '', url: '', shot: '' };
  try{
    browser = await launchBrowser();
    page = await browser.newPage({ locale: 'he-IL', viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(30000);
    await login(page, MASHOV_USER.value(), MASHOV_PASS.value(), step);
    result.ok = true;
    result.message = 'signed in - the main screen of Mashov opened';
  } catch(e){
    result.message = String((e && e.message) || e).slice(0, 1500);
  }
  result.step = current;
  if (page){
    result.url = page.url();
    try{ result.shot = (await page.screenshot({ type: 'jpeg', quality: 50 })).toString('base64'); } catch(e){}
  }
  if (browser) await browser.close().catch(() => {});
  await ref.set(result);
  logger.info('mashov test result: ' + JSON.stringify({ ok: result.ok, step: result.step, message: result.message, url: result.url }));
});

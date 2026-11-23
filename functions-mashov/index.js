// Mashov (משו"ב) from the server: a headless browser that signs in to Mashov.
// Kept as its own codebase (firebase.json) because the browser is big: the
// other functions don't carry it.
//
// It runs in Google's Tel Aviv region (me-west1), so Mashov sees a sign-in
// from Israel.
//
// mashovFillTest: a check - signs in, opens today's תפילה lesson, fills the
// topic and marks lateness / absence, but does not press "שמירה".

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const MASHOV_USER = defineSecret('MASHOV_USER');
const MASHOV_PASS = defineSecret('MASHOV_PASS');

const flow = require('./mashov-flow');

async function launchBrowser(){
  const chromium = require('@sparticuz/chromium');
  const { chromium: pw } = require('playwright-core');
  return pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
}

// One run in Mashov. save=false: everything is filled and marked, but "שמירה"
// is not pressed (a check). The result (what was marked for whom, pictures of
// the screens) is written to meta/mashovRun.
async function runMashov(save){
  const db = admin.firestore();
  const mainRef = db.collection('classroom_points').doc('classroom-points-v1');
  const runRef = mainRef.collection('meta').doc('mashovRun');
  let current = 'התחלה', browser = null, page = null;
  const step = (x) => { current = x; logger.info('mashov: ' + x); };
  const today = flow.israelToday();
  const result = { at: new Date().toISOString(), date: today.dmy, save, ok: false, saved: false, step: '', message: '', report: [], screens: [] };
  const keep = async (name, full) => {
    if (!page) return;
    const scr = { name, url: page.url(), shot: '', aria: '' };
    try{ scr.shot = (await page.screenshot({ type: 'jpeg', quality: 45, fullPage: !!full })).toString('base64'); } catch(e){}
    try{ scr.aria = (await page.locator('body').ariaSnapshot()).slice(0, 60000); } catch(e){}
    result.screens.push(scr);
  };
  try{
    step('קריאת הלוח של הכיתה');
    const mainSnap = await mainRef.get();
    const statuses = flow.boardStatuses(mainSnap.data() || {}, today);
    browser = await launchBrowser();
    page = await browser.newPage({ locale: 'he-IL', viewport: { width: 1280, height: 1400 } });
    page.setDefaultTimeout(30000);
    await flow.login(page, MASHOV_USER.value(), MASHOV_PASS.value(), step);
    await flow.openTodaysLesson(page, today, step);
    await flow.fillLesson(page, step);
    const { report, problems } = await flow.markEvents(page, statuses, step);
    result.report = report;
    await keep('אחרי הסימון', true);
    if (save && !problems){
      await flow.save(page, step);
      result.saved = true;
      await keep('אחרי השמירה', false);
    }
    result.ok = true;
    result.message = save
      ? (problems ? 'לא נשמר: יש תלמידים שלא נמצאו במשוב.' : 'נשמר במשוב.')
      : 'בדיקה: הכל סומן, לא נלחץ "שמירה".';
  } catch(e){
    result.message = String((e && e.message) || e).slice(0, 1500);
    await keep('בשגיאה', false);
  }
  result.step = current;
  if (browser) await browser.close().catch(() => {});
  if (JSON.stringify(result).length > 900000) result.screens.forEach(x => { x.shot = ''; });
  await runRef.set(result);
  logger.info('mashov result: ' + JSON.stringify({ ok: result.ok, saved: result.saved, step: result.step, message: result.message, report: result.report }));
  return result;
}

// A check run (no saving), started by hand: Cloud Scheduler "run" in me-west1.
exports.mashovFillTest = onSchedule({
  schedule: '0 3 1 1 *',
  timeZone: 'Asia/Jerusalem',
  region: 'me-west1',
  memory: '2GiB',
  timeoutSeconds: 300,
  maxInstances: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async () => { await runMashov(false); });

// The "מילוי נוכחות במשוב" button of the class board: fills and saves today's
// prayer attendance. Not more than once in 3 minutes (a second press while a
// run is going on is refused).
exports.mashovFill = onCall({
  region: 'me-west1',
  memory: '2GiB',
  timeoutSeconds: 300,
  maxInstances: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async () => {
  const db = admin.firestore();
  const lockRef = db.collection('classroom_points').doc('classroom-points-v1').collection('meta').doc('mashovLock');
  const free = await db.runTransaction(async (tx) => {
    const s = await tx.get(lockRef);
    const until = s.exists ? (s.data().until || 0) : 0;
    if (until > Date.now()) return false;
    tx.set(lockRef, { until: Date.now() + 3 * 60 * 1000 });
    return true;
  });
  if (!free) throw new HttpsError('resource-exhausted', 'כבר רץ מילוי, או שהסתיים לפני פחות מ-3 דקות. אפשר לנסות שוב עוד מעט.');
  const r = await runMashov(true);
  return { ok: r.ok, saved: r.saved, date: r.date, message: r.message, report: r.report.filter(x => x.status !== 'בזמן') };
});

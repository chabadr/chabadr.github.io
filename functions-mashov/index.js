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

// meta/mashovStatus (readable by the site): the day Mashov was last updated,
// so the class computer knows not to ask again and the reminder e-mail is not sent.
async function setMashovStatus(today, how){
  await admin.firestore().collection('classroom_points').doc('classroom-points-v1').collection('meta').doc('mashovStatus')
    .set({ date: today.iso, at: new Date().toISOString(), how });
}

// A page signed in to Mashov: with the sign-in kept from the last run when it
// still works (no new sign-in - so no "new device" e-mail from Mashov),
// otherwise (allowLogin) by user name and password. The sign-in is kept again
// for the next run. Returns { page } or { page: null } when not signed in.
async function signedInPage(browser, step, { allowLogin, result }){
  const sessionRef = admin.firestore().collection('classroom_points').doc('classroom-points-v1').collection('meta').doc('mashovSession');
  const sessionSnap = await sessionRef.get();
  const saved = sessionSnap.exists ? sessionSnap.data() : null;
  const ctxOptions = { locale: 'he-IL', viewport: { width: 1280, height: 1400 } };
  if (saved && saved.state){ try{ ctxOptions.storageState = JSON.parse(saved.state); } catch(e){} }
  // (The browser of this server can hold only one context.)
  const context = await browser.newContext(ctxOptions);
  if (saved && saved.session) await context.addInitScript(flow.sessionInitScript(saved.session), saved.session);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await flow.handleCookies(page);
  const reused = !!(saved && saved.state) && await flow.reuseSession(page, step);
  if (result) result.sessionReused = reused;
  if (!reused){
    if (saved) logger.info('mashov: the saved sign-in expired' + (saved.savedAt ? ' (kept at ' + saved.savedAt + ')' : ''));
    if (!allowLogin) return { page: null };
    await context.clearCookies();
    try{ await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch(e){}
    await flow.login(page, MASHOV_USER.value(), MASHOV_PASS.value(), step);
  }
  try{ await sessionRef.set(await flow.captureSession(page)); } catch(e){ logger.warn('mashov: could not keep the sign-in: ' + e.message); }
  return { page };
}

// One run in Mashov. save=false: everything is filled and marked, but "שמירה"
// is not pressed (a check). The result (what was marked for whom, pictures of
// the screens) is written to meta/mashovRun.
async function runMashov(save, arrivedIds){
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
    const statuses = flow.boardStatuses(mainSnap.data() || {}, today, arrivedIds);
    browser = await launchBrowser();
    ({ page } = await signedInPage(browser, step, { allowLogin: true, result }));
    await flow.openTodaysLesson(page, today, step);
    await flow.fillLesson(page, step);
    const { report, problems } = await flow.markEvents(page, statuses, step);
    result.report = report;
    // (A real update saves first - the picture is taken after, so it doesn't slow the saving.)
    if (!save || problems) await keep('אחרי הסימון', true);
    if (save && !problems){
      await flow.save(page, step);
      result.saved = true;
      await setMashovStatus(today, 'auto');
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
  // One browser per request; a few instances, so a press while one is still
  // starting is not refused ("no available instance").
  maxInstances: 3,
  concurrency: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async () => { await runMashov(false); });

// The "מילוי נוכחות במשוב" button of the class board: fills and saves today's
// prayer attendance. Not more than once in 3 minutes (a second press while a
// run is going on is refused).
exports.mashovFill = onCall({
  region: 'me-west1',
  memory: '2GiB',
  timeoutSeconds: 300,
  // One browser per request; a few instances, so a press while one is still
  // starting is not refused ("no available instance").
  maxInstances: 3,
  concurrency: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async (request) => {
  const data = request.data || {};
  // Sent when the question opens: the server wakes up and signs in now, so the
  // update itself (after the answer) is quick. Nothing is marked.
  if (data.warm === true){
    let browser = null;
    try{
      browser = await launchBrowser();
      await signedInPage(browser, (x) => logger.info('mashov warm: ' + x), { allowLogin: true });
      return { ok: true, warm: true };
    } catch(e){
      logger.warn('mashov warm failed: ' + ((e && e.message) || e));
      return { ok: false, warm: true };
    } finally{ if (browser) await browser.close().catch(() => {}); }
  }
  // "Mashov was already updated by hand today": only the status is kept.
  if (data.manualDone === true){
    await setMashovStatus(flow.israelToday(), 'manual');
    return { ok: true, saved: false, message: 'נרשם שמשוב עודכן ידנית היום.' , report: [] };
  }
  // From the question: the students with no mark today who came (arrivedIds -
  // marked late) and who did not (absentIds - absent, as anyone with no mark).
  const arrivedIds = Array.isArray(data.arrivedIds) ? data.arrivedIds.filter(n => Number.isInteger(n) && n > 0 && n < 100).slice(0, 60) : [];
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
  const r = await runMashov(true, arrivedIds);
  return { ok: r.ok, saved: r.saved, date: r.date, message: r.message, report: r.report.filter(x => x.status !== 'בזמן') };
});

// Every hour: the kept sign-in is used once, so it does not expire between the
// daily updates (an expired one means a new sign-in - and Mashov's "new device"
// e-mail). It never signs in by itself: when the kept sign-in expired anyway,
// the next update signs in.
exports.mashovKeepAlive = onSchedule({
  schedule: '20 * * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'me-west1',
  memory: '2GiB',
  timeoutSeconds: 120,
  maxInstances: 1,
  secrets: [MASHOV_USER, MASHOV_PASS]
}, async () => {
  let browser = null;
  try{
    browser = await launchBrowser();
    const { page } = await signedInPage(browser, () => {}, { allowLogin: false });
    logger.info('mashov keep-alive: ' + (page ? 'the sign-in is still good' : 'the sign-in expired'));
  } catch(e){
    logger.warn('mashov keep-alive failed: ' + ((e && e.message) || e));
  } finally{ if (browser) await browser.close().catch(() => {}); }
});

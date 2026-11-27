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
async function setMashovStatus(day, how, isToday){
  const at = new Date().toISOString();
  const data = { done: { [day.iso]: at } };
  if (isToday) Object.assign(data, { date: day.iso, at, how });
  await admin.firestore().collection('classroom_points').doc('classroom-points-v1').collection('meta').doc('mashovStatus')
    .set(data, { merge: true });
}

// School days (Sunday-Friday; no Saturday) of the last week, from the first day
// of the automatic update on, on which the board was used but Mashov was not
// updated (by this system). Keep in sync with mashovMissingDays in app.js.
const MASHOV_FIRST_DAY = '2026-11-24';
const MASHOV_MIN_MARKED = 5;
function missingDays(dailyDays, done, todayIso){
  const out = [];
  const seen = new Set();
  for (const e of (dailyDays || [])){
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(e.date));
    if (seen.has(iso) || iso >= todayIso || iso < MASHOV_FIRST_DAY || (done || {})[iso]) continue;
    const ageDays = (new Date(todayIso + 'T12:00:00Z') - new Date(iso + 'T12:00:00Z')) / 86400000;
    if (ageDays > 7 || new Date(iso + 'T12:00:00Z').getUTCDay() === 6) continue;
    // The board must really have been used that day (a few marks are not a school day's board).
    const marked = (e.students || []).filter(st => Object.values(st.cats || {}).some(v => v) || (st.minusTotal || 0) !== 0 || (st.purchases || 0) > 0).length;
    if (marked < MASHOV_MIN_MARKED) continue;
    seen.add(iso);
    out.push({ iso, students: e.students || [] });
  }
  return out.sort((a, b) => a.iso.localeCompare(b.iso));
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
    // Nothing is cleared: the "uniquId" cookie is how Mashov knows this is a
    // device it has seen (a sign-in from a known device sends no e-mail).
    await flow.login(page, MASHOV_USER.value(), MASHOV_PASS.value(), step);
  }
  try{ await sessionRef.set(await flow.captureSession(page)); } catch(e){ logger.warn('mashov: could not keep the sign-in: ' + e.message); }
  return { page };
}

// One run in Mashov. save=false: everything is filled and marked, but "שמירה"
// is not pressed (a check). The result (what was marked for whom, pictures of
// the screens) is written to meta/mashovRun.
async function runMashov(save, arrivedIds, pastArrived){
  const db = admin.firestore();
  const mainRef = db.collection('classroom_points').doc('classroom-points-v1');
  const runRef = mainRef.collection('meta').doc('mashovRun');
  let current = 'התחלה', browser = null, page = null;
  const step = (x) => { current = x; logger.info('mashov: ' + x); };
  const today = flow.israelToday();
  const result = { at: new Date().toISOString(), date: today.dmy, save, ok: false, saved: false, step: '', message: '', report: [], days: [], screens: [] };
  const keep = async (name, full) => {
    if (!page) return;
    const scr = { name, url: page.url(), shot: '', aria: '' };
    try{ scr.shot = (await page.screenshot({ type: 'jpeg', quality: 45, fullPage: !!full })).toString('base64'); } catch(e){}
    try{ scr.aria = (await page.locator('body').ariaSnapshot()).slice(0, 30000); } catch(e){}
    if (result.screens.length < 6) result.screens.push(scr);
  };
  // One lesson: fill, mark and (save) save. Returns { saved, problems, report }.
  const doLesson = async (statuses, label) => {
    await flow.fillLesson(page, step);
    const { report, problems } = await flow.markEvents(page, statuses, step);
    if (!save || problems) await keep('אחרי הסימון ' + label, true);
    if (save && !problems){
      await flow.save(page, step);
      await keep('אחרי השמירה ' + label, false);
    }
    return { saved: save && !problems, problems, report };
  };
  try{
    step('קריאת הלוח של הכיתה');
    const [mainSnap, dailySnap, statusSnap] = await Promise.all([
      mainRef.get(), mainRef.collection('meta').doc('dailyArchive').get(), mainRef.collection('meta').doc('mashovStatus').get()
    ]);
    const main = mainSnap.data() || {};
    const done = statusSnap.exists ? (statusSnap.data().done || {}) : {};
    const missing = missingDays(dailySnap.exists ? dailySnap.data().days : [], done, today.iso);
    // Today's board (a problem with it does not stop the earlier days).
    let statuses = null;
    try{ statuses = flow.boardStatuses(main, today, arrivedIds); }
    catch(e){ if (!missing.length) throw e; result.message = String((e && e.message) || e); }
    browser = await launchBrowser();
    ({ page } = await signedInPage(browser, step, { allowLogin: true, result }));

    // Today's lesson.
    if (statuses){
      await flow.openTodaysLesson(page, today, step);
      const t = await doLesson(statuses, today.dmy);
      result.report = t.report;
      result.saved = t.saved;
      if (t.saved) await setMashovStatus(today, 'auto', true);
      result.ok = true;
      result.message = save ? (t.problems ? 'לא נשמר: יש תלמידים שלא נמצאו במשוב.' : 'נשמר במשוב.') : 'בדיקה: הכל סומן, לא נלחץ "שמירה".';
    }

    // Earlier days of the week that were not updated (each on its own: a problem
    // in one does not stop the others).
    for (const m of missing){
      const day = flow.dayOf(m.iso);
      const entry = { date: day.dmy, saved: false, message: '', report: [] };
      result.days.push(entry);
      try{
        const st = flow.statusesOf(m.students, main.metivtaNames || {}, (pastArrived || {})[m.iso], 'ביום ' + day.dmy);
        await flow.openLessonOnDate(page, day, step);
        const r = await doLesson(st, day.dmy);
        entry.report = r.report.filter(x => x.status !== 'בזמן');
        entry.saved = r.saved;
        entry.message = save ? (r.problems ? 'לא נשמר: יש תלמידים שלא נמצאו במשוב.' : 'נשמר במשוב.') : 'בדיקה: סומן, לא נשמר.';
        if (r.saved) await setMashovStatus(day, 'auto-late', false);
      } catch(e){
        entry.message = String((e && e.message) || e).slice(0, 500);
        await keep('בשגיאה ' + day.dmy, false);
      }
    }
  } catch(e){
    result.message = String((e && e.message) || e).slice(0, 1500);
    await keep('בשגיאה', false);
  }
  result.step = current;
  if (browser) await browser.close().catch(() => {});
  if (JSON.stringify(result).length > 900000) result.screens.forEach(x => { x.shot = ''; });
  // Kept on the server: for a real update only whether it worked (and the
  // reason when it did not) - not what was marked for whom. A check run (no
  // saving) or a failed update keeps the details and pictures, to find a problem.
  const failed = !result.ok || result.days.some(d => !d.saved);
  await runRef.set(save && !failed
    ? { at: result.at, date: result.date, save, ok: result.ok, saved: result.saved, message: result.message, days: result.days.map(d => ({ date: d.date, saved: d.saved, message: d.message })) }
    : result);
  logger.info('mashov result: ' + JSON.stringify({ ok: result.ok, saved: result.saved, step: result.step, message: result.message, report: result.report, days: result.days }));
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
}, async () => { await runMashov(false, [], {}); });

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
    await setMashovStatus(flow.israelToday(), 'manual', true);
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
  // The answers about earlier days that were not updated: { 'yyyy-mm-dd': [ids that came] }.
  const pastArrived = {};
  if (data.pastArrived && typeof data.pastArrived === 'object'){
    Object.keys(data.pastArrived).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).slice(0, 7).forEach(k => {
      const v = data.pastArrived[k];
      pastArrived[k] = Array.isArray(v) ? v.filter(n => Number.isInteger(n) && n > 0 && n < 100).slice(0, 60) : [];
    });
  }
  const r = await runMashov(true, arrivedIds, pastArrived);
  return { ok: r.ok, saved: r.saved, date: r.date, message: r.message, report: r.report.filter(x => x.status !== 'בזמן'), days: r.days };
});

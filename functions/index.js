// The daily reset's date math (which day it is, which week) must follow
// Israel time, not the server's UTC clock. Set before anything reads a date.
process.env.TZ = 'Asia/Jerusalem';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const https = require('https');
const nodemailer = require('nodemailer');
const { sendQueuedBatch, MAX_AGE_MS } = require('./pdf-mail');
const { computeDailyResetUpdate, isLiveDayDueForArchive, getWeekKey } = require('./daily-reset');

admin.initializeApp();

const STORAGE_KEY = 'classroom-points-v1';
const FIRESTORE_COLLECTION = 'classroom_points';

const SMS4FREE_KEY = defineSecret('SMS4FREE_KEY');
const SMS4FREE_USER = defineSecret('SMS4FREE_USER');
const SMS4FREE_PASS = defineSecret('SMS4FREE_PASS');
// The admin page's code, checked here so it is never in the public site code.
const ADMIN_CODE = defineSecret('ADMIN_CODE');
// The mail account the PDFs are sent from (see functions/README.md).
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');

// Keep in sync with SMS4FREE_ERROR_MESSAGES in admin.html.
const SMS4FREE_ERROR_MESSAGES = {
  0: 'שגיאה כללית',
  '-1': 'מפתח, שם משתמש או סיסמה שגויים',
  '-2': 'שם או מספר שולח ההודעה שגוי',
  '-3': 'לא נמצאו נמענים',
  '-4': 'לא ניתן לשלוח הודעה, יתרת הודעות פנויות נמוכה',
  '-5': 'הודעה לא מתאימה',
  '-6': 'צריך לאמת מספר שולח'
};

function sendSms(key, user, pass, sender, recipient, msg){
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ key, user, pass, sender, recipient, msg });
    const req = https.request({
      hostname: 'api.sms4free.co.il',
      path: '/ApiSMS/SendSMS',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(parseInt(data, 10)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Checks the admin code on the server (the code is never in the public site
// code). Too many wrong codes lock the check for 10 minutes for everyone.
async function checkAdminCode(code){
  const db = admin.firestore();
  const guardRef = db.collection(FIRESTORE_COLLECTION).doc(STORAGE_KEY).collection('meta').doc('smsAuthGuard');
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(guardRef);
    const g = snap.exists ? snap.data() : {};
    const now = Date.now();
    if (g.lockedUntil && g.lockedUntil > now) return null;
    if (String(code || '') === ADMIN_CODE.value()){
      if (g.fails) tx.set(guardRef, { fails: 0, lockedUntil: 0 });
      return true;
    }
    const fails = (g.fails || 0) + 1;
    tx.set(guardRef, { fails: fails >= 10 ? 0 : fails, lockedUntil: fails >= 10 ? now + 10 * 60 * 1000 : 0 });
    return false;
  });
  if (ok === null) throw new HttpsError('resource-exhausted', 'locked');
  if (!ok) throw new HttpsError('permission-denied', 'bad code');
}

// The admin page: after the right code, this browser (its anonymous Firebase
// user) is marked as admin, and the database rules let it read the private
// data (phones, messages, settings). The mark stays on that browser.
exports.unlockDevice = onCall({
  region: 'us-central1',
  maxInstances: 3,
  secrets: [ADMIN_CODE]
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'sign in first');
  await checkAdminCode((request.data || {}).code);
  if (request.auth.token.admin !== true){
    await admin.auth().setCustomUserClaims(request.auth.uid, { admin: true });
  }
  return { admin: true };
});

// Sends one SMS right now for the admin page. The SMS account details stay
// here on the server (they used to be in a public file). The caller must send
// the admin code.
exports.sendSmsNow = onCall({
  region: 'us-central1',
  maxInstances: 3,
  secrets: [ADMIN_CODE, SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS]
}, async (request) => {
  const { code, sender, recipient, msg } = request.data || {};
  await checkAdminCode(code);
  if (typeof recipient !== 'string' || typeof msg !== 'string' || !msg || typeof sender !== 'string') {
    throw new HttpsError('invalid-argument', 'missing fields');
  }
  const result = await sendSms(SMS4FREE_KEY.value(), SMS4FREE_USER.value(), SMS4FREE_PASS.value(), sender, recipient, msg);
  return { code: result };
});

// Runs every 20 minutes, but only on Saturday and Sunday 19:00-22:40 Israel time (the
// sending window admin.html enforces for scheduling); picks up any "pending"
// doc in scheduledSms whose sendAt has arrived and actually sends it via the sms4free API, independent of
// whether admin.html is open anywhere. See admin.html's "תזמון שליחה" button
// (writes the pending docs this reads) and functions/README.md (deployment).
exports.sendScheduledSms = onSchedule({
  schedule: '*/20 19-22 * * 0,6',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1',
  secrets: [SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS]
}, async () => {
  const db = admin.firestore();
  const colRef = db.collection(FIRESTORE_COLLECTION).doc(STORAGE_KEY).collection('scheduledSms');
  const snap = await colRef.where('status', '==', 'pending').get();
  if (snap.empty) return;

  const now = Date.now();
  const due = snap.docs.filter((d) => new Date(d.data().sendAt).getTime() <= now);
  if (due.length === 0) return;

  const key = SMS4FREE_KEY.value();
  const user = SMS4FREE_USER.value();
  const pass = SMS4FREE_PASS.value();

  for (const docSnap of due){
    const data = docSnap.data();
    try{
      const code = await sendSms(key, user, pass, data.sender, data.phone, data.msg);
      if (!isNaN(code) && code > 0){
        await docSnap.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
      } else {
        const errMsg = SMS4FREE_ERROR_MESSAGES[String(code)] || ('קוד שגיאה: ' + code);
        await docSnap.ref.update({ status: 'failed', error: errMsg });
        logger.error('scheduled SMS failed', { id: docSnap.id, phone: data.phone, code, errMsg });
      }
    } catch(e){
      await docSnap.ref.update({ status: 'failed', error: String(e && e.message || e) });
      logger.error('scheduled SMS threw', { id: docSnap.id, phone: data.phone, error: String(e && e.message || e) });
    }
  }
});

// Every night at 01:00 Israel time: archive the day that ended and start a
// fresh board - the same transaction index.html's doResetGuarded runs, so
// whichever of them gets there first does it and the other finds nothing due.
exports.dailyReset = onSchedule({
  schedule: '0 1 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1'
}, async () => {
  const db = admin.firestore();
  const mainRef = db.collection(FIRESTORE_COLLECTION).doc(STORAGE_KEY);
  const dailyRef = mainRef.collection('meta').doc('dailyArchive');
  const result = await db.runTransaction(async (tx) => {
    const mainSnap = await tx.get(mainRef);
    if (!mainSnap.exists) return 'no main doc';
    const mainData = mainSnap.data();
    if (!Array.isArray(mainData.students) || mainData.students.length !== 23) return 'unexpected main doc shape';
    if (!isLiveDayDueForArchive(mainData)) return 'nothing due (lastActivityDate=' + mainData.lastActivityDate + ')';
    const entryDate = new Date(mainData.lastActivityDate + 'T12:00:00');
    const weekKey = getWeekKey(entryDate);
    const weekRef = mainRef.collection('archiveWeeks').doc(weekKey);
    const dailySnap = await tx.get(dailyRef);
    const weekSnap = await tx.get(weekRef);
    const dailyDays = dailySnap.exists && Array.isArray(dailySnap.data().days) ? dailySnap.data().days : [];
    const weeklyEntry = weekSnap.exists ? weekSnap.data() : null;
    const computed = computeDailyResetUpdate(mainData, dailyDays, weeklyEntry);
    tx.set(mainRef, computed.newMainData);
    tx.set(dailyRef, { days: computed.newDailyDays });
    tx.set(weekRef, computed.newWeeklyEntry);
    return 'archived ' + mainData.lastActivityDate + ' into week ' + weekKey;
  });
  logger.info('daily reset: ' + result);
});

// Every minute: the table PDFs queued by the "שליחה" button of הנוסע המתמיד
// (pdfOutbox, status "pending") are e-mailed to the address set in the admin
// page (meta/pdfSettings), and the document is marked sent or failed. The big
// PDF text is removed once it is sent.
exports.sendPendingPdfs = onSchedule({
  schedule: '* * * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1',
  secrets: [SMTP_USER, SMTP_PASS]
}, async () => {
  const db = admin.firestore();
  const mainRef = db.collection(FIRESTORE_COLLECTION).doc(STORAGE_KEY);
  const outbox = mainRef.collection('pdfOutbox');

  // Old finished documents are cleaned up.
  const old = await outbox.where('createdAt', '<', new Date(Date.now() - MAX_AGE_MS).toISOString()).get();
  await Promise.all(old.docs.filter((d) => d.data().status !== 'pending').map((d) => d.ref.delete()));

  const pending = await outbox.where('status', '==', 'pending').get();
  if (pending.empty) return;
  const settings = await mainRef.collection('meta').doc('pdfSettings').get();
  const email = settings.exists ? (settings.data().email || '') : '';
  const user = SMTP_USER.value();
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass: SMTP_PASS.value() }
  });
  // The documents of one batch (the weeks of one send) go out together, in one
  // e-mail with a file for each; a document without a batch goes out alone.
  const groups = new Map();
  for (const docSnap of pending.docs){
    const data = docSnap.data();
    const key = data.batchId || docSnap.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(docSnap);
  }
  for (const [key, docs] of groups){
    docs.sort((a, b) => (a.data().batchIndex || 0) - (b.data().batchIndex || 0));
    const size = docs[0].data().batchSize || 1;
    const ageMs = Date.now() - new Date(docs[0].data().createdAt || 0).getTime();
    // A batch that is not all here yet waits (the page writes it all at once, so this is rare).
    if (docs.length < size && ageMs < 5 * 60 * 1000) continue;
    const result = await sendQueuedBatch(docs.map((d) => d.data()), email, transporter, user);
    for (const docSnap of docs){
      if (result.status === 'sent'){
        await docSnap.ref.update({ status: 'sent', sentAt: new Date().toISOString(), to: email, pdfBase64: admin.firestore.FieldValue.delete() });
      } else {
        await docSnap.ref.update({ status: 'failed', error: result.error });
      }
    }
    if (result.status !== 'sent') logger.error('PDF e-mail failed', { batch: key, error: result.error });
  }
});

// Every Sunday at 03:00 Israel time: a copy of the class data (the main
// document, the daily archive, the settings and every archived week) is saved
// in the "backups" collection, so a mistake in the site or a bad edit can be
// undone. The last 8 weekly copies are kept. The copy is split in two documents
// so it never reaches the 1MB limit of one document.
exports.weeklyBackup = onSchedule({
  schedule: '0 3 * * 0',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1'
}, async () => {
  const db = admin.firestore();
  const mainRef = db.collection(FIRESTORE_COLLECTION).doc(STORAGE_KEY);
  const backups = mainRef.collection('backups');
  const stamp = new Date().toISOString().slice(0, 10);
  const savedAt = new Date().toISOString();
  const [mainSnap, metaSnap, weeksSnap] = await Promise.all([
    mainRef.get(), mainRef.collection('meta').get(), mainRef.collection('archiveWeeks').get()
  ]);
  const meta = {};
  metaSnap.forEach((d) => { meta[d.id] = d.data(); });
  await backups.doc('weekly-' + stamp).set({ savedAt, main: mainSnap.exists ? mainSnap.data() : null, meta });
  await backups.doc('weekly-' + stamp + '-weeks').set({ savedAt, weeks: weeksSnap.docs.map((d) => d.data()) });
  // Keep the last 8 weekly copies.
  const all = (await backups.get()).docs.map((d) => d.id).filter((id) => /^weekly-\d{4}-\d\d-\d\d$/.test(id)).sort();
  for (const id of all.slice(0, Math.max(0, all.length - 8))){
    await backups.doc(id).delete();
    await backups.doc(id + '-weeks').delete();
  }
  logger.info('weekly backup saved: ' + stamp);
});

// The daily reset's date math (which day it is, which week) must follow
// Israel time, not the server's UTC clock. Set before anything reads a date.
process.env.TZ = 'Asia/Jerusalem';

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const https = require('https');
const { computeDailyResetUpdate, isLiveDayDueForArchive, getWeekKey } = require('./daily-reset');

admin.initializeApp();

const STORAGE_KEY = 'classroom-points-v1';
const FIRESTORE_COLLECTION = 'classroom_points';

const SMS4FREE_KEY = defineSecret('SMS4FREE_KEY');
const SMS4FREE_USER = defineSecret('SMS4FREE_USER');
const SMS4FREE_PASS = defineSecret('SMS4FREE_PASS');

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

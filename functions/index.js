const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const https = require('https');

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

// Runs every minute, but only on Saturday night 20:00-22:59 Israel time (the
// sending window admin.html enforces for scheduling); picks up any "pending"
// doc in scheduledSms whose sendAt has arrived and actually sends it via the sms4free API, independent of
// whether admin.html is open anywhere. See admin.html's "תזמון שליחה" button
// (writes the pending docs this reads) and functions/README.md (deployment).
exports.sendScheduledSms = onSchedule({
  schedule: '* 20-22 * * 6',
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

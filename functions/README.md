# הפעלת שליחה מתוזמנת של SMS

הקובץ `functions/index.js` הוא פונקציית שרת (Cloud Function) שרצה כל דקה, בודקת אם יש הודעות SMS מתוזמנות ב-`admin.html` שהגיע זמנן, ושולחת אותן בפועל דרך ה-API של sms4free - גם אם שום דף לא פתוח באותו רגע. כדי שזה יעבוד צריך לפרוס אותה פעם אחת לפרויקט Firebase. את זה אפשר לעשות מ-Cloud Shell (אותו מקום שבו הרצת קודם את פקודות ה-`gcloud` להפעלת הגיבוי).

## שלבי ההתקנה (פעם אחת)

1. **לפתוח Cloud Shell** ולהריץ:
   ```bash
   git clone https://github.com/pshita/point.git
   cd point
   ```

2. **להתקין את כלי השורה של Firebase** (אם עוד לא מותקן):
   ```bash
   npm install -g firebase-tools
   ```

3. **להתחבר לחשבון Firebase**:
   ```bash
   firebase login --no-localhost
   ```
   זה ייתן קישור - לפתוח אותו בדפדפן, לאשר את ההתחברות, ולהדביק את הקוד שמתקבל בחזרה ב-Cloud Shell.

4. **לשמור את פרטי ההתחברות ל-sms4free בסוד מאובטח** (לא בקוד בגלוי, בניגוד לקובץ `sms-config.js` שמשמש את הדף עצמו):
   ```bash
   firebase functions:secrets:set SMS4FREE_KEY
   firebase functions:secrets:set SMS4FREE_USER
   firebase functions:secrets:set SMS4FREE_PASS
   ```
   כל פקודה תשאל לערך - להדביק את המפתח / שם המשתמש / הסיסמה המתאימים (אותם ערכים שכבר נמצאים ב-`sms-config.js`).

5. **להתקין את התלויות של הפונקציה ולפרוס אותה**:
   ```bash
   cd functions
   npm install
   cd ..
   firebase deploy --only functions
   ```
   בפעם הראשונה ייתכן שתתבקש לאשר הפעלת כמה שירותי Google Cloud (Cloud Functions, Cloud Scheduler, Cloud Build, Artifact Registry, Eventarc) - לאשר (לענות y) לכל בקשה כזו. הפריסה עצמה יכולה לקחת כמה דקות.

## בדיקה שזה עובד

לאחר הפריסה, אפשר לתזמן הודעת ניסיון קרובה (כמה דקות מהרגע הנוכחי) בעמוד שליחת ה-SMS באדמין, ולבדוק:
- בלשונית "הודעות מתוזמנות שעדיין לא נשלחו" היא מופיעה כ"מחכה".
- אחרי הזמן שנקבע (עד דקה איחור, כי הפונקציה בודקת כל דקה) ההודעה בפועל מגיעה לנמען.
- את הלוגים של הפונקציה אפשר לראות ב-Cloud Shell עם:
  ```bash
  firebase functions:log --only sendScheduledSms
  ```

## אם משנים את פרטי ההתחברות ל-sms4free בעתיד

מריצים שוב את שלב 4 (`firebase functions:secrets:set ...`) עם הערך החדש, ואז פורסים מחדש (`firebase deploy --only functions`).

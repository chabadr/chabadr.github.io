# הפעלת שליחה מתוזמנת של SMS

בקובץ `functions/index.js` יש שתי פונקציות שרת: `dailyReset` - כל לילה ב-01:00 (שעון ישראל) מעביר את היום שהסתיים לארכיון ומתחיל לוח חדש, גם אם אף דף לא פתוח (אותה לוגיקה כמו ב-index.html, מועתקת ל-`functions/daily-reset.js`); ו-`sendScheduledSms` - פונקציית שרת (Cloud Function) שרצה כל 20 דקות בשבת וביום ראשון בין 19:00 ל-22:00 (שעון ישראל; העמוד מאפשר לתזמן רק לחלון הזה), בודקת אם יש הודעות SMS מתוזמנות ב-`admin.html` שהגיע זמנן, ושולחת אותן בפועל דרך ה-API של sms4free - גם אם שום דף לא פתוח באותו רגע. כדי שזה יעבוד צריך לפרוס אותה פעם אחת לפרויקט Firebase. את זה אפשר לעשות מ-Cloud Shell (אותו מקום שבו הרצת קודם את פקודות ה-`gcloud` להפעלת הגיבוי).

## שלבי ההתקנה (פעם אחת)

1. **לפתוח Cloud Shell** ולהריץ:
   ```bash
   git clone https://github.com/chabadr/chabadr.github.io.git
   cd chabadr.github.io
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
- אחרי הזמן שנקבע (עד 20 דקות איחור, כי הפונקציה בודקת כל 20 דקות בתוך החלון) ההודעה בפועל מגיעה לנמען.
- את הלוגים של הפונקציה אפשר לראות ב-Cloud Shell עם:
  ```bash
  firebase functions:log --only sendScheduledSms
  ```

## אם משנים את פרטי ההתחברות ל-sms4free בעתיד

מריצים שוב את שלב 4 (`firebase functions:secrets:set ...`) עם הערך החדש, ואז פורסים מחדש (`firebase deploy --only functions`).

## שליחת טבלת הנוסע המתמיד במייל (כפתור "שליחה")

כפתור "שליחה" בטבלת הנוסע המתמיד מכין קובץ PDF של הטבלה שמוצגת, ושם אותו בתור (`pdfOutbox`). הפונקציה `sendPendingPdfs` רצה כל דקה, שולחת את הקובץ במייל לכתובת שמוגדרת בעמוד הניהול (לשונית "משתנים"), ומסמנת "נשלח" או "נכשל".

כדי שהפונקציה תוכל לשלוח מייל צריך חשבון מייל ששולח (כרגע Gmail):

1. בחשבון ה-Gmail: להפעיל אימות דו-שלבי, ואז ליצור **סיסמת אפליקציה** (חשבון Google ← אבטחה ← סיסמאות אפליקציה). מקבלים סיסמה של 16 תווים.
2. ב-Cloud Shell, בתיקיית הפרויקט:
   ```bash
   firebase functions:secrets:set SMTP_USER   # כתובת ה-Gmail השולח
   firebase functions:secrets:set SMTP_PASS   # סיסמת האפליקציה (16 תווים)
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```
3. בעמוד הניהול ← "משתנים": להזין את הכתובת שאליה נשלחת הטבלה.

המייל יוצא מכתובת ה-Gmail שהוגדרה ב-`SMTP_USER`.

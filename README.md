# כיתה ז - לוח נקודות

אתר סטטי (HTML/CSS/JS, בלי build), מתפרסם ב-GitHub Pages: https://chabadr.github.io/
הנתונים נשמרים ב-Firestore (פרויקט `point-3a9cf`) ומשותפים לכל המחשבים.

## עמודים

- `index.html` - לוח הכיתה, המתיבתא, הארכיון והנוסע המתמיד.
- `z1.html` (הקישור `/z1`) - הנוסע המתמיד ז1.
- `admin.html` - ניהול: משתנים, עדכוני הורים, שליחת הודעות, קיוסק.
- `up.html` (הקישור `/up`) - טופס עדכון להורים. `parent-update.html` מפנה אליו (קישורים ישנים בהודעות).

## קבצים נוספים

- `functions/` - פונקציות השרת (יום חדש ב-01:00, שליחת SMS מתוזמנת). הוראות ב-`functions/README.md`.
- `kiosk/` - הגדרת מחשב הכיתה כקיוסק. הוראות ב-`kiosk/README.md`.
- `firestore.rules` - חוקי הגישה ל-Firestore.
- `sw.js`, `manifest*.webmanifest`, `icons/` - עבודה בלי אינטרנט והתקנה כאפליקציה.

## הרצה מקומית

```bash
python3 -m http.server 8000
# ואז נכנסים ל-http://localhost:8000
```

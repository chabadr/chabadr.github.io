# מחשב הכיתה כקיוסק

`setup-kiosk.ps1` הופך את מחשב הכיתה לקיוסק:

- משתמש Windows נפרד (`kita`) שנכנס אוטומטית בהדלקה ומקבל את Edge **במקום** שולחן העבודה. אין שורת משימות, אין תפריט התחל ואין סייר קבצים, כך שאי אפשר לפתוח תוכנות אחרות.
- Edge רץ בגלישה רגילה, לא InPrivate, כך שהאתר שומר נתונים.
- אפשר לגלוש רק לאתר הכיתה ול-Mashov.
- אין הורדות, אין חלונות לפתיחת קבצים, אין כלי מפתחים, ו-Edge לא שומר סיסמאות.
- אם סוגרים את Edge, הוא נפתח שוב תוך כמה שניות.
- כל ההגבלות חלות רק על המשתמש `kita`. החשבון הרגיל של המנהל לא מושפע.

## התקנה

מריצים ב-PowerShell **כמנהל**:

```powershell
iwr https://chabadr.github.io/kiosk/setup-kiosk.ps1 -OutFile $env:TEMP\setup-kiosk.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\setup-kiosk.ps1
```

הסקריפט מבקש סיסמה למשתמש `kita`. אחרי זה מפעילים את המחשב מחדש.

## יציאה מהקיוסק

Ctrl+Alt+Del ← **החלף משתמש**, ונכנסים לחשבון המנהל.

## ביטול

```powershell
iwr https://chabadr.github.io/kiosk/remove-kiosk.ps1 -OutFile $env:TEMP\remove-kiosk.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\remove-kiosk.ps1
```

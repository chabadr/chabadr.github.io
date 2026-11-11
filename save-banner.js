// The "save failed" notice shared by index.html and admin.html: a large red
// box fixed in the top corner of the screen, above the tables, saying why.
// It never blocks the page - work goes on underneath while the failed saves
// keep retrying - and it stays up until every one of them has gone through.

const BANNER_CSS = `
  .save-failed-banner{
    position: fixed;
    left: 16px;
    top: 12px;
    z-index: 400;
    max-width: 260px;
    padding: 18px 20px;
    border-radius: 14px;
    background: #9C3B3B;
    color: #fff;
    font-family: 'Rubik', sans-serif;
    text-align: center;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
    pointer-events: none;
    direction: rtl;
  }
  .save-failed-banner .title{ font-size: 24px; font-weight: 800; line-height: 1.2; }
  .save-failed-banner .reason{ font-size: 15px; font-weight: 700; margin-top: 8px; line-height: 1.35; }
  .save-failed-banner .sub{ font-size: 13px; font-weight: 500; margin-top: 8px; line-height: 1.4; opacity: 0.9; }
`;

let banner = null;

export const SAVE_STALLED_REASON = 'השמירה לא הסתיימה תוך כמה שניות - כנראה אין חיבור לאינטרנט או שהוא איטי מאוד';

// Turns a Firestore save error into a short Hebrew reason.
export function describeSaveError(e){
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'אין חיבור לאינטרנט במחשב הזה';
  const code = (e && e.code) || '';
  const msg = (e && e.message) || String(e || '');
  if (code === 'permission-denied') return 'השרת דחה את השמירה (אין הרשאה)';
  if (code === 'unavailable' || /offline|network|fetch/i.test(msg)) return 'אין חיבור לשרת הנתונים';
  if (code === 'deadline-exceeded') return 'השרת לא ענה בזמן';
  if (code === 'resource-exhausted') return 'השרת עמוס כרגע';
  if (code === 'aborted') return 'שמירה מקבילה ממחשב אחר - מנסה שוב';
  return 'שגיאה: ' + msg;
}

export function setSaveFailedBanner(show, reason){
  if (!show){
    if (banner) banner.style.display = 'none';
    return;
  }
  if (!banner){
    const style = document.createElement('style');
    style.textContent = BANNER_CSS;
    document.head.appendChild(style);
    banner = document.createElement('div');
    banner.className = 'save-failed-banner';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = '<div class="title">⚠ שמירה נכשלה</div><div class="reason"></div>'
      + '<div class="sub">מנסה לשמור שוב אוטומטית. אפשר להמשיך להזין - שום דבר לא נמחק.</div>';
    document.body.appendChild(banner);
  }
  const reasonEl = banner.querySelector('.reason');
  reasonEl.textContent = reason ? 'סיבה: ' + reason : '';
  reasonEl.style.display = reason ? '' : 'none';
  banner.style.display = '';
}

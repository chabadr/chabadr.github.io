// The "save failed" notice shared by index.html and admin.html: a large red
// box fixed on the side of the screen. It never blocks the page - work goes
// on underneath while the failed saves keep retrying - and it stays up until
// every one of them has gone through.

const BANNER_CSS = `
  .save-failed-banner{
    position: fixed;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 400;
    max-width: 230px;
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
  .save-failed-banner .sub{ font-size: 13.5px; font-weight: 500; margin-top: 8px; line-height: 1.4; opacity: 0.95; }
`;

let banner = null;

export function setSaveFailedBanner(show){
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
    banner.innerHTML = '<div class="title">⚠ שמירה נכשלה</div>'
      + '<div class="sub">מנסה לשמור שוב אוטומטית. אפשר להמשיך להזין - שום דבר לא נמחק.</div>';
    document.body.appendChild(banner);
  }
  banner.style.display = '';
}

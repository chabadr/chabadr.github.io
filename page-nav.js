// The one page switcher (כיתה / מתיבתא / ניהול), shared by index.html and
// admin.html. It sits fixed in the top-right corner, invisible and taking no
// room in the layout until the mouse reaches it (or a tap there on a touch
// screen), then floats above whatever content is underneath.

const NAV_CSS = `
  .page-nav{
    position: fixed;
    top: 0;
    right: 0;
    z-index: 250;
    padding: 6px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .page-nav:hover, .page-nav.open{ opacity: 1; }
  .page-nav-btn{
    width: 40px;
    height: 40px;
    border-radius: 10px;
    border: 1px solid #D9D2BC;
    background: #fff;
    color: #22304A;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(34,48,74,0.18);
  }
  .page-nav-list{
    display: none;
    position: absolute;
    top: 50px;
    right: 6px;
    background: #fff;
    border: 1px solid #D9D2BC;
    border-radius: 10px;
    box-shadow: 0 6px 18px rgba(34,48,74,0.18);
    overflow: hidden;
    min-width: 120px;
  }
  .page-nav.open .page-nav-list{ display: block; }
  .page-nav-option{
    display: block;
    padding: 10px 16px;
    font-family: 'Rubik', sans-serif;
    font-weight: 600;
    font-size: 15px;
    color: #22304A;
    text-align: right;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
  }
  .page-nav-option:hover{ background: #FBF1D9; }
  .page-nav-option.active{ color: #B8902E; font-weight: 700; }
  .page-nav-reload{ border-top: 1px solid #D9D2BC; }
`;

export const PAGES = [
  { key: 'main', label: 'כיתה', href: 'index.html' },
  { key: 'metivta', label: 'מתיבתא', href: 'index.html?view=metivta' },
  { key: 'admin', label: 'ניהול', href: 'admin.html' }
];

// getCurrent(): the key of the page being shown right now.
// onNavigate(key): optional in-page switch; return true when it handled the
// switch itself, otherwise the browser follows the page's href.
export function mountPageNav({ getCurrent, onNavigate }){
  const style = document.createElement('style');
  style.textContent = NAV_CSS;
  document.head.appendChild(style);

  const nav = document.createElement('div');
  nav.className = 'page-nav';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'page-nav-btn';
  btn.textContent = '☰';
  btn.title = 'מעבר בין עמודים';
  const list = document.createElement('div');
  list.className = 'page-nav-list';

  function refreshActive(){
    const current = getCurrent();
    list.querySelectorAll('.page-nav-option').forEach(a => a.classList.toggle('active', a.dataset.key === current));
  }

  PAGES.forEach(page => {
    const a = document.createElement('a');
    a.className = 'page-nav-option';
    a.dataset.key = page.key;
    a.href = page.href;
    a.textContent = page.label;
    a.addEventListener('click', (e) => {
      nav.classList.remove('open');
      if (onNavigate && onNavigate(page.key)){
        e.preventDefault();
        refreshActive();
      }
    });
    list.appendChild(a);
  });

  // Reloading the page without a keyboard (touch screen kiosk).
  const reload = document.createElement('a');
  reload.className = 'page-nav-option page-nav-reload';
  reload.href = '#';
  reload.textContent = '⟳ רענון';
  reload.addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
  list.appendChild(reload);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshActive();
    nav.classList.toggle('open');
  });
  list.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => nav.classList.remove('open'));

  nav.appendChild(btn);
  nav.appendChild(list);
  document.body.appendChild(nav);
  return { refreshActive };
}

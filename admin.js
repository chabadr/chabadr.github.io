import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { initializeFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, collection, query, orderBy, limit, getDocs, runTransaction } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { mountPageNav } from "./page-nav.js";
import { setSaveFailedBanner, describeSaveError, SAVE_STALLED_REASON } from "./save-banner.js";

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const STORAGE_KEY = 'classroom-points-v1';
const FIRESTORE_COLLECTION = 'classroom_points';
// The code is checked on the server (unlockDevice), never here: this file is public.
let enteredCode = ''; // sent to the server with every SMS (it checks the code itself)

// Keep in sync with STUDENT_NAMES in index.html.
const STUDENT_NAMES = [
  'צאלי', 'ישרוליק', 'נתנאל', 'מענדי ה.', 'מענדי ח.', 'אלעאי', 'יהונתן', 'איתן', 'מענדי ל.', 'שלוימי', 'מוישלה', 'לוי ס.',
  'שמוליק ע.', 'מולי', 'שלום', 'חננאל', 'שמוליק צ.', 'אושר', 'שמעון', 'מוטי', 'לוי ק.', 'נועם', 'משה'
];
// Keep in sync with METIVTA_EXTRA_NAMES in index.html.
const METIVTA_EXTRA_NAMES = [
  'יהונתן', 'נריה', 'יהודה', 'חסדיאל', 'אוריאל', 'מענדל', 'שניאור', 'מענדי דר.', 'מענדי זכ.', 'עוזי', 'מענדי יא.',
  'אופיר', 'לוי', 'מענדי מז.', 'מענדי מע.', 'אברמי', 'שמואל', 'מענדי סמ.', 'ברוכי', 'איזיק', 'בער', 'רמי', 'ניתאי'
];
// Keep in sync with WEEKLY_PARENT_FIELD_DEFS in index.html.
const FIELD_LABELS = {
  chitas: 'חת"ת', shema: 'ישן חסיד', netilatYadaim: 'קם חסיד',
  minchaMaariv: 'מנחה מעריב', mikveh: 'מקווה שישי', dvarTorah: 'שיחה'
};
const FIELD_ORDER = ['chitas', 'shema', 'netilatYadaim', 'minchaMaariv', 'mikveh', 'dvarTorah'];

const DAY_COUNT_OPTIONS = [
  ...Array.from({ length: 15 }, (_, i) => i + 1).map(n => ({ value: String(n), label: n === 1 ? 'יום אחרון' : n + ' ימים אחרונים' })),
  { value: 'all', label: 'כל הימים' }
];

const DEFAULT_TEMPLATE = 'שלום,\nעדכון שבועי עבור {שם} מהמתיבתא:\nנוכחות: {נוכחות}\n\nלעדכון נתונים: {קישור}';

// "נוכחות" counts every day present at all, including late/left-early/
// disturbed days - matching the "נוכחות" column in index.html's archive.
const STAT_FIELDS = [
  { key: 'attendance', label: 'נוכחות', placeholder: '{נוכחות}' },
  { key: 'onTime', label: 'בזמן', placeholder: '{בזמן}' },
  { key: 'late', label: 'איחור', placeholder: '{איחור}' },
  { key: 'leftEarly', label: 'מוקדם', placeholder: '{מוקדם}' },
  { key: 'disturbed', label: 'הפרעות', placeholder: '{הפרעות}' }
];

const SMS4FREE_ERROR_MESSAGES = {
  0: 'שגיאה כללית',
  '-1': 'מפתח, שם משתמש או סיסמה שגויים',
  '-2': 'שם או מספר שולח ההודעה שגוי',
  '-3': 'לא נמצאו נמענים',
  '-4': 'לא ניתן לשלוח הודעה, יתרת הודעות פנויות נמוכה',
  '-5': 'הודעה לא מתאימה',
  '-6': 'צריך לאמת מספר שולח'
};

const TABS = [
  { key: 'phones', label: 'משתנים' },
  { key: 'sms', label: 'שליחת הודעות' },
  { key: 'edits', label: 'היסטוריית עדכונים' }
];

const DEFAULT_SENDER = '058-4012374';

const app = document.getElementById('app');
let db = null;
let firebaseApp = null;
let activeTab = 'phones';

function normalizePhone(v){
  return (v || '').replace(/[\s-]/g, '').trim();
}

function metivtaRecordHasFlags(s){
  const f = s && s.metivtaFlags;
  return !!(f && (f.ok || f.late || f.leftEarly || f.noBook || (f.disturbCount || 0) > 0));
}

// Keep in sync with metivtaEntryHasData in index.html (a day counts only if
// some Metivta attendance was marked).
function metivtaEntryHasData(entry){
  const recs = [...(entry.students || []), ...(entry.metivtaExtraStudents || [])];
  return recs.some(r => metivtaRecordHasFlags(r));
}

function showCodePrompt(){
  app.innerHTML = '';

  const box = document.createElement('div');
  box.className = 'code-box';
  const msg = document.createElement('div');
  msg.textContent = 'הזן קוד לצפייה:';
  box.appendChild(msg);
  const input = document.createElement('input');
  input.type = 'password';
  input.inputMode = 'numeric';
  box.appendChild(input);
  const errorEl = document.createElement('div');
  errorEl.className = 'code-error';
  box.appendChild(errorEl);
  const btn = document.createElement('button');
  btn.textContent = 'כניסה';
  box.appendChild(btn);
  app.appendChild(box);

  // The server checks the code and marks this browser as admin; only then do
  // the database rules let it read the private data.
  let busy = false;
  async function trySubmit(){
    const code = input.value.trim();
    if (!code || busy) return;
    busy = true;
    btn.disabled = true;
    errorEl.textContent = 'בודק…';
    try{
      const auth = getAuth(firebaseApp);
      if (!auth.currentUser) await signInAnonymously(auth);
      await httpsCallable(getFunctions(firebaseApp, 'us-central1'), 'unlockDevice')({ code });
      await auth.currentUser.getIdToken(true); // picks up the admin mark
      enteredCode = code;
      renderShell();
      return;
    } catch(e){
      const c = e && e.code;
      errorEl.textContent = c === 'functions/permission-denied' ? 'קוד שגוי, נסה שוב'
        : c === 'functions/resource-exhausted' ? 'יותר מדי ניסיונות שגויים. נסה שוב בעוד 10 דקות.'
        : 'אין חיבור לשרת, נסה שוב (' + ((e && e.message) || e) + ')';
      input.value = '';
      input.focus();
    } finally{
      busy = false;
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', trySubmit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') trySubmit(); });
  setTimeout(() => input.focus(), 50);
}

function renderShell(){
  app.innerHTML = '';

  const nav = document.createElement('div');
  nav.className = 'tab-nav';
  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (tab.key === activeTab ? ' active' : '');
    btn.textContent = tab.label;
    btn.dataset.tabKey = tab.key;
    btn.addEventListener('click', () => switchTab(tab.key));
    nav.appendChild(btn);
  });
  // The הנוסע המתמיד ז1 page is not in the page menu - it is opened from here.
  const z1Btn = document.createElement('a');
  z1Btn.className = 'tab-btn tab-link';
  z1Btn.href = 'z1.html';
  z1Btn.textContent = 'הנוסע המתמיד ז1 ←';
  nav.appendChild(z1Btn);
  app.appendChild(nav);

  const content = document.createElement('div');
  content.id = 'tabContent';
  app.appendChild(content);

  renderActiveTab();
  refreshRequestsBadge();
}

function switchTab(key){
  activeTab = key;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tabKey === key));
  renderActiveTab();
}

function renderActiveTab(){
  const content = document.getElementById('tabContent');
  content.innerHTML = '';
  if (activeTab === 'phones') renderPhonesTab(content);
  else if (activeTab === 'sms') renderSmsTab(content);
  else if (activeTab === 'edits') renderEditsTab(content);
}

// ---------- Tab: בקשות אישור ----------
// A parent update of a week older than two weeks is not applied by the form: it
// waits here until it is approved (then it is written to the week) or rejected.
const requestsRef = () => collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'parentRequests');

async function refreshRequestsBadge(){
  const btn = document.querySelector('.tab-btn[data-tab-key="edits"]');
  const sum = document.getElementById('requestsSummary');
  if (!btn) return;
  try{
    const snaps = await getDocs(requestsRef());
    let pending = 0;
    snaps.forEach(d => { if ((d.data() || {}).status === 'pending') pending++; });
    btn.textContent = 'היסטוריית עדכונים' + (pending ? ' (' + pending + ')' : '');
    btn.style.color = pending ? 'var(--danger)' : '';
    if (sum){
      sum.textContent = 'בקשות אישור' + (pending ? ' (' + pending + ')' : '');
      sum.style.color = pending ? 'var(--danger)' : '';
    }
  } catch(e){}
}

// The same change the parents' form makes to a week.
async function applyParentValues(req){
  const weekRef = doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'archiveWeeks', req.weekKey);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(weekRef);
    const weeklyEntry = snap.exists() ? snap.data() : {
      type: 'weekly',
      title: 'הנוסע המתמיד',
      weekKey: req.weekKey,
      weekStart: req.weekStart,
      date: req.weekStart,
      students: [],
      weekParsha: null
    };
    if (!Array.isArray(weeklyEntry.students)) weeklyEntry.students = [];
    let rec = weeklyEntry.students.find(x => x.id === req.studentId);
    if (!rec){
      rec = { id: req.studentId, morning: 0, tefila: 0, mikve: 0, minusDelta: 0, bonus: 0, days: {} };
      weeklyEntry.students.push(rec);
    }
    Object.assign(rec, req.values, { parentSubmitted: true });
    if (req.parsha) weeklyEntry.weekParsha = req.parsha;
    tx.set(weekRef, weeklyEntry);
  });
}

async function renderRequestsTab(container){
  const status = document.createElement('div');
  status.className = 'loading';
  status.textContent = 'טוען…';
  container.appendChild(status);
  try{
    const snaps = await getDocs(requestsRef());
    const all = [];
    snaps.forEach(d => all.push({ id: d.id, ...d.data() }));
    all.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
    status.remove();
    const pending = all.filter(r => r.status === 'pending');
    const handled = all.filter(r => r.status !== 'pending').slice(0, 20);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'הורים יכולים לעדכן עד שבועיים אחורה. עדכון לשבוע ישן יותר מחכה כאן לאישור, ועד האישור הוא לא נכנס לטבלה.';
    container.appendChild(hint);

    const valuesText = (v) => FIELD_ORDER.map(key => {
      const val = (v || {})[key];
      return (FIELD_LABELS[key] || key) + ': ' + (typeof val === 'boolean' ? (val ? '✓' : '—') : (val !== undefined ? val : ''));
    }).join(' · ');
    const whenText = (iso) => {
      const when = new Date(iso);
      return when.toLocaleDateString('he-IL') + ' ' + when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    };

    if (!pending.length){
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'אין בקשות שמחכות לאישור.';
      container.appendChild(empty);
    }
    pending.forEach(req => {
      const card = document.createElement('div');
      card.className = 'card';
      const head = document.createElement('div');
      head.style.fontWeight = '700';
      head.textContent = req.studentName + ' · ' + (req.weekLabel || '').replace(/^פרשת\s+/, '');
      card.appendChild(head);
      const when = document.createElement('div');
      when.className = 'hint';
      when.textContent = 'נשלח ב-' + whenText(req.submittedAt);
      card.appendChild(when);
      const vals = document.createElement('div');
      vals.style.margin = '8px 0';
      vals.style.lineHeight = '1.7';
      vals.textContent = valuesText(req.values);
      card.appendChild(vals);
      const row = document.createElement('div');
      row.className = 'row-inline';
      const msg = document.createElement('span');
      msg.className = 'save-status';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'small-btn';
      approve.textContent = 'אישור';
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'small-btn';
      reject.textContent = 'דחייה';
      const done = async (fn, okText) => {
        approve.disabled = reject.disabled = true;
        msg.className = 'save-status';
        msg.textContent = 'מעדכן…';
        try{
          await fn();
          card.remove();
          refreshRequestsBadge();
          if (!container.querySelector('.card')) renderActiveTab();
        } catch(e){
          approve.disabled = reject.disabled = false;
          msg.className = 'save-status err';
          msg.textContent = 'הפעולה נכשלה: ' + describeSaveError(e);
        }
      };
      approve.addEventListener('click', () => done(async () => {
        await applyParentValues(req);
        try{
          await addDoc(collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'parentUpdateLog'), {
            studentId: req.studentId, studentName: req.studentName, weekKey: req.weekKey, weekLabel: req.weekLabel,
            values: req.values, submittedAt: new Date().toISOString()
          });
        } catch(e){}
        await setDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'parentRequests', req.id), { status: 'approved', handledAt: new Date().toISOString() }, { merge: true });
      }));
      reject.addEventListener('click', () => done(async () => {
        await setDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'parentRequests', req.id), { status: 'rejected', handledAt: new Date().toISOString() }, { merge: true });
      }));
      row.appendChild(approve);
      row.appendChild(reject);
      row.appendChild(msg);
      card.appendChild(row);
      container.appendChild(card);
    });

    if (handled.length){
      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = 'בקשות שטופלו';
      container.appendChild(title);
      handled.forEach(req => {
        const line = document.createElement('div');
        line.className = 'hint';
        line.textContent = (req.status === 'approved' ? '✓ אושר' : '✗ נדחה') + ' · ' + req.studentName + ' · ' + (req.weekLabel || '').replace(/^פרשת\s+/, '') + ' · ' + whenText(req.submittedAt);
        container.appendChild(line);
      });
    }
  } catch(e){
    status.className = 'loading';
    status.textContent = 'שגיאה בטעינה: ' + (e && e.message ? e.message : String(e));
  }
}

// ---------- Tab: היסטוריית עדכונים ----------
// Every edit of the archive tables and of הנוסע המתמיד, by day (each day opens
// and closes). The history is kept from the day it was added.
// A dropdown (closed until pressed) with a title; returns { box, body }.
let requestsDropdownOpen = false;
function buildDropdown(title, open){
  const box = document.createElement('details');
  box.className = 'edits-day edits-group';
  if (open) box.open = true;
  const sum = document.createElement('summary');
  sum.textContent = title;
  box.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'edits-list';
  box.appendChild(body);
  return { box, body, sum };
}

async function renderEditsTab(container){
  // First: the requests waiting for an approval. Then one dropdown for each of
  // the tables the edits were made in.
  const req = buildDropdown('בקשות אישור', requestsDropdownOpen);
  req.sum.id = 'requestsSummary';
  req.box.addEventListener('toggle', () => { requestsDropdownOpen = req.box.open; });
  container.appendChild(req.box);
  renderRequestsTab(req.body);
  refreshRequestsBadge();
  const logHost = document.createElement('div');
  container.appendChild(logHost);
  container = logHost;
  const status = document.createElement('div');
  status.className = 'loading';
  status.textContent = 'טוען…';
  container.appendChild(status);
  try{
    const snaps = await getDocs(collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'editLog'));
    const days = [];
    snaps.forEach(d => { const v = d.data(); if (v && Array.isArray(v.entries) && v.entries.length) days.push({ day: v.day || d.id, entries: v.entries }); });
    days.sort((a, b) => (a.day < b.day ? 1 : -1));
    status.remove();
    const hebrewDay = (dayKey) => {
      const d = new Date(dayKey + 'T12:00:00');
      const letters = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
      const heb = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'long' }).format(d);
      return 'יום ' + letters[d.getDay()] + "' · " + heb + ' · ' + d.getDate() + '.' + (d.getMonth() + 1);
    };
    ['מתיבתא', 'ארכיון', 'הנוסע המתמיד'].forEach(tableName => {
    const group = buildDropdown(tableName, false);
    container.appendChild(group.box);
    const tableDays = days.map(d => ({ day: d.day, entries: d.entries.filter(e => e.table === tableName) })).filter(d => d.entries.length);
    if (!tableDays.length){
      group.body.textContent = 'עדיין אין עדכונים.';
      return;
    }
    tableDays.forEach(({ day, entries }, index) => {
      const details = document.createElement('details');
      details.className = 'edits-day';
      if (index === 0) details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = hebrewDay(day);
      const count = document.createElement('span');
      count.className = 'edits-day-count';
      count.textContent = '· ' + entries.length + (entries.length === 1 ? ' עדכון' : ' עדכונים');
      summary.appendChild(count);
      details.appendChild(summary);
      const list = document.createElement('div');
      list.className = 'edits-list';
      entries.slice().sort((a, b) => b.t - a.t).forEach(e => {
        const row = document.createElement('div');
        row.className = 'edit-row';
        const time = document.createElement('span');
        time.className = 'edit-time';
        time.textContent = new Date(e.t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        const tag = document.createElement('span');
        tag.className = 'edit-tag';
        tag.textContent = e.table;
        const name = document.createElement('span');
        name.className = 'edit-name';
        name.textContent = e.name;
        const what = document.createElement('span');
        what.textContent = e.field + (e.dayLabel ? ' · ' + e.dayLabel : '') + (e.table === 'הנוסע המתמיד' && e.week ? ' · ' + e.week : '');
        const change = document.createElement('span');
        change.className = 'edit-change';
        change.textContent = e.old + ' ← ' + e.new;
        [time, tag, name, what, change].forEach(x => row.appendChild(x));
        list.appendChild(row);
      });
      details.appendChild(list);
      group.body.appendChild(details);
    });
    });
  } catch(e){
    status.className = 'loading';
    status.textContent = 'שגיאה בטעינה: ' + (e && e.message ? e.message : String(e));
  }
}

// ---------- Tab: עדכוני הורים ----------
function buildLogTable(entries){
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  const table = document.createElement('table');
  table.className = 'log-table';

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  ['תלמיד', 'שבוע', 'תאריך ושעה'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    trh.appendChild(th);
  });
  FIELD_ORDER.forEach(key => {
    const th = document.createElement('th');
    th.textContent = FIELD_LABELS[key] || key;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  entries.forEach(entry => {
    const when = new Date(entry.submittedAt);
    const whenStr = when.toLocaleDateString('he-IL') + ' ' + when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    const v = entry.values || {};
    const tr = document.createElement('tr');
    const weekText = (entry.weekLabel || '').replace(/^פרשת\s+/, '');
    [entry.studentName || '', weekText, whenStr].forEach(text => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    FIELD_ORDER.forEach(key => {
      const td = document.createElement('td');
      const val = v[key];
      td.textContent = typeof val === 'boolean' ? (val ? '✓' : '—') : (val !== undefined ? val : '');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scrollWrap.appendChild(table);
  return scrollWrap;
}

async function renderHistoryTab(container){
  const status = document.createElement('div');
  status.className = 'loading';
  status.textContent = 'טוען…';
  container.appendChild(status);
  try{
    const logCollectionRef = collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'parentUpdateLog');
    const q = query(logCollectionRef, orderBy('submittedAt', 'desc'), limit(200));
    const snaps = await getDocs(q);
    status.remove();
    if (snaps.empty){
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'אין עדיין תשובות שהתקבלו.';
      container.appendChild(empty);
      return;
    }
    const entries = [];
    snaps.forEach(s => entries.push(s.data()));
    container.appendChild(buildLogTable(entries));
  } catch(e){
    status.className = 'err';
    status.textContent = 'שגיאה בטעינת היסטוריית התשובות: ' + (e && e.message ? e.message : String(e));
  }
}

// ---------- Shared: the Metivta student list ----------

// Parent-update form link for a main-group student ("up" - GitHub Pages
// serves up.html for it, so nobody has to type the .html).
function parentLinkFor(id){
  return new URL('up?id=' + id, location.href).href;
}

// Keep in sync with metivtaClassValue/metivtaClassLabel in index.html.
function metivtaClassLabelFrom(mainData, id, isExtra){
  const map = (isExtra ? mainData.metivtaExtraClass : mainData.metivtaClass) || {};
  const raw = map[id];
  const v = String((raw === undefined || raw === null || raw === '') ? (isExtra ? 1 : 2) : raw);
  return /^\d+$/.test(v) ? 'ז' + v : v;
}

// Every Metivta student (main group, then the extra group) with the same
// family/first name and class as the Metivta table in index.html, plus their
// parents' phones. "archived" = moved to that page's ארכיון table.
function buildRoster(mainData, phonesData){
  const archivedKeys = new Set(Array.isArray(mainData.metivtaArchivedKeys) ? mainData.metivtaArchivedKeys : []);
  const out = [];
  [
    { names: STUDENT_NAMES, isExtra: false, group: 'main', nameMap: mainData.metivtaNames || {} },
    { names: METIVTA_EXTRA_NAMES, isExtra: true, group: 'extra', nameMap: mainData.metivtaExtraNames || {} }
  ].forEach(({ names, isExtra, group, nameMap }) => {
    const phones = phonesData[group] || {};
    names.forEach((defaultName, idx) => {
      const id = idx + 1;
      const key = group + '-' + id;
      const entry = decodeMetivtaNameEntry(nameMap[id], defaultName);
      out.push({
        key, id, isExtra, group, order: out.length,
        family: entry.family,
        first: entry.first,
        name: metivtaFullNameFromEntry(entry),
        clsLabel: metivtaClassLabelFrom(mainData, id, isExtra),
        link: isExtra ? '' : parentLinkFor(id),
        father: (phones[id] && phones[id].father) || '',
        mother: (phones[id] && phones[id].mother) || '',
        archived: archivedKeys.has(key)
      });
    });
  });
  return out;
}

const ROSTER_SORT_COLUMNS = [
  { key: 'family', label: 'משפחה' },
  { key: 'first', label: 'פרטי' },
  { key: 'class', label: 'כיתה' }
];

function sortRoster(rows, sort){
  if (!sort.key) return rows.slice().sort((a, b) => a.order - b.order);
  const textOf = (r) => sort.key === 'family' ? r.family : sort.key === 'first' ? r.first : r.clsLabel;
  return rows.slice().sort((a, b) => {
    const ta = textOf(a), tb = textOf(b);
    if (!ta && tb) return 1;
    if (ta && !tb) return -1;
    return (ta.localeCompare(tb, 'he', { numeric: true }) * sort.dir) || (a.order - b.order);
  });
}

// Header cells for משפחה/פרטי/כיתה: click sorts א→ת, again reverses.
function appendRosterSortHeaders(trh, sort, onChange){
  ROSTER_SORT_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.className = 'sortable-th';
    th.textContent = col.label + (sort.key === col.key ? (sort.dir === 1 ? ' ▼' : ' ▲') : '');
    th.addEventListener('click', () => {
      if (sort.key === col.key) sort.dir = -sort.dir;
      else { sort.key = col.key; sort.dir = 1; }
      onChange();
    });
    trh.appendChild(th);
  });
}

function appendRosterNameCells(tr, r, withArchiveMark){
  const familyTd = document.createElement('td');
  familyTd.textContent = r.family;
  tr.appendChild(familyTd);
  const firstTd = document.createElement('td');
  firstTd.textContent = r.first;
  if (withArchiveMark && r.archived){
    const mark = document.createElement('span');
    mark.className = 'archived-mark';
    mark.textContent = ' (מתיבתא ארכיון)';
    firstTd.appendChild(mark);
  }
  tr.appendChild(firstTd);
  const classTd = document.createElement('td');
  classTd.textContent = r.clsLabel;
  tr.appendChild(classTd);
}

// ---------- The card that sends הנוסע המתמיד tables (PDF) by e-mail ----------
async function appendPdfCard(container){
    // Where the "שליחה" button of הנוסע המתמיד sends the table (as a PDF).
    const pdfSettingsRef = doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'pdfSettings');
    const pdfSnap = await getDoc(pdfSettingsRef);
    const pdfCard = document.createElement('div');
    pdfCard.className = 'card';
    const pdfTitle = document.createElement('div');
    pdfTitle.className = 'section-title';
    pdfTitle.textContent = 'שליחת טבלת הנוסע המתמיד (PDF)';
    pdfCard.appendChild(pdfTitle);
    const pdfHint = document.createElement('div');
    pdfHint.className = 'hint';
    pdfHint.textContent = 'כפתור "שליחה" בטבלת הנוסע המתמיד שולח אליה את הטבלה שמוצגת באותו רגע, כקובץ PDF. נשמר אוטומטית.';
    pdfCard.appendChild(pdfHint);
    const pdfRow = document.createElement('div');
    pdfRow.className = 'row-inline';
    const pdfInput = document.createElement('input');
    pdfInput.type = 'email';
    pdfInput.dir = 'ltr';
    pdfInput.placeholder = 'name@example.com';
    pdfInput.value = (pdfSnap.exists() && pdfSnap.data().email) || '';
    pdfRow.appendChild(pdfInput);
    const pdfStatus = document.createElement('span');
    pdfStatus.className = 'save-status';
    pdfRow.appendChild(pdfStatus);
    pdfCard.appendChild(pdfRow);

    // The "שליחה" button: a menu of the tables of הנוסע המתמיד (each week's
    // summary, or one of its days); the chosen one is sent as a PDF.
    const sendRow = document.createElement('div');
    sendRow.className = 'send-pdf-row';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn-secondary';
    sendBtn.textContent = 'שליחה ▾';
    sendRow.appendChild(sendBtn);
    const sendStatus = document.createElement('span');
    sendStatus.className = 'save-status';
    sendRow.appendChild(sendStatus);
    const sendMenu = document.createElement('div');
    sendMenu.className = 'send-pdf-menu';
    sendMenu.style.display = 'none';
    pdfCard.appendChild(sendRow);
    pdfCard.appendChild(sendMenu);
    container.appendChild(pdfCard);

    const weekLabel = (w) => {
      let cache = {};
      try{ cache = JSON.parse(localStorage.getItem('parshaNamesV1')) || {}; } catch(e){}
      const name = w.weekParsha || cache[w.weekKey];
      return name ? name.replace(/^פרשת\s+/, '') : 'שבוע ' + new Date(w.weekStart || w.weekKey).toLocaleDateString('he-IL');
    };

    async function buildSendMenu(){
      sendMenu.textContent = 'טוען…';
      const snaps = await getDocs(collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'archiveWeeks'));
      const weeks = [];
      snaps.forEach(d => { const w = d.data(); if (w && w.weekKey) weeks.push(w); });
      weeks.sort((a, b) => (a.weekKey < b.weekKey ? 1 : -1));
      sendMenu.innerHTML = '';
      if (!weeks.length){ sendMenu.textContent = 'אין עדיין שבועות בארכיון.'; return; }
      weeks.forEach(w => {
        // Every week has a tick; the ticked weeks are sent together, in one file.
        const line = document.createElement('label');
        line.className = 'send-pdf-week';
        line.style.cursor = 'pointer';
        const pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.className = 'send-pdf-pick';
        pick.dataset.weekKey = w.weekKey;
        pick.dataset.label = weekLabel(w);
        pick.addEventListener('change', updateMultiBtn);
        line.appendChild(pick);
        const name = document.createElement('span');
        name.className = 'send-pdf-name';
        name.textContent = weekLabel(w);
        line.appendChild(name);
        sendMenu.appendChild(line);
      });
      const multi = document.createElement('div');
      multi.className = 'send-pdf-multi';
      multiBtn = document.createElement('button');
      multiBtn.type = 'button';
      multiBtn.className = 'small-btn';
      multiBtn.addEventListener('click', () => {
        // The weeks are the pages of one PDF, oldest first, in one e-mail.
        const picked = [...sendMenu.querySelectorAll('.send-pdf-pick:checked')]
          .map(c => ({ weekKey: c.dataset.weekKey, label: c.dataset.label }))
          .sort((a, b) => (a.weekKey < b.weekKey ? -1 : 1));
        if (!picked.length) return;
        sendMenu.style.display = 'none';
        sendPdf(picked.map(x => x.weekKey), picked.length === 1 ? picked[0].label : picked.length + ' שבועות');
      });
      multi.appendChild(multiBtn);
      sendMenu.appendChild(multi);
      updateMultiBtn();
    }
    let multiBtn = null;
    function updateMultiBtn(){
      if (!multiBtn) return;
      const n = sendMenu.querySelectorAll('.send-pdf-pick:checked').length;
      multiBtn.textContent = n ? 'שליחה (' + n + (n === 1 ? ' שבוע' : ' שבועות') + ')' : 'סמן שבועות לשליחה';
      multiBtn.disabled = !n;
    }
    sendBtn.addEventListener('click', async () => {
      if (sendMenu.style.display !== 'none'){ sendMenu.style.display = 'none'; return; }
      sendMenu.style.display = '';
      try{ await buildSendMenu(); } catch(e){ sendMenu.textContent = 'שגיאה בטעינה: ' + (e && e.message ? e.message : String(e)); }
    });

    // The tables are made by the main page, loaded in a hidden frame; it puts
    // them in one PDF, sends it in one e-mail and reports back.
    function sendPdf(weekKeys, label){
      return new Promise((resolve) => {
      const job = 'job' + Date.now();
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:1000px;border:0;';
      frame.src = 'index.html?sendpdf=' + weekKeys.map(encodeURIComponent).join(',') + '&job=' + job;
      sendStatus.className = 'save-status';
      sendStatus.textContent = label + ': מכין…';
      let finished = false;
      const finish = (ok, message) => {
        finished = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(giveUp);
        frame.remove();
        sendStatus.className = 'save-status ' + (ok ? '' : 'err');
        sendStatus.textContent = label + ': ' + message;
        resolve({ ok, message });
      };
      function onMessage(e){
        if (e.origin !== location.origin || !e.data || e.data.type !== 'pdf-job' || e.data.job !== job) return;
        // a progress line ("מכין…", "שולח…") or the final answer
        if (/^(מכין|שולח)/.test(e.data.message) && e.data.ok) sendStatus.textContent = label + ': ' + e.data.message;
        else finish(e.data.ok, e.data.message);
      }
      window.addEventListener('message', onMessage);
      const giveUp = setTimeout(() => { if (!finished) finish(false, 'לא התקבלה תשובה, נסה שוב'); }, 120000 + 30000 * weekKeys.length);
      document.body.appendChild(frame);
      });
    }
    let pdfTimer = null;
    pdfInput.addEventListener('input', () => {
      clearTimeout(pdfTimer);
      const value = pdfInput.value.trim();
      if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)){ pdfStatus.textContent = 'כתובת לא תקינה'; return; }
      pdfStatus.textContent = 'שומר…';
      pdfTimer = setTimeout(async () => {
        try{
          await setDoc(pdfSettingsRef, { email: value }, { merge: true });
          pdfStatus.textContent = 'נשמר ✓';
        } catch(e){
          pdfStatus.textContent = 'השמירה נכשלה: ' + describeSaveError(e);
        }
      }, 700);
    });
}

// ---------- Tab: משתנים (phones + parent links) ----------
async function renderPhonesTab(container){
  const status = document.createElement('div');
  status.className = 'loading';
  status.textContent = 'טוען…';
  container.appendChild(status);
  try{
    const phonesDocRef = doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'metivtaPhones');
    const [mainSnap, phonesSnap] = await Promise.all([
      getDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY)),
      getDoc(phonesDocRef)
    ]);
    const mainData = mainSnap.exists() ? mainSnap.data() : {};
    const phonesData = phonesSnap.exists() ? phonesSnap.data() : {};
    const roster = buildRoster(mainData, phonesData);
    status.remove();

    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'טלפונים וקישורי הורים';
    titleRow.appendChild(title);
    const saveStatus = document.createElement('span');
    saveStatus.className = 'save-status';
    titleRow.appendChild(saveStatus);
    container.appendChild(titleRow);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'כל שינוי נשמר אוטומטית. השמות והכיתות נלקחים מעמוד המתיבתא.';
    container.appendChild(hint);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'phones-table';
    scrollWrap.appendChild(table);
    container.appendChild(scrollWrap);

    const sort = { key: null, dir: 1 };
    const pendingSaves = new Map();
    let inFlight = 0;
    // A phone that failed to save stays as typed, the big "שמירה נכשלה"
    // notice stays up, and it is retried until it goes through (a save that
    // hangs offline counts as failed after 8 seconds).
    const failedFields = new Map();
    let stalledSaves = 0;
    let failureReason = '';
    const refreshBanner = () => setSaveFailedBanner(failedFields.size > 0 || stalledSaves > 0, failureReason);

    async function saveField(r, role){
      const k = r.key + ':' + role;
      pendingSaves.delete(k);
      inFlight++;
      saveStatus.textContent = 'שומר…';
      let stalled = false;
      const stallTimer = setTimeout(() => { stalled = true; stalledSaves++; failureReason = SAVE_STALLED_REASON; refreshBanner(); }, 8000);
      try{
        await setDoc(phonesDocRef, { [r.group]: { [r.id]: { [role]: normalizePhone(r[role]) } } }, { merge: true });
        failedFields.delete(k);
      } catch(e){
        failureReason = describeSaveError(e);
        failedFields.set(k, () => saveField(r, role));
        scheduleSave(r, role, 5000);
      }
      clearTimeout(stallTimer);
      if (stalled) stalledSaves--;
      inFlight--;
      refreshBanner();
      if (failedFields.size > 0) saveStatus.textContent = 'שמירה נכשלה - מנסה שוב…';
      else if (inFlight === 0 && pendingSaves.size === 0) saveStatus.textContent = 'נשמר ✓';
    }
    window.addEventListener('online', () => failedFields.forEach(retry => retry()));

    function scheduleSave(r, role, delay){
      const k = r.key + ':' + role;
      clearTimeout(pendingSaves.get(k));
      pendingSaves.set(k, setTimeout(() => saveField(r, role), delay));
    }

    function render(){
      table.innerHTML = '';
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      appendRosterSortHeaders(trh, sort, render);
      ['טלפון אבא', 'טלפון אמא', 'קישור הורים'].forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      sortRoster(roster, sort).forEach(r => {
        const tr = document.createElement('tr');
        appendRosterNameCells(tr, r, false);
        ['father', 'mother'].forEach(role => {
          const td = document.createElement('td');
          const input = document.createElement('input');
          input.type = 'tel';
          input.value = r[role];
          input.addEventListener('input', () => {
            r[role] = input.value;
            saveStatus.textContent = 'שומר…';
            scheduleSave(r, role, 700);
          });
          input.addEventListener('change', () => scheduleSave(r, role, 0));
          td.appendChild(input);
          tr.appendChild(td);
        });
        const linkTd = document.createElement('td');
        linkTd.className = 'link-cell';
        if (r.link){
          const a = document.createElement('a');
          a.href = r.link;
          a.target = '_blank';
          a.textContent = r.link;
          linkTd.appendChild(a);
        }
        tr.appendChild(linkTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    }
    render();
  } catch(e){
    status.className = 'err';
    status.textContent = 'שגיאה בטעינה: ' + (e && e.message ? e.message : String(e));
  }
}

// ---------- Tab: שליחת הודעות ----------

// Metivta custom names are stored as { family, first } (older saved data -
// from before the family/first split existed - stored a single plain
// string instead, which this treats as the first name).
function decodeMetivtaNameEntry(raw, fallback){
  if (typeof raw === 'string') return { family: '', first: raw || fallback };
  if (raw && typeof raw === 'object') return { family: raw.family || '', first: raw.first || fallback };
  return { family: '', first: fallback };
}
function metivtaFullNameFromEntry(entry){
  return entry.family ? (entry.first + ' ' + entry.family) : entry.first;
}

// Scheduled messages go out only on Saturday and Sunday 19:00-22:00 Israel
// time - the server function (functions/index.js) runs only then.
function israelTimeParts(d){
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  return { weekday: get('weekday'), hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10) };
}

function isInSendWindow(d){
  const { weekday, hour, minute } = israelTimeParts(d);
  if (weekday !== 'Sat' && weekday !== 'Sun') return false;
  return (hour >= 19 && hour < 22) || (hour === 22 && minute === 0);
}

// The next 19:00 on a Saturday or Sunday that is still ahead (in this
// browser's clock, which is Israel time for everyone using the site), or a
// couple of minutes from now while a window is open.
function nextSendWindowStart(){
  const soon = new Date(Date.now() + 2 * 60000);
  if (isInSendWindow(soon)) return soon;
  const d = new Date();
  d.setHours(19, 0, 0, 0);
  for (let i = 0; i < 8; i++){
    if ((d.getDay() === 6 || d.getDay() === 0) && d.getTime() > Date.now()) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function computeDefaultStats(student, days, dayCountVal){
  const dayCount = dayCountVal === 'all' ? null : parseInt(dayCountVal, 10);
  const relevantDays = dayCount === null ? days : days.slice(0, dayCount);
  let onTime = 0, late = 0, leftEarly = 0, disturbed = 0;
  relevantDays.forEach(entry => {
    const rec = student.getRecord(entry);
    if (!rec || !metivtaRecordHasFlags(rec)) return;
    const f = rec.metivtaFlags;
    if (f.late) late++; else onTime++;
    if (f.leftEarly) leftEarly++;
    if (f.disturbCount > 0) disturbed += f.disturbCount;
  });
  return { attendance: onTime + late, onTime, late, leftEarly, disturbed };
}

async function renderSmsTab(container){
  const status = document.createElement('div');
  status.className = 'loading';
  status.textContent = 'טוען…';
  container.appendChild(status);

  try{
    const [mainSnap, archiveSnap, phonesSnap] = await Promise.all([
      getDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY)),
      getDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'dailyArchive')),
      getDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'metivtaPhones'))
    ]);
    if (!mainSnap.exists()) throw new Error('לא נמצאו נתוני כיתה');
    const mainData = mainSnap.data();
    // Same days as the Metivta table in index.html: today's live data first,
    // then only past days where Metivta attendance was actually recorded.
    const archivedDays = (archiveSnap.exists() && Array.isArray(archiveSnap.data().days)) ? archiveSnap.data().days.slice() : [];
    archivedDays.sort((a, b) => new Date(b.date) - new Date(a.date));
    const todayEntry = { date: new Date().toISOString(), students: mainData.students || [], metivtaExtraStudents: mainData.metivtaExtra || [] };
    const days = [todayEntry, ...archivedDays.filter(metivtaEntryHasData)];
    const phonesData = phonesSnap.exists() ? phonesSnap.data() : {};

    status.remove();

    const students = buildRoster(mainData, phonesData).map(r => ({
      ...r,
      firstName: r.first,
      getRecord: (entry) => ((r.isExtra ? entry.metivtaExtraStudents : entry.students) || []).find(x => x.id === r.id) || null
    }));
    const settingsDocRef = doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'smsSettings');
    const settingsSnap = await getDoc(settingsDocRef);
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};
    let savedTemplates = Array.isArray(settings.templates) ? settings.templates : [];
    // The recipients list that the old "הנוסע המתמיד" button kept - it now
    // belongs to the template of that name (until that template saves its own).
    const legacyFrequentRecipients = Array.isArray(settings.frequentFlyerRecipients) ? settings.frequentFlyerRecipients : null;
    const templateRecipients = (t) => Array.isArray(t.recipients) ? t.recipients
      : (legacyFrequentRecipients && t.name.includes('הנוסע המתמיד') ? legacyFrequentRecipients : null);

    // --- Template card ---
    const templateCard = document.createElement('div');
    templateCard.className = 'card';
    const templateLabel = document.createElement('label');
    templateLabel.className = 'field-label';
    templateLabel.textContent = 'תבנית ההודעה';
    const infoBtn = document.createElement('button');
    infoBtn.type = 'button';
    infoBtn.className = 'info-btn';
    infoBtn.textContent = '!';
    infoBtn.title = 'הסבר';
    templateLabel.appendChild(infoBtn);
    templateCard.appendChild(templateLabel);
    const hint = document.createElement('div');
    hint.className = 'hint info-text';
    hint.innerHTML = '<b>משתנים אפשריים בהודעה:</b>'
      + '<br><b>תלמיד:</b> <b>{שם}</b> שם פרטי, <b>{קישור}</b> קישור לטופס ההורים (ז2).'
      + '<br><b>מתיבתא</b> (לפי "טווח הסיכום"): <b>{נוכחות}</b> ימי נוכחות, <b>{בזמן}</b> ימים שהגיע בזמן, <b>{איחור}</b> ימי איחור, <b>{מוקדם}</b> ימים שיצא מוקדם, <b>{הפרעות}</b> מספר ההפרעות.'
      + '<br><b>מבחנים:</b> <b>{מבחן}</b> שם המבחן שנבחר, <b>{ציון}</b> הציון של התלמיד בו (מי שאין לו ציון נחשב 0). כשיש <b>{ציון}</b> בהודעה, אפשר לסמן נמענים לפי טווח ציונים.';
    templateCard.appendChild(hint);
    infoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      hint.classList.toggle('open');
      infoBtn.classList.toggle('open', hint.classList.contains('open'));
    });
    // Saved message templates (shared, stored with the site's data).
    const savedBox = document.createElement('div');
    savedBox.className = 'saved-templates';
    const savedLabel = document.createElement('span');
    savedLabel.className = 'field-label';
    savedLabel.textContent = 'תבניות שמורות:';
    savedBox.appendChild(savedLabel);
    const savedSelect = document.createElement('select');
    savedSelect.className = 'day-count-select';
    savedSelect.id = 'savedTemplates';
    savedBox.appendChild(savedSelect);
    const saveTemplateBtn = document.createElement('button');
    saveTemplateBtn.type = 'button';
    saveTemplateBtn.className = 'small-btn';
    saveTemplateBtn.textContent = 'שמירת ההודעה כתבנית';
    savedBox.appendChild(saveTemplateBtn);
    const deleteTemplateBtn = document.createElement('button');
    deleteTemplateBtn.type = 'button';
    deleteTemplateBtn.className = 'small-btn';
    deleteTemplateBtn.textContent = 'מחיקת התבנית';
    savedBox.appendChild(deleteTemplateBtn);
    templateCard.appendChild(savedBox);

    const templateTextarea = document.createElement('textarea');
    templateTextarea.id = 'template';
    templateTextarea.value = DEFAULT_TEMPLATE;
    templateTextarea.style.overflow = 'hidden';
    templateTextarea.style.resize = 'none';
    templateCard.appendChild(templateTextarea);
    // The message box is always as tall as its text, so all of it shows.
    const fitTextarea = (ta) => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 4) + 'px'; };
    templateTextarea.addEventListener('input', () => fitTextarea(templateTextarea));

    function refreshSavedTemplates(selectedName){
      savedSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = savedTemplates.length ? '— בחירת תבנית —' : 'אין עדיין תבניות שמורות';
      savedSelect.appendChild(placeholder);
      savedTemplates.forEach(t => {
        const o = document.createElement('option');
        o.value = t.name;
        o.textContent = t.name;
        savedSelect.appendChild(o);
      });
      savedSelect.value = selectedName || '';
      deleteTemplateBtn.disabled = !savedSelect.value;
    }
    refreshSavedTemplates('');

    async function saveSettings(update){
      await setDoc(settingsDocRef, update, { merge: true });
    }

    // Choosing a template brings back its text and the parents it is sent to.
    savedSelect.addEventListener('change', () => {
      deleteTemplateBtn.disabled = !savedSelect.value;
      const t = savedTemplates.find(x => x.name === savedSelect.value);
      if (!t) return;
      templateTextarea.value = t.text;
      const recipients = templateRecipients(t);
      if (recipients){
        checkedSet = new Set(recipients.filter(validCheckKey));
        renderRecipients();
      }
      templateTextarea.dispatchEvent(new Event('input'));
    });
    saveTemplateBtn.addEventListener('click', async () => {
      const name = (prompt('שם לתבנית:', savedSelect.value || '') || '').trim();
      if (!name) return;
      if (savedTemplates.some(t => t.name === name) && !confirm('תבנית בשם הזה כבר קיימת. להחליף אותה?')) return;
      savedTemplates = [...savedTemplates.filter(t => t.name !== name), { name, text: templateTextarea.value, recipients: [...checkedSet] }];
      try{
        await saveSettings({ templates: savedTemplates });
        refreshSavedTemplates(name);
      } catch(e){
        alert('שמירת התבנית נכשלה: ' + (e && e.message ? e.message : String(e)));
      }
    });
    deleteTemplateBtn.addEventListener('click', async () => {
      const name = savedSelect.value;
      if (!name || !confirm('למחוק את התבנית "' + name + '"?')) return;
      savedTemplates = savedTemplates.filter(t => t.name !== name);
      try{
        await saveSettings({ templates: savedTemplates });
        refreshSavedTemplates('');
      } catch(e){
        alert('מחיקת התבנית נכשלה: ' + (e && e.message ? e.message : String(e)));
      }
    });

    const rowInline = document.createElement('div');
    rowInline.className = 'row-inline';
    const senderWrap = document.createElement('div');
    const senderLabel = document.createElement('label');
    senderLabel.className = 'field-label';
    senderLabel.textContent = 'מספר השולח';
    senderWrap.appendChild(senderLabel);
    const senderInput = document.createElement('input');
    senderInput.id = 'sender';
    senderInput.type = 'text';
    senderInput.value = DEFAULT_SENDER;
    senderWrap.appendChild(senderInput);
    senderWrap.style.marginInlineStart = 'auto';
    savedBox.appendChild(senderWrap);

    const dayCountWrap = document.createElement('div');
    const dayCountLabel = document.createElement('label');
    dayCountLabel.className = 'field-label';
    dayCountLabel.textContent = 'טווח הסיכום';
    dayCountWrap.appendChild(dayCountLabel);
    const dayCountSelect = document.createElement('select');
    dayCountSelect.className = 'day-count-select';
    dayCountSelect.id = 'dayCount';
    DAY_COUNT_OPTIONS.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      dayCountSelect.appendChild(o);
    });
    dayCountSelect.value = '5';
    dayCountWrap.appendChild(dayCountSelect);
    rowInline.appendChild(dayCountWrap);
    // A test from the Metivta "מבחנים" table: {מבחן} and {ציון} in the message.
    const testsData = (mainData.metivtaTests && Array.isArray(mainData.metivtaTests.columns)) ? mainData.metivtaTests : { columns: [], scores: {} };
    const testColumns = testsData.columns.filter(c => c && c.id);
    const testWrap = document.createElement('div');
    const testLabel = document.createElement('label');
    testLabel.className = 'field-label';
    testLabel.textContent = 'מבחן';
    testWrap.appendChild(testLabel);
    const testSelect = document.createElement('select');
    testSelect.className = 'day-count-select';
    testSelect.id = 'testSelect';
    const noTest = document.createElement('option');
    noTest.value = '';
    noTest.textContent = testColumns.length ? '— בלי מבחן —' : 'אין עדיין מבחנים';
    testSelect.appendChild(noTest);
    testColumns.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.title || 'מבחן ללא שם';
      testSelect.appendChild(o);
    });
    testWrap.appendChild(testSelect);
    const scoreOf = (studentKey) => {
      const v = testSelect.value && testsData.scores && testsData.scores[testSelect.value] ? testsData.scores[testSelect.value][studentKey] : null;
      return (v === null || v === undefined || v === '') ? null : v;
    };
    // The score as a message and the range show it: no score = 0 (did not take it).
    const scoreOrZero = (studentKey) => { const v = scoreOf(studentKey); return v === null ? 0 : (parseFloat(v) || 0); };
    templateCard.appendChild(rowInline);
    container.appendChild(templateCard);

    // --- Pending scheduled messages card ---
    const pendingCard = document.createElement('div');
    pendingCard.className = 'card';
    pendingCard.style.display = 'none';
    const pendingTitle = document.createElement('div');
    pendingTitle.className = 'section-title';
    pendingTitle.textContent = 'הודעות מתוזמנות שעדיין לא נשלחו';
    const pendingInfo = document.createElement('button');
    pendingInfo.type = 'button';
    pendingInfo.className = 'info-btn';
    pendingInfo.textContent = '!';
    pendingInfo.title = 'הסבר';
    pendingTitle.appendChild(pendingInfo);
    pendingCard.appendChild(pendingTitle);
    const pendingHint = document.createElement('div');
    pendingHint.className = 'hint info-text';
    pendingInfo.addEventListener('click', () => {
      pendingHint.classList.toggle('open');
      pendingInfo.classList.toggle('open', pendingHint.classList.contains('open'));
    });
    pendingHint.textContent = 'אפשר לתזמן רק לשבת או ליום ראשון בין 19:00 ל-22:00 (שעון ישראל). השרת בודק כל 20 דקות ושולח את מה שהגיע זמנו (19:00, 19:20, 19:40...), גם אם העמוד הזה סגור.';
    pendingCard.appendChild(pendingHint);
    const pendingBody = document.createElement('div');
    pendingCard.appendChild(pendingBody);

    const scheduledSmsCollection = collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'scheduledSms');

    async function renderPendingList(){
      pendingBody.textContent = 'טוען…';
      const snap = await getDocs(scheduledSmsCollection);
      const pending = [];
      snap.forEach(d => {
        const data = d.data();
        if (data.status === 'pending') pending.push({ id: d.id, ...data });
      });
      pending.sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
      pendingBody.innerHTML = '';
      pendingCard.style.display = pending.length ? '' : 'none';
      if (pending.length === 0) return;
      const table = document.createElement('table');
      table.className = 'log-table';
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      ['נמען', 'זמן שליחה', 'הודעה', ''].forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      pending.forEach(p => {
        const tr = document.createElement('tr');
        const labelTd = document.createElement('td');
        labelTd.textContent = p.label || p.phone;
        tr.appendChild(labelTd);
        const timeTd = document.createElement('td');
        timeTd.textContent = new Date(p.sendAt).toLocaleString('he-IL');
        tr.appendChild(timeTd);
        const msgTd = document.createElement('td');
        msgTd.textContent = p.msg.length > 60 ? p.msg.slice(0, 60) + '…' : p.msg;
        tr.appendChild(msgTd);
        const cancelTd = document.createElement('td');
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.textContent = 'בטל';
        cancelBtn.addEventListener('click', async () => {
          if (!confirm('לבטל את ההודעה המתוזמנת הזו?')) return;
          cancelBtn.disabled = true;
          await deleteDoc(doc(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'scheduledSms', p.id));
          await renderPendingList();
        });
        cancelTd.appendChild(cancelBtn);
        tr.appendChild(cancelTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      pendingBody.appendChild(table);
    }

    // --- Recipients card ---
    const recipientsCard = document.createElement('div');
    recipientsCard.className = 'card';
    const recipientsTitle = document.createElement('div');
    recipientsTitle.className = 'section-title';
    recipientsTitle.textContent = 'נמענים';
    recipientsCard.appendChild(recipientsTitle);

    const selectAllRow = document.createElement('div');
    selectAllRow.className = 'select-all-row';
    // One button: a press ticks everybody, another press clears them all.
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.id = 'pickAll';
    allBtn.textContent = 'הכל';
    selectAllRow.appendChild(allBtn);
    recipientsCard.appendChild(selectAllRow);

    // From score X to score Y - shown only while the message has {ציון}. 0 also
    // takes those who did not take the test.
    const rangeRow = document.createElement('div');
    rangeRow.className = 'select-all-row';
    rangeRow.style.display = 'none';
    const mkNum = (id, v, title) => {
      const i = document.createElement('input');
      i.type = 'number'; i.id = id; i.min = '0'; i.max = '100'; i.value = v; i.title = title;
      i.style.width = '70px';
      return i;
    };
    const mkText = (t) => { const x = document.createElement('span'); x.textContent = t; return x; };
    const fromInput = mkNum('scoreFrom', '0', 'מציון');
    const toInput = mkNum('scoreTo', '100', 'עד ציון');
    const rangeBtn = document.createElement('button');
    rangeBtn.type = 'button';
    rangeBtn.id = 'pickRange';
    rangeBtn.textContent = 'סימון';
    testWrap.style.display = 'flex';
    testWrap.style.alignItems = 'center';
    testWrap.style.gap = '6px';
    testLabel.style.margin = '0';
    [testWrap, mkText('מציון'), fromInput, mkText('עד ציון'), toInput, rangeBtn].forEach(x => rangeRow.appendChild(x));
    recipientsCard.appendChild(rangeRow);

    // Which parent of which student is ticked, as 'studentKey:role'.
    let checkedSet = new Set();
    const validCheckKey = (k) => {
      const [studentKey, role] = k.split(':');
      const st = students.find(x => x.key === studentKey);
      return !!(st && st[role]);
    };

    // While a saved template is chosen, the ticked parents are kept with it.
    async function selectionChanged(){
      const t = savedTemplates.find(x => x.name === savedSelect.value);
      if (!t) return;
      t.recipients = [...checkedSet];
      try{
        await saveSettings({ templates: savedTemplates });
      } catch(e){
        alert('שמירת הנמענים בתבנית נכשלה: ' + (e && e.message ? e.message : String(e)));
      }
    }

    const tableScroll = document.createElement('div');
    tableScroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'recipients-table';
    tableScroll.appendChild(table);
    recipientsCard.appendChild(tableScroll);
    const recipientsSort = { key: null, dir: 1 };

    function renderRecipients(){
      table.innerHTML = '';
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      appendRosterSortHeaders(trh, recipientsSort, renderRecipients);
      ['אבא', 'אמא'].forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      sortRoster(students, recipientsSort).forEach(s => {
        const tr = document.createElement('tr');
        appendRosterNameCells(tr, s, true);
        ['father', 'mother'].forEach(role => {
          const td = document.createElement('td');
          const phone = s[role];
          if (phone){
            const cell = document.createElement('label');
            cell.className = 'parent-cell';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.studentKey = s.key;
            cb.dataset.role = role;
            cb.checked = checkedSet.has(s.key + ':' + role);
            cb.addEventListener('change', () => {
              if (cb.checked) checkedSet.add(s.key + ':' + role);
              else checkedSet.delete(s.key + ':' + role);
              selectionChanged();
            });
            cell.appendChild(cb);
            td.appendChild(cell);
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      refreshAllBtn();
    }
    renderRecipients();

    const recipientsAction = document.createElement('div');
    recipientsAction.className = 'action-bar';
    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn-secondary';
    previewBtn.type = 'button';
    previewBtn.textContent = 'תצוגה מקדימה של הודעות לעריכה';
    recipientsAction.appendChild(previewBtn);
    recipientsCard.appendChild(recipientsAction);
    container.appendChild(recipientsCard);

    // Every ticked parent is a message; students without a number have no box.
    function allKeys(){
      const keys = [];
      students.forEach(s => ['father', 'mother'].forEach(role => { if (s[role]) keys.push(s.key + ':' + role); }));
      return keys;
    }
    function refreshAllBtn(){
      const keys = allKeys();
      allBtn.classList.toggle('active', keys.length > 0 && keys.every(k => checkedSet.has(k)));
    }
    allBtn.addEventListener('click', () => {
      const keys = allKeys();
      checkedSet = keys.every(k => checkedSet.has(k)) ? new Set() : new Set(keys);
      renderRecipients();
      selectionChanged();
    });
    // Students whose score is from X to Y (both included); no score counts as 0.
    function pickByRange(){
      if (!testSelect.value){ alert('קודם לבחור מבחן.'); return; }
      const lo = parseFloat(fromInput.value), hi = parseFloat(toInput.value);
      if (isNaN(lo) || isNaN(hi)){ alert('יש להזין ציון בשני השדות.'); return; }
      checkedSet = new Set();
      students.forEach(s => {
        const n = scoreOrZero(s.key);
        if (s.archived || n < lo || n > hi) return;
        ['father', 'mother'].forEach(role => { if (s[role]) checkedSet.add(s.key + ':' + role); });
      });
      renderRecipients();
      selectionChanged();
    }
    rangeBtn.addEventListener('click', pickByRange);
    function getSelectedRecipients(){
      const selected = [];
      table.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
        const student = students.find(s => s.key === cb.dataset.studentKey);
        if (!student) return;
        const phone = student[cb.dataset.role];
        if (!phone) return;
        selected.push({ student, role: cb.dataset.role, phone });
      });
      return selected;
    }

    // The message's numbers come straight from the Metivta data (no table to edit).
    function getStatsForStudent(studentKey){
      const student = students.find(x => x.key === studentKey);
      return student ? computeDefaultStats(student, days, dayCountSelect.value) : { attendance: 0, onTime: 0, late: 0, leftEarly: 0, disturbed: 0 };
    }

    // What the message needs decides what is shown: the summary range for the
    // Metivta numbers, the test and the score range for {ציון}/{מבחן}.
    function refreshTemplateDependents(){
      const t = templateTextarea.value;
      dayCountWrap.style.display = STAT_FIELDS.some(f => t.includes(f.placeholder)) ? '' : 'none';
      rangeRow.style.display = (t.includes('{ציון}') || t.includes('{מבחן}')) ? '' : 'none';
      fromInput.style.display = toInput.style.display = rangeBtn.style.display = t.includes('{ציון}') ? '' : 'none';
      rangeRow.querySelectorAll('span').forEach(x => { x.style.display = t.includes('{ציון}') ? '' : 'none'; });
    }
    templateTextarea.addEventListener('input', refreshTemplateDependents);
    refreshTemplateDependents();
    setTimeout(() => fitTextarea(templateTextarea), 0);

    function resolveMessage(student){
      const stats = getStatsForStudent(student.key);
      let text = templateTextarea.value
        .split('{שם}').join(student.firstName)
        .split('{קישור}').join(student.link || '');
      STAT_FIELDS.forEach(f => { text = text.split(f.placeholder).join(String(stats[f.key])); });
      const col = testColumns.find(c => c.id === testSelect.value);
      text = text.split('{מבחן}').join(col ? (col.title || '') : '').split('{ציון}').join(testSelect.value ? String(scoreOrZero(student.key)) : '');
      return text;
    }

    // --- Preview + send card ---
    const sendCard = document.createElement('div');
    sendCard.className = 'card';
    sendCard.style.display = 'none';
    const sendTitle = document.createElement('div');
    sendTitle.className = 'section-title';
    sendTitle.textContent = 'תצוגה מקדימה - אפשר לערוך כל הודעה בנפרד לפני שליחה';
    sendCard.appendChild(sendTitle);
    const previewList = document.createElement('div');
    previewList.className = 'preview-list';
    sendCard.appendChild(previewList);
    // Send now | schedule, on one line.
    const sendAction = document.createElement('div');
    sendAction.className = 'action-bar send-row';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn-primary';
    sendBtn.type = 'button';
    sendBtn.textContent = 'שלח הודעות עכשיו';
    sendAction.appendChild(sendBtn);
    const sendSep = document.createElement('span');
    sendSep.className = 'send-sep';
    sendAction.appendChild(sendSep);
    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'btn-secondary';
    scheduleBtn.type = 'button';
    scheduleBtn.textContent = 'תזמן שליחה';
    sendAction.appendChild(scheduleBtn);
    sendCard.appendChild(sendAction);

    const toLocalInputValue = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    const summaryBar = document.createElement('div');
    summaryBar.className = 'summary-bar';
    sendCard.appendChild(summaryBar);
    container.appendChild(sendCard);

    previewBtn.addEventListener('click', () => {
      const selected = getSelectedRecipients();
      previewList.innerHTML = '';
      summaryBar.textContent = '';
      if (selected.length === 0){
        sendCard.style.display = 'none';
        return;
      }
      sendCard.style.display = '';
      selected.forEach(r => {
        const item = document.createElement('div');
        item.className = 'preview-item';
        item.dataset.studentKey = r.student.key;
        item.dataset.role = r.role;
        const head = document.createElement('div');
        head.className = 'preview-head';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = r.student.name + ' - ' + (r.role === 'father' ? 'אבא' : 'אמא');
        const phoneSpan = document.createElement('span');
        phoneSpan.className = 'preview-phone';
        phoneSpan.textContent = r.phone;
        head.appendChild(nameSpan);
        head.appendChild(phoneSpan);
        item.appendChild(head);
        const textarea = document.createElement('textarea');
        textarea.value = resolveMessage(r.student);
        textarea.style.overflow = 'hidden';
        textarea.style.resize = 'none';
        textarea.addEventListener('input', () => fitTextarea(textarea));
        item.appendChild(textarea);
        const statusEl = document.createElement('div');
        statusEl.className = 'preview-status';
        item.appendChild(statusEl);
        previewList.appendChild(item);
        fitTextarea(textarea);
      });
    });

    async function sendOne(sender, recipientPhone, msg){
      // The SMS account details are on the server; the admin code is checked there.
      try{
        const res = await httpsCallable(getFunctions(firebaseApp, 'us-central1'), 'sendSmsNow')({ code: enteredCode, sender, recipient: recipientPhone, msg });
        return parseInt(res.data && res.data.code, 10);
      } catch(e){
        if (e && e.code === 'functions/resource-exhausted') throw new Error('נעול זמנית אחרי ניסיונות שגויים, נסה בעוד 10 דקות');
        throw e;
      }
    }

    // A phone number typed with dashes/spaces is sent as plain digits.
    function senderForApi(){
      const v = senderInput.value.trim();
      return /^[\d\s-]+$/.test(v) ? normalizePhone(v) : v;
    }

    const sentSmsCollection = collection(db, FIRESTORE_COLLECTION, STORAGE_KEY, 'sentSms');

    async function logSent(record){
      try{
        await addDoc(sentSmsCollection, { ...record, sentAt: new Date().toISOString() });
      } catch(e){
        // the archive is a record only; never fail a send because of it
      }
    }

    sendBtn.addEventListener('click', async () => {
      const sender = senderForApi();
      if (!sender){
        alert('יש להזין שם/מספר שולח לפני השליחה.');
        return;
      }
      const items = Array.from(previewList.querySelectorAll('.preview-item'));
      if (items.length === 0) return;
      if (!confirm('לשלוח ' + items.length + ' הודעות SMS בפועל (בתשלום)?')) return;

      sendBtn.disabled = true;
      previewBtn.disabled = true;
      let okCount = 0, failCount = 0;
      const batchId = 'b' + Date.now();

      for (const item of items){
        const studentKey = item.dataset.studentKey;
        const role = item.dataset.role;
        const student = students.find(s => s.key === studentKey);
        const phone = normalizePhone(student[role]);
        const msg = item.querySelector('textarea').value;
        const statusEl = item.querySelector('.preview-status');
        const label = student.name + ' - ' + (role === 'father' ? 'אבא' : 'אמא');
        statusEl.textContent = 'שולח…';
        try{
          const code = await sendOne(sender, phone, msg);
          if (!isNaN(code) && code > 0){
            statusEl.textContent = 'נשלח בהצלחה ✓';
            statusEl.className = 'preview-status status-ok';
            okCount++;
            await logSent({ phone, label, msg, sender, status: 'sent', batchId });
          } else {
            const errMsg = SMS4FREE_ERROR_MESSAGES[String(code)] || ('קוד שגיאה: ' + code);
            statusEl.textContent = 'נכשל: ' + errMsg;
            statusEl.className = 'preview-status status-err';
            failCount++;
            await logSent({ phone, label, msg, sender, status: 'failed', error: errMsg, batchId });
          }
        } catch(e){
          const errMsg = 'שגיאת רשת (' + (e && e.message ? e.message : String(e)) + ')';
          statusEl.textContent = 'נכשל: ' + errMsg + ' - ייתכן שזה חסימת CORS של שרת ה-SMS';
          statusEl.className = 'preview-status status-err';
          failCount++;
          await logSent({ phone, label, msg, sender, status: 'failed', error: errMsg, batchId });
        }
      }

      summaryBar.textContent = 'נשלחו בהצלחה: ' + okCount + ' · נכשלו: ' + failCount;
      await renderSentArchive();
      previewBtn.disabled = false;
      sendBtn.disabled = false;
    });

    // The schedule button opens a window to choose the date: confirm or cancel.
    scheduleBtn.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'sched-overlay';
      const box = document.createElement('div');
      box.className = 'sched-box';
      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = 'תזמון שליחה';
      box.appendChild(title);
      const input = document.createElement('input');
      input.type = 'datetime-local';
      input.id = 'scheduleAt';
      input.min = toLocalInputValue(new Date());
      input.value = toLocalInputValue(nextSendWindowStart());
      box.appendChild(input);
      const row = document.createElement('div');
      row.className = 'action-bar';
      const ok = document.createElement('button');
      ok.className = 'btn-primary';
      ok.type = 'button';
      ok.id = 'scheduleOk';
      ok.textContent = 'אישור';
      const cancel = document.createElement('button');
      cancel.className = 'btn-secondary';
      cancel.type = 'button';
      cancel.textContent = 'ביטול';
      row.appendChild(ok);
      row.appendChild(cancel);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      cancel.addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      ok.addEventListener('click', () => { const v = input.value; overlay.remove(); scheduleMessages(v); });
    });

    async function scheduleMessages(whenVal){
      const sender = senderForApi();
      if (!sender){
        alert('יש להזין שם/מספר שולח לפני התזמון.');
        return;
      }
      const sendAtDate = whenVal ? new Date(whenVal) : null;
      if (!sendAtDate || isNaN(sendAtDate.getTime()) || sendAtDate.getTime() <= Date.now()){
        alert('יש לבחור תאריך ושעה בעתיד לשליחה.');
        return;
      }
      if (!isInSendWindow(sendAtDate)){
        alert('אפשר לתזמן רק לשבת או ליום ראשון בין 19:00 ל-22:00 (שעון ישראל) - רק אז השרת שולח הודעות.');
        return;
      }
      const items = Array.from(previewList.querySelectorAll('.preview-item'));
      if (items.length === 0) return;
      const whenLabel = sendAtDate.toLocaleString('he-IL');
      if (!confirm('לתזמן ' + items.length + ' הודעות SMS לשליחה אוטומטית ב-' + whenLabel + '?')) return;

      scheduleBtn.disabled = true;
      sendBtn.disabled = true;
      const batchId = 'b' + Date.now();
      try{
        for (const item of items){
          const studentKey = item.dataset.studentKey;
          const role = item.dataset.role;
          const student = students.find(s => s.key === studentKey);
          const phone = normalizePhone(student[role]);
          const msg = item.querySelector('textarea').value;
          const label = student.name + ' - ' + (role === 'father' ? 'אבא' : 'אמא');
          await addDoc(scheduledSmsCollection, {
            phone, msg, sender, label, batchId,
            status: 'pending',
            sendAt: sendAtDate.toISOString(),
            createdAt: new Date().toISOString()
          });
        }
        summaryBar.textContent = 'תוזמנו ' + items.length + ' הודעות לשליחה אוטומטית ב-' + whenLabel + '.';
        await renderPendingList();
      } catch(e){
        alert('שגיאה בתזמון: ' + (e && e.message ? e.message : String(e)));
      }
      scheduleBtn.disabled = false;
      sendBtn.disabled = false;
    }

    // --- Sent messages archive card ---
    const sentCard = document.createElement('div');
    sentCard.className = 'card';
    const sentTitle = document.createElement('div');
    sentTitle.className = 'section-title';
    sentTitle.textContent = 'ארכיון הודעות שנשלחו';
    const sentBody = document.createElement('div');
    // Last on the page, as dropdowns: the scheduled messages (only when there
    // are), then the parents' updates, then the sent messages.
    container.appendChild(pendingCard);
    await appendPdfCard(container);
    const parentsDd = buildDropdown('הנוסע המתמיד – ארכיון', false);
    parentsDd.box.className = 'edits-day edits-group card-dropdown';
    container.appendChild(parentsDd.box);
    let parentsLoaded = false;
    parentsDd.box.addEventListener('toggle', () => {
      if (parentsDd.box.open && !parentsLoaded){ parentsLoaded = true; renderHistoryTab(parentsDd.body); }
    });
    const sentDd = buildDropdown('מתיבתא - ארכיון', false);
    sentDd.box.className = 'edits-day edits-group card-dropdown';
    sentDd.body.appendChild(sentBody);
    container.appendChild(sentDd.box);

    // Messages sent from this page (sentSms) plus scheduled ones the server
    // function already sent or failed (scheduledSms), newest first.
    async function renderSentArchive(){
      sentBody.textContent = 'טוען…';
      try{
        const [sentSnap, schedSnap] = await Promise.all([getDocs(sentSmsCollection), getDocs(scheduledSmsCollection)]);
        const rows = [];
        sentSnap.forEach(d => rows.push({ ...d.data(), via: 'מיידי' }));
        schedSnap.forEach(d => {
          const data = d.data();
          if (data.status === 'sent' || data.status === 'failed') rows.push({ ...data, sentAt: data.sentAt || data.sendAt, via: 'מתוזמן' });
        });
        rows.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
        sentBody.innerHTML = '';
        if (rows.length === 0){
          sentBody.textContent = 'עדיין לא נשלחו הודעות.';
          return;
        }
        // One group per send command. Older messages have no batchId: those
        // sent the same way within a few minutes of each other count as one.
        const batches = [];
        rows.slice(0, 500).forEach(r => {
          const last = batches[batches.length - 1];
          const t = new Date(r.sentAt).getTime();
          const same = last && (r.batchId
            ? last.batchId === r.batchId
            : (!last.batchId && last.via === r.via && last.oldest - t < 5 * 60000));
          if (same){ last.rows.push(r); last.oldest = t; }
          else batches.push({ batchId: r.batchId || null, via: r.via, rows: [r], oldest: t });
        });
        const fmt = (iso) => new Date(iso).toLocaleString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });
        batches.forEach(batch => {
          const failed = batch.rows.filter(r => r.status !== 'sent').length;
          const box = document.createElement('details');
          box.className = 'sent-batch';
          const sum = document.createElement('summary');
          sum.textContent = fmt(batch.rows[0].sentAt) + ' · ' + batch.via;
          const count = document.createElement('span');
          count.className = 'batch-count';
          count.textContent = (batch.rows.length === 1 ? 'הודעה אחת' : batch.rows.length + ' הודעות') + (failed ? ' (' + failed + ' נכשלו)' : ' ✓');
          sum.appendChild(count);
          box.appendChild(sum);
          const body = document.createElement('div');
          body.className = 'sent-batch-body';
          // In the order they were sent.
          batch.rows.slice().reverse().forEach(r => {
            const item = document.createElement('details');
            item.className = 'sent-msg';
            const head = document.createElement('summary');
            head.textContent = (r.label || '') + (r.phone ? ' · ' + r.phone : '');
            const st = document.createElement('span');
            st.className = r.status === 'sent' ? 'status-ok' : 'status-err';
            st.textContent = r.status === 'sent' ? ' ✓' : ' ✗ ' + (r.error || 'נכשל');
            head.appendChild(st);
            item.appendChild(head);
            const text = document.createElement('div');
            text.className = 'sent-msg-text';
            text.textContent = r.msg || '';
            item.appendChild(text);
            body.appendChild(item);
          });
          box.appendChild(body);
          sentBody.appendChild(box);
        });
      } catch(e){
        sentBody.textContent = 'שגיאה בטעינת הארכיון: ' + (e && e.message ? e.message : String(e));
      }
    }

    await renderPendingList();
    await renderSentArchive();

  } catch(e){
    status.className = 'err';
    status.textContent = 'שגיאה בטעינה: ' + (e && e.message ? e.message : String(e));
  }
}

if (!isFirebaseConfigured){
  app.innerHTML = '<div class="err">האתר לא מוגדר עדיין.</div>';
} else {
  firebaseApp = initializeApp(firebaseConfig);
  // Plain requests instead of a streaming connection (see index.html).
  db = initializeFirestore(firebaseApp, { experimentalForceLongPolling: true });
  showCodePrompt();
}
mountPageNav({ getCurrent: () => 'admin' });

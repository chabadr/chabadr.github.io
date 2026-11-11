import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, collection, query, where, onSnapshot, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";
import { mountPageNav } from "./page-nav.js";
import { setSaveFailedBanner, describeSaveError, SAVE_STALLED_REASON } from "./save-banner.js";

function showSetupNeededMessage(){
  document.body.innerHTML = '';
  const box = document.createElement('div');
  box.style.maxWidth = '480px';
  box.style.margin = '60px auto';
  box.style.padding = '28px';
  box.style.fontFamily = "'Rubik', sans-serif";
  box.style.textAlign = 'center';
  box.style.direction = 'rtl';
  box.innerHTML = '<h1 style="font-size:20px;">האתר עדיין לא מוגדר</h1>' +
    '<p>צריך למלא את פרטי החיבור ל-Firebase בקובץ <code>firebase-config.js</code>. ' +
    'ראו את ה-README בריפו להוראות.</p>';
  document.body.appendChild(box);
}

window.addEventListener('error', (ev) => {
  showStartupError(ev.error || ev.message || ev);
});
window.addEventListener('unhandledrejection', (ev) => {
  showStartupError(ev.reason);
});

const CATEGORIES = [
  { key: 'c1', label: '8:10', value: 3 },
  { key: 'c2', label: 'קרבנות', value: 1 },
  { key: 'c3', label: 'תפילה', value: 2 },
  { key: 'c4', label: '11:23', value: 1 },
  { key: 'c5', label: '+', value: 1, resettable: true, cumulativeKey: 'c5Total' },
  { key: 'c6', label: 'מקווה', value: 1 },
  { key: 'c7', label: '8:45', value: 1 },
  { key: 'c8', label: '12:48', value: 1 },
  // Prayer minuses (a count, 0 or below): the small minus button of the תפילה cell.
  { key: 'c9', label: 'מינוס תפילה', value: -1 }
];

const MERGE_GROUPS = [
  ['c1', 'c7', 'c4', 'c8'],
  ['c5', 'c2', 'c3', 'mikvaot', 'rambam']
];

// mikvaot/rambam live in the "prayer" merged dropdown (MERGE_GROUPS[1]) but are
// not point categories: they are a checkmark (student.frequent[key]), excluded
// from the daily/overall point sums, and only turn into points (2, via
// student.frequentFrozen) inside the "הנוסע המתמיד" weekly archive.
const FREQUENT_TOGGLE_LABELS = { mikvaot: 'מקוואות', rambam: 'רמב"ם' };

function isFrequentToggleKey(key){
  return key === 'mikvaot' || key === 'rambam';
}

function categoryLabel(key){
  if (isFrequentToggleKey(key)) return FREQUENT_TOGGLE_LABELS[key];
  const cat = CATEGORIES.find(c => c.key === key);
  return cat ? cat.label : '';
}

const STUDENT_NAMES = [
  'צאלי', 'ישרוליק', 'נתנאל', 'מענדי ה.', 'מענדי ח.', 'אלעאי', 'יהונתן', 'איתן', 'מענדי ל.', 'שלוימי', 'מוישלה', 'לוי ס.',
  'שמוליק ע.', 'מולי', 'שלום', 'חננאל', 'שמוליק צ.', 'אושר', 'שמעון', 'מוטי', 'לוי ק.', 'נועם', 'משה'
];

function studentName(id){
  return STUDENT_NAMES[id - 1] || id;
}

// Display-only names used in the Metivta board/archive, editable in-app and
// stored in state.metivtaNames / state.metivtaExtraNames (keyed by id, main
// vs extra group). Same id as STUDENT_NAMES/METIVTA_EXTRA_NAMES, so the
// underlying linkage to every other page (main board, "הנוסע המתמיד", the
// parent-update log) stays correct - only how the name is shown inside
// Metivta's own views changes.
//
// Each entry is a { family, first } pair.
function normalizeMetivtaNameEntry(raw){
  if (raw && typeof raw === 'object') return { family: raw.family || '', first: raw.first || '' };
  return { family: '', first: '' };
}

function metivtaNameEntry(id, isExtra){
  const map = isExtra ? state.metivtaExtraNames : state.metivtaNames;
  return normalizeMetivtaNameEntry(map && map[id]);
}

function metivtaFirstName(id, isExtra){
  const entry = metivtaNameEntry(id, isExtra);
  if (entry.first) return entry.first;
  return isExtra ? (METIVTA_EXTRA_NAMES[id - 1] || String(id)) : studentName(id);
}

function metivtaFamilyName(id, isExtra){
  return metivtaNameEntry(id, isExtra).family;
}

function metivtaFullName(id, isExtra){
  const first = metivtaFirstName(id, isExtra);
  const family = metivtaFamilyName(id, isExtra);
  return family ? (first + ' ' + family) : first;
}

function setMetivtaNamePart(id, isExtra, part, value){
  commitOp({ kind: 'mname', group: isExtra ? 'extra' : 'main', sid: id, part, value });
}

// "כיתה" (class) per student, main group defaults to 2 and the extra group
// to 1 - distinct defaults, both overridable per student.
function metivtaClassValue(id, isExtra){
  const map = isExtra ? state.metivtaExtraClass : state.metivtaClass;
  const raw = map && map[id];
  return (raw === undefined || raw === null || raw === '') ? (isExtra ? 1 : 2) : raw;
}

function setMetivtaClassValue(id, isExtra, value){
  commitOp({ kind: 'mclass', group: isExtra ? 'extra' : 'main', sid: id, value });
}

const TOTAL_STUDENTS = 23;
const STORAGE_KEY = 'classroom-points-v1';
const FIRESTORE_COLLECTION = 'classroom_points';

const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
// The data is also kept in this browser (IndexedDB), so the site opens with
// the last known data even without internet. Falls back to memory only if
// the browser doesn't allow it.
const firestoreDb = firebaseApp ? (() => {
  try{
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      // Plain requests instead of a streaming connection - the streaming one
      // is what internet filters and school networks most often break.
      experimentalForceLongPolling: true
    });
  } catch(e){
    return getFirestore(firebaseApp);
  }
})() : null;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// Data model: the archive (daily point-history + the weekly "הנוסע המתמיד"
// entries) lives in its own documents, separate from the live, constantly-
// written "today" document below. A live point click never touches the
// archive at all, and every archive write re-reads the specific archive
// document fresh before changing it - so a device with an out-of-date copy
// of the archive can never silently overwrite someone else's newer archive
// data with its own stale copy (which is what caused a real data-loss
// incident: the old design kept the whole archive embedded in the one
// live document, and any ordinary save pushed back whatever archive this
// device last happened to load).
const stateDocRef = firestoreDb ? doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY) : null;
const dailyArchiveDocRef = firestoreDb ? doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'dailyArchive') : null;
const weeklyArchiveCollectionRef = firestoreDb ? collection(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'archiveWeeks') : null;
function weekDocRef(weekKey){
  return doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'archiveWeeks', weekKey);
}

let lastServerMainJson = null;

async function fetchArchiveDays(){
  try{
    const snap = await getDoc(dailyArchiveDocRef);
    if (snap.exists() && Array.isArray(snap.data().days)) return snap.data().days;
  } catch(e){}
  return [];
}

async function fetchArchiveWeeks(){
  try{
    const snaps = await getDocs(weeklyArchiveCollectionRef);
    const list = [];
    snaps.forEach(s => list.push(s.data()));
    return list;
  } catch(e){}
  return [];
}

// Every archived week is a document that costs a read. Old weeks almost never
// change, so after the first full load only the recent weeks are read again
// (and everything once in a while, in case an old week was edited elsewhere).
const RECENT_WEEKS_DAYS = 28;
const FULL_WEEKS_REFRESH_MS = 15 * 60 * 1000;
let lastFullWeeksAt = 0;
async function fetchArchiveWeeksMap(recentOnly){
  const base = serverSnap && serverSnap.weeks;
  if (recentOnly && base && Date.now() - lastFullWeeksAt < FULL_WEEKS_REFRESH_MS){
    try{
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RECENT_WEEKS_DAYS);
      const snaps = await getDocs(query(weeklyArchiveCollectionRef, where('weekKey', '>=', dayKeyOf(cutoff.toISOString()))));
      const map = { ...base };
      snaps.forEach(sn => { const w = sn.data(); if (w && w.weekKey) map[w.weekKey] = w; });
      return map;
    } catch(e){}
  }
  const map = {};
  (await fetchArchiveWeeks()).forEach(w => { if (w && w.weekKey) map[w.weekKey] = w; });
  lastFullWeeksAt = Date.now();
  return map;
}

// Re-reads the archive documents (another device may have archived a day or
// edited the archive) and redraws.
// A refresh that was read before one of our own saves finished could bring
// back the old value of the cell just edited, so it is thrown away and done
// again once the saving is over.
let archiveWriteVersion = 0;      // bumped by every save made here
let archiveRefreshWanted = false; // a refresh was dropped because of a save
async function refreshArchiveAndRender(){
  if (!serverSnap) return;
  if (syncRunning || pendingOps.length){ archiveRefreshWanted = true; return; }
  const version = archiveWriteVersion;
  const [days, weeks] = await Promise.all([fetchArchiveDays(), fetchArchiveWeeksMap(true)]);
  if (version !== archiveWriteVersion || syncRunning || pendingOps.length){ archiveRefreshWanted = true; return; }
  serverSnap.dailyDays = days;
  serverSnap.weeks = weeks;
  rebuildViewAndRender();
}

function subscribeToRemoteStateChanges(){
  onSnapshot(stateDocRef, (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const data = snap.data();
    if (!data || !Array.isArray(data.students) || data.students.length !== TOTAL_STUDENTS) return;
    const json = JSON.stringify(data);
    if (json === lastServerMainJson) return;
    lastServerMainJson = json;
    serverSnap.main = data;
    rebuildViewAndRender();
    refreshArchiveAndRender();
  }, (err) => {
    // realtime sync unavailable; changes are still synced by syncPendingOps
  });
}

let state = null; // { students: [{id, cumulative, cats:{c1,c2,c3,c4}}] }

const METIVTA_EXTRA_NAMES = [
  'יהונתן', 'נריה', 'יהודה', 'חסדיאל', 'אוריאל', 'מענדל', 'שניאור', 'מענדי דר.', 'מענדי זכ.', 'עוזי', 'מענדי יא.',
  'אופיר', 'לוי', 'מענדי מז.', 'מענדי מע.', 'אברמי', 'שמואל', 'מענדי סמ.', 'ברוכי', 'איזיק', 'בער', 'רמי', 'ניתאי'
];

function defaultState(){
  const students = [];
  for (let i = 1; i <= TOTAL_STUDENTS; i++){
    students.push({ id: i, cumulative: 0, cats: { c1:0, c2:0, c3:0, c4:0, c5:0, c6:0, c7:0, c8:0, c9:0 }, purchases: 0, c5Total: 0, minusTotal: 0, frequent: { mikvaot: 0, rambam: 0 }, frequentFrozen: { mikvaot: 0, rambam: 0 }, metivta: { attendance: 0, behavior: 0 }, metivtaFrozen: { attendance: 0, behavior: 0 }, metivtaFlags: { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 } });
  }
  const metivtaExtra = [];
  for (let i = 1; i <= 23; i++){
    metivtaExtra.push({ id: i, metivta: { attendance: 0, behavior: 0 }, metivtaFrozen: { attendance: 0, behavior: 0 }, metivtaFlags: { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 } });
  }
  return { students, metivtaExtra, mergedActive: MERGE_GROUPS.map(g => g[0]), minusShopActive: 'minus', archive: [], lastActivityDate: null, metivtaNames: {}, metivtaExtraNames: {}, metivtaClass: {}, metivtaExtraClass: {} };
}

function setStatus(msg){
  const el = document.getElementById('statusEl');
  if (el) el.textContent = msg;
}

// Fills in fields missing from older saved data. Works on a copy - used both
// for what is shown and for what a sync transaction writes back.
function normalizeMain(raw){
  const parsed = JSON.parse(JSON.stringify(raw));
  delete parsed.archive;
  if (!Array.isArray(parsed.mergedActive) || parsed.mergedActive.length !== MERGE_GROUPS.length){
    parsed.mergedActive = MERGE_GROUPS.map(g => g[0]);
  }
  if (parsed.minusShopActive !== 'minus' && parsed.minusShopActive !== 'shop'){
    parsed.minusShopActive = 'minus';
  }
  parsed.students.forEach(s => {
    if (typeof s.purchases !== 'number') s.purchases = 0;
    if (!s.cats) s.cats = {};
    CATEGORIES.forEach(c => { if (typeof s.cats[c.key] !== 'number') s.cats[c.key] = 0; });
    if (!s.frequent) s.frequent = { mikvaot: 0, rambam: 0 };
    if (!s.frequentFrozen) s.frequentFrozen = { mikvaot: s.frequent.mikvaot || 0, rambam: s.frequent.rambam || 0 };
    if (!s.metivta) s.metivta = { attendance: 0, behavior: 0 };
    if (!s.metivtaFrozen) s.metivtaFrozen = { attendance: s.metivta.attendance || 0, behavior: s.metivta.behavior || 0 };
    if (typeof s.c5Total !== 'number') s.c5Total = 0;
    if (typeof s.minusTotal !== 'number') s.minusTotal = 0;
    if (typeof s.cumulative !== 'number') s.cumulative = 0;
  });
  if (!Array.isArray(parsed.metivtaExtra) || parsed.metivtaExtra.length !== 23){
    const existing = Array.isArray(parsed.metivtaExtra) ? parsed.metivtaExtra : [];
    const byId = {};
    existing.forEach(s => { byId[s.id] = s; });
    const metivtaExtra = [];
    for (let i = 1; i <= 23; i++){
      metivtaExtra.push(byId[i] || { id: i, metivta: { attendance: 0, behavior: 0 }, metivtaFrozen: { attendance: 0, behavior: 0 } });
    }
    parsed.metivtaExtra = metivtaExtra;
  }
  if (typeof parsed.lastActivityDate === 'undefined') parsed.lastActivityDate = null;
  ['metivtaNames', 'metivtaExtraNames', 'metivtaClass', 'metivtaExtraClass', 'editTimes'].forEach(k => {
    if (!parsed[k] || typeof parsed[k] !== 'object' || Array.isArray(parsed[k])) parsed[k] = {};
  });
  if (!Array.isArray(parsed.metivtaArchivedKeys)) parsed.metivtaArchivedKeys = [];
  if (!Array.isArray(parsed.recentOpIds)) parsed.recentOpIds = [];
  ensureMetivtaTests(parsed);
  return parsed;
}

// The Metivta tests table: columns = [{ id, title }], scores = { column id: { row key: score } }.
// There is always an empty column at the end, ready for the next test.
function ensureMetivtaTests(main){
  let t = main.metivtaTests;
  if (!t || typeof t !== 'object' || Array.isArray(t)) t = main.metivtaTests = {};
  if (!Array.isArray(t.columns)) t.columns = [];
  if (!t.scores || typeof t.scores !== 'object' || Array.isArray(t.scores)) t.scores = {};
  if (!t.columns.length) t.columns.push({ id: 't-first', title: '' });
  return t;
}

function emptyMainDoc(){
  const d = defaultState();
  delete d.archive;
  return d;
}

// Deliberately does not swallow a failed read into "no data" - a transient
// read failure must never look identical to "this document genuinely
// doesn't exist yet", which is the one case that starts from a blank board.
async function loadState(){
  const snap = await getDoc(stateDocRef);
  let main = snap.exists() ? snap.data() : null;
  if (main && !(Array.isArray(main.students) && main.students.length === TOTAL_STUDENTS)){
    const err = new Error('הנתונים שנטענו מהשרת אינם בפורמט תקין');
    err.badFormat = true;
    throw err;
  }
  if (main) lastServerMainJson = JSON.stringify(main);
  const [days, weeks] = await Promise.all([fetchArchiveDays(), fetchArchiveWeeksMap()]);
  serverSnap = { main: main || emptyMainDoc(), dailyDays: days, weeks };
  rebuildView();
}

// ---- Saving: every change is a small operation ----
// A click never writes the whole board. Each change becomes an operation
// ("student 3, 8:10 -> 3 points") that is kept in this browser's storage
// until the server has it, so nothing is lost offline, on a refresh or when
// the computer is switched off. Syncing replays the waiting operations, in
// a transaction, on top of the server's current data - other computers'
// changes are never overwritten wholesale.
//
// - Last edit wins: an operation that sets a cell carries the time it was
//   made, and every document keeps the time of each cell's latest edit
//   (editTimes). An older edit that arrives late never replaces a newer one.
// - Additive changes (minus points, purchases, closing the "+" round) are
//   applied as they are, so changes from two computers add up.
// - Each operation is applied once: the main document remembers the ids of
//   recently applied operations (recentOpIds).
// - An operation is dated by the day it was made (days switch at 01:00). If
//   that day was already archived by the time it reaches the server, it is
//   applied to that day in the archive instead of to today's board; if the
//   board still holds an earlier day, that day is archived first.
//
// What is drawn is always: the last copy read from the server (serverSnap)
// + the operations still waiting (pendingOps).
const PENDING_OPS_KEY = 'classroom-pending-ops-v1';
const MAX_RECENT_OP_IDS = 400;
const SYNC_BATCH = 40;
const SAVE_STALL_MS = 8000;
const SAVE_RETRY_MS = 5000;

let serverSnap = null; // { main, dailyDays, weeks: { weekKey: doc } }
let pendingOps = loadPendingOps();
let syncRunning = false;
let syncTimer = null;
let syncFailed = false;
let syncStalled = false;
let lastSaveFailureReason = '';
let lastViewJson = '';

function loadPendingOps(){
  try{
    const list = JSON.parse(localStorage.getItem(PENDING_OPS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch(e){
    return [];
  }
}

function persistPendingOps(){
  try{ localStorage.setItem(PENDING_OPS_KEY, JSON.stringify(pendingOps)); } catch(e){}
}

// Another tab of the site on this computer changed the waiting list.
window.addEventListener('storage', (e) => {
  if (e.key !== PENDING_OPS_KEY) return;
  pendingOps = loadPendingOps();
  if (serverSnap) rebuildViewAndRender();
});

// Kinds that change today's board (dated by the day they were made).
const DAY_OP_KINDS = new Set(['cat', 'minus', 'purchase', 'resetCol', 'freq', 'mflags']);

function newOpId(){
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---- The history of edits of the archive tables and of הנוסע המתמיד ----
// Written once per saved edit: {id, t, table, name, field, week, day, old, new}
// into editLog/<the day it was made>, read by the admin page.
const EDIT_LOG_FIELD_LABELS = {
  bonus: 'בונוס', morning: 'חסידות', tefila: 'תפילה', mikvaotVal: 'מקוואות', rambamVal: 'רמב"ם', metivtaVal: 'מתיבתא',
  purchases: 'קניות', minusTotal: 'מינוס', metivtaFlags: 'מתיבתא'
};
function editLogFieldLabel(field){
  if (field.startsWith('cat:')) return categoryLabel(field.slice(4)) || field;
  const weekly = [...WEEKLY_CLASS_FIELD_DEFS, ...WEEKLY_PARENT_FIELD_DEFS].find(f => f.field === field);
  return EDIT_LOG_FIELD_LABELS[field] || (weekly && weekly.label) || field;
}
function editLogValue(v){
  if (v === true) return '✓';
  if (v === false || v === undefined || v === null) return '0';
  return String(v);
}
function buildEditLog(op){
  if (op.kind !== 'weekCell' && op.kind !== 'archiveCell') return null;
  const log = { id: op.id, t: op.t, field: editLogFieldLabel(op.field) };
  if (op.kind === 'weekCell'){
    const week = (state.archive || []).find(e => e.type === 'weekly' && e.weekKey === op.weekKey);
    const rec = week && (week.students || []).find(x => x.id === op.sid);
    const def = [...WEEKLY_CLASS_FIELD_DEFS, ...WEEKLY_PARENT_FIELD_DEFS].find(f => f.field === op.field);
    const ratio = !op.target && def && def.ratio ? def.ratio : 1;
    const raw = op.target ? ((rec && rec.days && rec.days[op.target]) || {})[op.field] : (rec || {})[op.field];
    log.table = op.src === 'archive' ? 'ארכיון' : 'הנוסע המתמיד';
    log.name = op.src === 'archive' ? studentName(op.sid) : metivtaFullName(op.sid, false);
    log.week = week ? weeklyEntryLabel(week) : op.weekKey;
    if (op.target){ log.day = op.target; log.dayLabel = formatHebrewDateShort(new Date(op.target + 'T12:00:00')); }
    log.old = editLogValue(typeof raw === 'number' ? raw * ratio : raw);
    log.new = editLogValue(typeof op.value === 'number' ? op.value * ratio : op.value);
    return log;
  }
  const entry = (state.archive || []).find(e => e.type !== 'weekly' && dayKeyOf(e.date) === op.target);
  const extra = op.group === 'extra';
  const rec = entry && (extra ? (entry.metivtaExtraStudents || []) : (entry.students || [])).find(x => x.id === op.sid);
  log.day = op.target;
  log.dayLabel = formatHebrewDateShort(new Date(op.target + 'T12:00:00'));
  if (op.field === 'metivtaFlags'){
    log.table = 'מתיבתא';
    log.name = metivtaFullName(op.sid, extra);
    log.old = rec && rec.metivtaFlags ? 'ציון ' + metivtaDayScore(rec.metivtaFlags) : '-';
    log.new = 'ציון ' + metivtaDayScore(op.value);
    return log;
  }
  log.table = 'ארכיון';
  log.name = studentName(op.sid);
  const old = op.field.startsWith('cat:') ? ((rec && rec.cats) || {})[op.field.slice(4)] : rec && rec[op.field];
  log.old = editLogValue(old || 0);
  log.new = editLogValue(op.value);
  return log;
}

function editLogDayKey(op){
  return dayKeyOf(new Date(op.t).toISOString());
}
function editLogDocRef(day){
  return doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'editLog', day);
}

function commitOp(op){
  op.id = newOpId();
  op.t = Date.now();
  if (DAY_OP_KINDS.has(op.kind)) op.day = activityDayStr();
  // Edits of the archive tables and of הנוסע המתמיד are written to the
  // updates history (read in the admin page) when the change is saved.
  try{ const log = buildEditLog(op); if (log) op.log = log; } catch(e){}
  pendingOps.push(op);
  persistPendingOps();
  deferWeeklyRender = DAY_OP_KINDS.has(op.kind);
  try{ rebuildViewAndRender(); } finally { deferWeeklyRender = false; }
  scheduleSync(0);
}

function cloneSnap(snap){
  return JSON.parse(JSON.stringify(snap));
}

function rebuildView(){
  const applied = new Set(serverSnap.main.recentOpIds || []);
  if (pendingOps.some(o => applied.has(o.id))){
    pendingOps = pendingOps.filter(o => !applied.has(o.id));
    persistPendingOps();
  }
  const snap = cloneSnap(serverSnap);
  snap.main = normalizeMain(snap.main);
  applyOpsToSnapshot(snap, pendingOps);
  const view = snap.main;
  view.archive = [...snap.dailyDays, ...Object.values(snap.weeks)];
  state = view;
}

// Redraws only when what is shown actually changed, so a sync that merely
// confirms what is already on screen doesn't close an open dropdown.
// What decides whether the screen must be drawn again. The list of recently
// applied operations changes when a save is confirmed, but nothing shows it,
// so it is left out - otherwise every confirmed save redrew everything.
function viewSignature(){
  return JSON.stringify(state, (key, value) => key === 'recentOpIds' ? undefined : value);
}

function rebuildViewAndRender(){
  rebuildView();
  const json = viewSignature();
  refreshSaveBanner();
  if (json === lastViewJson) return;
  lastViewJson = json;
  renderAll();
}

// The table row at the middle of the screen: after a redraw it is put back at
// the same place on the screen, even if something above it changed height, so
// a row never seems to slide down after an update.
function captureRowAnchor(){
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const tr = el && el.closest ? el.closest('tbody tr') : null;
  // (Not for הנוסע המתמיד and the archive: their rows never move after an
  // update, and a page that scrolls by itself after an edit is not wanted.)
  const container = tr && tr.closest('#boards, #metivtaView, #z1View');
  if (!container) return null;
  const table = tr.closest('table');
  return { containerId: container.id, tableIndex: [...container.querySelectorAll('table')].indexOf(table), key: rowAnchorKey(tr), top: tr.getBoundingClientRect().top };
}

function rowAnchorKey(tr){
  return (tr.dataset.studentId || '') + '|' + (tr.cells[0] ? tr.cells[0].textContent : '');
}

function restoreRowAnchor(a){
  if (!a) return;
  const container = document.getElementById(a.containerId);
  const table = container && container.querySelectorAll('table')[a.tableIndex];
  const tr = table && [...table.tBodies[0].rows].find(r => rowAnchorKey(r) === a.key);
  if (!tr) return;
  const delta = tr.getBoundingClientRect().top - a.top;
  if (Math.abs(delta) > 1) window.scrollBy(0, delta);
}

let deferWeeklyRender = false;
let weeklyRenderTimer = null;
const WEEKLY_RENDER_DELAY_MS = 350;

function renderAll(){
  // Redrawing empties the tables for a moment, which would scroll the page
  // back to the top - keep it (and any scrolled table) where it was.
  const keep = captureScrollPositions();
  const anchor = captureRowAnchor();
  const held = holdHeights();
  try{
    render();
    if (document.getElementById('frequentArchiveView').style.display !== 'none'){
      // After a click on today's board the weekly table (the heaviest part to
      // draw) is redrawn a moment later, so the board answers at once and a
      // quick series of clicks redraws it only once.
      if (deferWeeklyRender){
        clearTimeout(weeklyRenderTimer);
        weeklyRenderTimer = setTimeout(() => {
          if (state && document.getElementById('frequentArchiveView').style.display !== 'none') renderFrequentFlyerView();
        }, WEEKLY_RENDER_DELAY_MS);
      } else {
        clearTimeout(weeklyRenderTimer);
        renderFrequentFlyerView();
      }
    }
    if (document.getElementById('metivtaView').style.display !== 'none') renderMetivtaView();
    if (document.getElementById('z1View').style.display !== 'none') renderZ1View();
    restoreScrollPositions(keep);
    restoreRowAnchor(anchor);
  } finally {
    releaseHeights(held, keep);
  }
}

// While a table is redrawn it is empty for a moment, and the page would get
// shorter and be scrolled up by the browser. The parts of the page keep their
// height until the redraw is done.
function holdHeights(){
  const els = ['boards', 'todaySummary', 'frequentArchiveView', 'metivtaView', 'z1View'].map(id => document.getElementById(id)).filter(Boolean);
  els.forEach(el => { if (el.offsetHeight) el.style.minHeight = el.offsetHeight + 'px'; });
  return els;
}

function releaseHeights(els, keep){
  els.forEach(el => { el.style.minHeight = ''; });
  if (keep && (window.scrollX !== keep.x || window.scrollY !== keep.y)) window.scrollTo(keep.x, keep.y);
}

// Redraws a table without moving the page (see renderAll).
function keepScroll(draw){
  const keep = captureScrollPositions();
  const anchor = captureRowAnchor();
  const held = holdHeights();
  try{
    draw();
    restoreScrollPositions(keep);
    restoreRowAnchor(anchor);
  } finally {
    releaseHeights(held, keep);
  }
}

function captureScrollPositions(){
  const inner = [];
  document.querySelectorAll('body *').forEach(el => {
    if (el.scrollTop || el.scrollLeft){
      const same = el.className ? document.getElementsByClassName(el.className.split(' ')[0]) : [];
      inner.push({ cls: el.className, index: [...same].indexOf(el), top: el.scrollTop, left: el.scrollLeft });
    }
  });
  return { x: window.scrollX, y: window.scrollY, inner };
}

function restoreScrollPositions(keep){
  keep.inner.forEach(k => {
    if (!k.cls) return;
    const el = document.getElementsByClassName(k.cls.split(' ')[0])[k.index];
    if (el){ el.scrollTop = k.top; el.scrollLeft = k.left; }
  });
  if (window.scrollX !== keep.x || window.scrollY !== keep.y) window.scrollTo(keep.x, keep.y);
}

// ---- applying operations (pure: the same code builds what is shown and
// what a sync transaction writes) ----

function acceptEdit(holder, cellKey, t){
  if (!holder.editTimes || typeof holder.editTimes !== 'object') holder.editTimes = {};
  if ((holder.editTimes[cellKey] || 0) > t) return false;
  holder.editTimes[cellKey] = t;
  return true;
}

function latestArchivedDay(dailyDays){
  return (dailyDays || []).reduce((max, e) => {
    const k = dayKeyOf(e.date);
    return k > max ? k : max;
  }, '');
}

// Where an operation made on day `day` belongs right now.
function routeDay(snap, day){
  const live = snap.main.lastActivityDate;
  if (live) return day === live ? 'live' : (day > live ? 'reset' : 'archived');
  const lastArchived = snap.main.lastArchivedDay || latestArchivedDay(snap.dailyDays);
  return (lastArchived && day <= lastArchived) ? 'archived' : 'live';
}

function applyOpsToSnapshot(snap, ops){
  const touched = { main: false, daily: false, weeks: new Set() };
  const done = new Set(snap.main.recentOpIds || []);
  ops.forEach(op => {
    if (done.has(op.id)) return;
    applyOp(snap, op, touched);
    done.add(op.id);
    snap.main.recentOpIds = [...(snap.main.recentOpIds || []), op.id].slice(-MAX_RECENT_OP_IDS);
    touched.main = true;
  });
  return touched;
}

function applyOp(snap, op, touched){
  const main = snap.main;
  if (op.kind === 'weekCell') return applyWeekCellOp(snap, op, touched);
  if (op.kind === 'archiveCell') return applyArchiveCellOp(snap, op, touched);
  if (op.kind === 'addMetivtaDay'){
    // A past day added as a Metivta column (the board may not have been
    // used that day); it stays shown even before any mark is entered.
    ensureArchivedDay(snap, op.target, touched).metivtaAddedDay = true;
    return;
  }
  if (!DAY_OP_KINDS.has(op.kind)) return applyGlobalOp(main, op);
  let route = routeDay(snap, op.day);
  if (route === 'reset'){
    archiveLiveDayInSnapshot(snap, touched);
    route = routeDay(snap, op.day);
  }
  if (route === 'live'){
    applyLiveOp(snap.main, op);
    snap.main.lastActivityDate = op.day;
  } else {
    applyArchivedDayOp(snap, op, touched);
  }
}

function archiveLiveDayInSnapshot(snap, touched){
  const live = snap.main.lastActivityDate;
  const weekKey = getWeekKey(new Date(live + 'T12:00:00'));
  const r = computeDailyResetUpdate(snap.main, snap.dailyDays, snap.weeks[weekKey] || null);
  snap.main = r.newMainData;
  snap.dailyDays = r.newDailyDays;
  snap.weeks[weekKey] = r.newWeeklyEntry;
  touched.daily = true;
  touched.weeks.add(weekKey);
}

function opTargetList(main, group){
  return group === 'extra' ? main.metivtaExtra : main.students;
}

function applyLiveOp(main, op){
  const st = op.sid ? opTargetList(main, op.group).find(x => x.id === op.sid) : null;
  if (op.kind === 'cat'){
    if (st && acceptEdit(main, 'd:cat:' + op.sid + ':' + op.key, op.t)) st.cats[op.key] = op.value;
  } else if (op.kind === 'minus'){
    if (st) st.minusTotal = Math.min(0, (st.minusTotal || 0) + op.delta);
  } else if (op.kind === 'purchase'){
    if (st){ st.cumulative = (st.cumulative || 0) - PURCHASE_COST; st.purchases = (st.purchases || 0) + 1; }
  } else if (op.kind === 'resetCol'){
    const category = CATEGORIES.find(c => c.key === op.key);
    main.students.forEach(s => {
      s.cumulative = (s.cumulative || 0) + (s.cats[op.key] || 0);
      if (category && category.cumulativeKey) s[category.cumulativeKey] = (s[category.cumulativeKey] || 0) + (s.cats[op.key] || 0);
      s.cats[op.key] = 0;
    });
  } else if (op.kind === 'freq'){
    if (st && acceptEdit(main, 'd:freq:' + op.sid + ':' + op.key, op.t)){
      if (!st.frequent) st.frequent = { mikvaot: 0, rambam: 0 };
      if (!st.frequentFrozen) st.frequentFrozen = { mikvaot: 0, rambam: 0 };
      if (!!st.frequent[op.key] !== op.on){
        st.frequent[op.key] = op.on ? 2 : 0;
        st.frequentFrozen[op.key] = (st.frequentFrozen[op.key] || 0) + (op.on ? 2 : -2);
      }
    }
  } else if (op.kind === 'mflags'){
    if (st && acceptEdit(main, 'd:mflags:' + op.group + ':' + op.sid, op.t)) st.metivtaFlags = { ...op.flags };
  }
}

function applyGlobalOp(main, op){
  if (op.kind === 'pref'){
    if (!acceptEdit(main, 'g:pref:' + op.key, op.t)) return;
    if (op.key === 'minusShopActive') main.minusShopActive = op.value;
    else if (op.key.startsWith('mergedActive.')) main.mergedActive[parseInt(op.key.split('.')[1], 10)] = op.value;
  } else if (op.kind === 'mname'){
    if (!acceptEdit(main, 'g:mname:' + op.group + ':' + op.sid + ':' + op.part, op.t)) return;
    const map = op.group === 'extra' ? main.metivtaExtraNames : main.metivtaNames;
    const entry = normalizeMetivtaNameEntry(map[op.sid]);
    entry[op.part] = op.value;
    map[op.sid] = entry;
  } else if (op.kind === 'mclass'){
    if (!acceptEdit(main, 'g:mclass:' + op.group + ':' + op.sid, op.t)) return;
    (op.group === 'extra' ? main.metivtaExtraClass : main.metivtaClass)[op.sid] = op.value;
  } else if (op.kind === 'testTitle'){
    if (!acceptEdit(main, 'g:ttitle:' + op.colId, op.t)) return;
    const col = ensureMetivtaTests(main).columns.find(c => c.id === op.colId);
    if (col) col.title = op.value;
  } else if (op.kind === 'testScore'){
    if (!acceptEdit(main, 'g:tscore:' + op.colId + ':' + op.rowKey, op.t)) return;
    const tests = ensureMetivtaTests(main);
    if (!tests.columns.some(c => c.id === op.colId)) return;
    const scores = tests.scores[op.colId] || (tests.scores[op.colId] = {});
    if (op.value === '' || op.value === null || op.value === undefined) delete scores[op.rowKey];
    else scores[op.rowKey] = op.value;
    // A test column that got a score: the next, empty one is added after it.
    const last = tests.columns[tests.columns.length - 1];
    if (last && Object.keys(tests.scores[last.id] || {}).length) tests.columns.push({ id: 't-' + op.id, title: '' });
  } else if (op.kind === 'testDelete'){
    if (!acceptEdit(main, 'g:tdelete:' + op.colId, op.t)) return;
    const tests = ensureMetivtaTests(main);
    tests.columns = tests.columns.filter(c => c.id !== op.colId);
    delete tests.scores[op.colId];
    ensureMetivtaTests(main);
  } else if (op.kind === 'marchived'){
    if (!acceptEdit(main, 'g:marchived:' + op.key, op.t)) return;
    const set = new Set(main.metivtaArchivedKeys || []);
    if (op.archived) set.add(op.key); else set.delete(op.key);
    main.metivtaArchivedKeys = [...set];
  }
}

const DEFAULT_METIVTA_FLAGS = { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 };

// The archived day entry for `day`, created (empty) if that day never
// reached the server's archive - e.g. a day used only on an offline computer.
function ensureArchivedDay(snap, day, touched){
  let entry = snap.dailyDays.find(e => dayKeyOf(e.date) === day);
  if (!entry){
    entry = {
      date: new Date(day + 'T12:00:00').toISOString(),
      students: snap.main.students.map(s => ({ id: s.id, cats: Object.fromEntries(CATEGORIES.map(c => [c.key, 0])), purchases: 0, minusTotal: 0, metivtaFlags: { ...DEFAULT_METIVTA_FLAGS } })),
      metivtaExtraStudents: (snap.main.metivtaExtra || []).map(s => ({ id: s.id, metivtaFlags: { ...DEFAULT_METIVTA_FLAGS } }))
    };
    snap.dailyDays.push(entry);
    snap.dailyDays.sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  touched.daily = true;
  return entry;
}

function ensureArchivedRecord(entry, group, sid){
  const key = group === 'extra' ? 'metivtaExtraStudents' : 'students';
  if (!Array.isArray(entry[key])) entry[key] = [];
  let rec = entry[key].find(x => x.id === sid);
  if (!rec){
    rec = group === 'extra' ? { id: sid, metivtaFlags: { ...DEFAULT_METIVTA_FLAGS } }
      : { id: sid, cats: Object.fromEntries(CATEGORIES.map(c => [c.key, 0])), purchases: 0, minusTotal: 0, metivtaFlags: { ...DEFAULT_METIVTA_FLAGS } };
    entry[key].push(rec);
  }
  if (group !== 'extra' && !rec.cats) rec.cats = {};
  return rec;
}

function ensureWeekDoc(snap, weekKey, touched){
  if (!snap.weeks[weekKey]){
    const ws = new Date(weekKey + 'T12:00:00');
    snap.weeks[weekKey] = {
      type: 'weekly', title: 'הנוסע המתמיד', weekKey,
      weekStart: getWeekStart(ws).toISOString(), date: new Date(weekKey + 'T12:00:00').toISOString(),
      students: [], weekParsha: null
    };
  }
  touched.weeks.add(weekKey);
  const week = snap.weeks[weekKey];
  if (!Array.isArray(week.students)) week.students = [];
  return week;
}

function ensureWeekStudent(week, sid){
  let rec = week.students.find(x => x.id === sid);
  if (!rec){ rec = { id: sid, days: {} }; week.students.push(rec); }
  if (!rec.days) rec.days = {};
  return rec;
}

// The weekly (הנוסע המתמיד) values of one archived day that come straight
// from that day's board - same formulas as computeDailyResetUpdate.
function weeklyValueFromDay(field, rec){
  const cats = rec.cats || {};
  if (field === 'morning') return Math.round((cats.c1 || 0) * (2 / 3));
  if (field === 'tefila') return (cats.c7 || 0) + (cats.c3 || 0) + (cats.c9 || 0);
  if (field === 'bonus') return (rec.minusTotal || 0) === 0 ? 1 : 0;
  if (field === 'metivtaVal') return metivtaDayScore(rec.metivtaFlags || DEFAULT_METIVTA_FLAGS);
  return 0;
}

function refreshWeeklyFromDay(snap, day, sid, rec, fields, t, touched){
  const week = ensureWeekDoc(snap, getWeekKey(new Date(day + 'T12:00:00')), touched);
  const ws = ensureWeekStudent(week, sid);
  if (!ws.days[day]) ws.days[day] = {};
  fields.forEach(f => {
    if (acceptEdit(week, 'w:' + sid + ':' + f + ':' + day, t)) ws.days[day][f] = weeklyValueFromDay(f, rec);
  });
}

// Whether a student is in class ז1 right now (and not in the Metivta archive).
function isZ1Student(main, group, sid){
  const map = (group === 'extra' ? main.metivtaExtraClass : main.metivtaClass) || {};
  const raw = map[sid];
  const cls = String((raw === undefined || raw === null || raw === '') ? (group === 'extra' ? 1 : 2) : raw).replace(/^ז\s*/, '');
  return cls === '1' && !(main.metivtaArchivedKeys || []).includes(group + '-' + sid);
}

// The מתיבתא ז1 value of an archived day follows a corrected Metivta mark.
function refreshZ1FromDay(snap, day, group, sid, flags, t, touched){
  const key = group + '-' + sid;
  const week = ensureWeekDoc(snap, getWeekKey(new Date(day + 'T12:00:00')), touched);
  if (!Array.isArray(week.z1Students)) week.z1Students = [];
  let zr = week.z1Students.find(x => x.key === key);
  if (!zr){
    if (!isZ1Student(snap.main, group, sid)) return;
    zr = { key, days: {} };
    week.z1Students.push(zr);
  }
  if (!zr.days) zr.days = {};
  if (acceptEdit(week, 'w:z1:' + key + ':metivtaVal:' + day, t)) zr.days[day] = { metivtaVal: metivtaDayScore(flags || DEFAULT_METIVTA_FLAGS) };
}

// A board change that reaches the server after its day was already archived.
function applyArchivedDayOp(snap, op, touched){
  if (op.kind === 'resetCol') return;
  if (op.kind === 'freq'){
    const week = ensureWeekDoc(snap, getWeekKey(new Date(op.day + 'T12:00:00')), touched);
    const ws = ensureWeekStudent(week, op.sid);
    const field = op.key === 'rambam' ? 'rambamVal' : 'mikvaotVal';
    if (!ws.days[op.day]) ws.days[op.day] = {};
    if (!acceptEdit(week, 'w:' + op.sid + ':' + field + ':' + op.day, op.t)) return;
    const cur = ws.days[op.day][field] || 0;
    if (op.on && cur < 2) ws.days[op.day][field] = cur + 2;
    if (!op.on && cur >= 2) ws.days[op.day][field] = cur - 2;
    return;
  }
  const entry = ensureArchivedDay(snap, op.day, touched);
  const group = op.group === 'extra' ? 'extra' : 'main';
  const rec = ensureArchivedRecord(entry, group, op.sid);
  if (op.kind === 'cat'){
    if (!acceptEdit(entry, 'd:cat:' + op.sid + ':' + op.key, op.t)) return;
    rec.cats[op.key] = op.value;
    refreshWeeklyFromDay(snap, op.day, op.sid, rec, ['morning', 'tefila'], op.t, touched);
  } else if (op.kind === 'minus'){
    rec.minusTotal = Math.min(0, (rec.minusTotal || 0) + op.delta);
    refreshWeeklyFromDay(snap, op.day, op.sid, rec, ['bonus'], op.t, touched);
  } else if (op.kind === 'purchase'){
    rec.purchases = (rec.purchases || 0) + 1;
  } else if (op.kind === 'mflags'){
    if (!acceptEdit(entry, 'd:mflags:' + group + ':' + op.sid, op.t)) return;
    rec.metivtaFlags = { ...op.flags };
    if (group === 'main') refreshWeeklyFromDay(snap, op.day, op.sid, rec, ['metivtaVal'], op.t, touched);
    refreshZ1FromDay(snap, op.day, group, op.sid, op.flags, op.t, touched);
  }
}

// Editing a הנוסע המתמיד cell by hand (target = a day, or null for a
// whole-week field such as the parents' answers).
function applyWeekCellOp(snap, op, touched){
  const week = ensureWeekDoc(snap, op.weekKey, touched);
  const ws = ensureWeekStudent(week, op.sid);
  if (!acceptEdit(week, 'w:' + op.sid + ':' + op.field + ':' + (op.target || 'week'), op.t)) return;
  if (op.target){
    if (!ws.days[op.target]) ws.days[op.target] = {};
    ws.days[op.target][op.field] = op.value;
  } else {
    ws[op.field] = op.value;
  }
}

// Editing an archived day of the class board or the Metivta by hand.
// field: 'cat:<key>' | 'purchases' | 'minusTotal' | 'metivtaFlags'.
function applyArchiveCellOp(snap, op, touched){
  const entry = snap.dailyDays.find(e => dayKeyOf(e.date) === op.target);
  if (!entry) return;
  touched.daily = true;
  const group = op.group === 'extra' ? 'extra' : 'main';
  const rec = ensureArchivedRecord(entry, group, op.sid);
  const cellKey = op.field === 'metivtaFlags' ? 'd:mflags:' + group + ':' + op.sid
    : op.field.startsWith('cat:') ? 'd:cat:' + op.sid + ':' + op.field.slice(4)
    : 'd:' + op.field + ':' + op.sid;
  if (!acceptEdit(entry, cellKey, op.t)) return;
  // הנוסע המתמיד takes these from the archived day, so it follows the edit.
  if (op.field === 'metivtaFlags'){
    rec.metivtaFlags = { ...op.value };
    if (group === 'main') refreshWeeklyFromDay(snap, op.target, op.sid, rec, ['metivtaVal'], op.t, touched);
    refreshZ1FromDay(snap, op.target, group, op.sid, op.value, op.t, touched);
    return;
  }
  if (op.field.startsWith('cat:')) rec.cats[op.field.slice(4)] = op.value;
  else rec[op.field] = op.value;
  const derived = op.field === 'cat:c1' ? ['morning']
    : (op.field === 'cat:c7' || op.field === 'cat:c3' || op.field === 'cat:c9') ? ['tefila']
    : op.field === 'minusTotal' ? ['bonus'] : [];
  if (group === 'main' && derived.length) refreshWeeklyFromDay(snap, op.target, op.sid, rec, derived, op.t, touched);
}

// Which archive documents a sync transaction must read for these operations
// (reading one too many is harmless; one too few is not).
function archiveDocsNeeded(main, ops){
  let daily = false;
  const weekKeys = new Set();
  const live = main.lastActivityDate;
  const weekOf = (day) => getWeekKey(new Date(day + 'T12:00:00'));
  ops.forEach(op => {
    if (op.kind === 'weekCell'){ weekKeys.add(op.weekKey); return; }
    if (op.kind === 'archiveCell'){ daily = true; weekKeys.add(weekOf(op.target)); return; }
    if (op.kind === 'addMetivtaDay'){ daily = true; return; }
    if (!DAY_OP_KINDS.has(op.kind)) return;
    if (live && op.day === live) return;
    if (!live && main.lastArchivedDay && op.day > main.lastArchivedDay) return;
    daily = true;
    weekKeys.add(weekOf(op.day));
    if (live) weekKeys.add(weekOf(live));
  });
  return { daily, weekKeys: [...weekKeys] };
}

// ---- syncing ----

function hasUnsavedChanges(){
  return pendingOps.length > 0 && (syncFailed || syncStalled);
}

function refreshSaveBanner(){
  setSaveFailedBanner(hasUnsavedChanges(), lastSaveFailureReason);
}

function scheduleSync(delay){
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPendingOps, delay);
}

window.addEventListener('online', () => scheduleSync(0));

async function syncPendingOps(){
  syncTimer = null;
  if (syncRunning || !pendingOps.length || !firestoreDb || !serverSnap) return;
  syncRunning = true;
  const batch = pendingOps.slice(0, SYNC_BATCH);
  setStatus('שומר…');
  const stallTimer = setTimeout(() => {
    syncStalled = true;
    lastSaveFailureReason = SAVE_STALLED_REASON;
    refreshSaveBanner();
  }, SAVE_STALL_MS);
  let result = null;
  try{
    result = await runTransaction(firestoreDb, async (tx) => {
      const mainSnap = await tx.get(stateDocRef);
      const main = normalizeMain(mainSnap.exists() ? mainSnap.data() : emptyMainDoc());
      if (main.students.length !== TOTAL_STUDENTS) throw new Error('הנתונים בשרת אינם בפורמט תקין');
      const need = archiveDocsNeeded(main, batch);
      let dailyDays = null;
      if (need.daily){
        const ds = await tx.get(dailyArchiveDocRef);
        dailyDays = ds.exists() && Array.isArray(ds.data().days) ? ds.data().days : [];
      }
      const weeks = {};
      for (const wk of need.weekKeys){
        const w = await tx.get(weekDocRef(wk));
        if (w.exists()) weeks[wk] = w.data();
      }
      // The updates history: the entries of the days of these edits.
      const logOps = batch.filter(o => o.log);
      const logEntries = {};
      for (const day of new Set(logOps.map(editLogDayKey))){
        const ls = await tx.get(editLogDocRef(day));
        logEntries[day] = ls.exists() && Array.isArray(ls.data().entries) ? ls.data().entries : [];
      }
      const snap = { main, dailyDays: dailyDays || [], weeks };
      const touched = applyOpsToSnapshot(snap, batch);
      logOps.forEach(o => {
        const entries = logEntries[editLogDayKey(o)];
        if (!entries.some(x => x.id === o.id)) entries.push(o.log);
      });
      Object.keys(logEntries).forEach(day => tx.set(editLogDocRef(day), { day, entries: logEntries[day] }));
      tx.set(stateDocRef, snap.main);
      if (touched.daily && dailyDays !== null) tx.set(dailyArchiveDocRef, { days: snap.dailyDays });
      touched.weeks.forEach(wk => tx.set(weekDocRef(wk), snap.weeks[wk]));
      return { snap, touched, readDaily: dailyDays !== null };
    });
  } catch(e){
    syncFailed = true;
    lastSaveFailureReason = describeSaveError(e);
    setStatus('שמירה נכשלה');
  }
  clearTimeout(stallTimer);
  syncStalled = false;
  if (result){
    syncFailed = false;
    const ids = new Set(batch.map(o => o.id));
    pendingOps = pendingOps.filter(o => !ids.has(o.id));
    persistPendingOps();
    archiveWriteVersion++;
    serverSnap.main = result.snap.main;
    lastServerMainJson = JSON.stringify(result.snap.main);
    if (result.readDaily) serverSnap.dailyDays = result.snap.dailyDays;
    result.touched.weeks.forEach(wk => { serverSnap.weeks[wk] = result.snap.weeks[wk]; });
    setStatus('נשמר');
    setTimeout(() => setStatus(''), 1200);
  }
  syncRunning = false;
  rebuildViewAndRender();
  if (pendingOps.length) scheduleSync(syncFailed ? SAVE_RETRY_MS : 0);
  else if (archiveRefreshWanted){
    archiveRefreshWanted = false;
    refreshArchiveAndRender();
  }
}
function studentTotal(student){
  const todayCats = CATEGORIES.reduce((sum, c) => sum + (student.cats[c.key] || 0), 0);
  const todayPurchaseCost = (student.purchases || 0) * PURCHASE_COST;
  const todayNet = todayCats + (student.c5Total || 0) + (student.minusTotal || 0) - todayPurchaseCost;

  const archiveDailyEntries = (state.archive || []).filter(e => e.type !== 'weekly');
  const archiveSum = archiveDailyEntries.reduce((sum, entry) => {
    const s = (entry.students || []).find(x => x.id === student.id);
    if (!s) return sum;
    const catsSum = CATEGORIES.reduce((sum2, c) => sum2 + ((s.cats && s.cats[c.key]) || 0), 0);
    const purchaseCost = (s.purchases || 0) * PURCHASE_COST;
    return sum + catsSum + (s.minusTotal || 0) - purchaseCost;
  }, 0);

  return todayNet + archiveSum;
}

function runRaffle(){
  const candidates = state.students.filter(s => !s.cats.c5);
  if (candidates.length === 0){
    showModal('כל התלמידים כבר קיבלו נקודה בסיבוב הנוכחי של "+".', { showCancel: false, confirmText: 'הבנתי' });
    return;
  }
  const winner = candidates[Math.floor(Math.random() * candidates.length)];
  highlightWinner(winner.id);
}

function highlightWinner(studentId){
  const rows = document.querySelectorAll('tr[data-student-id="' + studentId + '"]');
  rows.forEach(row => {
    row.classList.remove('flash-yellow');
    void row.offsetWidth;
    row.classList.add('flash-yellow');
    setTimeout(() => { row.classList.remove('flash-yellow'); }, 3100);
  });
}

// The value a click on a point cell leads to. A cell is on (the category's
// value) or off (0). (A prayer minus is not a state of the cell: it is counted
// apart, by the small minus button - see prayerMinusButton.)
function nextCategoryValue(catKey, current){
  const category = CATEGORIES.find(c => c.key === catKey);
  return current ? 0 : category.value;
}

// The small minus button of a תפילה cell: the first press adds a minus; once
// there is one, a press opens a window to take it back or add another.
// `setMinus(newValue)` stores the new count (0 or below).
function prayerMinusButton(current, setMinus){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'prayer-minus-btn';
  btn.textContent = '−';
  btn.title = 'מינוס בתפילה';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!current){ setMinus(-1); return; }
    showChoiceModal('מינוס בתפילה: ' + current, [
      { label: 'ביטול מינוס', onPick: () => setMinus(Math.min(0, current + 1)) },
      { label: 'עוד מינוס', onPick: () => setMinus(current - 1) }
    ]);
  });
  return btn;
}

// A window of buttons; a press outside it closes it.
function showChoiceModal(message, choices){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box';
  const msg = document.createElement('div');
  msg.className = 'modal-msg';
  msg.textContent = message;
  box.appendChild(msg);
  const row = document.createElement('div');
  row.className = 'modal-btns';
  choices.forEach(c => {
    const b = document.createElement('button');
    b.className = 'modal-btn modal-btn-confirm';
    b.textContent = c.label;
    b.addEventListener('click', () => { overlay.remove(); c.onPick(); });
    row.appendChild(b);
  });
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function setPrayerMinus(studentId, value){
  commitOp({ kind: 'cat', group: 'main', sid: studentId, key: 'c9', value });
}

function toggleCell(studentId, catKey){
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  commitOp({ kind: 'cat', group: 'main', sid: studentId, key: catKey, value: nextCategoryValue(catKey, student.cats[catKey]) });
}

const PURCHASE_COST = 8;

function showModal(message, options){
  options = options || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box';

  const msg = document.createElement('div');
  msg.className = 'modal-msg';
  msg.textContent = message;
  box.appendChild(msg);

  const btnRow = document.createElement('div');
  btnRow.className = 'modal-btns';

  if (options.showCancel !== false){
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn modal-btn-cancel';
    cancelBtn.textContent = options.cancelText || 'ביטול';
    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      if (options.onCancel) options.onCancel();
    });
    btnRow.appendChild(cancelBtn);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'modal-btn modal-btn-confirm';
  confirmBtn.textContent = options.confirmText || 'אישור';
  confirmBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (options.onConfirm) options.onConfirm();
  });
  btnRow.appendChild(confirmBtn);

  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function setMergedActive(groupIndex, key){
  commitOp({ kind: 'pref', key: 'mergedActive.' + groupIndex, value: key });
}

function setMinusShopActive(value){
  commitOp({ kind: 'pref', key: 'minusShopActive', value });
}

function resetColumn(catKey){
  const category = CATEGORIES.find(c => c.key === catKey);
  showModal('לאפס את טור "' + category.label + '"? הנקודות שנצברו יתווספו לסה"כ הכולל.', {
    confirmText: 'אישור',
    cancelText: 'ביטול',
    onConfirm: () => commitOp({ kind: 'resetCol', key: catKey })
  });
}

function adjustMinus(studentId, delta){
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  commitOp({ kind: 'minus', group: 'main', sid: studentId, delta });
}

// A click on a minus cell adds a minus; the small + in the corner takes one
// back, never going above 0.
function appendMinusCellEvents(td, student){
  td.style.position = 'relative';
  td.addEventListener('click', () => adjustMinus(student.id, -1));
  if ((student.minusTotal || 0) < 0){
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'status-plus-btn';
    undo.textContent = '+';
    undo.title = 'ביטול מינוס';
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      adjustMinus(student.id, 1);
    });
    td.appendChild(undo);
  }
}

function makePurchase(studentId){
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  const total = studentTotal(student);
  if (total < PURCHASE_COST){
    showModal('אין מספיק נקודות לקניה (נדרשות ' + PURCHASE_COST + ' נקודות).', { showCancel: false, confirmText: 'הבנתי' });
    return;
  }
  showModal('לאשר קניה תמורת ' + PURCHASE_COST + ' נקודות?', {
    confirmText: 'אישור',
    cancelText: 'ביטול',
    onConfirm: () => commitOp({ kind: 'purchase', group: 'main', sid: studentId })
  });
}

function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// The day a change belongs to. Days switch at 01:00 at night (the nightly
// reset), so a change made at 00:30 still belongs to the day before.
function activityDayStr(){
  const d = new Date(Date.now() - AUTO_RESET_HOUR * 3600000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getWeekStart(date){
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function getWeekKey(date){
  const ws = getWeekStart(date);
  return ws.getFullYear() + '-' + String(ws.getMonth() + 1).padStart(2, '0') + '-' + String(ws.getDate()).padStart(2, '0');
}

function mergeEarlierDailyEntry(target, earlier){
  const times = { ...(earlier.editTimes || {}) };
  Object.entries(target.editTimes || {}).forEach(([k, t]) => { times[k] = Math.max(times[k] || 0, t); });
  target.editTimes = times;
  const sumCats = (a, b) => {
    const out = { ...(b || {}) };
    Object.keys(a || {}).forEach(k => { out[k] = (a[k] || 0) + (out[k] || 0); });
    return out;
  };
  (earlier.students || []).forEach(e => {
    const s = target.students.find(x => x.id === e.id);
    if (!s){ target.students.push(e); return; }
    s.cats = sumCats(s.cats, e.cats);
    s.purchases = (s.purchases || 0) + (e.purchases || 0);
    s.minusTotal = (s.minusTotal || 0) + (e.minusTotal || 0);
    if (!metivtaRecordHasFlags(s) && e.metivtaFlags) s.metivtaFlags = { ...e.metivtaFlags };
  });
  (earlier.metivtaExtraStudents || []).forEach(e => {
    const s = target.metivtaExtraStudents.find(x => x.id === e.id);
    if (!s){ target.metivtaExtraStudents.push(e); return; }
    if (!metivtaRecordHasFlags(s) && e.metivtaFlags) s.metivtaFlags = { ...e.metivtaFlags };
  });
}

// Pure function: computes the result of archiving one day (mainData.lastActivityDate)
// from freshly-read documents, without touching any global state. Used inside
// doResetGuarded's transaction so the whole operation - reading the live
// document, the daily-archive document and the one affected week document,
// and writing all three back - happens atomically from one consistent,
// just-read snapshot of each.
function computeDailyResetUpdate(mainData, dailyDays, weeklyEntry){
  const defaultMetivtaFlags = { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 };
  const entryDate = mainData.lastActivityDate
    ? new Date(mainData.lastActivityDate + 'T12:00:00')
    : new Date();
  const entryDayKey = dayKeyOf(entryDate.toISOString());

  const newDailyData = {
    date: entryDate.toISOString(),
    students: mainData.students.map(s => ({
      id: s.id,
      cats: { ...s.cats },
      purchases: s.purchases || 0,
      minusTotal: s.minusTotal || 0,
      metivtaFlags: { ...(s.metivtaFlags || defaultMetivtaFlags) }
    })),
    metivtaExtraStudents: (mainData.metivtaExtra || []).map(s => ({
      id: s.id,
      metivtaFlags: { ...(s.metivtaFlags || defaultMetivtaFlags) }
    })),
    // The day's cell edit times ('d:' keys) move with it into the archive, so
    // a late edit of this day is still judged against them; whole-site
    // settings ('g:' keys) stay on the board.
    editTimes: Object.fromEntries(Object.entries(mainData.editTimes || {}).filter(([k]) => k.startsWith('d:')))
  };

  let days = Array.isArray(dailyDays) ? dailyDays.slice() : [];
  const existingDailyIdx = days.findIndex(e => dayKeyOf(e.date) === entryDayKey);
  if (existingDailyIdx !== -1){
    // The same day was already archived once (an earlier reset followed by
    // more activity that evening, or an earlier mid-day reset) - add this
    // part of the day to it instead of overwriting the earlier part.
    mergeEarlierDailyEntry(newDailyData, days[existingDailyIdx]);
    days.splice(existingDailyIdx, 1);
  }
  days.unshift(newDailyData);
  const MAX_DAILY = 90;
  if (days.length > MAX_DAILY) days = days.slice(0, MAX_DAILY);

  const weekKey = getWeekKey(entryDate);
  // The week's starting point for the cumulative מקוואות/רמב"ם counters is
  // their value before the day being archived - today's checkmarks
  // (s.frequent) are already inside frequentFrozen and belong to this week.
  const weekStartCounter = (s, key) => ((s.frequentFrozen && s.frequentFrozen[key]) || 0) - ((s.frequent && s.frequent[key]) || 0);
  const freshWeeklyStudent = (s) => ({
    id: s.id, morning: 0, tefila: 0, mikve: 0, minusDelta: 0, bonus: 0, days: {},
    baselineMikvaot: weekStartCounter(s, 'mikvaot'),
    baselineRambam: weekStartCounter(s, 'rambam'),
    countedMikvaot: 0, countedRambam: 0,
    chitas: 0, shema: 0, netilatYadaim: 0, minchaMaariv: 0, mikveh: false, dvarTorah: false
  });
  const weeklyEntryOut = weeklyEntry ? JSON.parse(JSON.stringify(weeklyEntry)) : {
    type: 'weekly',
    title: 'הנוסע המתמיד',
    weekKey: weekKey,
    weekStart: getWeekStart(entryDate).toISOString(),
    date: entryDate.toISOString(),
    students: mainData.students.map(freshWeeklyStudent),
    weekParsha: null
  };
  weeklyEntryOut.date = entryDate.toISOString();
  if (!Array.isArray(weeklyEntryOut.students)) weeklyEntryOut.students = [];

  mainData.students.forEach(s => {
    let ws = weeklyEntryOut.students.find(x => x.id === s.id);
    if (!ws){
      ws = freshWeeklyStudent(s);
      weeklyEntryOut.students.push(ws);
    }
    if (!ws.days) ws.days = {};
    // A record created before any reset this week (e.g. by a parent's form)
    // has no starting point yet - take it from now, not from 0, which would
    // count every checkmark since the counters began into this one day.
    if (typeof ws.baselineMikvaot !== 'number') ws.baselineMikvaot = weekStartCounter(s, 'mikvaot');
    if (typeof ws.baselineRambam !== 'number') ws.baselineRambam = weekStartCounter(s, 'rambam');

    const dayMorning = Math.round((s.cats.c1 || 0) * (2 / 3));
    const dayTefila = (s.cats.c7 || 0) + (s.cats.c3 || 0) + (s.cats.c9 || 0);
    const dayBonus = (s.minusTotal || 0) === 0 ? 1 : 0;

    const priorMikvaotSum = Object.values(ws.days).reduce((sum, d) => sum + (d.mikvaotVal || 0), 0);
    const priorRambamSum = Object.values(ws.days).reduce((sum, d) => sum + (d.rambamVal || 0), 0);

    const currentMikvaot = s.frequentFrozen ? (s.frequentFrozen.mikvaot || 0) : 0;
    const currentRambam = s.frequentFrozen ? (s.frequentFrozen.rambam || 0) : 0;

    // How much of the week's counter growth earlier resets already turned
    // into day values - tracked on its own, not re-derived from the day
    // values, so a day value corrected by hand in the archive is not taken
    // back from the next day's count. Weeks from before this field existed
    // fall back to the sum of their day values.
    const countedMikvaot = typeof ws.countedMikvaot === 'number' ? ws.countedMikvaot : priorMikvaotSum;
    const countedRambam = typeof ws.countedRambam === 'number' ? ws.countedRambam : priorRambamSum;
    const dayMikvaotVal = currentMikvaot - ws.baselineMikvaot - countedMikvaot;
    const dayRambamVal = currentRambam - ws.baselineRambam - countedRambam;
    ws.countedMikvaot = countedMikvaot + dayMikvaotVal;
    ws.countedRambam = countedRambam + dayRambamVal;

    // Same-day re-archive: the counters below are increments on top of what
    // this day already holds, while bonus/metivta are whole-day values.
    const prevDay = ws.days[entryDayKey] || null;
    const hasMetivtaNow = metivtaRecordHasFlags(s);
    const dayMetivtaVal = (prevDay && !hasMetivtaNow)
      ? (prevDay.metivtaVal || 0)
      : metivtaDayScore(s.metivtaFlags || defaultMetivtaFlags);
    const mergedBonus = prevDay ? Math.min(prevDay.bonus || 0, dayBonus) : dayBonus;

    ws.days[entryDayKey] = {
      morning: (prevDay ? prevDay.morning || 0 : 0) + dayMorning,
      tefila: (prevDay ? prevDay.tefila || 0 : 0) + dayTefila,
      mikvaotVal: (prevDay ? prevDay.mikvaotVal || 0 : 0) + dayMikvaotVal,
      bonus: mergedBonus,
      rambamVal: (prevDay ? prevDay.rambamVal || 0 : 0) + dayRambamVal,
      metivtaVal: dayMetivtaVal
    };

    ws.morning += dayMorning;
    ws.tefila += dayTefila;
    ws.mikve += (s.cats.c6 || 0) * 2;
    ws.minusDelta += s.minusTotal || 0;
    ws.bonus = (ws.bonus || 0) - (prevDay ? prevDay.bonus || 0 : 0) + mergedBonus;
    ws.mikvaotVal = currentMikvaot - ws.baselineMikvaot;
    ws.rambamVal = currentRambam - ws.baselineRambam;
    ws.metivtaVal = (ws.metivtaVal || 0) - (prevDay ? prevDay.metivtaVal || 0 : 0) + dayMetivtaVal;
  });

  // מתיבתא ז1: the day's Metivta score of every student now in class ז1
  // (either group, unless moved to the Metivta page's archive table), kept
  // in the same week document under z1Students, keyed 'main-<id>'/'extra-<id>'.
  if (!Array.isArray(weeklyEntryOut.z1Students)) weeklyEntryOut.z1Students = [];
  const z1Archived = new Set(mainData.metivtaArchivedKeys || []);
  [['main', mainData.students || [], mainData.metivtaClass || {}, 2], ['extra', mainData.metivtaExtra || [], mainData.metivtaExtraClass || {}, 1]].forEach(([group, list, classMap, defaultClass]) => {
    list.forEach(s => {
      const raw = classMap[s.id];
      const cls = String((raw === undefined || raw === null || raw === '') ? defaultClass : raw).replace(/^ז\s*/, '');
      const key = group + '-' + s.id;
      if (cls !== '1' || z1Archived.has(key)) return;
      let zr = weeklyEntryOut.z1Students.find(x => x.key === key);
      if (!zr){ zr = { key, days: {} }; weeklyEntryOut.z1Students.push(zr); }
      if (!zr.days) zr.days = {};
      const prevZ1 = zr.days[entryDayKey];
      zr.days[entryDayKey] = {
        metivtaVal: (prevZ1 && !metivtaRecordHasFlags(s)) ? (prevZ1.metivtaVal || 0) : metivtaDayScore(s.metivtaFlags || defaultMetivtaFlags)
      };
    });
  });

  const newMainData = JSON.parse(JSON.stringify(mainData));
  newMainData.students.forEach(s => {
    const daily = CATEGORIES.reduce((sum, c) => sum + (s.cats[c.key] || 0), 0);
    s.cumulative += daily + (s.minusTotal || 0);
    CATEGORIES.forEach(c => { s.cats[c.key] = 0; });
    s.c5Total = 0;
    s.purchases = 0;
    s.minusTotal = 0;
    s.frequent = { mikvaot: 0, rambam: 0 };
    s.metivta = { attendance: 0, behavior: 0 };
    s.metivtaFlags = { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 };
  });
  (newMainData.metivtaExtra || []).forEach(s => {
    s.metivta = { attendance: 0, behavior: 0 };
    s.metivtaFlags = { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 };
  });
  newMainData.lastArchivedDay = mainData.lastActivityDate || null;
  newMainData.lastActivityDate = null;
  newMainData.editTimes = Object.fromEntries(Object.entries(mainData.editTimes || {}).filter(([k]) => !k.startsWith('d:')));

  return { newMainData, newDailyDays: days, newWeeklyEntry: weeklyEntryOut, weekKey };
}

async function doResetGuarded(){
  if (!state.lastActivityDate) return;
  let outcome = null;
  try{
    await runTransaction(firestoreDb, async (tx) => {
      const mainSnap = await tx.get(stateDocRef);
      if (!mainSnap.exists()) return;
      if (!Array.isArray(mainSnap.data().students) || mainSnap.data().students.length !== TOTAL_STUDENTS) return;
      const mainData = normalizeMain(mainSnap.data());
      // Re-decide from the fresh server copy, never from this device's
      // in-memory state: a device that slept since yesterday still holds
      // yesterday's lastActivityDate, and its overdue 01:00 timer used to
      // archive (and zero) today's live board mid-day on that stale basis.
      if (!isLiveDayDueForArchive(mainData)){
        outcome = { mainData, dailyDays: null };
        return;
      }
      const entryDate = new Date(mainData.lastActivityDate + 'T12:00:00');
      const weekKey = getWeekKey(entryDate);
      const weekRef = weekDocRef(weekKey);
      const dailySnap = await tx.get(dailyArchiveDocRef);
      const weekSnap = await tx.get(weekRef);
      const dailyDays = dailySnap.exists() && Array.isArray(dailySnap.data().days) ? dailySnap.data().days : [];
      const weeklyEntry = weekSnap.exists() ? weekSnap.data() : null;

      const computed = computeDailyResetUpdate(mainData, dailyDays, weeklyEntry);
      tx.set(stateDocRef, computed.newMainData);
      tx.set(dailyArchiveDocRef, { days: computed.newDailyDays });
      tx.set(weekRef, computed.newWeeklyEntry);
      outcome = { mainData: computed.newMainData, dailyDays: computed.newDailyDays };
    });
  } catch(e){
    // transaction failed (offline, etc.) - render whatever is in memory so the UI isn't stuck
  }
  if (outcome){
    serverSnap.main = outcome.mainData;
    lastServerMainJson = JSON.stringify(outcome.mainData);
    serverSnap.dailyDays = outcome.dailyDays !== null ? outcome.dailyDays : await fetchArchiveDays();
    serverSnap.weeks = await fetchArchiveWeeksMap(true);
  }
  rebuildViewAndRender();
}

const AUTO_RESET_HOUR = 1;

function isLiveDayDueForArchive(data){
  return !!data.lastActivityDate && data.lastActivityDate < activityDayStr();
}

function checkAutoReset(){
  if (!state) return;
  if (isLiveDayDueForArchive(state)) doResetGuarded();
}

function scheduleNextAutoResetCheck(){
  const now = new Date();
  const next = new Date(now);
  next.setHours(1, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    checkAutoReset();
    scheduleNextAutoResetCheck();
  }, next.getTime() - now.getTime());
}

function isColHidden(cat){
  return false;
}

let expandedGroup = null;
let expandedGroupTimer = null;

function activateExpandedGroup(groupName){
  expandedGroup = groupName;
  render();
  armExpandedGroupTimer();
}

function armExpandedGroupTimer(){
  clearTimeout(expandedGroupTimer);
  expandedGroupTimer = setTimeout(() => {
    expandedGroup = null;
    render();
  }, 10000);
}

function buildColSpec(){
  const spec = [];
  spec.push({ kind: 'name', category: 'none', weight: 30 });

  if (expandedGroup === 'prayer'){
    MERGE_GROUPS[1].forEach(key => spec.push({ kind: 'individual', category: 'prayer', weight: 11, key }));
    return spec;
  }
  if (expandedGroup === 'attendance'){
    MERGE_GROUPS[0].forEach(key => spec.push({ kind: 'individual', category: 'attendance', weight: 11, key }));
    return spec;
  }
  if (expandedGroup === 'minusShop'){
    spec.push({ kind: 'minusOnly', category: 'score', weight: 11 });
    spec.push({ kind: 'shopOnly', category: 'shop', weight: 11 });
    return spec;
  }

  spec.push({ kind: 'total', category: 'none', weight: 16 });
  spec.push({ kind: 'merged', category: 'prayer', weight: 11, group: MERGE_GROUPS[1], groupIndex: 1 });
  spec.push({ kind: 'merged', category: 'attendance', weight: 11, group: MERGE_GROUPS[0], groupIndex: 0 });
  spec.push({ kind: 'minus', category: 'score', weight: 11 });
  return spec;
}

function buildBoard(title, students){
  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';

  const table = document.createElement('table');
  const colSpec = buildColSpec();

  const PX_BY_KIND = { name: 115, total: 45, plus: 40, minus: 40, merged: 45, individual: 45, shop: 40 };
  const colgroup = document.createElement('colgroup');
  let totalPx = 0;
  colSpec.forEach(s => {
    const col = document.createElement('col');
    if (isColHidden(s.category)){
      col.style.width = '0px';
    } else {
      const px = PX_BY_KIND[s.kind] || 70;
      col.style.width = px + 'px';
      totalPx += px;
    }
    if (s.kind === 'total') col.className = 'col-hide-narrow';
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);
  table.style.width = 'max(100%, ' + totalPx + 'px)';

  const PLUS_KEY = 'c5';
  const plusCategory = CATEGORIES.find(c => c.key === PLUS_KEY);

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');


  colSpec.forEach(s => {
    const th = document.createElement('th');
    if (isColHidden(s.category)) th.style.display = 'none';

    if (s.kind === 'name'){
      const nameLabel = document.createElement('span');
      nameLabel.className = 'th-name-text';
      nameLabel.textContent = 'שם';
      th.appendChild(nameLabel);
    } else if (s.kind === 'total'){
      th.className = (th.className ? th.className + ' ' : '') + 'col-hide-narrow';
      const totalBtn = document.createElement('button');
      totalBtn.className = 'col-reset-btn';
      totalBtn.textContent = '=';
      totalBtn.addEventListener('click', runRaffle);
      th.appendChild(totalBtn);
    } else if (s.kind === 'plus'){
      const plusBtn = document.createElement('button');
      plusBtn.className = 'col-reset-btn';
      plusBtn.textContent = plusCategory.label;
      plusBtn.addEventListener('click', () => resetColumn(plusCategory.key));
      th.appendChild(plusBtn);
    } else if (s.kind === 'minus'){
      const list = document.createElement('div');
      list.className = 'merged-dropdown-list';
      [['minus', '-'], ['shop', '🛒']].forEach(([value, label]) => {
        const opt = document.createElement('div');
        opt.className = 'merged-dropdown-option';
        opt.textContent = label;
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          list.classList.remove('open');
          setMinusShopActive(value);
        });
        list.appendChild(opt);
      });
      const allOpt = document.createElement('div');
      allOpt.className = 'merged-dropdown-option merged-dropdown-option-all';
      allOpt.textContent = 'הכל';
      allOpt.addEventListener('click', (e) => {
        e.stopPropagation();
        list.classList.remove('open');
        activateExpandedGroup('minusShop');
      });
      list.appendChild(allOpt);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'merged-dropdown-toggle';
      toggle.textContent = (state.minusShopActive === 'shop' ? '🛒' : '-');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.merged-dropdown-list.open').forEach(l => {
          if (l !== list) l.classList.remove('open');
        });
        list.classList.toggle('open');
      });

      const dropdown = document.createElement('div');
      dropdown.className = 'merged-dropdown';
      dropdown.appendChild(toggle);
      dropdown.appendChild(list);
      th.appendChild(dropdown);
    } else if (s.kind === 'merged'){
      th.className = (th.className ? th.className + ' ' : '') + 'col-hide-narrow';

      const list = document.createElement('div');
      list.className = 'merged-dropdown-list';
      s.group.forEach(key => {
        const opt = document.createElement('div');
        opt.className = 'merged-dropdown-option';
        opt.textContent = categoryLabel(key);
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          list.classList.remove('open');
          if (key === 'c5' && state.mergedActive[s.groupIndex] === 'c5'){
            resetColumn('c5');
          } else {
            setMergedActive(s.groupIndex, key);
          }
        });
        list.appendChild(opt);
      });
      const allOpt = document.createElement('div');
      allOpt.className = 'merged-dropdown-option merged-dropdown-option-all';
      allOpt.textContent = 'הכל';
      allOpt.addEventListener('click', (e) => {
        e.stopPropagation();
        list.classList.remove('open');
        activateExpandedGroup(s.category);
      });
      list.appendChild(allOpt);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'merged-dropdown-toggle';
      toggle.textContent = categoryLabel(state.mergedActive[s.groupIndex]);
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.merged-dropdown-list.open').forEach(l => {
          if (l !== list) l.classList.remove('open');
        });
        list.classList.toggle('open');
      });

      const dropdown = document.createElement('div');
      dropdown.className = 'merged-dropdown';
      dropdown.appendChild(toggle);
      dropdown.appendChild(list);
      th.appendChild(dropdown);
    } else if (s.kind === 'individual'){
      th.textContent = categoryLabel(s.key);
    } else if (s.kind === 'minusOnly'){
      th.textContent = '-';
    } else if (s.kind === 'shopOnly'){
      th.textContent = '🛒';
    }

    const thInner = document.createElement('div');
    thInner.className = 'th-inner';
    while (th.firstChild) thInner.appendChild(th.firstChild);
    th.appendChild(thInner);

    trh.appendChild(th);
  });

  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  students.forEach(student => {
    const tr = document.createElement('tr');
    tr.dataset.studentId = student.id;

    colSpec.forEach(s => {
      const td = document.createElement('td');
      if (isColHidden(s.category)) td.style.display = 'none';

      if (s.kind === 'name'){
        td.className = (td.className ? td.className + ' ' : '') + 'num-cell name-cell';
        const numSpan = document.createElement('span');
        numSpan.className = 'cell-text';
        numSpan.textContent = studentName(student.id);
        td.appendChild(numSpan);
      } else if (s.kind === 'total'){
        td.className = (td.className ? td.className + ' ' : '') + 'total-cell col-hide-narrow';
        const totalSpan = document.createElement('span');
        totalSpan.className = 'cell-text';
        totalSpan.textContent = studentTotal(student);
        td.appendChild(totalSpan);
      } else if (s.kind === 'plus'){
        const c = plusCategory;
        const roundActive = !!student.cats[c.key];
        const displayVal = c.cumulativeKey
          ? (student[c.cumulativeKey] || 0) + (student.cats[c.key] || 0)
          : student.cats[c.key];
        td.className = (td.className ? td.className + ' ' : '') + 'point-cell' + (roundActive ? ' active' : '');
        const val = document.createElement('span');
        val.className = 'point-val';
        val.textContent = displayVal ? displayVal : '';
        td.appendChild(val);
        td.addEventListener('click', () => toggleCell(student.id, c.key));
      } else if (s.kind === 'minus'){
        if (state.minusShopActive === 'shop'){
          const purchaseCost = (student.purchases || 0) * PURCHASE_COST;
          const hasValue = purchaseCost !== 0;
          td.className = (td.className ? td.className + ' ' : '') + 'point-cell purchase-cell' + (hasValue ? ' has-purchases' : '');
          const val = document.createElement('span');
          val.className = 'point-val';
          val.textContent = hasValue ? -purchaseCost : '';
          td.appendChild(val);
          td.addEventListener('click', () => makePurchase(student.id));
        } else {
          const minusShown = (student.minusTotal || 0) + (student.cats.c9 || 0);
          const hasMinus = minusShown !== 0;
          td.className = (td.className ? td.className + ' ' : '') + 'point-cell minus-cell' + (hasMinus ? ' has-minus' : '');
          const minusVal = document.createElement('span');
          minusVal.className = 'point-val';
          minusVal.textContent = hasMinus ? minusShown : '';
          td.appendChild(minusVal);
          appendMinusCellEvents(td, student);
        }
      } else if (s.kind === 'merged'){
        const activeKey = state.mergedActive[s.groupIndex];
        if (isFrequentToggleKey(activeKey)){
          const active = !!(student.frequent && student.frequent[activeKey]);
          td.className = (td.className ? td.className + ' ' : '') + 'point-cell col-hide-narrow' + (active ? ' active' : '');
          const val = document.createElement('span');
          val.className = 'point-val';
          val.textContent = active ? '✓' : '';
          td.appendChild(val);
          td.addEventListener('click', () => toggleFrequent(student.id, activeKey));
        } else {
          let sum = s.group.reduce((sum2, k) => sum2 + (student.cats[k] || 0), 0);
          if (s.group.includes('c5')) sum += (student.c5Total || 0);
          const activeHasPoints = (student.cats[activeKey] || 0) > 0;
          const activeDisturbed = (student.cats[activeKey] || 0) < 0 || (activeKey === 'c3' && (student.cats.c9 || 0) < 0);
          td.className = (td.className ? td.className + ' ' : '') + 'point-cell col-hide-narrow' + (activeHasPoints ? ' active' : '') + (activeDisturbed ? ' disturb' : '');
          const val = document.createElement('span');
          val.className = 'point-val';
          val.textContent = sum !== 0 ? sum : '';
          td.appendChild(val);
          td.addEventListener('click', () => toggleCell(student.id, activeKey));
          if (activeKey === 'c3'){ td.style.position = 'relative'; td.appendChild(prayerMinusButton(student.cats.c9 || 0, v => setPrayerMinus(student.id, v))); }
        }
      } else if (s.kind === 'individual'){
        if (isFrequentToggleKey(s.key)){
          const active = !!(student.frequent && student.frequent[s.key]);
          td.className = (td.className ? td.className + ' ' : '') + 'point-cell' + (active ? ' active' : '');
          const val = document.createElement('span');
          val.className = 'point-val';
          val.textContent = active ? '✓' : '';
          td.appendChild(val);
          td.addEventListener('click', () => toggleFrequent(student.id, s.key));
        } else {
          const roundActive = (student.cats[s.key] || 0) > 0;
          td.className = (td.className ? td.className + ' ' : '') + 'point-cell' + (roundActive ? ' active' : '') + (((student.cats[s.key] || 0) < 0 || (s.key === 'c3' && (student.cats.c9 || 0) < 0)) ? ' disturb' : '');
          const val = document.createElement('span');
          val.className = 'point-val';
          val.textContent = student.cats[s.key] ? student.cats[s.key] : '';
          td.appendChild(val);
          td.addEventListener('click', () => toggleCell(student.id, s.key));
          if (s.key === 'c3'){ td.style.position = 'relative'; td.appendChild(prayerMinusButton(student.cats.c9 || 0, v => setPrayerMinus(student.id, v))); }
        }
      } else if (s.kind === 'minusOnly'){
        const minusShown = (student.minusTotal || 0) + (student.cats.c9 || 0);
        const hasMinus = minusShown !== 0;
        td.className = (td.className ? td.className + ' ' : '') + 'point-cell minus-cell' + (hasMinus ? ' has-minus' : '');
        const minusVal = document.createElement('span');
        minusVal.className = 'point-val';
        minusVal.textContent = hasMinus ? minusShown : '';
        td.appendChild(minusVal);
        appendMinusCellEvents(td, student);
      } else if (s.kind === 'shopOnly'){
        const purchaseCost = (student.purchases || 0) * PURCHASE_COST;
        const hasValue = purchaseCost !== 0;
        td.className = (td.className ? td.className + ' ' : '') + 'point-cell purchase-cell' + (hasValue ? ' has-purchases' : '');
        const val = document.createElement('span');
        val.className = 'point-val';
        val.textContent = hasValue ? -purchaseCost : '';
        td.appendChild(val);
        td.addEventListener('click', () => makePurchase(student.id));
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  wrap.appendChild(scrollWrap);
  return wrap;
}

function showMain(){
  document.getElementById('metivtaView').style.display = 'none';
  document.getElementById('boards').style.display = 'flex';
  document.getElementById('todaySummary').style.display = 'block';
  document.getElementById('frequentArchiveView').style.display = 'block';
  renderFrequentFlyerView();
  fitAllTextCells();
}

function showMetivta(){
  document.getElementById('boards').style.display = 'none';
  document.getElementById('todaySummary').style.display = 'none';
  document.getElementById('frequentArchiveView').style.display = 'none';
  const el = document.getElementById('metivtaView');
  el.style.display = 'block';
  renderMetivtaView();
}

function toggleFrequent(studentId, key){
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  commitOp({ kind: 'freq', group: 'main', sid: studentId, key, on: !(student.frequent && student.frequent[key]) });
}

let selectedWeeklyKey = null;

// Weeks archived before the parent form started stamping weekParsha have
// none stored - their name is looked up once from hebcal (same source as the
// parent form) and cached in this browser. A week with no weekly parsha
// (e.g. a holiday Shabbat) falls back to its starting date.
const PARSHA_CACHE_KEY = 'parshaNamesV1';
let parshaNameCache = (() => {
  try{ return JSON.parse(localStorage.getItem(PARSHA_CACHE_KEY)) || {}; } catch(e){ return {}; }
})();
let parshaLookupStarted = false;

function weeklyEntryLabel(entry){
  const name = entry.weekParsha || parshaNameCache[entry.weekKey];
  if (name) return name.replace(/^פרשת\s+/, '');
  return 'שבוע ' + formatHebrewDateShort(new Date(entry.weekStart));
}

async function lookupMissingParshaNames(weeklyEntries){
  const missing = weeklyEntries.filter(e => !e.weekParsha && !parshaNameCache[e.weekKey]);
  if (missing.length === 0 || parshaLookupStarted) return;
  parshaLookupStarted = true;
  const starts = missing.map(e => new Date(e.weekStart)).sort((a, b) => a - b);
  const end = new Date(starts[starts.length - 1]);
  end.setDate(end.getDate() + 6);
  try{
    const url = 'https://www.hebcal.com/hebcal?cfg=json&v=1&maj=off&min=off&mod=off&nx=off&mf=off&ss=off&s=on&i=on&geo=none'
      + '&start=' + dayKeyOf(starts[0].toISOString()) + '&end=' + dayKeyOf(end.toISOString());
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    let found = false;
    missing.forEach(e => {
      const sat = new Date(e.weekStart);
      sat.setDate(sat.getDate() + 6);
      const satKey = dayKeyOf(sat.toISOString());
      const match = items.find(it => it.category === 'parashat' && String(it.date || '').slice(0, 10) === satKey);
      if (match){ parshaNameCache[e.weekKey] = match.hebrew || match.title; found = true; }
    });
    if (!found) return;
    try{ localStorage.setItem(PARSHA_CACHE_KEY, JSON.stringify(parshaNameCache)); } catch(e){}
    if (document.getElementById('frequentArchiveView').style.display !== 'none') renderFrequentFlyerView();
    if (document.getElementById('z1View').style.display !== 'none') renderZ1View();
  } catch(e){
    // best-effort only - the date fallback label stays
  }
}

// The daily columns a school day is expected to fill. There is no Metivta on
// Friday, so that column isn't expected (or shown) for a Friday.
const WEEKLY_EXPECTED_DAY_FIELDS = ['morning', 'tefila', 'mikvaotVal', 'rambamVal', 'metivtaVal'];
const FRIDAY_INDEX = 5;

// School days are Sunday-Friday. A past day counts as missing when any of its
// expected columns is empty for every student (no data for the day at all
// included); days from today on (still live or in the future) are never listed.
// The missing days as { name, key, columns, everything }: the columns that are
// empty on that day, and whether all of them are.
function weekMissingDays(entry){
  const weekStartD = new Date(entry.weekStart);
  const today = todayStr();
  const students = entry.students || [];
  const missing = [];
  for (let i = 0; i < 6; i++){
    const d = new Date(weekStartD);
    d.setDate(d.getDate() + i);
    const k = dayKeyOf(d.toISOString());
    if (k >= today) break;
    const fields = WEEKLY_EXPECTED_DAY_FIELDS.filter(f => !(i === FRIDAY_INDEX && f === 'metivtaVal'));
    const filled = (f) => students.some(s => ((s.days || {})[k] || {})[f] > 0);
    const empty = fields.filter(f => !filled(f));
    // columns: the columns that are empty that day; everything: all of them are.
    if (empty.length) missing.push({ name: HEBREW_WEEKDAY_NAMES[i], key: k, columns: empty.map(editLogFieldLabel), everything: empty.length === fields.length });
  }
  return missing;
}


function renderFrequentFlyerView(){
  keepScroll(() => renderFrequentFlyerViewNow());
}

function renderFrequentFlyerViewNow(){
  const el = document.getElementById('frequentArchiveView');
  el.innerHTML = '';

  const weeklyEntries = getDisplayArchive().filter(e => e.type === 'weekly');
  if (weeklyEntries.length === 0) return;

  if (!selectedWeeklyKey || !weeklyEntries.find(e => e.weekKey === selectedWeeklyKey)){
    selectedWeeklyKey = weeklyEntries[0].weekKey;
  }
  const selectedEntry = weeklyEntries.find(e => e.weekKey === selectedWeeklyKey) || weeklyEntries[0];

  renderWeeklyEntryInto(selectedEntry, el, weeklyEntries);
  lookupMissingParshaNames(weeklyEntries);
}

function findMetivtaStatusStudent(studentId, isExtra){
  const list = isExtra ? (state.metivtaExtra || []) : state.students;
  return list.find(s => s.id === studentId);
}

function ensureMetivtaFlags(student){
  if (!student.metivtaFlags) student.metivtaFlags = { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 };
  return student.metivtaFlags;
}

function nowHHMM(){
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// When a lateness is marked: the hour (now, unless another one is chosen) takes
// the place of the word "איחור". `save(closeWindow)` stores the flags.
function appendLateTimeRow(box, flags, save){
  const row = document.createElement('div');
  row.className = 'modal-btns';
  row.style.marginTop = '10px';
  const label = document.createElement('span');
  label.textContent = 'שעת הגעה:';
  const input = document.createElement('input');
  input.type = 'time';
  input.value = flags.lateTime || nowHHMM();
  input.addEventListener('change', () => { flags.lateTime = input.value; save(); });
  row.appendChild(label);
  row.appendChild(input);
  row.style.display = flags.late ? '' : 'none';
  box.appendChild(row);
  return row;
}

function metivtaStatusParts(f){
  if (f.late || f.leftEarly || f.noBook || f.disturbCount > 0){
    const parts = [];
    if (f.late) parts.push(f.lateTime || 'איחור'); // the hour of arrival replaces the word
    if (f.leftEarly) parts.push('מוקדם');
    if (f.noBook) parts.push('בלי ספר');
    if (f.disturbCount > 0) parts.push('הפרעה' + (f.disturbCount > 1 ? ' ×' + f.disturbCount : ''));
    return parts;
  }
  return f.ok ? ['✓'] : [];
}

// A task given for the day ("מטלה"): the details are in f.task, and f.taskDone
// says it was done. Only the word shows in the day's row.
function metivtaStatusLabel(f){
  return metivtaStatusParts(f).concat(f.task ? ['מטלה'] : []).join(' · ');
}

// Details window of a task: the text and a mark for "done".
function showMetivtaTaskModal(studentId, isExtra){
  const student = findMetivtaStatusStudent(studentId, isExtra);
  if (!student) return;
  const f = { ...ensureMetivtaFlags(student) };
  if (!f.task) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box';
  const title = document.createElement('div');
  title.className = 'modal-msg';
  title.textContent = 'מטלה';
  box.appendChild(title);
  const details = document.createElement('div');
  details.className = 'modal-msg';
  details.style.whiteSpace = 'pre-wrap';
  details.textContent = f.task;
  box.appendChild(details);
  const row = document.createElement('div');
  row.className = 'modal-btns';
  const doneBtn = document.createElement('button');
  doneBtn.className = 'modal-btn ' + (f.taskDone ? 'modal-btn-confirm' : 'modal-btn-cancel');
  doneBtn.textContent = f.taskDone ? 'בוצע ✓' : 'סמן שבוצע';
  doneBtn.addEventListener('click', () => {
    f.taskDone = !f.taskDone;
    commitMetivtaFlags(studentId, isExtra, f);
    overlay.remove();
  });
  row.appendChild(doneBtn);
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// The task part of the day's window: its details and an add / update / remove.
function appendTaskSection(box, flags, save){
  const label = document.createElement('div');
  label.className = 'modal-msg';
  label.style.marginTop = '10px';
  label.textContent = 'מטלה:';
  box.appendChild(label);
  const input = document.createElement('textarea');
  input.rows = 2;
  input.style.width = '100%';
  input.value = flags.task || '';
  input.placeholder = 'פרטי המטלה';
  box.appendChild(input);
  const row = document.createElement('div');
  row.className = 'modal-btns';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn modal-btn-confirm';
  saveBtn.textContent = flags.task ? 'עדכון המטלה' : 'הוספת מטלה';
  saveBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    if (text !== flags.task) flags.taskDone = false;
    flags.task = text;
    save();
  });
  row.appendChild(saveBtn);
  if (flags.task){
    const delBtn = document.createElement('button');
    delBtn.className = 'modal-btn modal-btn-cancel';
    delBtn.textContent = 'מחיקת המטלה';
    delBtn.addEventListener('click', () => { flags.task = ''; flags.taskDone = false; save(); });
    row.appendChild(delBtn);
  }
  box.appendChild(row);
}

function metivtaDayScore(f){
  // A day with no record at all must always sort below an attended day, no
  // matter how many exceptions that attended day racked up - otherwise a
  // heavily-penalized but present student (e.g. disturbed twice, clamped to
  // 0) becomes indistinguishable from a student with no record for that day
  // at all, and the two get shuffled together when sorting by that column.
  const attended = f.ok || f.late || f.leftEarly || f.noBook || f.disturbCount > 0;
  if (!attended) return -1;
  let score = 4 - (f.late ? 2 : 0) - (f.leftEarly ? 2 : 0) - (f.noBook ? 2 : 0) - 2 * (f.disturbCount || 0);
  if (score < 0) score = 0;
  return score;
}

// An archived day's per-student Metivta record: whether anything was marked,
// what to show, and its score (-1 = no record for that day).
function metivtaRecordHasFlags(s){
  const f = s && s.metivtaFlags;
  return !!(f && (f.ok || f.late || f.leftEarly || f.noBook || (f.disturbCount || 0) > 0));
}

function metivtaRecordLabel(s){
  if (metivtaRecordHasFlags(s)) return metivtaStatusLabel(s.metivtaFlags);
  return (s && s.metivtaFlags && s.metivtaFlags.task) ? 'מטלה' : '';
}

function metivtaRecordScore(s){
  return metivtaRecordHasFlags(s) ? metivtaDayScore(s.metivtaFlags) : -1;
}

function toggleMetivtaOk(studentId, isExtra){
  const student = findMetivtaStatusStudent(studentId, isExtra);
  if (!student) return;
  const f = { ...ensureMetivtaFlags(student) };
  if (f.late || f.leftEarly || f.noBook || f.disturbCount > 0){
    f.late = false;
    f.lateTime = '';
    f.leftEarly = false;
    f.noBook = false;
    f.disturbCount = 0;
    f.ok = true;
  } else {
    f.ok = !f.ok;
  }
  commitMetivtaFlags(studentId, isExtra, f);
}

function commitMetivtaFlags(studentId, isExtra, flags){
  commitOp({ kind: 'mflags', group: isExtra ? 'extra' : 'main', sid: studentId, flags: { ...flags } });
}

function showMetivtaStatusExceptionsModal(studentId, isExtra){
  const student = findMetivtaStatusStudent(studentId, isExtra);
  if (!student) return;
  // The modal's own copy of the flags; every change is committed whole.
  const f = { ...ensureMetivtaFlags(student) };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box';

  const msg = document.createElement('div');
  msg.className = 'modal-msg';
  msg.textContent = 'סמן חריגות:';
  box.appendChild(msg);

  // Every choice is saved and closes the window.
  let timeRow = null;
  function applyChange(keepOpen){
    f.ok = false;
    commitMetivtaFlags(studentId, isExtra, f);
    if (keepOpen !== true) overlay.remove();
  }

  const toggleRow = document.createElement('div');
  toggleRow.className = 'modal-btns';

  function buildToggleBtn(label, flagKey){
    const btn = document.createElement('button');
    function refreshBtn(){
      btn.className = 'modal-btn' + (f[flagKey] ? ' modal-btn-confirm' : ' modal-btn-cancel');
      btn.textContent = label + (f[flagKey] ? ' ✓' : '');
    }
    refreshBtn();
    btn.addEventListener('click', () => {
      f[flagKey] = !f[flagKey];
      refreshBtn();
      if (flagKey === 'late'){
        f.lateTime = f.late ? nowHHMM() : '';
        if (f.late){
          timeRow.style.display = '';
          timeRow.querySelector('input').value = f.lateTime;
          applyChange(true);
          return;
        }
      }
      applyChange();
    });
    return btn;
  }

  toggleRow.appendChild(buildToggleBtn('איחור', 'late'));
  toggleRow.appendChild(buildToggleBtn('יצא מוקדם', 'leftEarly'));
  toggleRow.appendChild(buildToggleBtn('בלי ספר', 'noBook'));
  box.appendChild(toggleRow);
  timeRow = appendLateTimeRow(box, f, applyChange);

  const disturbLabel = document.createElement('div');
  disturbLabel.className = 'modal-msg';
  disturbLabel.style.marginTop = '10px';
  disturbLabel.textContent = 'הפרעות: ' + f.disturbCount;
  box.appendChild(disturbLabel);

  const disturbRow = document.createElement('div');
  disturbRow.className = 'modal-btns';

  const minusBtn = document.createElement('button');
  minusBtn.className = 'modal-btn modal-btn-cancel';
  minusBtn.textContent = '−';
  minusBtn.addEventListener('click', () => {
    if (f.disturbCount > 0) f.disturbCount--;
    disturbLabel.textContent = 'הפרעות: ' + f.disturbCount;
    applyChange();
  });
  disturbRow.appendChild(minusBtn);

  const plusBtn = document.createElement('button');
  plusBtn.className = 'modal-btn modal-btn-confirm';
  plusBtn.textContent = '+';
  plusBtn.addEventListener('click', () => {
    f.disturbCount++;
    disturbLabel.textContent = 'הפרעות: ' + f.disturbCount;
    applyChange();
  });
  disturbRow.appendChild(plusBtn);
  box.appendChild(disturbRow);
  appendTaskSection(box, f, () => applyChange());

  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function buildMetivtaEditableCell(value, promptLabel, onSave){
  const td = document.createElement('td');
  td.textContent = value;
  td.style.cursor = 'pointer';
  td.addEventListener('click', () => {
    requireArchiveEditAccess(() => {
      const next = prompt(promptLabel + ':', value);
      if (next === null) return;
      onSave(next.trim());
    });
  });
  return td;
}

// Stored class values are plain numbers (main group 2, extra group 1);
// they display as ז2 / ז1. A custom value typed in by hand shows as is.
function metivtaClassLabel(id, isExtra){
  const v = String(metivtaClassValue(id, isExtra));
  return /^\d+$/.test(v) ? 'ז' + v : v;
}

// Students moved to the Metivta page's "ארכיון" table, by row key
// ('main-<id>' / 'extra-<id>'), saved with the live document.
function metivtaRowKey(id, isExtra){
  return (isExtra ? 'extra-' : 'main-') + id;
}

function metivtaArchivedKeySet(){
  return new Set(Array.isArray(state.metivtaArchivedKeys) ? state.metivtaArchivedKeys : []);
}

// The ארכיון table starts folded; its title arrow opens/closes it.
let metivtaArchiveOpen = false;

// Rows picked by clicking their row number - only on this screen, not saved.
const metivtaSelectedKeys = new Set();

function renderMetivtaView(){
  keepScroll(() => renderMetivtaViewNow());
}

function renderMetivtaViewNow(){
  const el = document.getElementById('metivtaView');
  el.innerHTML = '';
  if (!Array.isArray(state.metivtaExtra)) state.metivtaExtra = [];

  const pastDays = getDisplayArchive().filter(e => e.type !== 'weekly' && !e.isLive && (metivtaEntryHasData(e) || e.metivtaAddedDay));
  const allDays = [buildMetivtaTodayEntry(), ...pastDays];
  const days = metivtaVisibleDayCount === null ? allDays : allDays.slice(0, metivtaVisibleDayCount);
  const archivedKeys = metivtaArchivedKeySet();
  const elStyle = getComputedStyle(el);
  const availableWidth = (el.clientWidth - (parseFloat(elStyle.paddingLeft) || 0) - (parseFloat(elStyle.paddingRight) || 0)) || (window.innerWidth - 40);

  el.appendChild(buildMetivtaTable({ days, archivedKeys, archiveTable: false, availableWidth }));
  if (archivedKeys.size > 0){
    el.appendChild(buildMetivtaTable({ days, archivedKeys, archiveTable: true, availableWidth }));
  }
  el.appendChild(buildMetivtaTestsSection(archivedKeys));
  el.querySelectorAll('table.metivta-table th, table.metivta-table td').forEach(shrinkCellTextToFit);
}

// ---- The tests table (opens with the admin code) ----
function scoreFromText(text){
  const t = String(text).trim();
  if (t === '') return '';
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

// Title and delete button of one test, in a small window.
function showTestDetailsModal(col, onSave, onDelete){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box';
  const msg = document.createElement('div');
  msg.className = 'modal-msg';
  msg.textContent = 'פרטי המבחן (שם, תאריך, חומר...):';
  box.appendChild(msg);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = col.title || '';
  input.style.cssText = "width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:10px;margin:8px 0 12px;border:1.5px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);";
  box.appendChild(input);
  const row = document.createElement('div');
  row.className = 'modal-btns';
  const close = () => overlay.remove();
  const save = document.createElement('button');
  save.className = 'modal-btn modal-btn-confirm';
  save.textContent = 'שמירה';
  save.addEventListener('click', () => { close(); onSave(input.value.trim()); });
  const del = document.createElement('button');
  del.className = 'modal-btn modal-btn-cancel';
  del.style.color = 'var(--danger)';
  del.textContent = 'מחיקת המבחן';
  del.addEventListener('click', () => {
    close();
    showModal('למחוק את המבחן "' + (col.title || 'ללא שם') + '" ואת כל הציונים שלו?', { confirmText: 'מחיקה', onConfirm: onDelete });
  });
  const cancel = document.createElement('button');
  cancel.className = 'modal-btn modal-btn-cancel';
  cancel.textContent = 'ביטול';
  cancel.addEventListener('click', close);
  [save, del, cancel].forEach(b => row.appendChild(b));
  box.appendChild(row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();
}

// Sorting of the tests table by a column (click its header; again = the other
// direction). The order is made once and kept while scores are entered, so a row
// does not jump to another place under the cursor.
let testsSort = { key: null, dir: 1, order: null };
function testsSortDefaultDir(key){ return (key === 'family' || key === 'first' || key === 'class') ? 1 : -1; }
function setTestsSort(key){
  if (testsSort.key === key) testsSort = { key, dir: -testsSort.dir, order: null };
  else testsSort = { key, dir: testsSortDefaultDir(key), order: null };
  renderMetivtaView();
}
function testsSortArrow(key){
  if (testsSort.key !== key) return '';
  return testsSort.dir === testsSortDefaultDir(key) ? ' ▼' : ' ▲';
}

function buildMetivtaTestsSection(archivedKeys){
  const wrap = document.createElement('div');
  wrap.className = 'archive-entry';
  const open = testsOpen();
  const dateEl = document.createElement('div');
  dateEl.className = 'archive-date weekly-header-row';
  const headerGroup = document.createElement('div');
  headerGroup.className = 'header-group';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = (open ? '▾ ' : '◂ 🔒 ') + 'מבחנים';
  titleSpan.style.cursor = 'pointer';
  titleSpan.title = open ? 'סגירה' : 'פתיחה בקוד ניהול';
  titleSpan.addEventListener('click', () => {
    if (testsOpen()){ setTestsOpen(false); renderMetivtaView(); return; }
    showArchiveCodePrompt(() => { setTestsOpen(true); renderMetivtaView(); }, 'admin');
  });
  headerGroup.appendChild(titleSpan);
  dateEl.appendChild(headerGroup);
  wrap.appendChild(dateEl);
  if (!open) return wrap;

  const tests = state.metivtaTests && Array.isArray(state.metivtaTests.columns) ? state.metivtaTests : { columns: [{ id: 't-first', title: '' }], scores: {} };
  const rows = [
    ...state.students.map(st => ({ id: st.id, isExtra: false })),
    ...state.metivtaExtra.map(st => ({ id: st.id, isExtra: true }))
  ].map(r => ({
    key: metivtaRowKey(r.id, r.isExtra),
    family: metivtaFamilyName(r.id, r.isExtra),
    first: metivtaFirstName(r.id, r.isExtra),
    clsLabel: metivtaClassLabel(r.id, r.isExtra)
  })).filter(r => !archivedKeys.has(r.key));
  if (testsSort.key){
    const scoreOf = (row) => {
      const v = (tests.scores[testsSort.key] || {})[row.key];
      const n = typeof v === 'number' ? v : (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
      return n;
    };
    const sorted = rows.map((row, index) => ({ row, index })).sort((a, b) => {
      let c;
      if (testsSort.key === 'family') c = a.row.family.localeCompare(b.row.family, 'he');
      else if (testsSort.key === 'first') c = a.row.first.localeCompare(b.row.first, 'he');
      else if (testsSort.key === 'class') c = a.row.clsLabel.localeCompare(b.row.clsLabel, 'he', { numeric: true });
      else {
        // Scores: numbers by value, rows with no score always at the end.
        const x = scoreOf(a.row), y = scoreOf(b.row);
        if (x === null && y === null) c = 0;
        else if (x === null) return 1;
        else if (y === null) return -1;
        else c = x - y;
      }
      return c * testsSort.dir || a.index - b.index;
    }).map(x => x.row);
    if (!testsSort.order) testsSort.order = sorted.map(r => r.key);
    const rank = new Map(testsSort.order.map((k, i) => [k, i]));
    rows.sort((a, b) => (rank.has(a.key) ? rank.get(a.key) : 1e9) - (rank.has(b.key) ? rank.get(b.key) : 1e9));
  }

  const W = {
    family: textColumnWidth(rows.map(r => r.family), 'משפחה', 4),
    first: textColumnWidth(rows.map(r => r.first), 'פרטי', 4),
    cls: 34, test: 84
  };
  const table = document.createElement('table');
  table.className = 'archive-table tests-table';
  table.style.width = 'max(100%, ' + (W.family + W.first + W.cls + W.test * tests.columns.length) + 'px)';

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  [['משפחה', W.family, 'family'], ['פרטי', W.first, 'first'], ['כיתה', W.cls, 'class']].forEach(([label, width, key]) => {
    const th = document.createElement('th');
    th.textContent = label + testsSortArrow(key);
    th.style.width = width + 'px';
    th.style.cursor = 'pointer';
    th.title = 'מיון לפי הטור הזה';
    th.addEventListener('click', () => setTestsSort(key));
    trh.appendChild(th);
  });
  // Each test column: its title (click to change it or delete the test).
  const guarded = (fn) => () => { if (!testsOpen()){ renderMetivtaView(); return; } setTestsOpen(true); fn(); };
  tests.columns.forEach((col, i) => {
    const th = document.createElement('th');
    th.style.width = W.test + 'px';
    th.style.cursor = 'pointer';
    th.style.whiteSpace = 'normal';
    th.title = 'מיון לפי הטור הזה';
    const label = document.createElement('span');
    label.textContent = (col.title || ('מבחן ' + (i + 1))) + testsSortArrow(col.id);
    if (!col.title) th.style.color = 'var(--ink-soft)';
    th.appendChild(label);
    // The pencil changes the details of the test; the header itself sorts.
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '✎';
    edit.title = 'שינוי פרטי המבחן';
    edit.style.cssText = 'margin-inline-start:4px;border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--ink-soft);padding:0 2px;';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      guarded(() => showTestDetailsModal(col,
        (title) => commitOp({ kind: 'testTitle', colId: col.id, value: title }),
        () => commitOp({ kind: 'testDelete', colId: col.id })))();
    });
    th.appendChild(edit);
    th.addEventListener('click', () => setTestsSort(col.id));
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    [r.family, r.first, r.clsLabel].forEach(text => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    tests.columns.forEach(col => {
      const td = document.createElement('td');
      const score = (tests.scores[col.id] || {})[r.key];
      td.textContent = score === undefined ? '' : String(score);
      td.style.cursor = 'pointer';
      td.addEventListener('click', guarded(() => {
        const next = prompt('ציון ' + r.family + ' ' + r.first + ':', score === undefined ? '' : String(score));
        if (next === null) return;
        const value = scoreFromText(next);
        if ((score === undefined ? '' : score) === value) return;
        commitOp({ kind: 'testScore', colId: col.id, rowKey: r.key, value });
      }));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  stickLeadingColumns(table, [W.family, W.first, W.cls]);

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  wrap.appendChild(scrollWrap);
  return wrap;
}

// Rows keep one line: text that doesn't fit its cell is made a little smaller
// instead of wrapping onto a taller row.
function shrinkCellTextToFit(cell){
  if (cell.scrollWidth <= cell.clientWidth) return;
  let size = parseFloat(getComputedStyle(cell).fontSize) || 13;
  let guard = 0;
  while (cell.scrollWidth > cell.clientWidth && size > 7 && guard < 40){
    size -= 0.5;
    cell.style.fontSize = size + 'px';
    guard++;
  }
}

function moveSelectedMetivtaRows(keys, toArchive){
  if (keys.length === 0) return;
  requireArchiveEditAccess(() => {
    keys.forEach(k => metivtaSelectedKeys.delete(k));
    keys.forEach(k => commitOp({ kind: 'marchived', key: k, archived: toArchive }));
  });
}

// How many days the Metivta table shows - this computer remembers the last choice.
const METIVTA_DAY_COUNT_KEY = 'metivtaVisibleDayCount';
let metivtaVisibleDayCount = (() => {
  try{
    const v = localStorage.getItem(METIVTA_DAY_COUNT_KEY);
    if (v === 'all') return null;
    const n = parseInt(v, 10);
    if (n >= 1 && n <= 15) return n;
  } catch(e){}
  return 5;
})();
let metivtaSort = { key: null, dir: 1 };
let metivtaSummaryField = 'total';
const METIVTA_VISIBLE_DAY_OPTIONS = [
  ...Array.from({ length: 15 }, (_, i) => i + 1).map(n => ({ key: n, label: n === 1 ? 'יום אחד' : n + ' ימים' })),
  { key: null, label: 'הכל' }
];
const METIVTA_SUMMARY_FIELD_OPTIONS = [
  { key: 'total', label: 'נוכחות' },
  { key: 'onTime', label: 'בזמן' },
  { key: 'late', label: 'איחור' },
  { key: 'leftEarly', label: 'מוקדם' },
  { key: 'disturbed', label: 'הפרעות' }
];

function computeMetivtaStats(row, days){
  let onTime = 0, late = 0, leftEarly = 0, disturbed = 0;
  days.forEach(entry => {
    const rec = row.getRecord(entry);
    if (!rec || !metivtaRecordHasFlags(rec)) return;
    const f = rec.metivtaFlags;
    if (f.late) late++; else onTime++;
    if (f.leftEarly) leftEarly++;
    if (f.disturbCount > 0) disturbed += f.disturbCount;
  });
  return { onTime, late, leftEarly, disturbed };
}

// "נוכחות" counts every day the student was present at all - even a day
// marked late/left-early/disturbed still counts as attendance here, unlike
// the other fields which isolate one specific exception type.
function metivtaSummaryText(stats, field){
  if (field === 'total') return String(stats.onTime + stats.late);
  return String(stats[field] || 0);
}

// Today's column is fed from the live board state, not the archive - it is
// where the day's attendance is entered. Same shape as an archived day so
// every per-day helper (labels, scores, summary, CSV) works on it as is.
function buildMetivtaTodayEntry(){
  return {
    date: new Date().toISOString(),
    isLive: true,
    students: state.students.map(s => ({ id: s.id, metivtaFlags: ensureMetivtaFlags(s) })),
    metivtaExtraStudents: state.metivtaExtra.map(s => ({ id: s.id, metivtaFlags: ensureMetivtaFlags(s) }))
  };
}

// A past day only gets a column if someone actually recorded Metivta
// attendance that day - days the board was used for other things only
// (class points etc.) don't show up as empty Metivta columns.
function metivtaEntryHasData(entry){
  const recs = [...(entry.students || []), ...(entry.metivtaExtraStudents || [])];
  return recs.some(rec => metivtaRecordScore(rec) >= 0);
}

function buildMetivtaDropdown(options, activeKey, toggleClass, onPick){
  const list = document.createElement('div');
  list.className = 'merged-dropdown-list merged-dropdown-list-right';
  options.forEach(opt => {
    const optEl = document.createElement('div');
    optEl.className = 'merged-dropdown-option' + (opt.key === activeKey ? ' merged-dropdown-option-active' : '');
    optEl.textContent = opt.label;
    optEl.addEventListener('click', (e) => {
      e.stopPropagation();
      list.classList.remove('open');
      onPick(opt.key);
    });
    list.appendChild(optEl);
  });
  const activeOpt = options.find(o => o.key === activeKey) || options[0];
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'merged-dropdown-toggle' + (toggleClass ? ' ' + toggleClass : '');
  toggle.textContent = activeOpt.label;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.merged-dropdown-list.open').forEach(l => { if (l !== list) l.classList.remove('open'); });
    list.classList.toggle('open');
    // The table sits in a sideways-scrolling, clipped box - position the
    // list against the viewport so it is never hidden under the table.
    if (list.classList.contains('open')) placeDropdownListFixed(toggle, list);
  });
  const dropdown = document.createElement('div');
  dropdown.className = 'merged-dropdown';
  dropdown.appendChild(toggle);
  dropdown.appendChild(list);
  return dropdown;
}

// Text columns sort א→ת first; number/day columns sort highest first.
// Clicking the active column again reverses it; "#" restores the original order.
function metivtaSortDefaultDir(key){
  return (key === 'family' || key === 'first' || key === 'class') ? 1 : -1;
}

function setMetivtaSort(key){
  if (key === null) metivtaSort = { key: null, dir: 1 };
  else if (metivtaSort.key === key) metivtaSort = { key, dir: -metivtaSort.dir };
  else metivtaSort = { key, dir: metivtaSortDefaultDir(key) };
  renderMetivtaView();
}

function metivtaSortArrow(key){
  if (metivtaSort.key !== key) return '';
  return metivtaSort.dir === metivtaSortDefaultDir(key) ? ' ▼' : ' ▲';
}

function metivtaDayColumnKey(entry){
  return entry.isLive ? 'live' : 'day:' + entry.date;
}

function sortMetivtaRows(rows, visibleDays){
  const { key, dir } = metivtaSort;
  if (!key) return rows;
  const textOf = (row) => key === 'family' ? row.family : key === 'first' ? row.first : row.clsLabel;
  let numOf = null;
  if (key === 'summary'){
    numOf = (row) => Number(metivtaSummaryText(computeMetivtaStats(row, visibleDays), metivtaSummaryField)) || 0;
  } else if (key !== 'family' && key !== 'first' && key !== 'class'){
    const entry = visibleDays.find(e => metivtaDayColumnKey(e) === key);
    if (!entry) return rows;
    numOf = (row) => metivtaRecordScore(row.getRecord(entry));
  }
  return rows.slice().sort((a, b) => {
    if (numOf) return (numOf(a) - numOf(b)) * dir;
    const ta = textOf(a), tb = textOf(b);
    if (!ta && tb) return 1;
    if (ta && !tb) return -1;
    return ta.localeCompare(tb, 'he', { numeric: true }) * dir;
  });
}

function buildMetivtaSortBtn(key){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'metivta-header-toggle metivta-sort-btn';
  btn.textContent = metivtaSortArrow(key).trim() || '⇅';
  btn.title = 'מיון לפי הטור הזה';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMetivtaSort(key);
  });
  return btn;
}

// ---- Adding a past day to the Metivta table: a Hebrew-calendar picker ----
function hebrewNumberLetters(n){
  const hundreds = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  let rest = n % 100;
  let out = hundreds[Math.floor((n % 1000) / 100)];
  if (rest === 15) out += 'טו';
  else if (rest === 16) out += 'טז';
  else out += tens[Math.floor(rest / 10)] + ones[rest % 10];
  return out.length > 1 ? out.slice(0, -1) + '"' + out.slice(-1) : out + "'";
}

function hebrewDateInfo(d){
  const parts = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
  return { day: parseInt(get('day'), 10), month: get('month'), year: parseInt(get('year'), 10) };
}

// The days (local noon) of the Hebrew month that `anchor` falls in.
function hebrewMonthDays(anchor){
  const first = new Date(anchor);
  first.setHours(12, 0, 0, 0);
  while (hebrewDateInfo(first).day > 1) first.setDate(first.getDate() - 1);
  const month = hebrewDateInfo(first).month;
  const days = [];
  const d = new Date(first);
  while (hebrewDateInfo(d).month === month){
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function showHebrewDayPicker(shownDays){
  const shown = new Set(shownDays.map(e => dayKeyOf(e.date)));
  const today = activityDayStr();
  let anchor = new Date();
  anchor.setDate(anchor.getDate() - 1);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box heb-cal';
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  function draw(){
    box.innerHTML = '';
    const days = hebrewMonthDays(anchor);
    const info = hebrewDateInfo(days[0]);
    const head = document.createElement('div');
    head.className = 'heb-cal-head';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'heb-cal-nav';
    prev.textContent = '›';
    prev.title = 'החודש הקודם';
    prev.addEventListener('click', () => { anchor = new Date(days[0]); anchor.setDate(anchor.getDate() - 1); draw(); });
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'heb-cal-nav';
    next.textContent = '‹';
    next.title = 'החודש הבא';
    const after = new Date(days[days.length - 1]);
    after.setDate(after.getDate() + 1);
    next.disabled = dayKeyOf(after.toISOString()) >= today;
    next.addEventListener('click', () => { anchor = after; draw(); });
    const title = document.createElement('div');
    title.className = 'heb-cal-title';
    title.textContent = info.month + ' ' + hebrewNumberLetters(info.year);
    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'heb-cal-grid';
    ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'].forEach(n => {
      const h = document.createElement('div');
      h.className = 'heb-cal-weekday';
      h.textContent = n;
      grid.appendChild(h);
    });
    for (let i = 0; i < days[0].getDay(); i++) grid.appendChild(document.createElement('div'));
    days.forEach(d => {
      const key = dayKeyOf(d.toISOString());
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'heb-cal-day' + (shown.has(key) ? ' shown' : '');
      btn.innerHTML = '<span class="heb">' + hebrewDayLetters(hebrewDateInfo(d).day) + '</span><span class="greg">' + d.getDate() + '.' + (d.getMonth() + 1) + '</span>';
      btn.disabled = key >= today || d.getDay() >= 5 || shown.has(key); // no Metivta on Friday/Shabbat
      btn.title = shown.has(key) ? 'כבר מופיע בטבלה' : '';
      btn.addEventListener('click', () => {
        overlay.remove();
        addMetivtaPastDay(key);
      });
      grid.appendChild(btn);
    });
    box.appendChild(grid);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-btn modal-btn-cancel';
    close.style.marginTop = '12px';
    close.textContent = 'סגור';
    close.addEventListener('click', () => overlay.remove());
    box.appendChild(close);
  }
  draw();
  document.body.appendChild(overlay);
}

function addMetivtaPastDay(dayKey){
  commitOp({ kind: 'addMetivtaDay', target: dayKey });
  // Make sure the new column is inside the number of days shown.
  const shownKeys = getDisplayArchive()
    .filter(e => e.type !== 'weekly' && !e.isLive && (metivtaEntryHasData(e) || e.metivtaAddedDay))
    .map(e => dayKeyOf(e.date));
  const index = shownKeys.indexOf(dayKey) + 1; // +1 for today's column
  if (metivtaVisibleDayCount !== null && index >= metivtaVisibleDayCount){
    metivtaVisibleDayCount = index + 1 > 15 ? null : index + 1;
    renderMetivtaView();
  }
}

function buildMetivtaTable({ days, archivedKeys, archiveTable, availableWidth }){
  const wrap = document.createElement('div');
  wrap.className = 'archive-entry';

  const toRow = (student, isExtra, getRecord, ensureRecord) => ({
    id: student.id,
    isExtra,
    key: metivtaRowKey(student.id, isExtra),
    family: metivtaFamilyName(student.id, isExtra),
    first: metivtaFirstName(student.id, isExtra),
    clsLabel: metivtaClassLabel(student.id, isExtra),
    getRecord,
    ensureRecord
  });
  const mainRows = state.students.map(student => toRow(student, false,
    (entry) => (entry.students || []).find(x => x.id === student.id) || null,
    (entry) => (entry.students || []).find(x => x.id === student.id) || null
  ));
  const extraRows = state.metivtaExtra.map(student => toRow(student, true,
    (entry) => (entry.metivtaExtraStudents || []).find(x => x.id === student.id) || null,
    (entry) => {
      if (!Array.isArray(entry.metivtaExtraStudents)) entry.metivtaExtraStudents = [];
      let s = entry.metivtaExtraStudents.find(x => x.id === student.id);
      if (!s){ s = { id: student.id, metivtaFlags: { ok: false, late: false, leftEarly: false, noBook: false, lateTime: '', task: '', taskDone: false, disturbCount: 0 } }; entry.metivtaExtraStudents.push(s); }
      return s;
    }
  ));
  const tableRows = mainRows.concat(extraRows).filter(r => archivedKeys.has(r.key) === archiveTable);
  const selectedHere = tableRows.filter(r => metivtaSelectedKeys.has(r.key)).map(r => r.key);

  const dateEl = document.createElement('div');
  dateEl.className = 'archive-date weekly-header-row';
  const headerGroup = document.createElement('div');
  headerGroup.className = 'header-group';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = archiveTable ? 'ארכיון' : 'מתיבתא';
  if (archiveTable){
    titleSpan.textContent = (metivtaArchiveOpen ? '▾ ' : '◂ ') + 'ארכיון (' + tableRows.length + ')';
    titleSpan.style.cursor = 'pointer';
    titleSpan.title = metivtaArchiveOpen ? 'סגירה' : 'פתיחה';
    titleSpan.addEventListener('click', () => {
      metivtaArchiveOpen = !metivtaArchiveOpen;
      renderMetivtaView();
    });
  }
  headerGroup.appendChild(titleSpan);
  if (!archiveTable){
    const sep = document.createElement('span');
    sep.textContent = '·';
    headerGroup.appendChild(sep);
    const viewLabel = document.createElement('span');
    viewLabel.textContent = 'תצוגה:';
    headerGroup.appendChild(viewLabel);
    headerGroup.appendChild(buildMetivtaDropdown(METIVTA_VISIBLE_DAY_OPTIONS, metivtaVisibleDayCount, '', (k) => {
      metivtaVisibleDayCount = k;
      try{ localStorage.setItem(METIVTA_DAY_COUNT_KEY, k === null ? 'all' : String(k)); } catch(e){}
      renderMetivtaView();
    }));
  }
  if (!archiveTable){
    const addDayBtn = document.createElement('button');
    addDayBtn.type = 'button';
    addDayBtn.className = 'metivta-move-btn';
    addDayBtn.textContent = '+יום';
    addDayBtn.title = 'הוספת טור ליום שעבר';
    addDayBtn.addEventListener('click', () => requireArchiveEditAccess(() => showHebrewDayPicker(days)));
    headerGroup.appendChild(addDayBtn);
  }
  if (selectedHere.length > 0){
    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.className = 'metivta-move-btn';
    moveBtn.textContent = (archiveTable ? 'החזרה למתיבתא' : 'העברה לארכיון') + ' (' + selectedHere.length + ')';
    moveBtn.addEventListener('click', () => moveSelectedMetivtaRows(selectedHere, !archiveTable));
    headerGroup.appendChild(moveBtn);
  }
  dateEl.appendChild(headerGroup);

  wrap.appendChild(dateEl);
  if (archiveTable && !metivtaArchiveOpen) return wrap;

  // Fixed widths so the leading columns stay narrow. Today's column (where
  // attendance is entered) gets whatever room is left on screen after them,
  // between a normal day's width and 110px - never pushed off-screen.
  const COL_W = {
    num: 26,
    family: textColumnWidth(tableRows.map(r => r.family), 'משפחה', 4),
    first: textColumnWidth(tableRows.map(r => r.first), 'פרטי', 4),
    class: 34, summary: 62, day: 56
  };
  const leadWidth = COL_W.num + COL_W.family + COL_W.first + COL_W.class + COL_W.summary;
  COL_W.today = Math.max(COL_W.day, Math.min(110, availableWidth - 2 - leadWidth));
  const dayColWidth = (entry) => entry.isLive ? COL_W.today : COL_W.day;
  const table = document.createElement('table');
  table.className = 'archive-table metivta-table';
  table.style.width = 'max(100%, ' + days.reduce((sum, e) => sum + dayColWidth(e), leadWidth) + 'px)';

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');

  function plainSortableTh(label, key){
    const th = document.createElement('th');
    th.style.cursor = 'pointer';
    th.textContent = label + metivtaSortArrow(key);
    th.addEventListener('click', () => setMetivtaSort(key));
    return th;
  }

  const numTh = document.createElement('th');
  numTh.textContent = '#';
  numTh.style.cursor = 'pointer';
  numTh.title = 'חזרה לסדר המקורי';
  numTh.addEventListener('click', () => setMetivtaSort(null));
  trh.appendChild(numTh);

  trh.appendChild(plainSortableTh('משפחה', 'family'));
  trh.appendChild(plainSortableTh('פרטי', 'first'));
  trh.appendChild(plainSortableTh('כיתה', 'class'));

  const summaryTh = document.createElement('th');
  summaryTh.className = 'metivta-summary-col';
  const summaryLabel = document.createElement('div');
  summaryLabel.className = 'metivta-summary-label';
  summaryLabel.textContent = 'סיכום';
  summaryTh.appendChild(summaryLabel);
  const fieldRow = document.createElement('div');
  fieldRow.className = 'metivta-th-row';
  fieldRow.appendChild(buildMetivtaDropdown(METIVTA_SUMMARY_FIELD_OPTIONS, metivtaSummaryField, 'metivta-header-toggle', (k) => {
    metivtaSummaryField = k;
    renderMetivtaView();
  }));
  fieldRow.appendChild(buildMetivtaSortBtn('summary'));
  summaryTh.appendChild(fieldRow);
  trh.appendChild(summaryTh);

  days.forEach(entry => {
    const key = metivtaDayColumnKey(entry);
    const th = document.createElement('th');
    th.style.cursor = 'pointer';
    if (entry.isLive) th.className = 'metivta-today-col';
    const d = new Date(entry.date);
    const dateSpan = document.createElement('div');
    dateSpan.textContent = formatHebrewDateShort(d) + metivtaSortArrow(key);
    const weekdaySpan = document.createElement('div');
    weekdaySpan.textContent = entry.isLive ? 'היום' : d.toLocaleDateString('he-IL', { weekday: 'short' });
    weekdaySpan.style.fontWeight = entry.isLive ? '700' : '400';
    weekdaySpan.style.fontSize = '0.9em';
    weekdaySpan.style.color = 'var(--ink-soft)';
    th.appendChild(dateSpan);
    th.appendChild(weekdaySpan);
    th.addEventListener('click', () => setMetivtaSort(key));
    trh.appendChild(th);
  });
  const headerWidths = [COL_W.num, COL_W.family, COL_W.first, COL_W.class, COL_W.summary];
  // Every column keeps its width, today's included, so the proportions are the
  // same on a small screen and a big one.
  [...trh.children].forEach((th, i) => {
    const entry = days[i - headerWidths.length];
    th.style.width = (i < headerWidths.length ? headerWidths[i] : dayColWidth(entry)) + 'px';
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  sortMetivtaRows(tableRows, days).forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    if (metivtaSelectedKeys.has(row.key)) tr.className = 'metivta-selected';

    const numTd = document.createElement('td');
    numTd.className = 'metivta-rownum';
    numTd.textContent = String(rowIndex + 1);
    numTd.title = 'סימון התלמיד';
    numTd.addEventListener('click', () => {
      if (metivtaSelectedKeys.has(row.key)) metivtaSelectedKeys.delete(row.key);
      else metivtaSelectedKeys.add(row.key);
      renderMetivtaView();
    });
    tr.appendChild(numTd);

    tr.appendChild(buildMetivtaEditableCell(row.family, 'שם משפחה', (v) => setMetivtaNamePart(row.id, row.isExtra, 'family', v)));
    tr.appendChild(buildMetivtaEditableCell(row.first, 'שם פרטי', (v) => setMetivtaNamePart(row.id, row.isExtra, 'first', v)));
    tr.appendChild(buildMetivtaEditableCell(row.clsLabel, 'כיתה', (v) => setMetivtaClassValue(row.id, row.isExtra, v.replace(/^ז\s*(?=\d+$)/, ''))));

    const summaryTd = document.createElement('td');
    summaryTd.className = 'metivta-summary-col';
    summaryTd.textContent = metivtaSummaryText(computeMetivtaStats(row, days), metivtaSummaryField);
    tr.appendChild(summaryTd);

    days.forEach(entry => {
      const rec = row.getRecord(entry);
      const td = document.createElement('td');
      if (entry.isLive){
        const flags = rec.metivtaFlags;
        const hasException = flags.late || flags.leftEarly || flags.noBook || flags.disturbCount > 0;
        td.className = 'metivta-today-cell' + (hasException ? ' today-exception' : (flags.ok ? ' today-ok' : ''));
        const label = document.createElement('span');
        label.textContent = metivtaStatusParts(flags).join(' · ');
        td.appendChild(label);
        if (flags.task){
          if (label.textContent) label.appendChild(document.createTextNode(' · '));
          const taskWord = document.createElement('span');
          taskWord.className = 'metivta-task' + (flags.taskDone ? ' done' : '');
          taskWord.textContent = 'מטלה';
          taskWord.addEventListener('click', (e) => { e.stopPropagation(); showMetivtaTaskModal(row.id, row.isExtra); });
          label.appendChild(taskWord);
        }
        td.addEventListener('click', (e) => {
          if (e.target.closest('.status-plus-btn')) return;
          toggleMetivtaOk(row.id, row.isExtra);
        });
        const plusBtn = document.createElement('button');
        plusBtn.type = 'button';
        plusBtn.className = 'status-plus-btn';
        plusBtn.textContent = '+';
        plusBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showMetivtaStatusExceptionsModal(row.id, row.isExtra);
        });
        td.appendChild(plusBtn);
      } else {
        // Like today's cell: a click marks present (✓) / clears it, the small
        // plus opens the other details. Both need the archive edit code.
        const dayKey = dayKeyOf(entry.date);
        const curFlags = () => ({ ...DEFAULT_METIVTA_FLAGS, ...((rec && rec.metivtaFlags) || {}) });
        const commitDay = (flags) => commitOp({ kind: 'archiveCell', target: dayKey, group: row.isExtra ? 'extra' : 'main', sid: row.id, field: 'metivtaFlags', value: { ...flags } });
        const flags = curFlags();
        const hasException = flags.late || flags.leftEarly || flags.noBook || flags.disturbCount > 0;
        td.className = 'metivta-today-cell' + (hasException ? ' today-exception' : (flags.ok ? ' today-ok' : ''));
        const label = document.createElement('span');
        label.textContent = metivtaRecordLabel(rec);
        td.appendChild(label);
        td.addEventListener('click', (e) => {
          if (e.target.closest('.status-plus-btn')) return;
          requireArchiveEditAccess(() => {
            const f = curFlags();
            if (f.late || f.leftEarly || f.noBook || f.disturbCount > 0){
              f.late = false; f.lateTime = ''; f.leftEarly = false; f.noBook = false; f.disturbCount = 0; f.ok = true;
            } else {
              f.ok = !f.ok;
            }
            commitDay(f);
          });
        });
        const plusBtn = document.createElement('button');
        plusBtn.type = 'button';
        plusBtn.className = 'status-plus-btn';
        plusBtn.textContent = '+';
        plusBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const f = curFlags();
          promptEditArchiveMetivtaFlags(f, () => commitDay(f));
        });
        td.appendChild(plusBtn);
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  stickLeadingColumns(table, [COL_W.num, COL_W.family, COL_W.first]);

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  wrap.appendChild(scrollWrap);
  return wrap;
}

// A day's metivtaVal is -1 when the student wasn't at the Metivta that day
// (so sorting ranks "absent" below "present with 0"); it is shown, summed and
// exported as no value at all, never as -1.
function weeklyDayFieldValue(dayData, field){
  const v = (dayData && dayData[field]) || 0;
  return field === 'metivtaVal' ? Math.max(0, v) : v;
}

// A click puts the column's full value for that day, another click clears it
// (0). The value stays in הנוסע המתמיד only - the class archive is not
// changed. A later edit in the class archive of that day overrides it (see
// refreshWeeklyFromDay: the later edit of a cell wins).
// מתיבתא: 4 is a full day; clearing it makes the day "no attendance" (-1),
// which is how the Metivta marks a day nobody attended.
const WEEKLY_DAY_FULL_VALUE = { morning: 2, tefila: 3, bonus: 1, mikvaotVal: 2, rambamVal: 2, metivtaVal: 4 };

// A day-by-day update of a daily column: the days of the week (so far) on which
// the student does not have it yet, to update, and under a line the days that
// are updated, to cancel. Each choice asks for confirmation first; the change
// stays in הנוסע המתמיד only (a later edit of that day in the class archive
// overrides it).
function showDayUpdatePicker(td, entry, s, field){
  document.querySelectorAll('.ff-value-picker').forEach(el => el.remove());
  const weekStartD = new Date(entry.weekStart);
  const today = activityDayStr();
  const missing = [], done = [];
  for (let i = 0; i < 6; i++){
    const d = new Date(weekStartD);
    d.setDate(d.getDate() + i);
    const key = dayKeyOf(d.toISOString());
    if (key >= today) break;
    if (i === FRIDAY_INDEX && field === 'metivtaVal') continue;
    const dd = (s.days || {})[key] || {};
    const isDone = field === 'metivtaVal' ? (typeof dd.metivtaVal === 'number' && dd.metivtaVal >= 0) : (dd[field] || 0) > 0;
    (isDone ? done : missing).push({ key, label: WEEKDAY_LETTERS[i] + ' · ' + formatHebrewDateShort(d), points: weeklyDayFieldValue(dd, field) });
  }
  const name = metivtaFullName(s.id, false);
  const fieldLabel = editLogFieldLabel(field);
  const points = WEEKLY_DAY_FULL_VALUE[field];
  const list = document.createElement('div');
  list.className = 'merged-dropdown-list ff-value-picker open';
  const addTitle = (text) => {
    const t = document.createElement('div');
    t.className = 'ff-picker-title';
    t.textContent = text;
    list.appendChild(t);
  };
  const addOption = (label, onClick) => {
    const opt = document.createElement('div');
    opt.className = 'merged-dropdown-option';
    opt.textContent = label;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      list.remove();
      onClick();
    });
    list.appendChild(opt);
  };
  addTitle('לעדכון:');
  if (!missing.length){
    const none = document.createElement('div');
    none.className = 'ff-picker-none';
    none.textContent = 'אין ימים לא מעודכנים';
    list.appendChild(none);
  }
  missing.forEach(day => addOption(day.label, () => showModal(
    'לעדכן ' + fieldLabel + ' של ' + name + ' ליום ' + day.label + '?\nיתווספו ' + points + (points === 1 ? ' נקודה.' : ' נקודות.'),
    { confirmText: 'עדכון', onConfirm: () => commitOp({ kind: 'weekCell', weekKey: entry.weekKey, sid: s.id, field, target: day.key, value: points }) }
  )));
  if (done.length){
    const line = document.createElement('div');
    line.className = 'ff-picker-line';
    list.appendChild(line);
    addTitle('לביטול:');
    done.forEach(day => addOption(day.label, () => showModal(
      'לבטל ' + fieldLabel + ' של ' + name + ' ביום ' + day.label + '?\nיורדו ' + day.points + (day.points === 1 ? ' נקודה.' : ' נקודות.'),
      { confirmText: 'ביטול היום', cancelText: 'השארה', onConfirm: () => commitOp({ kind: 'weekCell', weekKey: entry.weekKey, sid: s.id, field, target: day.key, value: field === 'metivtaVal' ? -1 : 0 }) }
    )));
  }
  list.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(list);
  placeDropdownListFixed(td, list);
  list.style.minWidth = Math.max(td.offsetWidth, 120) + 'px';
}

// The detailed report: the letters of the school days (so far) on which the
// student did not get this daily column, split by commas.
function weeklyMissingDayLetters(entry, s, field){
  const weekStartD = new Date(entry.weekStart);
  const today = todayStr();
  const out = [];
  for (let i = 0; i < 6; i++){
    const d = new Date(weekStartD);
    d.setDate(d.getDate() + i);
    if (dayKeyOf(d.toISOString()) >= today) break;
    if (i === FRIDAY_INDEX && field === 'metivtaVal') continue;
    const dd = (s.days || {})[dayKeyOf(d.toISOString())] || {};
    const done = field === 'metivtaVal' ? (typeof dd.metivtaVal === 'number' && dd.metivtaVal >= 0) : (dd[field] || 0) > 0;
    if (!done) out.push(WEEKDAY_LETTERS[i]);
  }
  return out.join(', ');
}

function weeklyDailySum(s, field){
  return Object.values(s.days || {}).reduce((sum, d) => sum + weeklyDayFieldValue(d, field), 0);
}

// ---- Sending the table as a PDF ----
// The table that is shown is drawn onto a canvas, made into a one-page PDF and
// put in the pdfOutbox collection; a server function sends it by e-mail to the
// address set in the admin page and marks the document sent or failed.

function isVisibleColor(c){
  return !!c && c !== 'transparent' && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c);
}

// Draws every cell of the table (background, lines, text) where it is on the
// screen, under a dark title bar.
async function renderTableToCanvas(table, titleText){
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const scroller = table.closest('.table-scroll');
  const oldScroll = scroller ? scroller.scrollLeft : 0;
  if (scroller) scroller.scrollLeft = 0;
  const tableRect = table.getBoundingClientRect();
  const W = Math.ceil(tableRect.width);
  const H = Math.ceil(tableRect.height);
  const TITLE_H = 44;
  const scale = Math.min(2, 2400 / W);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(W * scale);
  canvas.height = Math.ceil((H + TITLE_H) * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H + TITLE_H);
  ctx.direction = 'rtl';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#22304A';
  ctx.fillRect(0, 0, W, TITLE_H);
  ctx.fillStyle = '#F6F3EA';
  ctx.font = "700 20px 'Rubik', sans-serif";
  ctx.textAlign = 'right';
  ctx.fillText(titleText, W - 16, TITLE_H / 2);

  const cells = [...table.querySelectorAll('th, td')].map(cell => {
    const r = cell.getBoundingClientRect();
    return { cell, x: r.left - tableRect.left, y: r.top - tableRect.top + TITLE_H, w: r.width, h: r.height, cs: getComputedStyle(cell) };
  });
  // backgrounds (a transparent cell shows its row's), then the lines, then the text
  cells.forEach(({ cell, x, y, w, h, cs }) => {
    let bg = cs.backgroundColor;
    if (!isVisibleColor(bg) && cell.parentElement) bg = getComputedStyle(cell.parentElement).backgroundColor;
    if (isVisibleColor(bg)){ ctx.fillStyle = bg; ctx.fillRect(x, y, w, h); }
  });
  cells.forEach(({ x, y, w, h, cs }) => {
    const side = (name, rx, ry, rw, rh) => {
      const width = parseFloat(cs['border' + name + 'Width']) || 0;
      if (width > 0 && cs['border' + name + 'Style'] !== 'none' && isVisibleColor(cs['border' + name + 'Color'])){
        ctx.fillStyle = cs['border' + name + 'Color'];
        ctx.fillRect(rx(width), ry(width), rw(width), rh(width));
      }
    };
    side('Top', () => x, () => y, () => w, bw => bw);
    side('Bottom', () => x, bw => y + h - bw, () => w, bw => bw);
    side('Left', () => x, () => y, bw => bw, () => h);
    side('Right', bw => x + w - bw, () => y, bw => bw, () => h);
  });
  cells.forEach(({ cell, x, y, w, h, cs }) => {
    // The detailed report's cell: the number, and the missing days (two lines)
    // beside it - each piece is drawn where it is on the screen.
    const dwrap = cell.querySelector('.ff-dwrap');
    if (dwrap){
      [dwrap.children[0], ...dwrap.querySelectorAll('.ff-dletters > div')].forEach(piece => {
        const t = piece && piece.textContent.trim();
        if (!t) return;
        const ps = getComputedStyle(piece);
        if (!(parseFloat(ps.fontSize) > 0)) return;
        const r = piece.getBoundingClientRect();
        ctx.font = ps.fontStyle + ' ' + ps.fontWeight + ' ' + ps.fontSize + ' ' + ps.fontFamily;
        ctx.fillStyle = ps.color;
        ctx.textAlign = 'right';
        ctx.fillText(t, r.right - tableRect.left, r.top - tableRect.top + TITLE_H + r.height / 2);
      });
      return;
    }
    const el = cell.querySelector('.ff-fit') || cell;
    const text = el.textContent.trim();
    if (!text) return;
    const es = getComputedStyle(el);
    if (!(parseFloat(es.fontSize) > 0)) return;
    ctx.font = es.fontStyle + ' ' + es.fontWeight + ' ' + es.fontSize + ' ' + es.fontFamily;
    ctx.fillStyle = es.color;
    const align = cs.textAlign;
    if (align === 'right' || align === 'start'){ ctx.textAlign = 'right'; ctx.fillText(text, x + w - 5, y + h / 2); }
    else if (align === 'left' || align === 'end'){ ctx.textAlign = 'left'; ctx.fillText(text, x + 5, y + h / 2); }
    else { ctx.textAlign = 'center'; ctx.fillText(text, x + w / 2, y + h / 2); }
  });
  if (scroller) scroller.scrollLeft = oldScroll;
  return canvas;
}

// A PDF with a page (A4, landscape or portrait by the shape of the picture) for
// each JPEG picture, each as large as fits: images = [{ jpeg, w, h }].
function buildPdfFromJpegs(images){
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const begin = (n) => { offsets[n] = length; push(n + ' 0 obj\n'); };
  const count = images.length;
  // Objects: 1 catalog, 2 pages, then for every page: the page, its picture, its content.
  const pageObj = (i) => 3 + 3 * i;
  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2); push('<< /Type /Pages /Kids [' + images.map((_, i) => pageObj(i) + ' 0 R').join(' ') + '] /Count ' + count + ' >>\nendobj\n');
  images.forEach(({ jpeg, w: imgW, h: imgH }, i) => {
    const landscape = imgW >= imgH;
    const pw = landscape ? 842 : 595;
    const ph = landscape ? 595 : 842;
    const margin = PDF_PAGE_MARGIN;
    const k = Math.min((pw - 2 * margin) / imgW, (ph - 2 * margin) / imgH);
    const w = imgW * k, h = imgH * k;
    const x = (pw - w) / 2, y = (ph - h) / 2;
    const page = pageObj(i);
    begin(page);
    push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /Im0 ' + (page + 1) + ' 0 R >> >> /Contents ' + (page + 2) + ' 0 R >>\nendobj\n');
    begin(page + 1);
    push('<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
    push(jpeg);
    push('\nendstream\nendobj\n');
    const content = 'q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /Im0 Do Q';
    begin(page + 2); push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
  });
  const total = 3 + 3 * count;
  const xref = length;
  let table = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let n = 1; n < total; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  push(table + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  const out = new Uint8Array(length);
  let pos = 0;
  parts.forEach(b => { out.set(b, pos); pos += b.length; });
  return out;
}

function bytesToBase64(bytes){
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Firestore keeps a document under 1 MB: the picture's quality goes down
// until the PDF fits.
const PDF_MAX_BASE64 = 880000;
function scaleCanvas(canvas, factor){
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(canvas.width * factor));
  small.height = Math.max(1, Math.round(canvas.height * factor));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return small;
}

// One PDF with a page for each picture. All of them together have to fit in
// one queue document, so the pictures are made smaller as needed.
async function canvasesToPdfBase64(canvases){
  for (const factor of [1, 0.8, 0.65, 0.5]){
    const sized = factor === 1 ? canvases : canvases.map(c => scaleCanvas(c, factor));
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]){
      const images = [];
      for (const c of sized){
        const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', quality));
        images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: c.width, h: c.height });
      }
      const base64 = bytesToBase64(buildPdfFromJpegs(images));
      if (base64.length <= PDF_MAX_BASE64) return base64;
    }
  }
  throw new Error('הטבלאות גדולות מדי לשליחה');
}

// Puts a PDF file for each week in the queue and waits for the server to send
// them all in ONE e-mail (the documents of one batch are written together, and
// the server function sends a whole batch as one message with all the files).
// weeks = [{ canvas, label }]. Returns { ok, message }. Started from the admin
// page (see runSendPdfJob).
async function sendWeeksPdf(weeks, subject, onProgress){
  try{
    const settings = await getDoc(doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'meta', 'pdfSettings'));
    const email = settings.exists() ? (settings.data().email || '') : '';
    if (!email) return { ok: false, message: 'לא הוגדרה כתובת לשליחה. מגדירים אותה כאן, בלשונית "משתנים".' };
    onProgress('מכין…');
    const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const used = new Set();
    const entries = [];
    for (let i = 0; i < weeks.length; i++){
      // A file for each week, so none of them loses sharpness because of the others.
      let name = 'הנוסע-המתמיד-' + weeks[i].label.replace(/[\\/:*?"<>|\s]+/g, '-');
      if (used.has(name)) name += '-' + (i + 1);
      used.add(name);
      entries.push({
        id: batchId + '-' + i,
        data: {
          status: 'pending', createdAt: new Date().toISOString(), subject: i === 0 ? subject : weeks[i].label,
          filename: name + '.pdf', pdfBase64: await canvasesToPdfBase64([weeks[i].canvas]),
          batchId, batchSize: weeks.length, batchIndex: i
        }
      });
    }
    onProgress('שולח…');
    // All together, so the server never sees half a batch.
    await runTransaction(firestoreDb, async (tx) => {
      entries.forEach(e => tx.set(doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'pdfOutbox', e.id), e.data));
    });
    const ref = doc(firestoreDb, FIRESTORE_COLLECTION, STORAGE_KEY, 'pdfOutbox', entries[0].id);
    // The server function picks it up within a minute or so.
    for (let i = 0; i < 45; i++){
      await new Promise(resolve => setTimeout(resolve, 3000));
      const snap = await getDoc(ref);
      const data = snap.exists() ? snap.data() : null;
      if (data && data.status === 'sent') return { ok: true, message: 'נשלח ל-' + email };
      if (data && data.status === 'failed') return { ok: false, message: 'השליחה נכשלה: ' + (data.error || 'שגיאה לא ידועה') };
    }
    return { ok: false, message: 'השליחה עדיין בתור. אם לא תגיע בדקות הקרובות, בדוק את הגדרות הדוא"ל בשרת.' };
  } catch(e){
    return { ok: false, message: 'השליחה נכשלה: ' + (e && e.message ? e.message : String(e)) };
  }
}

// Draws a week so that, shrunk to a page of A4, it fills the page: the "screen"
// is given the shape of the page, and the letters of the missing days are never
// smaller than 7 points on the paper. A few rounds, since the width of the table
// (and so how much it is shrunk) depends on the sizes asked for.
const PDF_PAGE_MARGIN = 10;
const PDF_TITLE_HEIGHT = 44;
async function drawWeekForPaper(weekKey){
  PRINT.on = true;
  PRINT.viewportHeight = 0;
  PRINT.minLetterPx = 7 / 0.58;
  let table = null, box = null;
  for (let round = 0; round < 5; round++){
    document.documentElement.style.setProperty('--min-letter', PRINT.minLetterPx + 'px');
    selectedWeeklyKey = weekKey;
    renderFrequentFlyerView();
    await new Promise(resolve => setTimeout(resolve, 700));
    table = document.querySelector('#frequentArchiveView table');
    box = document.querySelector('#frequentArchiveView .archive-date');
    if (!table || !box) break;
    const rect = table.getBoundingClientRect();
    const W = rect.width, H = rect.height + PDF_TITLE_HEIGHT;
    const m = 2 * PDF_PAGE_MARGIN;
    const landscapeScale = Math.min((842 - m) / W, (595 - m) / H);
    const portraitScale = Math.min((595 - m) / W, (842 - m) / H);
    const landscape = landscapeScale >= portraitScale;
    const pageW = (landscape ? 842 : 595) - m, pageH = (landscape ? 595 : 842) - m;
    const byWidth = pageW / W;
    // The table as tall as the page allows at that scale, and the letters at 7pt.
    const wantedHeight = pageH / byWidth;
    const nextViewport = Math.round(wantedHeight - PDF_TITLE_HEIGHT + box.offsetHeight + 2);
    const nextMinLetter = 7 / byWidth;
    const settled = Math.abs(nextMinLetter - PRINT.minLetterPx) < 0.4 && Math.abs(nextViewport - PRINT.viewportHeight) < 8;
    PRINT.minLetterPx = nextMinLetter;
    PRINT.viewportHeight = nextViewport;
    if (settled) break;
  }
  return { table, box };
}

// The admin page sends the tables by loading this page in a hidden frame with
// ?sendpdf=<week>,<week>,...&job=<id>: the page draws each of those weeks, makes
// a PDF file for each, sends them all in one e-mail, and tells the admin page
// how it went.
async function runSendPdfJob(params){
  const job = params.get('job');
  const report = (ok, message) => { try{ parent.postMessage({ type: 'pdf-job', job, ok, message }, location.origin); } catch(e){} };
  try{
    // The e-mail settings and the PDF queue are private: they are read with
    // the admin page's Firebase user (same site, so this frame has it too).
    // Loaded only here, so the board itself doesn't download it.
    const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js");
    const auth = getAuth(firebaseApp);
    await auth.authStateReady();
    if (!auth.currentUser){ report(false, 'צריך להיכנס מחדש לעמוד הניהול'); return; }
    await auth.currentUser.getIdToken();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const weekKeys = params.get('sendpdf').split(',').filter(Boolean);
    const weeks = [];
    for (const weekKey of weekKeys){
      const weekEntry = getDisplayArchive().find(e => e.type === 'weekly' && e.weekKey === weekKey);
      if (!weekEntry){ report(false, 'הטבלה לא נמצאה'); return; }
      const { table, box } = await drawWeekForPaper(weekKey);
      if (!table || !box){ report(false, 'הטבלה לא נמצאה'); return; }
      const label = (box.querySelector('.merged-dropdown-toggle') || {}).textContent || '';
      // (The list of what is missing is shown on the screen only, not in the PDF.)
      weeks.push({ label, canvas: await renderTableToCanvas(table, 'הנוסע המתמיד · ' + label) });
    }
    const result = await sendWeeksPdf(weeks, 'הנוסע המתמיד · ' + weeks.map(w => w.label).join(', '), (text) => report(true, text));
    report(result.ok, result.message);
  } catch(e){
    report(false, 'השליחה נכשלה: ' + (e && e.message ? e.message : String(e)));
  }
}

function buildLiveTodayDailyEntry(){
  return {
    date: new Date().toISOString(),
    isLive: true,
    students: state.students.map(s => ({
      id: s.id,
      cats: { ...s.cats },
      purchases: s.purchases || 0,
      minusTotal: s.minusTotal || 0
    }))
  };
}

function getDisplayArchive(){
  const weekKey = getWeekKey(new Date());
  const archive = Array.isArray(state.archive) ? state.archive : [];
  const historical = archive
    .filter(e => e.type !== 'weekly' || e.weekKey !== weekKey)
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const currentWeekly = archive.find(e => e.type === 'weekly' && e.weekKey === weekKey);
  const weeklyList = currentWeekly ? [currentWeekly] : [];
  return [buildLiveTodayDailyEntry(), ...weeklyList, ...historical];
}

let weeklyArchiveSortField = {};
// The order of the rows of הנוסע המתמיד: made when a week / day / sort column
// is picked (by % unless another column is chosen) and kept while cells are
// edited, so a row does not jump under the cursor.
let weeklySortOrder = null; // { sig, ids }
let weeklyArchiveViewMode = {};

const HEBREW_WEEKDAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
// The days in the week menu: א, ב, ג ...
const WEEKDAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

function dayLabelWithinWeek(weekStartD, dayKeyStr){
  const selectedDate = new Date(dayKeyStr);
  const dIdx = Math.round((selectedDate.getTime() - new Date(dayKeyOf(weekStartD.toISOString())).getTime()) / 86400000);
  return WEEKDAY_LETTERS[dIdx] ? WEEKDAY_LETTERS[dIdx] + ' · ' + formatHebrewDateShort(selectedDate) : dayKeyStr;
}

// The one-line הנוסע המתמיד title bar scrolls sideways on narrow screens
// (overflow-x: auto), which also clips anything hanging below it - so its
// dropdown list is positioned relative to the viewport instead, escaping
// that clip. It closes on any outside scroll, since it would otherwise stay
// put while the toggle it belongs to scrolls away.
// Opens under the toggle - or above it when there isn't room below (a cell
// near the bottom of the screen), so the whole list is always visible.
function placeDropdownListFixed(toggle, list){
  const r = toggle.getBoundingClientRect();
  list.classList.add('dropdown-fixed');
  list.style.position = 'fixed';
  list.style.right = Math.max(window.innerWidth - r.right, 4) + 'px';
  list.style.left = 'auto';
  list.style.overflowY = 'auto';
  list.style.top = r.bottom + 'px';
  list.style.bottom = 'auto';
  list.style.maxHeight = 'none';
  const needed = list.scrollHeight;
  const below = window.innerHeight - r.bottom - 8;
  const above = r.top - 8;
  if (needed > below && above > below){
    list.style.top = 'auto';
    list.style.bottom = (window.innerHeight - r.top) + 'px';
    list.style.maxHeight = above + 'px';
  } else {
    list.style.maxHeight = Math.max(below, 160) + 'px';
  }
}

document.addEventListener('scroll', (e) => {
  document.querySelectorAll('.merged-dropdown-list.open.dropdown-fixed').forEach(l => {
    if (!l.contains(e.target)) l.classList.remove('open');
  });
}, true);

// One dropdown, nested: the outer list is the parshas/weeks; clicking a
// parsha expands a sub-list of that week's days (or "total") right under it,
// instead of opening a second, separate dropdown.
// ctx: where the picked week/day is kept and what to redraw - the
// הנוסע המתמיד table by default, the מתיבתא ז1 page passes its own.
const FREQUENT_WEEK_PICKER = {
  modes: weeklyArchiveViewMode,
  select: (weekKey, mode) => {
    selectedWeeklyKey = weekKey;
    weeklyArchiveViewMode[weekKey] = mode;
    weeklySortOrder = null;
    renderFrequentFlyerView();
  }
};

function buildWeekDaySelectDropdown(allWeeklyEntries, selectedEntry, ctx){
  ctx = ctx || FREQUENT_WEEK_PICKER;
  const currentMode = ctx.modes[selectedEntry.weekKey] || 'total';

  const list = document.createElement('div');
  list.className = 'merged-dropdown-list merged-dropdown-list-right';

  allWeeklyEntries.forEach(weekEntry => {
    const weekStartD = new Date(weekEntry.weekStart);
    const isSelectedWeek = weekEntry.weekKey === selectedEntry.weekKey;

    const parshaRow = document.createElement('div');
    parshaRow.className = 'parsha-option' + (isSelectedWeek && ctx !== FREQUENT_WEEK_PICKER ? ' open' : '');

    const parshaMain = document.createElement('div');
    parshaMain.className = 'merged-dropdown-option parsha-option-main';

    const parshaLabel = document.createElement('span');
    parshaLabel.className = 'parsha-option-label';
    parshaLabel.textContent = weeklyEntryLabel(weekEntry);
    parshaMain.appendChild(parshaLabel);
    parshaMain.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.merged-dropdown-list.open').forEach(l => l.classList.remove('open'));
      ctx.select(weekEntry.weekKey, 'total');
    });

    // הנוסע המתמיד has no tables by day: a week is just the week. (The ז1 page
    // still opens a list of the week's days.)
    const hasDays = ctx !== FREQUENT_WEEK_PICKER;
    if (hasDays){
      const expandBtn = document.createElement('span');
      expandBtn.className = 'parsha-option-caret';
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const alreadyOpen = parshaRow.classList.contains('open');
        list.querySelectorAll('.parsha-option.open').forEach(p => p.classList.remove('open'));
        if (!alreadyOpen) parshaRow.classList.add('open');
      });
      parshaMain.appendChild(expandBtn);
    }

    parshaRow.appendChild(parshaMain);

    const subList = document.createElement('div');
    subList.className = 'merged-dropdown-sublist';

    const addDayOption = (value, label) => {
      const isActive = isSelectedWeek && value === currentMode;
      const dayOpt = document.createElement('div');
      dayOpt.className = 'merged-dropdown-option' + (isActive ? ' merged-dropdown-option-active' : '');
      dayOpt.textContent = label;
      dayOpt.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.merged-dropdown-list.open').forEach(l => l.classList.remove('open'));
        ctx.select(weekEntry.weekKey, value);
      });
      subList.appendChild(dayOpt);
    };

    // The week itself is the detailed report (the parsha above); below it its
    // days. No Shabbat day, and no day that hasn't come yet.
    const today = activityDayStr();
    for (let i = 0; hasDays && i < 6; i++){
      const d = new Date(weekStartD);
      d.setDate(d.getDate() + i);
      const key = dayKeyOf(d.toISOString());
      if (key > today) break;
      addDayOption(key, WEEKDAY_LETTERS[i] + ' · ' + formatHebrewDateShort(d));
    }
    if (hasDays) parshaRow.appendChild(subList);
    list.appendChild(parshaRow);
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'merged-dropdown-toggle';
  const weekStartD = new Date(selectedEntry.weekStart);
  toggle.textContent = currentMode === 'total' || currentMode === 'detail' ? weeklyEntryLabel(selectedEntry)
    : weeklyEntryLabel(selectedEntry) + ' · ' + dayLabelWithinWeek(weekStartD, currentMode);
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.merged-dropdown-list.open').forEach(l => {
      if (l !== list) l.classList.remove('open');
    });
    list.classList.toggle('open');
    if (list.classList.contains('open')) placeDropdownListFixed(toggle, list);
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'merged-dropdown';
  dropdown.appendChild(toggle);
  dropdown.appendChild(list);
  return dropdown;
}

// Weekly columns filled in by the class (a number for the whole week), each
// with the one in charge of it.
// step/max: the points that can be given, picked from a list (0, step, 2*step, ... max).
const WEEKLY_CLASS_FIELD_DEFS = [
  { field: 'mivtzaim', label: 'מבצעים', kind: 'weekly-number', group: 'את"ה', step: 6, max: 6 },
  { field: 'hayomYom', label: 'היום יום', kind: 'weekly-number', group: 'משה', step: 2, max: 14 },
  { field: 'chitasClass', label: 'חת"ת', kind: 'weekly-number', group: 'משה', step: 3, max: 21 },
  { field: 'gaomash', label: 'גאומ"ש', kind: 'weekly-number', group: 'משה', step: 2, max: 10 },
  { field: 'mincha', label: 'מנחה', kind: 'weekly-number', group: 'מנהל', step: 1, max: 5 }
];

// Points of a weekly column in הנוסע המתמיד. Parents report days (0-7) or a
// ✓; ratio turns that into points.
function weeklyFieldPoints(s, f){
  const ratio = f.ratio || 1;
  if (f.kind === 'weekly-bool') return s[f.field] ? ratio : 0;
  return (Number(s[f.field]) || 0) * ratio;
}

// The week's score out of WEEKLY_FULL_POINTS: every column's points added up.
const WEEKLY_FULL_POINTS = 170;
const WEEKLY_DAILY_FIELDS = ['morning', 'tefila', 'mikvaotVal', 'bonus', 'rambamVal', 'metivtaVal'];
function weeklyPercent(s){
  let points = WEEKLY_DAILY_FIELDS.reduce((sum, f) => sum + weeklyDailySum(s, f), 0);
  [...WEEKLY_CLASS_FIELD_DEFS, ...WEEKLY_PARENT_FIELD_DEFS].forEach(f => { points += weeklyFieldPoints(s, f); });
  return Math.round(points / WEEKLY_FULL_POINTS * 100);
}

const WEEKLY_PARENT_FIELD_DEFS = [
  { field: 'chitas', label: 'חת"ת', kind: 'weekly-number', ratio: 2 },
  { field: 'shema', label: 'ישן חסיד', kind: 'weekly-number' },
  { field: 'netilatYadaim', label: 'קם חסיד', kind: 'weekly-number' },
  { field: 'minchaMaariv', label: 'מנחה מעריב', kind: 'weekly-number', ratio: 2 },
  { field: 'mikveh', label: 'מקווה שישי', kind: 'weekly-bool', ratio: 3 },
  { field: 'dvarTorah', label: 'שיחה', kind: 'weekly-bool', ratio: 4 }
];

// A list of the points a weekly cell can get, opened under the cell.
function showWeeklyValuePicker(td, values, current, onPick){
  document.querySelectorAll('.ff-value-picker').forEach(el => el.remove());
  const list = document.createElement('div');
  list.className = 'merged-dropdown-list ff-value-picker open';
  values.forEach(v => {
    const opt = document.createElement('div');
    opt.className = 'merged-dropdown-option' + (v === current ? ' merged-dropdown-option-active' : '');
    opt.textContent = String(v);
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      list.remove();
      if (v !== current) onPick(v);
    });
    list.appendChild(opt);
  });
  list.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(list);
  placeDropdownListFixed(td, list);
  list.style.minWidth = Math.max(td.offsetWidth, 48) + 'px';
}

function fitHeaderCellToWidestWord(th){
  const label = th.dataset.fitLabel;
  if (!label) return;
  const words = label.split(' ');
  const cs = getComputedStyle(th);
  const span = document.createElement('span');
  span.style.position = 'fixed';
  span.style.top = '-9999px';
  span.style.whiteSpace = 'nowrap';
  span.style.fontFamily = cs.fontFamily;
  span.style.fontWeight = cs.fontWeight;
  span.style.fontSize = cs.fontSize;
  document.body.appendChild(span);
  let maxWordWidth = 0;
  words.forEach(w => {
    span.textContent = w;
    maxWordWidth = Math.max(maxWordWidth, span.getBoundingClientRect().width);
  });
  span.remove();
  const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  th.style.width = Math.ceil(maxWordWidth + padding + border + 4) + 'px';
}

// The width (px) a column needs for its longest text - cell text at the
// tables' 13px, the header label in bold - plus the cell's padding.
function textColumnWidth(texts, headerLabel, padding){
  const ctx = textColumnWidth.ctx || (textColumnWidth.ctx = document.createElement('canvas').getContext('2d'));
  ctx.font = "400 13px 'Rubik', sans-serif";
  let w = 0;
  texts.forEach(t => { w = Math.max(w, ctx.measureText(String(t || '')).width); });
  ctx.font = "700 12.5px 'Rubik', sans-serif";
  w = Math.max(w, ctx.measureText(headerLabel || '').width);
  return Math.ceil(w + padding + 4);
}

// The leading (name) columns stay in place while the rest of the table
// scrolls sideways under them. widths: each sticky column's width in px.
// The first columns of a table that scrolls sideways stay in place. They are
// moved (cells and all, so they keep working) into a table of their own that
// stands next to the scrolling one - there is no position: sticky and no script
// that follows the scrolling. The rows of the two tables are kept the same
// height. Nothing is done when the table fits (nothing scrolls).
function stickLeadingColumns(table, widths){
  const rows = [...table.rows];
  const pinnedByRow = rows.map(() => []);
  const taken = []; // columns still covered by a tall cell from a row above
  rows.forEach((tr, rowIndex) => {
    let column = 0;
    const next = [];
    taken.forEach((n, c) => { if (n > 1) next[c] = n - 1; });
    for (let i = 0; i < tr.cells.length; i++){
      while (taken[column] > 0) column++;
      if (column >= widths.length) break;
      const cell = tr.cells[i];
      const span = cell.colSpan || 1;
      if ((cell.rowSpan || 1) > 1) for (let c = column; c < column + span; c++) next[c] = cell.rowSpan - 1;
      if (column + span > widths.length) break; // reaches past the fixed columns
      cell.classList.add('sticky-col');
      if (column + span === widths.length) cell.classList.add('sticky-col-last');
      pinnedByRow[rowIndex].push(cell);
      column += span;
    }
    taken.length = 0;
    next.forEach((n, c) => { taken[c] = n; });
  });
  // (The table can still be on its way into the page.)
  const run = () => {
    const scroller = table.closest('.table-scroll');
    if (!scroller || !table.isConnected) return false;
    splitPinnedColumns(table, scroller, widths, rows, pinnedByRow);
    return true;
  };
  if (!run()) requestAnimationFrame(() => { if (!run()) setTimeout(run, 100); });
}

function splitPinnedColumns(table, scroller, widths, rows, pinnedByRow){
  if (table._pinned || table.dataset.noPin || new URLSearchParams(location.search).get('sendpdf')) return;
  if (scroller.scrollWidth <= scroller.clientWidth + 1) return; // it all fits
  const pinnedWidth = widths.reduce((a, w) => a + w, 0);
  const pinTable = document.createElement('table');
  pinTable.className = table.className + ' pin-table';
  pinTable.style.tableLayout = 'fixed';
  pinTable.style.width = pinnedWidth + 'px';
  for (let i = 0; i < table.style.length; i++){ // (the archive's text size is a custom property)
    const name = table.style[i];
    if (name.startsWith('--')) pinTable.style.setProperty(name, table.style.getPropertyValue(name));
  }
  const colgroup = document.createElement('colgroup');
  widths.forEach(w => {
    const col = document.createElement('col');
    col.style.width = w + 'px';
    colgroup.appendChild(col);
  });
  pinTable.appendChild(colgroup);
  const sections = new Map();
  const pinRows = rows.map((tr, i) => {
    let section = sections.get(tr.parentNode);
    if (!section){
      section = document.createElement(tr.parentNode.tagName.toLowerCase());
      sections.set(tr.parentNode, section);
      pinTable.appendChild(section);
    }
    const ptr = document.createElement('tr');
    ptr.className = tr.className;
    Object.assign(ptr.dataset, tr.dataset);
    pinnedByRow[i].forEach(cell => ptr.appendChild(cell));
    section.appendChild(ptr);
    return ptr;
  });
  // The scrolling table no longer has those columns.
  const own = table.querySelector('colgroup');
  if (own) for (let i = 0; i < widths.length && own.firstElementChild; i++) own.removeChild(own.firstElementChild);
  const w = table.style.width;
  const px = /^([\d.]+)px$/.exec(w);
  const maxed = /^max\(100%,\s*([\d.]+)px\)$/.exec(w);
  if (px) table.style.width = Math.max(0, parseFloat(px[1]) - pinnedWidth) + 'px';
  else if (maxed) table.style.width = 'max(100%, ' + Math.max(0, parseFloat(maxed[1]) - pinnedWidth) + 'px)';
  const split = document.createElement('div');
  split.className = 'pin-split';
  scroller.parentNode.insertBefore(split, scroller);
  split.appendChild(pinTable);
  split.appendChild(scroller);
  table._pinned = pinTable;
  // The two tables' rows are always the same height.
  let queued = false;
  const sync = () => {
    queued = false;
    rows.forEach((tr, i) => {
      const a = tr.getBoundingClientRect().height, b = pinRows[i].getBoundingClientRect().height;
      const h = Math.max(a, b);
      if (Math.abs(a - h) > 0.4) tr.style.height = h + 'px';
      if (Math.abs(b - h) > 0.4) pinRows[i].style.height = h + 'px';
    });
  };
  sync();
  if (window.ResizeObserver){
    const observer = new ResizeObserver(() => { if (!queued){ queued = true; requestAnimationFrame(sync); } });
    observer.observe(table);
    observer.observe(pinTable);
  }
}

function fitNamesColumnWidth(th, names){
  const cs = getComputedStyle(th);
  const tdCs = (() => {
    const table = th.closest('table');
    const sampleTd = table && table.querySelector('tbody td:first-child');
    return sampleTd ? getComputedStyle(sampleTd) : cs;
  })();
  const span = document.createElement('span');
  span.style.position = 'fixed';
  span.style.top = '-9999px';
  span.style.whiteSpace = 'nowrap';
  span.style.fontFamily = tdCs.fontFamily;
  span.style.fontWeight = tdCs.fontWeight;
  span.style.fontSize = tdCs.fontSize;
  document.body.appendChild(span);
  let maxWidth = 0;
  [th.textContent, ...names].forEach(text => {
    span.textContent = text;
    maxWidth = Math.max(maxWidth, span.getBoundingClientRect().width);
  });
  span.remove();
  const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  th.style.width = Math.ceil(maxWidth + padding + border + 4) + 'px';
}

// ---- מתיבתא ז1 ----
// A page of its own (index.html?view=z1, no menu - nothing leads from it to
// the rest of the site): the הנוסע המתמיד table with only the Metivta
// column, for the students of class ז1. Its data is z1Students in each
// archiveWeeks document, written at every day change (computeDailyResetUpdate)
// and kept in step when an archived Metivta mark is corrected.
const Z1_PICKER_MODES = {};
let z1SelectedWeekKey = null;
let z1Sort = null; // null | 'name' | 'value'

function z1KeyName(key){
  const [group, id] = key.split('-');
  return metivtaFullName(parseInt(id, 10), group === 'extra');
}

function z1DayValue(day){
  return day ? Math.max(0, day.metivtaVal || 0) : 0;
}

// Past Sunday-Thursday school days (no Metivta on Friday) on which nobody
// in ז1 has a Metivta mark.
function z1MissingDayNames(entry){
  const weekStartD = new Date(entry.weekStart);
  const today = todayStr();
  const missing = [];
  for (let i = 0; i < 5; i++){
    const d = new Date(weekStartD);
    d.setDate(d.getDate() + i);
    const k = dayKeyOf(d.toISOString());
    if (k >= today) break;
    if (!entry.z1Students.some(r => r.days && r.days[k] && r.days[k].metivtaVal >= 0)) missing.push(HEBREW_WEEKDAY_NAMES[i]);
  }
  return missing;
}

function renderZ1View(){
  keepScroll(() => renderZ1ViewNow());
}

function renderZ1ViewNow(){
  const el = document.getElementById('z1View');
  el.innerHTML = '';
  const weeks = getDisplayArchive().filter(e => e.type === 'weekly' && Array.isArray(e.z1Students) && e.z1Students.length);
  const header = document.createElement('div');
  header.className = 'archive-entry';
  if (weeks.length === 0){
    const empty = document.createElement('div');
    empty.className = 'archive-date';
    empty.textContent = 'הנוסע המתמיד ז1 · אין עדיין נתונים';
    header.appendChild(empty);
    el.appendChild(header);
    return;
  }
  if (!z1SelectedWeekKey || !weeks.find(w => w.weekKey === z1SelectedWeekKey)) z1SelectedWeekKey = weeks[0].weekKey;
  const entry = weeks.find(w => w.weekKey === z1SelectedWeekKey);
  const mode = Z1_PICKER_MODES[entry.weekKey] || 'total';

  const dateEl = document.createElement('div');
  dateEl.className = 'archive-date weekly-header-row weekly-header-row-nowrap';
  const group = document.createElement('div');
  group.className = 'header-group';
  const title = document.createElement('span');
  title.textContent = 'הנוסע המתמיד ז1';
  group.appendChild(title);
  const sep = document.createElement('span');
  sep.textContent = '·';
  group.appendChild(sep);
  group.appendChild(buildWeekDaySelectDropdown(weeks, entry, {
    modes: Z1_PICKER_MODES,
    select: (weekKey, m) => { z1SelectedWeekKey = weekKey; Z1_PICKER_MODES[weekKey] = m; renderZ1View(); }
  }));
  const missing = z1MissingDayNames(entry);
  if (missing.length){
    const sep2 = document.createElement('span');
    sep2.textContent = '·';
    group.appendChild(sep2);
    const m = document.createElement('span');
    m.className = 'missing-days';
    m.textContent = 'חסר: ' + missing.join(', ');
    group.appendChild(m);
  }
  dateEl.appendChild(group);
  header.appendChild(dateEl);

  const valueOf = (r) => mode === 'total'
    ? Object.values(r.days || {}).reduce((sum, d) => sum + z1DayValue(d), 0)
    : z1DayValue((r.days || {})[mode]);
  let rows = entry.z1Students.slice();
  if (z1Sort === 'value') rows.sort((a, b) => valueOf(b) - valueOf(a));
  if (z1Sort === 'name') rows.sort((a, b) => z1KeyName(a.key).localeCompare(z1KeyName(b.key), 'he'));

  const table = document.createElement('table');
  table.className = 'archive-table z1-table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  [['שם', 'name'], ['מתיבתא', 'value']].forEach(([label, key]) => {
    const th = document.createElement('th');
    th.style.cursor = 'pointer';
    th.textContent = label + (z1Sort === key ? ' ▼' : '');
    th.addEventListener('click', () => { z1Sort = key; renderZ1View(); });
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = z1KeyName(r.key);
    tr.appendChild(nameTd);
    const valTd = document.createElement('td');
    valTd.textContent = valueOf(r) || '';
    tr.appendChild(valTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  header.appendChild(scrollWrap);
  el.appendChild(header);
}

function showZ1(){
  ['boards', 'todaySummary', 'frequentArchiveView', 'metivtaView'].forEach(id => { document.getElementById(id).style.display = 'none'; });
  document.getElementById('z1View').style.display = 'block';
  renderZ1View();
}

function fitTextSpan(td, text){
  const span = document.createElement('span');
  span.className = 'ff-fit';
  span.textContent = text;
  td.appendChild(span);
  return span;
}

// One font size per group (headers / names / values): the largest size, up to
// maxSize, at which every span of the group still fits inside its own cell.
// A header allowed to wrap fills its cell's width; it only "doesn't fit" when
// one of its words is wider than the cell (scrollWidth > offsetWidth).
function fitSpanGroupToCells(spans, minSize, maxSize, slack){
  if (spans.length === 0) return;
  const avail = spans.map(span => {
    const cell = span.parentElement;
    const cs = getComputedStyle(cell);
    return cell.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - (slack || 0);
  });
  const fits = (size) => {
    spans.forEach(sp => { sp.style.fontSize = size + 'px'; });
    return spans.every((sp, i) => sp.offsetWidth <= avail[i] && sp.scrollWidth <= avail[i]);
  };
  let lo = minSize, hi = maxSize;
  if (fits(hi)) return;
  while (hi - lo > 0.5){
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  fits(Math.floor(lo * 2) / 2);
}

// From this width the table spans the whole page and its text fills the cells.
const FREQUENT_WIDE_MIN_WIDTH = 900;
// Computers and tablets: the table is exactly as tall as the screen.
const FILL_SCREEN_MIN_WIDTH = 760;

// While a table is drawn for the PDF (a page of A4), the "screen" is shaped like
// the page: its height is set here, and the smallest size of the letters of the
// missing days is 7 points *on the paper* (so more pixels when the table is
// shrunk to fit the page).
const PRINT = { on: false, minLetterPx: 7, viewportHeight: 0 };
function layoutViewportHeight(){
  return PRINT.on && PRINT.viewportHeight ? PRINT.viewportHeight : window.innerHeight;
}

function renderWeeklyEntryInto(entry, container, allWeeklyEntries, opts){
  opts = opts || {};
  // A week is shown as the detailed report - there is no weekly summary page
  // and no table by day. opts.showAllColumns (the off-screen probe that
  // measures the column widths) shows the weekly columns of the current week too.
  const entryWrap = document.createElement('div');
  entryWrap.className = 'archive-entry';

  // The blue bar: the week picker and the days still missing.
  const dateEl = document.createElement('div');
  dateEl.className = 'archive-date weekly-header-row weekly-header-row-nowrap';
  const titleColumn = document.createElement('div');
  titleColumn.className = 'ff-title-col';
  const headerGroup = document.createElement('div');
  headerGroup.className = 'header-group';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = 'הנוסע המתמיד';
  headerGroup.appendChild(titleSpan);
  const sep1 = document.createElement('span');
  sep1.textContent = '·';
  headerGroup.appendChild(sep1);
  headerGroup.appendChild(buildWeekDaySelectDropdown(allWeeklyEntries || [entry], entry));
  // On the same line, after a dot: the days still missing, as letters (א, ב, ג).
  const missingDays = weekMissingDays(entry);
  if (missingDays.length){
    const sep2 = document.createElement('span');
    sep2.textContent = '·';
    headerGroup.appendChild(sep2);
    const missingEl = document.createElement('span');
    missingEl.className = 'missing-days';
    // "חסר: א (תפילה, רמב"ם), ב (הכל)" - after each day, in brackets, the columns
    // that are missing that day.
    missingEl.textContent = 'חסר: ' + missingDays.map(m => (WEEKDAY_LETTERS[HEBREW_WEEKDAY_NAMES.indexOf(m.name)] || m.name) + ' (' + (m.everything ? 'הכל' : m.columns.join(', ')) + ')').join(', ');
    headerGroup.appendChild(missingEl);
  }
  titleColumn.appendChild(headerGroup);
  dateEl.appendChild(titleColumn);


  entryWrap.appendChild(dateEl);

  // On a computer the table spans the whole page and its text grows to fill
  // the cells; on a narrow screen it keeps its compact, scrollable layout.
  const wide = window.innerWidth >= FREQUENT_WIDE_MIN_WIDTH;

  const table = document.createElement('table');
  table.className = 'archive-table ff-table' + (wide ? ' ff-wide' : '');
  if (opts.showAllColumns) table.dataset.noPin = '1'; // the off-screen probe
  table.style.tableLayout = 'fixed';
  table.style.width = wide ? '100%' : 'max-content';

  const isCurrentWeek = !opts.showAllColumns && entry.weekKey === getWeekKey(new Date(activityDayStr() + 'T12:00:00'));
  const fieldDefs = [
    { field: 'percent', label: '%', kind: 'percent' },
    { field: 'bonus', label: 'בונוס', kind: 'daily' },
    { field: 'morning', label: 'חסידות', kind: 'daily' },
    { field: 'tefila', label: 'תפילה', kind: 'daily' },
    { field: 'mikvaotVal', label: 'מקוואות', kind: 'daily' },
    { field: 'rambamVal', label: 'רמב"ם', kind: 'daily' },
    { field: 'metivtaVal', label: 'מתיבתא', kind: 'daily' },
    ...WEEKLY_CLASS_FIELD_DEFS,
    ...WEEKLY_PARENT_FIELD_DEFS
  ].filter(f => {
    // The current week: the columns filled in once a week are not shown yet, and
    // neither is the % (the rows are still ordered by it).
    if (isCurrentWeek && f.kind === 'percent') return false;
    return !(isCurrentWeek && (WEEKLY_CLASS_FIELD_DEFS.some(w => w.field === f.field) || WEEKLY_PARENT_FIELD_DEFS.some(w => w.field === f.field)));
  });
  const isParentField = (field) => WEEKLY_PARENT_FIELD_DEFS.some(f => f.field === field);
  const firstParentField = WEEKLY_PARENT_FIELD_DEFS[0].field;

  // Two leading columns, as in the Metivta table: משפחה, פרטי.
  const LEAD = 2;
  const colgroup = document.createElement('colgroup');
  const cols = [];
  for (let i = 0; i < LEAD + fieldDefs.length; i++){
    const col = document.createElement('col');
    if (wide) col.style.width = i < LEAD ? '7%' : (86 / fieldDefs.length) + '%';
    cols.push(col);
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  let currentSortField = weeklyArchiveSortField[entry.weekKey] || 'percent';
  // A column that is not shown in this view cannot be the sort column.
  if (!fieldDefs.some(f => f.field === currentSortField)) currentSortField = 'percent';
  const viewMode = 'detail';
  const isDetail = true;

  const thead = document.createElement('thead');
  // Who is in charge of each group of columns: a thin row on top of the
  // column names, each name centered over all of its columns (so the lines
  // between columns stop there and continue below).
  const groupRow = document.createElement('tr');
  const groupOf = (field) => isParentField(field) ? 'עדכוני הורים'
    : field === 'bonus' ? ''
    : field === 'rambamVal' ? 'שמעון'
    : field === 'metivtaVal' ? 'חננאל'
    : (WEEKLY_CLASS_FIELD_DEFS.find(f => f.field === field) || { group: 'תורנים' }).group;
  let lastGroupTh = null;
  fieldDefs.forEach(({ field }) => {
    if (field === 'percent') return;
    const name = groupOf(field);
    if (lastGroupTh && lastGroupTh.textContent === name){ lastGroupTh.colSpan++; return; }
    lastGroupTh = document.createElement('th');
    lastGroupTh.className = 'ff-parent-group-th';
    lastGroupTh.colSpan = 1;
    lastGroupTh.textContent = name;
    groupRow.appendChild(lastGroupTh);
  });
  thead.appendChild(groupRow);

  const trh = document.createElement('tr');
  const headerSpans = [];
  // The name and the % cells span both header rows, their text in the
  // middle of the height.
  const familyTh = document.createElement('th');
  familyTh.rowSpan = 2;
  familyTh.className = 'ff-tall-th';
  headerSpans.push(fitTextSpan(familyTh, 'משפחה'));
  groupRow.insertBefore(familyTh, groupRow.firstChild);
  const firstNameTh = document.createElement('th');
  firstNameTh.rowSpan = 2;
  firstNameTh.className = 'ff-tall-th';
  headerSpans.push(fitTextSpan(firstNameTh, 'פרטי'));
  groupRow.insertBefore(firstNameTh, groupRow.children[1]);
  const headerCells = [familyTh, firstNameTh];
  fieldDefs.forEach(({ field, label }) => {
    const th = document.createElement('th');
    th.style.cursor = 'pointer';
    if (field === 'percent'){
      th.rowSpan = 2;
      th.className = 'ff-tall-th';
      groupRow.insertBefore(th, groupRow.children[LEAD]);
    }
    headerCells.push(th);
    if (field === firstParentField) th.classList.add('ff-parent-first');
    // The whole header on one line (the parents' columns are made wide enough).
    th.dataset.fitLabel = label.replace(/ /g, '\u00a0');
    headerSpans.push(fitTextSpan(th, label + (currentSortField === field ? ' ▼' : '')));
    th.addEventListener('click', () => {
      weeklyArchiveSortField[entry.weekKey] = field;
      weeklySortOrder = null;
      renderFrequentFlyerView();
    });
    if (field !== 'percent') trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const pctTh = fieldDefs[0].kind === 'percent' ? headerCells[LEAD] : null; // none in the current week

  const tbody = document.createElement('tbody');
  const seenIds = new Set();
  let uniqueStudents = (entry.students || []).filter(s => {
    if (seenIds.has(s.id)) return false;
    seenIds.add(s.id);
    return true;
  });

  const defOf = (field) => fieldDefs.find(f => f.field === field) || {};
  const getFieldVal = (s, field, kind) => {
    if (kind === 'percent') return weeklyPercent(s);
    if (kind === 'weekly-number' || kind === 'weekly-bool') return weeklyFieldPoints(s, defOf(field));
    // The points the student collected in the week.
    return weeklyDailySum(s, field);
  };
  const kindOf = (field) => field === 'percent' ? 'percent' : (fieldDefs.find(f => f.field === field) || {}).kind;

  if (currentSortField){
    const sortSig = entry.weekKey + '|' + viewMode + '|' + currentSortField + '|' + uniqueStudents.length;
    if (!weeklySortOrder || weeklySortOrder.sig !== sortSig){
      weeklySortOrder = {
        sig: sortSig,
        ids: uniqueStudents.slice().sort((a, b) => getFieldVal(b, currentSortField, kindOf(currentSortField)) - getFieldVal(a, currentSortField, kindOf(currentSortField))).map(st => st.id)
      };
    }
    const rank = new Map(weeklySortOrder.ids.map((id, i) => [id, i]));
    uniqueStudents = uniqueStudents.slice().sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  }
  const familySpans = [];
  const firstSpans = [];
  const valueSpans = [];
  const pctSpans = []; // the % column has its own size (its text is longer)
  const detailSpans = []; // the detailed report: the number with the missing days beside it
  uniqueStudents.forEach(s => {
    const tr = document.createElement('tr');
    tr.dataset.studentId = s.id;
    const familyTd = document.createElement('td');
    familySpans.push(fitTextSpan(familyTd, metivtaFamilyName(s.id, false)));
    tr.appendChild(familyTd);
    const firstTd = document.createElement('td');
    firstSpans.push(fitTextSpan(firstTd, metivtaFirstName(s.id, false)));
    tr.appendChild(firstTd);

    fieldDefs.forEach(({ field, kind }) => {
      const td = document.createElement('td');
      if (field === firstParentField) td.classList.add('ff-parent-first');
      const val = getFieldVal(s, field, kind);
      if (kind === 'percent'){
        // The week's score, whichever day is shown.
        pctSpans.push(fitTextSpan(td, val + '%'));
        td.className = 'ff-percent';
        td.title = 'מתוך ' + WEEKLY_FULL_POINTS + ' נקודות בשבוע';
      } else if (kind === 'weekly-bool'){
        const ratio = defOf(field).ratio || 1;
        valueSpans.push(fitTextSpan(td, s[field] ? (ratio > 1 ? String(ratio) : '✓') : ''));
        td.style.cursor = 'pointer';
        td.addEventListener('click', () => {
          requireArchiveEditAccess(() => {
            commitOp({ kind: 'weekCell', weekKey: entry.weekKey, sid: s.id, field, target: null, value: !s[field] });
          });
        });
      } else if (kind === 'weekly-number'){
        // Points, picked from the column's list (parents' days times ratio).
        const def = defOf(field);
        const ratio = def.ratio || 1;
        const step = def.step || ratio;
        const max = def.max || 7 * ratio;
        const values = [];
        for (let v = 0; v <= max; v += step) values.push(v);
        valueSpans.push(fitTextSpan(td, val || ''));
        td.style.cursor = 'pointer';
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          requireArchiveEditAccess(() => {
            if (values.length === 2){
              // Only 0 or one value (מבצעים: 6): a click puts it, another click clears it.
              commitOp({ kind: 'weekCell', weekKey: entry.weekKey, sid: s.id, field, target: null, value: (val > 0 ? 0 : values[1]) / ratio });
              return;
            }
            showWeeklyValuePicker(td, values, val, (points) => {
              commitOp({ kind: 'weekCell', weekKey: entry.weekKey, sid: s.id, field, target: null, value: points / ratio });
            });
          });
        });
      } else if (isDetail){
        // On the right, big: the points collected in the week. On its left,
        // small and in two lines: the days it was not received.
        td.classList.add('ff-daily-detail');
        const cell = fitTextSpan(td, '');
        cell.classList.add('ff-dwrap');
        const numEl = document.createElement('span');
        numEl.textContent = String(val);
        cell.appendChild(numEl);
        const letters = weeklyMissingDayLetters(entry, s, field);
        if (letters){
          const list = letters.split(', ');
          const firstLine = Math.ceil(list.length / 2);
          const lettersEl = document.createElement('span');
          lettersEl.className = 'ff-dletters';
          [list.slice(0, firstLine), list.slice(firstLine)].forEach((part, idx) => {
            if (!part.length) return;
            const line = document.createElement('div');
            line.textContent = part.join(', ') + (idx === 0 && list.length > firstLine ? ',' : '');
            lettersEl.appendChild(line);
          });
          cell.appendChild(lettersEl);
        }
        detailSpans.push(cell);
        // A click opens the days of this column that are not updated yet (and
        // below them the updated ones, to cancel).
        td.style.cursor = 'pointer';
        td.title = 'לחיצה: עדכון או ביטול של ימים';
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          requireArchiveEditAccess(() => showDayUpdatePicker(td, entry, s, field));
        });
      } else {
        valueSpans.push(fitTextSpan(td, val || ''));
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  entryWrap.appendChild(scrollWrap);
  container.appendChild(entryWrap);

  if (!table.isConnected || container.clientWidth === 0) return;
  const rowCount = Math.max(tbody.rows.length, 1);
  const fillRowHeight = () => Math.max(0, Math.floor((layoutViewportHeight() - (entryWrap.offsetHeight - tbody.offsetHeight)) / rowCount * 10) / 10);
  if (wide){
    const isParentSpan = (i) => i >= LEAD && isParentField(fieldDefs[i - LEAD].field);
    // Headers: one size for all (small - the header row is kept low). The
    // parents' headers are whole labels on one line, so their columns are
    // widened below to fit them instead of shrinking the text.
    const plainHeaderSpans = headerSpans.filter((sp, i) => !isParentSpan(i));
    fitSpanGroupToCells(plainHeaderSpans, 12, 16);
    const headerSize = plainHeaderSpans[0].style.fontSize;
    headerSpans.forEach(sp => { sp.style.fontSize = headerSize; });
    const nameSpans = [...familySpans, ...firstSpans];
    // The rows share the screen's height with the bar and the header; the
    // text may be as tall as a row allows (a row = 8px padding + 1.25 lines).
    const heightFont = Math.max(12, Math.floor((fillRowHeight() - 8) / 1.25));
    fitSpanGroupToCells(nameSpans, 12, heightFont, 6);
    fitSpanGroupToCells(valueSpans, 12, heightFont);
    fitSpanGroupToCells(pctSpans, 10, heightFont);
    // The small letters of the missing days are never under 7px (their size
    // is 0.45 of the number's): the number is at least 16px, and a daily column
    // that is too narrow for that is widened - the table is then wider than the
    // screen and scrolls sideways.
    const minDetailFont = Math.max(16, Math.ceil(PRINT.minLetterPx / 0.45));
    const dailyIdx = fieldDefs.map((f, i) => f.kind === 'daily' ? LEAD + i : -1).filter(i => i >= 0);
    const widenDaily = () => {
      if (!detailSpans.length) return;
      fitSpanGroupToCells(detailSpans, minDetailFont, Math.max(minDetailFont, heightFont));
      const need = Math.ceil(Math.max(...detailSpans.map(sp => sp.offsetWidth)) + 20);
      const widths = cols.map(c => c.getBoundingClientRect().width);
      let widened = false;
      dailyIdx.forEach(i => { if (widths[i] < need){ widths[i] = need; widened = true; } });
      if (!widened) return;
      cols.forEach((c, i) => { c.style.width = Math.round(widths[i] * 100) / 100 + 'px'; });
      const total = widths.reduce((a, b) => a + b, 0);
      if (total > table.parentElement.clientWidth) table.style.width = total + 'px';
      fitSpanGroupToCells(detailSpans, minDetailFont, Math.max(minDetailFont, heightFont));
    };
    fitSpanGroupToCells(detailSpans, minDetailFont, Math.max(minDetailFont, heightFont));
    // Settles the rows to exactly the screen's height (the text is made a bit
    // smaller if the header ended up taller than expected).
    const fillScreenHeight = () => {
      for (let i = 0; i < 8; i++){
        const rh = fillRowHeight();
        [...tbody.rows].forEach(tr => { tr.style.height = rh + 'px'; });
        if (entryWrap.offsetHeight <= layoutViewportHeight() + 1) break;
        [...valueSpans, ...pctSpans, ...detailSpans, ...nameSpans].forEach(sp => { sp.style.fontSize = Math.max(10, (parseFloat(sp.style.fontSize) || 12) - 1) + 'px'; });
        [...tbody.rows].forEach(tr => { tr.style.height = ''; });
      }
    };
    // Names no larger than the numbers; each name column is then narrowed to
    // its longest name.
    const valueFont = parseFloat(valueSpans.length ? valueSpans[0].style.fontSize : '') || 40;
    if ((parseFloat(nameSpans.length ? nameSpans[0].style.fontSize : '') || 0) > valueFont){
      nameSpans.forEach(sp => { sp.style.fontSize = valueFont + 'px'; });
    }
    const nameCs = getComputedStyle(familyTh);
    const namePad = (parseFloat(nameCs.paddingLeft) || 0) + (parseFloat(nameCs.paddingRight) || 0) + 24;
    const columnWidth = (spans, headerSpan) => Math.ceil(Math.max(headerSpan.offsetWidth, ...spans.map(sp => sp.offsetWidth)) + namePad);
    const familyW = columnWidth(familySpans, headerSpans[0]);
    const firstW = columnWidth(firstSpans, headerSpans[1]);
    const nameW = familyW + firstW;
    // The current week has fewer columns: its columns are no wider than they
    // are in the other weeks (it does not stretch over the whole screen).
    const sameAs = isCurrentWeek ? weekSummaryColumnWidths(entry, allWeeklyEntries, container) : null;
    if (sameAs){
      fieldDefs.forEach((f, i) => { if (sameAs[f.field]) cols[LEAD + i].style.width = sameAs[f.field] + 'px'; });
      cols[0].style.width = sameAs.L0 + 'px';
      cols[1].style.width = sameAs.L1 + 'px';
      table.style.width = (sameAs.L0 + sameAs.L1 + fieldDefs.reduce((t, f) => t + (sameAs[f.field] || 0), 0)) + 'px';
      fitSpanGroupToCells(headerSpans.slice(LEAD), PRINT.on ? Math.ceil(PRINT.minLetterPx) : 9, 16);
      fitSpanGroupToCells(valueSpans, 12, heightFont);
      fitSpanGroupToCells(pctSpans, 10, heightFont);
      widenDaily();
      fillScreenHeight();
      stickLeadingColumns(table, pctTh ? [sameAs.L0, sameAs.L1, sameAs.percent || pctTh.offsetWidth] : [sameAs.L0, sameAs.L1]);
      return;
    }
    cols[0].style.width = familyW + 'px';
    cols[1].style.width = firstW + 'px';
    // The parents' columns: wide enough for the whole header; the others
    // share the rest equally.
    const tableW = table.clientWidth;
    const equalShare = (tableW - nameW) / fieldDefs.length;
    let parentsW = 0, parentCount = 0;
    headerSpans.forEach((sp, i) => {
      if (!isParentSpan(i)) return;
      const th = sp.parentElement;
      const cs = getComputedStyle(th);
      const need = Math.ceil(sp.offsetWidth + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 8);
      // (The detailed report gives the room to the daily columns instead.)
      const width = isDetail ? need : Math.max(need, equalShare);
      cols[i].style.width = width + 'px';
      parentsW += width;
      parentCount++;
    });
    // The detailed report: the daily columns (with the missing days under the
    // number) get more of the room than the others.
    const others = fieldDefs.length - parentCount;
    const weightOf = (i) => isDetail ? ({ daily: 1.7, percent: 1.3 }[fieldDefs[i - LEAD].kind] || 1.2) : 1;
    let weightSum = 0;
    headerSpans.forEach((sp, i) => { if (i >= LEAD && !isParentSpan(i)) weightSum += weightOf(i); });
    headerSpans.forEach((sp, i) => {
      if (i >= LEAD && !isParentSpan(i)) cols[i].style.width = isDetail
        ? Math.floor((tableW - nameW - parentsW) * weightOf(i) / weightSum) + 'px'
        : 'calc((100% - ' + (nameW + parentsW) + 'px) / ' + others + ')';
    });
    fitSpanGroupToCells(headerSpans.slice(LEAD), PRINT.on ? Math.ceil(PRINT.minLetterPx) : 9, 16);
    fitSpanGroupToCells(valueSpans, 12, heightFont);
    fitSpanGroupToCells(pctSpans, 10, heightFont);
    widenDaily();
    fillScreenHeight();
    stickLeadingColumns(table, pctTh ? [familyW, firstW, pctTh.offsetWidth] : [familyW, firstW]);
    if (opts.onWidths){
      const w = { L0: cols[0].getBoundingClientRect().width, L1: cols[1].getBoundingClientRect().width };
      fieldDefs.forEach((f, i) => { w[f.field] = cols[LEAD + i].getBoundingClientRect().width; });
      opts.onWidths(w);
    }
  } else {
    // Compact layout: each column as narrow as its widest header word (the
    // name column as wide as the longest name), applied through the
    // colgroup since the group-label row above spans several columns.
    headerCells.forEach(th => { if (th.dataset.fitLabel) fitHeaderCellToWidestWord(th); });
    familyTh.dataset.fitNamesCol = '1';
    firstNameTh.dataset.fitNamesCol = '1';
    fitNamesColumnWidth(familyTh, uniqueStudents.map(s => metivtaFamilyName(s.id, false)));
    fitNamesColumnWidth(firstNameTh, uniqueStudents.map(s => metivtaFirstName(s.id, false)));
    headerCells.forEach((th, i) => { if (cols[i]) cols[i].style.width = th.style.width; });
    // A tablet: rows as tall as the screen allows, with larger text.
    if (window.innerWidth >= FILL_SCREEN_MIN_WIDTH){
      const font = Math.min(24, Math.max(13, Math.floor((fillRowHeight() - 8) / 1.25)));
      [...tbody.querySelectorAll('td')].forEach(td => { td.style.fontSize = font + 'px'; td.style.lineHeight = '1.25'; });
      fitNamesColumnWidth(familyTh, uniqueStudents.map(s => metivtaFamilyName(s.id, false)));
      fitNamesColumnWidth(firstNameTh, uniqueStudents.map(s => metivtaFirstName(s.id, false)));
      cols[0].style.width = familyTh.style.width;
      cols[1].style.width = firstNameTh.style.width;
      for (let i = 0; i < 6; i++){
        [...tbody.rows].forEach(tr => { tr.style.height = ''; });
        const rh = fillRowHeight();
        [...tbody.rows].forEach(tr => { tr.style.height = rh + 'px'; });
        if (entryWrap.offsetHeight <= window.innerHeight) break;
      }
    }
    // The missing days under 7px are not readable: a daily column that is too
    // narrow for them is widened.
    if (detailSpans.length){
      detailSpans.forEach(sp => { sp.style.fontSize = ''; });
      const need = Math.ceil(Math.max(...detailSpans.map(sp => sp.offsetWidth)) + 20);
      fieldDefs.forEach((f, i) => {
        if (f.kind !== 'daily') return;
        const col = cols[LEAD + i];
        if ((parseFloat(col.style.width) || 0) < need){
          col.style.width = need + 'px';
          if (headerCells[LEAD + i]) headerCells[LEAD + i].style.width = need + 'px';
        }
      });
    }
    // On a narrow screen only the two names stay in place (the % scrolls).
    stickLeadingColumns(table, [familyTh.offsetWidth, firstNameTh.offsetWidth]);
  }
}

// The column widths of a week with all its columns (laid out off-screen), so
// the current week - which has fewer columns - can use the very same widths.
function weekSummaryColumnWidths(entry, allWeeklyEntries, container){
  const probe = document.createElement('div');
  probe.className = container.className;
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;width:' + container.getBoundingClientRect().width + 'px';
  document.body.appendChild(probe);
  let widths = null;
  try{ renderWeeklyEntryInto(entry, probe, allWeeklyEntries, { showAllColumns: true, onWidths: w => { widths = w; } }); }
  finally{ probe.remove(); }
  return widths;
}

let historyMergedActive = {};
let todayHistoryContainerEl = null;

function hebrewDayLetters(n){
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל'];
  if (n === 15) return 'טו';
  if (n === 16) return 'טז';
  const t = Math.floor(n / 10);
  const o = n % 10;
  return tens[t] + ones[o];
}

function formatHebrewDateShort(d){
  const parts = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', { day: 'numeric', month: 'short' }).formatToParts(d);
  let day = '';
  let month = '';
  parts.forEach(p => {
    if (p.type === 'day') day = p.value;
    if (p.type === 'month') month = p.value;
  });
  const dayNum = parseInt(day, 10);
  const dayLetters = isNaN(dayNum) ? day : hebrewDayLetters(dayNum);
  return dayLetters + ' ' + month;
}

function dayKeyOf(dateStr){
  const d = new Date(dateStr);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getHistoryActive(dayKey, groupType, defaultKey){
  const k = dayKey + '_' + groupType;
  if (!(k in historyMergedActive)) historyMergedActive[k] = defaultKey;
  return historyMergedActive[k];
}

function setHistoryActive(dayKey, groupType, key){
  historyMergedActive[dayKey + '_' + groupType] = key;
  if (todayHistoryContainerEl) renderTodayHistoryTable(todayHistoryContainerEl);
}

function buildHistoryDropdown(dayKey, groupType, options){
  const activeKey = getHistoryActive(dayKey, groupType, options[0].key);

  const list = document.createElement('div');
  list.className = 'merged-dropdown-list merged-dropdown-list-right';
  options.forEach(opt => {
    const optEl = document.createElement('div');
    optEl.className = 'merged-dropdown-option';
    optEl.textContent = opt.label;
    optEl.addEventListener('click', (e) => {
      e.stopPropagation();
      list.classList.remove('open');
      setHistoryActive(dayKey, groupType, opt.key);
    });
    list.appendChild(optEl);
  });

  const activeOpt = options.find(o => o.key === activeKey) || options[0];
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'merged-dropdown-toggle';
  toggle.textContent = activeOpt.label;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.merged-dropdown-list.open').forEach(l => {
      if (l !== list) l.classList.remove('open');
    });
    list.classList.toggle('open');
  });

  const dropdown = document.createElement('div');
  dropdown.className = 'merged-dropdown';
  dropdown.appendChild(toggle);
  dropdown.appendChild(list);
  return dropdown;
}

let todayArchiveSortIndex = null;
let todayArchiveSortOrder = null;

// מקוואות/רמב"ם of an archived day live in its week document (they are
// checkmarks counted per day, not class points).
const ARCHIVE_WEEKLY_KEYS = { mikvaot: 'mikvaotVal', rambam: 'rambamVal' };

function archivedWeeklyDayValue(entry, studentId, field){
  const day = dayKeyOf(entry.date);
  const weekKey = getWeekKey(new Date(day + 'T12:00:00'));
  const week = (state.archive || []).find(e => e.type === 'weekly' && e.weekKey === weekKey);
  const rec = week && (week.students || []).find(x => x.id === studentId);
  return (rec && rec.days && rec.days[day] && rec.days[day][field]) || 0;
}

function dayHasClassData(entry){
  return (entry.students || []).some(s => CATEGORIES.some(c => (s.cats || {})[c.key]) || s.purchases || s.minusTotal);
}

function getTodayArchiveValue(entry, studentId, activeKey){
  if (ARCHIVE_WEEKLY_KEYS[activeKey]) return archivedWeeklyDayValue(entry, studentId, ARCHIVE_WEEKLY_KEYS[activeKey]);
  const s = entry.students.find(x => x.id === studentId);
  const cats = (s && s.cats) || {};
  if (activeKey === 'total') return CATEGORIES.reduce((sum, c) => sum + (cats[c.key] || 0), 0) + ((s && s.minusTotal) || 0);
  if (activeKey === 'shop') return -((s && s.purchases || 0) * PURCHASE_COST);
  if (activeKey === 'minus') return ((s && s.minusTotal) || 0) + (cats.c9 || 0);
  return cats[activeKey] || 0;
}

function renderTodayHistoryTable(container){
  keepScroll(() => renderTodayHistoryTableNow(container));
}

function renderTodayHistoryTableNow(container){
  todayHistoryContainerEl = container;
  container.innerHTML = '';

  const days = getDisplayArchive().filter(e => e.type !== 'weekly' && !e.isLive && !(e.metivtaAddedDay && !dayHasClassData(e)));

  const allOptions = [
    { key: 'total', label: 'סה"כ' },
    ...MERGE_GROUPS[1].filter(k => !isFrequentToggleKey(k)).map(k => ({ key: k, label: categoryLabel(k) })),
    { key: 'mikvaot', label: 'מקוואות' },
    { key: 'rambam', label: 'רמב"ם' },
    ...MERGE_GROUPS[0].map(k => ({ key: k, label: categoryLabel(k) })),
    { key: 'minus', label: '-' },
    { key: 'shop', label: '🛒' }
  ];
  const groupType = 'combined';

  const wrap = document.createElement('div');
  wrap.className = 'archive-entry';

  const dateEl = document.createElement('div');
  dateEl.className = 'archive-date weekly-header-row';
  const headerGroup = document.createElement('div');
  headerGroup.className = 'header-group';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = 'ארכיון';
  headerGroup.appendChild(titleSpan);

  const titleSep = document.createElement('span');
  titleSep.textContent = '·';
  headerGroup.appendChild(titleSep);

  headerGroup.appendChild(buildHistoryDropdown('archive_shared', groupType, allOptions));
  dateEl.appendChild(headerGroup);

  wrap.appendChild(dateEl);

  const table = document.createElement('table');
  table.className = 'archive-table arch-table';
  // Each column is exactly as wide as its date needs, on one line.
  table.style.tableLayout = 'auto';
  table.style.width = 'max-content';

  const weekOf = (entry) => getWeekKey(new Date(dayKeyOf(entry.date) + 'T12:00:00'));
  // A thick line after the last day of each week (the next column is the
  // week before it).
  const endsWeek = (dayIndex) => dayIndex + 1 < days.length && weekOf(days[dayIndex]) !== weekOf(days[dayIndex + 1]);

  const thead = document.createElement('thead');

  const trDate = document.createElement('tr');
  const nameTh = document.createElement('th');
  nameTh.textContent = 'שם';
  trDate.appendChild(nameTh);
  days.forEach((entry, dayIndex) => {
    const th = document.createElement('th');
    th.style.cursor = 'pointer';
    th.style.whiteSpace = 'nowrap';
    th.style.lineHeight = '1.2';
    if (endsWeek(dayIndex)) th.classList.add('week-end');
    const d = new Date(entry.date);
    // The weekday letter and the date on one line, split by a dot.
    const dateSpan = document.createElement('div');
    dateSpan.textContent = WEEKDAY_LETTERS[d.getDay()] + ' · ' + formatHebrewDateShort(d) + (entry.isLive ? ' (היום)' : '') + (todayArchiveSortIndex === dayIndex ? ' ▼' : '');
    th.appendChild(dateSpan);
    th.addEventListener('click', () => {
      todayArchiveSortIndex = dayIndex;
      todayArchiveSortOrder = null;
      renderTodayHistoryTable(container);
    });
    trDate.appendChild(th);
  });
  thead.appendChild(trDate);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const activeKey = getHistoryActive('archive_shared', groupType, allOptions[0].key);
  let orderedStudents = state.students.slice();
  if (todayArchiveSortIndex !== null && days[todayArchiveSortIndex]){
    // Sorted by a day's column: the order is made once and kept while cells
    // are edited, so a row does not jump to another place under the cursor.
    const sortEntry = days[todayArchiveSortIndex];
    const sortSig = dayKeyOf(sortEntry.date) + '|' + activeKey;
    if (!todayArchiveSortOrder || todayArchiveSortOrder.sig !== sortSig){
      todayArchiveSortOrder = {
        sig: sortSig,
        ids: orderedStudents.slice().sort((a, b) => getTodayArchiveValue(sortEntry, b.id, activeKey) - getTodayArchiveValue(sortEntry, a.id, activeKey)).map(st => st.id)
      };
    }
    const rank = new Map(todayArchiveSortOrder.ids.map((id, i) => [id, i]));
    orderedStudents.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }
  orderedStudents.forEach(student => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = studentName(student.id);
    tr.appendChild(nameTd);

    days.forEach((entry, dayIndex) => {
      const s = entry.students.find(x => x.id === student.id) || {};
      const cats = s.cats || {};
      const dayKey = dayKeyOf(entry.date);
      const val = getTodayArchiveValue(entry, student.id, activeKey);
      const td = document.createElement('td');
      if (endsWeek(dayIndex)) td.classList.add('week-end');
      // מקוואות/רמב"ם: a checkmark, like on today's board (worth 2 points
      // only in הנוסע המתמיד).
      td.textContent = ARCHIVE_WEEKLY_KEYS[activeKey] ? (val > 0 ? '✓' : '') : (val || '');
      if (activeKey === 'c3' && (val < 0 || (cats.c9 || 0) < 0)) td.classList.add('disturb'); // a prayer minus: red
      if (activeKey === 'total') { tr.appendChild(td); return; }
      td.style.cursor = 'pointer';
      const editCell = (field, value) => requireArchiveEditAccess(() => {
        commitOp({ kind: 'archiveCell', target: dayKey, group: 'main', sid: student.id, field, value });
      });
      // A click puts the cell's fixed value there, another click takes it
      // out. The minus and the purchases are added one at a time, with a
      // small + in the corner that takes one back (never above 0).
      let onClick;
      let undo = null;
      if (ARCHIVE_WEEKLY_KEYS[activeKey]){
        onClick = () => requireArchiveEditAccess(() => {
          commitOp({ kind: 'weekCell', src: 'archive', weekKey: weekOf(entry), sid: student.id, field: ARCHIVE_WEEKLY_KEYS[activeKey], target: dayKey, value: val > 0 ? 0 : 2 });
        });
      } else if (activeKey === 'minus'){
        onClick = () => editCell('minusTotal', (s.minusTotal || 0) - 1);
        if ((s.minusTotal || 0) < 0) undo = () => editCell('minusTotal', Math.min(0, (s.minusTotal || 0) + 1));
      } else if (activeKey === 'shop'){
        onClick = () => editCell('purchases', (s.purchases || 0) + 1);
        if ((s.purchases || 0) > 0) undo = () => editCell('purchases', s.purchases - 1);
      } else {
        onClick = () => editCell('cat:' + activeKey, nextCategoryValue(activeKey, cats[activeKey]));
      }
      td.addEventListener('click', onClick);
      if (activeKey === 'c3'){
        td.style.position = 'relative';
        td.appendChild(prayerMinusButton(cats.c9 || 0, v => editCell('cat:c9', v)));
      }
      if (undo){
        td.style.position = 'relative';
        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.className = 'status-plus-btn';
        undoBtn.textContent = '+';
        undoBtn.title = activeKey === 'minus' ? 'ביטול מינוס' : 'ביטול קניה';
        undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undo(); });
        td.appendChild(undoBtn);
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  wrap.appendChild(scrollWrap);
  container.appendChild(wrap);

  // On a computer or tablet the table is exactly as tall as the screen: the
  // rows grow and the text is as large as a row allows, as long as the day
  // columns do not become wider than their dates need.
  if (table.isConnected && window.innerWidth >= FILL_SCREEN_MIN_WIDTH){
    const dayThs = [...trDate.children].slice(1);
    const daysWidth = () => dayThs.reduce((t, th) => t + th.offsetWidth, 0);
    const baseWidth = daysWidth();
    const rowCount = Math.max(tbody.rows.length, 1);
    const fillRowHeight = () => Math.max(0, Math.floor((window.innerHeight - (wrap.offsetHeight - tbody.offsetHeight)) / rowCount * 10) / 10);
    let font = Math.min(36, Math.max(13, Math.floor((fillRowHeight() - 8) / 1.25)));
    for (; font > 13; font--){
      table.style.setProperty('--arch-font', font + 'px');
      if (daysWidth() <= baseWidth + 2) break;
    }
    // Rows exactly as tall as what is left of the screen (a scrollbar that
    // appears under the table takes its share, so this is repeated).
    for (let i = 0; i < 8; i++){
      table.style.setProperty('--arch-font', font + 'px');
      [...tbody.rows].forEach(tr => { tr.style.height = ''; });
      const rh = fillRowHeight();
      [...tbody.rows].forEach(tr => { tr.style.height = rh + 'px'; });
      if (wrap.offsetHeight <= window.innerHeight || font <= 13) break;
      font--;
    }
  }
  // The name column stays in place while the days scroll under it.
  if (table.isConnected) stickLeadingColumns(table, [nameTh.offsetWidth]);
}

function buildToolbar(){
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const status = document.createElement('div');
  status.className = 'status';
  status.id = 'statusEl';
  toolbar.appendChild(status);

  return toolbar;
}

function computeSortScore(student){
  const attendanceSum = MERGE_GROUPS[0].reduce((sum, k) => sum + (student.cats[k] || 0), 0);
  const plusGroupSum = MERGE_GROUPS[1].reduce((sum, k) => sum + (student.cats[k] || 0), 0);
  const plusPersistent = student.c5Total || 0;
  const minusOnly = student.minusTotal || 0;
  return attendanceSum + plusGroupSum + plusPersistent + minusOnly + (student.cats.c9 || 0);
}

// The rows of today's board are ordered by score, but a change in the minus
// column does not move anyone: the order is kept as long as nothing but the
// minuses changed since it was made.
// Prayer minuses (the small button) move people only after 2 minutes without
// any press on the page.
let boardOrder = null; // { sig, rank: Map(student id -> place) }
const BOARD_RESORT_IDLE_MS = 2 * 60 * 1000;
let boardResortTimer = null;
function prayerMinusSig(){ return state.students.map(st => st.cats.c9 || 0).join(','); }
function boardRowOrder(){
  const sig = state.students.map(st => st.id + ':' + (computeSortScore(st) - (st.minusTotal || 0) - (st.cats.c9 || 0))).join(',');
  if (!boardOrder || boardOrder.sig !== sig){
    const rank = new Map();
    const half = Math.ceil(TOTAL_STUDENTS / 2);
    [state.students.slice(0, half), state.students.slice(half)].forEach(group => {
      group.slice().sort((a, b) => computeSortScore(b) - computeSortScore(a)).forEach((st, i) => rank.set(st.id, i));
    });
    boardOrder = { sig, rank, prayer: prayerMinusSig() };
  }
  return boardOrder.rank;
}
document.addEventListener('pointerdown', () => {
  clearTimeout(boardResortTimer);
  boardResortTimer = setTimeout(() => {
    if (state && boardOrder && boardOrder.prayer !== prayerMinusSig()){ boardOrder = null; render(); }
  }, BOARD_RESORT_IDLE_MS);
}, true);

function render(){
  if (!state) return;
  const boardsEl = document.getElementById('boards');
  boardsEl.innerHTML = '';
  const half = Math.ceil(TOTAL_STUDENTS / 2);
  const rank = boardRowOrder();
  const byRank = (a, b) => rank.get(a.id) - rank.get(b.id);
  const firstHalf = state.students.slice(0, half).sort(byRank);
  const secondHalf = state.students.slice(half).sort(byRank);

  const col1 = document.createElement('div');
  col1.className = 'board-col';
  col1.appendChild(buildBoard(`תלמידים 1–${half}`, firstHalf));

  const col2 = document.createElement('div');
  col2.className = 'board-col';
  col2.appendChild(buildBoard(`תלמידים ${half + 1}–${TOTAL_STUDENTS}`, secondHalf));
  col2.appendChild(buildToolbar());

  boardsEl.appendChild(col1);
  boardsEl.appendChild(col2);

  const todayEl = document.getElementById('todaySummary');
  renderTodayHistoryTable(todayEl);

  fitAllTextCells();
}

// The last size found for each group of text (see fitGroup), so the next fit
// can start from it.
const lastFitSizes = {};

function fitAllTextCells(){
  // The names have a size of their own: as large as the name cell allows,
  // the whole name inside it. The numbers share another size.
  const bodyItems = [];
  const nameItems = [];
  document.querySelectorAll('.num-cell .cell-text, .total-cell .cell-text, .point-val').forEach(el => {
    el.style.fontSize = '';
    const container = el.closest('td');
    if (container) (container.classList.contains('name-cell') ? nameItems : bodyItems).push({ el, container });
  });

  const headerGroups = new Map();
  // .metivta-header-toggle is excluded here on purpose - it inherits the
  // Metivta table's own header font size instead of this JS auto-shrink,
  // which would otherwise size it independently of the other headers and
  // end up visibly mismatched from them.
  document.querySelectorAll('thead .col-reset-btn, thead .th-name-text, thead .merged-dropdown-toggle:not(.metivta-header-toggle)').forEach(el => {
    el.style.fontSize = '';
    const container = el.closest('th');
    const table = el.closest('table');
    if (!container || !table) return;
    // Today's board: every header of both tables is one group, one size.
    const groupKey = table.closest('.board-wrap') ? 'board' : table;
    if (!headerGroups.has(groupKey)) headerGroups.set(groupKey, []);
    headerGroups.get(groupKey).push({ el, container });
  });

  requestAnimationFrame(() => {
    function fitGroup(items, startSize, ownBox, cacheKey){
      function fitsAll(size){
        // ownBox (the names): the whole name inside its own box, no wider
        // and no taller than the box.
        if (ownBox) return items.every(({ el }) => el.scrollWidth <= el.clientWidth && size <= el.clientHeight * 0.95);
        return items.every(({ el, container }) => {
          const limitW = Math.max(container.clientWidth - 2, 0);
          const limitH = Math.max(container.clientHeight - 2, 0);
          return el.scrollWidth <= limitW && el.scrollHeight <= limitH;
        });
      }
      function applySize(size){
        items.forEach(({ el }) => { el.style.fontSize = size + 'px'; });
      }

      // The largest whole size (8 to startSize) at which everything fits. A
      // smaller size always fits if a larger one does, so it is found by
      // halving (each try makes the browser measure the page again), and when
      // the size is the same as the last time two tries confirm it.
      const minSize = 8;
      const fits = (size) => { applySize(size); return fitsAll(size); };
      let lo = minSize, hi = startSize + 1; // lo fits (or is the smallest); hi does not
      const last = cacheKey ? lastFitSizes[cacheKey] : null;
      if (last && last > minSize && last <= startSize){
        if (fits(last)){
          lo = last;
          if (last === startSize || !fits(last + 1)){ applySize(last); return; }
          lo = last + 1;
        } else {
          hi = last;
        }
      }
      while (hi - lo > 1){
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) lo = mid; else hi = mid;
      }
      applySize(lo);
      if (cacheKey) lastFitSizes[cacheKey] = lo;
    }

    fitGroup(bodyItems, 90, false, 'body');
    fitGroup(nameItems, 90, true, 'names');
    // The text in the cells is as large as the names (the smaller of the two
    // sizes, so that everything still fits in its cell).
    if (bodyItems.length && nameItems.length){
      const common = Math.min(parseFloat(bodyItems[0].el.style.fontSize) || 90, parseFloat(nameItems[0].el.style.fontSize) || 90);
      bodyItems.concat(nameItems).forEach(({ el }) => { el.style.fontSize = common + 'px'; });
    }
    headerGroups.forEach((items, key) => fitGroup(items, key === 'board' ? 35 : 40, false, key === 'board' ? 'boardHeaders' : null));
  });
}

let resizeTimer = null;
document.addEventListener('click', () => {
  document.querySelectorAll('.merged-dropdown-list.open').forEach(l => l.classList.remove('open'));
  if (expandedGroup !== null){
    armExpandedGroupTimer();
  }
});

let lastViewportWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastViewportWidth) return;
  lastViewportWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state && document.getElementById('metivtaView').style.display !== 'none') renderMetivtaView();
    else {
      fitAllTextCells();
      if (state) renderFrequentFlyerView();
    }
  }, 150);
});

const SCREENSAVER_IDLE_MS = 30000;
const SCREENSAVER_ROTATE_MS = 20000;
const SCREENSAVER_STATES = [null, 'prayer', 'attendance'];
let screensaverIdleTimer = null;
let screensaverRotateTimer = null;
let screensaverActive = false;
let screensaverStateIndex = 0;

function currentView(){
  if (document.getElementById('z1View').style.display !== 'none') return 'z1';
  if (document.getElementById('metivtaView').style.display !== 'none') return 'metivta';
  return 'main';
}

// The automatic rotation only ever runs on/returns to the classroom (כיתה)
// page - it shows the live board, today's archive and the "הנוסע המתמיד"
// archive table together, since they all now live on that one page. While
// someone is on the Metivta page it does nothing, so there is no automatic
// page switching away from it.
function enterScreensaver(){
  if (!state) return;
  if (screensaverActive) return;
  if (currentView() !== 'main') return;
  screensaverActive = true;
  clearTimeout(expandedGroupTimer);
  screensaverStateIndex = 0;
  expandedGroup = SCREENSAVER_STATES[screensaverStateIndex];
  render();
  screensaverRotateTimer = setInterval(() => {
    screensaverStateIndex = (screensaverStateIndex + 1) % SCREENSAVER_STATES.length;
    expandedGroup = SCREENSAVER_STATES[screensaverStateIndex];
    render();
  }, SCREENSAVER_ROTATE_MS);
}

function exitScreensaver(){
  if (!screensaverActive) return;
  screensaverActive = false;
  clearInterval(screensaverRotateTimer);
  screensaverRotateTimer = null;
  expandedGroup = null;
  render();
}

function armScreensaverIdleTimer(){
  clearTimeout(screensaverIdleTimer);
  screensaverIdleTimer = setTimeout(enterScreensaver, SCREENSAVER_IDLE_MS);
}

['mousemove', 'click', 'touchstart', 'keydown'].forEach(evt => {
  document.addEventListener(evt, () => {
    if (screensaverActive) exitScreensaver();
    armScreensaverIdleTimer();
  });
});

armScreensaverIdleTimer();

function showStartupError(e){
  const msg = (e && e.stack) ? e.stack : String(e);
  const banner = document.createElement('div');
  banner.style.position = 'fixed';
  banner.style.top = '0';
  banner.style.left = '0';
  banner.style.right = '0';
  banner.style.zIndex = '300';
  banner.style.background = '#fff3f3';
  banner.style.color = '#9C3B3B';
  banner.style.borderBottom = '2px solid #9C3B3B';
  banner.style.padding = '10px 14px';
  banner.style.fontFamily = "'Rubik', sans-serif";
  banner.style.fontSize = '12px';
  banner.style.whiteSpace = 'pre-wrap';
  banner.style.wordBreak = 'break-word';
  banner.textContent = 'שגיאה בטעינת האתר: ' + msg;
  document.body.appendChild(banner);
}

// Shown instead of an error while the first load can't reach the data server
// (and this computer has no saved copy yet); the load is retried by itself.
function showLoadWaitNotice(reason){
  let box = document.getElementById('loadWaitNotice');
  if (!box){
    box = document.createElement('div');
    box.id = 'loadWaitNotice';
    box.style.cssText = 'max-width:440px;margin:80px auto;padding:28px 24px;background:#fff;border:1px solid var(--line);'
      + 'border-radius:14px;box-shadow:0 8px 24px rgba(34,48,74,0.08);text-align:center;font-family:Rubik,sans-serif;color:var(--ink);';
    document.getElementById('appContent').prepend(box);
  }
  box.innerHTML = '<div style="font-size:22px;font-weight:800;margin-bottom:10px;">⏳ ממתין לחיבור</div>'
    + '<div style="font-size:15px;line-height:1.6;">אי אפשר לטעון את הנתונים כרגע.</div>'
    + '<div class="load-wait-reason" style="font-size:14px;font-weight:700;color:var(--danger);margin-top:8px;"></div>'
    + '<div style="font-size:13px;color:var(--ink-soft);margin-top:10px;">האתר ינסה שוב לבד כל כמה שניות, ויוצג מיד כשהחיבור יחזור.</div>';
  box.querySelector('.load-wait-reason').textContent = 'סיבה: ' + reason;
}

function hideLoadWaitNotice(){
  const box = document.getElementById('loadWaitNotice');
  if (box) box.remove();
}

async function loadStateUntilConnected(){
  for (;;){
    try{
      // A load that just hangs (no answer, no error) shows the notice too.
      const slow = setTimeout(() => showLoadWaitNotice('השרת לא עונה - כנראה אין חיבור לאינטרנט, או שהרשת חוסמת את שרת הנתונים'), 8000);
      try{
        await loadState();
      } finally {
        clearTimeout(slow);
      }
      hideLoadWaitNotice();
      return;
    } catch(e){
      if (e && e.badFormat) throw e;
      showLoadWaitNotice(describeSaveError(e));
      await new Promise(resolve => {
        const done = () => { window.removeEventListener('online', done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 5000);
        window.addEventListener('online', done);
      });
    }
  }
}

// One-time change of the data: היום יום became 2 points a day, so every value
// already entered (a number of days) is doubled. Each week is changed in its
// own transaction and marked, so it can never be doubled twice. Only weeks up
// to this one are touched - later weeks are entered in the new way.
const HAYOM_YOM_LAST_OLD_WEEK = '2026-11-01';
async function migrateHayomYomDoubled(){
  if (!firestoreDb) return;
  // Once every old week is done there is nothing to read again on this device.
  try{ if (localStorage.getItem('hayomYomMigrationDone') === '1') return; } catch(e){}
  let changed = false;
  try{
    const snaps = await getDocs(weeklyArchiveCollectionRef);
    const keys = [];
    snaps.forEach(sn => { const d = sn.data(); if (d && d.weekKey && d.weekKey <= HAYOM_YOM_LAST_OLD_WEEK && !d.hayomYomDoubledV1) keys.push(d.weekKey); });
    for (const weekKey of keys){
      await runTransaction(firestoreDb, async (tx) => {
        const ref = weekDocRef(weekKey);
        const sn = await tx.get(ref);
        if (!sn.exists()) return;
        const data = sn.data();
        if (data.hayomYomDoubledV1) return;
        const students = (data.students || []).map(st => (st && st.hayomYom > 0) ? { ...st, hayomYom: st.hayomYom * 2 } : st);
        tx.set(ref, { ...data, students, hayomYomDoubledV1: true });
        changed = true;
      });
    }
    try{ localStorage.setItem('hayomYomMigrationDone', '1'); } catch(e){}
  } catch(e){ console.warn('hayomYom migration', e); }
  if (changed) refreshArchiveAndRender();
}

async function initApp(){
  try{
    // The מתיבתא ז1 page has no menu - nothing on it leads to the rest of the site.
    const isZ1Page = new URLSearchParams(location.search).get('view') === 'z1';
    if (isZ1Page){
      document.title = 'הנוסע המתמיד ז1';
      // Installed as an app, this page is its own app ("הנוסע המתמיד ז1").
      document.querySelector('link[rel="manifest"]').href = 'manifest-z1.webmanifest';
      ['boards', 'todaySummary', 'frequentArchiveView'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    }
    // The menu (with its refresh option) is there even while waiting to load.
    if (!isZ1Page) mountPageNav({
      getCurrent: currentView,
      onNavigate: (key) => {
        if (!state) return false;
        if (key === 'main'){ showMain(); history.replaceState(null, '', location.pathname); return true; }
        if (key === 'metivta'){ showMetivta(); history.replaceState(null, '', location.pathname + '?view=metivta'); return true; }
        return false;
      }
    });
    setStatus('טוען…');
    await loadStateUntilConnected();
    lastViewJson = viewSignature();
    const pdfJobParams = new URLSearchParams(location.search);
    if (pdfJobParams.get('sendpdf')){
      selectedWeeklyKey = pdfJobParams.get('sendpdf').split(',')[0];
    }
    render();
    renderFrequentFlyerView();
    if (new URLSearchParams(location.search).get('view') === 'metivta'){
      showMetivta();
    }
    if (isZ1Page) showZ1();
    setStatus('');
    if (pdfJobParams.get('sendpdf')) runSendPdfJob(pdfJobParams);
    else migrateHayomYomDoubled();
    checkAutoReset();
    scheduleNextAutoResetCheck();
    subscribeToRemoteStateChanges();
    // Changes left waiting from an earlier visit (e.g. made offline).
    if (pendingOps.length) scheduleSync(0);

    if (document.fonts && document.fonts.ready){
      document.fonts.ready.then(() => {
        fitAllTextCells();
        if (currentView() === 'main') renderFrequentFlyerView();
        else if (currentView() === 'metivta') renderMetivtaView();
      });
    }
  } catch(e){
    showStartupError(e);
  }
}

// Editing the archive is opened with a code entered on a very small number
// pad, whose digits change places each time the code has to be entered.
// Editing the archive: 135 (works without internet) or the admin code. The admin
// code is not in this file - the server checks it (verifyCode).
const ARCHIVE_ACCESS_CODE = '135';
// Once opened it stays open this long after the last use - also across a
// reload and between the site's pages (it is kept in the browser).
const ARCHIVE_EDIT_SECONDS = 90;
const ARCHIVE_UNLOCK_KEY = 'archiveEditUntil';
// Three wrong tries lock the prompt for a few minutes.
const ARCHIVE_LOCK_KEY = 'archiveEditLock';
const ARCHIVE_MAX_TRIES = 3;
const ARCHIVE_LOCK_MINUTES = 5;

let archiveEditUntilMemory = 0;
let archiveLockMemory = { tries: 0, until: 0 };

function readArchiveEditUntil(){
  try{
    return Math.max(parseInt(localStorage.getItem(ARCHIVE_UNLOCK_KEY), 10) || 0, archiveEditUntilMemory);
  } catch(e){
    return archiveEditUntilMemory;
  }
}

function archiveEditUnlocked(){
  return Date.now() < readArchiveEditUntil();
}

function extendArchiveEditAccess(){
  archiveEditUntilMemory = Date.now() + ARCHIVE_EDIT_SECONDS * 1000;
  try{ localStorage.setItem(ARCHIVE_UNLOCK_KEY, String(archiveEditUntilMemory)); } catch(e){}
}

function readArchiveLock(){
  try{
    const v = JSON.parse(localStorage.getItem(ARCHIVE_LOCK_KEY));
    if (v && typeof v === 'object') return { tries: v.tries || 0, until: v.until || 0 };
  } catch(e){}
  return archiveLockMemory;
}

function writeArchiveLock(lock){
  archiveLockMemory = lock;
  try{ localStorage.setItem(ARCHIVE_LOCK_KEY, JSON.stringify(lock)); } catch(e){}
}

// Counts a wrong try; returns the minutes left if that locked the prompt.
function archiveWrongTry(){
  const lock = readArchiveLock();
  const tries = lock.tries + 1;
  if (tries >= ARCHIVE_MAX_TRIES){
    writeArchiveLock({ tries: 0, until: Date.now() + ARCHIVE_LOCK_MINUTES * 60000 });
    return ARCHIVE_LOCK_MINUTES;
  }
  writeArchiveLock({ tries, until: 0 });
  return 0;
}

function archiveLockMinutesLeft(){
  const left = readArchiveLock().until - Date.now();
  return left > 0 ? Math.ceil(left / 60000) : 0;
}

// Asks the server whether a typed code is the admin code.
// Throws when the server can't be reached (or the check is locked).
async function verifyAdminCode(code){
  const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js");
  const res = await httpsCallable(getFunctions(firebaseApp, 'us-central1'), 'verifyCode')({ code });
  return !!(res.data && res.data.level === 'admin');
}

// requiredLevel 'admin': only the admin code opens it; otherwise 135 or the
// admin code do.
function showArchiveCodePrompt(onSuccess, requiredLevel){
  const maxLength = 4; // the longest code; nothing on the pad shows the length
  // No dimming and no title: just the small number pad, at the bottom left
  // of the screen. A click anywhere else closes it.
  const overlay = document.createElement('div');
  overlay.className = 'code-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const box = document.createElement('div');
  box.className = 'code-box-mini';

  // A tiny number pad. The digits change places each time the code has to be
  // entered (when it opens, and after a wrong code), and nothing on it shows
  // how many digits the code has.
  const keypad = document.createElement('div');
  keypad.className = 'mini-keypad';
  const keys = [];
  for (let i = 0; i < 10; i++){
    const key = document.createElement('button');
    key.type = 'button';
    key.addEventListener('click', () => press(key.textContent));
    keypad.appendChild(key);
    keys.push(key);
  }
  function shuffleKeys(){
    const digits = '0123456789'.split('');
    for (let i = digits.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [digits[i], digits[j]] = [digits[j], digits[i]];
    }
    keys.forEach((key, i) => { key.textContent = digits[i]; });
  }
  box.appendChild(keypad);

  // Shown only while the code is locked.
  const lockMsg = document.createElement('div');
  lockMsg.className = 'code-lock-msg';
  box.appendChild(lockMsg);

  let entered = '';
  function showLockState(){
    const mins = archiveLockMinutesLeft();
    if (mins > 0){
      lockMsg.textContent = 'ננעל. אפשר לנסות שוב בעוד ' + mins + (mins === 1 ? ' דקה' : ' דקות') + '.';
      lockMsg.style.display = '';
      keypad.style.display = 'none';
      return true;
    }
    lockMsg.style.display = 'none';
    keypad.style.display = '';
    return false;
  }
  function wrongCode(){
    entered = '';
    // A wrong code: the frame blinks red (no text), the digits move.
    box.classList.add('wrong');
    setTimeout(() => box.classList.remove('wrong'), 350);
    // A wrong code: the code must be entered again, so the digits change places.
    if (archiveWrongTry()) showLockState();
    else shuffleKeys();
  }
  async function press(digit){
    if (entered.length >= maxLength) return;
    entered += digit;
    // The digits keep their places while a code is being typed. 135 is checked
    // here (so it works without internet); a 4-digit code is asked from the server.
    if (entered === ARCHIVE_ACCESS_CODE && requiredLevel !== 'admin'){
      writeArchiveLock({ tries: 0, until: 0 });
      overlay.remove();
      onSuccess();
      return;
    }
    if (entered.length < maxLength) return;
    const asked = entered;
    let isAdmin = false;
    try{
      isAdmin = await verifyAdminCode(asked);
    } catch(e){
      entered = '';
      lockMsg.textContent = e && e.code === 'functions/resource-exhausted' ? 'נעול זמנית. נסה שוב בעוד כמה דקות.' : 'אין חיבור לשרת.';
      lockMsg.style.display = '';
      setTimeout(() => { if (!archiveLockMinutesLeft()) lockMsg.style.display = 'none'; }, 2500);
      shuffleKeys();
      return;
    }
    if (isAdmin){
      writeArchiveLock({ tries: 0, until: 0 });
      overlay.remove();
      onSuccess();
      return;
    }
    wrongCode();
  }

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  shuffleKeys();
  showLockState();
}

// The tests table of the Metivta page opens only with the admin code (the one
// of admin.html). Once open it stays open for a while after the last use.
const TESTS_OPEN_KEY = 'metivtaTestsOpenUntil';
const TESTS_OPEN_SECONDS = 600;
let testsOpenMemory = 0;
function testsOpen(){
  let until = testsOpenMemory;
  try{ until = Math.max(until, parseInt(localStorage.getItem(TESTS_OPEN_KEY), 10) || 0); } catch(e){}
  return Date.now() < until;
}
function setTestsOpen(open){
  testsOpenMemory = open ? Date.now() + TESTS_OPEN_SECONDS * 1000 : 0;
  try{ localStorage.setItem(TESTS_OPEN_KEY, String(testsOpenMemory)); } catch(e){}
}

function requireArchiveEditAccess(callback){
  if (archiveEditUnlocked()){
    extendArchiveEditAccess();
    callback();
    return;
  }
  showArchiveCodePrompt(() => {
    extendArchiveEditAccess();
    callback();
  });
}

function promptEditArchiveMetivtaFlags(flags, onChange){
  requireArchiveEditAccess(() => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    // Every choice is saved and closes the window.
    let timeRow = null;
    const save = (keepOpen) => { if (keepOpen !== true) overlay.remove(); onChange(); };

    const box = document.createElement('div');
    box.className = 'modal-box';

    const msg = document.createElement('div');
    msg.className = 'modal-msg';
    msg.textContent = 'ערוך דיווח:';
    box.appendChild(msg);

    const okBtn = document.createElement('button');
    function refreshOkBtn(){
      const isPlainOk = flags.ok && !flags.late && !flags.leftEarly && !flags.noBook && !(flags.disturbCount > 0);
      okBtn.className = 'modal-btn' + (isPlainOk ? ' modal-btn-confirm' : ' modal-btn-cancel');
      okBtn.textContent = 'וי (הגיע בזמן)';
    }
    refreshOkBtn();
    okBtn.addEventListener('click', () => {
      flags.late = false;
      flags.lateTime = '';
      flags.leftEarly = false;
      flags.noBook = false;
      flags.disturbCount = 0;
      flags.ok = true;
      refreshOkBtn();
      refreshToggleBtns();
      disturbLabel.textContent = 'הפרעות: ' + flags.disturbCount;
      save();
    });
    box.appendChild(okBtn);

    const toggleRow = document.createElement('div');
    toggleRow.className = 'modal-btns';
    toggleRow.style.marginTop = '10px';
    const toggleBtns = [];

    function refreshToggleBtns(){
      toggleBtns.forEach(({ btn, label, key }) => {
        btn.className = 'modal-btn' + (flags[key] ? ' modal-btn-confirm' : ' modal-btn-cancel');
        btn.textContent = label + (flags[key] ? ' ✓' : '');
      });
    }

    function buildToggleBtn(label, key){
      const btn = document.createElement('button');
      toggleBtns.push({ btn, label, key });
      btn.addEventListener('click', () => {
        flags[key] = !flags[key];
        if (flags.late || flags.leftEarly || flags.noBook || flags.disturbCount > 0) flags.ok = false;
        refreshToggleBtns();
        refreshOkBtn();
        if (key === 'late'){
          flags.lateTime = flags.late ? nowHHMM() : '';
          if (flags.late){
            timeRow.style.display = '';
            timeRow.querySelector('input').value = flags.lateTime;
            save(true);
            return;
          }
        }
        save();
      });
      return btn;
    }

    toggleRow.appendChild(buildToggleBtn('איחור', 'late'));
    toggleRow.appendChild(buildToggleBtn('יצא מוקדם', 'leftEarly'));
    toggleRow.appendChild(buildToggleBtn('בלי ספר', 'noBook'));
    refreshToggleBtns();
    box.appendChild(toggleRow);
    timeRow = appendLateTimeRow(box, flags, save);

    const disturbLabel = document.createElement('div');
    disturbLabel.className = 'modal-msg';
    disturbLabel.style.marginTop = '10px';
    disturbLabel.textContent = 'הפרעות: ' + flags.disturbCount;
    box.appendChild(disturbLabel);

    const disturbRow = document.createElement('div');
    disturbRow.className = 'modal-btns';

    const minusBtn = document.createElement('button');
    minusBtn.className = 'modal-btn modal-btn-cancel';
    minusBtn.textContent = '−';
    minusBtn.addEventListener('click', () => {
      if (flags.disturbCount > 0) flags.disturbCount--;
      disturbLabel.textContent = 'הפרעות: ' + flags.disturbCount;
      refreshOkBtn();
      save();
    });
    disturbRow.appendChild(minusBtn);

    const plusBtn = document.createElement('button');
    plusBtn.className = 'modal-btn modal-btn-confirm';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', () => {
      flags.disturbCount = (flags.disturbCount || 0) + 1;
      flags.ok = false;
      disturbLabel.textContent = 'הפרעות: ' + flags.disturbCount;
      refreshOkBtn();
      save();
    });
    disturbRow.appendChild(plusBtn);
    box.appendChild(disturbRow);
    appendTaskSection(box, flags, () => save());

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  });
}

if (isFirebaseConfigured){
  initApp();
} else {
  showSetupNeededMessage();
}

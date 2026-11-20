// Recurring SMS messages ("שליחה קבועה" in admin.html): a message template with
// its recipients that goes out every week on a chosen day and hour. The
// numbers in the message ({נוכחות}, {ציון}...) are worked out again at every
// sending, from the data of that moment - the same way admin.html works them
// out for a message sent by hand. Kept apart from index.js so it can be tried
// without Firebase.

// Keep in sync with STUDENT_NAMES / METIVTA_EXTRA_NAMES in admin.js and index.html.
const STUDENT_NAMES = [
  'צאלי', 'ישרוליק', 'נתנאל', 'מענדי ה.', 'מענדי ח.', 'אלעאי', 'יהונתן', 'איתן', 'מענדי ל.', 'שלוימי', 'מוישלה', 'לוי ס.',
  'שמוליק ע.', 'מולי', 'שלום', 'חננאל', 'שמוליק צ.', 'אושר', 'שמעון', 'מוטי', 'לוי ק.', 'נועם', 'משה'
];
const METIVTA_EXTRA_NAMES = [
  'יהונתן', 'נריה', 'יהודה', 'חסדיאל', 'אוריאל', 'מענדל', 'שניאור', 'מענדי דר.', 'מענדי זכ.', 'עוזי', 'מענדי יא.',
  'אופיר', 'לוי', 'מענדי מז.', 'מענדי מע.', 'אברמי', 'שמואל', 'מענדי סמ.', 'ברוכי', 'איזיק', 'בער', 'רמי', 'ניתאי'
];
const SITE_URL = 'https://chabadr.github.io/';

// Keep in sync with STAT_FIELDS in admin.js.
const STAT_FIELDS = [
  { key: 'attendance', placeholder: '{נוכחות}' },
  { key: 'onTime', placeholder: '{בזמן}' },
  { key: 'late', placeholder: '{איחור}' },
  { key: 'leftEarly', placeholder: '{מוקדם}' },
  { key: 'disturbed', placeholder: '{הפרעות}' }
];

function metivtaRecordHasFlags(s){
  const f = s && s.metivtaFlags;
  return !!(f && (f.ok || f.late || f.leftEarly || f.noBook || (f.disturbCount || 0) > 0));
}

function metivtaEntryHasData(entry){
  const recs = [...(entry.students || []), ...(entry.metivtaExtraStudents || [])];
  return recs.some(r => metivtaRecordHasFlags(r));
}

function decodeMetivtaNameEntry(raw, fallback){
  if (typeof raw === 'string') return { family: '', first: raw || fallback };
  if (raw && typeof raw === 'object') return { family: raw.family || '', first: raw.first || fallback };
  return { family: '', first: fallback };
}

// Every Metivta student by key ('main-3', 'extra-7'), with names, the parents'
// form link and the parents' phones - as buildRoster in admin.js.
function buildRosterMap(mainData, phonesData){
  const map = new Map();
  [
    { names: STUDENT_NAMES, isExtra: false, group: 'main', nameMap: mainData.metivtaNames || {} },
    { names: METIVTA_EXTRA_NAMES, isExtra: true, group: 'extra', nameMap: mainData.metivtaExtraNames || {} }
  ].forEach(({ names, isExtra, group, nameMap }) => {
    const phones = (phonesData || {})[group] || {};
    names.forEach((defaultName, idx) => {
      const id = idx + 1;
      const key = group + '-' + id;
      const entry = decodeMetivtaNameEntry(nameMap[id], defaultName);
      map.set(key, {
        key, id, isExtra,
        first: entry.first,
        name: entry.family ? (entry.first + ' ' + entry.family) : entry.first,
        link: isExtra ? '' : SITE_URL + 'up?id=' + id,
        father: (phones[id] && phones[id].father) || '',
        mother: (phones[id] && phones[id].mother) || '',
        getRecord: (day) => ((isExtra ? day.metivtaExtraStudents : day.students) || []).find(x => x.id === id) || null
      });
    });
  });
  return map;
}

// Today's live data first, then the past days on which Metivta attendance was
// marked, newest first - as in admin.js (renderSmsTab).
function buildDays(mainData, dailyDays, now){
  const archived = (Array.isArray(dailyDays) ? dailyDays.slice() : []).sort((a, b) => new Date(b.date) - new Date(a.date));
  const today = { date: now.toISOString(), students: mainData.students || [], metivtaExtraStudents: mainData.metivtaExtra || [] };
  return [today, ...archived.filter(metivtaEntryHasData)];
}

// Keep in sync with computeDefaultStats in admin.js.
function computeStats(student, days, dayCountVal){
  const dayCount = dayCountVal === 'all' ? null : parseInt(dayCountVal, 10);
  const relevantDays = (dayCount === null || isNaN(dayCount)) ? days : days.slice(0, dayCount);
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

// Keep in sync with resolveMessage in admin.js.
function resolveTemplate(template, student, stats, test){
  let text = String(template || '')
    .split('{שם}').join(student.first)
    .split('{קישור}').join(student.link || '');
  STAT_FIELDS.forEach(f => { text = text.split(f.placeholder).join(String(stats[f.key])); });
  text = text.split('{מבחן}').join(test ? (test.title || '') : '')
    .split('{ציון}').join(test ? String(test.scoreOf(student.key)) : '');
  return text;
}

function normalizePhone(v){
  return (v || '').replace(/[\s-]/g, '').trim();
}

// The messages of one recurring entry: [{ phone, label, msg }] (recipients
// with no phone now are skipped).
function buildRecurringMessages(rec, mainData, dailyDays, phonesData, now){
  const roster = buildRosterMap(mainData, phonesData);
  const days = buildDays(mainData, dailyDays, now);
  const testsData = (mainData.metivtaTests && Array.isArray(mainData.metivtaTests.columns)) ? mainData.metivtaTests : { columns: [], scores: {} };
  const col = rec.testId ? testsData.columns.find(c => c && c.id === rec.testId) : null;
  const test = col ? {
    title: col.title || '',
    scoreOf: (studentKey) => {
      const v = testsData.scores && testsData.scores[col.id] ? testsData.scores[col.id][studentKey] : null;
      return (v === null || v === undefined || v === '') ? 0 : (parseFloat(v) || 0);
    }
  } : null;
  const out = [];
  (rec.recipients || []).forEach(r => {
    const student = roster.get(r.studentKey);
    if (!student) return;
    const phone = normalizePhone(student[r.role]);
    if (!phone) return;
    const stats = computeStats(student, days, rec.dayCount || '5');
    out.push({
      phone,
      label: student.name + ' - ' + (r.role === 'father' ? 'אבא' : 'אמא'),
      msg: resolveTemplate(rec.template, student, stats, test)
    });
  });
  return out;
}

// Israel time of a moment: weekday (0 = Sunday), hour, minute, and the date as yyyy-mm-dd.
function israelParts(date){
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    dateKey: get('year') + '-' + get('month') + '-' + get('day')
  };
}

// Allowed sending times (Israel): Sunday-Thursday at any hour, Friday until
// 14:00, Saturday from 19:00. Keep in sync with isInRecurringWindow in admin.js.
function isInRecurringWindow(weekday, hour, minute){
  if (weekday >= 0 && weekday <= 4) return true;
  if (weekday === 5) return hour < 14;
  if (weekday === 6) return hour >= 19;
  return false;
}

// How late a sending may still go out (e.g. after the server was down).
const MAX_LATE_MINUTES = 180;

// Is the entry due now (its day, its hour has come, not sent yet today)?
function isRecurringDue(rec, now){
  if (!rec || !rec.active) return false;
  const p = israelParts(now);
  if (rec.weekday !== p.weekday || rec.lastRunKey === p.dateKey) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(rec.time || ''));
  if (!m) return false;
  const at = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const nowMin = p.hour * 60 + p.minute;
  if (nowMin < at || nowMin - at > MAX_LATE_MINUTES) return false;
  return isInRecurringWindow(p.weekday, p.hour, p.minute) && isInRecurringWindow(rec.weekday, parseInt(m[1], 10), parseInt(m[2], 10));
}

module.exports = { buildRecurringMessages, isRecurringDue, israelParts, isInRecurringWindow, normalizePhone };

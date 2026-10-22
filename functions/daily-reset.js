// The nightly "new day" reset, run by the server (index.js, dailyReset) at
// 01:00 Israel time even when no page is open.
//
// Everything below is copied VERBATIM from index.html, which runs the same
// reset in the browser - keep the two identical when changing either one.
// Date math uses the process's local time, so index.js sets TZ to
// Asia/Jerusalem before this runs.

const CATEGORIES = [
  { key: 'c1', label: '8:10', value: 3 },
  { key: 'c2', label: 'קרבנות', value: 1 },
  { key: 'c3', label: 'תפילה', value: 2 },
  { key: 'c4', label: '11:23', value: 1 },
  { key: 'c5', label: '+', value: 1, resettable: true, cumulativeKey: 'c5Total' },
  { key: 'c6', label: 'מקווה', value: 1 },
  { key: 'c7', label: '8:45', value: 1 },
  { key: 'c8', label: '12:48', value: 1 }
];

const AUTO_RESET_HOUR = 1;

function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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

function dayKeyOf(dateStr){
  const d = new Date(dateStr);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function metivtaRecordHasFlags(s){
  const f = s && s.metivtaFlags;
  return !!(f && (f.ok || f.late || f.leftEarly || (f.disturbCount || 0) > 0));
}

function metivtaDayScore(f){
  // A day with no record at all must always sort below an attended day, no
  // matter how many exceptions that attended day racked up - otherwise a
  // heavily-penalized but present student (e.g. disturbed twice, clamped to
  // 0) becomes indistinguishable from a student with no record for that day
  // at all, and the two get shuffled together when sorting by that column.
  const attended = f.ok || f.late || f.leftEarly || f.disturbCount > 0;
  if (!attended) return -1;
  let score = 4 - (f.late ? 2 : 0) - (f.leftEarly ? 2 : 0) - 2 * (f.disturbCount || 0);
  if (score < 0) score = 0;
  return score;
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

function computeDailyResetUpdate(mainData, dailyDays, weeklyEntry){
  const defaultMetivtaFlags = { ok: false, late: false, leftEarly: false, disturbCount: 0 };
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
    const dayTefila = (s.cats.c7 || 0) + (s.cats.c3 || 0);
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
    s.metivtaFlags = { ok: false, late: false, leftEarly: false, disturbCount: 0 };
  });
  (newMainData.metivtaExtra || []).forEach(s => {
    s.metivta = { attendance: 0, behavior: 0 };
    s.metivtaFlags = { ok: false, late: false, leftEarly: false, disturbCount: 0 };
  });
  newMainData.lastArchivedDay = mainData.lastActivityDate || null;
  newMainData.lastActivityDate = null;
  newMainData.editTimes = Object.fromEntries(Object.entries(mainData.editTimes || {}).filter(([k]) => !k.startsWith('d:')));

  return { newMainData, newDailyDays: days, newWeeklyEntry: weeklyEntryOut, weekKey };
}

function isLiveDayDueForArchive(data){
  return !!data.lastActivityDate && data.lastActivityDate < activityDayStr();
}

module.exports = { computeDailyResetUpdate, isLiveDayDueForArchive, getWeekKey, todayStr };

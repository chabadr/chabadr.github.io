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
    }))
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
  const freshWeeklyStudent = (s) => ({
    id: s.id, morning: 0, tefila: 0, mikve: 0, minusDelta: 0, bonus: 0, days: {},
    baselineMikvaot: s.frequentFrozen ? (s.frequentFrozen.mikvaot || 0) : 0,
    baselineRambam: s.frequentFrozen ? (s.frequentFrozen.rambam || 0) : 0,
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
    if (typeof ws.baselineMikvaot !== 'number') ws.baselineMikvaot = 0;
    if (typeof ws.baselineRambam !== 'number') ws.baselineRambam = 0;

    const dayMorning = Math.round((s.cats.c1 || 0) * (2 / 3));
    const dayTefila = (s.cats.c7 || 0) + (s.cats.c3 || 0);
    const dayBonus = (s.minusTotal || 0) === 0 ? 1 : 0;

    const priorMikvaotSum = Object.values(ws.days).reduce((sum, d) => sum + (d.mikvaotVal || 0), 0);
    const priorRambamSum = Object.values(ws.days).reduce((sum, d) => sum + (d.rambamVal || 0), 0);

    const currentMikvaot = s.frequentFrozen ? (s.frequentFrozen.mikvaot || 0) : 0;
    const currentRambam = s.frequentFrozen ? (s.frequentFrozen.rambam || 0) : 0;

    const dayMikvaotVal = currentMikvaot - ws.baselineMikvaot - priorMikvaotSum;
    const dayRambamVal = currentRambam - ws.baselineRambam - priorRambamSum;

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
  newMainData.lastAutoResetDate = todayStr();
  newMainData.lastActivityDate = null;

  return { newMainData, newDailyDays: days, newWeeklyEntry: weeklyEntryOut, weekKey };
}

function isLiveDayDueForArchive(data){
  if (!data.lastActivityDate) return false;
  const today = todayStr();
  if (data.lastActivityDate >= today) return false;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
  return data.lastActivityDate < yesterday || new Date().getHours() >= AUTO_RESET_HOUR;
}

module.exports = { computeDailyResetUpdate, isLiveDayDueForArchive, getWeekKey, todayStr };

// The steps in Mashov (a headless browser) and the attendance rule from the
// class board. Used by index.js. Keep the rule in sync with mashov/mashov-update.mjs.

const SETTINGS = {
  loginUrl: 'https://web.mashov.info/teachers/login',
  schoolSearch: 'רחובו',
  schoolOption: 'ממ"ד חב"ד בנים- רחובות',
  lessonText: /תפילה\s*ז2/,
  lessonGroup: '2278',
  topic: 'נוכחות',
  lessonMode: 'פיזי',
  lateColumn: 'איחור בוקר',
  absentColumn: 'חיסור יומי'
};
// A family name that is written differently in Mashov: board student id -> the name in Mashov.
const NAME_IN_MASHOV = { 2: 'גורפי' };

const norm = (s) => String(s || '').replace(/['׳"״`]/g, '').replace(/\s+/g, ' ').trim();
const searchTermOf = (name) => norm(String(name).split(/['׳"״`]/)[0]);

function israelToday(d = new Date()){
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t) => (p.find(x => x.type === t) || {}).value;
  return { dmy: g('day') + '/' + g('month') + '/' + g('year'), iso: g('year') + '-' + g('month') + '-' + g('day') };
}

// The rule, from today's live board:
//   marked at 8:10 (c1) or 8:45 (c7)     -> on time (nothing is marked)
//   any other mark today                 -> איחור בוקר
//   no mark at all                       -> חיסור יומי
// arrivedIds: students with no mark on the board that the class computer's
// question at 10:00 said did come (so: איחור בוקר and not חיסור).
function boardStatuses(main, today, arrivedIds){
  if (main.lastActivityDate !== today.iso) throw new Error('הלוח של הכיתה עוד לא מולא היום (' + today.dmy + ') - לא סומן כלום.');
  return statusesOf(main.students || [], main.metivtaNames || {}, arrivedIds, 'היום');
}

// The statuses of one day's students (today's live board, or an archived day).
function statusesOf(students, names, arrivedIds, dayLabel){
  const arrived = new Set((arrivedIds || []).map(Number));
  const out = [];
  let present = 0;
  for (const st of students){
    const c = st.cats || {};
    const onTime = (c.c1 || 0) > 0 || (c.c7 || 0) > 0;
    const otherMark = Object.keys(c).some(k => k !== 'c1' && k !== 'c7' && (c[k] || 0) !== 0)
      || (st.minusTotal || 0) !== 0 || (st.purchases || 0) > 0
      || !!(st.frequent && ((st.frequent.mikvaot || 0) > 0 || (st.frequent.rambam || 0) > 0));
    const status = onTime ? 'ontime' : (otherMark || arrived.has(st.id)) ? 'late' : 'absent';
    if (status !== 'absent') present++;
    const n = names[st.id];
    out.push({ id: st.id, family: NAME_IN_MASHOV[st.id] || (n && typeof n === 'object' ? n.family : '') || '', status });
  }
  if (!present) throw new Error('אף תלמיד לא מסומן בלוח ' + dayLabel + ' - לא סומן כלום.');
  return out;
}

// dd/mm/yyyy and yyyy-mm-dd of an Israel day key (yyyy-mm-dd).
function dayOf(iso){
  const [y, m, d] = iso.split('-');
  return { iso, dmy: d + '/' + m + '/' + y };
}

// The cookies window of a new browser ("only the needed cookies"): clicked
// whenever it shows up and gets in the way, without waiting for it.
async function handleCookies(page){
  const btn = page.getByRole('button', { name: 'עוגיות חיוניות בלבד' });
  try{ await page.addLocatorHandler(btn, async () => { await btn.click().catch(() => {}); }); } catch(e){}
}
async function dismissCookies(page){
  const btn = page.getByRole('button', { name: 'עוגיות חיוניות בלבד' });
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}


// A saved sign-in of an earlier run (cookies + the browser's storage), so
// Mashov does not see a new device (and e-mail "a new sign-in") every time.
// Returns true when the main screen opened without signing in.
async function reuseSession(page, step, pass){
  step('בדיקת כניסה שמורה');
  try{
    await page.goto('https://web.mashov.info/teachers/main/dashboard', { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('button', { name: 'הזנת נתוני שיעור' });
    const end = Date.now() + 25000;
    while (Date.now() < end){
      if (/\/teachers\/login/.test(page.url())) return false;
      // After a while without use Mashov locks the screen ("נא להזדהות מחדש"):
      // the password opens it again - the same sign-in, not a new one.
      if (await unlockIfLocked(page, pass)) continue;
      if (await main.isVisible().catch(() => false)){ await dismissCookies(page); return true; }
      await page.waitForTimeout(300);
    }
    return false;
  } catch(e){ return false; }
}

// The lock window: types the password and waits for it to go. True if it was there.
async function unlockIfLocked(page, pass){
  const title = page.getByText('נא להזדהות מחדש');
  if (!(await title.isVisible().catch(() => false))) return false;
  await page.getByRole('textbox', { name: 'סיסמה (משו"ב)' }).fill(pass);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await title.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  return true;
}

// The lock window may also come up in the middle of the work: opened whenever it gets in the way.
async function handleLock(page, pass){
  const title = page.getByText('נא להזדהות מחדש');
  try{ await page.addLocatorHandler(title, async () => { await unlockIfLocked(page, pass); }); } catch(e){}
}

// The sign-in to keep: cookies, localStorage (storageState) and sessionStorage.
async function captureSession(page){
  const state = await page.context().storageState();
  let session = '{}';
  try{ session = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))); } catch(e){}
  return { state: JSON.stringify(state), session, savedAt: new Date().toISOString() };
}

// The init script that puts the saved sessionStorage back in a new page.
function sessionInitScript(session){
  return (data) => {
    if (location.hostname !== 'web.mashov.info') return;
    try{ const o = JSON.parse(data); Object.keys(o).forEach(k => sessionStorage.setItem(k, o[k])); } catch(e){}
  };
}

async function login(page, user, pass, step){
  step('כניסה למשוב');
  await page.goto(SETTINGS.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('הזדהות משו"ב').click();
  const school = page.getByRole('combobox', { name: 'ביה"ס' });
  await school.click();
  await school.fill(SETTINGS.schoolSearch);
  await page.getByText(SETTINGS.schoolOption).first().click();
  await page.getByRole('textbox', { name: 'שם משתמש / ת.ז' }).fill(user);
  await page.getByRole('textbox', { name: 'סיסמה (משו"ב)' }).fill(pass);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await page.waitForURL(/\/teachers\/main\//, { timeout: 60000 });
  await dismissCookies(page);
}

// Today's תפילה lesson, from "המערכת להיום" of the main screen; the lesson
// page must say today's date and the group 2278.
async function openTodaysLesson(page, today, step){
  step('פתיחת שיעור התפילה של היום');
  // Only inside "המערכת להיום": the "תיעוד פעולות אחרונות" list of the same
  // screen also says "תפילה ז2" (yesterday's report), and must not be clicked.
  let found = false;
  for (let attempt = 0; attempt < 30 && !found; attempt++){
    if (page.__mashovPass) await unlockIfLocked(page, page.__mashovPass);
    found = await page.evaluate((src) => {
      const re = new RegExp(src);
      const heads = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && e.textContent.trim() === 'המערכת להיום');
      for (const h of heads){
        let box = h.parentElement;
        for (let k = 0; k < 6 && box; k++, box = box.parentElement){
          if (box.textContent.includes('תיעוד פעולות')) break;
          const items = [...box.querySelectorAll('*')].filter(e => re.test(e.textContent) && ![...e.children].some(c => re.test(c.textContent)));
          if (items.length){ items[0].setAttribute('data-mashov-today', '1'); return true; }
        }
      }
      return false;
    }, SETTINGS.lessonText.source);
    if (!found) await page.waitForTimeout(1000);
  }
  if (!found) throw new Error('שיעור תפילה ז2 לא נמצא ב"המערכת להיום" - אולי אין שיעור היום. לא סומן כלום.');
  await page.locator('[data-mashov-today="1"]').first().click();
  const panel = page.getByRole('tabpanel', { name: 'נתוני שיעור' });
  try{ await panel.waitFor({ timeout: 45000 }); }
  catch(e){ throw new Error('דף השיעור לא נפתח במשוב - לא סומן כלום.'); }
  const text = norm(await panel.innerText());
  if (!text.includes(today.dmy) || !text.includes(SETTINGS.lessonGroup)){
    throw new Error('השיעור שנפתח אינו שיעור התפילה של היום (' + today.dmy + ') - לא סומן כלום.');
  }
}

// The תפילה lesson of an earlier day: "הזנת נתוני שיעור" shows the week's
// timetable (a column for each date); the lesson is the תפילה (2278) cell in
// that date's column. An earlier week is reached with "שבוע קודם".
async function openLessonOnDate(page, day, step){
  step('פתיחת שיעור התפילה של ' + day.dmy);
  await page.goto('https://web.mashov.info/teachers/main/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'הזנת נתוני שיעור' }).click();
  let header = null;
  for (let week = 0; week < 3 && !header; week++){
    const h = page.getByText(day.dmy, { exact: true }).first();
    try{ await h.waitFor({ timeout: 12000 }); header = h; }
    catch(e){
      const prev = page.getByRole('button', { name: /שבוע קודם/ });
      if (!(await prev.count())) break;
      await prev.first().click();
    }
  }
  if (!header) throw new Error('התאריך ' + day.dmy + ' לא נמצא במערכת השעות של משוב.');
  const hb = await header.boundingBox();
  const hx = hb.x + hb.width / 2;
  for (let attempt = 0; attempt < 15; attempt++){
    for (const [text, other] of [[SETTINGS.lessonGroup, 'תפילה'], ['תפילה', SETTINGS.lessonGroup]]){
      const cands = page.getByText(text);
      const n = await cands.count();
      for (let i = 0; i < n; i++){
        const c = cands.nth(i);
        const b = await c.boundingBox();
        if (!b || Math.abs(b.x + b.width / 2 - hx) > Math.max(hb.width, b.width) / 2 + 20) continue;
        const cell = c.locator('xpath=ancestor-or-self::*[contains(normalize-space(.), "' + other + '")][1]');
        if (!(await cell.count())) continue;
        await c.click();
        const panel = page.getByRole('tabpanel', { name: 'נתוני שיעור' });
        try{ await panel.waitFor({ timeout: 45000 }); }
        catch(e){ throw new Error('דף השיעור של ' + day.dmy + ' לא נפתח במשוב.'); }
        const text2 = norm(await panel.innerText());
        if (!text2.includes(day.dmy) || !text2.includes(SETTINGS.lessonGroup)) throw new Error('השיעור שנפתח אינו שיעור התפילה של ' + day.dmy + '.');
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('שיעור התפילה (' + SETTINGS.lessonGroup + ') לא נמצא במערכת השעות ביום ' + day.dmy + '.');
}

async function fillLesson(page, step){
  step('נושא השיעור ואופן העברה');
  const happened = page.getByRole('radio', { name: 'שיעור התקיים' });
  if (await happened.count() && !(await happened.isChecked())) await happened.check();
  await page.getByRole('textbox', { name: 'נושא שיעור' }).fill(SETTINGS.topic);
  await page.getByRole('radio', { name: SETTINGS.lessonMode }).check();
  step('מעבר למסך אירועי התנהגות');
  const next = page.getByRole('button', { name: 'הזנת ארועי התנהגות' }).locator('visible=true').first();
  await next.click();
  await page.getByText(SETTINGS.lateColumn).first().waitFor({ timeout: 30000 });
}

// The events table (a grid): the names are in one block of rows and the
// checkboxes in another, row by row in the same order (and with the same
// row-index). The columns are found by their header (חיסור יומי / איחור בוקר).
async function readGrid(page){
  return page.evaluate(({ late, absent }) => {
    const hasHebrew = (t) => /[\u05d0-\u05ea]/.test(t);
    const grid = document.querySelector('[role="grid"]');
    if (!grid) return { error: 'no grid' };
    const groups = [...grid.querySelectorAll('[role="rowgroup"]')];
    let nameRows = null, boxRows = null, header = null;
    for (const g of groups){
      const rows = [...g.querySelectorAll('[role="row"]')];
      if (!rows.length) continue;
      if (rows.some(r => r.querySelector('[role="columnheader"]'))){
        if (rows.some(r => r.innerText.includes(late) && r.innerText.includes(absent))) header = rows.find(r => r.innerText.includes(late));
        continue;
      }
      if (rows.every(r => r.querySelector('input[type="checkbox"], [role="checkbox"]'))) boxRows = rows;
      else if (rows.some(r => hasHebrew(r.innerText))) nameRows = rows;
    }
    if (!nameRows || !boxRows || !header) return { error: 'grid parts not found' };
    const heads = [...header.querySelectorAll('[role="columnheader"]')];
    const lateCol = heads.findIndex(h => h.innerText.includes(late));
    const absentCol = heads.findIndex(h => h.innerText.includes(absent));
    const lateId = heads[lateCol] && heads[lateCol].getAttribute('col-id');
    const absentId = heads[absentCol] && heads[absentCol].getAttribute('col-id');
    const byIndex = (r, i) => r.getAttribute('row-index') || String(i);
    const boxByKey = new Map(boxRows.map((r, i) => [byIndex(r, i), r]));
    // A unique mark on each checkbox cell, so it can be clicked from outside.
    const out = [];
    nameRows.forEach((r, i) => {
      const key = byIndex(r, i);
      const br = boxByKey.get(key) || boxRows[i];
      if (!br) return;
      const cells = [...br.querySelectorAll('[role="gridcell"]')];
      const cellOf = (id, col) => (id && br.querySelector('[col-id="' + id + '"]')) || cells[col];
      const lc = cellOf(lateId, lateCol), ac = cellOf(absentId, absentCol);
      if (lc) lc.setAttribute('data-mashov-cell', 'late-' + i);
      if (ac) ac.setAttribute('data-mashov-cell', 'absent-' + i);
      out.push({ i, name: r.innerText.trim(), late: lc ? lc.innerText.trim() : null, absent: ac ? ac.innerText.trim() : null });
    });
    return { rows: out };
  }, { late: SETTINGS.lateColumn, absent: SETTINGS.absentColumn });
}

async function markEvents(page, statuses, step){
  step('סימון איחורים וחיסורים');
  // The table may still be filling: read it until it has its rows.
  let grid = { error: 'not read' };
  for (let i = 0; i < 20; i++){
    grid = await readGrid(page);
    if (!grid.error && grid.rows.length) break;
    await page.waitForTimeout(500);
  }
  if (grid.error) throw new Error('טבלת האירועים במשוב לא זוהתה (' + grid.error + ') - לא סומן כלום.');
  const report = [];
  const todo = []; // [cell mark, report entry]
  let problems = 0;
  for (const s of statuses){
    if (s.status === 'ontime'){ report.push({ name: s.family, status: 'בזמן', action: '—' }); continue; }
    const label = s.status === 'late' ? 'איחור' : 'חיסור';
    if (!s.family){ problems++; report.push({ name: '(תלמיד ' + s.id + ')', status: label, action: 'אין שם משפחה באתר - לא סומן' }); continue; }
    const matches = grid.rows.filter(r => norm(r.name).startsWith(norm(s.family) + ' ') || norm(r.name) === norm(s.family));
    if (matches.length !== 1){
      problems++;
      report.push({ name: s.family, status: label, action: matches.length ? 'נמצאו כמה תלמידים בשם הזה - לא סומן' : 'לא נמצא במשוב - לא סומן' });
      continue;
    }
    const row = matches[0];
    const kind = s.status === 'late' ? 'late' : 'absent';
    if (row[kind] === null){ problems++; report.push({ name: row.name, status: label, action: 'לא נמצאה התיבה - לא סומן' }); continue; }
    const entry = { name: row.name, status: label, action: '' };
    report.push(entry);
    todo.push([kind + '-' + row.i, entry]);
  }
  // (The small numbers next to a box are earlier events, not this lesson's.)
  const results = await page.evaluate((marks) => marks.map(m => {
    const cell = document.querySelector('[data-mashov-cell="' + m + '"]');
    const input = cell && cell.querySelector('input[type="checkbox"]');
    if (!input) return 'missing';
    if (input.checked) return 'already';
    input.click();
    return input.checked ? 'ok' : 'notyet';
  }), todo.map(t => t[0]));
  for (let i = 0; i < todo.length; i++){
    const [mark, entry] = todo[i];
    let r = results[i];
    if (r === 'notyet' || r === 'missing'){
      // The quick way did not take: the usual (slower) click, and a check.
      const box = page.locator('[data-mashov-cell="' + mark + '"]').getByRole('checkbox').first();
      try{ if (!(await box.isChecked())) await box.check({ timeout: 5000 }); r = (await box.isChecked()) ? 'ok' : 'fail'; } catch(e){ r = 'fail'; }
    }
    if (r === 'fail'){ problems++; entry.action = 'לא הצליח לסמן'; }
    else entry.action = r === 'already' ? 'כבר מסומן' : 'סומן';
  }
  return { report, problems };
}

async function save(page, step){
  step('שמירה');
  await page.getByRole('button', { name: 'שמירה', exact: true }).locator('visible=true').first().click();
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

module.exports = { SETTINGS, handleCookies, handleLock, unlockIfLocked, israelToday, boardStatuses, statusesOf, dayOf, openLessonOnDate, reuseSession, captureSession, sessionInitScript, login, openTodaysLesson, fillLesson, markEvents, save };

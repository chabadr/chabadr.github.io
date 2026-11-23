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
function boardStatuses(main, today){
  if (main.lastActivityDate !== today.iso) throw new Error('הלוח של הכיתה עוד לא מולא היום (' + today.dmy + ') - לא סומן כלום.');
  const names = main.metivtaNames || {};
  const out = [];
  let present = 0;
  for (const st of (main.students || [])){
    const c = st.cats || {};
    const onTime = (c.c1 || 0) > 0 || (c.c7 || 0) > 0;
    const otherMark = Object.keys(c).some(k => k !== 'c1' && k !== 'c7' && (c[k] || 0) !== 0)
      || (st.minusTotal || 0) !== 0 || (st.purchases || 0) > 0
      || !!(st.frequent && ((st.frequent.mikvaot || 0) > 0 || (st.frequent.rambam || 0) > 0));
    const status = onTime ? 'ontime' : otherMark ? 'late' : 'absent';
    if (status !== 'absent') present++;
    const n = names[st.id];
    out.push({ id: st.id, family: NAME_IN_MASHOV[st.id] || (n && typeof n === 'object' ? n.family : '') || '', status });
  }
  if (!present) throw new Error('אף תלמיד לא מסומן בלוח היום - כנראה הלוח עוד לא מולא. לא סומן כלום.');
  return out;
}

async function dismissCookies(page){
  const btn = page.getByRole('button', { name: 'עוגיות חיוניות בלבד' });
  try{ await btn.waitFor({ timeout: 8000 }); await btn.click(); } catch(e){}
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
  const item = page.getByText(SETTINGS.lessonText).last();
  try{ await item.waitFor({ timeout: 30000 }); }
  catch(e){ throw new Error('שיעור תפילה ז2 לא נמצא ב"המערכת להיום" - אולי אין שיעור היום. לא סומן כלום.'); }
  await item.click();
  const header = page.getByText('בתאריך:').first();
  await header.waitFor({ timeout: 30000 });
  const text = norm(await page.getByRole('tabpanel').first().innerText());
  if (!text.includes(today.dmy) || !text.includes(SETTINGS.lessonGroup)){
    throw new Error('השיעור שנפתח אינו שיעור התפילה של היום (' + today.dmy + ') - לא סומן כלום.');
  }
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
  await page.waitForTimeout(1500);
  const grid = await readGrid(page);
  if (grid.error) throw new Error('טבלת האירועים במשוב לא זוהתה (' + grid.error + ') - לא סומן כלום.');
  const report = [];
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
    const cellText = row[kind];
    if (cellText === null){ problems++; report.push({ name: row.name, status: label, action: 'לא נמצאה התיבה - לא סומן' }); continue; }
    if (/\d/.test(cellText)){ report.push({ name: row.name, status: label, action: 'כבר רשום במשוב - לא סומן שוב' }); continue; }
    const box = page.locator('[data-mashov-cell="' + kind + '-' + row.i + '"]').getByRole('checkbox').first();
    if (!(await box.isChecked())) await box.check();
    report.push({ name: row.name, status: label, action: 'סומן' });
  }
  return { report, problems };
}

async function save(page, step){
  step('שמירה');
  await page.getByRole('button', { name: 'שמירה', exact: true }).locator('visible=true').first().click();
  await page.waitForTimeout(5000);
}

module.exports = { SETTINGS, israelToday, boardStatuses, login, openTodaysLesson, fillLesson, markEvents, save };

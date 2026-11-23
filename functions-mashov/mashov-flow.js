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

async function columnIndex(page, text){
  const headers = page.getByRole('columnheader');
  const n = await headers.count();
  for (let i = 0; i < n; i++){
    if ((await headers.nth(i).innerText()).includes(text)) return i;
  }
  return -1;
}

async function markEvents(page, statuses, step){
  step('סימון איחורים וחיסורים');
  const lateIdx = await columnIndex(page, SETTINGS.lateColumn);
  const absentIdx = await columnIndex(page, SETTINGS.absentColumn);
  const search = page.getByRole('textbox', { name: 'חיפוש' }).or(page.getByPlaceholder('חיפוש')).first();
  const report = [];
  let problems = 0;
  for (const s of statuses){
    if (s.status === 'ontime'){ report.push({ name: s.family, status: 'בזמן', action: '—' }); continue; }
    const label = s.status === 'late' ? 'איחור' : 'חיסור';
    if (!s.family){ problems++; report.push({ name: '(תלמיד ' + s.id + ')', status: label, action: 'אין שם משפחה באתר - לא סומן' }); continue; }
    await search.fill(searchTermOf(s.family));
    await page.waitForTimeout(500);
    const rows = page.getByRole('row').filter({ has: page.getByRole('checkbox') });
    const matches = [];
    const count = await rows.count();
    for (let i = 0; i < count; i++){
      const text = norm(await rows.nth(i).innerText());
      if (text.startsWith(norm(s.family) + ' ')) matches.push(rows.nth(i));
    }
    if (matches.length !== 1){
      problems++;
      report.push({ name: s.family, status: label, action: matches.length ? 'נמצאו כמה תלמידים בשם הזה - לא סומן' : 'לא נמצא במשוב - לא סומן' });
      continue;
    }
    const row = matches[0];
    const idx = s.status === 'late' ? lateIdx : absentIdx;
    let cell = idx >= 0 ? row.getByRole('cell').nth(idx) : null;
    if (cell && !(await cell.count())) cell = null;
    const box = cell ? cell.getByRole('checkbox') : row.getByRole('checkbox').nth(s.status === 'late' ? 0 : 1);
    const cellText = cell ? norm(await cell.innerText()) : '';
    const name = norm(await row.getByRole('cell').first().innerText().catch(() => s.family)) || s.family;
    if (/\d/.test(cellText)){ report.push({ name, status: label, action: 'כבר רשום במשוב - לא סומן שוב' }); continue; }
    if (!(await box.isChecked())) await box.check();
    report.push({ name, status: label, action: 'סומן' });
  }
  await search.fill('');
  await page.waitForTimeout(500);
  return { report, problems };
}

async function save(page, step){
  step('שמירה');
  await page.getByRole('button', { name: 'שמירה', exact: true }).locator('visible=true').first().click();
  await page.waitForTimeout(5000);
}

module.exports = { SETTINGS, israelToday, boardStatuses, login, openTodaysLesson, fillLesson, markEvents, save };

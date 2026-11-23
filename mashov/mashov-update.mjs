// Fills the morning prayer attendance in Mashov (משו"ב) from the class board
// of כיתה ז. Runs on a Windows computer with Edge (Playwright drives Edge).
// It fills the lesson and marks the students - and leaves Mashov open: the
// saving is done by hand (the "שמירה" button).
//
//   node mashov-update.mjs          fills the attendance (no saving)
//   node mashov-update.mjs --login  sets / changes the saved Mashov login
//
// The rule (today's live board):
//   marked at 8:10 or at 8:45              -> on time, nothing is marked
//   any other mark today (another column)  -> איחור בוקר
//   no mark at all                         -> חיסור יומי
// A student who is not found in Mashov is listed in a report and not marked.

import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGIN_FILE = join(HERE, 'login.json');       // the password is encrypted for this Windows user only
const PROFILE_DIR = join(HERE, 'edge-profile');
const REPORT_FILE = join(HERE, 'report.html');

// ---------------------------------------------------------------- settings
const SETTINGS = {
  loginUrl: 'https://web.mashov.info/teachers/login',
  schoolSearch: 'רחובו',
  schoolOption: 'ממ"ד חב"ד בנים- רחובות',
  lessonName: 'תפילה',
  lessonGroup: '2278',
  topic: 'נוכחות',
  lessonMode: 'פיזי',
  lateColumn: 'איחור בוקר',
  absentColumn: 'חיסור יומי',
  boardDocUrl: 'https://firestore.googleapis.com/v1/projects/point-3a9cf/databases/(default)/documents/classroom_points/classroom-points-v1'
};
// A family name that is written differently in Mashov: board student id -> the name in Mashov.
const NAME_IN_MASHOV = {
  2: 'גורפי'
};

const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------- helpers
function israelDate(d = new Date()){
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'short' }).formatToParts(d);
  const g = (t) => (p.find(x => x.type === t) || {}).value;
  return { dmy: g('day') + '/' + g('month') + '/' + g('year'), iso: g('year') + '-' + g('month') + '-' + g('day'), weekday: g('weekday') };
}
const norm = (s) => String(s || '').replace(/['׳"״`]/g, '').replace(/\s+/g, ' ').trim();
const searchTermOf = (name) => norm(String(name).split(/['׳"״`]/)[0]);

function powershell(command, env){
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}
// The password is kept encrypted with Windows (DPAPI): only this Windows user on this computer can read it.
function encrypt(text){
  return powershell('ConvertFrom-SecureString (ConvertTo-SecureString $env:MASHOV_PLAIN -AsPlainText -Force)', { MASHOV_PLAIN: text });
}
function decrypt(blob){
  return powershell('$s = ConvertTo-SecureString $env:MASHOV_ENC; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))', { MASHOV_ENC: blob });
}

function ask(question, hidden){
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let s = '';
    stdin.setEncoding('utf8');
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk){
        if (ch === '\r' || ch === '\n'){
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(s);
          return;
        }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\b' || ch === '\x7f') s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function setLogin(){
  console.log('Mashov login (saved encrypted on this computer only)');
  const user = (await ask('Mashov user name: ', false)).trim();
  const pass = await ask('Mashov password (hidden): ', true);
  if (!user || !pass) throw new Error('No user name or password - nothing saved.');
  writeFileSync(LOGIN_FILE, JSON.stringify({ user, pass: encrypt(pass) }));
  console.log('Saved.');
}

function readLogin(){
  if (!existsSync(LOGIN_FILE)) return null;
  const j = JSON.parse(readFileSync(LOGIN_FILE, 'utf8'));
  return { user: j.user, pass: decrypt(j.pass) };
}

// Firestore REST values -> plain values.
function fsVal(v){
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsVal);
  if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
  return null;
}
function fsFields(f){
  const o = {};
  for (const k of Object.keys(f)) o[k] = fsVal(f[k]);
  return o;
}

// Today's statuses from the class board: [{ id, family, status: 'late' | 'absent' }]
async function boardStatuses(today){
  const res = await fetch(SETTINGS.boardDocUrl);
  if (!res.ok) throw new Error('Could not read the class board (' + res.status + ')');
  const main = fsFields((await res.json()).fields || {});
  if (main.lastActivityDate !== today.iso) throw new Error('The class board has no data for today (' + today.iso + ') - nothing was marked.');
  const students = Array.isArray(main.students) ? main.students : [];
  const names = main.metivtaNames || {};
  const out = [];
  let present = 0;
  for (const st of students){
    const c = st.cats || {};
    const onTime = (c.c1 || 0) > 0 || (c.c7 || 0) > 0;
    // Any other mark of today: another column, a minus, a purchase, מקוואות / רמב"ם.
    const otherMark = Object.keys(c).some(k => k !== 'c1' && k !== 'c7' && (c[k] || 0) !== 0)
      || (st.minusTotal || 0) !== 0 || (st.purchases || 0) > 0
      || !!(st.frequent && ((st.frequent.mikvaot || 0) > 0 || (st.frequent.rambam || 0) > 0));
    const status = onTime ? 'ontime' : otherMark ? 'late' : 'absent';
    if (status !== 'absent') present++;
    const n = names[st.id];
    const family = NAME_IN_MASHOV[st.id] || (n && typeof n === 'object' ? n.family : '') || '';
    out.push({ id: st.id, family, status });
  }
  if (!present) throw new Error('Nobody is marked on the board today - it was probably not filled yet. Nothing was marked.');
  return out;
}

function writeReport(title, rows, note){
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>משוב - דוח</title>'
    + '<body style="font-family:Arial;margin:24px"><h2>' + esc(title) + '</h2>' + (note ? '<p>' + esc(note) + '</p>' : '')
    + '<table border="1" cellpadding="6" style="border-collapse:collapse">'
    + '<tr><th>תלמיד (משוב)</th><th>מה נמצא באתר</th><th>מה נעשה</th></tr>'
    + rows.map(r => '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.status) + '</td><td>' + esc(r.action) + '</td></tr>').join('')
    + '</table></body></html>';
  writeFileSync(REPORT_FILE, html);
  spawn('cmd.exe', ['/c', 'start', '', REPORT_FILE], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- Mashov
async function login(page, creds){
  await page.goto(SETTINGS.loginUrl);
  await page.getByText('הזדהות משו"ב').click();
  const school = page.getByRole('combobox', { name: 'ביה"ס' });
  await school.click();
  await school.fill(SETTINGS.schoolSearch);
  await page.getByText(SETTINGS.schoolOption).first().click();
  await page.getByRole('textbox', { name: 'שם משתמש / ת.ז' }).fill(creds.user);
  await page.getByRole('textbox', { name: 'סיסמה (משו"ב)' }).fill(creds.pass);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await page.getByRole('button', { name: 'הזנת נתוני שיעור' }).waitFor({ timeout: 60000 });
}

// The תפילה lesson in today's column of the timetable.
async function openTodaysLesson(page, today){
  await page.getByRole('button', { name: 'הזנת נתוני שיעור' }).click();
  const header = page.getByText(today.dmy, { exact: true }).first();
  try{ await header.waitFor({ timeout: 30000 }); }
  catch(e){ throw new Error('Today (' + today.dmy + ') is not in the timetable.'); }
  const hb = await header.boundingBox();
  if (!hb) throw new Error('Today (' + today.dmy + ') is not in the timetable.');
  const hx = hb.x + hb.width / 2;
  const cands = page.getByText(SETTINGS.lessonName, { exact: true });
  const n = await cands.count();
  for (let i = 0; i < n; i++){
    const c = cands.nth(i);
    const b = await c.boundingBox();
    if (!b) continue;
    const inColumn = Math.abs((b.x + b.width / 2) - hx) < Math.max(hb.width, b.width) / 2 + 20;
    if (!inColumn) continue;
    const cell = c.locator('xpath=ancestor::*[contains(normalize-space(.), "' + SETTINGS.lessonGroup + '")][1]');
    if (!(await cell.count())) continue;
    await c.click();
    return;
  }
  throw new Error('The ' + SETTINGS.lessonName + ' lesson (' + SETTINGS.lessonGroup + ') was not found in today\'s column (' + today.dmy + ').');
}

async function fillLesson(page){
  const topic = page.getByRole('textbox', { name: 'נושא שיעור' });
  await topic.waitFor({ timeout: 30000 });
  await topic.fill(SETTINGS.topic);
  await page.getByRole('radio', { name: SETTINGS.lessonMode }).check();
  await page.getByRole('button', { name: 'הזנת ארועי התנהגות' }).locator('visible=true').first().click();
  await page.getByText(SETTINGS.lateColumn).first().waitFor({ timeout: 30000 });
}

// The column number of a header text in the events table.
async function columnIndex(page, text){
  const headers = page.getByRole('columnheader');
  const n = await headers.count();
  for (let i = 0; i < n; i++){
    if ((await headers.nth(i).innerText()).includes(text)) return i;
  }
  return -1;
}

async function markEvents(page, statuses){
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
    await page.waitForTimeout(400);
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
    if (!cell || !(await cell.count())) cell = null;
    const box = cell ? cell.getByRole('checkbox') : row.getByRole('checkbox').nth(s.status === 'late' ? 0 : 1);
    const cellText = cell ? norm(await cell.innerText()) : '';
    const name = norm(await row.getByRole('cell').first().innerText().catch(() => s.family)) || s.family;
    if (/\d/.test(cellText)){ report.push({ name, status: label, action: 'כבר רשום במשוב - לא סומן שוב' }); continue; }
    if (!(await box.isChecked())) await box.check();
    report.push({ name, status: label, action: 'סומן' });
  }
  await search.fill('');
  return { report, problems };
}

// ---------------------------------------------------------------- main
async function main(){
  if (args.has('--login')){ await setLogin(); return; }
  let creds = readLogin();
  if (!creds){ await setLogin(); creds = readLogin(); }
  const today = israelDate();
  const statuses = await boardStatuses(today);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'msedge', headless: false, viewport: null, locale: 'he-IL' });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  try{
    await login(page, creds);
    await openTodaysLesson(page, today);
    await fillLesson(page);
    const { report, problems } = await markEvents(page, statuses);
    writeReport('הנוכחות מולאה - לבדוק וללחוץ "שמירה" במשוב (' + today.dmy + ')', report,
      problems ? 'יש תלמידים שלא סומנו (ראו למטה) - לסמן אותם ידנית לפני השמירה.' : 'כל התלמידים סומנו. משוב נשאר פתוח לשמירה.');
    // Edge stays open for the saving by hand.
  } catch(e){
    writeReport('שגיאה - הנוכחות לא מולאה (' + today.dmy + ')', [], String((e && e.message) || e));
    throw e;
  }
}

export { boardStatuses, openTodaysLesson, fillLesson, markEvents, israelDate, SETTINGS };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => {
  const msg = String((e && e.message) || e);
  console.error(msg);
  if (!existsSync(REPORT_FILE) || !readFileSync(REPORT_FILE, 'utf8').includes(msg)) writeReport('הנוכחות לא מולאה', [], msg);
  process.exitCode = 1;
});

// Syntax check of every script in the site: the inline <script type="module">
// of each page, the .js files and the server functions. Run: node tests/check.mjs
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'check-'));
let failed = 0;
function check(label, file){
  try{ execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); console.log('ok   ' + label); }
  catch(e){ failed++; console.log('FAIL ' + label + '\n' + String(e.stderr || e.message)); }
}

for (const f of readdirSync('.').filter((n) => n.endsWith('.html'))){
  const html = readFileSync(f, 'utf8');
  [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].forEach((m, i) => {
    const out = join(tmp, f + '.' + i + '.mjs');
    writeFileSync(out, m[1]);
    check(f + ' (script ' + (i + 1) + ')', out);
  });
}
for (const f of readdirSync('.').filter((n) => n.endsWith('.js'))){
  const out = join(tmp, f.replace(/\.js$/, '.mjs'));
  writeFileSync(out, readFileSync(f, 'utf8'));
  check(f, out);
}
for (const f of readdirSync('functions').filter((n) => n.endsWith('.js'))) check('functions/' + f, join('functions', f));

if (failed){ console.log(failed + ' failed'); process.exit(1); }
console.log('all scripts are valid');

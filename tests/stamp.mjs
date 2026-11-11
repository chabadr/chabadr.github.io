// Gives each CSS/JS file of the pages a version made of its content, so a
// browser never mixes an old script with a new page. Run before committing:
// node tests/stamp.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
for (const page of ['index.html', 'admin.html']){
  let html = readFileSync(page, 'utf8');
  html = html.replace(/(href|src)="([\w.-]+\.(?:css|js))\?v=[^"]*"/g, (all, attr, file) => {
    if (!existsSync(file)) return all;
    const v = createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 8);
    return attr + '="' + file + '?v=' + v + '"';
  });
  writeFileSync(page, html);
}
console.log('stamped');

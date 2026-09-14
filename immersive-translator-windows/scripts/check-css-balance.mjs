// Balance-check every source CSS file: an unclosed rule swallows all following
// rules at bundle time (nested-selector prefixing), which is how quickreview.css
// and reminder.css went dead in the packaged app.
import fs from "fs";
import path from "path";

const roots = ["src"];
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".css")) files.push(p);
  }
}
walk(roots[0]);

let bad = 0;
for (const f of files) {
  const css = fs.readFileSync(f, "utf8");
  let depth = 0, inStr = false, strCh = "", inComment = false, line = 1;
  const openLines = [];
  for (let i = 0; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (c === "\n") line++;
    if (inComment) { if (c === "*" && n === "/") { inComment = false; i++; } continue; }
    if (inStr) { if (c === strCh && css[i - 1] !== "\\") inStr = false; continue; }
    if (c === "/" && n === "*") { inComment = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "{") { depth++; openLines.push(line); }
    if (c === "}") { depth--; openLines.pop(); if (depth < 0) { console.log(`BAD ${f}: extra } at line ${line}`); bad++; depth = 0; } }
  }
  if (openLines.length > 0) {
    console.log(`BAD ${f}: ${openLines.length} unclosed '{{' at lines ${openLines.join(", ")}`);
    bad++;
  }
}
console.log(bad === 0 ? `OK: ${files.length} css files balanced` : `${bad} problem file(s)`);

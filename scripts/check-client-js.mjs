// Client scripts live inside template literals, so a stray backslash is eaten before it
// reaches the browser: /\/series\/(\d+)/ once shipped as //series/(d+)/, which is a line
// comment, and silently killed the whole browse page. This parses every String.raw block.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const dir = "src/ui";
let checked = 0, bad = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
  const src = readFileSync(join(dir, f), "utf8");
  const re = /String\.raw`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const js = m[1].replace(/\$\{[^}]*\}/g, '"x"');   // placeholders stand in for values
    const tmp = join(mkdtempSync(join(tmpdir(), "cjs-")), "block.js");
    writeFileSync(tmp, js);
    checked++;
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (err) {
      bad++;
      console.error(`\n${f}: client script does not parse\n${String(err.stderr ?? err).slice(0, 700)}`);
    }
  }
}
console.log(`client scripts checked: ${checked}, failing: ${bad}`);
process.exit(bad > 0 ? 1 : 0);

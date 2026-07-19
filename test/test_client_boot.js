/**
 * Client boot smoke test — loads the page script under a minimal DOM stub and
 * asserts the core render functions exist and run without ReferenceError.
 * Catches "app freezes on login" caused by a missing/undefined UI function.
 */
const fs = require("fs");
const path = require("path");
const h = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
let js = h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];

const el = () => ({ classList:{add(){},remove(){},toggle(){}}, style:{setProperty(){},background:""},
  querySelectorAll:()=>[], querySelector:()=>null, addEventListener(){}, setAttribute(){}, getAttribute:()=>null,
  set innerHTML(v){}, get innerHTML(){return"";}, textContent:"", value:"fr", appendChild(){}, children:[], focus(){} });
global.document = { documentElement:{style:{setProperty(){}},lang:""}, body:{classList:{toggle(){},add(){},remove(){}},querySelectorAll:()=>[]},
  getElementById:()=>el(), querySelectorAll:()=>[], querySelector:()=>null, createTreeWalker:()=>({nextNode:()=>null}),
  createElement:()=>el(), addEventListener(){} };
global.window = { addEventListener(){} };
global.location = { reload(){}, href:"" };
global.sessionStorage = { getItem:()=>null, setItem(){}, clear(){} };
global.localStorage = { getItem:()=>"fr", setItem(){} };
global.fetch = () => Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve([]), headers:{get:()=>null} });
global.setInterval = () => 0; global.MutationObserver = class { observe(){} };
global.alert = () => {}; global.confirm = () => true; global.prompt = () => null; global.FormData = class { append(){} };

js += "\n;globalThis.__esc=typeof esc!=='undefined'?esc:null;globalThis.__go=typeof go!=='undefined'?go:null;globalThis.__ab=typeof applyBranding!=='undefined'?applyBranding:null;globalThis.__asc=typeof applySectionColor!=='undefined'?applySectionColor:null;globalThis.__t=typeof t!=='undefined'?t:null;";

let pass = 0, fail = 0;
const chk = (c, l) => { if (c) { pass++; console.log("PASS: " + l); } else { fail++; console.log("FAIL: " + l); } };

try { new Function(js)(); chk(true, "page script loads without error"); }
catch (e) { chk(false, "page script loads without error — " + e.message); console.log("\nRESULT: 0 passed, 1 failed"); process.exit(1); }

chk(!!globalThis.__go, "go() defined");
chk(!!globalThis.__ab, "applyBranding() defined");
chk(!!globalThis.__asc, "applySectionColor() defined");
chk(!!globalThis.__t, "t() translator defined");
try { globalThis.__asc("dash"); globalThis.__asc("career"); chk(true, "applySectionColor runs on navigation (no throw)"); }
catch (e) { chk(false, "applySectionColor throws — " + e.message); }
try { globalThis.__ab({ colors:{ primary:"#123456", accent:"#abcdef" }, appName:"X" }); chk(true, "applyBranding runs (no throw)"); }
catch (e) { chk(false, "applyBranding throws — " + e.message); }

chk(!!globalThis.__esc, "esc() defined");
if (globalThis.__esc) {
  chk(globalThis.__esc("<img src=x onerror=alert(1)>") === "&lt;img src=x onerror=alert(1)&gt;", "esc neutralises HTML tags");
  chk(globalThis.__esc('a"b\'c') === "a&quot;b&#39;c", "esc neutralises quotes (attribute safety)");
  chk(globalThis.__esc(null) === "" && globalThis.__esc(42) === "42", "esc handles null/number");
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

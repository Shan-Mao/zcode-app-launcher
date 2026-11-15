#!/usr/bin/env node
// Install / inspect / remove the launcher injection in ZCode's app.asar.
//
//   node patcher.mjs --check
//   node patcher.mjs --apply
//   node patcher.mjs --revert
//   node patcher.mjs --apply --asar "D:\path\resources\app.asar"
//
// Components:
//   out/renderer/index.html          <script> tag for the sidebar UI
//   out/renderer/zcode-app-launcher.js   toolbar + config panel
//   out/preload/index.cjs            three IPC bridge methods
//   out/main/index.js                three ipcMain handlers (read/write config, launch)
//
// No background process is started: the chain runs inside ZCode's main process
// when a button is clicked.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readHeader, entryMap, readEntry, repack, fileSha256, asarVersion } from "./lib/asar.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = "out/renderer/index.html";
const SCRIPT_PATH = "out/renderer/zcode-app-launcher.js";
const PRELOAD_PATH = "out/preload/index.cjs";
const MAIN_PATH = "out/main/index.js";
const SCRIPT_SRC = path.join(HERE, "renderer", "zcode-app-launcher.js");
const TAG = '<script src="./zcode-app-launcher.js"></script>';
const MARK_BEGIN = "/*zl:begin*/";
const MARK_END = "/*zl:end*/";
const PRELOAD_ANCHOR = /(\w+)\.contextBridge\.exposeInMainWorld\("zcode",\{/;
const MAIN_ANCHOR = /(\w+)\.handle\(\w+\.SaveMcpToUserDirectory/;
const BLOCK_RE = /\/\*zl:begin\*\/[\s\S]*?\/\*zl:end\*\//;

function parseArgs(argv) {
  const args = { mode: "check", asar: "", force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.mode = "apply";
    else if (a === "--check") args.mode = "check";
    else if (a === "--revert" || a === "--remove") args.mode = "revert";
    else if (a === "--force") args.force = true;
    else if (a === "--asar") args.asar = argv[++i] || "";
    else if (a === "--zcode") args.zcode = argv[++i] || "";
    else if (a === "--help" || a === "-h") args.mode = "help";
    else if (!a.startsWith("-")) args.asar = a;
  }
  return args;
}

function candidateAsars() {
  const out = [];
  const push = (p) => {
    if (p && fs.existsSync(p) && !out.includes(p)) out.push(p);
  };
  if (process.env.ZCODE_ASAR) push(process.env.ZCODE_ASAR);
  if (process.env.ZCODE_HOME) push(path.join(process.env.ZCODE_HOME, "resources", "app.asar"));
  const roots = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "ZCode"),
    path.join(process.env.PROGRAMFILES || "", "ZCode"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "ZCode"),
  ];
  for (const root of roots) if (root) push(path.join(root, "resources", "app.asar"));

  // Fall back to the uninstall registry entry, so custom install locations work
  // without shipping anyone's absolute path.
  try {
    const script =
      "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | " +
      "ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; " +
      "if ($p.DisplayName -like '*ZCode*' -and $p.InstallLocation) { $p.InstallLocation } }";
    const found = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    for (const line of found.split(/\r?\n/)) {
      const dir = line.trim();
      if (dir) push(path.join(dir, "resources", "app.asar"));
    }
  } catch {}
  return out;
}

function resolveAsar(args) {
  if (args.asar) {
    const p = path.resolve(args.asar);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
    return path.join(p, "resources", "app.asar");
  }
  if (args.zcode) return path.join(path.resolve(args.zcode), "resources", "app.asar");
  const found = candidateAsars();
  if (found.length) return found[0];
  throw new Error("找不到 ZCode 的 app.asar。用 --asar <路径> 指定，或设置环境变量 ZCODE_ASAR。");
}

function isZCodeRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return /ZCode\.exe/i.test(out);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ code blocks
function preloadBlock(alias) {
  const ipc = `${alias}.ipcRenderer.invoke`;
  return (
    MARK_BEGIN +
    `launcherGetConfig:function(){return ${ipc}("zcode-launcher:get-config")},` +
    `launcherSetConfig:function(t){return ${ipc}("zcode-launcher:set-config",t)},` +
    `launcherLaunch:function(t){return ${ipc}("zcode-launcher:launch",t)},` +
    `launcherPickProgram:function(){return ${ipc}("zcode-launcher:pick-program")},` +
    `launcherPickFolder:function(){return ${ipc}("zcode-launcher:pick-folder")},` +
    MARK_END
  );
}

function mainBlock(ipc) {
  const helper = `
function __zlSan(raw){
  var out={port:0,buttons:[]},seen={};
  var list=raw&&Array.isArray(raw.buttons)?raw.buttons.slice(0,50):[];
  for(var i=0;i<list.length;i++){
    var it=list[i];if(!it||typeof it!="object")continue;
    var id=String(it.id||"").trim().slice(0,64)||("button-"+(out.buttons.length+1));
    if(seen[id])continue;seen[id]=1;
    var steps=[],ss=Array.isArray(it.steps)?it.steps.slice(0,12):[];
    for(var j=0;j<ss.length;j++){
      var st=ss[j]||{},run=String(st.run||"").trim();
      if(!run||run.length>2000)continue;
      steps.push({run:run,delayMs:Math.max(0,Number(st.delayMs)||0)});
    }
    out.buttons.push({id:id,label:String(it.label||id).slice(0,40),icon:String(it.icon||"▸").slice(0,8),cwd:String(it.cwd||"").slice(0,400),steps:steps});
  }
  return out;
}
function __zlCtx(){
  return Promise.all([import("node:fs"),import("node:path"),import("node:os")]).then(function(m){
    var f=m[0],p=m[1],o=m[2];
    var dir=p.join(process.env.APPDATA||p.join(o.homedir(),"AppData","Roaming"),"zcode-app-launcher");
    return {f:f,p:p,o:o,dir:dir,file:p.join(dir,"config.json")};
  });
}
var __zlDef={port:0,buttons:[
  {id:"explorer",label:"资源管理器",icon:"📁",cwd:"",steps:[{run:'"explorer.exe" .',delayMs:0}]},
  {id:"calc",label:"计算器",icon:"🧮",cwd:"",steps:[{run:'"calc.exe"',delayMs:0}]}
]};
function __zlRead(ctx){
  try{ctx.f.mkdirSync(ctx.dir,{recursive:true})}catch(e){}
  var raw;
  try{raw=JSON.parse(ctx.f.readFileSync(ctx.file,"utf8"))}
  catch(e){raw=__zlDef;try{ctx.f.writeFileSync(ctx.file,JSON.stringify(__zlDef,null,2))}catch(e2){}}
  return __zlSan(raw);
}
`;
  const handlers = `
${ipc}.handle("zcode-launcher:get-config",function(){
  return __zlCtx().then(function(c){return __zlRead(c)}).catch(function(){return {port:0,buttons:[]}});
});
${ipc}.handle("zcode-launcher:set-config",function(ev,cfg){
  return __zlCtx().then(function(c){
    var clean=__zlSan(cfg);
    c.f.mkdirSync(c.dir,{recursive:true});
    c.f.writeFileSync(c.file,JSON.stringify(clean,null,2));
    return clean;
  });
});
${ipc}.handle("zcode-launcher:pick-program",function(){
  return import("electron").then(function(el){
    return el.dialog.showOpenDialog({title:"选择要启动的程序",properties:["openFile"],filters:[{name:"程序",extensions:["exe","bat","cmd","lnk"]},{name:"所有文件",extensions:["*"]}]}).then(function(r){
      return r&&!r.canceled&&r.filePaths&&r.filePaths.length?r.filePaths[0]:null;
    });
  }).catch(function(){return null});
});
${ipc}.handle("zcode-launcher:pick-folder",function(){
  return import("electron").then(function(el){
    return el.dialog.showOpenDialog({title:"选择工作目录",properties:["openDirectory"]}).then(function(r){
      return r&&!r.canceled&&r.filePaths&&r.filePaths.length?r.filePaths[0]:null;
    });
  }).catch(function(){return null});
});
${ipc}.handle("zcode-launcher:launch",function(ev,id){
  return __zlCtx().then(function(c){
    var cfg=__zlRead(c);
    var btn=null;
    for(var i=0;i<cfg.buttons.length;i++){if(cfg.buttons[i].id===id){btn=cfg.buttons[i];break}}
    if(!btn)return {ok:false,error:"未知按钮："+id};
    if(!btn.steps.length)return {ok:false,error:"这个按钮还没有配置命令"};
    return import("node:child_process").then(function(cp){
      var cwd=btn.cwd||c.o.homedir();
      try{if(!c.f.existsSync(cwd))cwd=c.o.homedir()}catch(e){cwd=c.o.homedir()}
      var k=0;
      function next(){
        if(k>=btn.steps.length)return Promise.resolve({ok:true});
        var step=btn.steps[k++];
        try{
          var child=cp.spawn("cmd.exe",["/d","/s","/c",step.run],{cwd:cwd,detached:true,stdio:"ignore",windowsHide:true});
          child.on("error",function(){});
          child.unref();
        }catch(e){return Promise.resolve({ok:false,error:String(e&&e.message||e)})}
        var wait=Math.min(Number(step.delayMs)||0,15000);
        return wait>0?new Promise(function(r){setTimeout(r,wait)}).then(next):next();
      }
      return next();
    });
  }).catch(function(e){return {ok:false,error:String(e&&e.message||e)}});
});
`;
  return `${MARK_BEGIN}(function(){
${helper}${handlers}})(),${MARK_END}`;
}

function stripBlock(text) {
  return text.replace(BLOCK_RE, "");
}

function insertPreload(text, alias) {
  const clean = stripBlock(text);
  const m = PRELOAD_ANCHOR.exec(clean);
  if (!m) return null;
  const at = m.index + m[0].length;
  return clean.slice(0, at) + preloadBlock(alias) + clean.slice(at);
}

function insertMain(text, alias) {
  const clean = stripBlock(text);
  const m = MAIN_ANCHOR.exec(clean);
  if (!m) return null;
  return clean.slice(0, m.index) + mainBlock(alias) + clean.slice(m.index);
}

// ------------------------------------------------------------------- inspection
function readState(asar) {
  const { header, dataStart } = readHeader(asar);
  const files = entryMap(header);
  const indexEntry = files.get(INDEX_PATH);
  const preloadEntry = files.get(PRELOAD_PATH);
  const mainEntry = files.get(MAIN_PATH);
  if (!indexEntry) return { ok: false, reason: `未找到 ${INDEX_PATH}` };
  if (!preloadEntry) return { ok: false, reason: `未找到 ${PRELOAD_PATH}` };
  if (!mainEntry) return { ok: false, reason: `未找到 ${MAIN_PATH}` };

  const indexBytes = readEntry(asar, dataStart, indexEntry);
  const preloadText = readEntry(asar, dataStart, preloadEntry).toString("utf8");
  const mainText = readEntry(asar, dataStart, mainEntry).toString("utf8");
  const scriptEntry = files.get(SCRIPT_PATH);
  const scriptBytes = scriptEntry ? readEntry(asar, dataStart, scriptEntry) : null;
  const srcBytes = fs.readFileSync(SCRIPT_SRC);

  const preloadAlias = PRELOAD_ANCHOR.exec(preloadText);
  const mainAlias = MAIN_ANCHOR.exec(mainText);

  const expectedPreload = preloadAlias ? insertPreload(preloadText, preloadAlias[1]) : null;
  const expectedMain = mainAlias ? insertMain(mainText, mainAlias[1]) : null;

  const tagged = indexBytes.includes(Buffer.from(TAG));
  const preloadPatched = preloadText.includes(MARK_BEGIN);
  const mainPatched = mainText.includes(MARK_BEGIN);
  const scriptOk = !!scriptBytes && scriptBytes.equals(srcBytes);
  const preloadOk = !!expectedPreload && preloadText === expectedPreload;
  const mainOk = !!expectedMain && mainText === expectedMain;

  return {
    ok: true,
    files,
    indexBytes,
    scriptEntry,
    scriptBytes,
    preloadText,
    mainText,
    preloadAlias: preloadAlias ? preloadAlias[1] : null,
    mainAlias: mainAlias ? mainAlias[1] : null,
    expectedPreload,
    expectedMain,
    tagged,
    preloadPatched,
    mainPatched,
    scriptOk,
    preloadOk,
    mainOk,
  };
}

// ---------------------------------------------------------------- backup helpers
function backupPaths(asar) {
  return { bak: `${asar}.launcher.bak`, meta: `${asar}.launcher.json` };
}

function ensureBackup(asar, version) {
  const { bak, meta } = backupPaths(asar);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(meta, "utf8"));
  } catch {}
  const size = fs.statSync(asar).size;
  if (current && current.asarSize === size && fs.existsSync(bak)) return current;
  const sha = fileSha256(asar);
  fs.copyFileSync(asar, bak);
  const record = {
    version,
    asarSize: size,
    asarSha256: sha,
    backup: path.basename(bak),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(meta, JSON.stringify(record, null, 2), "utf8");
  return record;
}

// ---------------------------------------------------------------------- actions
function apply(asar, args) {
  const st = readState(asar);
  if (!st.ok) {
    console.error(`[!] ${asar}\n    ${st.reason}`);
    return 1;
  }
  if (!st.preloadAlias) {
    console.error("[!] preload 里找不到 contextBridge 注入点，客户端结构可能已变，跳过。");
    return 1;
  }
  if (!st.mainAlias) {
    console.error("[!] main 里找不到 ipcMain 注入点，客户端结构可能已变，跳过。");
    return 1;
  }
  const installed = st.tagged && st.scriptOk && st.preloadOk && st.mainOk;
  if (installed) {
    console.log(`[=] 已安装且为最新版本，无需改动：${asar}`);
    return 0;
  }
  if (isZCodeRunning() && !args.force) {
    console.error(
      "[!] ZCode 正在运行，app.asar 被占用，无法写入。\n" +
        "    请完全退出 ZCode（含托盘），然后重新执行 --apply。"
    );
    return 2;
  }

  const indexText = st.indexBytes.toString("utf8");
  const bodyCount = indexText.split("</body>").length - 1;
  if (bodyCount !== 1) {
    console.error(`[!] index.html 里 </body> 出现 ${bodyCount} 次（期望 1），拒绝盲改。`);
    return 1;
  }

  const version = asarVersion(asar);
  const record = ensureBackup(asar, version);

  const newIndex = st.tagged
    ? st.indexBytes
    : Buffer.from(indexText.replace("</body>", `${TAG}\n</body>`), "utf8");
  const newPreload = st.expectedPreload;
  const newMain = st.expectedMain;
  if (!newPreload || !newMain) {
    console.error("[!] 生成注入块失败。");
    return 1;
  }

  const before = fs.statSync(asar).size;
  const after = repack(
    asar,
    new Map([
      [INDEX_PATH, newIndex],
      [SCRIPT_PATH, fs.readFileSync(SCRIPT_SRC)],
      [PRELOAD_PATH, Buffer.from(newPreload, "utf8")],
      [MAIN_PATH, Buffer.from(newMain, "utf8")],
    ]),
    new Set()
  );
  console.log(`[+] 已写入：${asar}`);
  console.log(`    版本 ${version || "未知"} | ${before.toLocaleString()} → ${after.toLocaleString()} 字节`);
  console.log(`    备份 ${path.basename(record.backup)}（${record.asarSize.toLocaleString()} 字节）`);
  console.log("[i] 完全重启 ZCode 后生效；整个过程不启动任何常驻进程。");
  return 0;
}

function revert(asar, args) {
  const st = readState(asar);
  if (!st.ok) {
    console.error(`[!] ${asar}\n    ${st.reason}`);
    return 1;
  }
  if (!st.tagged && !st.preloadPatched && !st.mainPatched && !st.scriptEntry) {
    console.log(`[=] 未安装，无需还原：${asar}`);
    return 0;
  }
  if (isZCodeRunning() && !args.force) {
    console.error("[!] ZCode 正在运行，请完全退出后再执行 --revert。");
    return 2;
  }

  const indexText = st.indexBytes
    .toString("utf8")
    .split(`${TAG}\n`)
    .join("")
    .split(TAG)
    .join("");
  const preloadText = stripBlock(st.preloadText);
  const mainText = stripBlock(st.mainText);

  const after = repack(
    asar,
    new Map([
      [INDEX_PATH, Buffer.from(indexText, "utf8")],
      [PRELOAD_PATH, Buffer.from(preloadText, "utf8")],
      [MAIN_PATH, Buffer.from(mainText, "utf8")],
    ]),
    new Set([SCRIPT_PATH])
  );
  console.log(`[+] 已还原：${asar}（${after.toLocaleString()} 字节）`);
  return 0;
}

function check(asar) {
  const st = readState(asar);
  if (!st.ok) {
    console.log(`[!] ${asar}\n    ${st.reason}`);
    return 1;
  }
  const version = asarVersion(asar);
  const parts = [
    st.tagged ? "界面" : "界面×",
    st.scriptOk ? "脚本" : "脚本×",
    st.preloadOk ? "桥接" : "桥接×",
    st.mainOk ? "主进程" : "主进程×",
  ];
  const installed = st.tagged && st.scriptOk && st.preloadOk && st.mainOk;
  const label = installed ? "已安装（最新）" : parts.every((p) => p.endsWith("×")) ? "未安装" : "需要更新 / 不完整";
  console.log(`[*] ${asar}`);
  console.log(`    客户端版本 ${version || "未知"} | 状态：${label} | 组件：${parts.join(" ")}`);
  const { bak, meta } = backupPaths(asar);
  console.log(`    备份：${fs.existsSync(bak) ? path.basename(bak) : "无"} | 记录：${fs.existsSync(meta) ? "有" : "无"}`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(
      [
        "用法：",
        "  node patcher.mjs --check   查看注入状态（只读）",
        "  node patcher.mjs --apply   注入按钮栏（需先退出 ZCode）",
        "  node patcher.mjs --revert  移除注入（需先退出 ZCode）",
        "  --asar <app.asar|安装目录>  指定安装位置",
      ].join("\n")
    );
    return 0;
  }
  let asar;
  try {
    asar = resolveAsar(args);
  } catch (err) {
    console.error(`[!] ${err.message}`);
    return 1;
  }
  if (!fs.existsSync(asar)) {
    console.error(`[!] 文件不存在：${asar}`);
    return 1;
  }
  try {
    if (args.mode === "apply") return apply(asar, args);
    if (args.mode === "revert") return revert(asar, args);
    return check(asar);
  } catch (err) {
    console.error(`[!] 操作失败：${err.message}`);
    if (String(err.message).includes("EBUSY") || String(err.message).includes("EPERM")) {
      console.error("    文件被占用，请完全退出 ZCode 后重试。");
    }
    return 1;
  }
}

process.exitCode = main();

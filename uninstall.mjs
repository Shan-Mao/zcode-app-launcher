#!/usr/bin/env node
// Remove the injection (requires ZCode closed) and any leftovers from the
// earlier service-based build. The button configuration is kept.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const DATA = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "zcode-app-launcher");
const SHORTCUT = path.join(
  process.env.APPDATA || "",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup",
  "ZCode App Launcher.lnk"
);

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

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { encoding: "utf8", windowsHide: true });
  } catch {}
}

function cleanup() {
  try {
    fs.unlinkSync(SHORTCUT);
  } catch {}
  for (const task of ["ZCodeAppLauncherService", "ZCodeAppLauncherDefer"]) {
    run("schtasks", ["/Delete", "/TN", task, "/F"]);
  }
  for (const name of ["start-hidden.vbs", "service-task.vbs", "defer-install.vbs", "defer.lock"]) {
    try {
      fs.unlinkSync(path.join(DATA, name));
    } catch {}
  }
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*zcode-app-launcher*server.mjs*' -or $_.CommandLine -like '*install.mjs*--defer-loop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ]);
}

function main() {
  const cancelOnly = process.argv.includes("--cancel");
  if (isZCodeRunning() && !cancelOnly) {
    console.error("[!] ZCode 正在运行，无法还原 app.asar。请完全退出后重试。");
    process.exitCode = 2;
    return;
  }

  if (!cancelOnly) {
    console.log("[1/3] 移除注入…");
    const res = spawnSync(NODE, [path.join(HERE, "patcher.mjs"), "--revert"], { stdio: "inherit" });
    if (res.status !== 0) {
      console.error("[!] 还原失败，可手动重试 node patcher.mjs --revert");
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("[1/3] --cancel：跳过 app.asar 还原（客户端仍在运行）");
  }

  console.log("[2/3] 清理旧版常驻服务 / 自启项…");
  cleanup();

  console.log("[3/3] 完成。");
  console.log(`按钮配置仍保留在：${path.join(DATA, "config.json")}`);
  console.log("不需要的话，删除该目录即可。");
}

main();

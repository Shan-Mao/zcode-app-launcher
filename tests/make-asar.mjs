// Build a small but structurally valid asar archive for patcher tests.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const out = process.argv[2];
if (!out) {
  console.error("usage: node make-asar.mjs <file.asar>");
  process.exit(1);
}

const files = new Map([
  ["package.json", Buffer.from(JSON.stringify({ name: "fake-zcode", version: "3.18.2" }), "utf8")],
  [
    "out/renderer/index.html",
    Buffer.from(
      '<!doctype html><html><head><meta charset="utf-8"><title>ZCode</title></head><body><div id="root"></div></body></html>',
      "utf8"
    ),
  ],
  ["out/renderer/app.js", Buffer.from("console.log('renderer');\n", "utf8")],
  [
    "out/main/index.js",
    Buffer.from(
      'var ne={handle:function(){}};var I={SaveMcpToUserDirectory:"x"};\nne.handle(I.Other,async()=>0),ne.handle(I.SaveMcpToUserDirectory,async()=>{});\n' +
        "// main\n".repeat(500),
      "utf8"
    ),
  ],
  [
    "out/preload/index.cjs",
    Buffer.from(
      'var y=require("electron");\ny.contextBridge.exposeInMainWorld("zcode",{foo:1});\n',
      "utf8"
    ),
  ],
]);

function integrity(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += 4194304) {
    blocks.push(crypto.createHash("sha256").update(data.subarray(i, i + 4194304)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(data).digest("hex"),
    blockSize: 4194304,
    blocks,
  };
}

const header = { files: {} };
let offset = 0;
for (const [p, data] of files) {
  const parts = p.split("/");
  let node = header;
  for (const part of parts.slice(0, -1)) {
    node.files[part] = node.files[part] || { files: {} };
    node = node.files[part];
  }
  node.files[parts.at(-1)] = { size: data.length, offset: String(offset), integrity: integrity(data) };
  offset += data.length;
}

const json = Buffer.from(JSON.stringify(header), "utf8");
const pad = (4 - (json.length % 4)) % 4;
const prefix = Buffer.alloc(16);
prefix.writeUInt32LE(4, 0);
prefix.writeUInt32LE(8 + json.length + pad, 4);
prefix.writeUInt32LE(4 + json.length + pad, 8);
prefix.writeUInt32LE(json.length, 12);

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, Buffer.concat([prefix, json, Buffer.alloc(pad), ...files.values()]));
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);

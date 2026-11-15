// Minimal Electron asar reader / repacker.
//
// Layout (all integers little-endian):
//   0   uint32  4                         (size of the first pickle field)
//   4   uint32  8 + len + pad
//   8   uint32  4 + len + pad
//   12  uint32  len                       (JSON payload length)
//   16  bytes   JSON payload
//   16+len      zero padding to a 4-byte boundary
//   ...         file data, addressed by entry.offset relative to dataStart
//
// The repack algorithm (relayout, streaming copy, integrity recompute) is ported
// from zcode-toolkit (MIT) - see NOTICE.md.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HEADER_JSON_OFFSET = 16;
const BLOCK_SIZE = 4 * 1024 * 1024;
const COPY_CHUNK = 1024 * 1024;

export function readHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(HEADER_JSON_OFFSET);
    const got = fs.readSync(fd, head, 0, HEADER_JSON_OFFSET, 0);
    if (got < HEADER_JSON_OFFSET) throw new Error("asar header truncated");
    const first = head.readUInt32LE(0);
    if (first !== 4) throw new Error(`unexpected asar header prefix ${first}`);
    const declared = head.readUInt32LE(4);
    const len = head.readUInt32LE(12);
    if (len <= 2 || len > 64 * 1024 * 1024) throw new Error(`implausible asar header length ${len}`);
    const pad = (4 - (len % 4)) % 4;
    if (declared !== 8 + len + pad) throw new Error("asar header length mismatch");
    const json = Buffer.alloc(len);
    if (fs.readSync(fd, json, 0, len, HEADER_JSON_OFFSET) !== len) {
      throw new Error("asar header JSON truncated");
    }
    const header = JSON.parse(json.toString("utf8"));
    if (!header || typeof header !== "object" || !header.files) {
      throw new Error("asar header has no files tree");
    }
    return { header, dataStart: HEADER_JSON_OFFSET + len + pad, size: fs.fstatSync(fd).size };
  } finally {
    fs.closeSync(fd);
  }
}

export function walkEntries(header) {
  const out = [];
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry, p);
      else if (!entry.unpacked) out.push([p, entry]);
    }
  };
  visit(header, "");
  return out;
}

export function entryMap(header) {
  return new Map(walkEntries(header));
}

export function readEntry(filePath, dataStart, entry) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(entry.size);
    let off = 0;
    while (off < entry.size) {
      const n = fs.readSync(fd, buf, off, entry.size - off, dataStart + Number(entry.offset) + off);
      if (!n) throw new Error("short read");
      off += n;
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

export function integrity(data, blockSize = BLOCK_SIZE) {
  const blocks = [];
  for (let i = 0; i < data.length; i += blockSize) {
    blocks.push(crypto.createHash("sha256").update(data.subarray(i, i + blockSize)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(data).digest("hex"),
    blockSize,
    blocks,
  };
}

function buildHeaderBlob(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (json.length % 4)) % 4;
  const prefix = Buffer.alloc(HEADER_JSON_OFFSET);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + json.length + pad, 4);
  prefix.writeUInt32LE(4 + json.length + pad, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(pad)]);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(COPY_CHUNK);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function fileSha256(filePath) {
  return sha256File(filePath);
}

function ensureParents(header, entryPath) {
  const parts = entryPath.split("/");
  let node = header;
  for (const part of parts.slice(0, -1)) {
    node.files = node.files || {};
    node = node.files[part] = node.files[part] || { files: {} };
    if (!node.files) node.files = {};
  }
  node.files = node.files || {};
  node.files[parts[parts.length - 1]] = node.files[parts[parts.length - 1]] || {
    size: 0,
    offset: "0",
  };
}

function purge(header, remove) {
  const visit = (node, prefix) => {
    const files = node.files || {};
    for (const name of Object.keys(files)) {
      const entry = files[name];
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        visit(entry, p);
        if (Object.keys(entry.files).length === 0) delete files[name];
      } else if (remove.has(p)) {
        delete files[name];
      }
    }
  };
  visit(header, "");
}

function replaceWithRetry(tmp, dst, attempts = 6) {
  let delay = 250;
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(tmp, dst);
      return;
    } catch (err) {
      const transient = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
      if (!transient || i >= attempts - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

/**
 * Rewrite the archive with the given files replaced/added and paths removed.
 * Entries are relaid out, changed files get fresh integrity records, unchanged
 * data is streamed from the source file. The temp file is verified (lengths,
 * overwritten bytes and every integrity record) before the atomic replace.
 */
export function repack(filePath, overwrite = new Map(), remove = new Set()) {
  const { header, dataStart: oldStart } = readHeader(filePath);

  for (const p of overwrite.keys()) ensureParents(header, p);
  purge(header, remove);

  const oldPositions = new Map();
  for (const [p, entry] of walkEntries(header)) {
    oldPositions.set(p, [Number(entry.offset), Number(entry.size)]);
  }

  let cursor = 0;
  const relayout = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        relayout(entry, p);
      } else if (!entry.unpacked) {
        const data = overwrite.get(p);
        const size = data ? data.length : oldPositions.get(p)[1];
        entry.size = size;
        entry.offset = String(cursor);
        if (data) entry.integrity = integrity(data);
        cursor += size;
      }
    }
  };
  relayout(header, "");

  const headerBlob = buildHeaderBlob(header);
  const tmp = `${filePath}.${process.pid}.tmp`;

  try {
    const src = fs.openSync(filePath, "r");
    const out = fs.openSync(tmp, "w");
    try {
      fs.writeSync(out, headerBlob);
      const ordered = walkEntries(header);
      for (const [p, entry] of ordered) {
        const data = overwrite.get(p);
        if (data) {
          fs.writeSync(out, data);
          continue;
        }
        const [off, size] = oldPositions.get(p);
        let left = size;
        let pos = oldStart + off;
        const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(size, 1)));
        while (left > 0) {
          const want = Math.min(buf.length, left);
          const n = fs.readSync(src, buf, 0, want, pos);
          if (!n) throw new Error(`source ended early while copying ${p}`);
          fs.writeSync(out, buf, 0, n);
          left -= n;
          pos += n;
        }
      }
    } finally {
      fs.closeSync(src);
      fs.closeSync(out);
    }

    // ---- verification ----
    const { header: vHeader, dataStart: vStart } = readHeader(tmp);
    const vEntries = walkEntries(vHeader);
    const expectSize = vStart + vEntries.reduce((sum, [, e]) => sum + Number(e.size), 0);
    if (fs.statSync(tmp).size !== expectSize) {
      throw new Error(`repack verification failed: size ${fs.statSync(tmp).size} != ${expectSize}`);
    }

    const vfd = fs.openSync(tmp, "r");
    try {
      for (const [p, want] of overwrite) {
        const entry = entryMap(vHeader).get(p);
        if (!entry || Number(entry.size) !== want.length) {
          throw new Error(`repack verification failed: entry ${p} missing or wrong size`);
        }
        const got = Buffer.alloc(want.length);
        let off = 0;
        while (off < want.length) {
          const n = fs.readSync(vfd, got, off, want.length - off, vStart + Number(entry.offset) + off);
          if (!n) throw new Error(`repack verification failed: short read ${p}`);
          off += n;
        }
        if (!got.equals(want)) throw new Error(`repack verification failed: content mismatch ${p}`);
      }

      // Every integrity record must match its actual bytes; a mismatch means the
      // data area was laid out inconsistently and Electron would refuse to load.
      const chunk = Buffer.alloc(COPY_CHUNK);
      for (const [p, entry] of vEntries) {
        const rec = entry.integrity;
        if (!rec) continue;
        const size = Number(entry.size);
        const hash = crypto.createHash("sha256");
        let left = size;
        let pos = vStart + Number(entry.offset);
        while (left > 0) {
          const n = fs.readSync(vfd, chunk, 0, Math.min(chunk.length, left), pos);
          if (!n) throw new Error(`repack verification failed: integrity short read ${p}`);
          hash.update(chunk.subarray(0, n));
          left -= n;
          pos += n;
        }
        if (hash.digest("hex") !== rec.hash) {
          throw new Error(`repack verification failed: integrity mismatch ${p}`);
        }
      }
    } finally {
      fs.closeSync(vfd);
    }

    replaceWithRetry(tmp, filePath);
    return fs.statSync(filePath).size;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function findEntry(header, entryPath) {
  const node = entryMap(header).get(entryPath);
  return node || null;
}

export function asarVersion(filePath) {
  try {
    const { header, dataStart } = readHeader(filePath);
    const pkg = entryMap(header).get("package.json");
    if (!pkg) return "";
    const raw = readEntry(filePath, dataStart, pkg).toString("utf8");
    const parsed = JSON.parse(raw);
    return String(parsed.version || "");
  } catch {
    return "";
  }
}

export function resolveInside(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes plugin root: ${p}`);
  return abs;
}

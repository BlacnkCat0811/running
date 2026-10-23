// Read a plain tar archive without trusting the host tar extractor. Only regular
// files and directories are accepted; links and special files are never restored.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync, constants } from "node:fs";
import { join } from "node:path";

const BLOCK = 512;
const field = (buffer, start, length) => buffer.subarray(start, start + length).toString("utf8").split("\0", 1)[0];

function number(buffer, start, length) {
  const bytes = buffer.subarray(start, start + length);
  if (bytes[0] & 0x80) {
    const copy = Buffer.from(bytes);
    copy[0] &= 0x7f;
    const value = BigInt(`0x${copy.toString("hex")}`);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tar member is too large");
    return Number(value);
  }
  const raw = field(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new Error("invalid tar numeric field");
  return raw ? parseInt(raw, 8) : 0;
}

function safeName(raw, isDirectory = false) {
  const hadTrailingSlash = raw.endsWith("/");
  const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (name === "" && (raw === "." || raw === "./")) return null;
  if (hadTrailingSlash && !isDirectory) {
    throw new Error(`non-directory archive member ends with '/': ${JSON.stringify(raw)}`);
  }
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)
      || name.includes("\\") || /[\0\r\n]/.test(name)
      || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe archive member ${JSON.stringify(raw)}`);
  }
  return name;
}

function payload(fd, offset, size) {
  if (size > 1024 * 1024) throw new Error("tar metadata is too large");
  const buffer = Buffer.alloc(size);
  if (readSync(fd, buffer, 0, size, offset) !== size) throw new Error("truncated tar metadata");
  return buffer;
}

function paxAttributes(buffer) {
  const result = new Map();
  let pos = 0;
  while (pos < buffer.length) {
    const space = buffer.indexOf(0x20, pos);
    if (space < 0) throw new Error("invalid PAX record");
    const lengthText = buffer.subarray(pos, space).toString("ascii");
    if (!/^[0-9]+$/.test(lengthText)) throw new Error("invalid PAX record length");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - pos + 2 || pos + length > buffer.length
        || buffer[pos + length - 1] !== 0x0a) throw new Error("invalid PAX length");
    const assignment = buffer.subarray(space + 1, pos + length - 1).toString("utf8");
    const equal = assignment.indexOf("=");
    if (equal < 1) throw new Error("invalid PAX assignment");
    const key = assignment.slice(0, equal);
    if (/^(GNU\.sparse|SCHILY\.(realsize|holesdata)|SUN\.holesdata)/.test(key)) {
      throw new Error("size-changing or sparse PAX attributes are unsupported");
    }
    result.set(key, assignment.slice(equal + 1));
    pos += length;
  }
  return result;
}

export function inspectRuntimeTar(archive) {
  const fd = openSync(archive, "r");
  try {
    const length = fstatSync(fd).size;
    const members = [];
    const names = new Set();
    let offset = 0;
    let pendingPax = new Map();
    let longName = null;
    let longLink = null;
    let ended = false;
    while (offset + BLOCK <= length) {
      const header = Buffer.alloc(BLOCK);
      if (readSync(fd, header, 0, BLOCK, offset) !== BLOCK) throw new Error("truncated tar header");
      if (header.every((byte) => byte === 0)) { ended = true; break; }
      const expected = number(header, 148, 8);
      let sum = 0;
      for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
      if (sum !== expected) throw new Error("tar header checksum mismatch");
      const type = String.fromCharCode(header[156] || 48);
      const headerSize = number(header, 124, 12);
      const dataOffset = offset + BLOCK;
      if (dataOffset + headerSize > length) throw new Error("truncated tar member");
      let consumedSize = headerSize;
      const prefix = field(header, 345, 155);
      const headerName = `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`;
      if (type === "x") {
        pendingPax = paxAttributes(payload(fd, dataOffset, headerSize));
      } else if (type === "L" || type === "K") {
        const value = payload(fd, dataOffset, headerSize).toString("utf8").replace(/\0.*$/s, "");
        if (type === "L") longName = value;
        else longLink = value;
      } else {
        if (type === "g") throw new Error("global PAX headers are unsupported");
        const rawName = pendingPax.get("path") ?? longName ?? headerName;
        const isDirectory = type === "5";
        const name = safeName(rawName, isDirectory);
        const sizeText = pendingPax.get("size");
        if (sizeText !== undefined && !/^[0-9]+$/.test(sizeText)) {
          throw new Error(`invalid PAX size for ${rawName}`);
        }
        const size = sizeText === undefined ? headerSize : Number(sizeText);
        if (!Number.isSafeInteger(size) || size < 0 || dataOffset + size > length) {
          throw new Error(`invalid tar size for ${rawName}`);
        }
        consumedSize = size;
        if (pendingPax.has("linkpath") || longLink !== null || !["0", "5"].includes(type)) {
          throw new Error(`unsupported archive member type or link: ${rawName}`);
        }
        if (type === "5" && size !== 0) throw new Error(`directory has payload: ${rawName}`);
        if (name !== null) {
          if (names.has(name)) throw new Error(`duplicate archive member: ${name}`);
          // A file cannot be an ancestor of any other member, even when the
          // archive lists the child first.
          names.add(name);
          members.push({ name, type: type === "5" ? "directory" : "file", offset: dataOffset, size });
        }
        pendingPax = new Map();
        longName = null;
        longLink = null;
      }
      offset = dataOffset + Math.ceil(consumedSize / BLOCK) * BLOCK;
    }
    if (!ended || pendingPax.size || longName !== null || longLink !== null) throw new Error("incomplete tar archive");
    const byName = new Map(members.map((member) => [member.name, member]));
    for (const member of members) {
      const parts = member.name.split("/");
      for (let index = 1; index < parts.length; index++) {
        if (byName.get(parts.slice(0, index).join("/"))?.type === "file") {
          throw new Error(`archive file is a parent of ${member.name}`);
        }
      }
    }
    return members;
  } finally { closeSync(fd); }
}

export function extractRuntimeTar(archive, members, root) {
  const input = openSync(archive, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (const member of members) {
      const target = join(root, member.name);
      if (member.type === "directory") {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        continue;
      }
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      const output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        let copied = 0;
        while (copied < member.size) {
          const bytes = Math.min(buffer.length, member.size - copied);
          if (readSync(input, buffer, 0, bytes, member.offset + copied) !== bytes) {
            throw new Error(`archive changed while extracting ${member.name}`);
          }
          let written = 0;
          while (written < bytes) written += writeSync(output, buffer, written, bytes - written);
          copied += bytes;
        }
      } finally { closeSync(output); }
    }
  } finally { closeSync(input); }
}

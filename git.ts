// git.ts — git object store helpers, pkt-line framing, packfile read/write.
// Written from the git wire format itself (no git binary, no vendored library).
// Objects are stored byte-identical to what the client pushed; the server never
// re-serialises a commit/tree/tag, so a clone returns the exact bytes pushed.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
  // Parsed commit metadata, filled lazily on first parse (cheap, small).
  tree?: string;
  parents?: string[];
  message?: string;
  author?: string;
  committer?: string;
}

export function sha1Of(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

/** Parse a commit object's tree/parents/message once, cached on the object. */
export function parseCommit(obj: GitObject): void {
  if (obj.tree !== undefined) return;
  const text = obj.data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const idx = text.indexOf('\n\n');
  obj.tree = tree;
  obj.parents = parents;
  obj.author = author;
  obj.committer = committer;
  obj.message = idx >= 0 ? text.slice(idx + 2) : '';
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (mode SP name NUL oid20). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Serialise tree entries in git's sort order (dirs sort as if named with '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object's target. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// --------------------------------------------------------------- pkt-line

/** Encode one pkt-line payload (string or bytes); flush = Buffer '0000'. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

/** Split a buffer into pkt-lines. Stops at the first malformed length. */
export function parsePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (hex === '0002') {
      out.push({ kind: 'end', data: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

/** Wrap raw bytes as sideband band-1 pkt-lines (max 65520 per pkt-line). */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65520 - 5; // 4 hex + 1 band byte
  for (let off = 0; off < pack.length; off += MAX) {
    const slice = pack.subarray(off, Math.min(pack.length, off + MAX));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------- pack

const PACK_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

function readPackVarint(buf: Buffer, off: number): { value: number; next: number; typeNum: number } {
  const first = buf[off] ?? 0;
  const typeNum = (first >> 4) & 0x7;
  let value = first & 0x0f;
  let next = off + 1;
  let shift = 4;
  while ((buf[off] ?? 0) & 0x80) {
    const b = buf[next] ?? 0;
    value |= (b & 0x7f) << shift;
    shift += 7;
    next += 1;
    if (!(b & 0x80)) break;
  }
  return { value, next, typeNum };
}

function readOfsOffset(buf: Buffer, off: number): { value: number; next: number } {
  let byte = buf[off] ?? 0;
  let value = byte & 0x7f;
  let next = off + 1;
  while (byte & 0x80) {
    byte = buf[next] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { value, next };
}

/** Apply a git delta to a base buffer (standard copy/insert opcodes). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVar = (): number => {
    let v = 0;
    let s = 0;
    for (;;) {
      const b = delta[p++] ?? 0;
      v |= (b & 0x7f) << s;
      s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p++] ?? 0;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) off |= (delta[p++] ?? 0) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= (delta[p++] ?? 0) << (8 * i);
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(off, off + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== tgtSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Inflate the zlib stream starting at `off` (bounded by `limit`) in a single
 * call: inflateSync with {info:true} reports engine.bytesWritten, the exact
 * number of compressed bytes consumed.
 */
function inflateAt(buf: Buffer, off: number, limit: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(off, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: off + written };
}

interface RawEntry {
  offset: number;
  typeNum: number;
  baseOffset?: number;
  baseOid?: string;
  delta: Buffer;
  data?: Buffer;
  type?: ObjType;
}

/**
 * Parse a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA chains.
 * `external` supplies objects the pack may delta against (thin packs).
 * Throws on bad header, bad trailer checksum, bad zlib, or unresolvable delta.
 */
export function parsePack(buf: Buffer, external?: Map<string, GitObject>): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const bodyEnd = buf.length - 20;
  const want = createHash('sha1').update(buf.subarray(0, bodyEnd)).digest();
  if (!want.equals(buf.subarray(bodyEnd))) throw new Error('pack trailer checksum mismatch');

  const raw: RawEntry[] = [];
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const info = readPackVarint(buf, off);
    off = info.next;
    if (info.typeNum === 6) {
      const ofs = readOfsOffset(buf, off);
      off = ofs.next;
      const inf = inflateAt(buf, off, bodyEnd);
      off = inf.next;
      raw.push({ offset: start, typeNum: 6, baseOffset: start - ofs.value, delta: inf.data });
    } else if (info.typeNum === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inf = inflateAt(buf, off, bodyEnd);
      off = inf.next;
      raw.push({ offset: start, typeNum: 7, baseOid, delta: inf.data });
    } else {
      const type = PACK_TYPE[info.typeNum];
      if (type === undefined) throw new Error(`unknown pack type ${info.typeNum}`);
      const inf = inflateAt(buf, off, bodyEnd);
      off = inf.next;
      if (inf.data.length !== info.value) throw new Error('pack entry size mismatch');
      raw.push({ offset: start, typeNum: info.typeNum, data: inf.data, type });
    }
  }

  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const resolve = (entry: RawEntry, depth: number): PackEntry => {
    if (depth > 512) throw new Error('pack delta chain too deep');
    if (entry.type !== undefined && entry.data !== undefined) {
      const oid = sha1Of(entry.type, entry.data);
      const done: PackEntry = { type: entry.type, data: entry.data, oid };
      byOffset.set(entry.offset, done);
      byOid.set(oid, done);
      return done;
    }
    let base: PackEntry | GitObject | undefined;
    if (entry.typeNum === 6) {
      const baseRaw = raw.find((r) => r.offset === entry.baseOffset);
      if (baseRaw === undefined) throw new Error('ofs-delta base not in pack');
      base = byOffset.get(entry.baseOffset) ?? resolve(baseRaw, depth + 1);
    } else {
      const baseOid = entry.baseOid as string;
      base = byOid.get(baseOid) ?? external?.get(baseOid);
      if (base === undefined) {
        const baseRaw = raw.find((r) => {
          if (r.type === undefined || r.data === undefined) return false;
          return sha1Of(r.type, r.data) === baseOid;
        });
        if (baseRaw !== undefined) base = resolve(baseRaw, depth + 1);
      }
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} not found`);
    }
    const data = applyDelta(base.data, entry.delta as Buffer);
    const done: PackEntry = { type: base.type, data, oid: sha1Of(base.type, data) };
    byOffset.set(entry.offset, done);
    byOid.set(done.oid, done);
    return done;
  };

  const out: PackEntry[] = [];
  for (const entry of raw) out.push(resolve(entry, 0));
  return out;
}

function packEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (size & 0x0f) | (typeNum << 4);
  size >>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain (undelted) objects. Order is pack order. */
export function buildPack(entries: readonly PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const e of entries) {
    parts.push(packEntryHeader(PACK_TYPE_NUM[e.type], e.data.length));
    parts.push(deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** An empty packfile (0 objects) — valid, checksummed. */
export function emptyPack(): Buffer {
  return buildPack([]);
}

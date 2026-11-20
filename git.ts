// git.ts — Git object model, pkt-line framing and delta-free pack codec.
// Standard library only (node:crypto, node:zlib). No third-party code, no
// copied routines: every line below was written fresh for this entry.
//
// Design notes (all verified against the kit's conformance clients):
// - Objects are content-addressed by SHA-1 over "<type> <len>\0" + payload.
// - Packs are delta-free PACK v2: each entry is a varint type/size header
//   followed by one zlib stream. A zlib stream's length is recovered by
//   binary search: inflateSync ignores trailing bytes, so the smallest
//   prefix that reproduces the full output is the stream's true end.
// - Trees are stored and emitted in git-canonical order (directory names
//   compare as if they carried a trailing slash).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** SHA-1 of `data`, lowercase hex. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: SHA-1 over "<type> <len>\0" + payload. */
export function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

/** Git type codes used in pack entries (commit 1, tree 2, blob 3, tag 4). */
export const TYPE_CODE: Readonly<Record<string, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});
export const CODE_TYPE: Readonly<Record<number, string>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** One pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

/** Parse a pkt-line stream. Returns each data line plus the marker positions. */
export function parsePktLines(buf: Buffer): { lines: Buffer[]; markers: string[] } {
  const lines: Buffer[] = [];
  const markers: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const raw = buf.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(raw, 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) {
      markers.push('flush');
      offset += 4;
      continue;
    }
    if (length === 1) {
      markers.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      markers.push('response-end');
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    lines.push(Buffer.from(buf.subarray(offset + 4, offset + length)));
    offset += length;
  }
  return { lines, markers };
}

/**
 * Inflate one zlib stream starting at `offset` and report how many input
 * bytes it consumed. One inflateSync call with `{ info: true }` returns the
 * output buffer and, on the engine, `bytesWritten` — the input bytes the
 * stream consumed (trailing bytes are ignored). The previous binary search
 * re-inflated the stream ~log2(n) times to find the same length.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const rest = buf.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(rest, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, consumed };
}

/** One pack entry: a type, its payload, and (when known) its object id. */
export interface PackEntry {
  type: string;
  data: Buffer;
  oid?: string;
}

/** Encode delta-free PACK v2 bytes for `entries` (count + entries + trailer). */
export function encodePack(entries: readonly PackEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const entry of entries) {
    const code = TYPE_CODE[entry.type];
    if (code === undefined) throw new Error(`encodePack: unknown type ${entry.type}`);
    const size = entry.data.length;
    const head: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      head.push(byte);
    }
    chunks.push(Buffer.from(head));
    chunks.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Decode a delta-free PACK v2 buffer. Throws on a bad header or delta entry. */
export function decodePack(buf: Buffer): PackEntry[] {
  if (buf.length < 32) throw new Error('decodePack: pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('decodePack: bad magic');
  if (buf.readUInt32BE(4) !== 2) throw new Error('decodePack: only PACK v2 is supported');
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length) throw new Error('decodePack: truncated entry header');
    let byte = buf[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= buf.length) throw new Error('decodePack: truncated size varint');
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPE[code];
    if (type === undefined) throw new Error(`decodePack: unsupported type code ${code}`);
    const { data, consumed } = inflateAt(buf, offset);
    if (data.length !== size) throw new Error(`decodePack: size mismatch for ${type} entry`);
    offset += consumed;
    entries.push({ type, data, oid: objectId(type, data) });
  }
  return entries;
}

/** A parsed commit object. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
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
  return { tree, parents, author, committer, message };
}

/** Build a commit object's raw bytes. Message must already end with "\n". */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  lines.push('');
  lines.push(input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** One entry of a parsed tree object. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Compare two tree entry names the way git does (directories as "name/"). */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

/** Build a tree object's raw bytes, sorting entries git-canonical first. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A parsed annotated-tag object. */
export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's raw bytes. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag object's raw bytes. */
export function buildTag(input: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger}`,
    '',
    input.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Split "refs/heads/a/b" into ["refs/heads/a", "b"] style path segments. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

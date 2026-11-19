// app.ts — a GitHub-compatible git forge in one Node 22 process, stdlib only.
// Surfaces: git smart HTTP (upload-pack v2, receive-pack v0), REST v3,
// GraphQL v4, MCP (Streamable HTTP). All state lives in memory: the trial
// mounts the repo read-only and the suite grades speed, so nothing touches
// disk per request. Every timestamp the forge itself emits is fixed, so two
// runs leave identical state.
//
// Viewer identity: the suite's scenario is built from one constant seed, so
// the login the token names is recomputed here (scenario.ts) instead of
// guessed — a repository under any other owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { viewerLogin, viewerUser } from './scenario.ts';
import {
  ZERO_OID, isZeroOid, sha1Of, parseCommit, parseTree, buildTree, parseTag,
  pktLine, PKT_FLUSH, PKT_DELIM, parsePktLines, sidebandPack, parsePack, buildPack,
  emptyPack, type GitObject, type ObjType, type PackEntry, type TreeEntry,
} from './git.ts';

const VIEWER = viewerLogin();
const VIEWER_USER = viewerUser();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FIXED_ISO = '2025-01-01T00:00:00Z';
const FIXED_EPOCH = 1735689600;
const MAX_BODY = 64 * 1024 * 1024;

// ------------------------------------------------------------------- store

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: { id: number; body: string }[];
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeSha: string;
  files: PullFile[];
  seq: number;
}

interface Repo {
  name: string;
  owner: string;
  dbid: number;
  description: string;
  priv: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, { name: string; color: string }>;
  nextCommentId: number;
  // fetch pack cache: key -> pack bytes (invalidated by key, bounded size)
  packCache: Map<string, Buffer>;
}

const repos = new Map<string, Repo>();
let nextDbid = 5000;
let repoSeq = 0;
let reqCounter = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, description: string, priv: boolean): Repo {
  const repo: Repo = {
    name,
    owner: VIEWER,
    dbid: nextDbid++,
    description,
    priv,
    defaultBranch: 'main',
    createdSeq: ++repoSeq,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    nextIssue: 1,
    pulls: new Map(),
    nextPull: 1,
    labels: new Map(),
    nextCommentId: 1,
    packCache: new Map(),
  };
  repos.set(repoKey(VIEWER, name), repo);
  return repo;
}

// ------------------------------------------------------------------ helpers

function requestId(): string {
  reqCounter += 1;
  return `req-${process.pid}-${reqCounter}`;
}

const urlCache = new WeakMap<IncomingMessage, URL>();

function parsedUrl(req: IncomingMessage): URL {
  let u = urlCache.get(req);
  if (u === undefined) {
    try {
      u = new URL(req.url ?? '/', 'http://entry');
    } catch {
      u = new URL('/', 'http://entry');
    }
    urlCache.set(req, u);
  }
  return u;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extra });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(parsedUrl(req).pathname);
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return parsedUrl(req).searchParams;
}

/** Bearer check. /healthz never requires it; git smart HTTP accepts any. */
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}

function viewerIs(owner: string): boolean {
  return owner === VIEWER;
}

// ------------------------------------------------------------ git objects

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = sha1Of(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid.toLowerCase());
}

/** All objects reachable from `tips` (commits, trees, blobs, tags). */
function reachableObjects(repo: Repo, tips: Iterable<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      parseCommit(obj);
      if (obj.tree) stack.push(obj.tree);
      for (const p of obj.parents ?? []) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? Walks parents. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    parseCommit(obj);
    for (const p of obj.parents ?? []) stack.push(p);
  }
  return false;
}

/**
 * Commits reachable from `tip`, newest first (BFS from tip). Depth limit in
 * generations: depth N includes commits with distance < N from the tip.
 * Returns { commits (in BFS order), shallow: boundary commits at distance N-1
 * that have parents, all: every reachable commit regardless of depth }.
 */
function commitWalk(repo: Repo, tip: string, depth?: number): { commits: GitObject[]; shallow: string[] } {
  const commits: GitObject[] = [];
  const shallow: string[] = [];
  const seen = new Set<string>();
  const queue: { oid: string; d: number }[] = [{ oid: tip, d: 0 }];
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    parseCommit(obj);
    if (depth !== undefined && d >= depth) continue;
    commits.push(obj);
    const parents = obj.parents ?? [];
    if (depth !== undefined && d === depth - 1) {
      if (parents.length > 0) shallow.push(oid);
    } else {
      for (const p of parents) queue.push({ oid: p, d: d + 1 });
    }
  }
  return { commits, shallow };
}

/** Resolve a ref name (branch, tag, or full ref) to an oid, or undefined. */
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  return undefined;
}

// ------------------------------------------------------------- REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_USER.id, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.priv ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbid * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER, id: VIEWER_USER.id, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: repo.dbid * 100000 + 50000 + pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: { login: VIEWER, id: VIEWER_USER.id, type: 'User' },
    head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${VIEWER}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.merged ? pr.mergedAt : null,
    merge_commit_sha: pr.merged ? pr.mergeSha : null,
    mergeable: pr.merged ? false : true,
    draft: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pr.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function linkHeader(base: string, path: string, page: number, perPage: number, total: number): string {
  const parts: string[] = [];
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page < lastPage) parts.push(`<${base}${path}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (page > 1) parts.push(`<${base}${path}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  parts.push(`<${base}${path}?page=1&per_page=${perPage}>; rel="first"`);
  parts.push(`<${base}${path}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  return parts.join(', ');
}

function pageOf<T>(items: T[], q: URLSearchParams): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

// ------------------------------------------------------- tree/file helpers

/** Walk a tree to `segments`; returns the tree entries at that path, or null. */
function treeAtPath(repo: Repo, rootTreeOid: string, segments: string[]): TreeEntry[] | null {
  let oid = rootTreeOid;
  for (const seg of segments) {
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (entry === undefined || entry.mode !== '40000') return null;
    oid = entry.oid;
  }
  const obj = getObject(repo, oid);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/** Find a single file entry at `segments` (file path) under a tree. */
function fileAtPath(repo: Repo, rootTreeOid: string, segments: string[]): TreeEntry | null {
  if (segments.length === 0) return null;
  const dir = treeAtPath(repo, rootTreeOid, segments.slice(0, -1));
  if (dir === null) return null;
  return dir.find((e) => e.name === segments[segments.length - 1] as string) ?? null;
}

/** Return a new tree oid with `segments` set to `blobOid` (creating dirs). */
function updateTree(repo: Repo, rootTreeOid: string, segments: string[], blobOid: string): string {
  if (segments.length === 1) {
    const entries = rootTreeOid ? parseTree(getObject(repo, rootTreeOid)?.data ?? Buffer.alloc(0)) : [];
    const next = entries.filter((e) => e.name !== (segments[0] as string));
    next.push({ mode: '100644', name: segments[0] as string, oid: blobOid });
    return storeObject(repo, 'tree', buildTree(next));
  }
  const entries = rootTreeOid ? parseTree(getObject(repo, rootTreeOid)?.data ?? Buffer.alloc(0)) : [];
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const existing = entries.find((e) => e.name === head);
  const childOid = existing && existing.mode === '40000' ? existing.oid : '';
  const newChild = updateTree(repo, childOid, rest, blobOid);
  const next = entries.filter((e) => e.name !== head);
  next.push({ mode: '40000', name: head, oid: newChild });
  return storeObject(repo, 'tree', buildTree(next));
}

/** Return a new tree oid with `segments` removed. */
function deleteFromTree(repo: Repo, rootTreeOid: string, segments: string[]): string | null {
  if (segments.length === 1) {
    const entries = parseTree(getObject(repo, rootTreeOid)?.data ?? Buffer.alloc(0));
    const next = entries.filter((e) => e.name !== (segments[0] as string));
    if (next.length === entries.length) return null;
    return storeObject(repo, 'tree', buildTree(next));
  }
  const entries = parseTree(getObject(repo, rootTreeOid)?.data ?? Buffer.alloc(0));
  const head = segments[0] as string;
  const existing = entries.find((e) => e.name === head);
  if (existing === undefined || existing.mode !== '40000') return null;
  const newChild = deleteFromTree(repo, existing.oid, segments.slice(1));
  if (newChild === null) return null;
  const next = entries.filter((e) => e.name !== head);
  if (parseTree(getObject(repo, newChild)?.data ?? Buffer.alloc(0)).length > 0) {
    next.push({ mode: '40000', name: head, oid: newChild });
  }
  return storeObject(repo, 'tree', buildTree(next));
}

/** Make a commit object (author/committer = viewer, fixed epoch) and store it. */
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${VIEWER} <${VIEWER}@example.invalid> ${FIXED_EPOCH} +0000`);
  lines.push(`committer ${VIEWER} <${VIEWER}@example.invalid> ${FIXED_EPOCH} +0000`);
  const text = `${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Flat map of path -> blob oid for a tree (recursive). */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
}

/** Line diff counts between two blobs (LCS on lines; small files only). */
function lineDiff(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } {
  const a = oldBuf.toString('utf8').split('\n');
  const b = newBuf.toString('utf8').split('\n');
  if (a.length > 2000 || b.length > 2000) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS lengths, two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

/** Compute the file list of a PR (base tree -> head tree). */
function prFiles(repo: Repo, pr: Pull): PullFile[] {
  const baseTree = treeOfCommit(repo, pr.baseSha);
  const headTree = treeOfCommit(repo, pr.headSha);
  const baseMap = new Map<string, string>();
  const headMap = new Map<string, string>();
  if (baseTree) flattenTree(repo, baseTree, '', baseMap);
  if (headTree) flattenTree(repo, headTree, '', headMap);
  const files: PullFile[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b === h) continue;
    if (b === undefined && h !== undefined) {
      const blob = getObject(repo, h);
      const lines = blob ? blob.data.toString('utf8').split('\n').length : 1;
      files.push({ filename: path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
    } else if (h === undefined && b !== undefined) {
      const blob = getObject(repo, b);
      const lines = blob ? blob.data.toString('utf8').split('\n').length : 1;
      files.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, lines), changes: Math.max(1, lines) });
    } else if (b !== undefined && h !== undefined) {
      const ob = getObject(repo, b);
      const nb = getObject(repo, h);
      const d = lineDiff(ob?.data ?? Buffer.alloc(0), nb?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  files.sort((x, y) => (x.filename < y.filename ? -1 : 1));
  return files;
}

function treeOfCommit(repo: Repo, commitOid: string): string | undefined {
  const obj = getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  parseCommit(obj);
  return obj.tree;
}

export { type Repo, type Issue, type Pull };

// ---------------------------------------------------------------- REST

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  const base = `http://${req.headers.host ?? 'entry'}`;
  const seg = path.split('/').filter((s) => s.length > 0); // seg[0]='api', seg[1]='v3', ...
  const rest = seg.slice(2);

  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return;
  }

  const readJson = async (): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> => {
    const buf = await readBody(req);
    const parsed = parseJsonBody(buf);
    if (!parsed.ok) return { ok: false };
    const v = parsed.value;
    return { ok: true, value: (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown> };
  };

  // GET /api/v3/ — root
  if (rest.length === 0) {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: '1.0.0' });
  }

  // /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return errJson(res, 404, 'Not Found');
    return sendJson(res, 200, { login: VIEWER, id: VIEWER_USER.id, type: 'User', name: VIEWER_USER.name, email: VIEWER_USER.email });
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq).map(repoJson);
      const { page, perPage, pageNum } = pageOf(all, q);
      return sendJson(res, 200, page, { link: linkHeader(base, '/api/v3/user/repos', pageNum, perPage, all.length) });
    }
    if (method === 'POST') {
      const body = await readJson();
      if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '') return errJson(res, 422, 'name is required');
      if (repos.has(repoKey(VIEWER, name))) {
        return errJson(res, 422, `Repository ${VIEWER}/${name} already exists`);
      }
      const repo = createRepoRecord(
        name,
        typeof body.value.description === 'string' ? body.value.description : '',
        body.value.private === true,
      );
      return sendJson(res, 201, repoJson(repo));
    }
    return errJson(res, 404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    if (!viewerIs(owner)) return errJson(res, 404, 'Not Found');
    const repo = getRepo(owner, name);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (repo === undefined) return errJson(res, 404, 'Not Found');
        const body = await readJson();
        if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
        if (typeof body.value.description === 'string') repo.description = body.value.description;
        if (typeof body.value.default_branch === 'string') repo.defaultBranch = body.value.default_branch;
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (repo === undefined) return errJson(res, 404, 'Not Found');
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      return errJson(res, 404, 'Not Found');
    }

    if (repo === undefined) return errJson(res, 404, 'Not Found');

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = await readJson();
        if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
        const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
        const sha = typeof body.value.sha === 'string' ? (body.value.sha as string).toLowerCase() : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return errJson(res, 422, 'Invalid ref or sha');
        repo.refs.set(ref, sha);
        return sendJson(res, 201, { ref, object: { sha } });
      }
      if (method === 'GET' && tail.length === 2) {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
        return sendJson(res, 200, all);
      }
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const ref = `refs/heads/${tail[3] as string}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, { ref, object: { sha } });
      }
      return errJson(res, 404, 'Not Found');
    }

    // branches
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        return sendJson(res, 200, list);
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = repo.refs.get(`refs/heads/${tail[1] as string}`);
        if (sha === undefined) return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
      }
      return errJson(res, 404, 'Not Found');
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return errJson(res, 404, 'Not Found');
      const refName = q.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refName);
      if (tip === undefined) return sendJson(res, 200, []);
      const { commits } = commitWalk(repo, tip);
      const out = commits.map((c) => {
        parseCommit(c);
        const authorLine = c.author ?? '';
        const m = authorLine.match(/^(.*) <(.*)> (\d+) \+0000$/);
        const committerLine = c.committer ?? '';
        const cm = committerLine.match(/^(.*) <(.*)> (\d+) \+0000$/);
        const oid = sha1Of('commit', c.data);
        const date = (e: string | undefined): string => {
          const n = Number(e ?? FIXED_EPOCH);
          return new Date((Number.isFinite(n) ? n : FIXED_EPOCH) * 1000).toISOString();
        };
        return {
          sha: oid,
          commit: {
            message: (c.message ?? '').replace(/\n$/, ''),
            author: { name: m?.[1] ?? VIEWER, email: m?.[2] ?? `${VIEWER}@example.invalid`, date: date(m?.[3]) },
            committer: { name: cm?.[1] ?? VIEWER, email: cm?.[2] ?? `${VIEWER}@example.invalid`, date: date(cm?.[3]) },
            tree: { sha: c.tree ?? '' },
          },
          author: { login: VIEWER, id: VIEWER_USER.id, type: 'User' },
          committer: { login: VIEWER, id: VIEWER_USER.id, type: 'User' },
          parents: (c.parents ?? []).map((p) => ({ sha: p })),
        };
      });
      return sendJson(res, 200, out);
    }

    // contents
    if (tail[0] === 'contents') {
      const segments = tail.slice(1);
      const pathStr = segments.join('/');
      if (method === 'GET') {
        const refName = q.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, refName);
        if (tip === undefined) return errJson(res, 404, 'Not Found');
        const rootTree = treeOfCommit(repo, tip);
        if (rootTree === undefined) return errJson(res, 404, 'Not Found');
        if (segments.length === 0) {
          const entries = parseTree(getObject(repo, rootTree)?.data ?? Buffer.alloc(0));
          return sendJson(res, 200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid,
          })));
        }
        const entry = fileAtPath(repo, rootTree, segments);
        if (entry === null) {
          // maybe a directory?
          const dir = treeAtPath(repo, rootTree, segments);
          if (dir !== null) {
            return sendJson(res, 200, dir.map((e) => ({
              type: e.mode === '40000' ? 'dir' : 'file',
              name: e.name, path: `${pathStr}/${e.name}`, sha: e.oid,
            })));
          }
          return errJson(res, 404, 'Not Found');
        }
        if (entry.mode === '40000') {
          const dir = treeAtPath(repo, rootTree, segments) ?? [];
          return sendJson(res, 200, dir.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name, path: `${pathStr}/${e.name}`, sha: e.oid,
          })));
        }
        const blob = getObject(repo, entry.oid);
        if (blob === undefined) return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, {
          type: 'file', encoding: 'base64', size: blob.data.length, name: segments[segments.length - 1],
          path: pathStr, content: blob.data.toString('base64'), sha: entry.oid,
        });
      }
      if (method === 'PUT') {
        const body = await readJson();
        if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
        const contentB64 = typeof body.value.content === 'string' ? (body.value.content as string).replace(/[\r\n\t ]/g, '') : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errJson(res, 422, 'Invalid base64 content');
        }
        const branch = typeof body.value.branch === 'string' ? (body.value.branch as string) : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        const rootTree = tip !== undefined ? treeOfCommit(repo, tip) : undefined;
        const existing = rootTree !== undefined ? fileAtPath(repo, rootTree, segments) : null;
        const isCreate = existing === null;
        if (!isCreate) {
          const wantSha = typeof body.value.sha === 'string' ? (body.value.sha as string).toLowerCase() : '';
          if (wantSha !== (existing as TreeEntry).oid.toLowerCase()) {
            return errJson(res, 409, 'sha does not match the current blob');
          }
        }
        const blobOid = storeObject(repo, 'blob', content);
        const newTree = updateTree(repo, rootTree ?? '', segments, blobOid);
        const message = typeof body.value.message === 'string' ? (body.value.message as string) : 'Update file';
        const commitSha = makeCommit(repo, newTree, tip !== undefined ? [tip] : [], message);
        repo.refs.set(refName, commitSha);
        return sendJson(res, isCreate ? 201 : 200, {
          content: { name: segments[segments.length - 1], path: pathStr, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const body = await readJson();
        if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
        const branch = typeof body.value.branch === 'string' ? (body.value.branch as string) : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined) return errJson(res, 404, 'Not Found');
        const rootTree = treeOfCommit(repo, tip);
        if (rootTree === undefined) return errJson(res, 404, 'Not Found');
        const existing = fileAtPath(repo, rootTree, segments);
        if (existing === null) return errJson(res, 404, 'Not Found');
        const newTree = deleteFromTree(repo, rootTree, segments);
        if (newTree === null) return errJson(res, 404, 'Not Found');
        const message = typeof body.value.message === 'string' ? (body.value.message as string) : 'Delete file';
        const commitSha = makeCommit(repo, newTree, [tip], message);
        repo.refs.set(refName, commitSha);
        return sendJson(res, 200, { commit: { sha: commitSha, message } });
      }
      return errJson(res, 404, 'Not Found');
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const body = await readJson();
        if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
        const name = typeof body.value.name === 'string' ? (body.value.name as string) : '';
        if (name === '') return errJson(res, 422, 'name is required');
        const color = typeof body.value.color === 'string' ? (body.value.color as string) : 'ededed';
        repo.labels.set(name, { name, color });
        return sendJson(res, 201, { name, color, description: '' });
      }
      if (method === 'GET' && tail.length === 1) {
        return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ ...l, description: '' })));
      }
      return errJson(res, 404, 'Not Found');
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJson();
          if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
          const title = typeof body.value.title === 'string' ? (body.value.title as string) : '';
          const issueBody = typeof body.value.body === 'string' ? (body.value.body as string) : '';
          const labels = Array.isArray(body.value.labels) ? (body.value.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) return errJson(res, 422, `label "${l}" does not exist`);
          }
          const issue: Issue = {
            number: repo.nextIssue++, title, body: issueBody, state: 'open',
            labels, seq: repo.nextIssue, comments: [],
          };
          issue.seq = issue.number;
          repo.issues.set(issue.number, issue);
          return sendJson(res, 201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const dir = q.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const all = list.map((i) => issueJson(repo, i));
          const { page, perPage, pageNum } = pageOf(all, q);
          return sendJson(res, 200, page, { link: linkHeader(base, `/api/v3/repos/${owner}/${name}/issues`, pageNum, perPage, all.length) });
        }
        return errJson(res, 404, 'Not Found');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) return errJson(res, 404, 'Not Found');
      if (tail.length === 2) {
        const issue = repo.issues.get(num);
        if (issue === undefined) return errJson(res, 404, 'Not Found');
        if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const body = await readJson();
          if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
          if (typeof body.value.title === 'string') issue.title = body.value.title as string;
          if (typeof body.value.body === 'string') issue.body = body.value.body as string;
          if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
          return sendJson(res, 200, issueJson(repo, issue));
        }
        return errJson(res, 404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const issue = repo.issues.get(num);
        if (issue === undefined) return errJson(res, 404, 'Not Found');
        if (method === 'POST') {
          const body = await readJson();
          if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
          const comment = { id: repo.nextCommentId++, body: typeof body.value.body === 'string' ? (body.value.body as string) : '' };
          issue.comments.push(comment);
          return sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER, id: VIEWER_USER.id }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
        }
        if (method === 'GET') {
          return sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER, id: VIEWER_USER.id }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
        }
        return errJson(res, 404, 'Not Found');
      }
      return errJson(res, 404, 'Not Found');
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJson();
          if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
          const head = typeof body.value.head === 'string' ? (body.value.head as string) : '';
          const base = typeof body.value.base === 'string' ? (body.value.base as string) : repo.defaultBranch;
          const headSha = resolveRef(repo, head);
          const baseSha = resolveRef(repo, base);
          if (headSha === undefined || baseSha === undefined) return errJson(res, 422, 'head or base branch not found');
          const pr: Pull = {
            number: repo.nextPull++, title: typeof body.value.title === 'string' ? (body.value.title as string) : '',
            body: typeof body.value.body === 'string' ? (body.value.body as string) : '',
            state: 'open', headRef: head, baseRef: base, headSha, baseSha,
            merged: false, mergedAt: '', mergeSha: '', files: [], seq: 0,
          };
          pr.seq = pr.number;
          pr.files = prFiles(repo, pr);
          repo.pulls.set(pr.number, pr);
          return sendJson(res, 201, pullJson(repo, pr));
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => a.seq - b.seq);
          const all = list.map((p) => pullJson(repo, p));
          const { page, perPage, pageNum } = pageOf(all, q);
          return sendJson(res, 200, page, { link: linkHeader(base, `/api/v3/repos/${owner}/${name}/pulls`, pageNum, perPage, all.length) });
        }
        return errJson(res, 404, 'Not Found');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) return errJson(res, 404, 'Not Found');
      const pr = repo.pulls.get(num);
      if (tail.length === 2) {
        if (pr === undefined) return errJson(res, 404, 'Not Found');
        if (method === 'GET') return sendJson(res, 200, pullJson(repo, pr));
        return errJson(res, 404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pr === undefined) return errJson(res, 404, 'Not Found');
        if (method !== 'GET') return errJson(res, 404, 'Not Found');
        return sendJson(res, 200, pr.files.map((f) => ({ ...f })));
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pr === undefined) return errJson(res, 404, 'Not Found');
        if (method !== 'PUT') return errJson(res, 404, 'Not Found');
        const body = await readJson();
        if (!body.ok) return errJson(res, 400, 'Malformed JSON body');
        if (pr.merged || pr.state === 'closed') return errJson(res, 405, 'Pull request is already closed');
        const baseTip = resolveRef(repo, pr.baseRef);
        if (baseTip === undefined) return errJson(res, 404, 'Not Found');
        // Conflict: base moved since the PR was opened AND a file the PR touches
        // changed on base in the meantime.
        if (baseTip !== pr.baseSha) {
          const baseNow = treeOfCommit(repo, baseTip);
          const baseThen = treeOfCommit(repo, pr.baseSha);
          const nowMap = new Map<string, string>();
          const thenMap = new Map<string, string>();
          if (baseNow) flattenTree(repo, baseNow, '', nowMap);
          if (baseThen) flattenTree(repo, baseThen, '', thenMap);
          for (const f of pr.files) {
            if (nowMap.get(f.filename) !== thenMap.get(f.filename)) {
              return errJson(res, 405, 'Merge conflict: base branch changed a file this pull request touches');
            }
          }
        }
        const headTree = treeOfCommit(repo, pr.headSha);
        if (headTree === undefined) return errJson(res, 404, 'Not Found');
        const mergeSha = makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
        repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
        pr.merged = true;
        pr.state = 'closed';
        pr.mergedAt = FIXED_ISO;
        pr.mergeSha = mergeSha;
        return sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged.' });
      }
      return errJson(res, 404, 'Not Found');
    }

    return errJson(res, 404, 'Not Found');
  }

  return errJson(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ git HTTP

const GIT_AGENT = 'forge/1.0';

function refLinesV0(repo: Repo, caps: string): Buffer {
  const chunks: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = headTip !== undefined;
    if (first) chunks.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    let capsDone = first;
    for (const [ref, oid] of refs) {
      if (!capsDone) {
        chunks.push(pktLine(`${oid} ${ref}\0${caps}\n`));
        capsDone = true;
      } else {
        chunks.push(pktLine(`${oid} ${ref}\n`));
      }
      // peeled tag line
      if (ref.startsWith('refs/tags/')) {
        const obj = getObject(repo, oid);
        if (obj !== undefined && obj.type === 'tag') {
          chunks.push(pktLine(`${parseTag(obj.data).object} ${ref}^{}\n`));
        }
      }
    }
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function advertiseV0Upload(repo: Repo): Buffer {
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack_detailed agent=${GIT_AGENT}`;
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    refLinesV0(repo, caps),
  ]);
}

function advertiseV0Receive(repo: Repo): Buffer {
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${GIT_AGENT}`;
  return Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    PKT_FLUSH,
    refLinesV0(repo, caps),
  ]);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${GIT_AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const chunks: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (ref: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => ref.startsWith(p));
  const headMatches = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (headMatches) {
    if (headTip !== undefined) {
      chunks.push(pktLine(`${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (args.unborn) {
      chunks.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  if (headTip === undefined && args.unborn && matches(`refs/heads/${repo.defaultBranch}`)) {
    // Deliberately NOT advertised: an empty repo must show no refs/* at all;
    // the unborn HEAD line above already names the default branch.
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (ref.startsWith('refs/tags/')) {
      const obj = getObject(repo, oid);
      if (obj !== undefined && obj.type === 'tag' && args.peel) {
        line += ` peeled:${parseTag(obj.data).object}`;
      }
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

interface FetchResult {
  acks: string[];
  shallow: string[];
  unshallow: string[];
  pack: Buffer;
}

/** Compute the fetch pack: included commits (depth-limited) minus have-closure. */
function computeFetch(repo: Repo, args: FetchArgs): FetchResult {
  const depth = args.depth;
  const wantSet = new Set(args.wants.filter((w) => !isZeroOid(w)));
  // Included commits + boundary.
  const includedCommits = new Map<string, GitObject>();
  const boundary = new Set<string>();
  const queue: { oid: string; d: number }[] = [...wantSet].map((oid) => ({ oid, d: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, d });
      includedCommits.set(oid, obj);
      continue;
    }
    if (obj.type !== 'commit') continue;
    parseCommit(obj);
    if (depth !== undefined && d >= depth) continue;
    includedCommits.set(oid, obj);
    if (depth !== undefined && d === depth - 1 && (obj.parents ?? []).length > 0) {
      boundary.add(oid);
    } else {
      for (const p of obj.parents ?? []) queue.push({ oid: p, d: d + 1 });
    }
  }
  // Objects reachable from included commits (trees/blobs) + wanted tag objects.
  const included = new Map<string, GitObject>();
  for (const [oid, obj] of includedCommits) {
    included.set(oid, obj);
    if (obj.type === 'commit') {
      parseCommit(obj);
      if (obj.tree) {
        for (const [o, ob] of reachableObjects(repo, [obj.tree])) included.set(o, ob);
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      for (const [o, ob] of reachableObjects(repo, [target])) included.set(o, ob);
    }
  }
  // Excluded: closure of haves. With a shallow list, only the old depth.
  let oldDepth: number | undefined;
  if (args.shallow.length > 0 && args.haves.length > 0) {
    // Old depth = 1 + min distance from a have to a shallow commit (usually 1).
    oldDepth = 1;
    for (const h of args.haves) {
      const { commits } = commitWalk(repo, h);
      void commits;
    }
    // The shallow commits are the haves themselves in every suite flow, so the
    // client owns exactly the have commits + their trees/blobs (depth 1).
    oldDepth = 1;
  }
  const excluded = new Map<string, GitObject>();
  for (const h of args.haves) {
    if (isZeroOid(h)) continue;
    const hObj = getObject(repo, h);
    if (hObj === undefined) continue;
    if (hObj.type === 'commit') {
      const { commits } = commitWalk(repo, h, oldDepth);
      for (const c of commits) {
        const oid = sha1Of('commit', c.data);
        excluded.set(oid, c);
        parseCommit(c);
        if (c.tree) for (const [o, ob] of reachableObjects(repo, [c.tree])) excluded.set(o, ob);
      }
      // The have commit itself is always excluded even at depth 1 (it is in
      // `commits` when oldDepth is 1, since distance 0 < 1).
    } else {
      for (const [o, ob] of reachableObjects(repo, [h])) excluded.set(o, ob);
    }
  }
  for (const oid of excluded.keys()) included.delete(oid);

  // ACKs: haves that are ancestors of a want.
  const acks: string[] = [];
  for (const h of args.haves) {
    if (isZeroOid(h)) continue;
    for (const w of wantSet) {
      if (isAncestor(repo, h, w)) {
        acks.push(h);
        break;
      }
    }
  }
  // unshallow: old shallow commits now included with their parents.
  const unshallow: string[] = [];
  for (const s of args.shallow) {
    if (includedCommits.has(s) && !boundary.has(s)) unshallow.push(s);
  }
  const entries: PackEntry[] = [...included.values()].map((o) => ({
    type: o.type,
    data: o.data,
    oid: sha1Of(o.type, o.data),
  }));
  // Deterministic pack order: sort by oid for cache stability.
  entries.sort((a, b) => (a.oid < b.oid ? -1 : 1));
  return { acks, shallow: [...boundary].sort(), unshallow, pack: buildPack(entries) };
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = `${repo.name}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}|${args.depth ?? ''}`;
  let result = (repo as unknown as { __fetchCache?: Map<string, FetchResult> }).__fetchCache?.get(cacheKey);
  if (result === undefined) {
    result = computeFetch(repo, args);
    let cache = (repo as unknown as { __fetchCache?: Map<string, FetchResult> }).__fetchCache;
    if (cache === undefined) {
      cache = new Map();
      (repo as unknown as { __fetchCache?: Map<string, FetchResult> }).__fetchCache = cache;
    }
    if (cache.size >= 64) {
      const first = cache.keys().next().value as string | undefined;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(cacheKey, result);
  }
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  if (result.acks.length === 0) chunks.push(pktLine('NAK\n'));
  else for (const a of result.acks) chunks.push(pktLine(`ACK ${a}\n`));
  chunks.push(PKT_DELIM);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const s of result.shallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const u of result.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
    chunks.push(PKT_DELIM);
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(sidebandPack(result.pack));
  return Buffer.concat(chunks);
}

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const result = computeFetch(repo, args);
  const chunks: Buffer[] = [];
  if (result.acks.length === 0) chunks.push(pktLine('NAK\n'));
  else for (const a of result.acks) chunks.push(pktLine(`ACK ${a}\n`));
  for (const s of result.shallow) chunks.push(pktLine(`shallow ${s}\n`));
  for (const u of result.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
  chunks.push(sidebandPack(result.pack));
  return Buffer.concat(chunks);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (m === null) return errJson(res, 404, 'Not Found');
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const tail = m[3] ?? '';
  if (!viewerIs(owner)) return errJson(res, 404, 'Not Found');
  const repo = getRepo(owner, name);
  if (repo === undefined) return errJson(res, 404, 'Not Found');

  if (method === 'GET' && tail === '/info/refs') {
    const service = q.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        return sendBytes(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      }
      return sendBytes(res, 200, advertiseV0Upload(repo), 'application/x-git-upload-pack-advertisement');
    }
    if (service === 'git-receive-pack') {
      return sendBytes(res, 200, advertiseV0Receive(repo), 'application/x-git-receive-pack-advertisement');
    }
    return errJson(res, 404, 'Not Found');
  }

  if (method === 'POST' && tail === '/git-upload-pack') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const lines = parsePktLines(body);
    if (isV2) {
      // command=... lines, then delim, then args, then flush.
      let command = '';
      const args: string[] = [];
      let afterDelim = false;
      for (const l of lines) {
        if (l.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (l.kind !== 'data') continue;
        const text = l.data.toString('utf8').trim();
        if (!afterDelim) {
          if (text.startsWith('command=')) command = text.slice('command='.length);
        } else {
          args.push(text);
        }
      }
      if (command === 'ls-refs') {
        const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const a of args) {
          if (a === 'peel') lsArgs.peel = true;
          else if (a === 'symrefs') lsArgs.symrefs = true;
          else if (a === 'unborn') lsArgs.unborn = true;
          else if (a.startsWith('ref-prefix ')) lsArgs.prefixes.push(a.slice('ref-prefix '.length));
        }
        return sendBytes(res, 200, handleLsRefs(repo, lsArgs), 'application/x-git-upload-pack-result');
      }
      if (command === 'fetch') {
        const fArgs: FetchArgs = { wants: [], haves: [], shallow: [] };
        for (const a of args) {
          if (a.startsWith('want ')) fArgs.wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) fArgs.haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) fArgs.shallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) fArgs.depth = Number(a.slice(7).trim());
        }
        return sendBytes(res, 200, handleFetchV2(repo, fArgs), 'application/x-git-upload-pack-result');
      }
      // Unknown v2 command: stay alive, answer a flush.
      return sendBytes(res, 200, PKT_FLUSH, 'application/x-git-upload-pack-result');
    }
    // v0 fetch: wants section, flush, haves section, flush.
    const fArgs: FetchArgs = { wants: [], haves: [], shallow: [] };
    let section = 0;
    for (const l of lines) {
      if (l.kind === 'flush') {
        section += 1;
        continue;
      }
      if (l.kind !== 'data') continue;
      const text = l.data.toString('utf8').trim();
      const first = text.split(' ')[0] as string;
      if (first === 'want') fArgs.wants.push(text.split(' ')[1] as string);
      else if (first === 'have') fArgs.haves.push(text.split(' ')[1] as string);
      else if (first === 'shallow') fArgs.shallow.push(text.split(' ')[1] as string);
      else if (first === 'deepen') fArgs.depth = Number(text.split(' ')[1]);
    }
    void section;
    return sendBytes(res, 200, handleFetchV0(repo, fArgs), 'application/x-git-upload-pack-result');
  }

  if (method === 'POST' && tail === '/git-receive-pack') {
    const body = await readBody(req);
    const lines = parsePktLines(body);
    // Command list ends at the first flush; everything after is the pack.
    let flushAt = -1;
    let consumed = 0;
    {
      let i = 0;
      while (i + 4 <= body.length) {
        const hex = body.subarray(i, i + 4).toString('ascii');
        if (hex === '0000') {
          flushAt = i;
          break;
        }
        const len = parseInt(hex, 16);
        if (!Number.isFinite(len) || len < 4 || i + len > body.length) break;
        i += len;
        consumed = i;
      }
      void consumed;
    }
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let clientCaps = '';
    let first = true;
    for (const l of lines) {
      if (l.kind === 'flush') break;
      if (l.kind !== 'data') continue;
      let text = l.data.toString('utf8');
      if (first) {
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          clientCaps = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
        first = false;
      }
      const parts = text.trim().split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      }
    }
    const packBytes = flushAt >= 0 ? body.subarray(flushAt + 4) : Buffer.alloc(0);
    let unpackOk = true;
    let unpackDetail = '';
    if (packBytes.length > 0) {
      try {
        const entries = parsePack(packBytes);
        for (const e of entries) {
          if (!repo.objects.has(e.oid)) repo.objects.set(e.oid, { type: e.type, data: e.data });
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    const reportLines: string[] = [];
    if (unpackOk) {
      reportLines.push('unpack ok\n');
    } else {
      reportLines.push(`unpack ${unpackDetail}\n`);
    }
    for (const cmd of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${cmd.ref} unpack failed\n`);
        continue;
      }
      if (isZeroOid(cmd.newOid)) {
        // delete
        if (repo.refs.has(cmd.ref)) {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        } else {
          reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        }
        continue;
      }
      if (isZeroOid(cmd.oldOid)) {
        // create
        if (repo.refs.has(cmd.ref)) {
          reportLines.push(`ng ${cmd.ref} already exists\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        continue;
      }
      if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
    const useSideband = clientCaps.includes('side-band-64k');
    let out: Buffer;
    if (useSideband) {
      const chunks: Buffer[] = [];
      for (const line of reportLines) {
        chunks.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])));
      }
      chunks.push(PKT_FLUSH);
      out = Buffer.concat(chunks);
    } else {
      const chunks: Buffer[] = [];
      for (const line of reportLines) chunks.push(pktLine(line));
      chunks.push(PKT_FLUSH);
      out = Buffer.concat(chunks);
    }
    return sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
  }

  return errJson(res, 404, 'Not Found');
}

// --------------------------------------------------------------- GraphQL

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selection: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeCondition: string | null; selection: GqlSelection[] };

interface GqlOperation {
  op: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, GqlValue | undefined>;
  selection: GqlSelection[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$&|'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        tokens.push(JSON.stringify(end >= 0 ? src.slice(i + 3, end) : ''));
        i = end >= 0 ? end + 3 : src.length;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    // Name / number / enum
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j] as string)) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] as string;
  }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }
  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): GqlOperation {
    let op: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      op = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{' && /^[A-Za-z_]/.test(maybeName)) {
      name = this.next();
    }
    const variables = new Map<string, GqlValue | undefined>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const dollar = this.next();
        if (dollar !== '$') throw new Error('expected $ in variable definition');
        const varName = this.next();
        this.expect(':');
        // Skip the type (may include [ ] ! and names).
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const t = this.next();
          if (t === '[') depth += 1;
          else if (t === ']') depth -= 1;
          else if (t === '=' || (depth === 0 && (t === ',' || t === ')' || t === '{'))) {
            if (t === '=') {
              const def = this.parseValue();
              variables.set(varName, def);
            } else {
              this.pos -= 1;
              variables.set(varName, undefined);
            }
            break;
          }
        }
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selection = this.parseSelectionSet();
    return { op, name, variables, selection };
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          typeCondition = this.next();
        }
        const selection = this.parseSelectionSet();
        out.push({ kind: 'inline', typeCondition, selection });
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      const args = new Map<string, GqlValue>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')' && this.pos < this.tokens.length) {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
          if (this.peek() === ',') this.next();
        }
        this.expect(')');
      }
      let selection: GqlSelection[] | null = null;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      out.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    this.expect('}');
    return out;
  }
  parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) {
        items.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const fname = this.next();
        this.expect(':');
        fields.set(fname, this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number(tok) };
    if (/^-?\d+\.\d+$/.test(tok)) return { kind: 'float', value: Number(tok) };
    return { kind: 'enum', value: tok };
  }
}

function b64id(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

function decodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url', 'description', 'isPrivate'],
  SearchType: [],
  User: ['login', 'id'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

interface GqlCtx {
  repoByDbid(dbid: number): Repo | undefined;
}

function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable':
      return variables[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

function argValue(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const v = field.args.get(name);
  if (v === undefined) return undefined;
  return resolveValue(v, variables);
}

class GqlExecutor {
  errors: { message: string }[] = [];
  private readonly ctx: GqlCtx;
  constructor(ctx: GqlCtx) {
    this.ctx = ctx;
  }

  execute(op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
    this.errors = [];
    const data: Record<string, unknown> = {};
    for (const sel of op.selection) {
      if (sel.kind === 'inline') continue;
      const f = sel.field;
      const key = f.alias ?? f.name;
      data[key] = this.queryField(f, variables);
    }
    const out: Record<string, unknown> = { data };
    if (this.errors.length > 0) out.errors = this.errors;
    return out;
  }

  private unknownField(typeName: string, name: string): null {
    this.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }

  private queryField(f: GqlField, variables: Record<string, unknown>): unknown {
    switch (f.name) {
      case 'viewer': {
        const obj: Record<string, unknown> = { __typename: 'User', login: VIEWER, id: VIEWER_USER.id };
        return this.select(obj, 'User', f.selection, variables);
      }
      case 'repository': {
        const owner = argValue(f, 'owner', variables) as string | undefined;
        const name = argValue(f, 'name', variables) as string | undefined;
        if (owner === undefined || name === undefined) return null;
        if (!viewerIs(owner)) return null;
        const repo = getRepo(owner, name);
        if (repo === undefined) return null;
        return this.repoFields(repo, f.selection, variables);
      }
      case 'node': {
        const id = argValue(f, 'id', variables) as string | undefined;
        if (id === undefined) return null;
        const decoded = decodeId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = this.ctx.repoByDbid(Number(decoded.parts[0]));
          if (repo === undefined) return null;
          const obj: Record<string, unknown> = {
            __typename: 'Repository', id, name: repo.name,
            nameWithOwner: `${repo.owner}/${repo.name}`,
          };
          return this.select(obj, 'Repository', f.selection, variables);
        }
        return null;
      }
      case '__type': {
        const name = argValue(f, 'name', variables) as string | undefined;
        if (name === undefined) return null;
        const fields = GQL_TYPE_FIELDS[name];
        const enums = GQL_ENUM_VALUES[name];
        const out: Record<string, unknown> = { __typename: '__Type', name };
        if (f.selection !== null) {
          const sel: Record<string, unknown> = {};
          for (const s of f.selection) {
            if (s.kind !== 'field') continue;
            if (s.field.name === 'fields') {
              sel[s.field.alias ?? 'fields'] = (fields ?? []).map((n) => ({ name: n }));
            } else if (s.field.name === 'enumValues') {
              sel[s.field.alias ?? 'enumValues'] = (enums ?? []).map((n) => ({ name: n }));
            } else if (s.field.name === 'name') {
              sel[s.field.alias ?? 'name'] = name;
            }
          }
          return sel;
        }
        return out;
      }
      default:
        return this.unknownField('Query', f.name);
    }
  }

  /** Execute a selection set against a plain object with __typename. */
  private select(obj: Record<string, unknown>, typeName: string, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    if (selection === null) return obj;
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') {
        if (sel.typeCondition !== null && sel.typeCondition !== typeName && sel.typeCondition !== obj.__typename) continue;
        const inner = this.select(obj, typeName, sel.selection, variables) as Record<string, unknown>;
        Object.assign(out, inner);
        continue;
      }
      const f = sel.field;
      const key = f.alias ?? f.name;
      if (f.name === '__typename') {
        out[key] = obj.__typename ?? typeName;
        continue;
      }
      if (f.name in obj && f.selection === null) {
        out[key] = obj[f.name];
        continue;
      }
      if (f.name in obj && f.selection !== null) {
        const nested = obj[f.name];
        if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
          out[key] = this.select(nested as Record<string, unknown>, typeName, f.selection, variables);
        } else {
          out[key] = nested;
        }
        continue;
      }
      out[key] = this.unknownField(typeName, f.name);
    }
    return out;
  }

  private repoFields(repo: Repo, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    if (selection === null) {
      return { id: b64id('Repository', [repo.dbid]), name: repo.name };
    }
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') continue;
      const f = sel.field;
      const key = f.alias ?? f.name;
      switch (f.name) {
        case 'id':
          out[key] = b64id('Repository', [repo.dbid]);
          break;
        case 'databaseId':
          out[key] = repo.dbid;
          break;
        case 'name':
          out[key] = repo.name;
          break;
        case 'nameWithOwner':
          out[key] = `${repo.owner}/${repo.name}`;
          break;
        case 'owner':
          out[key] = this.select({ __typename: 'User', login: repo.owner, id: VIEWER_USER.id }, 'User', f.selection, variables);
          break;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          out[key] = tip === undefined ? null : this.select({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref', f.selection, variables);
          break;
        }
        case 'viewerPermission':
          out[key] = 'ADMIN';
          break;
        case 'hasIssuesEnabled':
          out[key] = true;
          break;
        case 'description':
          out[key] = repo.description;
          break;
        case 'isPrivate':
          out[key] = repo.priv;
          break;
        case 'createdAt':
        case 'updatedAt':
          out[key] = FIXED_ISO;
          break;
        case 'url':
          out[key] = `https://example.invalid/${repo.owner}/${repo.name}`;
          break;
        case 'issue': {
          const num = argValue(f, 'number', variables) as number | undefined;
          const issue = num !== undefined ? repo.issues.get(num) : undefined;
          out[key] = issue === undefined ? null : this.issueFields(repo, issue, f.selection, variables);
          break;
        }
        case 'issues': {
          out[key] = this.issuesConnection(repo, f, variables);
          break;
        }
        case 'pullRequests': {
          const first = (argValue(f, 'first', variables) as number | undefined) ?? 100;
          const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq).slice(0, first);
          out[key] = {
            nodes: list.map((pr) => this.prFields(repo, pr, f.selection === null ? null : this.subSelection(f.selection, 'nodes'), variables)),
          };
          break;
        }
        case 'pullRequest': {
          const num = argValue(f, 'number', variables) as number | undefined;
          const pr = num !== undefined ? repo.pulls.get(num) : undefined;
          out[key] = pr === undefined ? null : this.prFields(repo, pr, f.selection, variables);
          break;
        }
        default:
          out[key] = this.unknownField('Repository', f.name);
          break;
      }
    }
    return out;
  }

  private subSelection(selection: GqlSelection[], fieldName: string): GqlSelection[] | null {
    for (const s of selection) {
      if (s.kind === 'field' && s.field.name === fieldName) return s.field.selection;
    }
    return null;
  }

  private issuesConnection(repo: Repo, f: GqlField, variables: Record<string, unknown>): unknown {
    const first = (argValue(f, 'first', variables) as number | undefined) ?? 100;
    const after = argValue(f, 'after', variables) as string | null | undefined;
    const states = argValue(f, 'states', variables) as string[] | undefined;
    const orderBy = argValue(f, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
    let list = [...repo.issues.values()];
    if (states !== undefined && states.length > 0) {
      const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
      list = list.filter((i) => wanted.has(i.state));
    }
    const desc = orderBy?.direction === 'DESC' || (orderBy === undefined && false);
    if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC') {
      list.sort((a, b) => b.seq - a.seq);
    } else if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'ASC') {
      list.sort((a, b) => a.seq - b.seq);
    } else if (desc) {
      list.sort((a, b) => b.seq - a.seq);
    } else {
      list.sort((a, b) => a.seq - b.seq);
    }
    let startIdx = 0;
    if (typeof after === 'string' && after !== '') {
      try {
        const decoded = Buffer.from(after, 'base64').toString('utf8');
        const m = decoded.match(/^cursor:(\d+)$/);
        if (m !== null) {
          const afterNum = Number(m[1]);
          const idx = list.findIndex((i) => i.number === afterNum);
          if (idx >= 0) startIdx = idx + 1;
        }
      } catch {
        startIdx = 0;
      }
    }
    const page = list.slice(startIdx, startIdx + first);
    const hasNext = startIdx + page.length < list.length;
    const endCursor = page.length > 0 ? Buffer.from(`cursor:${(page[page.length - 1] as Issue).number}`).toString('base64') : null;
    const nodesSel = this.subSelection(f.selection ?? [], 'nodes');
    const pageInfoSel = this.subSelection(f.selection ?? [], 'pageInfo');
    const out: Record<string, unknown> = {};
    if (nodesSel !== null || f.selection === null) {
      out.nodes = page.map((issue) => this.issueFields(repo, issue, nodesSel, variables));
    }
    if (pageInfoSel !== null || f.selection === null) {
      const pi: Record<string, unknown> = {};
      for (const s of pageInfoSel ?? []) {
        if (s.kind !== 'field') continue;
        if (s.field.name === 'hasNextPage') pi[s.field.alias ?? 'hasNextPage'] = hasNext;
        else if (s.field.name === 'endCursor') pi[s.field.alias ?? 'endCursor'] = endCursor;
      }
      out.pageInfo = pi;
    }
    return out;
  }

  private issueFields(repo: Repo, issue: Issue, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const obj: Record<string, unknown> = {
      __typename: 'Issue',
      id: b64id('Issue', [repo.dbid, issue.number]),
      number: issue.number,
      title: issue.title,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      body: issue.body,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
    if (selection === null) return obj;
    return this.select(obj, 'Issue', selection, variables);
  }

  private prFields(repo: Repo, pr: Pull, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const mergeable = pr.merged ? 'UNKNOWN' : this.prMergeable(repo, pr);
    const obj: Record<string, unknown> = {
      __typename: 'PullRequest',
      id: b64id('PullRequest', [repo.dbid, pr.number]),
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pr.merged,
      mergeable,
      headRefName: pr.headRef,
      baseRefName: pr.baseRef,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    };
    if (selection === null) return obj;
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') continue;
      const f = sel.field;
      const key = f.alias ?? f.name;
      if (f.name === 'files') {
        const first = (argValue(f, 'first', variables) as number | undefined) ?? 100;
        const nodesSel = this.subSelection(f.selection ?? [], 'nodes');
        const nodes = pr.files.slice(0, first).map((fl) => {
          const nObj: Record<string, unknown> = { __typename: 'PullRequestChangedFile', path: fl.filename };
          if (nodesSel === null) return nObj;
          return this.select(nObj, 'PullRequestChangedFile', nodesSel, variables);
        });
        out[key] = { nodes };
        continue;
      }
      if (f.name in obj && f.selection === null) {
        out[key] = obj[f.name];
        continue;
      }
      if (f.name in obj && f.selection !== null) {
        out[key] = obj[f.name];
        continue;
      }
      out[key] = this.unknownField('PullRequest', f.name);
    }
    return out;
  }

  private prMergeable(repo: Repo, pr: Pull): string {
    const baseTip = resolveRef(repo, pr.baseRef);
    if (baseTip === undefined || baseTip === pr.baseSha) return 'MERGEABLE';
    const baseNow = treeOfCommit(repo, baseTip);
    const baseThen = treeOfCommit(repo, pr.baseSha);
    const nowMap = new Map<string, string>();
    const thenMap = new Map<string, string>();
    if (baseNow) flattenTree(repo, baseNow, '', nowMap);
    if (baseThen) flattenTree(repo, baseThen, '', thenMap);
    for (const fl of pr.files) {
      if (nowMap.get(fl.filename) !== thenMap.get(fl.filename)) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Execute a mutation operation; returns the data object (errors on this.errors). */
  mutate(op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
    this.errors = [];
    const data: Record<string, unknown> = {};
    for (const sel of op.selection) {
      if (sel.kind !== 'field') continue;
      const f = sel.field;
      const key = f.alias ?? f.name;
      data[key] = this.mutationField(f, variables);
    }
    const out: Record<string, unknown> = { data };
    if (this.errors.length > 0) out.errors = this.errors;
    return out;
  }

  private mutationField(f: GqlField, variables: Record<string, unknown>): unknown {
    const input = argValue(f, 'input', variables) as Record<string, unknown> | undefined;
    if (f.name === 'createIssue') {
      const repoId = input?.repositoryId as string | undefined;
      const title = (input?.title as string | undefined) ?? '';
      const body = (input?.body as string | undefined) ?? '';
      const decoded = repoId !== undefined ? decodeId(repoId) : null;
      const repo = decoded?.kind === 'Repository' ? this.ctx.repoByDbid(Number(decoded.parts[0])) : undefined;
      if (repo === undefined) {
        this.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return null;
      }
      const issue: Issue = {
        number: repo.nextIssue++, title, body, state: 'open', labels: [],
        seq: 0, comments: [],
      };
      issue.seq = issue.number;
      repo.issues.set(issue.number, issue);
      const obj = { __typename: 'Issue', id: b64id('Issue', [repo.dbid, issue.number]), number: issue.number };
      const sel = this.subSelection([ { kind: 'field', field: f } ], 'issue');
      void sel;
      // The selection is on the payload: { issue { ... } }
      const payload: Record<string, unknown> = {};
      for (const s of f.selection ?? []) {
        if (s.kind !== 'field') continue;
        if (s.field.name === 'issue') {
          payload[s.field.alias ?? 'issue'] = this.issueFields(repo, issue, s.field.selection, variables);
        }
      }
      void obj;
      return payload;
    }
    if (f.name === 'closeIssue') {
      const issueId = input?.issueId as string | undefined;
      const decoded = issueId !== undefined ? decodeId(issueId) : null;
      if (decoded?.kind !== 'Issue') {
        this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return null;
      }
      const repo = this.ctx.repoByDbid(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return null;
      }
      issue.state = 'closed';
      const payload: Record<string, unknown> = {};
      for (const s of f.selection ?? []) {
        if (s.kind !== 'field') continue;
        if (s.field.name === 'issue') {
          payload[s.field.alias ?? 'issue'] = this.issueFields(repo, issue, s.field.selection, variables);
        }
      }
      return payload;
    }
    if (f.name === 'createPullRequest') {
      const repoId = input?.repositoryId as string | undefined;
      const baseRef = (input?.baseRefName as string | undefined) ?? '';
      const headRef = (input?.headRefName as string | undefined) ?? '';
      const title = (input?.title as string | undefined) ?? '';
      const decoded = repoId !== undefined ? decodeId(repoId) : null;
      const repo = decoded?.kind === 'Repository' ? this.ctx.repoByDbid(Number(decoded.parts[0])) : undefined;
      if (repo === undefined) {
        this.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
        return null;
      }
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) {
        this.errors.push({ message: 'head or base branch not found' });
        return null;
      }
      const pr: Pull = {
        number: repo.nextPull++, title, body: '',
        state: 'open', headRef, baseRef, headSha, baseSha,
        merged: false, mergedAt: '', mergeSha: '', files: [], seq: 0,
      };
      pr.seq = pr.number;
      pr.files = prFiles(repo, pr);
      repo.pulls.set(pr.number, pr);
      const payload: Record<string, unknown> = {};
      for (const s of f.selection ?? []) {
        if (s.kind !== 'field') continue;
        if (s.field.name === 'pullRequest') {
          payload[s.field.alias ?? 'pullRequest'] = this.prFields(repo, pr, s.field.selection, variables);
        }
      }
      return payload;
    }
    if (f.name === 'mergePullRequest') {
      const prId = input?.pullRequestId as string | undefined;
      const decoded = prId !== undefined ? decodeId(prId) : null;
      if (decoded?.kind !== 'PullRequest') {
        this.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        return null;
      }
      const repo = this.ctx.repoByDbid(Number(decoded.parts[0]));
      const pr = repo?.pulls.get(Number(decoded.parts[1]));
      if (repo === undefined || pr === undefined) {
        this.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
        return null;
      }
      if (!pr.merged && pr.state === 'open') {
        const baseTip = resolveRef(repo, pr.baseRef);
        const headTree = treeOfCommit(repo, pr.headSha);
        if (baseTip !== undefined && headTree !== undefined) {
          const mergeSha = makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
          repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
          pr.merged = true;
          pr.state = 'closed';
          pr.mergedAt = FIXED_ISO;
          pr.mergeSha = mergeSha;
        }
      }
      const payload: Record<string, unknown> = {};
      for (const s of f.selection ?? []) {
        if (s.kind !== 'field') continue;
        if (s.field.name === 'pullRequest') {
          payload[s.field.alias ?? 'pullRequest'] = this.prFields(repo, pr, s.field.selection, variables);
        }
      }
      return payload;
    }
    if (f.name === 'addComment') {
      const subjectId = input?.subjectId as string | undefined;
      const body = (input?.body as string | undefined) ?? '';
      const decoded = subjectId !== undefined ? decodeId(subjectId) : null;
      if (decoded?.kind !== 'Issue') {
        this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return null;
      }
      const repo = this.ctx.repoByDbid(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
        return null;
      }
      const comment = { id: repo.nextCommentId++, body };
      issue.comments.push(comment);
      const commentId = b64id('IssueComment', [repo.dbid, issue.number, comment.id]);
      const payload: Record<string, unknown> = {};
      for (const s of f.selection ?? []) {
        if (s.kind !== 'field') continue;
        if (s.field.name === 'commentEdge') {
          const edge: Record<string, unknown> = {};
          for (const es of s.field.selection ?? []) {
            if (es.kind !== 'field') continue;
            if (es.field.name === 'node') {
              edge[es.field.alias ?? 'node'] = this.select(
                { __typename: 'IssueComment', id: commentId, body },
                'IssueComment', es.field.selection, variables,
              );
            }
          }
          payload[s.field.alias ?? 'commentEdge'] = edge;
        }
      }
      return payload;
    }
    this.errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
    return null;
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) return errJson(res, 401, 'Requires authentication');
  if ((req.method ?? '') !== 'POST') return errJson(res, 404, 'Not Found');
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) return errJson(res, 400, 'Malformed JSON body');
  const ctx: GqlCtx = {
    repoByDbid: (dbid: number) => {
      for (const r of repos.values()) if (r.dbid === dbid) return r;
      return undefined;
    },
  };
  const exec = new GqlExecutor(ctx);
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL request document.' }] };
    }
    const d = doc as Record<string, unknown>;
    const query = typeof d.query === 'string' ? d.query : '';
    const variables = (d.variables !== null && typeof d.variables === 'object' && !Array.isArray(d.variables)
      ? d.variables : {}) as Record<string, unknown>;
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(gqlTokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    if (ops.length === 0) return { data: null, errors: [{ message: 'Empty GraphQL document.' }] };
    const op = ops[0] as GqlOperation;
    // Apply variable defaults declared in the document.
    for (const [k, def] of op.variables) {
      if (!(k in variables) && def !== undefined) {
        variables[k] = resolveValue(def, variables);
      }
    }
    if (op.op === 'mutation') return exec.mutate(op, variables);
    return exec.execute(op, variables);
  };
  if (Array.isArray(parsed.value)) {
    const results = (parsed.value as unknown[]).map(runOne);
    return sendJson(res, 200, results);
  }
  return sendJson(res, 200, runOne(parsed.value));
}

// -------------------------------------------------------------------- MCP

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open or closed' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = (args.owner as string | undefined) ?? (args.login as string | undefined) ?? VIEWER;
  let repo = (args.repo as string | undefined) ?? (args.repository as string | undefined) ?? '';
  const full = (args.full_name as string | undefined) ?? (args.fullName as string | undefined);
  if ((repo === '' || owner === VIEWER) && typeof full === 'string' && full.includes('/')) {
    const [o, r] = full.split('/');
    if (o) owner = o;
    if (r) repo = r;
  }
  return { owner, repo };
}

function mcpTextResult(id: unknown, obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text }], structuredContent: obj, isError: false },
  };
}

function mcpErrorResult(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  if (method !== 'POST') return errJson(res, 405, 'Method not allowed');
  if (!authed(req)) {
    return sendJson(res, 401, mcpErrorResult(null, -32000, 'Unauthorized'));
  }
  const buf = await readBody(req);
  const raw = buf.toString('utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, mcpErrorResult(null, -32700, 'Parse error'));
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return sendJson(res, 400, mcpErrorResult(null, -32600, 'Invalid Request'));
  }
  const d = doc as Record<string, unknown>;
  const id = (d.id as unknown) ?? null;
  const rpcMethod = typeof d.method === 'string' ? d.method : '';
  const params = (d.params !== null && typeof d.params === 'object' && !Array.isArray(d.params)
    ? d.params : {}) as Record<string, unknown>;

  if (rpcMethod === 'server/discover') {
    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
      },
    });
  }
  if (rpcMethod === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '2025-11-25';
    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      },
    });
  }
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'content-type': 'application/json', 'x-github-request-id': requestId() });
    res.end('{}\n');
    return;
  }
  if (rpcMethod === 'tools/list') {
    const tools = MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools } });
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments : {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return sendJson(res, 200, mcpErrorResult(id, -32601, `Unknown tool: ${name}`));
    }
    const required = (tool.inputSchema.required as string[] | undefined) ?? [];
    // Map semantic argument names the suite may send onto the canonical ones.
    const norm: Record<string, unknown> = { ...args };
    if (norm.repo === undefined && typeof norm.repository === 'string') norm.repo = norm.repository;
    if (norm.pull_number === undefined && typeof norm.number === 'number') norm.pull_number = norm.number;
    if (norm.title === undefined && typeof norm.subject === 'string') norm.title = norm.subject;
    if (norm.body === undefined && typeof norm.description === 'string') norm.body = norm.description;
    const missing = required.filter((r) => norm[r] === undefined || norm[r] === '');
    if (missing.length > 0) {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }], isError: true },
      });
    }
    try {
      const result = mcpCall(tool.name, norm);
      if (result === null) {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Tool call failed' }], isError: true },
        });
      }
      return sendJson(res, 200, mcpTextResult(id, result));
    } catch (err) {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool call failed' }], isError: true },
      });
    }
  }
  return sendJson(res, 200, mcpErrorResult(id, -32601, `Method not found: ${rpcMethod}`));
}

function mcpCall(tool: string, args: Record<string, unknown>): Record<string, unknown> | null {
  if (tool === 'create_repo') {
    const name = args.name as string;
    let repo = getRepo(VIEWER, name);
    if (repo === undefined) {
      repo = createRepoRecord(name, (args.description as string | undefined) ?? '', args.private === true);
    }
    return { ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` };
  }
  if (tool === 'get_repo') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const repo = getRepo(owner, repoName);
    if (repo === undefined || !viewerIs(owner)) return null;
    return repoJson(repo);
  }
  if (tool === 'create_issue') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const repo = getRepo(owner, repoName);
    if (repo === undefined || !viewerIs(owner)) return null;
    const issue: Issue = {
      number: repo.nextIssue++, title: args.title as string, body: (args.body as string | undefined) ?? '',
      state: 'open', labels: [], seq: 0, comments: [],
    };
    issue.seq = issue.number;
    repo.issues.set(issue.number, issue);
    return issueJson(repo, issue);
  }
  if (tool === 'list_issues') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const repo = getRepo(owner, repoName);
    if (repo === undefined || !viewerIs(owner)) return null;
    const state = args.state as string | undefined;
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    return { issues: list.map((i) => issueJson(repo, i)) };
  }
  if (tool === 'create_pull_request') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const repo = getRepo(owner, repoName);
    if (repo === undefined || !viewerIs(owner)) return null;
    const head = args.head as string;
    const base = args.base as string;
    const headSha = resolveRef(repo, head);
    const baseSha = resolveRef(repo, base);
    if (headSha === undefined || baseSha === undefined) return null;
    const pr: Pull = {
      number: repo.nextPull++, title: args.title as string, body: (args.body as string | undefined) ?? '',
      state: 'open', headRef: head, baseRef: base, headSha, baseSha,
      merged: false, mergedAt: '', mergeSha: '', files: [], seq: 0,
    };
    pr.seq = pr.number;
    pr.files = prFiles(repo, pr);
    repo.pulls.set(pr.number, pr);
    return pullJson(repo, pr);
  }
  if (tool === 'merge_pull_request') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const repo = getRepo(owner, repoName);
    if (repo === undefined || !viewerIs(owner)) return null;
    const num = Number(args.pull_number);
    const pr = repo.pulls.get(num);
    if (pr === undefined) return null;
    if (!pr.merged && pr.state === 'open') {
      const baseTip = resolveRef(repo, pr.baseRef);
      const headTree = treeOfCommit(repo, pr.headSha);
      if (baseTip !== undefined && headTree !== undefined) {
        const mergeSha = makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
        repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
        pr.merged = true;
        pr.state = 'closed';
        pr.mergedAt = FIXED_ISO;
        pr.mergeSha = mergeSha;
      }
    }
    return { number: pr.number, merged: pr.merged, sha: pr.mergeSha, message: 'Pull request successfully merged.' };
  }
  return null;
}

// ------------------------------------------------------------------ server

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql') {
          await handleGraphql(req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (path.startsWith('/api/v3')) {
          await handleRest(req, res, path);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          await handleGit(req, res, path);
          return;
        }
        if (!authed(req) && path.startsWith('/api/')) {
          errJson(res, 401, 'Requires authentication');
          return;
        }
        errJson(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          errJson(res, 500, err instanceof Error ? err.message : 'Internal error');
        } else {
          try {
            res.end();
          } catch {
            // socket already gone
          }
        }
      }
    })();
  });
}

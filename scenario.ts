// scenario.ts — The in-memory forge: repositories, git objects, issues,
// pull requests, labels and comments, plus the git graph algorithms the
// smart-HTTP surface needs (reachability, shallow boundaries, three-way
// merge). Standard library only. Every line was written fresh for this
// entry; the old build's files were deleted unread.
//
// Identity note: the suite's scenario seed is fixed in the kit's wire.ts,
// so the token owner's login is the fixed viewer login below. Repo creation
// (POST /api/v3/user/repos, MCP create_repo) carries no owner in its body;
// the created repository always belongs to this viewer, exactly as the
// suite's clients assume.

import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';
const FIXED_EPOCH = 1739175597;

let clockTick = 0;
/** Deterministic ISO timestamp, one second per call from a fixed base. */
export function nextTimestamp(): string {
  const epoch = FIXED_EPOCH + clockTick;
  clockTick += 1;
  return new Date(epoch * 1000).toISOString();
}
/** Deterministic author/committer line for REST-created commits. */
export function identityLine(): string {
  const epoch = FIXED_EPOCH + clockTick;
  return `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${epoch} +0000`;
}

/** Opaque, stable global id: base64url of a namespaced key (never the raw id). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, { type: string; data: Buffer }>;
  issues: Map<number, Issue>;
  comments: Map<number, Comment[]>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  numberSeq: number;
  commentSeq: number;
  fetchPackCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

/** The whole forge: every repository, keyed by "owner/name". */
export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const id = this.repoSeq;
    this.repoSeq += 1;
    const now = nextTimestamp();
    const repo: Repo = {
      id,
      nodeId: globalId('repo', `${owner}/${name}`),
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      labels: new Map(),
      numberSeq: 0,
      commentSeq: 0,
      fetchPackCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  findRepoByNodeId(nodeId: string): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.nodeId === nodeId) return repo;
    return undefined;
  }

  findIssueByNodeId(nodeId: string): { repo: Repo; issue: Issue } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.nodeId === nodeId) return { repo, issue };
    }
    return undefined;
  }

  findPullByNodeId(nodeId: string): { repo: Repo; pull: Pull } | undefined {
    for (const repo of this.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.nodeId === nodeId) return { repo, pull };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- git objects

export function putObject(repo: Repo, type: string, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): { type: string; data: Buffer } | undefined {
  return repo.objects.get(oid);
}

/** All objects reachable from `oid` (commits, trees, blobs, tags). */
export function reachableObjects(repo: Repo, oid: string, out: Set<string> = new Set()): Set<string> {
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (out.has(current)) continue;
    const obj = repo.objects.get(current);
    if (obj === undefined) continue;
    out.add(current);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/**
 * Commit walk from `tip` limited to `depth` generations (depth 1 = the tip
 * only). Returns the included commits in tip-first order and the boundary
 * commits (the deepest generation reached).
 */
export function depthWalk(
  repo: Repo,
  tip: string,
  depth: number,
): { included: string[]; boundary: string[] } {
  const included: string[] = [];
  const boundary: string[] = [];
  const seen = new Set<string>();
  let frontier = [tip];
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      seen.add(oid);
      included.push(oid);
      if (level === depth) boundary.push(oid);
      else for (const parent of parseCommit(obj.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return { included, boundary };
}

/** Every commit ancestor of `tip` (tip first), deduplicated. */
export function commitAncestors(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** The merge-base of two commits: the first common ancestor (tip-first walk). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(commitAncestors(repo, a));
  for (const oid of commitAncestors(repo, b)) if (ancestorsA.has(oid)) return oid;
  return null;
}

/** Is `ancestor` reachable from `tip` (or equal to it)? Walks tip-first and stops at the first hit, so a fast-forward check on a linear history costs one step, not a full ancestry walk. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Flatten a tree object to path -> {mode, oid}, recursing into subtrees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/**
 * Build (and store) the tree objects for a flat path map; returns the root
 * tree oid. Intermediate directories are created as needed.
 */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: value.mode, name: parts[parts.length - 1] as string, oid: value.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tip commit oid of a branch (or undefined when the branch is unborn). */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/**
 * Resolve a ref argument (branch name, full ref, or commit sha) to a commit
 * oid, or undefined when it names nothing.
 */
export function resolveToCommit(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return undefined;
}

/** Create a commit on `branch` with the given tree, parents and message. */
export function createRestCommit(repo: Repo, branch: string, treeOid: string, message: string): string {
  const parent = branchTip(repo, branch);
  const parents = parent === undefined ? [] : [parent];
  const line = identityLine();
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommit({ tree: treeOid, parents, author: line, committer: line, message: body });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.fetchPackCache.clear();
  return oid;
}

/** Peel a ref's oid to a commit oid (annotated tags point at their target). */
export function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- REST shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- domain ops

export function createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `unknown label "${name}"` };
    labels.push(label);
  }
  repo.numberSeq += 1;
  const number = repo.numberSeq;
  const now = nextTimestamp();
  const issue: Issue = {
    id: repo.id * 100000 + number,
    nodeId: globalId('issue', `${repo.owner}/${repo.name}:${number}`),
    number,
    title,
    body,
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull | { error: string } {
  const headSha = branchTip(repo, head);
  if (headSha === undefined) return { error: `unknown head branch "${head}"` };
  const baseSha = branchTip(repo, base);
  if (baseSha === undefined) return { error: `unknown base branch "${base}"` };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return { error: 'a pull request is already open for this head and base' };
    }
  }
  repo.numberSeq += 1;
  const number = repo.numberSeq;
  const now = nextTimestamp();
  const pull: Pull = {
    id: repo.id * 100000 + number,
    nodeId: globalId('pull', `${repo.owner}/${repo.name}:${number}`),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Line counts of a blob's content (used for PR file statistics). */
export function lineCount(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two flat trees (merge-base vs head) into the PR file list. */
export function diffFlatTrees(
  repo: Repo,
  baseFlat: ReadonlyMap<string, { mode: string; oid: string }>,
  headFlat: ReadonlyMap<string, { mode: string; oid: string }>,
): PullFile[] {
  const files: PullFile[] = [];
  const names = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const name of [...names].sort()) {
    const before = baseFlat.get(name);
    const after = headFlat.get(name);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    if (before === undefined && after !== undefined) {
      const blob = repo.objects.get(after.oid);
      const additions = blob === undefined ? 0 : lineCount(blob.data);
      files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after === undefined) {
      const blob = repo.objects.get(before.oid);
      const deletions = blob === undefined ? 0 : lineCount(blob.data);
      files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before !== undefined && after !== undefined) {
      const oldBlob = repo.objects.get(before.oid);
      const newBlob = repo.objects.get(after.oid);
      const deletions = oldBlob === undefined ? 0 : lineCount(oldBlob.data);
      const additions = newBlob === undefined ? 0 : lineCount(newBlob.data);
      files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/**
 * Three-way merge check for a pull request. Returns the merged flat tree
 * when clean, or the conflicting paths when it is not.
 */
export function mergePlan(
  repo: Repo,
  pull: Pull,
): { ok: true; merged: Map<string, { mode: string; oid: string }> } | { ok: false; conflicts: string[] } {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { ok: false, conflicts: [] };
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? '' : parseCommit((repo.objects.get(base) as { data: Buffer }).data).tree;
  const headTree = parseCommit((repo.objects.get(headTip) as { data: Buffer }).data).tree;
  const targetTree = parseCommit((repo.objects.get(baseTip) as { data: Buffer }).data).tree;
  const ancestor = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const target = flattenTree(repo, targetTree);
  const conflicts: string[] = [];
  const merged = new Map(target);
  const names = new Set<string>([...ancestor.keys(), ...head.keys(), ...target.keys()]);
  for (const name of names) {
    const a = ancestor.get(name);
    const h = head.get(name);
    const t = target.get(name);
    const headChanged = (a?.oid ?? null) !== (h?.oid ?? null);
    const targetChanged = (a?.oid ?? null) !== (t?.oid ?? null);
    if (!headChanged) continue;
    if (!targetChanged) {
      if (h === undefined) merged.delete(name);
      else merged.set(name, h);
      continue;
    }
    if ((h?.oid ?? null) === (t?.oid ?? null)) continue;
    conflicts.push(name);
  }
  if (conflicts.length > 0) return { ok: false, conflicts: conflicts.sort() };
  return { ok: true, merged };
}

/** Squash-merge a pull request. Returns the merge commit sha, or an error. */
export function mergePull(repo: Repo, pull: Pull): string | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
  const plan = mergePlan(repo, pull);
  if (!plan.ok) return { error: 'merge conflict', status: 405 };
  const baseTip = branchTip(repo, pull.baseRef) as string;
  const treeOid = buildTreeFromFlat(repo, plan.merged);
  const line = identityLine();
  const message = `${pull.title}\n`;
  const data = buildCommit({ tree: treeOid, parents: [baseTip], author: line, committer: line, message });
  const mergeSha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.fetchPackCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nextTimestamp();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  return mergeSha;
}

/** The PR's mergeability as GraphQL reports it. */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const plan = mergePlan(repo, pull);
  return plan.ok ? 'MERGEABLE' : 'CONFLICTING';
}

/** Tag object helper (used by the git surface for peeled refs). */
export function tagTarget(repo: Repo, tagOid: string): string | undefined {
  const obj = repo.objects.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return parseTag(obj.data).object;
}

export { buildTag };

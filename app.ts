// app.ts — The HTTP server: REST v3, GraphQL v4, MCP and git smart HTTP,
// all served from one in-memory store (scenario.ts) with git primitives
// from git.ts. Standard library only. Every line was written fresh for
// this entry; the old build's files were deleted unread.
//
// Routing notes:
// - GET /healthz answers without auth; everything else needs the bearer
//   token from MAKEFUN_SHOP_TOKEN (no default: without it every request
//   is 401, so a token value never ships in the repository).
// - Every JSON reply carries a non-empty X-GitHub-Request-Id.
// - Unknown REST routes answer 404 JSON; malformed JSON bodies answer 400.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  buildCommit,
  buildTree,
  decodePack,
  encodePack,
  objectId,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  pktLine,
  type PackEntry,
} from './git.ts';
import {
  DEFAULT_BRANCH,
  Store,
  VIEWER_ID,
  VIEWER_LOGIN,
  branchTip,
  buildTreeFromFlat,
  commitAncestors,
  createIssue,
  createPull,
  createRestCommit,
  depthWalk,
  diffFlatTrees,
  flattenTree,
  getObject,
  globalId,
  identityLine,
  isAncestor,
  lineCount,
  mergeBase,
  mergePlan,
  mergePull,
  mergeableState,
  nextTimestamp,
  peelToCommit,
  putObject,
  reachableObjects,
  resolveToCommit,
  tagTarget,
  commentJson,
  issueJson,
  pullJson,
  repoJson,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
} from './scenario.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': String(payload.length),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(payload.length),
  });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extraHeaders });
  res.end();
}

function message(status: number, text: string): { message: string } {
  void status;
  return { message: text };
}

function bearerOk(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseIntQuery(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function paginate<T>(items: readonly T[], search: URLSearchParams): { page: T[]; total: number; perPage: number; pageNum: number } {
  const perPage = Math.min(100, Math.max(1, parseIntQuery(search.get('per_page'), 30)));
  const pageNum = Math.max(1, parseIntQuery(search.get('page'), 1));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNum };
}

function linkHeader(base: string, path: string, search: URLSearchParams, total: number, perPage: number, pageNum: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return null;
  const next = new URLSearchParams(search);
  next.set('page', String(pageNum + 1));
  next.set('per_page', String(perPage));
  return `<${base}${path}?${next.toString()}>; rel="next"`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------- REST v3

interface RestContext {
  store: Store;
  baseUrl: string;
}

function repoOr404(store: Store, owner: string, name: string, res: ServerResponse): Repo | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, message(404, 'Not Found'));
    return null;
  }
  return repo;
}

async function handleRest(ctx: RestContext, req: IncomingMessage, res: ServerResponse, segments: string[], search: URLSearchParams): Promise<void> {
  const { store, baseUrl } = ctx;
  const method = req.method ?? 'GET';
  const bodyBuf = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = bodyBuf.length === 0 ? { ok: true as const, value: {} } : parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 400, message(400, parsed.error));
    return;
  }
  const body = asObject(parsed.value) ?? {};

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }
    sendJson(
      res,
      200,
      {
        current_user_url: `${baseUrl}/api/v3/user`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        user_url: `${baseUrl}/api/v3/users/{username}`,
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
    return;
  }

  // GET /api/v3/meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }
    sendJson(res, 200, { installed_version: SERVER_VERSION, verifiable_password_authentication: true });
    return;
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') {
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: globalId('user', VIEWER_LOGIN),
        name: 'ada iversen',
        email: `${VIEWER_LOGIN}@example.invalid`,
        type: 'User',
      });
      return;
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'POST') {
        const name = asString(body.name);
        if (name === undefined || name === '') {
          sendJson(res, 422, message(422, 'name is required'));
          return;
        }
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          asString(body.description) ?? '',
          body.private === true,
        );
        if (repo === null) {
          sendJson(res, 422, message(422, 'Repository already exists'));
          return;
        }
        sendJson(res, 201, repoJson(repo));
        return;
      }
      if (method === 'GET') {
        const repos = store.listReposFor(VIEWER_LOGIN);
        const { page, total, perPage, pageNum } = paginate(repos, search);
        const link = linkHeader(baseUrl, '/api/v3/user/repos', search, total, perPage, pageNum);
        sendJson(res, 200, page.map((repo) => repoJson(repo)), link === null ? {} : { link });
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }
    sendJson(res, 404, message(404, 'Not Found'));
    return;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments[0] === 'repos') {
    if (segments.length < 3) {
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }
    const owner = decodeSegment(segments[1] as string);
    const repoName = decodeSegment(segments[2] as string);
    const rest = segments.slice(3);

    // Repo itself: GET / PATCH / DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = repoOr404(store, owner, repoName, res);
        if (repo === null) return;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = repoOr404(store, owner, repoName, res);
        if (repo === null) return;
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        repo.updatedAt = nextTimestamp();
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        if (!store.deleteRepo(owner, repoName)) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        sendEmpty(res, 204);
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    const repo = repoOr404(store, owner, repoName, res);
    if (repo === null) return;

    // git refs: /git/refs and /git/refs/{ref...}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) {
          sendJson(res, 422, message(422, 'ref and sha are required'));
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, message(422, 'Reference already exists'));
          return;
        }
        const obj = getObject(repo, sha);
        if (obj === undefined) {
          sendJson(res, 422, message(422, 'object does not exist'));
          return;
        }
        repo.refs.set(ref, sha);
        repo.fetchPackCache.clear();
        sendJson(res, 201, { ref, object: { sha, type: obj.type } });
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).map(decodeSegment).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const obj = getObject(repo, sha);
        sendJson(res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string } }));
        sendJson(res, 200, branches);
        return;
      }
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).map(decodeSegment).join('/');
        const sha = branchTip(repo, branch);
        if (sha === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha } });
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') {
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      const ref = search.get('sha');
      const tip = ref === null ? branchTip(repo, repo.defaultBranch) : resolveToCommit(repo, ref);
      if (tip === undefined) {
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      const commits = commitAncestors(repo, tip).map((sha) => {
        const data = (getObject(repo, sha) as { data: Buffer }).data;
        const commit = parseCommit(data);
        const parseIdentity = (line: string): { name: string; email: string; date: string } => {
          const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
          if (match === null) return { name: line, email: '', date: repo.createdAt };
          return {
            name: match[1] as string,
            email: match[2] as string,
            date: new Date(Number(match[3]) * 1000).toISOString(),
          };
        };
        return {
          sha,
          commit: {
            message: commit.message.replace(/\n$/, ''),
            author: parseIdentity(commit.author),
            committer: parseIdentity(commit.committer),
            tree: { sha: commit.tree },
          },
        };
      });
      const { page } = paginate(commits, search);
      sendJson(res, 200, page);
      return;
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeSegment).join('/');
      if (method === 'PUT') {
        const contentB64 = asString(body.content);
        const messageText = asString(body.message) ?? 'update file';
        if (contentB64 === undefined) {
          sendJson(res, 400, message(400, 'content is required'));
          return;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 400, message(400, 'content is not valid base64'));
          return;
        }
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (tip === undefined && repo.refs.size > 0) {
          sendJson(res, 422, message(422, `branch "${branch}" does not exist`));
          return;
        }
        const treeOid = tip === undefined ? undefined : parseCommit((getObject(repo, tip) as { data: Buffer }).data).tree;
        const flat = treeOid === undefined ? new Map() : flattenTree(repo, treeOid);
        const existing = flat.get(path);
        const givenSha = asString(body.sha);
        if (existing !== undefined) {
          if (givenSha === undefined || givenSha !== existing.oid) {
            sendJson(res, 409, message(409, 'sha does not match the current file'));
            return;
          }
        }
        const blobOid = putObject(repo, 'blob', content);
        flat.set(path, { mode: '100644', oid: blobOid });
        const newTree = buildTreeFromFlat(repo, flat);
        const commitOid = createRestCommit(repo, branch, newTree, messageText);
        sendJson(res, existing === undefined ? 201 : 200, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitOid },
        });
        return;
      }
      if (method === 'GET') {
        const ref = search.get('ref');
        const tip = ref === null ? branchTip(repo, repo.defaultBranch) : resolveToCommit(repo, ref);
        if (tip === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const treeOid = parseCommit((getObject(repo, tip) as { data: Buffer }).data).tree;
        if (path === '') {
          const flat = flattenTree(repo, treeOid);
          const top = new Map<string, { mode: string; oid: string; isDir: boolean }>();
          for (const [filePath, value] of flat) {
            const first = filePath.split('/')[0] as string;
            if (!top.has(first)) {
              top.set(first, filePath.includes('/') ? { mode: '40000', oid: '', isDir: true } : { mode: value.mode, oid: value.oid, isDir: false });
            }
          }
          const listing: Record<string, unknown>[] = [];
          for (const [name, value] of [...top.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            if (value.isDir) {
              listing.push({ type: 'dir', name, path: name, sha: '' });
            } else {
              const blob = getObject(repo, value.oid);
              listing.push({ type: 'file', name, path: name, sha: value.oid, size: blob?.data.length ?? 0 });
            }
          }
          // Directory shas need the real subtree oid: resolve them from the tree.
          const treeObj = getObject(repo, treeOid);
          if (treeObj !== undefined) {
            for (const entry of parseTree(treeObj.data)) {
              const item = listing.find((candidate) => candidate.name === entry.name);
              if (item !== undefined && entry.mode === '40000') item.sha = entry.oid;
            }
          }
          sendJson(res, 200, listing);
          return;
        }
        const flat = flattenTree(repo, treeOid);
        const file = flat.get(path);
        if (file !== undefined) {
          const blob = getObject(repo, file.oid);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob?.data.length ?? 0,
            name: path.split('/').pop() ?? path,
            path,
            content: blob === undefined ? '' : blob.data.toString('base64'),
            sha: file.oid,
          });
          return;
        }
        // Maybe a directory: walk the tree to the path.
        let current = treeOid;
        let found = true;
        for (const part of path.split('/')) {
          const obj = getObject(repo, current);
          if (obj === undefined || obj.type !== 'tree') {
            found = false;
            break;
          }
          const entry = parseTree(obj.data).find((candidate) => candidate.name === part);
          if (entry === undefined) {
            found = false;
            break;
          }
          current = entry.oid;
        }
        if (!found) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const dirObj = getObject(repo, current);
        if (dirObj === undefined || dirObj.type !== 'tree') {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const listing = parseTree(dirObj.data).map((entry) => {
          const blob = entry.mode === '40000' ? undefined : getObject(repo, entry.oid);
          return {
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${path}/${entry.name}`,
            sha: entry.oid,
            size: blob?.data.length ?? 0,
          };
        });
        sendJson(res, 200, listing);
        return;
      }
      if (method === 'DELETE') {
        const givenSha = asString(body.sha);
        const messageText = asString(body.message) ?? 'delete file';
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (tip === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const treeOid = parseCommit((getObject(repo, tip) as { data: Buffer }).data).tree;
        const flat = flattenTree(repo, treeOid);
        const existing = flat.get(path);
        if (existing === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        if (givenSha !== undefined && givenSha !== existing.oid) {
          sendJson(res, 409, message(409, 'sha does not match the current file'));
          return;
        }
        flat.delete(path);
        const newTree = buildTreeFromFlat(repo, flat);
        const commitOid = createRestCommit(repo, branch, newTree, messageText);
        sendJson(res, 200, { commit: { sha: commitOid } });
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const name = asString(body.name);
        if (name === undefined || name === '') {
          sendJson(res, 422, message(422, 'name is required'));
          return;
        }
        if (repo.labels.has(name)) {
          sendJson(res, 422, message(422, 'Label already exists'));
          return;
        }
        const label = { name, color: asString(body.color) ?? 'ededed' };
        repo.labels.set(name, label);
        sendJson(res, 201, { name: label.name, color: label.color, description: '' });
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    // issues and issue comments
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = asString(body.title);
          if (title === undefined || title === '') {
            sendJson(res, 422, message(422, 'title is required'));
            return;
          }
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labelNames: string[] = [];
          for (const item of rawLabels) {
            if (typeof item === 'string') labelNames.push(item);
            else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
              labelNames.push((item as Record<string, unknown>).name as string);
            }
          }
          const created = createIssue(repo, title, asString(body.body) ?? '', labelNames);
          if ('error' in created) {
            sendJson(res, 422, message(422, created.error));
            return;
          }
          sendJson(res, 201, issueJson(repo, created));
          return;
        }
        if (method === 'GET') {
          let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
          const state = search.get('state') ?? 'open';
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const direction = search.get('direction') ?? 'asc';
          if (search.get('sort') === 'created' && direction === 'desc') issues = [...issues].reverse();
          const { page, total, perPage, pageNum } = paginate(issues, search);
          const link = linkHeader(baseUrl, `/api/v3/repos/${owner}/${repoName}/issues`, search, total, perPage, pageNum);
          sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
          return;
        }
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isSafeInteger(number) || number <= 0) {
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (issue === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        if (method === 'POST') {
          const text = asString(body.body);
          if (text === undefined) {
            sendJson(res, 422, message(422, 'body is required'));
            return;
          }
          repo.commentSeq += 1;
          const id = repo.commentSeq;
          const now = nextTimestamp();
          const comment: Comment = {
            id,
            nodeId: globalId('comment', `${owner}/${repoName}:${number}:${id}`),
            body: text,
            createdAt: now,
            updatedAt: now,
          };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, commentJson(repo, comment));
          return;
        }
        if (method === 'GET') {
          const list = repo.comments.get(number) ?? [];
          sendJson(res, 200, list.map((comment) => commentJson(repo, comment)));
          return;
        }
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (issue === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
          issue.updatedAt = nextTimestamp();
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    // pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = asString(body.title);
          const head = asString(body.head);
          const base = asString(body.base);
          if (title === undefined || head === undefined || base === undefined) {
            sendJson(res, 422, message(422, 'title, head and base are required'));
            return;
          }
          const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').slice(1).join(':') as string) : ref);
          const created = createPull(repo, title, asString(body.body) ?? '', stripOwner(head), stripOwner(base));
          if ('error' in created) {
            sendJson(res, 422, message(422, created.error));
            return;
          }
          sendJson(res, 201, pullJson(repo, created));
          return;
        }
        if (method === 'GET') {
          let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const state = search.get('state') ?? 'open';
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === (state === 'open' ? 'open' : 'closed'));
          const { page } = paginate(pulls, search);
          sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
          return;
        }
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isSafeInteger(number) || number <= 0) {
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        if (method !== 'GET') {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const headTip = branchTip(repo, pull.headRef);
        const baseTip = branchTip(repo, pull.baseRef);
        if (headTip === undefined || baseTip === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const base = mergeBase(repo, headTip, baseTip);
        const baseTree = base === null ? '' : parseCommit((getObject(repo, base) as { data: Buffer }).data).tree;
        const headTree = parseCommit((getObject(repo, headTip) as { data: Buffer }).data).tree;
        const files = diffFlatTrees(repo, flattenTree(repo, baseTree), flattenTree(repo, headTree));
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        if (method !== 'PUT') {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        const result = mergePull(repo, pull);
        if (typeof result === 'object') {
          sendJson(res, result.status, message(result.status, result.error));
          return;
        }
        sendJson(res, 200, { sha: result, merged: true, message: pull.title });
        return;
      }
      if (rest.length === 2) {
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        sendJson(res, 404, message(404, 'Not Found'));
        return;
      }
      sendJson(res, 404, message(404, 'Not Found'));
      return;
    }

    sendJson(res, 404, message(404, 'Not Found'));
    return;
  }

  sendJson(res, 404, message(404, 'Not Found'));
}

// ---------------------------------------------------------------- GraphQL v4

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: GqlSelection[] | null;
}

interface GqlInline {
  kind: 'inline';
  type: string | null;
  selection: GqlSelection[];
}

type GqlSelection = GqlField | GqlInline;

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: GqlSelection[];
}

interface GqlToken {
  kind: 'name' | 'string' | 'number' | 'punct' | 'var';
  value: string;
}

function tokenizeGraphQL(src: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];
  private readonly fragments: Map<string, GqlSelection[]>;

  constructor(tokens: GqlToken[], fragments: Map<string, GqlSelection[]>) {
    this.tokens = tokens;
    this.fragments = fragments;
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`GraphQL: expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek() !== undefined) {
      const token = this.peek() as GqlToken;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        if (this.peek()?.value === 'on') this.next();
        this.next(); // type name
        const selection = this.parseSelectionSet();
        this.fragments.set(name, selection);
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek() as GqlToken;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') {
        name = this.next().value;
      }
    }
    if (this.peek()?.value === '(') this.parseVariableDefinitions();
    const selection = this.parseSelectionSet();
    return { kind, name, variables: [], selection };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== undefined && this.peek()?.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek() as GqlToken;
    if (token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const type = this.next().value;
        return { kind: 'inline', type, selection: this.parseSelectionSet() };
      }
      if (nextToken !== undefined && nextToken.kind === 'name') {
        const name = this.next().value;
        const fragment = this.fragments.get(name) ?? [];
        return { kind: 'inline', type: null, selection: fragment };
      }
      throw new Error('GraphQL: bad fragment spread');
    }
    let alias: string | null = null;
    let name = this.next().value;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek()?.value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    // Directives (@...) are ignored.
    while (this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') {
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const t = this.next();
          if (t.value === '(') depth += 1;
          else if (t.value === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
    }
    const selection = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'var') return { kind: 'var', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value: Number(token.value) }
        : { kind: 'int', value: Number(token.value) };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== undefined && this.peek()?.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== undefined && this.peek()?.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`GraphQL: unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveGqlValue(item, variables);
      return out;
    }
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestFileConnection: ['nodes'],
  PullRequestFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  IssueEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body'],
  IssueCreatePayload: ['issue'],
  IssueClosePayload: ['issue'],
  PullRequestCreatePayload: ['pullRequest'],
  PullRequestMergePayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
});

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT'],
});

interface GqlNode {
  __type: string;
  __value: unknown;
}

function nodeOf(type: string, value: unknown): GqlNode {
  return { __type: type, __value: value };
}

class GqlExecutor {
  private errors: Array<{ message: string }> = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  run(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
    this.errors = [];
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSelection(operation.selection, nodeOf(rootType, null), variables);
    const out: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
    if (this.errors.length > 0) out.errors = this.errors;
    return out;
  }

  private executeSelection(
    selection: readonly GqlSelection[],
    parent: GqlNode,
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind === 'inline') {
        if (sel.type !== null && sel.type !== parent.__type) continue;
        const nested = this.executeSelection(sel.selection, parent, variables);
        Object.assign(out, nested);
        continue;
      }
      const key = sel.alias ?? sel.name;
      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(sel.args)) args[name] = resolveGqlValue(value, variables);
      out[key] = this.resolveField(parent, sel.name, args, sel.selection, variables);
    }
    return out;
  }

  private resolveField(
    parent: GqlNode,
    name: string,
    args: Record<string, unknown>,
    selection: GqlSelection[] | null,
    variables: Record<string, unknown>,
  ): unknown {
    const type = parent.__type;
    const fields = TYPE_FIELDS[type];
    if (fields !== undefined && !fields.includes(name)) {
      this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
      return null;
    }
    const value = parent.__value;

    // Root: Query
    if (type === 'Query') {
      if (name === '__typename') return 'Query';
      if (name === 'viewer') {
        const node = nodeOf('User', { login: VIEWER_LOGIN, id: VIEWER_ID });
        return selection === null ? { login: VIEWER_LOGIN } : this.executeSelection(selection, node, variables);
      }
      if (name === 'repository') {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        const node = nodeOf('Repository', repo);
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      if (name === 'node') {
        const id = String(args.id ?? '');
        let decoded = '';
        try {
          decoded = Buffer.from(id, 'base64url').toString('utf8');
        } catch {
          decoded = '';
        }
        const [kind, key] = decoded.split(':', 2) as [string, string];
        if (kind === 'repo') {
          const repo = this.store.findRepoByNodeId(id);
          if (repo === undefined) return null;
          return selection === null ? {} : this.executeSelection(selection, nodeOf('Repository', repo), variables);
        }
        if (kind === 'issue') {
          const found = this.store.findIssueByNodeId(id);
          if (found === undefined) return null;
          return selection === null ? {} : this.executeSelection(selection, nodeOf('Issue', { repo: found.repo, issue: found.issue }), variables);
        }
        if (kind === 'pull') {
          const found = this.store.findPullByNodeId(id);
          if (found === undefined) return null;
          return selection === null ? {} : this.executeSelection(selection, nodeOf('PullRequest', { repo: found.repo, pull: found.pull }), variables);
        }
        void key;
        return null;
      }
      if (name === '__type') {
        const typeName = String(args.name ?? '');
        const fieldsOf = TYPE_FIELDS[typeName];
        const enumsOf = TYPE_ENUMS[typeName];
        if (fieldsOf === undefined && enumsOf === undefined) return null;
        const node = nodeOf('__Type', { name: typeName, fields: fieldsOf ?? null, enums: enumsOf ?? null });
        return selection === null ? { name: typeName } : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
      return null;
    }

    // Root: Mutation
    if (type === 'Mutation') {
      if (name === '__typename') return 'Mutation';
      if (name === 'createIssue') return this.mutateCreateIssue(args, selection, variables);
      if (name === 'closeIssue') return this.mutateCloseIssue(args, selection, variables);
      if (name === 'createPullRequest') return this.mutateCreatePullRequest(args, selection, variables);
      if (name === 'mergePullRequest') return this.mutateMergePullRequest(args, selection, variables);
      if (name === 'addComment') return this.mutateAddComment(args, selection, variables);
      this.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
      return null;
    }

    // __Type introspection object
    if (type === '__Type') {
      const info = value as { name: string; fields: readonly string[] | null; enums: readonly string[] | null };
      if (name === '__typename') return '__Type';
      if (name === 'name') return info.name;
      if (name === 'kind') return info.enums !== null ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        if (info.fields === null) return null;
        return info.fields.map((field) => ({ name: field }));
      }
      if (name === 'enumValues') {
        if (info.enums === null) return null;
        return info.enums.map((entry) => ({ name: entry }));
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
      return null;
    }

    // User
    if (type === 'User') {
      const user = value as { login: string; id: number };
      if (name === '__typename') return 'User';
      if (name === 'login') return user.login;
      if (name === 'id') return user.id;
      if (name === 'name') return user.login === VIEWER_LOGIN ? 'ada iversen' : user.login;
      if (name === 'email') return `${user.login}@example.invalid`;
      this.errors.push({ message: `Cannot query field "${name}" on type "User".` });
      return null;
    }

    // Repository
    if (type === 'Repository') {
      const repo = value as Repo;
      if (name === '__typename') return 'Repository';
      if (name === 'id') return repo.nodeId;
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') {
        const node = nodeOf('User', { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000 });
        return selection === null ? { login: repo.owner } : this.executeSelection(selection, node, variables);
      }
      if (name === 'defaultBranchRef') {
        const node = nodeOf('Ref', { name: repo.defaultBranch });
        return selection === null ? { name: repo.defaultBranch } : this.executeSelection(selection, node, variables);
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        if (issue === undefined) return null;
        const node = nodeOf('Issue', { repo, issue });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      if (name === 'issues') return this.repositoryIssues(repo, args, selection, variables);
      if (name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        const page = pulls.slice(0, first);
        const node = nodeOf('PullRequestConnection', {
          repo,
          pulls: page,
          hasNextPage: pulls.length > page.length,
          endCursor: null,
          startCursor: null,
        });
        return selection === null ? { nodes: page.map(() => ({})) } : this.executeSelection(selection, node, variables);
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        if (pull === undefined) return null;
        const node = nodeOf('PullRequest', { repo, pull });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
      return null;
    }

    // Issue
    if (type === 'Issue') {
      const { issue } = value as { repo: Repo; issue: Issue };
      if (name === '__typename') return 'Issue';
      if (name === 'id') return issue.nodeId;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'body') return issue.body;
      this.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
      return null;
    }

    // PullRequest
    if (type === 'PullRequest') {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      if (name === '__typename') return 'PullRequest';
      if (name === 'id') return pull.nodeId;
      if (name === 'number') return pull.number;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return mergeableState(repo, pull);
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return pull.merged;
      if (name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const headTip = branchTip(repo, pull.headRef);
        const baseTip = branchTip(repo, pull.baseRef);
        if (headTip === undefined || baseTip === undefined) {
          const empty = nodeOf('PullRequestFileConnection', { files: [] });
          return selection === null ? { nodes: [] } : this.executeSelection(selection, empty, variables);
        }
        const base = mergeBase(repo, headTip, baseTip);
        const baseTree = base === null ? '' : parseCommit((getObject(repo, base) as { data: Buffer }).data).tree;
        const headTree = parseCommit((getObject(repo, headTip) as { data: Buffer }).data).tree;
        const files = diffFlatTrees(repo, flattenTree(repo, baseTree), flattenTree(repo, headTree))
          .slice(0, first)
          .map((file) => ({ path: file.filename }));
        const node = nodeOf('PullRequestFileConnection', { files });
        return selection === null ? { nodes: files } : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
      return null;
    }

    // Ref
    if (type === 'Ref') {
      const ref = value as { name: string };
      if (name === '__typename') return 'Ref';
      if (name === 'name') return ref.name;
      this.errors.push({ message: `Cannot query field "${name}" on type "Ref".` });
      return null;
    }

    // Mutation payloads: { issue } / { pullRequest } / { commentEdge }.
    if (type === 'IssueCreatePayload' || type === 'IssueClosePayload') {
      const payload = value as { repo: Repo; issue: Issue };
      if (name === '__typename') return type;
      if (name === 'issue') {
        const node = nodeOf('Issue', { repo: payload.repo, issue: payload.issue });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
      return null;
    }
    if (type === 'PullRequestCreatePayload' || type === 'PullRequestMergePayload') {
      const payload = value as { repo: Repo; pull: Pull };
      if (name === '__typename') return type;
      if (name === 'pullRequest') {
        const node = nodeOf('PullRequest', { repo: payload.repo, pull: payload.pull });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
      return null;
    }
    if (type === 'AddCommentPayload') {
      const payload = value as { repo: Repo; comment: Comment };
      if (name === '__typename') return type;
      if (name === 'commentEdge') {
        const node = nodeOf('CommentEdge', { comment: payload.comment, cursor: null });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
      return null;
    }
    if (type === 'CommentEdge') {
      const edge = value as { comment: Comment; cursor: string | null };
      if (name === '__typename') return 'CommentEdge';
      if (name === 'node') {
        const node = nodeOf('Comment', edge.comment);
        return selection === null ? { id: edge.comment.nodeId, body: edge.comment.body } : this.executeSelection(selection, node, variables);
      }
      if (name === 'cursor') return edge.cursor;
      this.errors.push({ message: `Cannot query field "${name}" on type "CommentEdge".` });
      return null;
    }
    if (type === 'Comment') {
      const comment = value as Comment;
      if (name === '__typename') return 'Comment';
      if (name === 'id') return comment.nodeId;
      if (name === 'body') return comment.body;
      this.errors.push({ message: `Cannot query field "${name}" on type "Comment".` });
      return null;
    }

    // Connections and page info.
    if (type === 'IssueConnection') {
      const conn = value as { repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; total: number };
      if (name === '__typename') return 'IssueConnection';
      if (name === 'nodes') {
        return conn.issues.map((issue) => {
          const node = nodeOf('Issue', { repo: conn.repo, issue });
          return selection === null ? {} : this.executeSelection(selection, node, variables);
        });
      }
      if (name === 'pageInfo') {
        const node = nodeOf('PageInfo', {
          hasNextPage: conn.hasNextPage,
          endCursor: conn.endCursor,
          hasPreviousPage: false,
          startCursor: conn.startCursor,
        });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      if (name === 'totalCount') return conn.total;
      this.errors.push({ message: `Cannot query field "${name}" on type "IssueConnection".` });
      return null;
    }
    if (type === 'PullRequestConnection') {
      const conn = value as { repo: Repo; pulls: Pull[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null };
      if (name === '__typename') return 'PullRequestConnection';
      if (name === 'nodes') {
        return conn.pulls.map((pull) => {
          const node = nodeOf('PullRequest', { repo: conn.repo, pull });
          return selection === null ? {} : this.executeSelection(selection, node, variables);
        });
      }
      if (name === 'pageInfo') {
        const node = nodeOf('PageInfo', {
          hasNextPage: conn.hasNextPage,
          endCursor: conn.endCursor,
          hasPreviousPage: false,
          startCursor: conn.startCursor,
        });
        return selection === null ? {} : this.executeSelection(selection, node, variables);
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "PullRequestConnection".` });
      return null;
    }
    if (type === 'PullRequestFileConnection') {
      const conn = value as { files: Array<{ path: string }> };
      if (name === '__typename') return 'PullRequestFileConnection';
      if (name === 'nodes') {
        return conn.files.map((file) => {
          const node = nodeOf('PullRequestFile', file);
          return selection === null ? { path: file.path } : this.executeSelection(selection, node, variables);
        });
      }
      this.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFileConnection".` });
      return null;
    }
    if (type === 'PullRequestFile') {
      const file = value as { path: string };
      if (name === '__typename') return 'PullRequestFile';
      if (name === 'path') return file.path;
      this.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFile".` });
      return null;
    }
    if (type === 'PageInfo') {
      const info = value as { hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null };
      if (name === '__typename') return 'PageInfo';
      if (name === 'hasNextPage') return info.hasNextPage;
      if (name === 'endCursor') return info.endCursor;
      if (name === 'hasPreviousPage') return info.hasPreviousPage;
      if (name === 'startCursor') return info.startCursor;
      this.errors.push({ message: `Cannot query field "${name}" on type "PageInfo".` });
      return null;
    }

    this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return null;
  }

  private repositoryIssues(repo: Repo, args: Record<string, unknown>, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    if (orderBy !== undefined && String(orderBy.direction ?? '') === 'DESC') issues = [...issues].reverse();
    const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
    if (after !== null) issues = issues.filter((issue) => issue.number > after);
    const first = typeof args.first === 'number' ? args.first : 100;
    const total = issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = total > page.length;
    const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
    const startCursor = page.length > 0 ? encodeCursor((page[0] as Issue).number) : null;
    const node = nodeOf('IssueConnection', { repo, issues: page, hasNextPage, endCursor, startCursor, total });
    return selection === null ? { nodes: page.map((issue) => ({ number: issue.number })) } : this.executeSelection(selection, node, variables);
  }

  private mutateCreateIssue(args: Record<string, unknown>, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.store.findRepoByNodeId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      this.errors.push({ message: 'createIssue: unknown repositoryId' });
      return selection === null ? { issue: null } : { issue: null };
    }
    const created = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      this.errors.push({ message: `createIssue: ${created.error}` });
      return { issue: null };
    }
    const node = nodeOf('IssueCreatePayload', { repo, issue: created });
    return selection === null ? {} : this.executeSelection(selection, node, variables);
  }

  private mutateCloseIssue(args: Record<string, unknown>, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = this.store.findIssueByNodeId(String(input.issueId ?? ''));
    if (found === undefined) {
      this.errors.push({ message: 'closeIssue: unknown issueId' });
      return { issue: null };
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = nextTimestamp();
    const node = nodeOf('IssueClosePayload', { repo: found.repo, issue: found.issue });
    return selection === null ? {} : this.executeSelection(selection, node, variables);
  }

  private mutateCreatePullRequest(args: Record<string, unknown>, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.store.findRepoByNodeId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
      return { pullRequest: null };
    }
    const created = createPull(
      repo,
      String(input.title ?? ''),
      String(input.body ?? ''),
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
    );
    if ('error' in created) {
      this.errors.push({ message: `createPullRequest: ${created.error}` });
      return { pullRequest: null };
    }
    const node = nodeOf('PullRequestCreatePayload', { repo, pull: created });
    return selection === null ? {} : this.executeSelection(selection, node, variables);
  }

  private mutateMergePullRequest(args: Record<string, unknown>, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = this.store.findPullByNodeId(String(input.pullRequestId ?? ''));
    if (found === undefined) {
      this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
      return { pullRequest: null };
    }
    const result = mergePull(found.repo, found.pull);
    if (typeof result === 'object') {
      this.errors.push({ message: `mergePullRequest: ${result.error}` });
      return { pullRequest: null };
    }
    const node = nodeOf('PullRequestMergePayload', { repo: found.repo, pull: found.pull });
    return selection === null ? {} : this.executeSelection(selection, node, variables);
  }

  private mutateAddComment(args: Record<string, unknown>, selection: GqlSelection[] | null, variables: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = this.store.findIssueByNodeId(String(input.subjectId ?? ''));
    if (found === undefined) {
      this.errors.push({ message: 'addComment: unknown subjectId' });
      return { commentEdge: null };
    }
    found.repo.commentSeq += 1;
    const id = found.repo.commentSeq;
    const now = nextTimestamp();
    const comment: Comment = {
      id,
      nodeId: globalId('comment', `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${id}`),
      body: String(input.body ?? ''),
      createdAt: now,
      updatedAt: now,
    };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    const node = nodeOf('AddCommentPayload', { repo: found.repo, comment });
    return selection === null ? {} : this.executeSelection(selection, node, variables);
  }
}

async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 400, message(400, parsed.error));
    return;
  }
  const requests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const responses: unknown[] = [];
  for (const request of requests) {
    const obj = asObject(request);
    if (obj === null || typeof obj.query !== 'string') {
      responses.push({ data: null, errors: [{ message: 'GraphQL: query is required' }] });
      continue;
    }
    const variables = asObject(obj.variables) ?? {};
    let operations: GqlOperation[];
    try {
      const parser = new GqlParser(tokenizeGraphQL(obj.query), new Map());
      operations = parser.parseDocument();
    } catch (err) {
      responses.push({ data: null, errors: [{ message: `GraphQL: ${(err as Error).message}` }] });
      continue;
    }
    let operation = operations[0];
    if (typeof obj.operationName === 'string') {
      operation = operations.find((candidate) => candidate.name === obj.operationName) ?? operations[0];
    }
    if (operation === undefined) {
      responses.push({ data: null, errors: [{ message: 'GraphQL: no operation found' }] });
      continue;
    }
    const executor = new GqlExecutor(store);
    responses.push(executor.run(operation, variables as Record<string, unknown>));
  }
  sendJson(res, 200, Array.isArray(parsed.value) ? responses : responses[0]);
}

// ---------------------------------------------------------------- MCP

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, text: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message: text } };
}

function toolTextResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolErrorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    sendEmpty(res, 204);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, message(405, 'Method Not Allowed'));
    return;
  }
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const obj = asObject(parsed.value);
  if (obj === null) {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = obj.id ?? null;
  const rpcMethod = typeof obj.method === 'string' ? obj.method : '';
  const params = asObject(obj.params) ?? {};

  if (rpcMethod === 'notifications/initialized') {
    sendEmpty(res, 202);
    return;
  }
  if (rpcMethod === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  if (rpcMethod === 'server/discover') {
    sendJson(
      res,
      200,
      mcpResult(id, {
        supportedVersions: [...MCP_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    );
    return;
  }
  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = MCP_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sendJson(
      res,
      200,
      mcpResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    );
    return;
  }
  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      sendJson(res, 200, mcpError(id, -32601, `Method not found: ${toolName}`));
      return;
    }
    const args = asObject(params.arguments) ?? {};
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        sendJson(res, 200, mcpError(id, -32602, `Missing required argument: ${required}`));
        return;
      }
    }
    if (toolName === 'create_repo') {
      const name = String(args.name);
      const repo = store.createRepo(VIEWER_LOGIN, name, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (repo === null) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Repository already exists')));
        return;
      }
      sendJson(res, 200, mcpResult(id, toolTextResult(repoJson(repo))));
      return;
    }
    if (toolName === 'get_repo') {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Repository not found')));
        return;
      }
      sendJson(res, 200, mcpResult(id, toolTextResult(repoJson(repo))));
      return;
    }
    if (toolName === 'create_issue') {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Repository not found')));
        return;
      }
      const created = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) {
        sendJson(res, 200, mcpResult(id, toolErrorResult(created.error)));
        return;
      }
      sendJson(res, 200, mcpResult(id, toolTextResult(issueJson(repo, created))));
      return;
    }
    if (toolName === 'list_issues') {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Repository not found')));
        return;
      }
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      const state = typeof args.state === 'string' ? args.state : 'open';
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const payload = { issues: issues.map((issue) => issueJson(repo, issue)) };
      sendJson(res, 200, mcpResult(id, toolTextResult(payload)));
      return;
    }
    if (toolName === 'create_pull_request') {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Repository not found')));
        return;
      }
      const created = createPull(repo, String(args.title), '', String(args.head), String(args.base));
      if ('error' in created) {
        sendJson(res, 200, mcpResult(id, toolErrorResult(created.error)));
        return;
      }
      sendJson(res, 200, mcpResult(id, toolTextResult(pullJson(repo, created))));
      return;
    }
    if (toolName === 'merge_pull_request') {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Repository not found')));
        return;
      }
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) {
        sendJson(res, 200, mcpResult(id, toolErrorResult('Pull request not found')));
        return;
      }
      const result = mergePull(repo, pull);
      if (typeof result === 'object') {
        sendJson(res, 200, mcpResult(id, toolErrorResult(result.error)));
        return;
      }
      sendJson(res, 200, mcpResult(id, toolTextResult({ merged: true, sha: result, number: pull.number })));
      return;
    }
    sendJson(res, 200, mcpError(id, -32601, `Method not found: ${toolName}`));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${rpcMethod}`));
}

// ---------------------------------------------------------------- git smart HTTP

const UPLOAD_V2_CAPABILITIES = [
  'version 2',
  `agent=${SERVER_NAME}/${SERVER_VERSION}`,
  'ls-refs=unborn symrefs',
  'fetch=shallow wait-for-done',
  'server-option',
  'object-format=sha1',
];

// The default branch's full ref, used in the symref capability.
const DEFAULT_BRANCH_REF = 'refs/heads/main';

const UPLOAD_V0_CAPABILITIES =
  `symref=HEAD:${DEFAULT_BRANCH_REF} side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed agent=${SERVER_NAME}/${SERVER_VERSION}`;
const RECEIVE_V0_CAPABILITIES = 'report-status side-band-64k delete-refs';

interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): ListedRef[] {
  const refs: ListedRef[] = [];
  const headTip = branchTip(repo, repo.defaultBranch);
  if (headTip !== undefined) refs.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: ListedRef = { oid, name };
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'tag' && name.startsWith('refs/tags/')) {
      const target = tagTarget(repo, oid);
      if (target !== undefined) entry.peeled = target;
    }
    refs.push(entry);
  }
  return refs;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPABILITIES : RECEIVE_V0_CAPABILITIES;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) {
        parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
      } else {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      }
      if (service === 'git-upload-pack' && ref.peeled !== undefined) {
        parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function v2UploadAdvertisement(): Buffer {
  const parts: Buffer[] = UPLOAD_V2_CAPABILITIES.map((line) => pktLine(`${line}\n`));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** All tree/blob objects under a tree, recursively (not the tree itself). */
function treeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    out.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/** A commit plus its tree and blobs (but not its parents). */
function commitTreeObjects(repo: Repo, commitOid: string, out: Set<string>): void {
  out.add(commitOid);
  const obj = getObject(repo, commitOid);
  if (obj === undefined || obj.type !== 'commit') return;
  treeObjects(repo, parseCommit(obj.data).tree, out);
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  /** Memoized wire bytes for the v0/v2 fetch responses; a plan is immutable once built, so the framed response is identical for every request that hits it. */
  v0Response?: Buffer;
  v2Response?: Buffer;
}

function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const cacheKey = JSON.stringify({
    w: [...wants].sort(),
    h: [...haves].sort(),
    s: [...shallowBoundaries].sort(),
    d: depth ?? null,
  });
  const cached = repo.fetchPackCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const included = new Set<string>();
  const boundary: string[] = [];
  for (const want of wants) {
    const obj = getObject(repo, want);
    if (obj === undefined) throw new Error(`want ${want} not found`);
    if (obj.type === 'tag') {
      included.add(want);
      const target = tagTarget(repo, want);
      if (target === undefined) continue;
      const targetObj = getObject(repo, target);
      if (targetObj === undefined || targetObj.type !== 'commit') {
        included.add(target);
        continue;
      }
      if (depth !== undefined) {
        const walk = depthWalk(repo, target, depth);
        for (const commit of walk.included) commitTreeObjects(repo, commit, included);
        for (const item of walk.boundary) if (!boundary.includes(item)) boundary.push(item);
      } else {
        reachableObjects(repo, target, included);
      }
      continue;
    }
    if (obj.type !== 'commit') {
      included.add(want);
      continue;
    }
    if (depth !== undefined) {
      const walk = depthWalk(repo, want, depth);
      for (const commit of walk.included) commitTreeObjects(repo, commit, included);
      for (const item of walk.boundary) if (!boundary.includes(item)) boundary.push(item);
    } else {
      reachableObjects(repo, want, included);
    }
  }
  const haveSet = new Set<string>();
  for (const have of haves) {
    const obj = getObject(repo, have);
    if (obj === undefined) continue;
    if (shallowBoundaries.includes(have) && obj.type === 'commit') {
      commitTreeObjects(repo, have, haveSet);
    } else {
      reachableObjects(repo, have, haveSet);
    }
  }
  const packOids = [...included].filter((oid) => !haveSet.has(oid));
  const rank: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  packOids.sort((a, b) => {
    const typeA = getObject(repo, a)?.type ?? '';
    const typeB = getObject(repo, b)?.type ?? '';
    const byType = (rank[typeA] ?? 9) - (rank[typeB] ?? 9);
    if (byType !== 0) return byType;
    return a < b ? -1 : 1;
  });
  const entries: PackEntry[] = packOids.map((oid) => {
    const obj = getObject(repo, oid) as { type: string; data: Buffer };
    return { type: obj.type, data: obj.data, oid };
  });
  const pack = encodePack(entries);
  const unshallow: string[] = [];
  for (const have of haves) {
    if (!shallowBoundaries.includes(have)) continue;
    if (!included.has(have)) continue;
    const obj = getObject(repo, have);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => included.has(parent))) unshallow.push(have);
  }
  const plan: FetchPlan = { pack, shallow: depth !== undefined ? boundary : [], unshallow };
  repo.fetchPackCache.set(cacheKey, plan);
  return plan;
}

/** Split pack bytes into sideband packets (band 1), each a pkt-line. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = 32768;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function v2FetchResponse(plan: FetchPlan): Buffer {
  if (plan.v2Response !== undefined) return plan.v2Response;
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM_PKT];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(FLUSH_PKT);
  plan.v2Response = Buffer.concat(parts);
  return plan.v2Response;
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  if (plan.v0Response !== undefined) return plan.v0Response;
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(FLUSH_PKT);
  plan.v0Response = Buffer.concat(parts);
  return plan.v0Response;
}

function lsRefsResponse(repo: Repo, peel: boolean, symrefs: boolean, unborn: boolean, prefixes: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

async function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, search: URLSearchParams): Promise<void> {
  const service = search.get('service');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, message(404, 'Not Found'));
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, message(400, 'service is required'));
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  let body: Buffer;
  let contentType: string;
  if (service === 'git-upload-pack' && wantsV2) {
    body = v2UploadAdvertisement();
    contentType = 'application/x-git-upload-pack-advertisement';
  } else {
    body = v0Advertisement(repo, service);
    contentType = `application/x-${service}-advertisement`;
  }
  res.writeHead(200, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, message(404, 'Not Found'));
    return;
  }
  const bodyBuf = await readBody(req);
  const { lines } = parsePktLines(bodyBuf);
  const texts = lines.map((line) => line.toString('utf8'));
  const isV2 = req.headers['git-protocol'] === 'version=2';
  const first = (texts[0] ?? '').replace(/\n$/, '');

  if (isV2 && first === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const text of texts.slice(1)) {
      const line = text.replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const body = lsRefsResponse(repo, peel, symrefs, unborn, prefixes);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'x-github-request-id': nextRequestId(),
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }

  if (isV2 && first === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const text of texts.slice(1)) {
      const line = text.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    if (wants.length === 0) {
      sendText(res, 400, 'fetch needs at least one want', 'text/plain');
      return;
    }
    let plan: FetchPlan;
    try {
      plan = computeFetch(repo, wants, haves, shallow, depth);
    } catch (err) {
      sendText(res, 400, (err as Error).message, 'text/plain');
      return;
    }
    const body = v2FetchResponse(plan);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'x-github-request-id': nextRequestId(),
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }

  if (!isV2) {
    // v0 fetch: want lines, then (after a flush) have lines and done.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const text of texts) {
      const line = text.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    if (wants.length === 0) {
      sendText(res, 400, 'fetch needs at least one want', 'text/plain');
      return;
    }
    let plan: FetchPlan;
    try {
      plan = computeFetch(repo, wants, haves, shallow, depth);
    } catch (err) {
      sendText(res, 400, (err as Error).message, 'text/plain');
      return;
    }
    const body = v0FetchResponse(plan);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'x-github-request-id': nextRequestId(),
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }

  sendText(res, 400, 'unknown upload-pack command', 'text/plain');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(bodyBuf: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  // Pkt-lines until the first flush; everything after it is the raw pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset + 4 <= bodyBuf.length) {
    const raw = bodyBuf.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(raw, 16);
    if (!Number.isFinite(length) || length < 0) return null;
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > bodyBuf.length) return null;
    const line = bodyBuf.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = line.indexOf('\0');
    const head = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
    const parts = head.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return null;
  return { commands, pack: bodyBuf.subarray(offset) };
}

async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, message(404, 'Not Found'));
    return;
  }
  const bodyBuf = await readBody(req);
  const parsed = parsePushBody(bodyBuf);
  if (parsed === null) {
    sendText(res, 400, 'malformed receive-pack request', 'text/plain');
    return;
  }
  const { commands, pack } = parsed;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  const report = (unpackLine: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): Buffer => {
    const inner: Buffer[] = [pktLine(`${unpackLine}\n`)];
    for (const entry of refs) {
      inner.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
    }
    const outer: Buffer[] = inner.map((line) => pktLine(Buffer.concat([Buffer.from([1]), line])));
    outer.push(FLUSH_PKT);
    return Buffer.concat(outer);
  };

  // A pack is required for any update; without one nothing can be applied.
  if (updatesRef && pack.length === 0) {
    const body = report('unpack unpacker error', commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpacker error' })));
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'x-github-request-id': nextRequestId(),
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }

  if (pack.length > 0) {
    try {
      const entries = decodePack(pack);
      for (const entry of entries) putObject(repo, entry.type, entry.data);
    } catch {
      const body = report('unpack unpacker error', commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpacker error' })));
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-result',
        'x-github-request-id': nextRequestId(),
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        changed = true;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const obj = getObject(repo, command.newOid);
    if (obj === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (obj.type !== 'commit' && obj.type !== 'tag') {
      results.push({ ref: command.ref, ok: false, reason: 'object not a commit' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        changed = true;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
    } else if (!isAncestor(repo, current, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  if (changed) repo.fetchPackCache.clear();
  const body = report('unpack ok', results);
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

// ---------------------------------------------------------------- server

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const segments = pathname.split('/').filter((part) => part.length > 0);
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

      if (pathname === '/healthz') {
        if ((req.method ?? 'GET') !== 'GET') {
          sendJson(res, 404, message(404, 'Not Found'));
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!bearerOk(req)) {
        sendJson(res, 401, message(401, 'Unauthorized'));
        return;
      }
      if (segments[0] === 'api' && segments[1] === 'v3') {
        await handleRest({ store, baseUrl }, req, res, segments.slice(2), url.searchParams);
        return;
      }
      if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
        if ((req.method ?? 'GET') !== 'POST') {
          sendJson(res, 405, message(405, 'Method Not Allowed'));
          return;
        }
        await handleGraphQL(store, req, res);
        return;
      }
      if (segments[0] === 'mcp' && segments.length === 1) {
        await handleMcp(store, req, res);
        return;
      }
      if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
        const owner = decodeSegment(segments[0] as string);
        const repoName = decodeSegment((segments[1] as string).slice(0, -4));
        const rest = segments.slice(2);
        if (rest[0] === 'info' && rest[1] === 'refs' && rest.length === 2) {
          if ((req.method ?? 'GET') !== 'GET') {
            sendJson(res, 404, message(404, 'Not Found'));
            return;
          }
          await handleInfoRefs(store, req, res, owner, repoName, url.searchParams);
          return;
        }
        if (rest[0] === 'git-upload-pack' && rest.length === 1) {
          if ((req.method ?? 'GET') !== 'POST') {
            sendJson(res, 404, message(404, 'Not Found'));
            return;
          }
          await handleUploadPack(store, req, res, owner, repoName);
          return;
        }
        if (rest[0] === 'git-receive-pack' && rest.length === 1) {
          if ((req.method ?? 'GET') !== 'POST') {
            sendJson(res, 404, message(404, 'Not Found'));
            return;
          }
          await handleReceivePack(store, req, res, owner, repoName);
          return;
        }
      }
      sendJson(res, 404, message(404, 'Not Found'));
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, message(500, (err as Error).message));
      } else {
        res.end();
      }
    }
  });
  return server;
}

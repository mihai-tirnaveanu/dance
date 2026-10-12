// Minimal GitHub REST client for a private "database" repo:
// JSON file via the Contents API, media via raw downloads and the Git Data API.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
  get isAuth() { return this.status === 401; }
  get isConflict() { return this.status === 409 || (this.status === 422 && /sha|fast forward|Update is not a fast/i.test(this.message)); }
}

export const isNetworkError = (e) => e instanceof TypeError || e?.name === 'NetworkError';

export function b64encodeBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const b64encodeUtf8 = (str) => b64encodeBytes(new TextEncoder().encode(str));
export function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = r.result; resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export class GitHub {
  constructor({ token, owner, repo, branch = 'main' }) {
    Object.assign(this, { token, owner, repo, branch });
  }

  get base() { return `/repos/${this.owner}/${this.repo}`; }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  async req(method, path, { body, accept, signal, raw } = {}) {
    const headers = this.headers(accept ? { Accept: accept } : {});
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch {}
      throw new GitHubError(res.status, data?.message || res.statusText || `HTTP ${res.status}`, data);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  user() { return this.req('GET', '/user'); }
  repoInfo() { return this.req('GET', this.base); }

  /** Returns {sha, data} or null if the file does not exist. */
  async getJSON(path) {
    let meta;
    try {
      meta = await this.req('GET', `${this.base}/contents/${encPath(path)}?ref=${encodeURIComponent(this.branch)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    let text;
    if (meta.content && meta.encoding === 'base64') text = b64decodeUtf8(meta.content);
    else {
      // Files over 1 MB: the Contents API omits content; read the blob instead.
      const blob = await this.req('GET', `${this.base}/git/blobs/${meta.sha}`);
      text = b64decodeUtf8(blob.content);
    }
    return { sha: meta.sha, data: JSON.parse(text) };
  }

  /** Create or update a JSON file. Returns the new blob sha. */
  async putJSON(path, data, sha, message) {
    const body = {
      message,
      content: b64encodeUtf8(JSON.stringify(data, null, 1) + '\n'),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await this.req('PUT', `${this.base}/contents/${encPath(path)}`, { body });
    return res.content.sha;
  }

  /** Download a file's bytes with progress. */
  async getRaw(path, { onProgress, signal, size = 0, type = 'application/octet-stream' } = {}) {
    const res = await this.req('GET', `${this.base}/contents/${encPath(path)}?ref=${encodeURIComponent(this.branch)}`, {
      accept: 'application/vnd.github.raw',
      signal,
      raw: true,
    });
    const total = Number(res.headers.get('Content-Length')) || size || 0;
    if (!res.body || !onProgress) {
      const b = await res.blob();
      return new Blob([b], { type });
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, Math.max(total, received));
    }
    return new Blob(chunks, { type });
  }

  /** Upload one file as a git blob (base64) with upload progress. Returns the blob sha. */
  async createBlob(blob, { onProgress, signal } = {}) {
    const content = await blobToBase64(blob);
    const body = new Blob(['{"encoding":"base64","content":"', content, '"}'], { type: 'application/json' });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}${this.base}/git/blobs`);
      const hd = this.headers({ 'Content-Type': 'application/json' });
      for (const [k, v] of Object.entries(hd)) xhr.setRequestHeader(k, v);
      xhr.responseType = 'json';
      if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response.sha);
        else reject(new GitHubError(xhr.status, xhr.response?.message || `HTTP ${xhr.status}`, xhr.response));
      };
      xhr.onerror = () => reject(new TypeError('Network error'));
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body);
    });
  }

  /**
   * Commit a set of changes on top of the branch head.
   * changes: [{path, sha}] to add/replace, [{path, sha: null}] to delete.
   */
  async commit(changes, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ref = await this.req('GET', `${this.base}/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const headSha = ref.object.sha;
      const head = await this.req('GET', `${this.base}/git/commits/${headSha}`);
      const tree = await this.req('POST', `${this.base}/git/trees`, {
        body: {
          base_tree: head.tree.sha,
          tree: changes.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: c.sha })),
        },
      });
      const commit = await this.req('POST', `${this.base}/git/commits`, {
        body: { message, tree: tree.sha, parents: [headSha] },
      });
      try {
        await this.req('PATCH', `${this.base}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
          body: { sha: commit.sha, force: false },
        });
        return commit.sha;
      } catch (e) {
        if (e.status === 422 && attempt < 3) continue; // head moved meanwhile: rebuild on the new head
        throw e;
      }
    }
  }
}

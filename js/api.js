import {apiOrigin} from './core.js';

export class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}
function errorFor(payload, status) { return new ApiError(payload?.error?.message || `SALTA returned HTTP ${status}.`, status, payload?.error?.code || ''); }

export class SaltaApi {
  #token;
  constructor(origin, token, fetcher = globalThis.fetch) {
    this.origin = apiOrigin(origin);
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Paste a valid SALTA API token.');
    this.#token = token.trim(); this.fetcher = fetcher; this.controller = new AbortController();
  }
  disconnect() { this.controller.abort(); this.#token = ''; }
  url(path) {
    if (!path.startsWith('/api/v1/') || /[?#\\]/.test(path)) throw new Error('Invalid API path.');
    const result = new URL(path, this.origin);
    if (result.origin !== this.origin) throw new Error('API requests must stay on the connected SALTA origin.');
    return result.href;
  }
  async request(path, {method = 'GET', body, signal = this.controller.signal, query} = {}) {
    if (!this.#token) throw new Error('Connect to SALTA again.');
    let response;
    try {
      const url = new URL(this.url(path));
      if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      response = await this.fetcher(url.href, {method, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: {Authorization: `Bearer ${this.#token}`, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError('Could not reach SALTA. Check the address, VPN/network, and whether this recorder origin is allowed by SALTA.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw errorFor(payload, response.status);
    if (!payload || typeof payload !== 'object') throw new ApiError('SALTA returned an invalid API response.');
    return payload;
  }
  capabilities() { return this.request('/api/v1/capabilities/'); }
  projects() { return this.request('/api/v1/projects/'); }
  createProject(name, description = '') { return this.request('/api/v1/projects/', {method: 'POST', body: {name, description}}); }
  createRecording(manifest) { return this.request('/api/v1/recordings/', {method: 'POST', body: manifest}); }
  recordings(projectId, page = 1) {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(page) || page < 1) throw new Error('Invalid project or page.');
    return this.request('/api/v1/recordings/', {query: {project_id: projectId, page, page_size: 20}});
  }
  async download(id, key) {
    if (!this.#token || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error('Connect to SALTA and choose a valid stream.');
    const response = await this.fetcher(this.url(`/api/v1/recordings/${this.recordingId(id)}/streams/${key}/download/`), {signal: this.controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: {Authorization: `Bearer ${this.#token}`}});
    if (!response.ok) throw errorFor(await response.json().catch(() => null), response.status);
    return response.blob();
  }
  recording(id) { return this.request(`/api/v1/recordings/${this.recordingId(id)}/`); }
  recordingId(id) { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid recording ID.'); return id; }
  upload(id, stream, onProgress, {signal, xhrFactory = () => new XMLHttpRequest()} = {}) {
    if (!this.#token) return Promise.reject(new Error('Connect to SALTA again.'));
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stream.key)) return Promise.reject(new Error('Invalid stream key.'));
    return new Promise((resolve, reject) => {
      const xhr = xhrFactory();
      const abort = () => xhr.abort();
      const finish = fn => value => { signal?.removeEventListener('abort', abort); this.controller.signal.removeEventListener('abort', abort); fn(value); };
      const done = finish(resolve), fail = finish(reject);
      xhr.open('POST', this.url(`/api/v1/recordings/${this.recordingId(id)}/streams/${stream.key}/`));
      xhr.withCredentials = false; xhr.timeout = 10 * 60 * 1000;
      xhr.setRequestHeader('Authorization', `Bearer ${this.#token}`);
      xhr.upload.onprogress = event => onProgress?.(event.lengthComputable ? event.loaded / event.total : null);
      xhr.onerror = () => fail(new ApiError('Upload interrupted. The local draft is safe; reconnect and retry the same draft.'));
      xhr.ontimeout = () => fail(new ApiError('Upload timed out. The local draft is safe; retry to check whether SALTA received it.'));
      xhr.onabort = () => fail(new DOMException('Upload cancelled; the local draft is retained.', 'AbortError'));
      xhr.onload = () => {
        if (xhr.responseURL && new URL(xhr.responseURL).origin !== this.origin) return fail(new ApiError('SALTA redirected the upload to another origin.'));
        let payload; try { payload = JSON.parse(xhr.responseText); } catch { return fail(new ApiError('SALTA returned an unreadable upload response. Retry the same draft to check its status.')); }
        if (xhr.status < 200 || xhr.status >= 300) return fail(errorFor(payload, xhr.status));
        done(payload);
      };
      signal?.addEventListener('abort', abort, {once: true});
      this.controller.signal.addEventListener('abort', abort, {once: true});
      if (signal?.aborted || this.controller.signal.aborted) { fail(new DOMException('Upload cancelled.', 'AbortError')); return; }
      const form = new FormData(); form.append('file', stream.blob, stream.filename); xhr.send(form);
    });
  }
}

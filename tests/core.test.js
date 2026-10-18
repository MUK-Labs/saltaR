import test from 'node:test';
import assert from 'node:assert/strict';
import {apiOrigin, analysisUrl, createManifest, backupBlob, restoreBackup, sha256} from '../js/core.js';
import {SaltaApi} from '../js/api.js';

function draft() { return {id: '257914b8-c557-4f70-b53b-69ca98330c10', label: 'Take', started_at: '2026-10-18T12:00:00Z', metadata: {clock: 'performance'}, streams: [{key: 'microphone', kind: 'audio', filename: 'take.webm', mime_type: 'audio/webm', started_at: '2026-10-18T12:00:00Z', offset_seconds: 0.12, metadata: {}, blob: new Blob(['binary\u0000bytes'], {type: 'audio/webm'})}]}; }

test('API origin accepts HTTPS and only loopback HTTP, without embedded secrets or paths', () => {
  assert.equal(apiOrigin('https://salta.example/'), 'https://salta.example');
  assert.equal(apiOrigin('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
  for (const value of ['http://salta.example', 'https://user:secret@example.com', 'https://salta.example/?token=x', 'https://salta.example/home', 'javascript:alert(1)', 'http://localhost.evil.test']) assert.throws(() => apiOrigin(value));
});
test('analysis links accept only positive numeric IDs and configured origin', () => {
  assert.equal(analysisUrl('https://salta.example', 17), 'https://salta.example/home/salta_analysis/?file=17');
  for (const id of ['https://evil.example', '../secret', '1', 0, -2, Infinity]) assert.equal(analysisUrl('https://salta.example', id), null);
});
test('manifest retains stream offsets and excludes blobs/local connection state', () => {
  const d = draft(); d.targetOrigin = 'https://salta.example'; const m = createManifest(d, 12, 'Take 1');
  assert.equal(m.streams[0].offset_seconds, .12); assert.equal(m.client_id, d.id); assert.equal(m.project_id, 12);
  assert.ok(!('blob' in m.streams[0])); assert.ok(!('targetOrigin' in m)); assert.throws(() => createManifest(d, 0, 'Take'));
});
test('binary backup roundtrip preserves bytes, manifest and retry UUID without base64', async () => {
  const d = draft(); d.manifest = createManifest(d, 12, 'Take'); d.targetOrigin = 'https://salta.example';
  const restored = await restoreBackup(backupBlob(d));
  assert.equal(restored.id, d.id); assert.deepEqual(restored.manifest, d.manifest); assert.equal(await restored.streams[0].blob.text(), await d.streams[0].blob.text());
  assert.equal(await sha256(restored.streams[0].blob), await sha256(d.streams[0].blob));
});
test('backup rejects truncation, trailing bytes and top-level credentials', async () => {
  const backup = backupBlob(draft());
  await assert.rejects(restoreBackup(backup.slice(0, backup.size - 1)), /incomplete/);
  await assert.rejects(restoreBackup(new Blob([backup, 'extra'])), /trailing/);
  assert.throws(() => backupBlob({...draft(), token: 'secret'}), /credentials/);
});
test('JSON API omits cookies, rejects redirects and sends token only in Authorization', async () => {
  const calls = []; const api = new SaltaApi('https://salta.example', 'salta_secret', async (...args) => { calls.push(args); return {ok: true, json: async () => ({projects: []})}; });
  await api.projects(); const [url, options] = calls[0];
  assert.equal(url, 'https://salta.example/api/v1/projects/'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer salta_secret');
  assert.ok(!JSON.stringify(api).includes('salta_secret')); assert.ok(!url.includes('salta_secret'));
  api.disconnect(); assert.equal(options.signal.aborted, true); await assert.rejects(api.projects(), /Connect/);
});
test('history query is bounded and original downloads use fixed authenticated paths', async () => {
  const calls = []; const api = new SaltaApi('https://salta.example', 'secret', async (url, options) => { calls.push({url, options}); return {ok: true, json: async () => ({}), blob: async () => new Blob(['original'])}; });
  await api.recordings(9, 2); assert.equal(calls[0].url, 'https://salta.example/api/v1/recordings/?project_id=9&page=2&page_size=20');
  assert.equal(await (await api.download(draft().id, 'microphone')).text(), 'original'); assert.equal(calls[1].options.credentials, 'omit');
  await assert.rejects(api.download(draft().id, '../evil'), /valid stream/);
});
test('XHR upload has explicit progress, no cookies, exact filename, and disconnect aborts it', async () => {
  let xhr;
  class FakeXHR { constructor() { xhr = this; this.upload = {}; this.headers = {}; } open(method, url) { this.method = method; this.url = url; } setRequestHeader(k, v) { this.headers[k] = v; } send(form) { this.form = form; } abort() { this.onabort(); } }
  const api = new SaltaApi('https://salta.example', 'secret'); let progress;
  const promise = api.upload(draft().id, draft().streams[0], value => { progress = value; }, {xhrFactory: () => new FakeXHR()});
  xhr.upload.onprogress({lengthComputable: true, loaded: 2, total: 4}); assert.equal(progress, .5); assert.equal(xhr.withCredentials, false); assert.equal(xhr.form.get('file').name, 'take.webm'); assert.ok(!('Content-Type' in xhr.headers));
  api.disconnect(); await assert.rejects(promise, {name: 'AbortError'});
});

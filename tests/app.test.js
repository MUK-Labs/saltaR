import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {DraftStore} from '../js/store.js';
import {sha256} from '../js/core.js';
const require = createRequire(import.meta.url);
const {JSDOM} = require('jsdom');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

test('app DOM: offline fallback, connect, import, explicit upload, history and disconnect', async t => {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'), {url: 'https://recorder.example/saltaR/'});
  const {window} = dom; const document = window.document;
  Object.assign(globalThis, {window, document, Option: window.Option, confirm: () => true});
  Object.defineProperty(globalThis, 'navigator', {value: window.navigator, configurable: true});
  Object.defineProperty(window, 'isSecureContext', {value: true});
  Object.defineProperty(window, 'DeviceMotionEvent', {value: undefined});
  const local = new Map();
  DraftStore.prototype.transact = async (_mode, action) => action({getAll: () => ({result: [...local.values()]}), put: draft => { local.set(draft.id, structuredClone(draft)); return {result: draft.id}; }, delete: id => { local.delete(id); return {}; }}).result;
  const calls = []; let recording = null, uploadCount = 0, fileBytes = null;
  globalThis.fetch = async (url, options) => {
    calls.push({url, options}); let payload;
    if (url.endsWith('/capabilities/')) payload = {api_version: '1', user: {name: 'Test user'}, max_file_bytes: 536870912, max_json_file_bytes: 16777216};
    else if (url.endsWith('/projects/')) payload = {projects: [{id: 12, name: '<Project & name>'}]};
    else if (url.includes('/recordings/?')) payload = {recordings: recording ? [recording] : [], page: 1, next_page: null};
    else if (url.endsWith('/recordings/') && options.method === 'POST') { const manifest = JSON.parse(options.body); recording = {id: '257914b8-c557-4f70-b53b-69ca98330c10', ...manifest, streams: manifest.streams.map(s => ({...s, status: 'awaiting_upload', processing: {status: 'awaiting_upload', processed_file_ids: []}}))}; payload = {recording}; }
    else if (url.includes('/recordings/')) payload = {recording};
    else throw new Error(`Unexpected request ${url}`);
    return {ok: true, json: async () => structuredClone(payload)};
  };
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; }
    open(_method, url) { this.responseURL = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    async send(form) {
      uploadCount++; fileBytes = form.get('file'); this.upload.onprogress?.({lengthComputable: true, loaded: 1, total: 1});
      const stream = {...recording.streams[0], status: 'uploaded', size_bytes: fileBytes.size, sha256: await sha256(fileBytes), processing: {status: 'succeeded', supported: true, processed_file_ids: [99]}};
      recording.streams = [stream]; this.status = 201; this.responseText = JSON.stringify({stream}); this.onload();
    }
    abort() { this.onabort?.(); }
  };
  await import(`../js/app.js?smoke=${Date.now()}`); await settle();
  const $ = id => document.getElementById(id);
  const event = (id, name) => $(id).dispatchEvent(new window.Event(name, {bubbles: true, cancelable: true}));
  await t.test('all IDs wire up with graceful unavailable sensors and no automatic transfer', () => {
    assert.equal(calls.length, 0); assert.equal($('upload-btn').disabled, true); assert.equal($('motion-enabled').disabled, true); assert.equal($('midi-enabled').disabled, true);
    assert.equal(document.querySelector('input[name="av-mode"]:checked').value, 'none');
  });
  await t.test('connect keeps token in memory and renders project names as text', async () => {
    $('api-base').value = 'https://salta.example'; $('api-token').value = 'salta_private_token'; event('connect-form', 'submit'); await settle();
    assert.equal($('connection-badge').textContent, 'Connected'); assert.equal($('api-token').value, ''); assert.equal($('project-select').options[1].textContent, '<Project & name>');
    assert.ok(!document.body.innerHTML.includes('salta_private_token')); assert.ok(!JSON.stringify([...local.values()]).includes('salta_private_token'));
    $('project-select').value = '12'; event('project-select', 'change'); await settle(); assert.match($('history-list').textContent, /No recordings/);
  });
  await t.test('import persists a local draft and does not upload without explicit action', async () => {
    Object.defineProperty($('import-file'), 'files', {value: [new File(['WAV data'], 'test.wav', {type: 'audio/wav', lastModified: 1})], configurable: true});
    $('import-kind').value = 'audio'; event('import-form', 'submit'); await settle();
    assert.equal(local.size, 1); assert.equal(uploadCount, 0); assert.equal($('upload-btn').disabled, false); assert.match($('stream-list').textContent, /test.wav/); assert.match($('timing-note').textContent, /alignment are unknown/);
  });
  await t.test('explicit upload preserves manifest, renders safe analysis link and server history', async () => {
    event('upload-btn', 'click'); event('upload-btn', 'click'); await settle();
    assert.equal(uploadCount, 1); assert.equal(await fileBytes.text(), 'WAV data'); assert.equal([...local.values()][0].manifest.project_id, 12);
    const link = $('stream-list').querySelector('a'); assert.equal(link.href, 'https://salta.example/home/salta_analysis/?file=99'); assert.equal(link.rel, 'noopener noreferrer');
    assert.match($('history-list').textContent, /test.wav/); assert.equal($('take-label').disabled, true);
  });
  await t.test('editing server disconnects and clears remote project/history state', async () => {
    $('api-base').value = 'https://another.example'; event('api-base', 'input'); await settle();
    assert.equal($('connection-badge').textContent, 'Offline'); assert.equal($('project-select').disabled, true); assert.equal($('upload-btn').disabled, true); assert.equal(local.size, 1);
    assert.ok(calls.filter(c => c.options.signal).every(c => c.options.signal.aborted));
  });
  dom.window.close();
});

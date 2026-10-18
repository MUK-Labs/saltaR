import {SaltaApi} from './api.js';
import {Capture} from './capture.js';
import {DraftStore} from './store.js';
import {LIMITS, KINDS, apiOrigin, uuid, formatBytes, formatTime, safeFilename, createManifest, backupBlob, restoreBackup, analysisUrl, hasActiveJobs, sha256} from './core.js';

const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
const store = new DraftStore(); const capture = new Capture();
let api = null, connectingApi = null, capabilities = null, connectionGeneration = 0, drafts = [], selected = null, uploading = false, uploadController = null, pollTimer = null, historyGeneration = 0, previewUrls = [];

function message(text, error = false) { $('global-status').textContent = text; $('global-status').classList.toggle('error', error); show('global-status', Boolean(text)); }
function handleError(error) { if (error.name !== 'AbortError') message(error.message || String(error), true); }
function action(id, event, fn) { $(id).addEventListener(event, e => { e.preventDefault(); Promise.resolve().then(() => fn(e)).catch(handleError); }); }
function download(blob, name) { const url = URL.createObjectURL(blob); const link = node('a'); link.href = url; link.download = safeFilename(name); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
function selectedProject() { const n = Number($('project-select').value); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function clearPreviews() { previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls = []; }
function setCaptureControls() {
  const busy = ['preparing', 'recording', 'stopping'].includes(capture.state), ready = capture.state === 'ready';
  $('source-controls').querySelectorAll('input,select,button').forEach(el => { el.disabled = busy || ready || el.dataset.unsupported === 'true'; });
  $('prepare-btn').disabled = busy || ready || uploading; $('start-btn').disabled = !ready || uploading; show('stop-btn', capture.state === 'recording' || capture.state === 'stopping'); $('stop-btn').disabled = capture.state === 'stopping'; show('release-btn', ready || capture.state === 'preparing'); $('release-btn').textContent = capture.state === 'preparing' ? 'Cancel setup' : 'Release sources';
  $('capture-badge').textContent = {idle: 'Ready to set up', preparing: 'Requesting access', ready: 'Sources enabled', recording: 'Recording', stopping: 'Saving…'}[capture.state];
  $('recording-indicator').classList.toggle('active', capture.state === 'recording');
}
function setUploadControls() {
  $('upload-btn').disabled = !api || !selectedProject() || !selected || uploading || ['recording', 'stopping'].includes(capture.state);
  $('take-label').disabled = uploading || Boolean(selected?.manifest);
  $('delete-draft-btn').disabled = uploading; $('project-select').disabled = !api || uploading;
  $('restore-file').disabled = uploading; $('create-project-btn').disabled = !api || uploading;
  $('import-form').querySelectorAll('input,select,button').forEach(el => { el.disabled = uploading; });
  show('cancel-upload-btn', uploading); $('backup-btn').disabled = !selected;
  $('upload-btn').textContent = selected?.manifest ? 'Check & retry upload' : 'Upload to project';
}
async function persist(draft) {
  await store.put(draft);
  drafts = drafts.filter(d => d.id !== draft.id); drafts.unshift(draft); renderDrafts();
  $('storage-status').textContent = 'Completed takes are saved on this device. Browser storage can still be cleared or evicted; keep a backup.';
}
function renderDrafts() {
  $('draft-count').textContent = `${drafts.length} draft${drafts.length === 1 ? '' : 's'}`; $('draft-list').replaceChildren();
  if (!drafts.length) $('draft-list').append(node('li', 'No saved drafts yet.', 'empty'));
  drafts.forEach(draft => { const li = node('li'), button = node('button', draft.label || 'Untitled take'); button.type = 'button'; button.setAttribute('aria-current', String(selected?.id === draft.id)); button.disabled = uploading; button.append(node('small', `${new Date(draft.started_at).toLocaleString()} · ${draft.streams.length} source(s)`)); button.addEventListener('click', () => selectDraft(draft)); li.append(button); $('draft-list').append(li); });
}
function streamCard(stream, recordingId = null, local = false, origin = api?.origin) {
  const card = node('article', undefined, 'stream'), header = node('div', undefined, 'stream-header');
  header.append(node('h3', stream.filename), node('span', stream.kind.replace('_', ' '), 'badge')); card.append(header);
  const process = stream.processing, size = stream.blob?.size ?? stream.size_bytes;
  card.append(node('p', `${size !== undefined ? formatBytes(size) + ' · ' : ''}offset ${Number(stream.offset_seconds || 0).toFixed(3)} s${['acceleration', 'midi_events'].includes(stream.kind) ? ' · raw data only; segmentation unsupported in v1' : ''}`));
  if (stream.kind === 'acceleration' && stream.metadata?.sample_count !== undefined) {
    card.append(node('p', `${stream.metadata.sample_count} motion samples · ${stream.metadata.observed_axis_samples} with observed axes`));
    if (!stream.metadata.observed_axis_samples) card.append(node('p', 'No motion measurements were received. Check sensor availability and permission; this raw draft is retained, but it contains no usable acceleration evidence.', 'error'));
  }
  if (stream.kind === 'midi_events' && stream.metadata?.event_count !== undefined) card.append(node('p', `${stream.metadata.event_count} MIDI events${stream.metadata.event_count ? '' : ' · no events received; check the input or record a new take'}`));
  if (process) {
    const descriptions = {awaiting_upload: 'Awaiting upload', pending: 'Saved · waiting for dispatch', dispatching: 'Saved · dispatching', queued: 'Saved · queued for processing', running: 'Processing', succeeded: 'Processing complete', partial: 'Partially processed — inspect the outputs and error', failed: 'Processing failed — original file is retained', dispatch_error: 'Dispatch needs review — original file is retained', unsupported: 'Stored for download · segmentation unsupported'};
    card.append(node('p', descriptions[process.status] || process.status || 'Status unavailable'));
    if (process.error || process.reason) card.append(node('p', process.error || process.reason, 'error'));
    for (const fileId of process.processed_file_ids || []) { const href = origin && analysisUrl(origin, fileId); if (href) { const link = node('a', `Open analysis #${fileId} ↗`); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); } }
  }
  if (local && stream.blob && ['audio', 'video'].includes(stream.kind)) { const preview = node(stream.kind); const url = URL.createObjectURL(stream.blob); previewUrls.push(url); preview.src = url; preview.controls = true; preview.preload = 'metadata'; if (stream.kind === 'video') preview.playsInline = true; card.append(preview); }
  const button = node('button', local ? 'Download original' : 'Download from SALTA', 'quiet'); button.type = 'button';
  button.disabled = !local && (!api || stream.status === 'awaiting_upload' || !stream.size_bytes);
  button.addEventListener('click', async () => { try { button.disabled = true; const blob = local ? stream.blob : await api.download(recordingId, stream.key); download(blob, stream.filename); } catch (error) { handleError(error); } finally { button.disabled = false; } }); card.append(button);
  return card;
}
function renderReview() {
  clearPreviews(); show('review-empty', !selected); show('review-content', Boolean(selected));
  if (!selected) { $('draft-state').textContent = 'No take selected'; setUploadControls(); return; }
  $('take-label').value = selected.label; $('draft-state').textContent = selected.manifest ? 'Upload manifest fixed' : 'Local draft';
  $('take-meta').textContent = `${new Date(selected.started_at).toLocaleString()} · ${selected.streams.length} source(s) · ${formatBytes(selected.streams.reduce((n, s) => n + s.blob.size, 0))}`;
  $('stream-list').replaceChildren(...selected.streams.map(s => {
    const remote = selected.remote?.streams?.find(r => r.key === s.key); return streamCard({...s, ...(remote ? {processing: remote.processing} : {})}, selected.remote?.id, true, selected.targetOrigin);
  }));
  const interruptions = selected.metadata.interruptions || [];
  $('timing-note').textContent = `${selected.metadata.timing || 'Imported file; timing has not been synchronized.'}${interruptions.length ? ` Recorded interruptions: ${interruptions.map(i => `${i.type} at ${Number(i.at_seconds).toFixed(2)} s`).join('; ')}.` : ''} Source offsets are saved as metadata; apply them deliberately when combining bundles in SALTA.`;
  if (selected.manifest) $('upload-status').textContent = `This draft is linked to project #${selected.manifest.project_id} on ${selected.targetOrigin}. Retries reuse the same manifest and files.`;
  else $('upload-status').textContent = 'Choose a project, then upload explicitly. Your local draft will remain here.';
  setUploadControls(); renderDrafts();
}
function selectDraft(draft) { if (uploading) return; stopPolling(); selected = draft; renderReview(); if (api && draft.targetOrigin === api.origin && draft.remote?.id) void pollDraft(); }
async function keepDraft(draft) {
  selected = draft;
  try { await persist(draft); message('Take saved on this device. Review it below; nothing has been uploaded.'); }
  catch (error) { drafts = drafts.filter(d => d.id !== draft.id); drafts.unshift(draft); message(`${error.message} This take is still available in this page.`, true); }
  renderReview();
}
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
async function pollDraft() {
  stopPolling(); const current = api, generation = connectionGeneration, draft = selected;
  if (!current || !draft?.remote?.id || draft.targetOrigin !== current.origin) return;
  try {
    const {recording} = await current.recording(draft.remote.id);
    if (api !== current || generation !== connectionGeneration || selected !== draft) return;
    draft.remote = recording; await persist(draft); renderReview();
    if (hasActiveJobs(recording)) pollTimer = setTimeout(() => void pollDraft(), 4000);
  } catch (error) { if (api === current && selected === draft && error.name !== 'AbortError') { $('upload-status').textContent = `Status check paused: ${error.message} Use Check & retry upload to reconnect to this recording.`; } }
}
function disconnect({clearToken = true} = {}) {
  connectionGeneration++; historyGeneration++; stopPolling(); uploadController?.abort(); api?.disconnect(); connectingApi?.disconnect(); connectingApi = null; api = null; capabilities = null;
  if (clearToken) $('api-token').value = '';
  $('connection-badge').textContent = 'Offline'; $('connection-badge').classList.remove('connected'); $('connect-status').textContent = 'Disconnected. Local drafts remain on this device.';
  $('project-select').replaceChildren(new Option('Connect to load projects', '')); $('project-select').disabled = true;
  for (const id of ['project-name', 'project-description', 'create-project-btn', 'refresh-history-btn']) $(id).disabled = true;
  show('disconnect-btn', false); $('history-list').replaceChildren(node('li', 'Connect and choose a project to see its recordings.', 'empty')); $('history-detail').replaceChildren(); setUploadControls();
}
async function connect() {
  const origin = apiOrigin($('api-base').value), token = $('api-token').value; disconnect({clearToken: false});
  const generation = connectionGeneration, candidate = new SaltaApi(origin, token); connectingApi = candidate; $('connect-btn').disabled = true; $('connect-status').textContent = 'Connecting…';
  try {
    const [caps, projects] = await Promise.all([candidate.capabilities(), candidate.projects()]);
    if (generation !== connectionGeneration) { candidate.disconnect(); return; }
    if (String(caps.api_version) !== '1' || !Array.isArray(projects.projects)) throw new Error('This SALTA server does not provide the expected recorder API v1.');
    api = candidate; connectingApi = null; capabilities = caps; $('api-token').value = ''; $('api-base').value = origin;
    $('connection-badge').textContent = 'Connected'; $('connection-badge').classList.add('connected'); $('connect-status').textContent = `Connected${caps.user?.name ? ` as ${caps.user.name}` : ''}. Token is held only in this page’s memory.`;
    $('project-select').replaceChildren(new Option('Choose a project', ''), ...projects.projects.map(project => new Option(project.name, project.id)));
    for (const id of ['project-name', 'project-description', 'create-project-btn', 'refresh-history-btn', 'project-select']) $(id).disabled = false;
    show('disconnect-btn', true); message('Connected. Choose a destination project when you are ready to upload.'); setUploadControls();
  } catch (error) { candidate.disconnect(); if (generation === connectionGeneration) { $('connect-status').textContent = 'Connection failed. Recording and local backups remain available.'; throw error; } }
  finally { $('connect-btn').disabled = false; }
}
async function refreshHistory(page = 1) {
  const current = api, project = selectedProject(), generation = ++historyGeneration;
  $('history-detail').replaceChildren();
  if (!current || !project) { $('history-list').replaceChildren(node('li', 'Choose a project to see its recordings.', 'empty')); return; }
  $('history-list').replaceChildren(node('li', 'Loading recordings…', 'empty'));
  const result = await current.recordings(project, page);
  if (api !== current || generation !== historyGeneration || selectedProject() !== project) return;
  $('history-list').replaceChildren();
  if (!result.recordings?.length) $('history-list').append(node('li', 'No recordings in this project yet.', 'empty'));
  for (const recording of result.recordings || []) { const li = node('li'), button = node('button', recording.label); button.type = 'button'; button.append(node('small', `${new Date(recording.started_at || recording.created_at).toLocaleString()} · ${recording.streams.length} source(s)`)); button.addEventListener('click', () => { $('history-detail').replaceChildren(node('h3', recording.label), ...recording.streams.map(s => streamCard(s, recording.id))); }); li.append(button); $('history-list').append(li); }
  const pagination = node('li', undefined, 'button-row');
  for (const [label, next] of [['Newer', page > 1 ? page - 1 : null], ['Older', result.next_page]]) if (next) { const button = node('button', label, 'quiet'); button.type = 'button'; button.addEventListener('click', () => refreshHistory(next).catch(handleError)); pagination.append(button); }
  if (pagination.children.length) $('history-list').append(pagination);
}
async function uploadSelected() {
  if (uploading) return;
  const current = api, draft = selected, projectId = selectedProject(), generation = connectionGeneration;
  if (!current || !draft || !projectId) throw new Error('Connect and choose a project first.');
  if (draft.targetOrigin && draft.targetOrigin !== current.origin) throw new Error('This draft already has an upload manifest for another SALTA server. Reconnect to that original address to retry.');
  if (draft.manifest && draft.manifest.project_id !== projectId) throw new Error(`This draft is already assigned to project #${draft.manifest.project_id}. Select that project to retry.`);
  for (const stream of draft.streams) { const max = ['acceleration', 'midi_events'].includes(stream.kind) ? capabilities.max_json_file_bytes : capabilities.max_file_bytes; if (stream.blob.size > max) throw new Error(`${stream.filename} exceeds this SALTA server’s ${formatBytes(max)} limit.`); }
  if (!draft.manifest) { draft.label = $('take-label').value.trim(); draft.manifest = createManifest(draft, projectId, draft.label); draft.targetOrigin = current.origin; }
  // Save the exact immutable manifest before the first network mutation.
  uploading = true; uploadController = new AbortController(); stopPolling(); setUploadControls(); setCaptureControls(); renderDrafts(); show('upload-progress', true); $('upload-progress').value = 0;
  try {
    await persist(draft);
    $('upload-status').textContent = 'Creating or recovering the recording…';
    const {recording} = await current.createRecording(draft.manifest);
    if (api !== current || generation !== connectionGeneration) throw new DOMException('Connection changed.', 'AbortError');
    draft.remote = recording; await persist(draft);
    for (let index = 0; index < draft.streams.length; index++) {
      const stream = draft.streams[index], remote = draft.remote.streams.find(s => s.key === stream.key);
      if (remote && ['uploaded', 'stored'].includes(remote.status) && remote.sha256) {
        $('upload-status').textContent = `Verifying saved ${stream.filename}…`;
        const digest = await sha256(stream.blob);
        if (api !== current || generation !== connectionGeneration || uploadController.signal.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
        if (digest !== remote.sha256 || remote.filename !== stream.filename) throw new Error(`${stream.filename} differs from the file already stored for this recording. Keep this draft and its backup; do not overwrite the saved recording.`);
        $('upload-progress').value = (index + 1) / draft.streams.length; continue;
      }
      if (uploadController.signal.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
      $('upload-status').textContent = `Uploading ${stream.filename} (${index + 1}/${draft.streams.length})…`;
      const result = await current.upload(recording.id, stream, fraction => { if (fraction !== null) $('upload-progress').value = (index + fraction) / draft.streams.length; }, {signal: uploadController.signal});
      if (api !== current || generation !== connectionGeneration) throw new DOMException('Connection changed.', 'AbortError');
      draft.remote.streams = draft.remote.streams.map(s => s.key === stream.key ? result.stream : s); await persist(draft);
    }
    $('upload-progress').value = 1; message('Upload complete. Original files are saved on SALTA; audio/video processing may still be running. Local drafts remain available.');
  } catch (error) { if (error.name === 'AbortError') message('Upload stopped. Your local draft is retained. Retry this same draft to check what SALTA received.'); else handleError(error); }
  finally { uploading = false; uploadController = null; renderReview(); setUploadControls(); setCaptureControls(); if (api === current) { void pollDraft(); refreshHistory().catch(handleError); } }
}

action('connect-form', 'submit', connect);
action('disconnect-btn', 'click', () => disconnect());
$('api-base').addEventListener('input', () => { if (api || $('connect-btn').disabled) disconnect(); });
$('api-token').addEventListener('input', () => { if (api || $('connect-btn').disabled) disconnect({clearToken: false}); });
action('project-form', 'submit', async () => {
  if (!api) throw new Error('Connect first.'); const current = api;
  const {project} = await current.createProject($('project-name').value.trim(), $('project-description').value.trim());
  if (api !== current) return; $('project-select').append(new Option(project.name, project.id, true, true)); $('project-form').reset(); setUploadControls(); await refreshHistory();
});
action('project-select', 'change', async () => { setUploadControls(); await refreshHistory(); });
action('refresh-history-btn', 'click', () => refreshHistory());
// This listener is intentionally synchronous up to prepare(), so iOS motion
// permission is requested within the user's original activation.
$('prepare-btn').addEventListener('click', () => {
  const pending = capture.prepare({mode: document.querySelector('input[name="av-mode"]:checked').value, motion: $('motion-enabled').checked, midi: $('midi-enabled').checked, midiId: $('midi-device').value});
  setCaptureControls(); pending.then(() => { $('camera-preview').srcObject = capture.media; show('camera-preview', Boolean(capture.media?.getVideoTracks().length)); $('capture-message').textContent = 'Sources enabled. Start when you are ready.'; }).catch(handleError).finally(setCaptureControls);
});
$('find-midi-btn').addEventListener('click', () => { capture.discoverMidi().then(inputs => { $('midi-device').replaceChildren(new Option('Choose a MIDI input', ''), ...inputs.map(input => new Option(input.name || input.id, input.id))); $('midi-support').textContent = inputs.length ? `${inputs.length} input(s) found. Select the device to record.` : 'No MIDI inputs found. Connect a device and try again.'; }).catch(handleError); });
action('release-btn', 'click', () => { capture.release(); $('camera-preview').srcObject = null; show('camera-preview', false); setCaptureControls(); });
action('start-btn', 'click', () => { capture.start(); $('capture-message').textContent = 'Recording locally. Keep this page visible.'; setCaptureControls(); setUploadControls(); message('Recording has started. No data is being uploaded.'); });
action('stop-btn', 'click', async () => { const pending = capture.stop(); setCaptureControls(); await pending; });
capture.addEventListener('tick', event => { $('capture-time').textContent = formatTime(event.detail.duration); $('capture-counts').textContent = `${formatBytes(event.detail.bytes)} media · ${event.detail.motion} motion samples · ${event.detail.midi} MIDI events`; });
capture.addEventListener('complete', event => { $('camera-preview').srcObject = null; show('camera-preview', false); $('capture-message').textContent = 'Take finished. Review it below.'; setCaptureControls(); setUploadControls(); keepDraft(event.detail).catch(handleError); });
action('upload-btn', 'click', uploadSelected);
action('cancel-upload-btn', 'click', () => uploadController?.abort());
action('backup-btn', 'click', () => { if (selected) download(backupBlob(selected), `${safeFilename(selected.label)}.saltar`); });
action('delete-draft-btn', 'click', async () => { if (!selected || !confirm('Delete this local draft and its files from this browser? Copies already uploaded to SALTA are kept.')) return; const id = selected.id; await store.delete(id); drafts = drafts.filter(d => d.id !== id); selected = null; stopPolling(); renderDrafts(); renderReview(); message('Local draft deleted.'); });
action('take-label', 'change', async () => { if (selected && !selected.manifest) { selected.label = $('take-label').value.trim() || 'Untitled take'; await persist(selected); } });
action('restore-file', 'change', async () => { if (uploading || ['recording', 'stopping'].includes(capture.state)) throw new Error('Finish the recording or upload before restoring a backup.'); const file = $('restore-file').files[0]; if (!file) return; const restored = await restoreBackup(file); if (uploading || ['recording', 'stopping'].includes(capture.state)) throw new Error('A recording or upload started while the backup was being read. Restore it after that finishes.'); if (drafts.some(d => d.id === restored.id)) throw new Error('This recording is already on this device. Open its existing draft.'); await keepDraft(restored); $('restore-file').value = ''; });
action('import-form', 'submit', async () => {
  if (['recording', 'stopping', 'preparing'].includes(capture.state) || uploading) throw new Error('Finish the active recording or upload before importing.');
  const file = $('import-file').files[0], kind = $('import-kind').value;
  if (!file || !KINDS.includes(kind)) throw new Error('Choose a file and its modality.');
  if (!file.size || file.size > LIMITS.captureBytes) throw new Error('Choose a nonempty file up to 64 MB.');
  const name = safeFilename(file.name), json = ['acceleration', 'midi_events'].includes(kind);
  let mime = json ? 'application/json' : file.type;
  if (json) { if (file.size > 16 * 1048576) throw new Error('Raw JSON files must be at most 16 MB.'); let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('The file is not readable JSON.'); } if (data.kind !== kind || data.schema_version !== 1 || data.clock !== 'performance' || data.time_unit !== 'seconds' || !Array.isArray(data[kind === 'acceleration' ? 'samples' : 'events'])) throw new Error('This file does not use the saltaR v1 JSON schema for the chosen modality.'); }
  if (!mime) mime = kind === 'video' ? (name.endsWith('.mov') ? 'video/quicktime' : name.endsWith('.mp4') ? 'video/mp4' : 'video/webm') : (name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm');
  if (uploading || ['recording', 'stopping', 'preparing'].includes(capture.state)) throw new Error('A recording or upload started while the file was being read. Import it after that finishes.');
  const started_at = new Date().toISOString();
  await keepDraft({id: uuid(), label: name, started_at, metadata: {client: 'saltaR', version: 1, imported: true, timing: 'Imported file: recording start time and alignment are unknown; offset is a placeholder, not measured synchronization.', interruptions: []}, streams: [{key: 'imported', kind, filename: name, mime_type: mime, offset_seconds: 0, started_at, metadata: {imported: true, original_last_modified: file.lastModified}, blob: file}]}); $('import-form').reset();
});
window.addEventListener('beforeunload', event => { if (['recording', 'stopping'].includes(capture.state) || uploading) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  disconnect(); clearPreviews();
  if (['ready', 'preparing'].includes(capture.state)) { capture.release(); $('camera-preview').srcObject = null; show('camera-preview', false); setCaptureControls(); }
});
async function init() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { document.querySelectorAll('input[name="av-mode"]').forEach(input => { if (input.value !== 'none') { input.disabled = true; input.dataset.unsupported = 'true'; } else input.checked = true; }); $('capture-message').textContent = 'Live audio/video recording is unavailable. Use HTTPS or import a file.'; }
  if (!window.DeviceMotionEvent || !window.isSecureContext) { $('motion-enabled').disabled = true; $('motion-enabled').dataset.unsupported = 'true'; $('motion-support').textContent = 'Device motion is unavailable in this browser.'; } else $('motion-support').textContent = 'Requires a device with motion sensors and permission.';
  if (!navigator.requestMIDIAccess || !window.isSecureContext) { for (const id of ['midi-enabled', 'midi-device', 'find-midi-btn']) { $(id).disabled = true; $(id).dataset.unsupported = 'true'; } $('midi-support').textContent = 'Web MIDI is unavailable here. Import a compatible JSON file instead.'; }
  try { drafts = await store.list(); renderDrafts(); if (drafts.length) selectDraft(drafts[0]); } catch (error) { $('storage-status').textContent = error.message; }
  setCaptureControls(); setUploadControls();
}
void init();

export const LIMITS = Object.freeze({ durationSeconds: 300, captureBytes: 64 * 1024 * 1024, records: 100000, drafts: 10 });
export const KINDS = ['audio', 'video', 'acceleration', 'midi_events'];
export const ACTIVE_JOBS = new Set(['pending', 'dispatching', 'queued', 'running']);

export function apiOrigin(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete SALTA address, such as https://salta.example.ac.at.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS for SALTA. HTTP is allowed only on localhost for development.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use only the SALTA origin, without a path, query, password, or fragment.');
  return url.origin;
}

export function analysisUrl(origin, fileId) {
  if (!Number.isSafeInteger(fileId) || fileId < 1) return null;
  return `${apiOrigin(origin)}/home/salta_analysis/?file=${fileId}`;
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const s = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function formatBytes(bytes) { return bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
export function formatTime(seconds) { const n = Math.max(0, Math.floor(seconds)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`; }
export function safeFilename(name) { return String(name).replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(-200) || 'capture'; }
export async function sha256(blob) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join(''); }

export function createManifest(draft, projectId, label) {
  if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error('Choose a SALTA project first.');
  const title = label.trim();
  if (!title || title.length > 120) throw new Error('Give this recording a name of 1–120 characters.');
  if (!draft.streams.length) throw new Error('There are no streams to upload.');
  return {
    project_id: projectId, client_id: draft.id, label: title, started_at: draft.started_at,
    metadata: draft.metadata,
    streams: draft.streams.map(({key, kind, filename, mime_type, started_at, offset_seconds, metadata}) => ({key, kind, filename, mime_type, started_at, offset_seconds, metadata}))
  };
}

export function hasActiveJobs(recording) { return recording?.streams?.some(s => ACTIVE_JOBS.has(s.processing?.status)); }

export function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || !/^[a-f0-9-]{36}$/i.test(draft.id) || !Array.isArray(draft.streams) || !draft.streams.length || draft.streams.length > 16) throw new Error('This is not a valid saltaR draft.');
  if (!Number.isFinite(Date.parse(draft.started_at)) || !draft.metadata || typeof draft.metadata !== 'object') throw new Error('The draft is missing its recording metadata.');
  const keys = new Set(); let total = 0;
  for (const stream of draft.streams) {
    if (!KINDS.includes(stream.kind) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stream.key) || keys.has(stream.key)) throw new Error('The draft has invalid or duplicate streams.');
    keys.add(stream.key);
    if (!(stream.blob instanceof Blob) || stream.filename !== safeFilename(stream.filename) || !Number.isFinite(stream.offset_seconds) || Math.abs(stream.offset_seconds) > 86400) throw new Error('The draft contains an invalid stream.');
    total += stream.blob.size;
  }
  if (total > LIMITS.captureBytes * 2) throw new Error('The draft exceeds the 128 MB restore limit.');
  if (draft.targetOrigin) apiOrigin(draft.targetOrigin);
  // Never accept credentials from a backup, even if manually added to one.
  for (const key of ['token', 'password', 'authorization']) if (key in draft) throw new Error('Backups must not contain credentials.');
  return draft;
}

const BACKUP_MAGIC = new TextEncoder().encode('SALTAR1\n');
export function backupBlob(draft) {
  validateDraft(draft);
  const {streams, ...fields} = draft;
  const header = new TextEncoder().encode(JSON.stringify({...fields, streams: streams.map(({blob, ...s}) => ({...s, size: blob.size}))}));
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, header.length);
  return new Blob([BACKUP_MAGIC, length, header, ...streams.map(s => s.blob)], {type: 'application/octet-stream'});
}

export async function restoreBackup(file) {
  if (file.size > LIMITS.captureBytes * 2 + 1048576) throw new Error('This backup exceeds the 128 MB restore limit.');
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (prefix.length !== 12 || !BACKUP_MAGIC.every((b, i) => prefix[i] === b)) throw new Error('Choose a saltaR .saltar backup.');
  const length = new DataView(prefix.buffer).getUint32(8);
  if (length > 1048576 || length + 12 > file.size) throw new Error('The backup header is invalid.');
  let draft;
  try { draft = JSON.parse(await file.slice(12, 12 + length).text()); } catch { throw new Error('The backup header could not be read.'); }
  if (!Array.isArray(draft.streams) || draft.streams.length > 16) throw new Error('The backup has invalid streams.');
  let offset = length + 12;
  draft.streams = draft.streams.map(({size, ...stream}) => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > file.size) throw new Error('The backup is incomplete.');
    const blob = file.slice(offset, offset + size, stream.mime_type); offset += size;
    return {...stream, blob};
  });
  if (offset !== file.size) throw new Error('The backup has unexpected trailing data.');
  return validateDraft(draft);
}

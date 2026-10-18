import {LIMITS, validateDraft} from './core.js';
const DATABASE = 'saltaR-drafts-v1';
export class DraftStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.db = null; }
  async open() {
    if (this.db) return this.db;
    if (!this.indexedDB) throw new Error('Local draft storage is unavailable. Download a backup before closing this page.');
    this.db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts', {keyPath: 'id'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Local draft storage could not be opened. Download a backup.'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }
  async transact(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode); const request = action(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(new Error('The draft could not be saved locally (storage may be full). Download a backup before leaving.'));
    });
  }
  async list() { const drafts = await this.transact('readonly', s => s.getAll()); return drafts.sort((a, b) => b.started_at.localeCompare(a.started_at)); }
  async put(draft) {
    validateDraft(draft);
    const existing = await this.list();
    if (!existing.some(d => d.id === draft.id) && existing.length >= LIMITS.drafts) throw new Error('Ten drafts are already stored. Back up and delete an older draft first.');
    const otherBytes = existing.filter(d => d.id !== draft.id).reduce((sum, d) => sum + d.streams.reduce((n, s) => n + s.blob.size, 0), 0);
    if (otherBytes + draft.streams.reduce((n, s) => n + s.blob.size, 0) > LIMITS.captureBytes * 2) throw new Error('Local drafts have reached the 128 MB storage limit. Back up and delete an older draft first.');
    return this.transact('readwrite', s => s.put(draft));
  }
  delete(id) { return this.transact('readwrite', s => s.delete(id)); }
}

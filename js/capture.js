import {LIMITS, uuid} from './core.js';

export function negotiateMime(kind, MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass) return null;
  const candidates = kind === 'video'
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  return candidates.find(type => MediaRecorderClass.isTypeSupported?.(type)) || '';
}
export function mediaExtension(type, kind) { return type.includes('mp4') ? (kind === 'audio' ? 'm4a' : 'mp4') : type.includes('ogg') ? 'ogg' : 'webm'; }
export function motionSample(event, t) {
  const axes = event.accelerationIncludingGravity;
  return {t, x: Number.isFinite(axes?.x) ? axes.x : null, y: Number.isFinite(axes?.y) ? axes.y : null, z: Number.isFinite(axes?.z) ? axes.z : null};
}
export function eventTime(event, start, now, previous = 0) {
  const stamp = event.timeStamp;
  const elapsed = (stamp - start) / 1000;
  if (Number.isFinite(stamp) && stamp > 0 && stamp <= now + 1 && stamp >= now - 60000 && elapsed >= previous) return {t: elapsed, basis: 'event_timestamp'};
  return {t: Math.max(previous, 0, (now - start) / 1000), basis: 'callback_fallback'};
}
export function validMidiMessage(bytes) {
  if (!bytes.length || !bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
  const s = bytes[0]; if (s < 128 || [240, 244, 245, 247, 249, 253].includes(s)) return false;
  const length = s < 240 ? ([192, 208].includes(s & 240) ? 2 : 3) : ({241: 2, 242: 3, 243: 2, 246: 1, 248: 1, 250: 1, 251: 1, 252: 1, 254: 1, 255: 1})[s];
  return length === bytes.length && bytes.slice(1).every(n => n < 128);
}

export class Capture extends EventTarget {
  constructor({navigatorObject = globalThis.navigator, windowObject = globalThis.window, documentObject = globalThis.document, now = () => performance.now(), mediaRecorderClass = globalThis.MediaRecorder} = {}) {
    super(); this.nav = navigatorObject; this.win = windowObject; this.doc = documentObject; this.now = now; this.Recorder = mediaRecorderClass;
    this.state = 'idle'; this.cleanups = []; this.media = null; this.midiAccess = null; this.generation = 0;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, {detail})); }
  async discoverMidi() {
    if (!this.nav.requestMIDIAccess) throw new Error('Web MIDI is unavailable in this browser. Import a file instead.');
    this.midiAccess = await this.nav.requestMIDIAccess({sysex: false});
    return [...this.midiAccess.inputs.values()];
  }
  async prepare(options) {
    if (this.state === 'recording' || this.state === 'stopping') throw new Error('Stop the current recording first.');
    this.release(); const generation = this.generation; this.options = {...options};
    if (options.mode === 'none' && !options.motion && !options.midi) throw new Error('Choose at least one recording source.');
    // Call permission immediately within the originating click, before any await.
    const motionPermission = options.motion && typeof this.win.DeviceMotionEvent?.requestPermission === 'function'
      ? this.win.DeviceMotionEvent.requestPermission() : Promise.resolve('granted');
    this.state = 'preparing';
    try {
      if (await motionPermission !== 'granted') throw new Error('Motion permission was not granted. Deselect motion or allow it and try again.');
      if (generation !== this.generation) throw new DOMException('Source setup cancelled.', 'AbortError');
      if (options.motion && !this.win.DeviceMotionEvent) throw new Error('Device motion is unavailable in this browser.');
      if (options.midi) {
        if (!this.midiAccess) await this.discoverMidi();
        if (generation !== this.generation) throw new DOMException('Source setup cancelled.', 'AbortError');
        const midiInput = this.midiAccess.inputs.get(options.midiId); this.midiInput = midiInput;
        if (!midiInput || midiInput.state === 'disconnected') throw new Error('Choose a connected MIDI input after selecting Find MIDI devices.');
        await midiInput.open();
        if (generation !== this.generation) { await midiInput.close(); throw new DOMException('Source setup cancelled.', 'AbortError'); }
      }
      if (options.mode !== 'none') {
        if (!this.nav.mediaDevices?.getUserMedia || !this.Recorder) throw new Error('Recording is unavailable here. Use HTTPS and a compatible browser, or import a file.');
        const media = await this.nav.mediaDevices.getUserMedia({audio: true, video: options.mode === 'video' ? {width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30, max: 30}, facingMode: 'environment'} : false});
        if (generation !== this.generation) { media.getTracks().forEach(track => track.stop()); throw new DOMException('Source setup cancelled.', 'AbortError'); }
        this.media = media;
      }
      this.state = 'ready'; this.emit('ready', {media: this.media});
    } catch (error) { if (generation === this.generation) this.release(); throw error; }
  }
  start() {
    if (this.state !== 'ready') throw new Error('Enable your selected sources first.');
    this.origin = this.now(); this.wallStart = Date.now(); this.interruptions = []; this.streams = []; this.bytes = 0; this.rawBytes = 0;
    this.motionSamples = []; this.midiEvents = []; this.droppedMidi = 0; this.stopReason = 'user'; this.state = 'recording';
    const source = (key, kind, mime) => {
      const start = this.now(); const offset = (start - this.origin) / 1000;
      const stream = {key, kind, mime_type: mime, filename: `${key}.${kind === 'audio' || kind === 'video' ? mediaExtension(mime, kind) : 'json'}`, started_at: new Date(this.wallStart + offset * 1000).toISOString(), offset_seconds: offset, metadata: {timestamp_basis: 'event.timeStamp on performance clock when plausible; performance.now callback fallback', callback_timestamp_fallbacks: 0}, start};
      this.streams.push(stream); return stream;
    };
    if (this.options.motion) {
      this.motionStream = source('motion', 'acceleration', 'application/json');
      const listener = event => {
        if (this.state !== 'recording') return;
        if (this.motionSamples.length >= LIMITS.records) { void this.stop('motion-record-limit'); return; }
        const timing = eventTime(event, this.motionStream.start, this.now(), this.motionSamples.at(-1)?.t || 0);
        if (timing.basis === 'callback_fallback') this.motionStream.metadata.callback_timestamp_fallbacks++;
        const sample = motionSample(event, timing.t);
        this.motionSamples.push(sample); this.rawBytes += JSON.stringify(sample).length + 1;
        if (this.bytes + this.rawBytes >= LIMITS.captureBytes - 2 * 1048576) void this.stop('size-limit');
      };
      this.win.addEventListener('devicemotion', listener); this.cleanups.push(() => this.win.removeEventListener('devicemotion', listener));
    }
    if (this.options.midi) {
      this.midiStream = source('midi', 'midi_events', 'application/json');
      this.midiStream.metadata.device = {name: this.midiInput.name || '', manufacturer: this.midiInput.manufacturer || '', id: this.midiInput.id};
      const listener = event => {
        if (this.state !== 'recording') return;
        const data = [...event.data];
        if (!validMidiMessage(data)) { this.droppedMidi++; return; }
        if (this.midiEvents.length >= LIMITS.records) { void this.stop('midi-record-limit'); return; }
        const timing = eventTime(event, this.midiStream.start, this.now(), this.midiEvents.at(-1)?.t || 0);
        if (timing.basis === 'callback_fallback') this.midiStream.metadata.callback_timestamp_fallbacks++;
        const item = {t: timing.t, data, input_id: this.midiInput.id};
        this.midiEvents.push(item); this.rawBytes += new TextEncoder().encode(JSON.stringify(item)).length + 1;
        if (this.bytes + this.rawBytes >= LIMITS.captureBytes - 2 * 1048576) void this.stop('size-limit');
      };
      const disconnected = () => { if (this.midiInput.state === 'disconnected') void this.stop('midi-disconnected'); };
      this.midiInput.addEventListener('midimessage', listener); this.midiInput.addEventListener('statechange', disconnected);
      this.cleanups.push(() => this.midiInput?.removeEventListener('midimessage', listener), () => this.midiInput?.removeEventListener('statechange', disconnected));
    }
    if (this.media) {
      const kind = this.options.mode, mimeType = negotiateMime(kind, this.Recorder); this.chunks = [];
      try { this.recorder = new this.Recorder(this.media, {...(mimeType ? {mimeType} : {}), audioBitsPerSecond: 128000, ...(kind === 'video' ? {videoBitsPerSecond: 2500000} : {})}); }
      catch (error) { this.release(); throw new Error(`The browser could not start ${kind} recording: ${error.message}`); }
      this.avStream = source(kind === 'video' ? 'camera' : 'microphone', kind, this.recorder.mimeType || mimeType);
      this.avStream.metadata.timestamp_basis = 'MediaRecorder start-event callback on performance clock; approximate first sample';
      this.avStream.metadata.track_settings = this.media.getTracks().map(track => ({kind: track.kind, settings: track.getSettings?.() || {}}));
      this.avStream.metadata.includes_audio = this.media.getAudioTracks().length > 0;
      this.recorder.onstart = () => {
        this.avStream.start = this.now(); this.avStream.offset_seconds = (this.avStream.start - this.origin) / 1000;
        this.avStream.started_at = new Date(this.wallStart + this.avStream.offset_seconds * 1000).toISOString();
      };
      this.recorder.ondataavailable = event => { if (event.data.size) { this.chunks.push(event.data); this.bytes += event.data.size; } if (this.bytes + this.rawBytes >= LIMITS.captureBytes - 2 * 1048576 && this.state === 'recording') void this.stop('size-limit'); };
      this.recorder.onerror = event => { this.interruptions.push({type: 'media-error', at_seconds: (this.now() - this.origin) / 1000, message: event.error?.message || 'MediaRecorder error'}); void this.stop('media-error'); };
      this.avDone = new Promise(resolve => { this.recorder.onstop = () => { resolve(); if (this.state === 'recording') void this.stop('media-recorder-stopped'); }; });
      this.media.getTracks().forEach(track => {
        const ended = () => void this.stop('media-track-ended');
        const muted = () => this.interruptions.push({type: `${track.kind}-muted`, at_seconds: (this.now() - this.origin) / 1000});
        const unmuted = () => this.interruptions.push({type: `${track.kind}-unmuted`, at_seconds: (this.now() - this.origin) / 1000});
        track.addEventListener('ended', ended); track.addEventListener('mute', muted); track.addEventListener('unmute', unmuted);
        this.cleanups.push(() => { track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); track.removeEventListener('unmute', unmuted); });
      });
      try { this.recorder.start(1000); this.recorderStarted = true; } catch (error) { this.release(); throw error; }
    }
    const visibility = () => { if (this.doc.hidden) void this.stop('page-hidden'); };
    const pagehide = () => void this.stop('page-left');
    this.doc.addEventListener('visibilitychange', visibility); this.win.addEventListener('pagehide', pagehide);
    this.cleanups.push(() => this.doc.removeEventListener('visibilitychange', visibility), () => this.win.removeEventListener('pagehide', pagehide));
    this.timer = setInterval(() => {
      const duration = (this.now() - this.origin) / 1000;
      this.emit('tick', {duration, bytes: this.bytes + this.rawBytes, motion: this.motionSamples.length, midi: this.midiEvents.length});
      if (duration >= LIMITS.durationSeconds) void this.stop('duration-limit');
    }, 250);
    this.emit('start', {});
  }
  stop(reason = 'user') {
    if (this.state === 'stopping') return this.stopPromise;
    if (this.state !== 'recording') return Promise.resolve(null);
    this.state = 'stopping'; this.stopReason = reason;
    this.stopPromise = this.finish(reason); return this.stopPromise;
  }
  async finish(reason) {
    const duration = (this.now() - this.origin) / 1000;
    if (reason !== 'user') this.interruptions.push({type: reason, at_seconds: duration});
    clearInterval(this.timer); this.cleanups.splice(0).forEach(fn => fn());
    if (this.recorder && this.recorderStarted) {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      // Even an inactive recorder can still have its final data/stop events queued.
      await this.avDone;
    }
    if (this.avStream) {
      const mime = this.recorder.mimeType || this.chunks[0]?.type || this.avStream.mime_type;
      this.avStream.mime_type = mime; this.avStream.filename = `${this.avStream.key}.${mediaExtension(mime, this.avStream.kind)}`;
      this.avStream.blob = new Blob(this.chunks, {type: mime}); this.chunks = [];
    }
    if (this.motionStream) { this.motionStream.blob = new Blob([JSON.stringify({schema_version: 1, kind: 'acceleration', time_unit: 'seconds', clock: 'performance', units: 'm/s^2', coordinate_frame: 'device', includes_gravity: true, samples: this.motionSamples})], {type: 'application/json'}); this.motionStream.metadata.sample_count = this.motionSamples.length; this.motionStream.metadata.observed_axis_samples = this.motionSamples.filter(s => [s.x, s.y, s.z].some(Number.isFinite)).length; }
    if (this.midiStream) { this.midiStream.blob = new Blob([JSON.stringify({schema_version: 1, kind: 'midi_events', time_unit: 'seconds', clock: 'performance', events: this.midiEvents})], {type: 'application/json'}); this.midiStream.metadata.ignored_invalid_or_sysex_messages = this.droppedMidi; this.midiStream.metadata.event_count = this.midiEvents.length; }
    const streams = this.streams.map(({start, ...stream}) => ({...stream, metadata: {...stream.metadata, duration_seconds: Math.max(0, (this.origin + duration * 1000 - start) / 1000)}}));
    const draft = {id: uuid(), label: `Take ${new Date(this.wallStart).toLocaleString()}`, started_at: new Date(this.wallStart).toISOString(), metadata: {client: 'saltaR', version: 1, clock: 'performance', performance_time_origin: performance.timeOrigin, timing: 'Approximate browser timing: event timestamps for sensors/MIDI when valid, recorder start callback for media; not hardware synchronization.', duration_seconds: duration, interruptions: this.interruptions, stop_reason: reason}, streams};
    this.motionSamples = []; this.midiEvents = []; this.release(); this.emit('complete', draft); return draft;
  }
  release() {
    this.generation++;
    clearInterval(this.timer); this.cleanups.splice(0).forEach(fn => fn());
    this.media?.getTracks().forEach(track => track.stop()); this.media = null;
    if (this.midiInput) { void this.midiInput.close()?.catch?.(() => {}); this.midiInput = null; }
    this.recorder = null; this.recorderStarted = false; this.avStream = null; this.motionStream = null; this.midiStream = null; this.state = 'idle';
  }
}

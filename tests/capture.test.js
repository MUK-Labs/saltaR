import test from 'node:test';
import assert from 'node:assert/strict';
import {Capture, negotiateMime, motionSample, validMidiMessage, eventTime} from '../js/capture.js';

function setup(Recorder, {getUserMedia} = {}) {
  const track = new EventTarget(); track.kind = 'audio'; track.stop = () => { track.stopped = true; }; track.getSettings = () => ({sampleRate: 48000});
  const media = {getTracks: () => [track], getAudioTracks: () => [track]};
  const win = new EventTarget(); win.DeviceMotionEvent = class {};
  const doc = new EventTarget(); doc.hidden = false;
  const capture = new Capture({navigatorObject: {mediaDevices: {getUserMedia: getUserMedia || (async () => media)}}, windowObject: win, documentObject: doc, now: () => 1000, mediaRecorderClass: Recorder});
  return {capture, media, track, win, doc};
}
class Recorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
  start() { this.state = 'recording'; this.onstart?.(); }
  stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({data: new Blob(['final'])}); this.onstop(); }); }
}
test('runtime MIME negotiation uses supported types and permits browser default', () => {
  assert.equal(negotiateMime('audio', Recorder), 'audio/webm;codecs=opus'); assert.equal(negotiateMime('video', Recorder), ''); assert.equal(negotiateMime('video', null), null);
});
test('motion preserves missing axes and MIDI rejects SysEx/malformed messages', () => {
  assert.deepEqual(motionSample({accelerationIncludingGravity: {x: 1, y: null, z: NaN}}, .2), {t: .2, x: 1, y: null, z: null});
  for (const data of [[144, 60, 100], [192, 3], [248], [242, 1, 2]]) assert.equal(validMidiMessage(data), true);
  for (const data of [[240, 1, 247], [144, 60], [144, 255, 1], [60, 1, 2], [249], [253]]) assert.equal(validMidiMessage(data), false);
});
test('event timestamps reduce callback jitter and epoch/regressing timestamps fall back explicitly', () => {
  assert.deepEqual(eventTime({timeStamp: 1200}, 1000, 1250), {t: .2, basis: 'event_timestamp'});
  assert.deepEqual(eventTime({timeStamp: Date.now()}, 1000, 1250), {t: .25, basis: 'callback_fallback'});
  assert.equal(eventTime({timeStamp: 1100}, 1000, 1250, .2).basis, 'callback_fallback');
});
test('normal stop includes final chunk and releases tracks', async () => {
  const {capture, track} = setup(Recorder); await capture.prepare({mode: 'audio'}); capture.start(); const draft = await capture.stop();
  assert.equal(await draft.streams[0].blob.text(), 'final'); assert.equal(track.stopped, true); assert.equal(capture.state, 'idle');
});
test('inactive recorder error still waits for queued final data and stop', async () => {
  const {capture} = setup(Recorder); await capture.prepare({mode: 'audio'}); capture.start(); const recorder = capture.recorder;
  recorder.state = 'inactive'; const pending = capture.stop('media-error'); let completed = false; pending.then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  recorder.ondataavailable({data: new Blob(['last packet'])}); recorder.onstop(); const draft = await pending;
  assert.equal(await draft.streams[0].blob.text(), 'last packet'); assert.equal(draft.metadata.stop_reason, 'media-error');
});
test('automatic recorder stop saves once with interruption metadata', async () => {
  const {capture} = setup(Recorder); await capture.prepare({mode: 'audio'}); capture.start();
  const finished = new Promise(resolve => capture.addEventListener('complete', e => resolve(e.detail), {once: true}));
  capture.recorder.state = 'inactive'; capture.recorder.ondataavailable({data: new Blob(['auto'])}); capture.recorder.onstop();
  const draft = await finished; assert.equal(await draft.streams[0].blob.text(), 'auto'); assert.equal(draft.metadata.stop_reason, 'media-recorder-stopped');
});
test('cancelled permission setup stops a late granted media stream', async () => {
  let grant; const {capture, media, track} = setup(Recorder, {getUserMedia: () => new Promise(resolve => { grant = resolve; })});
  const pending = capture.prepare({mode: 'audio'}); await Promise.resolve(); capture.release(); grant(media);
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(track.stopped, true); assert.equal(capture.media, null); assert.equal(capture.state, 'idle');
});
test('quiet motion recording retains an empty stream with visible diagnostic metadata', async () => {
  const {capture} = setup(Recorder); await capture.prepare({mode: 'none', motion: true}); capture.start(); const draft = await capture.stop();
  assert.equal(draft.streams[0].metadata.sample_count, 0); assert.equal(draft.streams[0].metadata.observed_axis_samples, 0);
  assert.deepEqual(JSON.parse(await draft.streams[0].blob.text()).samples, []);
});

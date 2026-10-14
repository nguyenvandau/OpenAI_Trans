import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LIVE_TRANSCRIPTION_MODEL, LiveTranscriber, liveTranscriptionSessionUpdate } from '../live-transcriber.mjs';

const FRAME_BYTES = 9600;
const profiles = {
  en: { model: LIVE_TRANSCRIPTION_MODEL, prompt: 'Medical conference about fertility.', keywords: ['IVF', 'embryo transfer'], languages: ['en'], delay: 'medium' },
  vi: { model: LIVE_TRANSCRIPTION_MODEL, prompt: 'Hội nghị y học sinh sản.', keywords: ['IVF', 'chuyển phôi'], languages: ['vi', 'en'], delay: 'medium' },
};

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

function createTranscriber(t, targetLanguage = 'vi') {
  const socket = new FakeSocket();
  let connection;
  const transcriber = new LiveTranscriber({
    apiKey: 'test-only', targetLanguage, profiles,
    createSocket: (url, options) => { connection = { url, options }; return socket; },
  });
  t.after(() => transcriber.close());
  const acknowledge = () => transcriber.handleEvent({
    type: 'session.updated', session: { audio: { input: { transcription: { model: LIVE_TRANSCRIPTION_MODEL } } } },
  });
  return { transcriber, socket, connection, acknowledge };
}
const appends = socket => socket.sent.filter(event => event.type === 'input_audio_buffer.append');
const commits = socket => socket.sent.filter(event => event.type === 'input_audio_buffer.commit');
const bytes = event => Buffer.from(event.audio, 'base64');
function speechFrame(sample = 1200) {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(sample, offset);
  return frame;
}
function committed(transcriber, item, previous = null) {
  transcriber.handleEvent({ type: 'input_audio_buffer.committed', item_id: item, previous_item_id: previous });
}
function completed(transcriber, item, transcript) {
  transcriber.handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript });
}
function delta(transcriber, item, text) {
  transcriber.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: item, delta: text });
}

test('caption connection uses the correct source profile and has no audio response configuration', t => {
  for (const targetLanguage of ['vi', 'en']) {
    const { transcriber, socket, connection, acknowledge } = createTranscriber(t, targetLanguage);
    assert.equal(connection.url, 'wss://api.openai.com/v1/realtime?intent=transcription');
    socket.open();
    const input = socket.sent[0].session.audio.input;
    assert.equal(socket.sent[0].session.type, 'transcription');
    assert.deepEqual(input.format, { type: 'audio/pcm', rate: 24000 });
    assert.equal(input.turn_detection, null);
    assert.equal(input.transcription.model, LIVE_TRANSCRIPTION_MODEL);
    assert.deepEqual(input.transcription.keywords, targetLanguage === 'vi' ? ['IVF', 'embryo transfer'] : ['IVF', 'chuyển phôi']);
    assert.deepEqual(input.transcription.languages, targetLanguage === 'vi' ? ['en'] : ['vi', 'en']);
    assert.equal(input.transcription.delay, 'medium');
    assert.equal(transcriber.ready, false);
    assert.equal(socket.sent[0].session.audio.output, undefined);
    acknowledge();
    assert.equal(transcriber.ready, true);
  }
  assert.throws(() => liveTranscriptionSessionUpdate({ targetLanguage: 'auto', profiles }), RangeError);
  assert.equal(profiles.en.prompt, 'Medical conference about fertility.', 'Configuration must not mutate the supplied profiles');
});

test('startup buffering preserves the first words, silence and arbitrary microphone chunk boundaries', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  const input = Buffer.concat([speechFrame(), Buffer.alloc(FRAME_BYTES), Buffer.alloc(420, 3)]);
  transcriber.appendAudio(input.subarray(0, 3100));
  socket.open();
  transcriber.appendAudio(input.subarray(3100));
  assert.equal(appends(socket).length, 0);
  acknowledge();
  assert.deepEqual(Buffer.concat(appends(socket).map(bytes)), input.subarray(0, FRAME_BYTES * 2));
  assert.equal(commits(socket).length, 0);
  transcriber.finish();
  const tail = bytes(appends(socket).at(-1));
  assert.deepEqual(tail.subarray(0, 420), input.subarray(FRAME_BYTES * 2));
  assert.ok(tail.subarray(420).every(value => value === 0));
  assert.equal(commits(socket).length, 1);
});

test('source deltas stream before any commit and preserve partial words and repetitions exactly', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  const captions = [], audio = [];
  transcriber.on('source_delta', event => captions.push(event));
  transcriber.on('audio', event => audio.push(event));
  for (let frame = 0; frame < 8; frame++) {
    transcriber.appendAudio(speechFrame());
    if (frame === 2) { delta(transcriber, 'a', 'emb'); delta(transcriber, 'a', 'ryo'); delta(transcriber, 'a', ' embryo'); }
  }
  assert.equal(captions.map(event => event.delta).join(''), 'embryo embryo');
  assert.equal(new Set(captions.map(event => event.itemId)).size, 1);
  assert.equal(captions[0].targetLanguage, 'vi');
  assert.equal(appends(socket).length, 8);
  assert.equal(commits(socket).length, 0);
  assert.equal(audio.length, 0);
  assert.ok(socket.sent.every(event => ['session.update', 'input_audio_buffer.append'].includes(event.type)));
});

test('caption-only turn finalisation forwards every silence frame and finalises once after a pause', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  transcriber.appendAudio(speechFrame());
  for (let frame = 0; frame < 3; frame++) transcriber.appendAudio(Buffer.alloc(FRAME_BYTES));
  assert.equal(commits(socket).length, 1);
  for (let frame = 0; frame < 5; frame++) transcriber.appendAudio(Buffer.alloc(FRAME_BYTES));
  assert.equal(appends(socket).length, 9);
  assert.equal(commits(socket).length, 1, 'A quiet microphone must not produce repeated 600 ms commits');
  assert.deepEqual(bytes(appends(socket)[1]), Buffer.alloc(FRAME_BYTES));
});

test('continuous speech is bounded at 30 seconds without dropping a single PCM frame', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  const frame = speechFrame();
  transcriber.appendAudio(Buffer.concat(Array.from({ length: 151 }, () => frame)));
  assert.equal(appends(socket).length, 151);
  assert.equal(commits(socket).length, 1);
  assert.equal(transcriber.turnBytes, FRAME_BYTES);
  assert.deepEqual(Buffer.concat(appends(socket).map(bytes)), Buffer.concat(Array.from({ length: 151 }, () => frame)));
});

test('commit IDs establish source order while out-of-order finals replace their own partials', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  const turns = [], finals = [];
  transcriber.on('source_turn', event => turns.push(event));
  transcriber.on('source_transcript', event => finals.push(event));
  transcriber.appendAudio(Buffer.concat([speechFrame(), Buffer.alloc(FRAME_BYTES * 3)]));
  delta(transcriber, 'a', 'Partial A'); committed(transcriber, 'a');
  transcriber.appendAudio(Buffer.concat([speechFrame(), Buffer.alloc(FRAME_BYTES * 3)]));
  delta(transcriber, 'b', 'Partial B'); committed(transcriber, 'b', 'a');
  completed(transcriber, 'b', 'Final B'); completed(transcriber, 'a', 'Final A');
  assert.equal(turns.at(-1).previousItemId, turns[0].itemId);
  assert.deepEqual(finals.map(event => event.text), ['Final B', 'Final A']);
  assert.equal(finals[0].itemId, turns.at(-1).itemId);
  assert.equal(finals[1].itemId, turns[0].itemId);
  assert.equal(transcriber.pendingItems.size, 0);
  delta(transcriber, 'a', ' late duplicate'); completed(transcriber, 'a', 'duplicate');
  assert.equal(finals.length, 2);
});

test('caption source IDs cannot collide when the API reuses an item ID in another conference', t => {
  const first = createTranscriber(t), second = createTranscriber(t);
  const ids = [];
  for (const { transcriber, socket, acknowledge } of [first, second]) {
    transcriber.on('source_delta', event => ids.push(event.itemId));
    socket.open(); acknowledge(); delta(transcriber, 'same-api-id', 'IVF');
  }
  assert.notEqual(ids[0], ids[1]);
});

test('Stop waits for both commit acknowledgements and final captions, preserving the last fragment', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  const finals = [], closed = [];
  transcriber.on('source_transcript', event => finals.push(event));
  transcriber.on('closed', event => closed.push(event));
  transcriber.appendAudio(speechFrame()); delta(transcriber, 'tail', 'Last frag');
  transcriber.finish(); transcriber.finish();
  transcriber.appendAudio(speechFrame(3000));
  assert.equal(appends(socket).length, 1);
  assert.equal(commits(socket).length, 1);
  assert.equal(socket.readyState, 1);
  delta(transcriber, 'tail', 'ment');
  committed(transcriber, 'tail');
  assert.equal(transcriber.closed, false);
  completed(transcriber, 'tail', 'Last fragment.');
  assert.deepEqual(finals.map(event => event.text), ['Last fragment.']);
  assert.deepEqual(closed, [{ drained: true }]);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent.some(event => event.type === 'session.close'), false);
});

test('a final received before its commit acknowledgement cannot close the session prematurely', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  transcriber.appendAudio(speechFrame());
  transcriber.finish(); completed(transcriber, 'tail', 'Tail.');
  assert.equal(transcriber.closed, false);
  committed(transcriber, 'tail');
  assert.equal(transcriber.closed, true);
});

test('Stop during startup flushes buffered PCM after configuration and avoids an empty final commit', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  transcriber.appendAudio(Buffer.alloc(1400, 2));
  transcriber.finish(); socket.open(); acknowledge();
  assert.equal(appends(socket).length, 1);
  assert.equal(commits(socket).length, 1);
  assert.equal(transcriber.closed, false);
  committed(transcriber, 'last'); completed(transcriber, 'last', 'Last.');
  assert.equal(transcriber.closed, true);

  const empty = createTranscriber(t);
  empty.socket.open(); empty.acknowledge(); empty.transcriber.finish();
  assert.equal(commits(empty.socket).length, 0);
  assert.equal(empty.transcriber.closed, true);
});

test('language updates affect only future source turns after configuration acknowledgements', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open();
  transcriber.setTargetLanguage('en');
  acknowledge();
  assert.equal(transcriber.activeTargetLanguage, 'vi', 'The first ACK belongs to the original EN source profile');
  transcriber.appendAudio(speechFrame());
  const captions = [];
  transcriber.on('source_delta', event => captions.push(event));
  delta(transcriber, 'old', 'Earlier');
  acknowledge();
  assert.equal(transcriber.activeTargetLanguage, 'en');
  transcriber.appendAudio(Buffer.alloc(FRAME_BYTES * 3)); committed(transcriber, 'old');
  transcriber.appendAudio(speechFrame()); delta(transcriber, 'new', 'Sau đó');
  completed(transcriber, 'old', 'Earlier.');
  assert.equal(captions[0].targetLanguage, 'vi');
  assert.equal(captions[1].targetLanguage, 'en');
  const input = socket.sent.filter(event => event.type === 'session.update').at(-1).session.audio.input;
  assert.deepEqual(input.transcription.keywords, ['IVF', 'chuyển phôi']);
  assert.deepEqual(input.transcription.languages, ['vi', 'en']);
  const count = socket.sent.length;
  assert.equal(transcriber.setTargetLanguage('auto'), false);
  assert.equal(socket.sent.length, count);
});

test('a failed ASR item retains its partial and drains with a warning without fabricating a final', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  const warnings = [], finals = [];
  transcriber.on('warning', message => warnings.push(message));
  transcriber.on('source_transcript', event => finals.push(event));
  transcriber.appendAudio(speechFrame()); delta(transcriber, 'failed', 'Original partial');
  transcriber.finish(); committed(transcriber, 'failed');
  transcriber.handleEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'failed', error: { message: 'ASR failed' } });
  assert.deepEqual(warnings, ['ASR failed']);
  assert.deepEqual(finals, []);
  assert.equal(transcriber.closed, true);
});

test('unsupported delay retries configuration once while retaining startup audio', t => {
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); transcriber.appendAudio(speechFrame());
  const warnings = [], faults = [];
  transcriber.on('warning', message => warnings.push(message));
  transcriber.on('fault', message => faults.push(message));
  const error = { type: 'error', error: { param: 'session.audio.input.transcription.delay', message: 'Unknown parameter: delay' } };
  transcriber.handleEvent(error);
  assert.equal(socket.sent[1].session.audio.input.transcription.delay, undefined);
  assert.equal(transcriber.closed, false);
  assert.equal(warnings.length, 1);
  acknowledge();
  assert.equal(appends(socket).length, 1);
  transcriber.handleEvent(error);
  assert.equal(transcriber.closed, true);
  assert.equal(faults.length, 1);
});

test('caption transport faults, invalid PCM and startup overflow fail visibly without speech output', t => {
  for (const input of [Buffer.alloc(3), Buffer.alloc(24000 * 2 * 20 + 2)]) {
    const { transcriber } = createTranscriber(t);
    let fault;
    transcriber.on('fault', message => fault = message);
    transcriber.appendAudio(input);
    assert.ok(fault);
    assert.equal(transcriber.closed, true);
    assert.equal(transcriber.pendingAudio.length, 0);
  }
  const { transcriber, socket, acknowledge } = createTranscriber(t);
  socket.open(); acknowledge();
  const faults = [], audio = [];
  transcriber.on('fault', message => faults.push(message));
  transcriber.on('audio', value => audio.push(value));
  transcriber.handleEvent({ type: 'response.output_audio.delta', delta: Buffer.alloc(40).toString('base64') });
  socket.close();
  assert.equal(faults.length, 1);
  assert.equal(audio.length, 0);
  assert.equal(transcriber.closed, true);
});

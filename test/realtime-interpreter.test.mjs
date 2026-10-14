import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RealtimeInterpreter, AUDIO_FRAME_BYTES, sessionUpdate } from '../realtime-interpreter.mjs';

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

function createInterpreter(t, language = 'vi') {
  const socket = new FakeSocket();
  let connection;
  const interpreter = new RealtimeInterpreter({
    apiKey: 'test-only', targetLanguage: language,
    createSocket: (url, options) => { connection = { url, options }; return socket; },
  });
  t.after(() => interpreter.close());
  const acknowledge = (target = language) => interpreter.handleEvent({
    type: 'session.updated', session: { audio: { output: { language: target } } },
  });
  return { interpreter, socket, connection, acknowledge };
}
const appends = socket => socket.sent.filter(event => event.type === 'session.input_audio_buffer.append');
const bytes = event => Buffer.from(event.audio, 'base64');

test('dedicated translation endpoint configures both directions without conversation/voice/VAD parameters', t => {
  for (const language of ['vi', 'en']) {
    const { interpreter, socket, connection, acknowledge } = createInterpreter(t, language);
    assert.equal(connection.url, 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate');
    socket.open();
    assert.deepEqual(socket.sent, [{
      type: 'session.update',
      session: { audio: { input: { transcription: { model: 'gpt-realtime-whisper' }, noise_reduction: null }, output: { language } } },
    }]);
    assert.equal(interpreter.ready, false);
    acknowledge();
    assert.equal(interpreter.ready, true);
  }
  assert.throws(() => sessionUpdate({ targetLanguage: 'auto' }), RangeError);
  assert.deepEqual(sessionUpdate({ noiseReduction: { type: 'near_field' } }).session.audio.input.noise_reduction, { type: 'near_field' });
});

test('buffers first words until configuration is acknowledged, preserving byte order across frames', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  const input = Buffer.alloc(AUDIO_FRAME_BYTES * 2 + 320);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  interpreter.appendAudio(input.subarray(0, 5000));
  socket.open();
  interpreter.appendAudio(input.subarray(5000));
  assert.equal(appends(socket).length, 0);
  acknowledge();
  assert.deepEqual(Buffer.concat(appends(socket).map(bytes)), input.subarray(0, AUDIO_FRAME_BYTES * 2));
  assert.equal(appends(socket).length, 2);
  interpreter.finish();
  const tail = bytes(appends(socket).at(-1));
  assert.deepEqual(tail.subarray(0, 320), input.subarray(AUDIO_FRAME_BYTES * 2));
  assert.ok(tail.subarray(320).every(value => value === 0));
  assert.equal(socket.sent.at(-1).type, 'session.close');
});

test('streams translation during continuing microphone audio without a pause, commit, source transcript or response request', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  socket.open(); acknowledge();
  const audio = [], captions = [];
  interpreter.on('audio', value => audio.push(value));
  interpreter.on('target_delta', value => captions.push(value));
  for (let i = 0; i < 12; i++) {
    interpreter.appendAudio(Buffer.alloc(AUDIO_FRAME_BYTES, i));
    if (i === 2) {
      interpreter.handleEvent({ type: 'session.output_audio.delta', delta: Buffer.alloc(6000, 8).toString('base64'), sample_rate: 24000, channels: 1, format: 'pcm16' });
      interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: 'Bản dịch đang tiếp tục.', elapsed_ms: 600 });
      assert.equal(audio.length, 1);
      assert.equal(captions.length, 1);
      assert.equal(interpreter.closing, false);
    }
  }
  assert.equal(appends(socket).length, 12);
  assert.ok(socket.sent.every(event => ['session.update', 'session.input_audio_buffer.append'].includes(event.type)));
  assert.ok(bytes(appends(socket)[0]).every(value => value === 0), 'Silence also reaches the streaming model');
});

test('handles variable output audio sizes and independent partial-word captions sharing a timestamp', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  socket.open(); acknowledge();
  const audio = [], source = [], target = [];
  interpreter.on('audio', value => audio.push(value));
  interpreter.on('source_delta', value => source.push(value));
  interpreter.on('target_delta', value => target.push(value));
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: 'Chúng', elapsed_ms: 400 });
  interpreter.handleEvent({ type: 'session.input_transcript.delta', delta: 'treat', elapsed_ms: 400 });
  interpreter.handleEvent({ type: 'session.input_transcript.delta', delta: 'ment', elapsed_ms: 400 });
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: ' tôi', elapsed_ms: 400 });
  for (const size of [2, 9600, 14400]) interpreter.handleEvent({ type: 'session.output_audio.delta', delta: Buffer.alloc(size).toString('base64') });
  assert.equal(source.map(event => event.delta).join(''), 'treatment');
  assert.equal(target.map(event => event.delta).join(''), 'Chúng tôi');
  assert.equal(source[0].itemId, target[0].itemId);
  assert.deepEqual(audio.map(value => value.length), [2, 9600, 14400]);
});

test('language switch is acknowledged before captions change column; audio continues on the same socket', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  socket.open(); acknowledge();
  let readyEvents = 0;
  const target = [];
  interpreter.on('ready', () => readyEvents++);
  interpreter.on('target_delta', event => target.push(event));
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: 'Trước' });
  assert.equal(interpreter.setTargetLanguage('en'), true);
  interpreter.appendAudio(Buffer.alloc(AUDIO_FRAME_BYTES));
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: ' khi đổi.' });
  assert.equal(target.at(-1).targetLanguage, 'vi');
  acknowledge('en');
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: 'After switching.' });
  assert.equal(target.at(-1).targetLanguage, 'en');
  assert.notEqual(target[0].itemId, target.at(-1).itemId);
  assert.equal(readyEvents, 0);
  assert.equal(socket.readyState, 1);
  const sent = socket.sent.length;
  assert.equal(interpreter.setTargetLanguage('auto'), false);
  assert.equal(socket.sent.length, sent);
});

test('Stop drains final captions and audio before closing the WebSocket, and rejects further microphone input', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  socket.open(); acknowledge();
  const audio = [], target = [], closed = [];
  interpreter.on('audio', event => audio.push(event));
  interpreter.on('target_delta', event => target.push(event));
  interpreter.on('closed', event => closed.push(event));
  interpreter.appendAudio(Buffer.alloc(1000, 4));
  interpreter.finish();
  interpreter.finish();
  interpreter.appendAudio(Buffer.alloc(AUDIO_FRAME_BYTES, 9));
  assert.equal(socket.sent.filter(event => event.type === 'session.close').length, 1);
  assert.equal(appends(socket).length, 1);
  assert.equal(socket.readyState, 1);
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: 'phần cuối.' });
  interpreter.handleEvent({ type: 'session.output_audio.delta', delta: Buffer.alloc(1000, 5).toString('base64') });
  assert.equal(target.length, 1);
  assert.equal(audio.length, 1);
  assert.equal(closed.length, 0);
  interpreter.handleEvent({ type: 'session.closed' });
  assert.deepEqual(closed, [{ drained: true }]);
  assert.equal(socket.readyState, 3);
  interpreter.handleEvent({ type: 'session.output_transcript.delta', delta: 'must be ignored' });
  assert.equal(target.length, 1);
});

test('Stop during startup flushes buffered input after configuration, then drains normally', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  interpreter.appendAudio(Buffer.alloc(AUDIO_FRAME_BYTES + 24, 3));
  interpreter.finish();
  socket.open();
  assert.equal(socket.sent.length, 1);
  acknowledge();
  assert.equal(appends(socket).length, 2);
  assert.equal(socket.sent.at(-1).type, 'session.close');
  assert.equal(interpreter.closed, false);
  interpreter.handleEvent({ type: 'session.closed' });
  assert.equal(interpreter.closed, true);
});

test('reports a dropped final connection and prevents incompatible PCM from reaching listeners', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  socket.open(); acknowledge();
  let fault = '';
  interpreter.on('fault', message => fault = message);
  interpreter.finish(); socket.close();
  assert.match(fault, /trước khi hoàn tất/);
  assert.equal(interpreter.closed, true);

  const other = createInterpreter(t);
  other.socket.open(); other.acknowledge();
  let audioEvents = 0;
  other.interpreter.on('audio', () => audioEvents++);
  other.interpreter.handleEvent({ type: 'session.output_audio.delta', delta: 'AAAA', sample_rate: 48000 });
  assert.equal(other.interpreter.closed, true);
  assert.equal(audioEvents, 0);
});

test('server-initiated session closure is reported separately from a successfully drained Stop', t => {
  const { interpreter, socket, acknowledge } = createInterpreter(t);
  socket.open(); acknowledge();
  let result;
  interpreter.on('closed', event => result = event);
  interpreter.handleEvent({ type: 'session.closed' });
  assert.deepEqual(result, { drained: false });
  assert.equal(interpreter.closed, true);
});

test('fails visibly instead of silently dropping an oversized startup buffer or malformed input', t => {
  for (const input of [Buffer.alloc(24000 * 2 * 20 + 2), Buffer.alloc(3)]) {
    const { interpreter } = createInterpreter(t);
    let fault = '';
    interpreter.on('fault', value => fault = value);
    interpreter.appendAudio(input);
    assert.ok(fault);
    assert.equal(interpreter.closed, true);
    assert.equal(interpreter.pendingAudio.length, 0);
  }
});

test('external source captions disable native transcription; fallback preserves continuous translation audio', t => {
  const socket = new FakeSocket();
  const interpreter = new RealtimeInterpreter({ apiKey: 'test-only', sourceTranscription: false, createSocket: () => socket });
  t.after(() => interpreter.close());
  const source = [], audio = [];
  interpreter.on('source_delta', caption => source.push(caption));
  interpreter.on('audio', chunk => audio.push(chunk));
  socket.open();
  assert.equal(socket.sent[0].session.audio.input.transcription, null);
  interpreter.handleEvent({ type: 'session.updated', session: { audio: { output: { language: 'vi' } } } });
  interpreter.handleEvent({ type: 'session.input_transcript.delta', delta: 'Native text must not duplicate the separate ASR.' });
  assert.equal(source.length, 0);
  interpreter.appendAudio(Buffer.alloc(AUDIO_FRAME_BYTES, 5));
  assert.equal(interpreter.setSourceTranscription(true), true);
  assert.deepEqual(socket.sent.at(-1).session.audio.input.transcription, { model: 'gpt-realtime-whisper' });
  interpreter.appendAudio(Buffer.alloc(AUDIO_FRAME_BYTES, 6));
  interpreter.handleEvent({ type: 'session.output_audio.delta', delta: Buffer.alloc(9600).toString('base64') });
  interpreter.handleEvent({ type: 'session.input_transcript.delta', delta: 'Words that were spoken.' });
  assert.equal(source[0].delta, 'Words that were spoken.');
  assert.equal(audio.length, 1);
  assert.equal(appends(socket).length, 2);
  assert.equal(socket.readyState, 1);
  assert.ok(!socket.sent.some(event => event.type === 'session.close'));
});

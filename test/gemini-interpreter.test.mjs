import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  GeminiInterpreter, GEMINI_FRAME_BYTES, GEMINI_LIVE_URL, GEMINI_TRANSLATE_MODEL, ROLLOVER_AFTER_MS, DRAIN_IDLE_MS,
  Pcm16Resampler, describeGeminiFailure, geminiSetup,
} from '../gemini-interpreter.mjs';
import { loadConferenceGlossary, transcriptionProfile } from '../conference-glossary.mjs';
import { CaptionModel } from '../public/caption-model.js';

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.emit('open'); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
  terminate() { this.close(1006); }
  receive(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
  ready() { this.open(); this.receive({ setupComplete: {} }); }
}

function createInterpreter(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  let clock = 1_000_000;
  const interpreter = new GeminiInterpreter({
    apiKey: 'AIza-test-only', now: () => clock,
    createSocket: (url, socketOptions) => {
      const socket = new FakeSocket();
      Object.assign(socket, { url, socketOptions });
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  t.after(() => interpreter.close());
  const events = [];
  for (const type of ['audio', 'target_delta', 'source_delta', 'configured', 'ready', 'warning', 'fault', 'closed']) {
    interpreter.on(type, value => events.push([type, value]));
  }
  const advance = ms => { clock += ms; t.mock.timers.tick(ms); };
  return { interpreter, sockets, events, advance };
}

function tone(ms, amplitude = 8000) {
  const buffer = Buffer.alloc(24 * ms * 2);
  for (let i = 0; i < buffer.length / 2; i++) buffer.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
  return buffer;
}
const silence = ms => Buffer.alloc(24 * ms * 2);
const audioMessages = socket => socket.sent.filter(message => message.realtimeInput?.audio);
const sentAudio = socket => Buffer.concat(audioMessages(socket).map(message => Buffer.from(message.realtimeInput.audio.data, 'base64')));
const streamEnded = socket => socket.sent.some(message => message.realtimeInput?.audioStreamEnd === true);
const translated = (text, fill = 1) => ({
  serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480, fill).toString('base64') } }] },
    outputTranscription: { text },
  },
});
const spoken = (events, types = ['audio', 'target_delta']) => events.filter(([type]) => types.includes(type))
  .map(([type, value]) => type === 'audio' ? `audio:${value[0]}` : value.delta);

test('Live Translate setup sets the target, keeps transcription at setup level and adds glossary hints', t => {
  const profiles = loadConferenceGlossary().profiles;
  for (const language of ['vi', 'en']) {
    const { sockets } = createInterpreter(t, { targetLanguage: language, profiles });
    const [socket] = sockets;
    assert.equal(socket.url, `${GEMINI_LIVE_URL}?key=AIza-test-only`);
    socket.open();
    assert.equal(socket.sent.length, 1);
    const { setup } = socket.sent[0];
    assert.equal(setup.model, `models/${GEMINI_TRANSLATE_MODEL}`);
    assert.deepEqual(setup.generationConfig, {
      responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: language, echoTargetLanguage: false },
    });
    assert.deepEqual(setup.outputAudioTranscription, {});
    assert.deepEqual(setup.inputAudioTranscription, {
      languageCodes: language === 'vi' ? ['en', 'vi'] : ['vi', 'en'],
      customVocabulary: transcriptionProfile(language, profiles).keywords,
    });
    assert.equal('systemInstruction' in setup, false);
    t.mock.timers.reset();
  }
  assert.deepEqual(geminiSetup({ targetLanguage: 'en', transcriptionHints: false }).setup.inputAudioTranscription, {});
  assert.deepEqual(geminiSetup({ targetLanguage: 'vi' }).setup.inputAudioTranscription, { languageCodes: ['en', 'vi'] });
  assert.throws(() => geminiSetup({ targetLanguage: 'fr' }), RangeError);
});

test('24 kHz capture is resampled to 16 kHz without changing speech-band level or dropping samples', () => {
  const resampler = new Pcm16Resampler();
  const input = tone(1000, 10000);
  const pieces = [];
  for (let offset = 0; offset < input.length; offset += 4798) pieces.push(resampler.process(input.subarray(offset, offset + 4798)));
  pieces.push(resampler.process(Buffer.alloc(0), true));
  const output = Buffer.concat(pieces);
  assert.equal(output.length / 2, 16000);
  let peak = 0;
  for (let i = 1000; i < 15000; i++) peak = Math.max(peak, Math.abs(output.readInt16LE(i * 2)));
  assert.ok(peak > 9900 && peak < 10100, `peak ${peak}`);
  const alias = new Pcm16Resampler();
  const tenKilohertz = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++) tenKilohertz.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 10000 * i / 24000)), i * 2);
  const aliased = alias.process(tenKilohertz);
  let aliasPeak = 0;
  for (let i = 100; i < aliased.length / 2 - 100; i++) aliasPeak = Math.max(aliasPeak, Math.abs(aliased.readInt16LE(i * 2)));
  assert.ok(aliasPeak < 10, `10 kHz must not alias into the 16 kHz stream (peak ${aliasPeak})`);
});

test('buffers the first words until setupComplete, then streams 100 ms frames and flushes the tail on Stop', t => {
  const { interpreter, sockets, events } = createInterpreter(t);
  const [socket] = sockets;
  interpreter.appendAudio(tone(500));
  socket.open();
  assert.equal(audioMessages(socket).length, 0);
  assert.equal(interpreter.ready, false);
  socket.receive({ setupComplete: {} });
  assert.equal(interpreter.ready, true);
  assert.deepEqual(events.filter(([type]) => type === 'configured' || type === 'ready'), [['configured', { targetLanguage: 'vi' }], ['ready', undefined]]);
  assert.equal(audioMessages(socket).length, 4);
  assert.ok(audioMessages(socket).every(message => message.realtimeInput.audio.mimeType === 'audio/pcm;rate=16000'
    && Buffer.from(message.realtimeInput.audio.data, 'base64').length === GEMINI_FRAME_BYTES));
  interpreter.finish();
  assert.equal(sentAudio(socket).length, 16000, '0.5 s at 24 kHz becomes exactly 0.5 s at 16 kHz');
  assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  const sent = socket.sent.length;
  interpreter.appendAudio(tone(200));
  assert.equal(socket.sent.length, sent, 'no microphone audio after Stop');
});

test('one stream yields source captions, translated captions and translated audio in step', t => {
  const { interpreter, sockets, events } = createInterpreter(t);
  const [socket] = sockets;
  socket.ready();
  socket.receive({ serverContent: { inputTranscription: { text: 'Good morning', languageCode: 'en-US' } } });
  socket.receive(translated('Chào buổi sáng', 7));
  socket.receive({ serverContent: { inputTranscription: { text: ' everyone.', languageCode: 'en' } } });
  // A finished transcript repeats the turn; it must not duplicate the partial text.
  socket.receive({ serverContent: { inputTranscription: { text: 'Good morning everyone.', finished: true } } });
  socket.receive({ serverContent: { outputTranscription: { text: ' mọi người.' } } });
  socket.receive({ serverContent: { outputTranscription: { text: 'Chào buổi sáng mọi người.', finished: true } } });
  socket.receive({ serverContent: { inputTranscription: { text: 'Xin cảm ơn.', languageCode: 'vi' } } });
  const sources = events.filter(([type]) => type === 'source_delta').map(([, value]) => value);
  assert.deepEqual(sources.map(source => source.delta), ['Good morning', ' everyone.', 'Xin cảm ơn.']);
  assert.equal(sources[0].itemId, sources[1].itemId);
  assert.notEqual(sources[2].itemId, sources[1].itemId, 'a language change starts a new source row');
  const targets = events.filter(([type]) => type === 'target_delta').map(([, value]) => value);
  assert.deepEqual(targets.map(target => target.delta), ['Chào buổi sáng', ' mọi người.']);
  assert.ok(targets.every(target => target.itemId === `${interpreter.streamId}:1` && target.targetLanguage === 'vi'));
  assert.deepEqual(spoken(events, ['audio']), ['audio:7']);

  const captions = new CaptionModel();
  for (const [type, value] of events) if (type === 'source_delta' || type === 'target_delta') captions.update({ type, ...value });
  assert.equal(captions.liveText('en'), 'Good morning everyone.');
  assert.match(captions.liveText('vi'), /Chào buổi sáng mọi người\./);
  assert.match(captions.liveText('vi'), /Xin cảm ơn\./);
});

test('a finished transcript is used when the server sends no partial text', t => {
  const { sockets, events } = createInterpreter(t);
  sockets[0].ready();
  sockets[0].receive({ serverContent: { outputTranscription: { text: 'Câu một.', finished: true } } });
  sockets[0].receive({ serverContent: { outputTranscription: { text: 'Câu hai.', finished: true } } });
  assert.deepEqual(spoken(events), [' Câu một.', ' Câu hai.']);
});

test('rolls over before the 10-minute connection limit at a pause, without interleaving two voices', t => {
  const { interpreter, sockets, events, advance } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(1000));
  advance(ROLLOVER_AFTER_MS);
  interpreter.appendAudio(tone(200));
  assert.equal(sockets.length, 2, 'the next connection is prepared early');
  sockets[1].ready();
  interpreter.appendAudio(tone(400));
  assert.equal(audioMessages(sockets[1]).length, 0, 'never switch in the middle of speech');
  interpreter.appendAudio(silence(600));
  assert.ok(streamEnded(sockets[0]), 'the old connection flushes its last words');
  assert.ok(audioMessages(sockets[1]).length > 0, 'new speech goes to the new connection');
  const lastOldAudio = sockets[0].sent.findLastIndex(message => message.realtimeInput?.audio);
  const streamEnd = sockets[0].sent.findIndex(message => message.realtimeInput?.audioStreamEnd);
  assert.ok(lastOldAudio < streamEnd);

  sockets[1].receive(translated('B', 2));
  sockets[0].receive(translated('A', 1));
  assert.deepEqual(spoken(events), ['audio:1', 'A'], 'the new voice waits for the old one');
  advance(1500);
  assert.deepEqual(spoken(events), ['audio:1', 'A', 'audio:2', 'B']);
  assert.equal(sockets[0].readyState, 3);
  sockets[1].receive(translated('C', 3));
  assert.deepEqual(spoken(events).slice(-2), ['audio:3', 'C']);
  assert.equal(events.filter(([type]) => type === 'configured').length, 1, 'same direction: no settings change');
});

test('GoAway switches before the server deadline even while the speaker keeps talking', t => {
  const { interpreter, sockets, advance } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(400));
  sockets[0].receive({ goAway: { timeLeft: '5s' } });
  assert.equal(sockets.length, 2);
  sockets[1].ready();
  interpreter.appendAudio(tone(400));
  assert.equal(streamEnded(sockets[0]), false);
  advance(4000);
  interpreter.appendAudio(tone(400));
  assert.ok(streamEnded(sockets[0]));
  assert.ok(audioMessages(sockets[1]).length > 0);
});

test('changing direction opens a connection for the new target and keeps the speech said meanwhile', t => {
  const { interpreter, sockets, events, advance } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(400));
  assert.equal(interpreter.setTargetLanguage('fr'), false);
  assert.equal(interpreter.setTargetLanguage('vi'), true);
  assert.equal(sockets.length, 1);
  assert.equal(interpreter.setTargetLanguage('en'), true);
  assert.equal(sockets.length, 2);
  assert.ok(streamEnded(sockets[0]));
  interpreter.appendAudio(tone(300));
  sockets[1].open();
  assert.equal(sockets[1].sent[0].setup.generationConfig.translationConfig.targetLanguageCode, 'en');
  sockets[1].receive({ setupComplete: {} });
  assert.equal(sentAudio(sockets[1]).length, GEMINI_FRAME_BYTES * 3, 'audio spoken while connecting is not lost');
  assert.deepEqual(events.filter(([type]) => type === 'configured').map(([, value]) => value.targetLanguage), ['vi', 'en']);
  sockets[0].receive(translated('Phần cuối tiếng Việt', 1));
  sockets[1].receive(translated('English now', 2));
  advance(DRAIN_IDLE_MS);
  const targets = events.filter(([type]) => type === 'target_delta').map(([, value]) => value);
  assert.deepEqual(targets.map(target => [target.delta, target.targetLanguage]), [['Phần cuối tiếng Việt', 'vi'], ['English now', 'en']]);
  assert.notEqual(targets[0].itemId, targets[1].itemId);
});

test('Stop sends audioStreamEnd, plays the remaining translation and closes as drained', t => {
  const { interpreter, sockets, events, advance } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(250));
  interpreter.finish();
  assert.equal(interpreter.closing, true);
  sockets[0].receive(translated('đoạn cuối', 5));
  advance(DRAIN_IDLE_MS - 500);
  assert.equal(interpreter.closed, false);
  sockets[0].receive({ serverContent: { turnComplete: true, interactionStatus: 'IDLE' } });
  advance(1000);
  assert.deepEqual(events.filter(([type]) => type === 'closed'), [['closed', { drained: true }]]);
  assert.deepEqual(spoken(events), ['audio:5', 'đoạn cuối']);
  assert.equal(sockets[0].readyState, 3);
});

test('Stop during startup sends the buffered audio after setupComplete, then drains', t => {
  const { interpreter, sockets, events, advance } = createInterpreter(t);
  interpreter.appendAudio(tone(300));
  interpreter.finish();
  sockets[0].ready();
  assert.equal(sentAudio(sockets[0]).length, 9600);
  assert.deepEqual(sockets[0].sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  advance(DRAIN_IDLE_MS);
  assert.deepEqual(events.filter(([type]) => type === 'closed'), [['closed', { drained: true }]]);
});

test('rejected glossary hints retry once without them and keep the startup audio', t => {
  const { interpreter, sockets, events } = createInterpreter(t);
  sockets[0].open();
  interpreter.appendAudio(tone(300));
  sockets[0].close(1007, 'Invalid JSON payload received. Unknown name "customVocabulary"');
  assert.equal(events.filter(([type]) => type === 'warning').length, 1);
  assert.equal(events.some(([type]) => type === 'fault'), false);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent[0].setup.inputAudioTranscription, {});
  sockets[1].receive({ setupComplete: {} });
  assert.equal(sentAudio(sockets[1]).length, GEMINI_FRAME_BYTES * 2);
  assert.equal(interpreter.setTargetLanguage('en'), true);
  sockets[2].open();
  assert.deepEqual(sockets[2].sent[0].setup.inputAudioTranscription, {}, 'later connections skip the rejected hints');
});

test('refused connections fail visibly with an actionable message', t => {
  for (const [close, error, expected] of [
    [[1008, 'API key not valid. Please pass a valid API key.'], '', /GEMINI_API_KEY/],
    [[1006, ''], 'Unexpected server response: 429', /quota/],
    [[1008, `models/${GEMINI_TRANSLATE_MODEL} is not found for API version v1beta`], '', /preview/],
    [[1007, 'Request contains an invalid argument.'], '', /invalid argument/],
  ]) {
    const { sockets, events } = createInterpreter(t);
    sockets[0].open();
    if (error) sockets[0].emit('error', new Error(error));
    if (close[0] === 1007) {
      sockets[0].close(...close);
      sockets[1].open();
      sockets[1].close(...close);
    } else sockets[0].close(...close);
    const faults = events.filter(([type]) => type === 'fault');
    assert.equal(faults.length, 1);
    assert.match(faults[0][1], expected);
    assert.deepEqual(events.at(-1), ['closed', { drained: false }]);
    t.mock.timers.reset();
  }
  assert.match(describeGeminiFailure(1008, 'User location is not supported for the API use.'), /khu vực/);
  assert.match(describeGeminiFailure(1008, 'Your project has been denied access. Please contact support.'), /chặn project.*Billing.*OpenAI GPT/);
  for (const [code, reason, error] of [[1008, 'Your Prepay credit balance is depleted. Add credits to your billing account.', ''], [1006, '', 'Unexpected server response: 402']]) {
    assert.match(describeGeminiFailure(code, reason, error), /^Hết credit Gemini.*Buy credits/, 'not mistaken for a quota error');
  }
  assert.equal(describeGeminiFailure(1011, 'Internal error.'), 'Lỗi Gemini (1011): Internal error.');
});

test('Stop before setupComplete still reports a refused key instead of a clean finish', t => {
  const { interpreter, sockets, events } = createInterpreter(t);
  interpreter.appendAudio(tone(300));
  interpreter.finish();
  sockets[0].open();
  sockets[0].close(1008, 'API key not valid. Please pass a valid API key.');
  assert.match(events.find(([type]) => type === 'fault')[1], /GEMINI_API_KEY/);
  assert.deepEqual(events.at(-1), ['closed', { drained: false }]);
});

test('an unexpected drop reconnects with a warning; repeated drops stop with an error', t => {
  const { interpreter, sockets, events } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(200));
  sockets[0].close(1011, 'Internal error');
  assert.equal(sockets.length, 2);
  assert.match(events.find(([type]) => type === 'warning')[1], /tự nối lại/);
  interpreter.appendAudio(tone(200));
  sockets[1].ready();
  assert.equal(sentAudio(sockets[1]).length, GEMINI_FRAME_BYTES * 2);
  for (const index of [1, 2, 3]) {
    if (index > 1) sockets[index].ready();
    sockets[index].close(1011, 'Internal error');
  }
  assert.equal(events.filter(([type]) => type === 'fault').length, 1);
  assert.equal(interpreter.closed, true);
});

test('invalid PCM, unexpected output format and a 20-second startup backlog fail visibly', t => {
  for (const scenario of ['input', 'output', 'backlog']) {
    const { interpreter, sockets, events } = createInterpreter(t);
    if (scenario === 'input') interpreter.appendAudio(Buffer.alloc(3));
    if (scenario === 'output') {
      sockets[0].ready();
      sockets[0].receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: 'AAAA' } }] } } });
    }
    if (scenario === 'backlog') for (let i = 0; i < 21; i++) interpreter.appendAudio(silence(1000));
    assert.equal(events.filter(([type]) => type === 'fault').length, 1, scenario);
    assert.equal(events.some(([type]) => type === 'audio'), false);
    assert.equal(interpreter.closed, true);
    t.mock.timers.reset();
  }
});

// Measured on the real API (2026-10-16): after the translated voice ends, Live
// Translate keeps streaming exact digital silence in real time until the socket closes.
const silence250 = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(12000).toString('base64') } }] } } };
const forwardedSilence = events => events.filter(([type, value]) => type === 'audio' && value.every(byte => byte === 0))
  .reduce((bytes, [, value]) => bytes + value.length, 0);

test('streamed digital silence neither stretches Stop to the 20 s limit nor floods listeners', t => {
  const { interpreter, sockets, events, advance } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(250));
  interpreter.finish();
  sockets[0].receive(translated('đoạn cuối', 5));
  for (let i = 0; i < 40 && !interpreter.closed; i++) { sockets[0].receive(silence250); advance(250); }
  assert.deepEqual(events.filter(([type]) => type === 'closed'), [['closed', { drained: true }]]);
  assert.ok(events.findIndex(([type]) => type === 'closed') > 0);
  assert.ok(forwardedSilence(events) <= 24000 * 2 * 0.6, 'only a natural pause of silence reaches listeners');
  assert.deepEqual(spoken(events).filter(text => text !== 'audio:0'), ['audio:5', 'đoạn cuối']);
});

test('a finishing connection that streams silence does not hold back the next connection', t => {
  const { interpreter, sockets, events, advance } = createInterpreter(t);
  sockets[0].ready();
  interpreter.appendAudio(tone(400));
  assert.equal(interpreter.setTargetLanguage('en'), true);
  sockets[1].ready();
  sockets[0].receive(translated('Phần cuối', 1));
  sockets[1].receive(translated('English now', 2));
  for (let i = 0; i < 8; i++) { sockets[0].receive(silence250); advance(250); }
  assert.deepEqual(spoken(events).filter(text => text !== 'audio:0'), ['audio:1', 'Phần cuối', 'audio:2', 'English now']);
  assert.equal(sockets[0].readyState, 3);
});

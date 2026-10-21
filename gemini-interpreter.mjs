import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { transcriptionProfile } from './conference-glossary.mjs';

export const GEMINI_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
export const GEMINI_LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const GEMINI_FRAME_BYTES = 16000 * 2 / 10; // 100 ms, mono PCM16 at the documented 16 kHz input rate.
const MAX_PENDING_AUDIO_BYTES = 16000 * 2 * 20;
// A Live API connection lasts about 10 minutes. Open the next connection early
// and switch at a pause, so a long conference never depends on one socket.
export const ROLLOVER_AFTER_MS = 7.5 * 60000;
export const ROLLOVER_DEADLINE_MS = 9.25 * 60000;
const STANDBY_RETRY_MS = 5000;
const PAUSE_FRAMES = 4;
const SPEECH_RMS = 0.006;
// Continuous translation has no "drained" event: after audioStreamEnd the model
// flushes its last words, so a finishing connection is done once it goes quiet.
export const DRAIN_IDLE_MS = 4000;
const DRAIN_HANDOFF_IDLE_MS = 1500;
const DRAIN_TURN_GRACE_MS = 1000;
const DRAIN_MAX_MS = 20000;
// Live Translate streams digital silence in real time for as long as the socket
// is open. Keep natural pauses, but drop long silence: it is not translation
// activity, costs listener bandwidth, and would queue behind the next voice.
const KEEP_SILENCE_BYTES = 24000 * 2 * 0.6;
const isSilent = audio => {
  for (let offset = 0; offset < audio.length; offset += 2) if (Math.abs(audio.readInt16LE(offset)) > 2) return false;
  return true;
};
const validTarget = value => value === 'vi' || value === 'en';
const baseLanguage = code => typeof code === 'string' && code ? code.split(/[-_]/)[0].toLowerCase() : null;

// 24 kHz capture → 16 kHz input: Blackman-windowed sinc low-pass (7 kHz).
// Output sample k sits at input position 1.5k, so only two phases exist.
const HALF_TAPS = 24;
const KERNELS = [0, 0.5].map(phase => {
  const taps = [];
  for (let j = 1 - HALF_TAPS; j <= HALF_TAPS; j++) {
    const t = j - phase, x = 7 / 12 * t;
    const sinc = x ? Math.sin(Math.PI * x) / (Math.PI * x) : 1;
    taps.push(Math.max(0, 0.42 + 0.5 * Math.cos(Math.PI * t / HALF_TAPS) + 0.08 * Math.cos(2 * Math.PI * t / HALF_TAPS)) * sinc);
  }
  const sum = taps.reduce((total, tap) => total + tap, 0);
  return taps.map(tap => tap / sum);
});

export class Pcm16Resampler {
  constructor() {
    this.samples = new Float32Array(HALF_TAPS); // Silence before the first sample.
    this.position = HALF_TAPS;
  }

  process(buffer, final = false) {
    const count = buffer.length >> 1;
    const samples = new Float32Array(this.samples.length + count + (final ? HALF_TAPS : 0));
    samples.set(this.samples);
    for (let i = 0; i < count; i++) samples[this.samples.length + i] = buffer.readInt16LE(i * 2);
    const output = [];
    let position = this.position;
    while (Math.floor(position) + HALF_TAPS < samples.length) {
      const base = Math.floor(position), kernel = KERNELS[position === base ? 0 : 1];
      let value = 0;
      for (let j = 0; j < kernel.length; j++) value += samples[base + j + 1 - HALF_TAPS] * kernel[j];
      output.push(value);
      position += 1.5;
    }
    const keep = Math.floor(position) + 1 - HALF_TAPS;
    this.samples = samples.slice(keep);
    this.position = position - keep;
    const bytes = Buffer.alloc(output.length * 2);
    output.forEach((value, i) => bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2));
    return bytes;
  }
}

export function geminiSetup({ targetLanguage = 'vi', vocabulary = [], transcriptionHints = true } = {}) {
  if (!validTarget(targetLanguage)) throw new RangeError('Invalid translation target');
  const sourceLanguage = targetLanguage === 'vi' ? 'en' : 'vi';
  return {
    setup: {
      model: `models/${GEMINI_TRANSLATE_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        // Like a booth interpreter: speech already in the target language stays silent.
        translationConfig: { targetLanguageCode: targetLanguage, echoTargetLanguage: false },
      },
      // Glossary terms only bias the source captions; Live Translate takes no instructions.
      inputAudioTranscription: transcriptionHints
        ? { languageCodes: [sourceLanguage, targetLanguage], ...(vocabulary.length ? { customVocabulary: [...vocabulary] } : {}) }
        : {},
      outputAudioTranscription: {},
    },
  };
}

export function describeGeminiFailure(code, reason = '', error = '') {
  const detail = [reason, error].map(value => String(value || '').trim()).filter(Boolean).join(' — ');
  const status = Number(String(error).match(/Unexpected server response: (\d+)/)?.[1]);
  if (/location is not supported|region|country/i.test(detail)) {
    return 'Gemini API chưa hỗ trợ khu vực mạng của máy chủ. Kiểm tra mạng hoặc VPN của server.';
  }
  // Google flags the account or project itself; every model is refused, so the app cannot fix it.
  if (/denied access|has been suspended/i.test(detail)) {
    return 'Google đã chặn project của GEMINI_API_KEY ("project has been denied access"), lỗi tài khoản phía Google. Xác minh tuổi, số điện thoại và bật xác minh 2 bước cho tài khoản Google, hoặc bật Billing cho project, rồi tạo API key mới. Trong lúc chờ, chọn mô hình OpenAI GPT.';
  }
  // A depleted Prepay balance stops every key on the billing account; retrying cannot help.
  if (status === 402 || /payment[ _]required|credit balance|depleted/i.test(detail)) {
    return 'Hết credit Gemini (402: Prepay credit balance is depleted). Nạp thêm tại AI Studio → Billing → Buy credits hoặc bật auto-reload, rồi bấm Bắt đầu lại. Trong lúc chờ, chọn mô hình OpenAI GPT.';
  }
  if (status === 401 || status === 403 || /API[ _]?key|UNAUTHENTICATED|PERMISSION_DENIED|permission denied/i.test(detail)) {
    return 'Gemini từ chối API key hoặc quyền truy cập. Kiểm tra GEMINI_API_KEY trong .env rồi khởi động lại server.';
  }
  if (status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit|billing/i.test(detail)) {
    return 'Gemini báo vượt hạn mức (429/quota). Kiểm tra gói Free/Paid, Billing và giới hạn của project trong Google AI Studio.';
  }
  if (status === 404 || /not found|NOT_FOUND|not supported|is not available/i.test(detail)) {
    return `Không truy cập được model ${GEMINI_TRANSLATE_MODEL} (bản preview). Kiểm tra project của API key có quyền dùng model này.`;
  }
  return `Lỗi Gemini${code ? ` (${code})` : ''}: ${(detail || 'kết nối bị đóng').replace(/[.\s]+$/u, '')}.`;
}

function durationMs(value) {
  if (value && typeof value === 'object') return (Number(value.seconds) || 0) * 1000 + (Number(value.nanos) || 0) / 1e6;
  const seconds = Number(String(value ?? '').match(/^(\d+(?:\.\d+)?)s$/)?.[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : 10000;
}

// One Gemini Live Translate stream: source captions, translated captions and
// translated speech all come from the same connection, so they stay in step.
export class GeminiInterpreter extends EventEmitter {
  constructor({ apiKey, targetLanguage = 'vi', profiles = null, createSocket = (url, options) => new WebSocket(url, options), now = () => Date.now() }) {
    super();
    if (!validTarget(targetLanguage)) throw new RangeError('Invalid translation target');
    this.apiKey = apiKey;
    this.profiles = profiles;
    this.createSocket = createSocket;
    this.now = now;
    this.targetLanguage = targetLanguage;
    this.activeTargetLanguage = targetLanguage;
    this.streamId = randomUUID();
    this.sequence = 0;
    // Output order: connections that are finishing come first, then the active one.
    // Only the first may reach listeners, so two voices never interleave.
    this.connections = [];
    this.standby = null;
    this.nextStandbyAt = 0;
    this.transcriptionHints = true;
    this.failures = 0;
    this.ready = false;
    this.closing = false;
    this.closed = false;
    this.resampler = new Pcm16Resampler();
    this.pendingAudio = Buffer.alloc(0);
    this.recentRms = [];
    this.quietFrames = 0;
    this.finishTimer = null;
    this.active = this.open(targetLanguage);
    this.connections.push(this.active);
  }

  vocabulary(targetLanguage) {
    try { return this.profiles ? transcriptionProfile(targetLanguage, this.profiles).keywords : []; }
    catch { return []; }
  }

  open(targetLanguage) {
    const connection = {
      sequence: ++this.sequence, targetLanguage, openedAt: this.now(), deadline: Infinity,
      transcriptionHints: this.transcriptionHints, ready: false, ended: false, finished: false, socketClosed: false,
      frames: [], pendingBytes: 0, output: [], streamEndAt: 0, lastActivity: 0, turnComplete: false,
      source: null, sourceCount: 0, sourceFresh: false, targetFresh: false, silentBytes: 0, error: '',
    };
    connection.targetItemId = `${this.streamId}:${connection.sequence}`;
    const socket = connection.socket = this.createSocket(`${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.apiKey)}`, { handshakeTimeout: 15000 });
    socket.on('open', () => {
      if (connection.finished || this.closed) return;
      socket.send(JSON.stringify(geminiSetup({
        targetLanguage, vocabulary: this.vocabulary(targetLanguage), transcriptionHints: connection.transcriptionHints,
      })));
    });
    socket.on('message', data => {
      if (connection.finished || this.closed) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      this.handleMessage(connection, message);
    });
    socket.on('error', error => { connection.error = error.message; });
    socket.on('close', (code, reason) => this.handleClose(connection, code, reason ? String(reason) : ''));
    return connection;
  }

  send(connection, message) {
    if (connection.finished || connection.socket.readyState !== WebSocket.OPEN) return false;
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  appendAudio(buffer) {
    if (this.closed || this.closing) return;
    const audio = Buffer.from(buffer);
    if (audio.length % 2) { this.fail('Âm thanh đầu vào không đúng định dạng PCM16.'); return; }
    if (!audio.length) return;
    this.pendingAudio = Buffer.concat([this.pendingAudio, this.resampler.process(audio)]);
    this.routeFrames();
  }

  routeFrames(final = false) {
    let offset = 0;
    while (!this.closed && (this.pendingAudio.length - offset >= GEMINI_FRAME_BYTES || final && offset < this.pendingAudio.length)) {
      const frame = Buffer.from(this.pendingAudio.subarray(offset, offset + GEMINI_FRAME_BYTES));
      offset += frame.length;
      this.trackPause(frame);
      this.maybeRollover();
      this.routeTo(this.active, frame);
    }
    this.pendingAudio = this.closed ? Buffer.alloc(0) : Buffer.from(this.pendingAudio.subarray(offset));
  }

  routeTo(connection, frame) {
    if (connection.ready) {
      this.send(connection, { realtimeInput: { audio: { data: frame.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
      return;
    }
    connection.frames.push(frame);
    connection.pendingBytes += frame.length;
    if (connection.pendingBytes > MAX_PENDING_AUDIO_BYTES) this.fail('Gemini chưa sẵn sàng sau 20 giây thu âm. Bấm Dừng rồi Bắt đầu để thử lại.');
  }

  trackPause(frame) {
    let sum = 0;
    for (let offset = 0; offset < frame.length; offset += 2) sum += (frame.readInt16LE(offset) / 32768) ** 2;
    const rms = Math.sqrt(sum / (frame.length / 2));
    this.recentRms.push(rms);
    if (this.recentRms.length > 50) this.recentRms.shift();
    // 20 dB below the last 5 s of speech, so mixer hiss between sentences still counts as a pause.
    this.quietFrames = rms <= Math.max(SPEECH_RMS, Math.max(...this.recentRms) / 10) ? this.quietFrames + 1 : 0;
  }

  maybeRollover() {
    const active = this.active;
    if (this.closing || this.closed || !active.ready) return;
    const now = this.now();
    if (!this.standby && now >= this.nextStandbyAt && (now - active.openedAt >= ROLLOVER_AFTER_MS || active.deadline !== Infinity)) {
      this.nextStandbyAt = now + STANDBY_RETRY_MS;
      this.standby = this.open(active.targetLanguage);
    }
    if (now >= Math.min(active.deadline, active.openedAt + ROLLOVER_DEADLINE_MS)) this.switchTo(this.standby || this.open(active.targetLanguage));
    else if (this.standby?.ready && this.quietFrames >= PAUSE_FRAMES) this.switchTo(this.standby);
  }

  switchTo(next) {
    const previous = this.active;
    if (this.standby === next) this.standby = null;
    this.active = next;
    this.connections.push(next);
    this.quietFrames = 0;
    if (previous.ready && !previous.socketClosed) this.endConnection(previous);
    else {
      // Audio that never reached Gemini belongs to the replacement connection.
      const frames = previous.frames;
      previous.frames = [];
      this.retire(previous);
      for (const frame of frames) this.routeTo(next, frame);
    }
    if (next.ready) this.activate(next);
    if (this.closing) this.endConnection(next);
  }

  setTargetLanguage(targetLanguage) {
    if (this.closed || this.closing || !validTarget(targetLanguage)) return false;
    if (targetLanguage === this.targetLanguage) return true;
    this.targetLanguage = targetLanguage;
    // The target is fixed at setup. New speech goes to a new connection while
    // the previous one finishes translating what it already heard.
    if (this.standby) this.retire(this.standby);
    this.switchTo(this.open(targetLanguage));
    return true;
  }

  handleMessage(connection, message) {
    if (message.setupComplete) { this.connectionReady(connection); return; }
    if (message.goAway) { this.goAway(connection, durationMs(message.goAway.timeLeft)); return; }
    const content = message.serverContent;
    if (!content) return;
    let activity = this.sourceText(connection, content.inputTranscription);
    for (const part of content.modelTurn?.parts || []) {
      const data = part.inlineData;
      if (!data?.data) continue;
      const mimeType = String(data.mimeType || 'audio/pcm;rate=24000');
      if (!/^audio\/(?:pcm|l16)\b/i.test(mimeType) || Number(mimeType.match(/rate=(\d+)/)?.[1] || 24000) !== 24000) {
        this.fail('Gemini trả âm thanh khác định dạng PCM16 mono 24 kHz.');
        return;
      }
      const audio = Buffer.from(data.data, 'base64');
      if (audio.length % 2) { this.fail('Đoạn âm thanh bản dịch Gemini không đúng định dạng PCM16.'); return; }
      if (!audio.length) continue;
      if (isSilent(audio)) {
        connection.silentBytes += audio.length;
        if (connection.silentBytes <= KEEP_SILENCE_BYTES) this.output(connection, ['audio', audio]);
        continue;
      }
      connection.silentBytes = 0;
      this.output(connection, ['audio', audio]);
      activity = true;
    }
    const translated = this.transcriptText(connection, content.outputTranscription, 'target');
    if (translated) {
      this.output(connection, ['target_delta', { delta: translated, itemId: connection.targetItemId, targetLanguage: connection.targetLanguage }]);
      activity = true;
    }
    if (!connection.streamEndAt || connection.finished) return;
    if (activity) { connection.lastActivity = this.now(); connection.turnComplete = false; }
    if (content.turnComplete && content.interactionStatus !== 'IN_PROGRESS') connection.turnComplete = true;
    this.checkDrain(connection);
  }

  transcriptText(connection, transcription, kind) {
    if (typeof transcription?.text !== 'string' || !transcription.text) return '';
    const fresh = `${kind}Fresh`;
    if (transcription.finished !== true) { connection[fresh] = true; return transcription.text; }
    // A finished transcription repeats the turn; use it only if no partial text arrived.
    const text = connection[fresh] ? '' : transcription.text;
    connection[fresh] = false;
    return text && !/^\s/u.test(text) ? ` ${text}` : text;
  }

  sourceText(connection, transcription) {
    const text = this.transcriptText(connection, transcription, 'source');
    if (!text) return false;
    const language = baseLanguage(transcription.languageCode);
    // One language per source row, so a long row never moves caption columns.
    if (!connection.source || language && connection.source.language && language !== connection.source.language && /\p{L}/u.test(text)) {
      connection.source = { itemId: `${connection.targetItemId}:source:${++connection.sourceCount}`, language };
    }
    connection.source.language ||= language;
    this.emit('source_delta', { delta: text, itemId: connection.source.itemId, targetLanguage: connection.targetLanguage });
    return true;
  }

  output(connection, event) {
    if (this.connections[0] === connection) { this.emit(...event); return; }
    connection.output.push(event);
    if (this.connections[0]?.streamEndAt) this.checkDrain(this.connections[0]);
  }

  connectionReady(connection) {
    if (connection.ready) return;
    connection.ready = true;
    connection.readyAt = this.now();
    const frames = connection.frames;
    connection.frames = [];
    connection.pendingBytes = 0;
    for (const frame of frames) this.routeTo(connection, frame);
    if (connection === this.active) this.activate(connection);
    if (connection.ended) this.endStream(connection);
  }

  activate(connection) {
    const changed = connection.targetLanguage !== this.activeTargetLanguage;
    this.activeTargetLanguage = connection.targetLanguage;
    if (!this.ready || changed) this.emit('configured', { targetLanguage: connection.targetLanguage });
    if (!this.ready) { this.ready = true; this.emit('ready'); }
  }

  goAway(connection, timeLeftMs) {
    if (connection === this.standby) { this.retire(connection); return; }
    if (connection !== this.active) return;
    connection.deadline = Math.min(connection.deadline, this.now() + timeLeftMs - 1000);
    this.maybeRollover();
  }

  endConnection(connection) {
    if (connection.ended) return;
    connection.ended = true;
    if (connection.ready) this.endStream(connection);
  }

  endStream(connection) {
    if (connection.streamEndAt || connection.finished) return;
    this.send(connection, { realtimeInput: { audioStreamEnd: true } });
    connection.streamEndAt = connection.lastActivity = this.now();
    connection.limitTimer = setTimeout(() => this.retire(connection), DRAIN_MAX_MS);
    connection.limitTimer.unref?.();
    this.checkDrain(connection);
  }

  checkDrain(connection) {
    if (connection.finished || !connection.streamEndAt) return;
    clearTimeout(connection.idleTimer);
    const successorWaiting = this.connections.some(other => other !== connection && other.output.length);
    const quiet = connection.turnComplete ? DRAIN_TURN_GRACE_MS : successorWaiting ? DRAIN_HANDOFF_IDLE_MS : DRAIN_IDLE_MS;
    const delay = connection.lastActivity + quiet - this.now();
    if (delay <= 0) { this.retire(connection); return; }
    connection.idleTimer = setTimeout(() => this.checkDrain(connection), delay);
    connection.idleTimer.unref?.();
  }

  retire(connection) {
    if (connection.finished) return;
    connection.finished = true;
    connection.frames = [];
    clearTimeout(connection.idleTimer);
    clearTimeout(connection.limitTimer);
    if (this.standby === connection) this.standby = null;
    this.closeSocket(connection);
    // Release queued speech from the next connection in order.
    while (this.connections.length) {
      const owner = this.connections[0], queued = owner.output;
      owner.output = [];
      for (const event of queued) this.emit(...event);
      if (!owner.finished) break;
      this.connections.shift();
    }
    if (this.closing && !this.closed && !this.connections.length) this.markClosed(true);
  }

  closeSocket(connection) {
    const { socket } = connection;
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  }

  handleClose(connection, code, reason) {
    if (connection.finished || this.closed) return;
    connection.socketClosed = true;
    // A finishing connection is done when its socket closes; a refused one still reports why.
    if (connection === this.standby || connection.ended && connection.ready) { this.retire(connection); return; }
    const failure = describeGeminiFailure(code, reason, connection.error);
    if (!connection.ready && connection.transcriptionHints && code === 1007) {
      // Language and glossary hints are optional; retry once without them.
      this.transcriptionHints = false;
      this.emit('warning', 'Gemini không nhận gợi ý thuật ngữ cho phụ đề gốc; phụ đề dùng nhận dạng mặc định.');
      this.switchTo(this.open(connection.targetLanguage));
      return;
    }
    if (connection.ready && !this.closing) {
      if (this.now() - connection.readyAt > 60000) this.failures = 0;
      if (++this.failures <= 3) {
        this.emit('warning', `Kết nối Gemini bị ngắt (${failure}); đã tự nối lại, có thể thiếu vài giây bản dịch.`);
        this.switchTo(this.standby?.targetLanguage === connection.targetLanguage ? this.standby : this.open(connection.targetLanguage));
        return;
      }
    }
    this.fail(failure);
  }

  finish() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.pendingAudio = Buffer.concat([this.pendingAudio, this.resampler.process(Buffer.alloc(0), true)]);
    this.routeFrames(true);
    if (this.closed) return;
    if (this.standby) this.retire(this.standby);
    this.finishTimer = setTimeout(() => this.fail('Gemini chưa hoàn tất phần dịch cuối sau 30 giây.'), 30000);
    this.finishTimer.unref?.();
    this.endConnection(this.active);
  }

  markClosed(drained) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.pendingAudio = Buffer.alloc(0);
    clearTimeout(this.finishTimer);
    for (const connection of [...this.connections, this.standby].filter(Boolean)) {
      connection.finished = true;
      connection.frames = [];
      clearTimeout(connection.idleTimer);
      clearTimeout(connection.limitTimer);
      this.closeSocket(connection);
    }
    this.connections = [];
    this.standby = null;
    this.emit('closed', { drained });
  }

  fail(message) {
    if (this.closed) return;
    this.emit('fault', message);
    this.close();
  }

  close() {
    this.markClosed(false);
  }
}

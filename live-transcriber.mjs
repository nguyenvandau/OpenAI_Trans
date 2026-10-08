import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { transcriptionProfile } from './conference-glossary.mjs';

export const LIVE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
const SAMPLE_RATE = 24000;
const FRAME_BYTES = SAMPLE_RATE * 2 / 5;
const MAX_PENDING_AUDIO_BYTES = SAMPLE_RATE * 2 * 20;
const MAX_TURN_BYTES = SAMPLE_RATE * 2 * 30;
const SILENCE_FRAMES = 3;
const SPEECH_RMS = 0.006;
const validTarget = value => value === 'vi' || value === 'en';

// Context belongs to source captions only. This connection never requests speech
// output or supplies text to the independent audio translation connection.
export function liveTranscriptionSessionUpdate({ targetLanguage = 'vi', profiles, noiseReduction = null, includeDelay = true } = {}) {
  if (!validTarget(targetLanguage)) throw new RangeError('Invalid translation target');
  const transcription = { ...transcriptionProfile(targetLanguage, profiles), model: LIVE_TRANSCRIPTION_MODEL };
  if (!includeDelay) delete transcription.delay;
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription,
          noise_reduction: noiseReduction,
          turn_detection: null,
        },
      },
    },
  };
}

export class LiveTranscriber extends EventEmitter {
  constructor({ apiKey, noiseReduction = null, targetLanguage = 'vi', profiles, createSocket = (url, options) => new WebSocket(url, options) }) {
    super();
    if (!validTarget(targetLanguage)) throw new RangeError('Invalid translation target');
    this.targetLanguage = targetLanguage;
    this.activeTargetLanguage = targetLanguage;
    this.profiles = profiles;
    this.noiseReduction = noiseReduction;
    this.streamId = `source-${randomUUID()}`;
    this.ready = false;
    this.closing = false;
    this.closed = false;
    this.includeDelay = true;
    this.configurationTargets = [];
    this.pendingAudio = Buffer.alloc(0);
    this.turnBytes = 0;
    this.turnTargetLanguage = targetLanguage;
    this.hadSpeech = false;
    this.silenceFrames = 0;
    this.commitRequests = [];
    this.pendingItems = new Set();
    this.items = new Map();
    this.finishTimer = null;
    this.socket = createSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      handshakeTimeout: 15000,
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': 'conference-source-captions' },
    });
    this.socket.on('open', () => { if (!this.closed) this.configure(); });
    this.socket.on('message', data => {
      if (this.closed) return;
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      this.handleEvent(event);
    });
    this.socket.on('error', error => { if (!this.closed) this.fail(error.message); });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.emit('fault', 'Kết nối phụ đề nguồn đã đóng trước khi hoàn tất nhận dạng.');
      this.markClosed(false);
    });
  }

  send(event) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  configure() {
    const update = liveTranscriptionSessionUpdate({
      targetLanguage: this.targetLanguage, profiles: this.profiles,
      noiseReduction: this.noiseReduction, includeDelay: this.includeDelay,
    });
    if (this.send(update)) this.configurationTargets.push(this.targetLanguage);
  }

  appendAudio(buffer) {
    if (this.closed || this.closing) return;
    const audio = Buffer.from(buffer);
    if (audio.length % 2) { this.fail('Âm thanh phụ đề nguồn không đúng định dạng PCM16.'); return; }
    if (!audio.length) return;
    this.pendingAudio = Buffer.concat([this.pendingAudio, audio]);
    if (!this.ready && this.pendingAudio.length > MAX_PENDING_AUDIO_BYTES) {
      this.fail('Nhận dạng phụ đề nguồn chưa sẵn sàng sau 20 giây thu âm.');
      return;
    }
    this.flushAudio();
  }

  sendFrame(frame) {
    if (!this.turnBytes) this.turnTargetLanguage = this.activeTargetLanguage;
    if (!this.send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') })) return false;
    this.turnBytes += frame.length;
    let squareSum = 0;
    for (let offset = 0; offset < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset) / 32768;
      squareSum += sample * sample;
    }
    const speech = Math.sqrt(squareSum / (frame.length / 2)) >= SPEECH_RMS;
    if (speech) {
      this.hadSpeech = true;
      this.silenceFrames = 0;
    } else if (this.hadSpeech) this.silenceFrames++;
    // Only finalise captions at a pause or bounded interval. Silence still goes
    // to the ASR service, and audio translation never waits for this commit.
    if ((this.hadSpeech && this.silenceFrames >= SILENCE_FRAMES) || this.turnBytes >= MAX_TURN_BYTES) this.commitTurn();
    return true;
  }

  flushAudio() {
    if (!this.ready || this.closed) return;
    let offset = 0;
    while (this.pendingAudio.length - offset >= FRAME_BYTES) {
      if (!this.sendFrame(this.pendingAudio.subarray(offset, offset + FRAME_BYTES))) break;
      offset += FRAME_BYTES;
    }
    if (offset) this.pendingAudio = Buffer.from(this.pendingAudio.subarray(offset));
    if (this.closing && this.pendingAudio.length && this.pendingAudio.length < FRAME_BYTES) {
      const tail = Buffer.alloc(FRAME_BYTES);
      this.pendingAudio.copy(tail);
      if (this.sendFrame(tail)) this.pendingAudio = Buffer.alloc(0);
    }
    if (this.closing && !this.pendingAudio.length) {
      this.commitTurn();
      this.maybeFinish();
    }
  }

  commitTurn() {
    if (!this.turnBytes || this.closed) return;
    const request = { targetLanguage: this.turnTargetLanguage };
    if (!this.send({ type: 'input_audio_buffer.commit' })) return;
    this.commitRequests.push(request);
    this.turnBytes = 0;
    this.hadSpeech = false;
    this.silenceFrames = 0;
  }

  setTargetLanguage(targetLanguage) {
    if (this.closed || this.closing || !validTarget(targetLanguage)) return false;
    if (targetLanguage === this.targetLanguage) return true;
    this.targetLanguage = targetLanguage;
    this.configure();
    return true;
  }

  sourceItem(apiItemId, targetLanguage) {
    if (typeof apiItemId !== 'string' || !apiItemId) return null;
    if (!this.items.has(apiItemId)) {
      const item = {
        itemId: `${this.streamId}:${apiItemId}`,
        targetLanguage: targetLanguage || this.commitRequests[0]?.targetLanguage || this.turnTargetLanguage,
        completed: false,
      };
      this.items.set(apiItemId, item);
      this.emit('source_turn', { itemId: item.itemId, targetLanguage: item.targetLanguage });
    }
    return this.items.get(apiItemId);
  }

  handleEvent(event) {
    if (this.closed) return;
    if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
      const model = event.session?.audio?.input?.transcription?.model || event.session?.input_audio_transcription?.model;
      if (model && model !== LIVE_TRANSCRIPTION_MODEL) { this.fail('OpenAI chưa xác nhận model nhận dạng phụ đề nguồn.'); return; }
      this.activeTargetLanguage = this.configurationTargets.shift() || this.targetLanguage;
      const wasReady = this.ready;
      this.ready = true;
      if (!wasReady) this.emit('ready');
      this.flushAudio();
    } else if (event.type === 'input_audio_buffer.committed') {
      const request = this.commitRequests.shift();
      const item = this.sourceItem(event.item_id, request?.targetLanguage);
      if (!item) { this.fail('OpenAI trả lượt phụ đề nguồn không có mã nhận dạng.'); return; }
      if (request) item.targetLanguage = request.targetLanguage;
      if (!item.completed) this.pendingItems.add(event.item_id);
      this.emit('source_turn', {
        itemId: item.itemId, targetLanguage: item.targetLanguage,
        previousItemId: event.previous_item_id ? `${this.streamId}:${event.previous_item_id}` : null,
      });
      this.maybeFinish();
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const item = this.sourceItem(event.item_id);
      if (!item || item.completed || typeof event.delta !== 'string') return;
      this.emit('source_delta', { itemId: item.itemId, delta: event.delta, targetLanguage: item.targetLanguage });
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const item = this.sourceItem(event.item_id);
      if (!item || item.completed) return;
      item.completed = true;
      this.pendingItems.delete(event.item_id);
      // The final transcript is authoritative; don't append it to partial text,
      // replace words with glossary translations, or infer text from silence.
      this.emit('source_transcript', { itemId: item.itemId, text: typeof event.transcript === 'string' ? event.transcript : '', targetLanguage: item.targetLanguage });
      this.maybeFinish();
    } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
      const item = this.sourceItem(event.item_id);
      if (!item || item.completed) return;
      item.completed = true;
      this.pendingItems.delete(event.item_id);
      this.emit('warning', event.error?.message || 'Không nhận dạng được một đoạn phụ đề nguồn.');
      this.maybeFinish();
    } else if (event.type === 'error') {
      const error = event.error || {};
      const message = error.message || 'OpenAI live transcription error';
      const unsupportedDelay = /delay/i.test(error.param || '') || /(?:unknown|invalid|unsupported).*delay|delay.*(?:not supported|only supported|unsupported)/i.test(message);
      if (this.includeDelay && unsupportedDelay) {
        this.includeDelay = false;
        this.configurationTargets.shift();
        this.emit('warning', 'OpenAI chưa hỗ trợ cấu hình độ trễ phụ đề; đang dùng độ trễ mặc định.');
        this.configure();
      } else this.fail(message);
    }
  }

  finish() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.finishTimer = setTimeout(() => this.fail('Phụ đề nguồn chưa hoàn tất sau 25 giây.'), 25000);
    this.finishTimer.unref?.();
    this.flushAudio();
  }

  maybeFinish() {
    if (this.closing && this.ready && !this.pendingAudio.length && !this.turnBytes && !this.commitRequests.length && !this.pendingItems.size) {
      this.markClosed(true);
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    }
  }

  markClosed(drained) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.pendingAudio = Buffer.alloc(0);
    this.commitRequests.length = 0;
    this.configurationTargets.length = 0;
    this.pendingItems.clear();
    clearTimeout(this.finishTimer);
    this.emit('closed', { drained });
  }

  fail(message) {
    if (this.closed) return;
    this.emit('fault', message);
    this.close();
  }

  close() {
    this.markClosed(false);
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

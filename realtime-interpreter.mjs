import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export const REALTIME_MODEL = 'gpt-realtime-translate';
export const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
export const TRANSLATION_TARGETS = ['vi', 'en'];
export const AUDIO_FRAME_BYTES = 24000 * 2 / 5; // 200 ms, mono PCM16 at 24 kHz.
const MAX_PENDING_AUDIO_BYTES = 24000 * 2 * 20;

export function isTranslationTarget(value) { return TRANSLATION_TARGETS.includes(value); }

export function sessionUpdate({ noiseReduction = null, targetLanguage = 'vi' } = {}) {
  if (!isTranslationTarget(targetLanguage)) throw new RangeError('Invalid translation target');
  return {
    type: 'session.update',
    session: {
      audio: {
        input: { transcription: { model: TRANSCRIPTION_MODEL }, noise_reduction: noiseReduction },
        output: { language: targetLanguage },
      },
    },
  };
}

export class RealtimeInterpreter extends EventEmitter {
  constructor({ apiKey, noiseReduction = null, targetLanguage = 'vi', createSocket = (url, options) => new WebSocket(url, options) }) {
    super();
    if (!isTranslationTarget(targetLanguage)) throw new RangeError('Invalid translation target');
    this.targetLanguage = targetLanguage;
    this.activeTargetLanguage = targetLanguage;
    this.noiseReduction = noiseReduction;
    this.streamId = randomUUID();
    this.segment = 0;
    this.ready = false;
    this.closing = false;
    this.closed = false;
    this.closeSent = false;
    this.pendingAudio = Buffer.alloc(0);
    this.finishTimer = null;
    this.socket = createSocket(`wss://api.openai.com/v1/realtime/translations?model=${REALTIME_MODEL}`, {
      handshakeTimeout: 15000,
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': 'conference-translation-operator' },
    });
    this.socket.on('open', () => {
      if (!this.closed) this.send(sessionUpdate({ noiseReduction, targetLanguage: this.targetLanguage }));
    });
    this.socket.on('message', data => {
      if (this.closed) return;
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      this.handleEvent(event);
    });
    this.socket.on('error', error => { if (!this.closed) this.fail(error.message); });
    this.socket.on('close', () => {
      if (!this.closed) {
        if (this.closing) this.emit('fault', 'Kết nối dịch đã đóng trước khi hoàn tất phần âm thanh cuối.');
        this.markClosed(false);
      }
    });
  }

  send(event) {
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  appendAudio(buffer) {
    if (this.closed || this.closing) return;
    const audio = Buffer.from(buffer);
    if (audio.length % 2) { this.fail('Âm thanh đầu vào không đúng định dạng PCM16.'); return; }
    if (!audio.length) return;
    this.pendingAudio = Buffer.concat([this.pendingAudio, audio]);
    if (!this.ready && this.pendingAudio.length > MAX_PENDING_AUDIO_BYTES) {
      this.fail('OpenAI chưa sẵn sàng sau 20 giây thu âm. Bấm Dừng rồi Bắt đầu để thử lại.');
      return;
    }
    this.flushAudio();
  }

  flushAudio() {
    if (!this.ready || this.closed) return;
    let offset = 0;
    while (this.pendingAudio.length - offset >= AUDIO_FRAME_BYTES) {
      this.send({ type: 'session.input_audio_buffer.append', audio: this.pendingAudio.subarray(offset, offset + AUDIO_FRAME_BYTES).toString('base64') });
      offset += AUDIO_FRAME_BYTES;
    }
    // Copy the small remainder so a large input buffer can be released.
    if (offset) this.pendingAudio = Buffer.from(this.pendingAudio.subarray(offset));
    if (this.closing && !this.closeSent) {
      if (this.pendingAudio.length) {
        const frame = Buffer.alloc(AUDIO_FRAME_BYTES);
        this.pendingAudio.copy(frame);
        this.send({ type: 'session.input_audio_buffer.append', audio: frame.toString('base64') });
        this.pendingAudio = Buffer.alloc(0);
      }
      this.closeSent = true;
      this.send({ type: 'session.close' });
    }
  }

  setTargetLanguage(targetLanguage) {
    if (this.closed || this.closing || !isTranslationTarget(targetLanguage)) return false;
    if (targetLanguage === this.targetLanguage) return true;
    this.targetLanguage = targetLanguage;
    this.send(sessionUpdate({ noiseReduction: this.noiseReduction, targetLanguage }));
    return true;
  }

  handleEvent(event) {
    if (this.closed) return;
    if (event.type === 'session.updated') {
      const language = event.session?.audio?.output?.language;
      if (!isTranslationTarget(language)) { this.fail('OpenAI chưa xác nhận ngôn ngữ bản dịch.'); return; }
      if (this.ready && language !== this.activeTargetLanguage) this.segment++;
      this.activeTargetLanguage = language;
      const wasReady = this.ready;
      this.ready = true;
      this.emit('configured', { targetLanguage: language });
      if (!wasReady) this.emit('ready');
      this.flushAudio();
    } else if (event.type === 'session.output_audio.delta' && event.delta) {
      if ((event.sample_rate && event.sample_rate !== 24000) || (event.channels && event.channels !== 1) || (event.format && event.format !== 'pcm16')) {
        this.fail('OpenAI trả âm thanh khác định dạng PCM16 mono 24 kHz.');
        return;
      }
      const audio = Buffer.from(event.delta, 'base64');
      if (audio.length % 2) { this.fail('Đoạn âm thanh bản dịch không đúng định dạng PCM16.'); return; }
      if (audio.length) this.emit('audio', audio);
    } else if (['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type) && typeof event.delta === 'string') {
      // Independent append-only streams: no utterance IDs or final-transcript event.
      // Preserve partial words. elapsed_ms is not a unique event ID.
      this.emit(event.type === 'session.input_transcript.delta' ? 'source_delta' : 'target_delta', {
        delta: event.delta, itemId: `${this.streamId}:${this.segment}`,
        targetLanguage: this.activeTargetLanguage, elapsedMs: event.elapsed_ms,
      });
    } else if (event.type === 'session.closed') {
      this.markClosed(this.closeSent);
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    } else if (event.type === 'error') {
      this.fail(event.error?.message || 'OpenAI Realtime translation error');
    }
  }

  finish() {
    if (this.closed || this.closing) return;
    this.closing = true;
    // Receive the translated tail until the API confirms session.closed.
    this.finishTimer = setTimeout(() => this.fail('OpenAI chưa hoàn tất phần dịch cuối sau 30 giây.'), 30000);
    this.finishTimer.unref?.();
    this.flushAudio();
  }

  markClosed(drained) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.pendingAudio = Buffer.alloc(0);
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

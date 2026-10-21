import 'dotenv/config';
import express from 'express';
import http from 'http';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import WebSocket, { WebSocketServer } from 'ws';
import { RealtimeInterpreter, REALTIME_MODEL, TRANSCRIPTION_MODEL, isTranslationTarget } from './realtime-interpreter.mjs';
import { LiveTranscriber, LIVE_TRANSCRIPTION_MODEL } from './live-transcriber.mjs';
import { GeminiInterpreter, GEMINI_TRANSLATE_MODEL } from './gemini-interpreter.mjs';
import { loadConferenceGlossary } from './conference-glossary.mjs';

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_TARGET_LANGUAGE = 'vi';
let targetLanguage = DEFAULT_TARGET_LANGUAGE;
let presentation = { speakerName: '', talkTitle: '', speakerPhotoUrl: '', showSpeakerPhoto: false, showListenerQr: false };
const MAX_SPEAKER_PHOTO_BYTES = 128 * 1024;
const speakerPhotos = new Map();
const noiseReductionType = process.env.OPENAI_NOISE_REDUCTION || 'none';
const noiseReduction = ['near_field', 'far_field'].includes(noiseReductionType) ? { type: noiseReductionType } : null;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const requestedTranscriptionModel = process.env.OPENAI_SOURCE_TRANSCRIPTION || LIVE_TRANSCRIPTION_MODEL;
let glossary = null;
let glossaryWarning = '';
try { glossary = loadConferenceGlossary(); }
catch (error) { glossaryWarning = `Chưa đọc được bộ thuật ngữ; phụ đề dùng Whisper. ${error.message}`; }
if (![LIVE_TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL].includes(requestedTranscriptionModel)) {
  glossaryWarning = 'OPENAI_SOURCE_TRANSCRIPTION không hợp lệ; phụ đề dùng Whisper.';
}
const defaultTranscriptionModel = glossary && requestedTranscriptionModel === LIVE_TRANSCRIPTION_MODEL
  ? LIVE_TRANSCRIPTION_MODEL : TRANSCRIPTION_MODEL;
let transcriptionModel = defaultTranscriptionModel;

const placeholderKey = key => !key || /^(sk-\.\.\.|AIza\.\.\.|API_KEY_CUA_BAN|your[_ -]?api[_ -]?key.*)$/i.test(key);
// GPT: gpt-realtime-translate audio plus independent gpt-live-transcribe captions.
// Gemini: one Live Translate stream carries source captions, translation captions and audio.
const PROVIDERS = {
  openai: {
    label: 'OpenAI', model: REALTIME_MODEL,
    configurationError: placeholderKey(OPENAI_API_KEY) ? 'Chưa có OpenAI API key thật. Điền OPENAI_API_KEY trong file .env rồi khởi động lại server.' : '',
  },
  gemini: {
    label: 'Gemini', model: GEMINI_TRANSLATE_MODEL,
    configurationError: placeholderKey(GEMINI_API_KEY) ? 'Chưa có Gemini API key thật. Điền GEMINI_API_KEY trong file .env rồi khởi động lại server.' : '',
  },
};
const isProvider = value => typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
const requestedProvider = (process.env.TRANSLATION_PROVIDER || '').trim().toLowerCase();
const DEFAULT_PROVIDER = isProvider(requestedProvider) ? requestedProvider
  : PROVIDERS.openai.configurationError && !PROVIDERS.gemini.configurationError ? 'gemini' : 'openai';
let provider = DEFAULT_PROVIDER;
for (const { configurationError } of Object.values(PROVIDERS)) if (configurationError) console.warn(configurationError);

const app = express();
app.use(express.static('public'));
app.get('/', (_req, res) => res.redirect('/operator.html'));
app.get('/api/config', (req, res) => {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, { label, model, configurationError }]) => [id, { label, model, configurationError }]));
  res.json({
    targetLanguage, provider, providers, model: PROVIDERS[provider].model, transcriptionModel, glossary: glossary?.metadata || null,
    presentation, sessionActive: sessionsActive(), listenerUrl: `${base}/listen.html`, configurationError: PROVIDERS[provider].configurationError,
  });
});
app.get('/api/speaker-photo/:id', (req, res) => {
  const photo = /^[a-f0-9]{64}$/.test(req.params.id) ? speakerPhotos.get(req.params.id) : null;
  if (!photo) return res.sendStatus(404);
  res.set({ 'Content-Type': photo.type, 'Cache-Control': 'private, max-age=3600, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(photo.bytes);
});
app.post('/api/presentation', express.json({ limit: '384kb' }), (req, res) => {
  const fields = { speakerName: 160, talkTitle: 300 };
  const nextPresentation = { ...presentation };
  for (const [field, maxLength] of Object.entries(fields)) {
    if (typeof req.body?.[field] !== 'string') {
      return res.status(400).json({ message: 'Điền tên diễn giả và tên bài trình bày bằng văn bản; có thể để trống để ẩn.' });
    }
    nextPresentation[field] = req.body[field].trim().replace(/\s+/gu, ' ');
    if (nextPresentation[field].length > maxLength) {
      return res.status(400).json({ message: 'Tên diễn giả tối đa 160 ký tự; tên bài trình bày tối đa 300 ký tự.' });
    }
  }
  if (Object.hasOwn(req.body, 'showSpeakerPhoto')) {
    if (typeof req.body.showSpeakerPhoto !== 'boolean') {
      return res.status(400).json({ message: 'Lựa chọn hiển thị ảnh diễn giả phải là bật hoặc tắt.' });
    }
    nextPresentation.showSpeakerPhoto = req.body.showSpeakerPhoto;
  }
  if (Object.hasOwn(req.body, 'showListenerQr')) {
    if (typeof req.body.showListenerQr !== 'boolean') {
      return res.status(400).json({ message: 'Lựa chọn hiển thị QR trên cửa sổ phụ đề phải là bật hoặc tắt.' });
    }
    nextPresentation.showListenerQr = req.body.showListenerQr;
  }
  let uploadedPhoto = null;
  if (Object.hasOwn(req.body, 'speakerPhoto')) {
    if (req.body.speakerPhoto === null) {
      nextPresentation.speakerPhotoUrl = '';
      nextPresentation.showSpeakerPhoto = false;
    } else {
      const match = typeof req.body.speakerPhoto === 'string'
        ? req.body.speakerPhoto.match(/^data:(image\/(?:jpeg|png|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/)
        : null;
      if (!match || match[2].length > Math.ceil(MAX_SPEAKER_PHOTO_BYTES / 3) * 4) {
        return res.status(400).json({ message: 'Ảnh diễn giả phải là JPEG, PNG hoặc WebP, tối đa 128 KB.' });
      }
      const type = match[1];
      const bytes = Buffer.from(match[2], 'base64');
      const validSignature = type === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        : type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (bytes.length > MAX_SPEAKER_PHOTO_BYTES || bytes.toString('base64') !== match[2] || !validSignature) {
        return res.status(400).json({ message: 'Ảnh diễn giả không hợp lệ hoặc vượt quá 128 KB.' });
      }
      const id = createHash('sha256').update(bytes).digest('hex');
      uploadedPhoto = { id, type, bytes };
      nextPresentation.speakerPhotoUrl = `/api/speaker-photo/${id}`;
    }
  }
  if (nextPresentation.showSpeakerPhoto && !nextPresentation.speakerPhotoUrl) {
    return res.status(400).json({ message: 'Chọn ảnh diễn giả trước khi bật hiển thị ảnh.' });
  }
  // Commit only after validating every field. Status messages carry the URL, never image bytes.
  if (uploadedPhoto) {
    const { id, type, bytes } = uploadedPhoto;
    speakerPhotos.delete(id);
    speakerPhotos.set(id, { type, bytes });
    while (speakerPhotos.size > 16) speakerPhotos.delete(speakerPhotos.keys().next().value);
  }
  presentation = nextPresentation;
  broadcastJson({ type: 'presentation_update', presentation });
  res.json(presentation);
});
app.use((error, _req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Thông tin diễn giả và bài trình bày không đúng định dạng.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Thông tin diễn giả và bài trình bày quá dài.' });
  }
  next(error);
});
app.get('/api/qr.png', async (req, res) => {
  try {
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const png = await QRCode.toBuffer(`${base}/listen.html`, { width: 420, margin: 2 });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send(String(err));
  }
});

const server = http.createServer(app);
const sourceWss = new WebSocketServer({ noServer: true });
const listenerWss = new WebSocketServer({ noServer: true });

let sourceClient = null;
let interpreter = null;
let transcriber = null;
let sourceFinishing = false;
let aiReady = false;
let lastError = PROVIDERS[provider].configurationError;
let captionWarning = provider === 'openai' ? glossaryWarning : '';

function sessionsActive() { return Boolean(interpreter && !interpreter.closed || transcriber && !transcriber.closed); }
function sessionsDraining() { return Boolean(interpreter?.closing && !interpreter.closed || transcriber?.closing && !transcriber.closed); }

function broadcastJson(obj) {
  const payload = JSON.stringify(obj);
  if (sourceClient?.readyState === WebSocket.OPEN) sourceClient.send(payload);
  for (const client of listenerWss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function broadcastAudio(buffer) {
  for (const client of listenerWss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(buffer, { binary: true });
  }
}

function currentStatus(message = '') {
  return {
    type: 'status',
    sourceConnected: Boolean(sourceClient && sourceClient.readyState === WebSocket.OPEN),
    aiReady,
    listeners: listenerWss.clients.size,
    targetLanguage,
    provider,
    presentation,
    draining: sessionsDraining(),
    captionWarning,
    error: lastError,
    message,
  };
}

function broadcastStatus(message = '') {
  broadcastJson(currentStatus(message));
}

function scrubError(message) {
  // Authentication errors can echo credentials. Never forward those to browsers or logs.
  let result = String(message);
  for (const key of [OPENAI_API_KEY, GEMINI_API_KEY]) if (key) result = result.split(key).join('[hidden]');
  return result.replace(/sk-[A-Za-z0-9_.*-]+|AIza[A-Za-z0-9_-]{20,}/g, '[hidden]');
}

function reportError(message) {
  lastError = scrubError(message);
  aiReady = false;
  console.error(`${PROVIDERS[provider].label}:`, lastError);
  broadcastStatus();
}

function reportCaptionWarning(message) {
  captionWarning = scrubError(message);
  console.warn('Source captions:', captionWarning);
  broadcastJson({ type: 'caption_warning', message: captionWarning });
  broadcastStatus();
}

function finishSourceIfDrained() {
  if (!sourceFinishing || sessionsActive() || sourceClient?.readyState !== WebSocket.OPEN) return;
  sourceClient.send(JSON.stringify({ type: 'stopped' }));
  sourceClient.close(1000, 'Translation complete');
}

function finishSessions() {
  sourceFinishing = true;
  interpreter?.finish();
  transcriber?.finish();
  broadcastStatus('Finishing translation');
  finishSourceIfDrained();
}

function openSourceCaptions() {
  if (transcriptionModel !== LIVE_TRANSCRIPTION_MODEL) return;
  const session = new LiveTranscriber({ apiKey: OPENAI_API_KEY, noiseReduction, targetLanguage, profiles: glossary.profiles });
  transcriber = session;
  for (const type of ['source_turn', 'source_delta', 'source_transcript']) {
    session.on(type, caption => {
      if (transcriber === session) broadcastJson({ type, ...caption });
    });
  }
  session.on('warning', message => {
    if (transcriber === session) reportCaptionWarning(`Phụ đề nguồn: ${message}`);
  });
  session.on('fault', message => {
    if (transcriber !== session) return;
    reportCaptionWarning(`Phụ đề thuật ngữ tạm gián đoạn; âm thanh dịch vẫn tiếp tục. ${message}`);
  });
  session.on('closed', ({ drained }) => {
    if (transcriber !== session) return;
    transcriber = null;
    if (!drained && !sourceFinishing && interpreter && !interpreter.closing && !interpreter.closed) {
      // Only the caption source changes. Keep the translation socket and PCM stream running.
      transcriptionModel = TRANSCRIPTION_MODEL;
      interpreter.setSourceTranscription(true);
      reportCaptionWarning('Phụ đề chuyển sang Whisper do kết nối nhận dạng thuật ngữ bị gián đoạn. Âm thanh dịch vẫn tiếp tục; hãy đối chiếu phần phụ đề bị thiếu.');
    }
    broadcastStatus();
    finishSourceIfDrained();
  });
}

function openTranslationSession() {
  const { label, configurationError } = PROVIDERS[provider];
  if (configurationError) {
    reportError(configurationError);
    return;
  }
  if (interpreter && !interpreter.closed) return;
  lastError = '';
  const session = provider === 'gemini'
    ? new GeminiInterpreter({ apiKey: GEMINI_API_KEY, targetLanguage, profiles: glossary?.profiles })
    : new RealtimeInterpreter({
      apiKey: OPENAI_API_KEY, noiseReduction, targetLanguage,
      sourceTranscription: transcriptionModel === TRANSCRIPTION_MODEL,
    });
  interpreter = session;
  session.on('configured', config => {
    if (interpreter !== session) return;
    targetLanguage = config.targetLanguage;
    transcriber?.setTargetLanguage(targetLanguage);
    if (aiReady) broadcastStatus('Translation settings updated');
  });
  session.on('ready', () => {
    if (interpreter !== session) return;
    aiReady = true;
    broadcastStatus(`${label} interpreter connected`);
  });
  session.on('audio', buffer => {
    if (interpreter === session) broadcastAudio(buffer);
  });
  session.on('target_delta', delta => {
    if (interpreter === session) broadcastJson({ type: 'target_delta', ...delta });
  });
  session.on('source_delta', caption => {
    if (interpreter === session) broadcastJson({ type: 'source_delta', ...caption });
  });
  session.on('closed', ({ drained }) => {
    if (interpreter !== session) return;
    interpreter = null;
    aiReady = false;
    if (!drained && sourceClient?.readyState === WebSocket.OPEN && !lastError) {
      lastError = `Mất kết nối ${label}. Bấm Dừng rồi Bắt đầu để thử lại.`;
    }
    broadcastStatus(`${label} disconnected`);
    finishSourceIfDrained();
  });

  if (provider === 'gemini') {
    session.on('warning', message => {
      if (interpreter === session) reportCaptionWarning(`Gemini: ${message}`);
    });
    // Gemini messages already explain the cause and the fix.
    session.on('fault', message => {
      if (interpreter === session) reportError(message);
    });
    return;
  }
  session.on('fault', (message) => {
    if (interpreter !== session) return;
    const status = String(message).match(/Unexpected server response: (\d+)/)?.[1];
    const hints = {
      401: 'OpenAI từ chối API key (401). Kiểm tra khóa thật trong .env rồi khởi động lại server.',
      403: 'OpenAI từ chối quyền truy cập (403). Kiểm tra quyền của API key, project và khu vực truy cập.',
      404: `Không truy cập được model hoặc endpoint (404). Kiểm tra quyền dùng ${REALTIME_MODEL}.`,
      429: 'OpenAI báo giới hạn (429). Kiểm tra Billing, số dư API và giới hạn sử dụng của project.',
    };
    reportError(hints[status] || `Lỗi OpenAI: ${message}`);
  });
  openSourceCaptions();
}

function closeTranslationSession() {
  const session = interpreter;
  const captionSession = transcriber;
  interpreter = null;
  transcriber = null;
  session?.close();
  captionSession?.close();
  aiReady = false;
}

sourceWss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const requestedLanguage = params.get('targetLanguage') ?? DEFAULT_TARGET_LANGUAGE;
  if (!isTranslationTarget(requestedLanguage)) {
    ws.close(1008, 'Translation target must be vi or en.');
    return;
  }
  const requestedSessionProvider = params.get('provider') ?? DEFAULT_PROVIDER;
  if (!isProvider(requestedSessionProvider)) {
    ws.close(1008, 'Translation provider must be openai or gemini.');
    return;
  }
  if (sessionsDraining()) {
    ws.close(1008, 'Wait for the final translation to finish.');
    return;
  }
  if (sourceClient && sourceClient.readyState === WebSocket.OPEN) {
    sourceClient.close(1012, 'Replaced by new operator');
  }
  sourceClient = ws;
  targetLanguage = requestedLanguage;
  closeTranslationSession();
  provider = requestedSessionProvider;
  sourceFinishing = false;
  transcriptionModel = defaultTranscriptionModel;
  captionWarning = provider === 'openai' ? glossaryWarning
    : glossary ? '' : 'Chưa đọc được bộ thuật ngữ; phụ đề gốc Gemini chạy không có gợi ý thuật ngữ.';
  broadcastJson({ type: 'session_reset' });
  openTranslationSession();
  broadcastStatus('Operator connected');

  ws.on('message', (data, isBinary) => {
    if (sourceClient !== ws) return;
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'stop') {
          finishSessions();
        }
        if (msg.type === 'translation_config') {
          if (!isTranslationTarget(msg.targetLanguage)) {
            ws.send(JSON.stringify({ type: 'config_error', message: 'Chiều dịch không hợp lệ. Chọn Anh → Việt hoặc Việt → Anh.' }));
            return;
          }
          if (sourceFinishing) {
            ws.send(JSON.stringify({ type: 'config_error', message: 'Đang hoàn tất phiên dịch; chưa thể đổi chiều.' }));
          } else if (interpreter) {
            if (!interpreter.setTargetLanguage(msg.targetLanguage)) ws.send(JSON.stringify({ type: 'config_error', message: 'Đang hoàn tất phiên dịch; chưa thể đổi chiều.' }));
          } else {
            targetLanguage = msg.targetLanguage;
            transcriber?.setTargetLanguage(targetLanguage);
            broadcastStatus('Translation settings updated');
          }
        }
      } catch {}
      return;
    }
    // Buffer startup audio in the interpreter instead of dropping the first words.
    interpreter?.appendAudio(data);
    // Independent caption hints cannot hold, gate, or alter translation input.
    transcriber?.appendAudio(data);
  });

  ws.on('close', () => {
    if (sourceClient !== ws) return;
    sourceClient = null;
    finishSessions();
  });
});

listenerWss.on('connection', (ws) => {
  broadcastStatus();
  ws.on('close', () => broadcastStatus());
});

server.on('upgrade', (req, socket, head) => {
  // Route by path only: a malformed Host header or request target must not crash the shared process.
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (url.pathname === '/ws/source') {
    sourceWss.handleUpgrade(req, socket, head, (ws) => sourceWss.emit('connection', ws, req));
  } else if (url.pathname === '/ws/listen') {
    listenerWss.handleUpgrade(req, socket, head, (ws) => listenerWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Cabin running on http://localhost:${server.address()?.port}`);
  const available = Object.values(PROVIDERS).filter(({ configurationError }) => !configurationError).map(({ label, model }) => `${label} ${model}`);
  console.log(`Continuous translation: English ↔ Vietnamese (${available.join(', ') || 'no API key configured'})`);
  if (PUBLIC_BASE_URL) console.log(`Listener URL: ${PUBLIC_BASE_URL}/listen.html`);
});

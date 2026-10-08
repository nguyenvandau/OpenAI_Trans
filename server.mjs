import 'dotenv/config';
import express from 'express';
import http from 'http';
import QRCode from 'qrcode';
import WebSocket, { WebSocketServer } from 'ws';
import { RealtimeInterpreter, REALTIME_MODEL, TRANSCRIPTION_MODEL, isTranslationTarget } from './realtime-interpreter.mjs';
import { LiveTranscriber, LIVE_TRANSCRIPTION_MODEL } from './live-transcriber.mjs';
import { loadConferenceGlossary } from './conference-glossary.mjs';

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_TARGET_LANGUAGE = 'vi';
let targetLanguage = DEFAULT_TARGET_LANGUAGE;
const noiseReductionType = process.env.OPENAI_NOISE_REDUCTION || 'none';
const noiseReduction = ['near_field', 'far_field'].includes(noiseReductionType) ? { type: noiseReductionType } : null;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
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

const configurationError = !OPENAI_API_KEY || /^(sk-\.\.\.|API_KEY_CUA_BAN|your[_ -]?api[_ -]?key.*)$/i.test(OPENAI_API_KEY)
  ? 'Chưa có OpenAI API key thật. Điền OPENAI_API_KEY trong file .env rồi khởi động lại server.'
  : '';
if (configurationError) console.error(configurationError);

const app = express();
app.use(express.static('public'));
app.get('/', (_req, res) => res.redirect('/operator.html'));
app.get('/api/config', (req, res) => {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ targetLanguage, model: REALTIME_MODEL, transcriptionModel, glossary: glossary?.metadata || null, sessionActive: sessionsActive(), listenerUrl: `${base}/listen.html`, configurationError });
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
let lastError = configurationError;
let captionWarning = glossaryWarning;

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
  if (OPENAI_API_KEY) result = result.split(OPENAI_API_KEY).join('[hidden]');
  return result.replace(/sk-[A-Za-z0-9_.*-]+/g, '[hidden]');
}

function reportError(message) {
  lastError = scrubError(message);
  aiReady = false;
  console.error('OpenAI:', lastError);
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
  if (configurationError) {
    reportError(configurationError);
    return;
  }
  if (interpreter && !interpreter.closed) return;
  lastError = '';
  const session = new RealtimeInterpreter({
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
    broadcastStatus('OpenAI interpreter connected');
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
      lastError = 'Mất kết nối OpenAI. Bấm Dừng rồi Bắt đầu để thử lại.';
    }
    broadcastStatus('OpenAI disconnected');
    finishSourceIfDrained();
  });

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
  const requestedLanguage = new URL(req.url, 'http://localhost').searchParams.get('targetLanguage') ?? DEFAULT_TARGET_LANGUAGE;
  if (!isTranslationTarget(requestedLanguage)) {
    ws.close(1008, 'Translation target must be vi or en.');
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
  sourceFinishing = false;
  transcriptionModel = defaultTranscriptionModel;
  captionWarning = glossaryWarning;
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/ws/source') {
    sourceWss.handleUpgrade(req, socket, head, (ws) => sourceWss.emit('connection', ws, req));
  } else if (url.pathname === '/ws/listen') {
    listenerWss.handleUpgrade(req, socket, head, (ws) => listenerWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Cabin running on http://localhost:${server.address().port}`);
  console.log(`Continuous translation: English ↔ Vietnamese (${REALTIME_MODEL})`);
  if (PUBLIC_BASE_URL) console.log(`Listener URL: ${PUBLIC_BASE_URL}/listen.html`);
});

import 'dotenv/config';
import express from 'express';
import http from 'http';
import QRCode from 'qrcode';
import WebSocket, { WebSocketServer } from 'ws';
import { RealtimeInterpreter, REALTIME_MODEL, isTranslationTarget } from './realtime-interpreter.mjs';

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_TARGET_LANGUAGE = 'auto';
let targetLanguage = DEFAULT_TARGET_LANGUAGE;
const noiseReductionType = process.env.OPENAI_NOISE_REDUCTION || 'none';
const noiseReduction = ['near_field', 'far_field'].includes(noiseReductionType) ? { type: noiseReductionType } : null;
const requestedSilenceMs = Number(process.env.VAD_SILENCE_MS || 650);
const silenceDurationMs = Number.isFinite(requestedSilenceMs) && requestedSilenceMs >= 200 && requestedSilenceMs <= 2000 ? requestedSilenceMs : 650;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const configurationError = !OPENAI_API_KEY || /^(sk-\.\.\.|API_KEY_CUA_BAN|your[_ -]?api[_ -]?key.*)$/i.test(OPENAI_API_KEY)
  ? 'Chưa có OpenAI API key thật. Điền OPENAI_API_KEY trong file .env rồi khởi động lại server.'
  : '';
if (configurationError) console.error(configurationError);

const app = express();
app.use(express.static('public'));
app.get('/', (_req, res) => res.redirect('/operator.html'));
app.get('/api/config', (req, res) => {
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ targetLanguage, listenerUrl: `${base}/listen.html`, configurationError });
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
let aiReady = false;
let lastError = configurationError;

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
    error: lastError,
    message,
  };
}

function broadcastStatus(message = '') {
  broadcastJson(currentStatus(message));
}

function reportError(message) {
  // Authentication errors can echo credentials. Never forward those to browsers or logs.
  lastError = String(message);
  if (OPENAI_API_KEY) lastError = lastError.split(OPENAI_API_KEY).join('[hidden]');
  lastError = lastError.replace(/sk-[A-Za-z0-9_.*-]+/g, '[hidden]');
  aiReady = false;
  console.error('OpenAI:', lastError);
  broadcastStatus();
}

function openTranslationSession() {
  if (configurationError) {
    reportError(configurationError);
    return;
  }
  if (interpreter && !interpreter.closed) return;
  lastError = '';
  const session = new RealtimeInterpreter({
    apiKey: OPENAI_API_KEY, noiseReduction, silenceDurationMs, targetLanguage,
  });
  interpreter = session;
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
  session.on('source_transcript', transcript => {
    if (interpreter === session) broadcastJson({ type: 'source_transcript', ...transcript });
  });
  for (const type of ['source_turn', 'source_delta']) {
    session.on(type, caption => {
      if (interpreter === session) broadcastJson({ type, ...caption });
    });
  }
  session.on('caption_warning', message => {
    if (interpreter === session) broadcastJson({ type: 'caption_warning', message: String(message).replace(/sk-[A-Za-z0-9_.*-]+/g, '[hidden]') });
  });
  session.on('closed', () => {
    if (interpreter !== session) return;
    aiReady = false;
    if (sourceClient?.readyState === WebSocket.OPEN && !lastError) {
      lastError = 'Mất kết nối OpenAI. Bấm Dừng rồi Bắt đầu để thử lại.';
    }
    broadcastStatus('OpenAI disconnected');
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
}

function closeTranslationSession() {
  const session = interpreter;
  interpreter = null;
  session?.close();
  aiReady = false;
}

sourceWss.on('connection', (ws, req) => {
  const requestedLanguage = new URL(req.url, 'http://localhost').searchParams.get('targetLanguage') ?? DEFAULT_TARGET_LANGUAGE;
  if (!isTranslationTarget(requestedLanguage)) {
    ws.close(1008, 'Translation target must be auto, vi or en.');
    return;
  }
  if (sourceClient && sourceClient.readyState === WebSocket.OPEN) {
    sourceClient.close(1012, 'Replaced by new operator');
  }
  sourceClient = ws;
  targetLanguage = requestedLanguage;
  closeTranslationSession();
  broadcastJson({ type: 'session_reset' });
  openTranslationSession();
  broadcastStatus('Operator connected');

  ws.on('message', (data, isBinary) => {
    if (sourceClient !== ws) return;
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'translation_config') {
          if (!isTranslationTarget(msg.targetLanguage)) {
            ws.send(JSON.stringify({ type: 'config_error', message: 'Chiều dịch không hợp lệ. Chọn tự động, Anh → Việt hoặc Việt → Anh.' }));
            return;
          }
          targetLanguage = msg.targetLanguage;
          interpreter?.setTargetLanguage(targetLanguage);
          broadcastStatus('Translation settings updated');
        }
      } catch {}
      return;
    }
    if (!aiReady) return;
    interpreter?.appendAudio(data);
  });

  ws.on('close', () => {
    if (sourceClient !== ws) return;
    sourceClient = null;
    closeTranslationSession();
    broadcastStatus('Operator disconnected');
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
  console.log(`Translation: automatic or manual English ↔ Vietnamese (${REALTIME_MODEL})`);
  if (PUBLIC_BASE_URL) console.log(`Listener URL: ${PUBLIC_BASE_URL}/listen.html`);
});

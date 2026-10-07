import 'dotenv/config';
import express from 'express';
import http from 'http';
import QRCode from 'qrcode';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const TARGET_LANGUAGE = ['vi', 'en'].includes(process.env.TARGET_LANGUAGE) ? process.env.TARGET_LANGUAGE : 'vi';
let targetLanguage = TARGET_LANGUAGE;
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
  res.json({ targetLanguage: TARGET_LANGUAGE, listenerUrl: `${base}/listen.html`, configurationError });
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
let openaiWs = null;
let aiReady = false;
let lastError = configurationError;
let translatedChars = 0;
let audioChunks = 0;

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
  if (openaiWs && [WebSocket.OPEN, WebSocket.CONNECTING].includes(openaiWs.readyState)) return;
  lastError = '';

  const url = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
  const sessionWs = new WebSocket(url, {
    handshakeTimeout: 15000,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': 'conference-translation-operator',
    },
  });
  openaiWs = sessionWs;

  sessionWs.on('open', () => {
    if (openaiWs !== sessionWs) return;
    sessionWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper' },
          },
          output: { language: targetLanguage },
        },
      },
    }));
    aiReady = true;
    broadcastStatus('OpenAI translation connected');
  });

  sessionWs.on('message', (data) => {
    if (openaiWs !== sessionWs) return;
    let event;
    try { event = JSON.parse(data.toString()); } catch { return; }

    if (event.type === 'session.output_audio.delta' && event.delta) {
      audioChunks++;
      broadcastAudio(Buffer.from(event.delta, 'base64'));
      return;
    }

    if (event.type === 'session.output_transcript.delta' && event.delta) {
      translatedChars += event.delta.length;
      broadcastJson({ type: 'target_delta', delta: event.delta });
      return;
    }

    if (event.type === 'session.input_transcript.delta' && event.delta) {
      broadcastJson({ type: 'source_delta', delta: event.delta });
      return;
    }

    if (event.type === 'error') {
      reportError(event.error?.message || 'OpenAI translation error');
    }

    if (event.type === 'session.closed') {
      aiReady = false;
      broadcastStatus('Translation session closed');
    }
  });

  sessionWs.on('close', () => {
    if (openaiWs !== sessionWs) return;
    aiReady = false;
    if (sourceClient?.readyState === WebSocket.OPEN && !lastError) {
      lastError = 'Mất kết nối OpenAI. Bấm Dừng rồi Bắt đầu để thử lại.';
    }
    broadcastStatus('OpenAI disconnected');
  });

  sessionWs.on('error', (err) => {
    if (openaiWs !== sessionWs) return;
    const status = err.message.match(/Unexpected server response: (\d+)/)?.[1];
    const hints = {
      401: 'OpenAI từ chối API key (401). Kiểm tra khóa thật trong .env rồi khởi động lại server.',
      403: 'OpenAI từ chối quyền truy cập (403). Kiểm tra quyền của API key, project và khu vực truy cập.',
      404: 'Không truy cập được model hoặc endpoint (404). Kiểm tra quyền dùng gpt-realtime-translate.',
      429: 'OpenAI báo giới hạn (429). Kiểm tra Billing, số dư API và giới hạn sử dụng của project.',
    };
    reportError(hints[status] || `Không kết nối được OpenAI: ${err.message}`);
  });
}

function closeTranslationSession() {
  const sessionWs = openaiWs;
  openaiWs = null;
  if (sessionWs?.readyState === WebSocket.OPEN) {
    try { sessionWs.send(JSON.stringify({ type: 'session.close' })); } catch {}
    setTimeout(() => {
      try { sessionWs.close(); } catch {}
    }, 1500);
  } else if (sessionWs?.readyState === WebSocket.CONNECTING) {
    sessionWs.terminate();
  }
  aiReady = false;
}

sourceWss.on('connection', (ws, req) => {
  const requestedLanguage = new URL(req.url, 'http://localhost').searchParams.get('targetLanguage') || TARGET_LANGUAGE;
  if (!['vi', 'en'].includes(requestedLanguage)) {
    ws.close(1008, 'Unsupported target language');
    return;
  }
  if (sourceClient && sourceClient.readyState === WebSocket.OPEN) {
    sourceClient.close(1012, 'Replaced by new operator');
  }
  sourceClient = ws;
  closeTranslationSession();
  targetLanguage = requestedLanguage;
  translatedChars = 0;
  audioChunks = 0;
  openTranslationSession();
  broadcastStatus('Operator connected');

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
      return;
    }
    if (sourceClient !== ws || !aiReady || openaiWs?.readyState !== WebSocket.OPEN) return;
    openaiWs.send(JSON.stringify({
      type: 'session.input_audio_buffer.append',
      audio: Buffer.from(data).toString('base64'),
    }));
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
  console.log(`Target language: ${TARGET_LANGUAGE}`);
  if (PUBLIC_BASE_URL) console.log(`Listener URL: ${PUBLIC_BASE_URL}/listen.html`);
});

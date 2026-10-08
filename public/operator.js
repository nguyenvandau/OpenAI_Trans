const $ = id => document.getElementById(id);
let stream, ctx, source, processor, ws;
let running = false, stopping = false, stopTask = null;
let lastReportedError = '', selectionEdited = false;
let pendingAudio = [], pendingBytes = 0, flushCapture = null;
const MAX_BUFFERED_BYTES = 24000 * 2 * 20;

function log(s) { $('log').textContent = `[${new Date().toLocaleTimeString()}] ${s}\n` + $('log').textContent; }
function wsUrl(path) { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`; }
function selectedTargetLanguage() { return $('manualDirection').value; }
function translationLabel(language) { return language === 'en' ? 'Việt → Anh' : 'Anh → Việt'; }
function updateTranslationControls() {
  $('translationHint').textContent = `Dịch liên tục ${translationLabel(selectedTargetLanguage())} khi diễn giả đang nói. Đổi chiều dịch khi diễn giả đổi ngôn ngữ.`;
}
function changeTranslationSettings() {
  selectionEdited = true;
  updateTranslationControls();
  if (ws?.readyState === WebSocket.OPEN && !stopping) {
    ws.send(JSON.stringify({ type: 'translation_config', targetLanguage: selectedTargetLanguage() }));
  }
}

async function loadConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  $('listenerUrl').textContent = cfg.listenerUrl;
  $('listenerUrl').href = cfg.listenerUrl;
  $('qr').src = `/api/qr.png?t=${Date.now()}`;
  if (!selectionEdited && !running && ['vi', 'en'].includes(cfg.targetLanguage)) {
    $('manualDirection').value = cfg.targetLanguage;
    updateTranslationControls();
  }
  if (cfg.configurationError) {
    $('status').textContent = 'Chưa cấu hình API key';
    $('detail').textContent = cfg.configurationError;
  }
}

async function refreshDevices() {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach(t => t.stop());
  } catch (error) { log('Chưa có quyền thu âm: ' + error.message); }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  $('device').replaceChildren(...devices.map((device, index) => new Option(device.label || 'Audio input ' + (index + 1), device.deviceId)));
}

function sendAudio(audio) {
  if (!running) return;
  const socket = ws;
  if (socket?.readyState === WebSocket.OPEN) {
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      lastReportedError = 'Kết nối nguồn âm thanh quá chậm. Hãy kiểm tra mạng rồi bắt đầu lại.';
      $('detail').textContent = lastReportedError;
      stop();
      return;
    }
    socket.send(audio);
  } else if (socket?.readyState === WebSocket.CONNECTING) {
    pendingAudio.push(audio);
    pendingBytes += audio.byteLength;
    if (pendingBytes > MAX_BUFFERED_BYTES) {
      lastReportedError = 'Chưa nối được tới server sau 20 giây thu âm.';
      $('detail').textContent = lastReportedError;
      stop();
    }
  }
  const pcm = new DataView(audio);
  let sum = 0;
  for (let offset = 0; offset < audio.byteLength; offset += 2) sum += (pcm.getInt16(offset, true) / 32768) ** 2;
  $('meterFill').style.width = `${Math.min(100, Math.sqrt(sum / (audio.byteLength / 2)) * 350)}%`;
}

async function start() {
  if (running || stopping) return;
  running = true;
  lastReportedError = '';
  pendingAudio = [];
  pendingBytes = 0;
  $('start').disabled = true;
  $('detail').textContent = '';
  $('status').textContent = 'Đang mở nguồn âm thanh';
  const deviceId = $('device').value;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  });
  ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.resume();
  await ctx.audioWorklet.addModule('/audio-capture-worklet.js');
  source = ctx.createMediaStreamSource(stream);
  processor = new AudioWorkletNode(ctx, 'cabin-audio-capture', { channelCount: 1, channelCountMode: 'explicit' });
  processor.port.onmessage = event => {
    if (event.data.type === 'audio') sendAudio(event.data.audio);
    if (event.data.type === 'flushed') flushCapture?.();
  };
  const zeroGain = ctx.createGain();
  zeroGain.gain.value = 0;
  processor.connect(zeroGain);
  zeroGain.connect(ctx.destination);

  const initialLanguage = selectedTargetLanguage();
  const socket = ws = new WebSocket(wsUrl(`/ws/source?targetLanguage=${initialLanguage}`));
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    for (const audio of pendingAudio) socket.send(audio);
    pendingAudio = [];
    pendingBytes = 0;
    if (!stopping) {
      $('status').textContent = 'Đang kết nối OpenAI';
      $('stop').disabled = false;
      if (selectedTargetLanguage() !== initialLanguage) changeTranslationSettings();
    }
    log('Nguồn âm thanh đã nối tới server.');
  };
  socket.onclose = event => {
    log('WebSocket nguồn âm thanh đã đóng.');
    if (!stopping) {
      lastReportedError ||= event.code === 1008 ? 'Máy chủ chưa nhận nguồn âm thanh. Chờ phiên dịch trước hoàn tất rồi bắt đầu lại.'
        : event.code === 1012 ? 'Một màn hình điều khiển khác đã tiếp quản nguồn âm thanh.' : 'Mất kết nối nguồn âm thanh. Kiểm tra mạng rồi bắt đầu lại.';
      stop().catch(error => log(error.message));
    }
  };
  socket.onerror = () => log('Lỗi WebSocket nguồn âm thanh.');
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'config_error') { log(message.message); $('detail').textContent = message.message; return; }
    if (message.type !== 'status') return;
    if (message.error) {
      $('status').textContent = 'Lỗi dịch';
      $('detail').textContent = message.error;
      if (lastReportedError !== message.error) log(message.error);
      lastReportedError = message.error;
    } else {
      lastReportedError = '';
      $('detail').textContent = '';
      $('status').textContent = message.draining || stopping ? 'Đang hoàn tất phần dịch cuối…'
        : message.aiReady ? `Đang dịch song song ${translationLabel(message.targetLanguage)}` : 'Đang kết nối OpenAI';
    }
    if (message.message === 'Translation settings updated') log(`Đã đổi chiều dịch sang ${translationLabel(message.targetLanguage)}.`);
  };
  source.connect(processor);
}

function waitForSocket(socket, eventName, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(result) { clearTimeout(timer); socket.removeEventListener(eventName, onEvent); resolve(result); }
    function onEvent() { finish(true); }
    socket.addEventListener(eventName, onEvent, { once: true });
  });
}

function stop() {
  if (stopTask) return stopTask;
  stopping = true;
  $('start').disabled = true;
  $('stop').disabled = true;
  $('manualDirection').disabled = true;
  $('status').textContent = 'Đang hoàn tất phần dịch cuối…';
  stopTask = (async () => {
    if (processor && ctx?.state === 'running') {
      await new Promise(resolve => {
        const timer = setTimeout(done, 1000);
        function done() { clearTimeout(timer); flushCapture = null; resolve(); }
        flushCapture = done;
        processor.port.postMessage({ type: 'flush' });
      });
    }
    running = false;
    try { processor?.disconnect(); source?.disconnect(); } catch {}
    stream?.getTracks().forEach(track => track.stop());
    try { await ctx?.close(); } catch {}
    processor = source = ctx = stream = null;
    const socket = ws;
    if (socket?.readyState === WebSocket.CONNECTING) await waitForSocket(socket, 'open', 8000);
    if (socket?.readyState === WebSocket.OPEN) {
      const closed = waitForSocket(socket, 'close', 35000);
      socket.send(JSON.stringify({ type: 'stop' }));
      if (!await closed) {
        lastReportedError ||= 'Chưa nhận được xác nhận hoàn tất phiên dịch. Hãy kiểm tra kết nối.';
        socket.close();
      }
    } else { try { socket?.close(); } catch {} }
    // An unexpected source disconnect still leaves OpenAI finishing its last audio.
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      let config;
      try { config = await fetch('/api/config', { signal: AbortSignal.timeout(3000) }).then(response => response.json()); } catch { break; }
      if (!config.sessionActive) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    ws = null;
    pendingAudio = [];
    pendingBytes = 0;
    $('meterFill').style.width = '0%';
    $('status').textContent = lastReportedError ? 'Lỗi dịch' : 'Đã dừng';
    $('detail').textContent = lastReportedError;
  })().finally(() => {
    stopping = false;
    stopTask = null;
    $('start').disabled = false;
    $('stop').disabled = true;
    $('manualDirection').disabled = false;
  });
  return stopTask;
}

$('toggleQr').onclick = () => {
  const show = $('qrPanel').hidden;
  $('qrPanel').hidden = !show;
  $('operatorGrid').classList.toggle('qr-visible', show);
  $('toggleQr').setAttribute('aria-expanded', String(show));
  $('toggleQr').textContent = show ? 'Ẩn QR nghe' : 'Hiện QR nghe';
};
$('refresh').onclick = () => refreshDevices().catch(error => log(error.message));
$('start').onclick = () => start().catch(async error => { lastReportedError = error.message; await stop(); log(error.message); });
$('stop').onclick = () => stop().catch(error => log(error.message));
$('manualDirection').onchange = changeTranslationSettings;
loadConfig().catch(error => log(error.message));
refreshDevices().catch(error => log(error.message));

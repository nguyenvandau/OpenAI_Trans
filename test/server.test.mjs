import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for message')), 4000);
    function finish(error, message) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (error) reject(error); else resolve(message);
    }
    function onError(error) { finish(error); }
    function onMessage(data, isBinary) {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (predicate(message)) finish(null, message);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}
function waitForStatus(ws, predicate) { return waitForMessage(ws, message => message.type === 'status' && predicate(message)); }

for (const apiKey of ['', 'sk-...']) {
  test(`translation configuration and presentation stay consistent across connections (${apiKey ? 'sample' : 'missing'} key)`, { timeout: 20000 }, async t => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...process.env, OPENAI_API_KEY: apiKey, GEMINI_API_KEY: apiKey && 'AIza...', TRANSLATION_PROVIDER: '',
        PORT: '0', PUBLIC_BASE_URL: 'http://192.0.2.10:3000', OPENAI_SOURCE_TRANSCRIPTION: 'gpt-live-transcribe',
      },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const sockets = [];
    t.after(async () => {
      for (const ws of sockets) ws.terminate();
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    });
    const port = await new Promise((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 4000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = stdout.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const getConfig = () => fetch(`http://localhost:${port}/api/config`).then(r => r.json());
    const postPresentation = body => fetch(`http://localhost:${port}/api/presentation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const config = await getConfig();
    const emptyPresentation = { speakerName: '', talkTitle: '', speakerPhotoUrl: '', showSpeakerPhoto: false, showListenerQr: false };
    assert.deepEqual(config.presentation, emptyPresentation);
    assert.equal(config.listenerUrl, 'http://192.0.2.10:3000/listen.html');
    assert.match(config.configurationError, /API key thật/);
    assert.ok(!JSON.stringify(config).includes('sk-'));
    assert.equal(config.model, 'gpt-realtime-translate');
    assert.equal(config.provider, 'openai');
    assert.deepEqual(Object.keys(config.providers), ['openai', 'gemini']);
    assert.equal(config.providers.openai.configurationError, config.configurationError);
    assert.equal(config.providers.gemini.model, 'gemini-3.5-live-translate-preview');
    assert.match(config.providers.gemini.configurationError, /GEMINI_API_KEY/);
    assert.ok(!JSON.stringify(config).includes('AIza'));
    assert.equal(config.transcriptionModel, 'gpt-live-transcribe');
    assert.equal(config.glossary.entries, 959);
    assert.equal(config.glossary.keywordsEn, 340);
    assert.equal(config.glossary.keywordsVi, 290);
    assert.equal(config.glossary.bundles, 4);
    assert.equal(config.glossary.supplementEntries, 4);
    assert.equal(config.glossary.duplicateEntries, 1938);
    assert.deepEqual(config.glossary.sourceFiles, [
      'IFR2026_glossary_EN-VI.csv', 'IFR2026_glossary_EN-VI_v2.csv',
      'IFR2026_glossary_EN-VI_v3.csv', 'IFR2026_glossary_EN-VI_v4.csv',
      'IFR2026_glossary_EN-VI_supplement.csv',
    ]);
    assert.equal(config.targetLanguage, 'vi');
    assert.equal(config.sessionActive, false);
    assert.equal('voice' in config, false);
    assert.equal('voices' in config, false);
    function connect(path) { const ws = new WebSocket(`ws://localhost:${port}${path}`); sockets.push(ws); return ws; }

    const listener = connect('/ws/listen');
    const initial = await waitForStatus(listener, () => true);
    assert.equal(initial.sourceConnected, false);
    assert.equal(initial.error, config.configurationError);
    assert.equal('voice' in initial, false);
    assert.deepEqual(initial.presentation, emptyPresentation);

    // Operator information can be prepared before any microphone session starts.
    const preparedPresentation = { ...emptyPresentation, speakerName: 'Nguyễn Văn A', talkTitle: 'Điều trị và thực hành lâm sàng' };
    const listenerPrepared = waitForMessage(listener, message => message.type === 'presentation_update');
    const prepared = await postPresentation({
      speakerName: `${' '.repeat(180)}Nguyễn\t Văn  A\n`,
      talkTitle: '  Điều trị\n và   thực hành\t lâm sàng  ',
    });
    assert.equal(prepared.status, 200);
    assert.deepEqual(await prepared.json(), preparedPresentation);
    assert.deepEqual((await listenerPrepared).presentation, preparedPresentation);
    const preparedConfig = await getConfig();
    assert.deepEqual(preparedConfig.presentation, preparedPresentation);
    assert.equal(preparedConfig.targetLanguage, config.targetLanguage);
    assert.equal(preparedConfig.sessionActive, false);

    const listenerSawSource = waitForStatus(listener, status => status.sourceConnected);
    const source = connect('/ws/source?targetLanguage=en');
    const operatorStatus = await waitForStatus(source, () => true);
    assert.equal(operatorStatus.aiReady, false);
    assert.equal(operatorStatus.targetLanguage, 'en');
    assert.equal(operatorStatus.error, config.configurationError);
    assert.deepEqual(operatorStatus.presentation, preparedPresentation);
    const connectedStatus = await listenerSawSource;
    assert.equal(connectedStatus.error, config.configurationError);
    assert.deepEqual(connectedStatus.presentation, preparedPresentation);

    const listenerCountChanged = waitForStatus(listener, status => status.listeners === 2);
    const lateListener = connect('/ws/listen');
    const lateStatus = await waitForStatus(lateListener, () => true);
    assert.equal(lateStatus.error, config.configurationError);
    assert.deepEqual(lateStatus.presentation, preparedPresentation);
    assert.equal((await listenerCountChanged).error, config.configurationError);

    // Changing the current speaker/talk reaches everyone without restarting translation.
    let currentPresentation = { ...emptyPresentation, speakerName: 'Dr. B', talkTitle: 'Updates for 2026' };
    const presentationUpdates = [listener, lateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const updated = await postPresentation(currentPresentation);
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), currentPresentation);
    for (const event of await Promise.all(presentationUpdates)) {
      assert.deepEqual(event.presentation, currentPresentation);
    }
    const updatedConfig = await getConfig();
    assert.equal(updatedConfig.targetLanguage, 'en');
    assert.equal(updatedConfig.sessionActive, preparedConfig.sessionActive);
    assert.deepEqual(updatedConfig.presentation, currentPresentation);

    const noPhoto = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', showSpeakerPhoto: true });
    assert.equal(noPhoto.status, 400);
    assert.deepEqual((await getConfig()).presentation, currentPresentation);

    let resetsAfterMetadataUpdate = 0;
    for (const ws of [listener, lateListener, source]) {
      ws.on('message', (data, isBinary) => {
        if (!isBinary && JSON.parse(data.toString()).type === 'session_reset') resetsAfterMetadataUpdate++;
      });
    }
    const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZXUAAAAASUVORK5CYII=', 'base64');
    const photoData = `data:image/png;base64,${photoBytes.toString('base64')}`;
    const photoUpdates = [listener, lateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const uploaded = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', speakerPhoto: photoData, showSpeakerPhoto: true });
    assert.equal(uploaded.status, 200);
    currentPresentation = await uploaded.json();
    assert.match(currentPresentation.speakerPhotoUrl, /^\/api\/speaker-photo\/[a-f0-9]{64}$/);
    assert.equal(currentPresentation.showSpeakerPhoto, true);
    for (const event of await Promise.all(photoUpdates)) {
      assert.deepEqual(event.presentation, currentPresentation);
      assert.ok(!JSON.stringify(event).includes('base64'));
    }
    const imageResponse = await fetch(`http://localhost:${port}${currentPresentation.speakerPhotoUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(imageResponse.headers.get('cache-control'), /private.*max-age=3600.*immutable/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), photoBytes);
    assert.equal((await fetch(`http://localhost:${port}/api/speaker-photo/${'f'.repeat(64)}`)).status, 404);
    assert.equal((await fetch(`http://localhost:${port}/api/speaker-photo/not-an-image`)).status, 404);

    const photoLateListener = connect('/ws/listen');
    assert.deepEqual((await waitForStatus(photoLateListener, () => true)).presentation, currentPresentation);
    const legacyUpdates = [listener, lateListener, photoLateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const legacyUpdate = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026' });
    assert.equal(legacyUpdate.status, 200);
    assert.deepEqual(await legacyUpdate.json(), currentPresentation);
    for (const event of await Promise.all(legacyUpdates)) assert.deepEqual(event.presentation, currentPresentation);

    const hiddenUpdates = [listener, lateListener, photoLateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const hiddenPhoto = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', showSpeakerPhoto: false });
    assert.equal(hiddenPhoto.status, 200);
    currentPresentation = { ...currentPresentation, showSpeakerPhoto: false };
    assert.deepEqual(await hiddenPhoto.json(), currentPresentation);
    for (const event of await Promise.all(hiddenUpdates)) assert.deepEqual(event.presentation, currentPresentation);
    const shownUpdates = [listener, lateListener, photoLateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const shownPhoto = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', showSpeakerPhoto: true });
    assert.equal(shownPhoto.status, 200);
    currentPresentation = { ...currentPresentation, showSpeakerPhoto: true };
    assert.deepEqual(await shownPhoto.json(), currentPresentation);
    for (const event of await Promise.all(shownUpdates)) assert.deepEqual(event.presentation, currentPresentation);
    assert.equal(source.readyState, WebSocket.OPEN);
    assert.equal(resetsAfterMetadataUpdate, 0);
    const photoConfig = await getConfig();
    assert.equal(photoConfig.targetLanguage, 'en');
    assert.equal(photoConfig.sessionActive, updatedConfig.sessionActive);

    const qrEnabledUpdates = [listener, lateListener, photoLateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const enabledQr = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', showListenerQr: true });
    assert.equal(enabledQr.status, 200);
    currentPresentation = { ...currentPresentation, showListenerQr: true };
    assert.deepEqual(await enabledQr.json(), currentPresentation);
    for (const event of await Promise.all(qrEnabledUpdates)) assert.deepEqual(event.presentation, currentPresentation);
    const qrLateListener = connect('/ws/listen');
    const qrLateStatus = await waitForStatus(qrLateListener, () => true);
    assert.deepEqual(qrLateStatus.presentation, currentPresentation);
    assert.equal(qrLateStatus.sourceConnected, true);
    const qrImage = await fetch(`http://localhost:${port}/api/qr.png`);
    assert.equal(qrImage.status, 200);
    assert.equal(qrImage.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await qrImage.arrayBuffer()).subarray(0, 8), photoBytes.subarray(0, 8));

    const retainedQrUpdates = [listener, lateListener, photoLateListener, qrLateListener, source].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const retainedQr = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026' });
    assert.equal(retainedQr.status, 200);
    assert.deepEqual(await retainedQr.json(), currentPresentation);
    for (const event of await Promise.all(retainedQrUpdates)) assert.deepEqual(event.presentation, currentPresentation);

    const rejectedQrPhotoBytes = Buffer.concat([photoBytes, Buffer.from([254])]);
    const rejectedQrUpload = await postPresentation({
      speakerName: 'Changed name', talkTitle: 'Changed talk', showListenerQr: 'true',
      speakerPhoto: `data:image/png;base64,${rejectedQrPhotoBytes.toString('base64')}`,
    });
    assert.equal(rejectedQrUpload.status, 400);
    const rejectedQrPhotoId = createHash('sha256').update(rejectedQrPhotoBytes).digest('hex');
    assert.equal((await fetch(`http://localhost:${port}/api/speaker-photo/${rejectedQrPhotoId}`)).status, 404);
    assert.deepEqual((await getConfig()).presentation, currentPresentation);
    assert.equal(source.readyState, WebSocket.OPEN);
    assert.equal(resetsAfterMetadataUpdate, 0);
    const enabledQrConfig = await getConfig();
    assert.equal(enabledQrConfig.targetLanguage, 'en');
    assert.equal(enabledQrConfig.sessionActive, updatedConfig.sessionActive);

    const oversizedPhotoBytes = Buffer.alloc(128 * 1024 + 1);
    photoBytes.subarray(0, 8).copy(oversizedPhotoBytes);
    for (const invalidPhotoFields of [
      { showSpeakerPhoto: 'true' }, { showSpeakerPhoto: null },
      { showListenerQr: 1 }, { showListenerQr: null },
      { speakerPhoto: 42 }, { speakerPhoto: 'https://example.com/speaker.png' },
      { speakerPhoto: photoData.replace('image/png', 'image/jpeg') },
      { speakerPhoto: 'data:image/png;base64,!!!!' },
      { speakerPhoto: 'data:image/png;base64,aGVsbG8=' },
      { speakerPhoto: 'data:image/png;base64,iVBORw0KGgp=' },
      { speakerPhoto: `data:image/png;base64,${oversizedPhotoBytes.toString('base64')}` },
    ]) {
      const rejected = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', ...invalidPhotoFields });
      assert.equal(rejected.status, 400);
      assert.deepEqual((await getConfig()).presentation, currentPresentation);
    }
    const rejectedPhotoBytes = Buffer.concat([photoBytes, Buffer.from([255])]);
    const rejectedUpload = await postPresentation({
      speakerName: 'x'.repeat(161), talkTitle: 'Talk',
      speakerPhoto: `data:image/png;base64,${rejectedPhotoBytes.toString('base64')}`,
    });
    assert.equal(rejectedUpload.status, 400);
    const rejectedId = createHash('sha256').update(rejectedPhotoBytes).digest('hex');
    assert.equal((await fetch(`http://localhost:${port}/api/speaker-photo/${rejectedId}`)).status, 404);
    assert.deepEqual((await getConfig()).presentation, currentPresentation);

    for (const invalidPresentation of [
      {}, { speakerName: 'Missing title' }, { speakerName: null, talkTitle: 'Talk' },
      { speakerName: 'Speaker', talkTitle: 42 },
      { speakerName: 'x'.repeat(161), talkTitle: 'Talk' },
      { speakerName: 'Speaker', talkTitle: 'x'.repeat(301) },
    ]) {
      const rejected = await postPresentation(invalidPresentation);
      assert.equal(rejected.status, 400);
      assert.deepEqual((await getConfig()).presentation, currentPresentation);
    }
    const malformed = await fetch(`http://localhost:${port}/api/presentation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"speakerName":',
    });
    assert.equal(malformed.status, 400);
    const oversized = await postPresentation({ speakerName: 'x'.repeat(400 * 1024), talkTitle: 'Talk' });
    assert.equal(oversized.status, 413);
    assert.deepEqual((await getConfig()).presentation, currentPresentation);

    const changed = waitForStatus(listener, status => status.message === 'Translation settings updated');
    source.send(JSON.stringify({ type: 'translation_config', targetLanguage: 'vi' }));
    assert.equal((await changed).targetLanguage, 'vi');
    const invalid = waitForMessage(source, message => message.type === 'config_error');
    source.send(JSON.stringify({ type: 'translation_config', targetLanguage: 'auto' }));
    assert.match((await invalid).message, /không hợp lệ/);
    assert.equal((await getConfig()).targetLanguage, 'vi');

    const invalidProvider = connect('/ws/source?targetLanguage=vi&provider=other');
    assert.equal((await once(invalidProvider, 'close'))[0], 1008);
    for (const language of ['auto', 'fr']) {
      const invalidSource = connect(`/ws/source?targetLanguage=${language}`);
      const [code] = await once(invalidSource, 'close');
      assert.equal(code, 1008);
    }
    const disconnected = waitForStatus(listener, status => !status.sourceConnected);
    const stopped = waitForMessage(source, message => message.type === 'stopped');
    const closed = once(source, 'close');
    source.send(JSON.stringify({ type: 'stop' }));
    await stopped;
    assert.equal((await closed)[0], 1000);
    const stoppedStatus = await disconnected;
    assert.equal(stoppedStatus.error, config.configurationError);
    assert.deepEqual(stoppedStatus.presentation, currentPresentation);
    assert.deepEqual((await getConfig()).presentation, currentPresentation);

    const restarted = connect('/ws/source');
    const restartedStatus = await waitForStatus(restarted, () => true);
    assert.equal(restartedStatus.targetLanguage, 'vi');
    assert.deepEqual(restartedStatus.presentation, currentPresentation);

    const qrDisabledUpdates = [listener, lateListener, photoLateListener, qrLateListener, restarted].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const resetsBeforeDisablingQr = resetsAfterMetadataUpdate;
    const disabledQr = await postPresentation({ speakerName: 'Dr. B', talkTitle: 'Updates for 2026', showListenerQr: false });
    assert.equal(disabledQr.status, 200);
    currentPresentation = { ...currentPresentation, showListenerQr: false };
    assert.deepEqual(await disabledQr.json(), currentPresentation);
    for (const event of await Promise.all(qrDisabledUpdates)) assert.deepEqual(event.presentation, currentPresentation);
    assert.equal(restarted.readyState, WebSocket.OPEN);
    assert.equal(resetsAfterMetadataUpdate, resetsBeforeDisablingQr);
    const disabledQrConfig = await getConfig();
    assert.deepEqual(disabledQrConfig.presentation, currentPresentation);
    assert.equal(disabledQrConfig.targetLanguage, 'vi');
    assert.equal(disabledQrConfig.sessionActive, updatedConfig.sessionActive);

    const clearedUpdates = [listener, lateListener, restarted].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const cleared = await postPresentation({ speakerName: ' \n\t ', talkTitle: '\t  ' });
    assert.equal(cleared.status, 200);
    const blankNamesWithPhoto = { ...currentPresentation, speakerName: '', talkTitle: '' };
    assert.deepEqual(await cleared.json(), blankNamesWithPhoto);
    for (const event of await Promise.all(clearedUpdates)) {
      assert.deepEqual(event.presentation, blankNamesWithPhoto);
    }
    assert.deepEqual((await getConfig()).presentation, blankNamesWithPhoto);
    const removedUpdates = [listener, lateListener, restarted].map(ws =>
      waitForMessage(ws, message => message.type === 'presentation_update'));
    const removedPhoto = await postPresentation({ speakerName: '', talkTitle: '', speakerPhoto: null, showSpeakerPhoto: true });
    assert.equal(removedPhoto.status, 200);
    assert.deepEqual(await removedPhoto.json(), emptyPresentation);
    for (const event of await Promise.all(removedUpdates)) assert.deepEqual(event.presentation, emptyPresentation);
    assert.deepEqual((await getConfig()).presentation, emptyPresentation);

    // Old photo URLs expire from server memory; the currently selected photo remains available.
    let firstCachedUrl, lastCachedUrl;
    for (let index = 0; index < 17; index++) {
      const bytes = Buffer.concat([photoBytes, Buffer.from([index])]);
      const changedPhoto = waitForMessage(listener, message => message.type === 'presentation_update');
      const response = await postPresentation({
        speakerName: '', talkTitle: '', speakerPhoto: `data:image/png;base64,${bytes.toString('base64')}`,
      });
      assert.equal(response.status, 200);
      const cached = await response.json();
      if (index === 0) firstCachedUrl = cached.speakerPhotoUrl;
      lastCachedUrl = cached.speakerPhotoUrl;
      assert.deepEqual((await changedPhoto).presentation, cached);
    }
    assert.equal((await fetch(`http://localhost:${port}${firstCachedUrl}`)).status, 404);
    assert.equal((await fetch(`http://localhost:${port}${currentPresentation.speakerPhotoUrl}`)).status, 404);
    assert.equal((await fetch(`http://localhost:${port}${lastCachedUrl}`)).status, 200);
    assert.equal((await getConfig()).presentation.speakerPhotoUrl, lastCachedUrl);

    // The operator picks Gemini per session; without its key the reason is shown, not a silent stall.
    const gemini = connect('/ws/source?targetLanguage=en&provider=gemini');
    const geminiStatus = await waitForStatus(gemini, status => status.provider === 'gemini');
    assert.match(geminiStatus.error, /GEMINI_API_KEY/);
    assert.equal(geminiStatus.targetLanguage, 'en');
    assert.equal(geminiStatus.aiReady, false);
    const geminiConfig = await getConfig();
    assert.equal(geminiConfig.provider, 'gemini');
    assert.equal(geminiConfig.model, 'gemini-3.5-live-translate-preview');
    assert.equal(geminiConfig.configurationError, geminiConfig.providers.gemini.configurationError);
  });
}

test('a malformed Host header or request target on a WebSocket upgrade cannot crash the shared server', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, OPENAI_API_KEY: '', GEMINI_API_KEY: '', TRANSLATION_PROVIDER: '', PORT: '0', PUBLIC_BASE_URL: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 4000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const upgrade = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';
  // Anyone on the venue Wi-Fi can send these; the process holds every listener and the AI session.
  for (const request of [`GET /ws/listen HTTP/1.1\r\nHost: bad host\r\n${upgrade}`, `GET http://[bad/ws/listen HTTP/1.1\r\nHost: localhost\r\n${upgrade}`]) {
    await new Promise(resolve => {
      const socket = connectTcp(port, '127.0.0.1', () => socket.write(request));
      socket.once('data', () => { socket.destroy(); resolve(); });
      socket.once('close', resolve);
      socket.on('error', () => {});
    });
  }
  const config = await fetch(`http://localhost:${port}/api/config`).then(response => response.json());
  assert.equal(config.sessionActive, false);
  assert.equal(child.exitCode, null);
  const listener = new WebSocket(`ws://localhost:${port}/ws/listen`);
  t.after(() => listener.terminate());
  await once(listener, 'open');
});

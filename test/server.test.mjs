import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

function waitForStatus(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for status')), 4000);
    function finish(error, status) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (error) reject(error); else resolve(status);
    }
    function onError(error) { finish(error); }
    function onMessage(data, isBinary) {
      if (isBinary) return;
      const status = JSON.parse(data.toString());
      if (status.type === 'status' && predicate(status)) finish(null, status);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

for (const apiKey of ['', 'sk-...']) {
  test(`missing or sample key stays visible across connections (${apiKey ? 'sample' : 'missing'})`, { timeout: 15000 }, async (t) => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, OPENAI_API_KEY: apiKey, PORT: '0', PUBLIC_BASE_URL: 'http://192.0.2.10:3000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sockets = [];
    t.after(async () => {
      for (const ws of sockets) ws.terminate();
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    });
    // No source audio or real credentials are used by this regression test.
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
    const config = await fetch(`http://localhost:${port}/api/config`).then(r => r.json());
    assert.equal(config.listenerUrl, 'http://192.0.2.10:3000/listen.html');
    assert.match(config.configurationError, /API key thật/);
    assert.ok(!JSON.stringify(config).includes('sk-'));

    function connect(path) {
      const ws = new WebSocket(`ws://localhost:${port}${path}`);
      sockets.push(ws);
      return ws;
    }
    const listener = connect('/ws/listen');
    const initial = await waitForStatus(listener, () => true);
    assert.equal(initial.sourceConnected, false);
    assert.equal(initial.error, config.configurationError);

    const listenerSawSource = waitForStatus(listener, status => status.sourceConnected);
    const source = connect('/ws/source?targetLanguage=en');
    const operatorStatus = await waitForStatus(source, () => true);
    assert.equal(operatorStatus.aiReady, false);
    assert.equal(operatorStatus.targetLanguage, 'en');
    assert.equal(operatorStatus.error, config.configurationError);
    assert.equal((await listenerSawSource).error, config.configurationError);

    const listenerCountChanged = waitForStatus(listener, status => status.listeners === 2);
    const lateListener = connect('/ws/listen');
    assert.equal((await waitForStatus(lateListener, () => true)).error, config.configurationError);
    assert.equal((await listenerCountChanged).error, config.configurationError);

    const sourceDisconnected = waitForStatus(listener, status => !status.sourceConnected);
    source.close();
    assert.equal((await sourceDisconnected).error, config.configurationError);
    const vietnameseSource = connect('/ws/source?targetLanguage=vi');
    assert.equal((await waitForStatus(vietnameseSource, () => true)).targetLanguage, 'vi');
    const invalidSource = connect('/ws/source?targetLanguage=fr');
    const [closeCode] = await once(invalidSource, 'close');
    assert.equal(closeCode, 1008);
  });
}

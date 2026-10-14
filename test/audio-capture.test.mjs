import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('worklet sends continuous PCM including silence, then flushes the last samples exactly once', () => {
  let Capture;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(new URL('../public/audio-capture-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: message => messages.push(message) }; },
    registerProcessor: (_name, Processor) => Capture = Processor,
    ArrayBuffer, DataView,
  });
  const capture = new Capture();
  for (let i = 0; i < 40; i++) capture.process([[new Float32Array(128)]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].audio.byteLength, 9600);
  assert.ok(new Uint8Array(messages[0].audio).every(value => value === 0));
  capture.process([[Float32Array.from([-1, 0.5, 1])]]);
  capture.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages[1].audio.byteLength, (320 + 3) * 2);
  const tail = new DataView(messages[1].audio);
  assert.equal(tail.getInt16(320 * 2, true), -32768);
  assert.equal(tail.getInt16(321 * 2, true), 16383);
  assert.equal(tail.getInt16(322 * 2, true), 32767);
  assert.equal(messages[2].type, 'flushed');
  assert.equal(capture.process([[new Float32Array(128)]]), false);
  assert.equal(messages.length, 3);
});

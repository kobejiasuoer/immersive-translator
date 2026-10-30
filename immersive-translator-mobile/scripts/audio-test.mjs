import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "ita-audio-tests-"));
const output = join(directory, "audio.mjs");
const source = await readFile(new URL("../src/services/audio.ts", import.meta.url), "utf8");
let tests = 0;
const originalWarn = console.warn;
try {
  await build({
    stdin: { contents: `${source}\nexport { WORKLET_SRC, makeFallbackBlockHandler, assemble };`, resolveDir: fileURLToPath(new URL("../src/services", import.meta.url)), sourcefile: "audio.ts", loader: "ts" },
    outfile: output, bundle: true, platform: "browser", format: "esm",
    plugins: [{ name: "device-preview-fixture", setup(api) {
      api.onResolve({ filter: /.*/ }, args => args.path === "./device" ? { path: args.path, namespace: "device-fixture" } : undefined);
      api.onLoad({ filter: /.*/, namespace: "device-fixture" }, () => ({ contents: "export async function invoke(){return null;}", loader: "js" }));
    } }],
  });
  const api = await import(pathToFileURL(output).href);
  function processor(rate) {
    let Constructor; const messages = [];
    class Base { constructor() { this.port = { postMessage: value => messages.push(value) }; } }
    vm.runInNewContext(api.WORKLET_SRC, { AudioWorkletProcessor: Base, sampleRate: rate, Float32Array, Int16Array, registerProcessor(_name, value) { Constructor = value; } });
    return { instance: new Constructor(), messages };
  }
  function expectedPcm(input, rate) {
    const samples = [], ratio = rate / 16000;
    for (let pos = 0; pos < input.length; pos += ratio) {
      const index = Math.floor(pos), frac = pos - index;
      const value = input[index] * (1 - frac) + input[Math.min(index + 1, input.length - 1)] * frac;
      samples.push(value);
    }
    return api.floatToPcm16(Float32Array.from(samples));
  }
  for (const rate of [16000, 44100, 48000]) {
    for (const length of [1, 127, 2048, 2057, 4097]) {
      const input = Float32Array.from({ length }, (_, index) => Math.sin(index / 11) * 0.8);
      const worklet = processor(rate), state = { chunks: [], totalSamples: 0, peak: 0, smoothed: 0 }, fallback = api.makeFallbackBlockHandler(state, rate);
      for (let offset = 0; offset < input.length; offset += 128) { const block = input.subarray(offset, Math.min(offset + 128, input.length)); worklet.instance.process([[block]]); fallback.process(block); }
      worklet.instance.port.onmessage({ data: { type: "flush" } }); fallback.flush();
      const chunks = worklet.messages.filter(message => message.type === "chunk");
      const actual = Int16Array.from(chunks.flatMap(message => Array.from(message.pcm))), expected = expectedPcm(input, rate);
      assert.deepEqual(actual, expected, `worklet ${rate}Hz/${length} samples`);
      const fallbackPcm = Int16Array.from(state.chunks.flatMap(chunk => Array.from(chunk)));
      assert.deepEqual(fallbackPcm, expected, `fallback ${rate}Hz/${length} samples`);
      const count = chunks.length, samples = state.totalSamples;
      worklet.instance.port.onmessage({ data: { type: "flush" } }); fallback.flush();
      worklet.instance.process([[new Float32Array(128)]]); fallback.process(new Float32Array(128));
      assert.equal(worklet.messages.filter(message => message.type === "chunk").length, count); assert.equal(state.totalSamples, samples); tests++;
    }
  }
  for (const fallbackMode of [false, true]) {
    let audioContext, node; const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { async getUserMedia() { return { getTracks: () => tracks }; } } } });
    globalThis.AudioContext = class {
      constructor() { audioContext = this; this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => { if (fallbackMode) throw new Error("expected fixture fallback"); } }; }
      async resume() {} async close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createGain() { return { gain: { value: 0 }, connect() {} }; }
      createScriptProcessor() { this.legacy = { onaudioprocess: null, connect() {}, disconnect() {} }; return this.legacy; }
    };
    globalThis.AudioWorkletNode = class {
      constructor() { node = this; this.port = { onmessage: null, postMessage: message => { if (message.type === "flush") setTimeout(() => { this.port.onmessage?.({ data: { type: "chunk", pcm: Int16Array.from([1, 2, 3]), peak: 0.4, level: 0.2 } }); this.port.onmessage?.({ data: { type: "flushed" } }); }, 0); } }; }
      connect() {} disconnect() {}
    };
    console.warn = () => {};
    const delivered = [], capture = await api.startPcmCapture({ onChunk: value => delivered.push(value) });
    assert.ok(capture); if (fallbackMode) audioContext.legacy.onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.from([0.1, 0.2, 0.3]) } });
    const [first, simultaneous] = await Promise.all([capture.stop(), capture.stop()]);
    assert.equal(first.pcmB64, simultaneous.pcmB64);
    assert.equal(Buffer.from(first.pcmB64, "base64").length, 6, "Short recording must survive stop and concurrent stop");
    assert.equal(delivered.length, 1); assert.equal(tracks[0].stopped, true);
    if (!fallbackMode) assert.equal(node.port.onmessage, null);
    assert.equal((await capture.stop()).pcmB64, first.pcmB64); tests++;
    console.warn = originalWarn;
  }
  console.log(`PASS: ${tests} audio scenarios (16k/44.1k/48k resampling, one-sample tail, flush idempotency, fallback and concurrent stop)`);
} finally { console.warn = originalWarn; await rm(directory, { recursive: true, force: true }); }

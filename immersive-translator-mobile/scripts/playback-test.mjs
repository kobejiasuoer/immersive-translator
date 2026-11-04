import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// These tests exercise ordering and failure handling. Mocked WebAudio cannot
// establish that an iPhone speaker emitted sound or ignored the silent switch.
const directory = await mkdtemp(join(tmpdir(), "ita-playback-tests-"));
const output = join(directory, "voice.mjs");
const globalNames = ["window", "navigator", "AudioContext", "OfflineAudioContext", "__playbackFixture", "WebSocket"];
const originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let moduleId = 0;
let scenarios = 0;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitForRestorationRequest(f) {
  let timer;
  try {
    await Promise.race([
      f.restoreRequested.promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Playback never requested native session restoration")), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function fixture(options = {}) {
  const restoreRequested = deferred();
  const f = {
    tauri: options.tauri ?? true,
    events: [],
    diagnostics: [],
    sources: [],
    contexts: [],
    restoreRequested,
    state: { settings: { ttsVoice: "" } },
    cloud: { generation: 1, baseUrl: "https://app.example.test", account: options.signedOut ? null : { id: "account-a" }, config: {
      gateway: { voiceTicket: "/v1/voice/ticket", voiceTtsStream: "/v1/voice/tts/stream", voiceAsrStream: "/v1/voice/asr/stream" },
      voice: { ttsVoices: [{ id: "voice-a", label: "声音 A" }], asrLanguages: ["en_us", "zh_cn"], iseEnabled: true },
    } },
    cloudListeners: new Set(),
    sockets: [],
    requests: [],
    async request(path, method, body) {
      f.requests.push({ path, method, body });
      if (!f.cloud.account) throw new Error("Gateway request must require an account");
      if (path === "/v1/voice/ticket" && options.ticketGate && f.requests.length === 1) return options.ticketGate.promise;
      if (path === "/v1/voice/ticket") return { ticket: `one-use-${f.requests.length}` };
      if (path === "/v1/voice/ise") return options.iseResult ?? { total: 4, accuracy: 3, fluency: 4, standard: 5, isRejected: false, words: [{ content: "hello", totalScore: 4, dpMessage: 0, sylls: [{ phones: [{ content: "h", dpMessage: 0, gwpp: 1 }] }] }] };
      throw new Error(`Unexpected gateway request: ${path}`);
    },
    audio: {
      duration: 0.004,
      sampleRate: 48000,
      length: 192,
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from({ length: 192 }, (_, index) => Math.sin(index / 8) * 0.4),
    },
    async invoke(name) {
      f.events.push(name);
      if (name === "restore_playback_audio") {
        restoreRequested.resolve();
        if (options.restore) return options.restore(f);
        return { category: "AVAudioSessionCategoryPlayback", outputVolume: 0.5, outputs: ["Speaker"] };
      }
      throw new Error(`Unexpected command: ${name}`);
    },
  };

  class MockWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url; this.readyState = 0; this.messages = [];
      f.sockets.push(this);
      assert.equal(new URL(url).host, "app.example.test", "Speech may connect only to the account server");
      assert.ok(new URL(url).searchParams.get("ticket"));
      assert.ok(!url.includes("accessToken"));
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send(data) {
      this.messages.push(data);
      if (typeof data !== "string") return;
      const frame = JSON.parse(data);
      if (frame.type === "synthesis") {
        f.events.push("gateway.synthesis");
        if (options.ttsError) { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "error", code: options.ttsError }) }), 0); return; }
        setTimeout(() => {
          this.onmessage?.({ data: Uint8Array.from([0, 1, 2, 3, 4, 5]).buffer });
          this.onmessage?.({ data: JSON.stringify({ type: "end" }) });
        }, 0);
      } else if (frame.type === "stop") {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "final", text: "hello world" }) }), 0);
      }
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class MockAudioContext extends EventTarget {
    constructor() {
      super();
      this.state = options.contextState ?? "running";
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = {};
      f.contexts.push(this);
    }
    changeState(state) { this.state = state; this.dispatchEvent(new Event("statechange")); }
    async resume() { if (this.state === "suspended") this.changeState("running"); }
    async close() { this.changeState("closed"); }
    createBuffer(channels, length, rate) {
      return { duration: length / rate, sampleRate: rate, length, numberOfChannels: channels };
    }
    createBufferSource() {
      const context = this;
      const source = {
        buffer: null, playbackRate: { value: 1 },
        onended: null,
        starts: 0,
        stops: 0,
        connected: false,
        connect(target) { assert.equal(target, context.destination); this.connected = true; },
        disconnect() { this.connected = false; },
        start() {
          this.starts++;
          if (this.buffer !== f.audio && this.buffer?.length <= f.audio.length) return; // Ignore a gesture-unlock silent sample.
          f.events.push("source.start");
          assert.equal(context.state, "running", "Decoded audio must not start in a suspended/interrupted context");
          assert.equal(this.connected, true);
          if (options.interruptAfterStart) context.changeState("interrupted");
          else setTimeout(() => this.onended?.(), 0);
        },
        stop() { this.stops++; this.onended?.(); },
      };
      f.sources.push(source);
      return source;
    }
    async decodeAudioData() { return f.audio; }
  }
  class MockOfflineAudioContext {
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: channel => data[channel] };
    }
    async decodeAudioData(data) {
      assert.ok(data.byteLength > 0);
      f.events.push("decode");
      return f.audio;
    }
  }
  const win = new EventTarget();
  win.matchMedia = () => ({ matches: false });
  const nav = { userAgent: "Mock WKWebView" };
  f.webSessionType = "auto";
  if (options.webAudioSession !== false) {
    nav.audioSession = {
      state: "active",
      get type() { return f.webSessionType; },
      set type(value) { f.webSessionType = value; f.events.push(`web-session:${value}`); },
    };
  }
  f.navigator = nav;
  for (const [name, value] of Object.entries({
    window: win, navigator: nav, AudioContext: MockAudioContext,
    OfflineAudioContext: MockOfflineAudioContext, WebSocket: MockWebSocket, __playbackFixture: f,
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  f.api = await import(`${pathToFileURL(output).href}?case=${++moduleId}`);
  f.playingSources = () => f.sources.filter(source => (source.buffer === f.audio || source.buffer?.length > f.audio.length) && source.starts > 0);
  return f;
}

async function run(label, test) {
  try { await test(); scenarios++; }
  catch (error) { error.message = `${label}: ${error.message}`; throw error; }
}

try {
  await build({
    stdin: {
      contents: `${await readFile(new URL("../src/services/voice.ts", import.meta.url), "utf8")}\nexport { beginAudioRecording, isAudioRecordingActive } from "./webAudioSession";`,
      resolveDir: fileURLToPath(new URL("../src/services", import.meta.url)),
      sourcefile: "voice.ts", loader: "ts",
    },
    outfile: output, bundle: true, platform: "browser", format: "esm",
    plugins: [{ name: "playback-fixture", setup(api) {
      api.onResolve({ filter: /^(\.\.\/store|\.\/device|\.\/cloud)$/ }, args => ({ path: args.path, namespace: "playback-fixture" }));
      api.onLoad({ filter: /.*/, namespace: "playback-fixture" }, args => ({
        contents: args.path === "../store"
          ? "export function getState(){return globalThis.__playbackFixture.state;} export function profileIdentity(){return globalThis.__playbackFixture.repositoryOverride?.identity ?? globalThis.__playbackFixture.profile ?? globalThis.__playbackFixture.cloud.account?.id ?? 'guest';} export function activeRepository(){const f=globalThis.__playbackFixture;if(f.repositoryOverride)return f.repositoryOverride;const id=profileIdentity();f.repositories??=new Map();if(!f.repositories.has(id))f.repositories.set(id,{identity:id});return f.repositories.get(id);}"
          : args.path === "./cloud"
          ? `export class CloudError extends Error { constructor(message,status=0,code="network_error"){super(message);this.status=status;this.code=code;} }
             export function cloudState(){return globalThis.__playbackFixture.cloud;}
             export function subscribeCloud(fn){const f=globalThis.__playbackFixture;f.cloudListeners.add(fn);return ()=>f.cloudListeners.delete(fn);}
             export async function loadCloudConfig(){const f=globalThis.__playbackFixture;return f.loadConfig?f.loadConfig():f.cloud.config;}
             export function cloudRequest(path,method,body){return globalThis.__playbackFixture.request(path,method,body);}`
          : `export function isTauri(){return globalThis.__playbackFixture.tauri;}
             export function invokeRaw(name,args){return globalThis.__playbackFixture.invoke(name,args);}
             export async function invoke(name,args){try{return await invokeRaw(name,args);}catch{return null;}}
             export function reportDiag(kind,msg){globalThis.__playbackFixture.diagnostics.push({kind,msg});}`,
        loader: "js",
      }));
    } }],
  });

  await run("Cloud playback restores the native session before starting decoded audio", async () => {
    const gate = deferred();
    const f = await fixture({ restore: () => gate.promise });
    const speech = f.api.speakCloud("A short demonstration.");
    assert.equal(f.webSessionType, "playback", "WebKit's session must synchronously select playback before asynchronous synthesis");
    await waitForRestorationRequest(f);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.playingSources().length, 0, "Starting the native command is insufficient; playback must await its completion");
    gate.resolve({ category: "AVAudioSessionCategoryPlayback", outputVolume: 0.5, outputs: ["Speaker"] });
    await speech.done;
    assert.equal(f.playingSources().length, 1);
    assert.ok(f.events.indexOf("restore_playback_audio") >= 0, "Cloud playback must restore the native session");
    assert.ok(f.events.indexOf("restore_playback_audio") < f.events.indexOf("source.start"));
  });

  await run("A cached sentence still restores the native session on every playback", async () => {
    const f = await fixture();
    await f.api.speakCloud("The same sentence.").done;
    f.navigator.audioSession.type = "auto"; // Model WebKit changing categories after recording.
    await f.api.speakCloud("The same sentence.").done;
    assert.equal(f.webSessionType, "playback", "Cached playback must also reassert WebKit's category override");
    assert.equal(f.events.filter(event => event === "gateway.synthesis").length, 1, "Second playback should reuse the synthesis cache");
    assert.equal(f.events.filter(event => event === "restore_playback_audio").length, 2, "Cache reuse must not bypass session restoration");
    assert.equal(f.playingSources().length, 2);
    const starts = f.events.flatMap((event, index) => event === "source.start" ? [index] : []);
    const restores = f.events.flatMap((event, index) => event === "restore_playback_audio" ? [index] : []);
    assert.ok(restores[0] < starts[0] && restores[1] < starts[1]);
  });

  await run("Native restoration failure rejects cloud playback without starting audio", async () => {
    const f = await fixture({ restore: async () => { throw new Error("fixture restore failure"); } });
    await assert.rejects(f.api.speakCloud("Do not play this.").done, /fixture restore failure/);
    assert.equal(f.playingSources().length, 0);
    assert.ok(!f.diagnostics.some(entry => entry.msg.includes("播放完成")));
  });

  await run("Stopping while native restoration is pending prevents a late start", async () => {
    const gate = deferred();
    const f = await fixture({ restore: () => gate.promise });
    const speech = f.api.speakCloud("This was cancelled.");
    await waitForRestorationRequest(f);
    speech.stop();
    gate.resolve(null);
    await speech.done;
    assert.equal(f.playingSources().length, 0);
  });

  await run("An interrupted output context cannot report completed playback", async () => {
    const f = await fixture({ interruptAfterStart: true });
    await assert.rejects(f.api.speakCloud("Interrupted playback.").done, /interrupted|播放未结束|音频/);
    assert.equal(f.playingSources().length, 1);
    assert.ok(!f.diagnostics.some(entry => entry.msg.includes("播放完成")));
  });

  await run("A context interrupted after session restoration never starts decoded audio", async () => {
    const f = await fixture({ restore: async current => {
      current.contexts.at(-1).changeState("interrupted");
      return { category: "AVAudioSessionCategoryPlayback", outputVolume: 0.5, outputs: ["Speaker"] };
    } });
    await assert.rejects(f.api.speakCloud("Wait for output recovery.").done, /interrupted|音频/);
    assert.equal(f.playingSources().length, 0);
    assert.ok(!f.diagnostics.some(entry => entry.msg.includes("播放完成")));
  });

  await run("A fresh user playback repairs an old interrupted context", async () => {
    const f = await fixture();
    f.api.prepareAudioPlayback();
    const oldContext = f.contexts.at(-1);
    oldContext.changeState("interrupted");
    await f.api.speakCloud("Try playing again.").done;
    assert.notEqual(f.contexts.at(-1), oldContext, "The stale interrupted context should be replaced");
    assert.equal(oldContext.state, "closed");
    assert.equal(f.contexts.at(-1).state, "running");
    assert.equal(f.playingSources().length, 1);
  });

  await run("Local recording playback waits for native restoration and remains stoppable", async () => {
    const gate = deferred();
    const f = await fixture({ restore: () => gate.promise });
    const playback = f.api.playAudioBufferData(Uint8Array.from([0, 1, 2, 3]).buffer);
    assert.equal(f.webSessionType, "playback");
    await waitForRestorationRequest(f);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.playingSources().length, 0, "Local playback must also await the native command's completion");
    gate.resolve({ category: "AVAudioSessionCategoryPlayback", outputVolume: 0.5, outputs: ["Speaker"] });
    const stop = await playback;
    assert.equal(f.playingSources().length, 1);
    assert.ok(f.events.indexOf("restore_playback_audio") >= 0);
    assert.ok(f.events.indexOf("restore_playback_audio") < f.events.indexOf("source.start"));
    stop(); stop();
    assert.equal(f.playingSources()[0].stops, 1, "The returned stop handle must be idempotent");
  });

  await run("Native restoration failure prevents local recording playback", async () => {
    const f = await fixture({ restore: async () => { throw new Error("fixture restore failure"); } });
    await assert.rejects(f.api.playAudioBufferData(Uint8Array.from([0, 1, 2, 3]).buffer), /fixture restore failure/);
    assert.equal(f.playingSources().length, 0);
  });

  await run("Browser playback does not require the Tauri native session command", async () => {
    const f = await fixture({ tauri: false, webAudioSession: false, restore: async () => { throw new Error("Browser must not call the native bridge"); } });
    const stop = await f.api.playAudioBufferData(Uint8Array.from([0, 1, 2, 3]).buffer);
    assert.equal("audioSession" in f.navigator, false, "The browser fixture must exercise the unsupported Web Audio Session API path");
    assert.equal(f.events.filter(event => event === "restore_playback_audio").length, 0);
    assert.equal(f.playingSources().length, 1);
    stop();
  });

  await run("Demo and local playback preserve recording, then restore after the last recording ends", async () => {
    const f = await fixture();
    const release = f.api.beginAudioRecording();
    assert.equal(f.api.isAudioRecordingActive(), true);
    assert.equal(f.webSessionType, "play-and-record");
    await f.api.speakCloud("A demo while recording.").done;
    const stop = await f.api.playAudioBufferData(Uint8Array.from([0, 1, 2, 3]).buffer);
    stop();
    assert.equal(f.webSessionType, "play-and-record", "Playback must leave the active microphone category intact");
    assert.equal(f.events.filter(event => event === "web-session:playback").length, 0);
    assert.equal(f.events.filter(event => event === "restore_playback_audio").length, 0, "Native playback restoration must not interrupt recording");
    release();
    assert.equal(f.api.isAudioRecordingActive(), false);
    assert.equal(f.webSessionType, "playback");
    await f.api.speakCloud("A demo while recording.").done;
    assert.equal(f.events.filter(event => event === "gateway.synthesis").length, 1, "Playback after recording should reuse the cached demo");
    assert.equal(f.events.filter(event => event === "restore_playback_audio").length, 1, "Playback must restore native output again after recording ends");
  });

  await run("Overlapping recordings retain their category until every idempotent release completes", async () => {
    const f = await fixture();
    const releaseFirst = f.api.beginAudioRecording();
    const releaseSecond = f.api.beginAudioRecording();
    releaseFirst(); releaseFirst();
    assert.equal(f.api.isAudioRecordingActive(), true, "Releasing one recording twice must not release another recording");
    f.api.prepareAudioPlayback();
    assert.equal(await f.api.restorePlaybackSession(), null);
    assert.equal(f.webSessionType, "play-and-record");
    assert.equal(f.events.filter(event => event === "restore_playback_audio").length, 0);
    releaseSecond(); releaseSecond();
    assert.equal(f.api.isAudioRecordingActive(), false);
    assert.equal(f.webSessionType, "playback");
    const releaseNew = f.api.beginAudioRecording();
    releaseFirst(); releaseSecond();
    assert.equal(f.api.isAudioRecordingActive(), true, "Old release handles must not reduce the reference count of a later recording");
    assert.equal(f.webSessionType, "play-and-record");
    releaseNew(); releaseNew();
    assert.equal(f.api.isAudioRecordingActive(), false);
    assert.equal(f.webSessionType, "playback");
    assert.ok(await f.api.restorePlaybackSession());
    assert.equal(f.events.filter(event => event === "restore_playback_audio").length, 1);
  });


  await run("Signed-out speech rejects without contacting the server or falling back", async () => {
    const f = await fixture({ signedOut: true });
    await assert.rejects(f.api.speakCloud("Login is required.").done, /登录/);
    assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0);
    assert.equal(f.api.cloudAvailable(), false);
  });

  await run("Speech uses server-issued voices and applies speed during playback", async () => {
    const f = await fixture();
    f.state.settings.ttsVoice = "voice-a";
    await f.api.speakCloud("A faster sentence.", undefined, 1.5).done;
    const socket = f.sockets[0], message = JSON.parse(socket.messages[0]);
    assert.equal(new URL(socket.url).pathname, "/v1/voice/tts/stream");
    assert.deepEqual(message, { type: "synthesis", text: "A faster sentence.", voice: "voice-a" });
    assert.equal(f.playingSources()[0].playbackRate.value, 1.5);
    await f.api.speakCloud("A faster sentence.", undefined, 0.8).done;
    assert.equal(f.sockets.length, 1, "Changing playback speed must reuse server audio");
    assert.equal(f.playingSources()[1].playbackRate.value, 0.8);
  });

  await run("Gateway errors stay actionable and never select another speech provider", async () => {
    const f = await fixture({ ttsError: "quota_exceeded" });
    let error;
    try { await f.api.speakCloud("Quota is exhausted.").done; } catch (value) { error = value; }
    assert.ok(error); assert.match(f.api.voiceErrorText(error), /额度/);
    assert.equal(f.playingSources().length, 0);
    assert.equal(f.sockets.length, 1);
    assert.match(f.api.voiceErrorText(undefined), /稍后再试/);
    assert.doesNotMatch(f.api.voiceErrorText(undefined), /undefined/);
  });

  await run("Signing out clears cached audio and interrupts old-account playback", async () => {
    const f = await fixture();
    await f.api.speakCloud("Account-specific cache.").done;
    f.cloud = { ...f.cloud, generation: 2, account: null };
    f.cloudListeners.forEach(fn => fn());
    await assert.rejects(f.api.speakCloud("Account-specific cache.").done, /登录/);
    assert.equal(f.sockets.length, 1);
    f.cloud = { ...f.cloud, generation: 3, account: { id: "account-b" } };
    f.cloudListeners.forEach(fn => fn());
    await f.api.speakCloud("Account-specific cache.").done;
    assert.equal(f.sockets.length, 2, "Another account must not reuse the old account's cached speech");
  });

  await run("ASR sends buffered PCM to the account server before its final stop", async () => {
    const f = await fixture(), deltas = [];
    const session = f.api.createAsrSession("en_us", { onDelta: (text, final) => deltas.push({ text, final }) });
    session.push("AAECAwQF");
    const text = await session.finish();
    assert.equal(text, "hello world");
    assert.deepEqual(deltas, [{ text: "hello world", final: true }]);
    const socket = f.sockets[0];
    assert.equal(new URL(socket.url).pathname, "/v1/voice/asr/stream");
    assert.equal(new URL(socket.url).searchParams.get("lang"), "en_us");
    assert.deepEqual(JSON.parse(socket.messages[0]), { type: "start" });
    assert.ok(socket.messages[1] instanceof ArrayBuffer);
    assert.deepEqual(JSON.parse(socket.messages[2]), { type: "stop" });
    assert.equal(socket.readyState, 3);
  });

  await run("Aborting ASR during connection prevents later audio upload", async () => {
    const f = await fixture();
    const session = f.api.createAsrSession("en_us", { onDelta: () => assert.fail("Cancelled ASR must not deliver a result") });
    session.push("AAECAwQF"); session.abort();
    await assert.rejects(session.finish(), { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.sockets.length, 0);
  });

  await run("Pronunciation uploads only through authenticated REST and preserves score scale", async () => {
    const f = await fixture();
    const result = await f.api.assessSentence("hello", "AAECAwQF");
    assert.deepEqual(f.requests, [{ path: "/v1/voice/ise", method: "POST", body: { refText: "hello", lang: "en", audio: "AAECAwQF" } }]);
    assert.equal(result.totalScore, 4); assert.equal(result.accuracyScore, 3); assert.equal(result.integrityScore, 5);
    assert.deepEqual(result.words[0].phones, [{ content: "h", dpMessage: 0, gwpp: 1 }]);
    assert.equal(f.sockets.length, 0);
  });


  await run("Signing out during native restoration prevents an old-account sentence from playing", async () => {
    const gate = deferred(), f = await fixture({ restore: () => gate.promise });
    const speech = f.api.speakCloud("An old account sentence.");
    await waitForRestorationRequest(f);
    f.cloud = { ...f.cloud, generation: 2, account: null };
    f.cloudListeners.forEach(fn => fn());
    gate.resolve(null);
    await speech.done;
    assert.equal(f.playingSources().length, 0);
  });

  await run("Long multilingual speech obeys the byte limit and decodes every segment", async () => {
    const f = await fixture(), text = "你好🙂".repeat(1000);
    await f.api.speakCloud(text).done;
    assert.equal(f.sockets.length, 2);
    const pieces = f.sockets.map(socket => JSON.parse(socket.messages[0]).text);
    assert.equal(pieces.join(""), text);
    assert.ok(pieces.every(piece => new TextEncoder().encode(piece).length < 8000));
    assert.equal(new Set(f.sockets.map(socket => new URL(socket.url).searchParams.get("ticket"))).size, 2, "Every connection must have its own one-use ticket");
    assert.equal(f.events.filter(event => event === "decode").length, 2, "Each MP3 stream must be decoded separately");
    assert.equal(f.playingSources()[0].buffer.length, f.audio.length * 2);
  });

  await run("Unavailable assessment is blocked before recording upload", async () => {
    const f = await fixture(); f.cloud.config.voice.iseEnabled = false;
    let error; try { await f.api.assessSentence("hello", "AAECAwQF"); } catch (value) { error = value; }
    assert.ok(error); assert.match(f.api.voiceErrorText(error), /暂未开放/);
    assert.equal(f.requests.length, 0);
  });


  await run("Authenticated login still blocks voice until account data is bound", async () => {
    const f = await fixture(); f.profile = "guest";
    assert.equal(f.api.voiceConfigured(), false); assert.equal(f.api.cloudAvailable(), false);
    f.api.prefetchCloud("Private guest text.");
    await assert.rejects(f.api.speakCloud("Private guest text.").done, /登录/);
    await assert.rejects(f.api.assessSentence("Private guest reference.", "PRIVATE_GUEST_PCM"), /登录/);
    assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0);
  });

  await run("Assessment rechecks the original account immediately before uploading", async () => {
    const f = await fixture();
    Object.defineProperty(f.cloud.config.voice, "iseEnabled", { get() {
      queueMicrotask(() => { f.cloud = { ...f.cloud, generation: 2, account: { id: "account-b" } }; });
      return true;
    } });
    await assert.rejects(f.api.assessSentence("Account A private reference.", "ACCOUNT_A_PRIVATE_PCM"), { name: "AbortError" });
    assert.equal(f.requests.length, 0, "Account A audio must not be uploaded under account B");
  });

  await run("A profile change during capability loading blocks old recorded audio", async () => {
    const f = await fixture(), gate = deferred(), config = f.cloud.config;
    f.cloud.config = null; f.loadConfig = () => gate.promise;
    const assessment = f.api.assessSentence("Account A reference.", "ACCOUNT_A_PCM");
    f.cloud.config = config; f.profile = "guest"; gate.resolve(config);
    await assert.rejects(assessment, { name: "AbortError" });
    assert.equal(f.requests.length, 0);
  });

  await run("Immediate preview cancellation never exchanges a ticket or consumes synthesis", async () => {
    const f = await fixture();
    const speech = f.api.speakCloud("This preview was cancelled immediately."); speech.stop();
    await speech.done; await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0);
  });

  await run("Stopping during ticket exchange settles the preview and prevents a late handshake", async () => {
    const gate = deferred(), f = await fixture({ ticketGate: gate });
    const speech = f.api.speakCloud("Stop before the ticket comes back.");
    for (let i = 0; i < 20 && !f.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.requests.length, 1); speech.stop();
    await speech.done;
    gate.resolve({ ticket: "cancelled-ticket" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.sockets.length, 0); assert.equal(f.playingSources().length, 0);
  });

  await run("Cancelling one shared preview preserves another active listener", async () => {
    const f = await fixture();
    const first = f.api.speakCloud("A shared sentence."), second = f.api.speakCloud("A shared sentence.");
    first.stop(); await Promise.all([first.done, second.done]);
    assert.equal(f.requests.length, 1); assert.equal(f.sockets.length, 1);
    assert.equal(f.playingSources().length, 1);
  });


  await run("Replacing the repository of the same account cancels a pending assessment", async () => {
    const f = await fixture();
    Object.defineProperty(f.cloud.config.voice, "iseEnabled", { get() {
      queueMicrotask(() => { f.repositoryOverride = { identity: "account-a" }; });
      return true;
    } });
    await assert.rejects(f.api.assessSentence("Old account A reference.", "OLD_REPOSITORY_PCM"), { name: "AbortError" });
    assert.equal(f.requests.length, 0);
  });


  await run("A cancelled ticket request does not hold up the next preview", async () => {
    const gate = deferred(), f = await fixture({ ticketGate: gate });
    const first = f.api.speakCloud("An old preview.");
    for (let i = 0; i < 20 && !f.requests.length; i++) await new Promise(resolve => setTimeout(resolve, 0));
    first.stop(); await first.done;
    let timer;
    try {
      await Promise.race([f.api.speakCloud("A new preview.").done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cancelled task blocked the synthesis queue")), 1000); })]);
    } finally { clearTimeout(timer); gate.resolve({ ticket: "old-cancelled-ticket" }); }
    assert.equal(f.sockets.length, 1);
    assert.equal(JSON.parse(f.sockets[0].messages[0]).text, "A new preview.");
  });

  console.log(`PASS: ${scenarios} playback control-flow scenarios (mocked native session and WebAudio; physical audibility is not asserted)`);
} finally {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  await rm(directory, { recursive: true, force: true });
}

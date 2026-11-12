import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../downloads.js", import.meta.url), "utf8");
const api = "https://api.github.com/repos/kobejiasuoer/immersive-translator/releases/latest";
const downloadRoot = "https://github.com/kobejiasuoer/immersive-translator/releases/download/";
const tag = "v0.16.0";
const initialVersion = "v0.15.2";

function asset(name, assetTag = tag) {
  return {
    name,
    state: "uploaded",
    browser_download_url: `${downloadRoot}${assetTag}/${name}`,
  };
}

const currentWindows = asset("ImmersiveSpeaking_0.16.0_x64-setup.exe");
const currentMacos = asset("ImmersiveSpeaking-0.16.0-macOS.zip");
const legacyWindows = asset("ImmersiveTranslator_0.16.0_x64-setup.exe");
const legacyMacos = asset("ImmersiveTranslator-0.16.0-macOS.zip");
const release = (assets) => ({ tag_name: tag, draft: false, prerelease: false, assets });

function mount(data, options = {}) {
  const links = Object.fromEntries(
    ["windows", "macos"].map((platform) => [
      platform,
      Array.from({ length: 2 }, () => ({
        href: `${platform}-fallback`,
        setAttribute(name, value) {
          assert.equal(name, "href");
          this.href = value;
        },
      })),
    ]),
  );
  const versions = {
    windows: [{ textContent: initialVersion }],
    macos: [{ textContent: initialVersion }],
  };
  const requests = [];
  const timers = [];
  const events = new Map();
  const context = {
    URL,
    AbortController,
    document: {
      readyState: options.loading ? "loading" : "complete",
      querySelector: () => true,
      querySelectorAll(selector) {
        const match = /data-(download|version)="(windows|macos)"/.exec(selector);
        assert.ok(match, `Unexpected selector: ${selector}`);
        return (match[1] === "download" ? links : versions)[match[2]];
      },
      addEventListener(name, callback, eventOptions) {
        events.set(name, { callback, options: eventOptions });
      },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      assert.ok(timers.includes(timer));
      timer.cancelled = true;
    },
    async fetch(url, request) {
      requests.push({ url, ...request });
      if (options.pending) {
        return new Promise((resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        });
      }
      if (options.reject) throw new Error("Network unavailable");
      return {
        ok: options.ok !== false,
        async json() {
          if (options.invalidJson) throw new SyntaxError("Invalid JSON");
          return data;
        },
      };
    },
  };
  vm.runInNewContext(source, context, { filename: "downloads.js" });
  return { links, versions, requests, timers, events };
}

async function run(data, options) {
  const page = mount(data, options);
  await setImmediate();
  assert.equal(page.requests.length, 1);
  assert.equal(page.timers.length, 1);
  assert.equal(page.timers[0].delay, 8000);
  assert.equal(page.timers[0].cancelled, true);
  return page;
}

function assertDownload(page, platform, expected) {
  assert.deepEqual(page.links[platform].map((link) => link.href), [expected, expected]);
  assert.equal(page.versions[platform][0].textContent, tag);
}

function assertFallback(page, platform) {
  assert.deepEqual(page.links[platform].map((link) => link.href), [
    `${platform}-fallback`,
    `${platform}-fallback`,
  ]);
  assert.equal(page.versions[platform][0].textContent, initialVersion);
}

test("current branding wins even when legacy assets appear first", async () => {
  const page = await run(release([legacyWindows, legacyMacos, currentWindows, currentMacos]));
  assertDownload(page, "windows", currentWindows.browser_download_url);
  assertDownload(page, "macos", currentMacos.browser_download_url);
  const request = page.requests[0];
  assert.equal(request.url, api);
  assert.equal(request.credentials, "omit");
  assert.equal(request.referrerPolicy, "no-referrer");
  assert.equal(request.cache, "no-store");
  assert.equal(request.signal.aborted, false);
});

test("both naming generations work independently", async (t) => {
  for (const [label, windows, macos] of [
    ["current only", currentWindows, currentMacos],
    ["legacy only", legacyWindows, legacyMacos],
  ]) {
    await t.test(label, async () => {
      const page = await run(release([windows, macos]));
      assertDownload(page, "windows", windows.browser_download_url);
      assertDownload(page, "macos", macos.browser_download_url);
    });
  }
});

test("invalid current-brand candidates fall back to a valid legacy asset", async (t) => {
  for (const [label, candidate] of [
    ["untrusted URL", { ...currentWindows, browser_download_url: "https://example.com/installer.exe" }],
    ["not uploaded", { ...currentWindows, state: "new" }],
    ["wrong version", asset("ImmersiveSpeaking_0.17.0_x64-setup.exe")],
  ]) {
    await t.test(label, async () => {
      const page = await run(release([candidate, legacyWindows, currentMacos]));
      assertDownload(page, "windows", legacyWindows.browser_download_url);
      assertDownload(page, "macos", currentMacos.browser_download_url);
    });
  }
});

test("a malformed first asset does not hide a later valid asset of the same name", async () => {
  const page = await run(release([
    null,
    { ...currentWindows, browser_download_url: "not a URL" },
    currentWindows,
    currentMacos,
  ]));
  assertDownload(page, "windows", currentWindows.browser_download_url);
  assertDownload(page, "macos", currentMacos.browser_download_url);
});

test("missing or invalid assets affect only their own platform", async (t) => {
  await t.test("Windows missing", async () => {
    const page = await run(release([currentMacos]));
    assertFallback(page, "windows");
    assertDownload(page, "macos", currentMacos.browser_download_url);
  });
  await t.test("macOS invalid", async () => {
    const page = await run(release([
      currentWindows,
      { ...currentMacos, browser_download_url: null },
    ]));
    assertDownload(page, "windows", currentWindows.browser_download_url);
    assertFallback(page, "macos");
  });
});

test("download URLs must belong to the exact trusted release asset", async (t) => {
  const validUrl = currentMacos.browser_download_url;
  const candidates = [
    ["HTTP", validUrl.replace("https:", "http:")],
    ["lookalike hostname", validUrl.replace("github.com", "github.com.evil.invalid")],
    ["credentials", validUrl.replace("github.com", "user:password@github.com")],
    ["nonstandard port", validUrl.replace("github.com", "github.com:8443")],
    ["other repository", validUrl.replace("kobejiasuoer/immersive-translator", "other/repo")],
    ["query", `${validUrl}?redirect=other`],
    ["fragment", `${validUrl}#download`],
    ["other tag", validUrl.replace("/v0.16.0/", "/v0.15.2/")],
    ["other filename", validUrl.replace("macOS.zip", "macOS.zip.sha256")],
    ["script URL", "javascript:alert(1)"],
  ];
  for (const [label, url] of candidates) {
    await t.test(label, async () => {
      const page = await run(release([currentWindows, { ...currentMacos, browser_download_url: url }]));
      assertDownload(page, "windows", currentWindows.browser_download_url);
      assertFallback(page, "macos");
    });
  }
});

test("draft, prerelease and malformed release responses preserve all fallbacks", async (t) => {
  const validRelease = release([currentWindows, currentMacos]);
  for (const [label, data] of [
    ["draft", { ...validRelease, draft: true }],
    ["prerelease", { ...validRelease, prerelease: true }],
    ["release candidate tag", { ...validRelease, tag_name: "v0.16.0-rc.1" }],
    ["missing release flag", { ...validRelease, draft: undefined }],
    ["invalid assets", { ...validRelease, assets: null }],
    ["empty response", null],
  ]) {
    await t.test(label, async () => {
      const page = await run(data);
      assertFallback(page, "windows");
      assertFallback(page, "macos");
    });
  }
});

test("network, HTTP and JSON failures preserve existing URLs and versions", async (t) => {
  for (const [label, options] of [
    ["network", { reject: true }],
    ["HTTP", { ok: false }],
    ["JSON", { invalidJson: true }],
  ]) {
    await t.test(label, async () => {
      const page = await run(release([currentWindows, currentMacos]), options);
      assertFallback(page, "windows");
      assertFallback(page, "macos");
    });
  }
});

test("a pending request is aborted after eight seconds without changing fallbacks", async () => {
  const page = mount(release([currentWindows, currentMacos]), { pending: true });
  assert.equal(page.requests.length, 1);
  assert.equal(page.timers[0].delay, 8000);
  assert.equal(page.requests[0].signal.aborted, false);
  page.timers[0].callback();
  await setImmediate();
  assert.equal(page.requests[0].signal.aborted, true);
  assert.equal(page.timers[0].cancelled, true);
  assertFallback(page, "windows");
  assertFallback(page, "macos");
});

test("loading documents defer initialization until DOMContentLoaded", async () => {
  const page = mount(release([currentWindows, currentMacos]), { loading: true });
  assert.equal(page.requests.length, 0);
  assert.equal(page.timers.length, 0);
  const ready = page.events.get("DOMContentLoaded");
  assert.ok(ready);
  assert.equal(ready.options.once, true);
  await ready.callback();
  assert.equal(page.requests.length, 1);
  assert.equal(page.timers[0].cancelled, true);
  assertDownload(page, "windows", currentWindows.browser_download_url);
  assertDownload(page, "macos", currentMacos.browser_download_url);
});

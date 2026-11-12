(() => {
  "use strict";

  const API = "https://api.github.com/repos/kobejiasuoer/immersive-translator/releases/latest";
  const DOWNLOAD_PATH = "/kobejiasuoer/immersive-translator/releases/download/";
  const platforms = [
    {
      name: "windows",
      filenames: [
        /^ImmersiveSpeaking_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe$/,
        /^ImmersiveTranslator_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe$/,
      ],
    },
    {
      name: "macos",
      filenames: [
        /^ImmersiveSpeaking-([0-9]+\.[0-9]+\.[0-9]+)-macOS\.zip$/,
        /^ImmersiveTranslator-([0-9]+\.[0-9]+\.[0-9]+)-macOS\.zip$/,
      ],
    },
  ];

  function findDownloadUrl(release, filenames, version) {
    // Prefer the current brand, but only after validating the entire asset.
    for (const filename of filenames) {
      for (const asset of release.assets) {
        if (!asset || asset.state !== "uploaded" || typeof asset.name !== "string") continue;
        const match = filename.exec(asset.name);
        if (!match || match[1] !== version || typeof asset.browser_download_url !== "string") continue;
        try {
          const url = new URL(asset.browser_download_url);
          const expectedPath = `${DOWNLOAD_PATH}${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`;
          if (
            url.protocol === "https:" &&
            url.hostname === "github.com" &&
            !url.port &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === expectedPath
          )
            return url.href;
        } catch {
          // A malformed candidate must not hide another valid download.
        }
      }
    }
    return null;
  }

  async function updateDownloads() {
    if (typeof fetch !== "function" || typeof AbortController !== "function") return;
    if (!document.querySelector('[data-download="windows"], [data-download="macos"]')) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(API, {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!response.ok) return;
      const release = await response.json();
      if (
        !release ||
        release.draft !== false ||
        release.prerelease !== false ||
        !Array.isArray(release.assets)
      )
        return;
      const tagMatch =
        typeof release.tag_name === "string" && /^v?([0-9]+\.[0-9]+\.[0-9]+)$/.exec(release.tag_name);
      if (!tagMatch) return;

      for (const platform of platforms) {
        // Each platform keeps its HTML fallback unless its own asset is validated.
        try {
          const links = document.querySelectorAll(`[data-download="${platform.name}"]`);
          if (!links.length) continue;
          const url = findDownloadUrl(release, platform.filenames, tagMatch[1]);
          if (!url) continue;

          links.forEach((link) => link.setAttribute("href", url));
          document.querySelectorAll(`[data-version="${platform.name}"]`).forEach((node) => {
            node.textContent = `v${tagMatch[1]}`;
          });
        } catch {
          // A missing or malformed asset does not affect the other platform.
        }
      }
    } catch {
      // Offline, rate-limited and timed-out requests leave direct HTML downloads usable.
    } finally {
      clearTimeout(timer);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateDownloads, { once: true });
  } else {
    void updateDownloads();
  }
})();

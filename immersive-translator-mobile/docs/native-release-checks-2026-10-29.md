# iOS release checks — 2026-10-29

## Minimum version

The existing frontend build declares `target: safari16` in `vite.config.ts`. The generated Apple project and Podfile previously declared iOS 14, allowing installation of a bundle whose frontend compatibility target was newer than the OS. The release minimum is now consistently iOS 16.0 in:

- `src-tauri/tauri.conf.json` → `bundle.iOS.minimumSystemVersion` (durable Tauri source of truth).
- `src-tauri/gen/apple/project.yml` → deployment target.
- Generated `project.pbxproj` → both deployment target settings.
- Generated `Podfile` → iOS platform.

The installed Tauri CLI `config.schema.json` documents `minimumSystemVersion` as mapping to `IPHONEOS_DEPLOYMENT_TARGET`. This change preserves the existing frontend compatibility policy; it does not claim an iOS 16 device test. Recheck generated files after `tauri ios init`.

## PCM capture corrections

`src/services/audio.ts` drains partial 2048-sample chunks and the resampler's remaining source samples. Downsampling preserves skipped phase across source blocks instead of resetting when the next sample position overshoots a block. Repeated flushes do not duplicate audio, and concurrent `stop()` calls await the same teardown.

`pnpm audio:test` runs the actual embedded worklet source in a VM, compares worklet/fallback output with a whole-buffer reference at 16,000 / 44,100 / 48,000 Hz, tests recordings shorter than one chunk, and exercises the public stop path with a delayed flush acknowledgement. This validates deterministic PCM processing, not microphone capture on iPhone.

## Release gates still open

1. **Device-only recording files.** `audio_store.rs` writes private files under `app_data/profiles/<identity hash>/audio`, but has no Apple backup exclusion or data-protection attribute code. On macOS/Xcode, implement and validate `NSURLIsExcludedFromBackupKey=true` and `NSFileProtectionCompleteUntilFirstUserAuthentication` for the directory and partial/staged/final files, including existing-file migration and post-rename application. A Windows compile cannot validate Objective-C behavior. Verify attributes and locked/unlocked reads on an actual iPhone and confirm device backups exclude recordings.
2. **Incoming system share.** The Apple project contains only the application target; entitlements are empty and no Share Extension/App Group exists. The installed share plugin implements outbound sharing. A deep link is not an incoming Safari share extension. Build a signed Share Extension target, App Group bounded handoff queue, import confirmation, process-death recovery and deduplication, then validate Safari→app on a real device.
3. **Apple build and device validation.** This workstation currently has only `x86_64-pc-windows-msvc` installed and no Xcode. Windows `cargo check` does not verify the iOS-only Objective-C bridge, native microphone permissions, route restoration, safe-area keyboard behavior or signing. Run iOS archive, launch, recording/playback and lifecycle tests on the signing Mac before release.

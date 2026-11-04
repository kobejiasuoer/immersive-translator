import { useEffect, useState } from "react";
import type { AudioManifest, Repository } from "./persistence";
import { reportDiag } from "../services/device";

/** A clip identifier alone does not establish that any audio was saved on this device. */
export function useLocalRecording(repo: Repository, clipId: string | undefined, refresh: unknown): AudioManifest | null {
  const [found, setFound] = useState<{ repo: Repository; clipId: string; manifest: AudioManifest } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFound(null);
    if (clipId) void repo.audioManifest(clipId).then(manifest => {
      if (!cancelled && manifest && manifest.byteLength > 0 && ["ready", "interrupted"].includes(manifest.status)) {
        setFound({ repo, clipId, manifest });
      }
    }).catch(error => {
      if (!cancelled) reportDiag("audio", `检查本机原声失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { cancelled = true; };
  }, [repo, clipId, refresh]);
  return found?.repo === repo && found.clipId === clipId ? found.manifest : null;
}

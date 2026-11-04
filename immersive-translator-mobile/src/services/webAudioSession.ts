/** WebKit owns a separate audio session: declare playback so it does not select ambient. */
export type WebAudioSessionType = "auto" | "playback" | "play-and-record";
let recordings = 0;

export function isAudioRecordingActive(): boolean {
  return recordings > 0;
}

/** Keep a live microphone session intact even if the learner taps a demo while recording. */
export function beginAudioRecording(): () => void {
  recordings++;
  setWebAudioSessionType("play-and-record");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    recordings--;
    if (!recordings) setWebAudioSessionType("playback");
  };
}

export function setWebAudioSessionType(type: WebAudioSessionType): void {
  if (type === "playback" && recordings) return;
  if (typeof navigator === "undefined") return;
  const session = (navigator as Navigator & { audioSession?: { type: WebAudioSessionType } }).audioSession;
  if (!session || session.type === type) return;
  try {
    session.type = type;
  } catch {
    // Older WebViews rely on the native AVAudioSession setup.
  }
}

/** 口语示范语速保存在本机，声音由账号服务的朗读设置决定。 */
import { speak, stopSpeak } from "../../store";

export type DemoAccent = "US" | "UK";
export interface DemoVoicePrefs { accent: DemoAccent; speed: number }

const KEY = "ita.v3.spokenVoice";
const SPEEDS = [0.7, 0.85, 1];
/* 默认档随原型 settings.speed=0.85（html:1578），示范朗读略放慢更易跟读。 */
const DEFAULT_SPEED = 0.85;

function load(): DemoVoicePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<DemoVoicePrefs>;
      const speed = SPEEDS.includes(value.speed as number) ? (value.speed as number) : DEFAULT_SPEED;
      const accent = value.accent === "UK" ? "UK" : "US";
      return { accent, speed };
    }
  } catch { /* 坏数据按默认档 */ }
  return { accent: "US", speed: DEFAULT_SPEED };
}

function save(prefs: DemoVoicePrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 无痕模式忽略 */ }
}

export function readDemoVoice(): DemoVoicePrefs { return load(); }

export function writeDemoVoice(patch: Partial<DemoVoicePrefs>): DemoVoicePrefs {
  const next = { ...load(), ...patch };
  save(next);
  return next;
}

/** 口语示范经账号语音服务朗读，按本机偏好调整语速。 */
export function speakDemo(text: string, rate = 1): void {
  stopSpeak();
  speak(text, rate * load().speed);
}

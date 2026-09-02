/**
 * 全局热键校验。对齐 Mac HotKeyManager 的冲突检测思路：
 * - 必须包含至少一个修饰键（Ctrl/Alt/Shift/Super）
 * - 不能等于 Windows 系统保留组合
 * - 危险组合给出提示（仅 Alt + 字母 易和菜单冲突，纯 Ctrl+C/V 等会抢系统）
 */

export interface ParsedHotkey {
  mods: Set<string>; // "Ctrl" | "Alt" | "Shift" | "Super"
  key: string; // 主键，大写
  raw: string;
}

export const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;

/** 解析 "Ctrl+Shift+Q" -> { mods, key }。无效返回 null。 */
export function parseHotkey(input: string): ParsedHotkey | null {
  const raw = input.trim();
  if (!raw) return null;
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null; // 至少一个修饰键 + 一个主键

  const mods = new Set<string>();
  const nonMods: string[] = [];
  for (const p of parts) {
    const cap = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    if ((MODIFIERS as readonly string[]).includes(cap)) {
      mods.add(cap);
    } else {
      nonMods.push(p);
    }
  }
  if (nonMods.length !== 1) return null; // 主键必须恰好一个
  if (mods.size === 0) return null; // 必须有修饰键
  return { mods, key: nonMods[0].toUpperCase(), raw };
}

/** Windows 系统保留 / 危险组合。 */
const RESERVED: Array<{ mods: Set<string>; key: string; reason: string }> = [
  { mods: new Set(["Ctrl", "Alt"]), key: "DEL", reason: "Ctrl+Alt+Del 是系统安全序列，不可用" },
  { mods: new Set(["Super"]), key: "L", reason: "Win+L 是锁屏快捷键" },
  { mods: new Set(["Super"]), key: "E", reason: "Win+E 打开资源管理器" },
  { mods: new Set(["Super"]), key: "D", reason: "Win+D 显示桌面" },
  { mods: new Set(["Super"]), key: "R", reason: "Win+R 打开运行" },
  { mods: new Set(["Super"]), key: "TAB", reason: "Win+Tab 任务视图" },
  { mods: new Set(["Super"]), key: "I", reason: "Win+I 打开设置" },
  { mods: new Set(["Ctrl", "Shift"]), key: "ESC", reason: "Ctrl+Shift+Esc 打开任务管理器" },
];

/** 通用会抢系统输入的组合（仅 Ctrl + 单字母，如 Ctrl+C/V/X/Z/A/S/P）。 */
const CTRL_CLASH_KEYS = new Set(["C", "V", "X", "Z", "A", "S", "P", "F", "O", "W", "N"]);

export interface HotkeyValidation {
  ok: boolean;
  /** 非空时表示有问题，前端应展示。 */
  warning?: string;
  /** true 表示硬性不可用（已注册会失败）；false 表示能用但有风险提示。 */
  blocking?: boolean;
}

export function validateHotkey(input: string): HotkeyValidation {
  const parsed = parseHotkey(input);
  if (!parsed) {
    return {
      ok: false,
      blocking: true,
      warning: "格式无效。需要至少一个修饰键 + 一个主键，例如 Ctrl+Shift+Q",
    };
  }

  // 系统保留
  for (const r of RESERVED) {
    if (setEq(r.mods, parsed.mods) && r.key === parsed.key) {
      return { ok: false, blocking: true, warning: r.reason };
    }
  }

  // 仅 Ctrl + 单字母 且该字母是常用编辑键 -> 抢系统
  if (
    parsed.mods.size === 1 &&
    parsed.mods.has("Ctrl") &&
    CTRL_CLASH_KEYS.has(parsed.key)
  ) {
    return {
      ok: true,
      blocking: false,
      warning: `Ctrl+${parsed.key} 是系统编辑快捷键，会与复制/粘贴等冲突。建议加 Shift 或换键。`,
    };
  }

  // 仅 Alt + 字母 -> 易触发菜单栏助记符
  if (parsed.mods.size === 1 && parsed.mods.has("Alt")) {
    return {
      ok: true,
      blocking: false,
      warning: "仅用 Alt 的组合容易和窗口菜单助记符冲突，可能不生效。建议加 Ctrl 或 Shift。",
    };
  }

  // 仅 Super + 字母（非保留键）也提示
  if (parsed.mods.size === 1 && parsed.mods.has("Super")) {
    return {
      ok: true,
      blocking: false,
      warning: "Win 组合大多被系统占用，可能不生效。建议用 Ctrl 或 Ctrl+Shift。",
    };
  }

  return { ok: true };
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** 推荐的替代组合，用于冲突时给建议。 */
export const RECOMMENDED_HOTKEYS = [
  "Ctrl+Shift+Q",
  "Ctrl+Shift+E",
  "Ctrl+Shift+T",
  "Alt+Shift+S",
  "Ctrl+Alt+T",
];

/** 规范化为 Tauri 接受的格式（首字母大写，+ 不带空格）。 */
export function normalizeHotkey(input: string): string {
  const parsed = parseHotkey(input);
  if (!parsed) return input.trim();
  const ordered = MODIFIERS.filter((m) => parsed.mods.has(m));
  return [...ordered, parsed.key].join("+");
}

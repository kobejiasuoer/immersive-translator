import type { TranslationMode } from "../core/languageDetect";
import {
  findMatchingPreset,
  isLocalhostEndpoint,
  platformEndpoint,
  PLATFORM_PROVIDER_ID,
} from "../core/providerPresets";
import { authServerBaseUrl, secretGet, secretSet } from "./tauriBridge";
import { xfyunCredentialPresence } from "./iseCredentials";

/** 词典卡片模式：auto = 选中单词/短语时自动切换；off = 始终普通翻译。 */
export type DictCardMode = "auto" | "off";

/** 语音服务商（契约 §三.2）：gateway = 沉浸云官方，xfyun = 自带讯飞凭据。
 *  与 LLM providerId 解耦；点卡即写盘（不经保存条），不纳入云同步（与 LLM provider 选择同口径）。 */
export type VoiceProvider = "gateway" | "xfyun";

export interface AppSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 当前服务商（预设 id 或 "custom"）。apiKey 按服务商分桶保存，切换服务商互不影响。 */
  providerId?: string;
  translationMode: TranslationMode;
  fixedTarget: string;
  customStyle: string;
  glossaryText: string;
  stream: boolean;
  /** 词典卡片模式（划选单词/短语时浮窗切换为词典样式）。 */
  dictCard: DictCardMode;
  /** 全局翻译热键，Tauri 格式如 "Ctrl+Shift+Q"。 */
  hotkey: string;
  /** 截图 OCR 翻译热键，Tauri 格式如 "Ctrl+Shift+E"。 */
  ocrHotkey: string;
  /** 沉浸阅读室热键，Tauri 格式如 "Ctrl+Shift+R"。 */
  readerHotkey: string;
  /** 语音服务商（gateway=沉浸云 / xfyun=讯飞 BYOK）。未存过时由迁移推断决定（§三.3）。
   *  即时保存字段：改它不走保存条（Settings 里同步挪快照 + persistVoicePrefs 落盘）。 */
  voiceProvider?: VoiceProvider;
  /** 云模式朗读音色（me/config ttsVoices 里的 id，缺省用服务端默认音色）。即时保存。 */
  voiceGatewayVoice?: string;
  /** 云模式跟读打分本地开关（服务端 iseEnabled 之上的个人开关，缺省开）。即时保存。 */
  voiceGatewayIseEnabled?: boolean;
}

/** 按服务商分桶的密钥库：providerId -> apiKey。整体经 DPAPI 加密落盘。 */
export type KeyVault = Record<string, string>;

/** 自定义接口（不匹配任何预设）在 vault 中的桶名。 */
export const CUSTOM_PROVIDER_ID = "custom";

const STORAGE_KEY = "immersive-translator-settings";
const ONBOARDING_KEY = "immersive-translator-onboarding-dismissed";

/** 是否已关闭首次引导横幅。 */
export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOnboardingDismissed(v: boolean): void {
  try {
    if (v) localStorage.setItem(ONBOARDING_KEY, "1");
    else localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    /* ignore */
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o-mini",
  providerId: "openai",
  translationMode: "auto",
  fixedTarget: "",
  customStyle: "",
  glossaryText: "",
  stream: true,
  dictCard: "auto",
  hotkey: "Ctrl+Shift+Q",
  ocrHotkey: "Ctrl+Shift+E",
  readerHotkey: "Ctrl+Shift+R",
};

/** localStorage 里保存的非敏感字段（apiKey 走 DPAPI，不落明文）。 */
type PersistedSettings = Omit<AppSettings, "apiKey">;

type PersistedRawReader = () => string | null;
type PersistedRawWriter = (raw: string | null) => void;
type SecretWriter = (value: string) => Promise<void>;

interface LoadedPersistedSettings {
  settings: PersistedSettings;
  legacyApiKey?: string;
}

function defaultPersistedSettings(): PersistedSettings {
  const { apiKey: _ignored, ...rest } = DEFAULT_SETTINGS;
  return rest;
}

function loadPersistedState(): LoadedPersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { settings: defaultPersistedSettings() };
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings JSON must be an object");
    }
    const { apiKey, ...persisted } = parsed as Record<string, unknown>;
    return {
      settings: { ...defaultPersistedSettings(), ...persisted } as PersistedSettings,
      legacyApiKey:
        typeof apiKey === "string" && apiKey.trim() !== "" ? apiKey : undefined,
    };
  } catch {
    return { settings: defaultPersistedSettings() };
  }
}

function loadPersisted(): PersistedSettings {
  return loadPersistedState().settings;
}

function savePersisted(p: PersistedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

function formatPersistenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析 DPAPI 槽位内容为密钥库。兼容两种旧格式：
 * 纯文本 key（归入 fallbackProviderId 桶）或单个 apiKey 字符串 JSON。
 */
export function parseKeyVault(raw: string, fallbackProviderId: string): KeyVault {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const vault: KeyVault = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim() !== "") vault[k] = v;
      }
      return vault;
    }
  } catch {
    /* 不是 JSON：按旧版纯文本 key 处理 */
  }
  return { [fallbackProviderId]: trimmed };
}

/** 当前生效的服务商 id：一律从 endpoint 推断（预设精确匹配，自定义接口归 custom）。
 *  不读已保存的 providerId：旧版可能存了与 endpoint 不一致的值，以实际请求的 endpoint 为准。
 *  platformEndpoint：沉浸云网关地址（动态），传入后命中即归 immersive-cloud。 */
export function providerIdFor(
  settings: Pick<AppSettings, "endpoint">,
  platformEndpoint?: string,
): string {
  return findMatchingPreset(settings.endpoint, platformEndpoint)?.id ?? CUSTOM_PROVIDER_ID;
}

/** 解析沉浸云网关地址（与 Rust 侧 gateway_endpoint 同构派生）。
 *  沉浸云未开放（auth_server_base_url 返回 null）或调用失败（非 Tauri 环境）
 *  时返回 undefined：此时沉浸云 endpoint 无法识别，按自定义接口处理。 */
async function resolvePlatformEndpoint(): Promise<string | undefined> {
  try {
    const base = await authServerBaseUrl();
    return base ? platformEndpoint(base) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 旧版迁移自愈：单 key 时代的数据可能被归在错误的桶里。
 * 若整库只有一个 key、不在当前服务商的桶、且当前桶为空，则视为旧数据，归还给当前服务商。
 * 本机接口（localhost）不参与：它本就不需要 Key，不应吞掉别的服务商的 Key。
 */
export function adoptMisplacedSingleKey(
  vault: KeyVault,
  providerId: string,
  endpointIsLocal: boolean,
): KeyVault | null {
  const ids = Object.keys(vault);
  if (ids.length !== 1 || ids[0] === providerId) return null;
  const key = vault[ids[0]];
  if (!key || endpointIsLocal) return null;
  return { [providerId]: key };
}

/**
 * Persist non-sensitive settings and the DPAPI secret as one recoverable
 * operation. The injected storage functions keep the rollback behavior
 * testable without requiring a browser or Tauri runtime.
 */
export async function persistSettingsTransaction(
  settings: AppSettings,
  readRaw: PersistedRawReader,
  writeRaw: PersistedRawWriter,
  writeSecret: SecretWriter,
): Promise<void> {
  const previousRaw = readRaw();
  const { apiKey, ...rest } = settings;

  writeRaw(JSON.stringify(rest));
  try {
    await writeSecret(apiKey);
  } catch (error) {
    try {
      writeRaw(previousRaw);
    } catch (rollbackError) {
      throw new Error(
        `保存 API Key 失败：${formatPersistenceError(error)}；恢复设置失败：${formatPersistenceError(rollbackError)}`,
      );
    }
    throw error;
  }
}

/** Update only the persisted hotkey without saving other edited form fields. */
export function persistHotkeyField(
  hotkey: string,
  readRaw: PersistedRawReader,
  writeRaw: (raw: string) => void,
): void {
  const raw = readRaw();
  let persisted: Record<string, unknown>;

  if (raw === null) {
    const { apiKey: _ignored, ...defaults } = DEFAULT_SETTINGS;
    persisted = defaults;
  } else {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("已保存的设置格式无效");
    }
    const { apiKey: _ignored, ...withoutLegacySecret } = parsed as Record<string, unknown>;
    persisted = withoutLegacySecret;
  }

  writeRaw(JSON.stringify({ ...persisted, hotkey }));
}

export function savePersistedHotkey(hotkey: string): void {
  persistHotkeyField(
    hotkey,
    () => localStorage.getItem(STORAGE_KEY),
    (raw) => localStorage.setItem(STORAGE_KEY, raw),
  );
}

// ---- 语音服务商偏好（voiceProvider / voiceGatewayVoice / voiceGatewayIseEnabled）----
// 与保存条解耦（契约 §三.2）：点卡即写盘，这里只合并这几个字段、不触碰其余设置；
// 同时从保存条 dirty 比较里剔除（stripVoicePrefs），云同步本就不含 AppSettings（决策 6）。

/** 迁移推断（契约 §三.3，纯函数）：任一讯飞凭据存在 → 保持 xfyun（零感知）；否则默认 gateway。
 *  高级覆盖用户可以只配单独凭据不配主凭据，所以三个槽位的「存在性」都算数。 */
export function inferVoiceProvider(xfyunCreds: {
  iseMain: boolean;
  ttsOwn: boolean;
  asrOwn: boolean;
}): VoiceProvider {
  return xfyunCreds.iseMain || xfyunCreds.ttsOwn || xfyunCreds.asrOwn ? "xfyun" : "gateway";
}

/**
 * 语音页取生效服务商：已存值优先；未存过时按讯飞凭据存在性推断（§三.3）。
 * 推断结果只作展示默认，不代写盘——首次用户点击时才落盘。
 */
export async function resolveInitialVoiceProvider(
  stored: VoiceProvider | undefined,
): Promise<VoiceProvider> {
  if (stored === "gateway" || stored === "xfyun") return stored;
  const presence = await xfyunCredentialPresence().catch(() => ({
    iseMain: false,
    ttsOwn: false,
    asrOwn: false,
  }));
  return inferVoiceProvider(presence);
}

/** 保存条 dirty 比较用：剔除即时保存的语音偏好字段。 */
export function stripVoicePrefs(
  settings: AppSettings,
): Omit<AppSettings, "voiceProvider" | "voiceGatewayVoice" | "voiceGatewayIseEnabled"> {
  const { voiceProvider: _p, voiceGatewayVoice: _v, voiceGatewayIseEnabled: _i, ...rest } = settings;
  return rest;
}

export interface VoicePrefsPatch {
  voiceProvider?: VoiceProvider;
  voiceGatewayVoice?: string;
  voiceGatewayIseEnabled?: boolean;
}

/** 只把语音偏好字段合并进已保存设置（persistHotkeyField 同款注入式实现，便于单测）。 */
export function persistVoicePrefsField(
  patch: VoicePrefsPatch,
  readRaw: PersistedRawReader,
  writeRaw: (raw: string) => void,
): void {
  let persisted: Record<string, unknown>;
  const raw = readRaw();
  if (raw === null) {
    const { apiKey: _ignored, ...defaults } = DEFAULT_SETTINGS;
    persisted = defaults;
  } else {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("已保存的设置格式无效");
    }
    const { apiKey: _ignored, ...withoutLegacySecret } = parsed as Record<string, unknown>;
    persisted = withoutLegacySecret;
  }
  writeRaw(JSON.stringify({ ...persisted, ...patch }));
}

/** 点卡即写盘：语音偏好不等「保存设置」，立即合并进 localStorage。 */
export function saveVoicePrefs(patch: VoicePrefsPatch): void {
  persistVoicePrefsField(
    patch,
    () => localStorage.getItem(STORAGE_KEY),
    (raw) => localStorage.setItem(STORAGE_KEY, raw),
  );
}

/**
 * 加载设置 + 完整密钥库（异步）。localStorage 存非敏感字段，DPAPI 存按服务商
 * 分桶的 KeyVault。设置窗口用这份完整 vault 做「切换服务商 → 切换 Key」。
 */
export async function loadSettingsFullAsync(): Promise<{
  settings: AppSettings;
  vault: KeyVault;
}> {
  const { settings: persisted, legacyApiKey } = loadPersistedState();
  const providerId = providerIdFor(persisted, await resolvePlatformEndpoint());

  if (legacyApiKey !== undefined) {
    // 迁移：旧版明文 key（localStorage）搬进 vault 对应服务商的桶
    const raw = await secretGet();
    const vault: KeyVault = { ...parseKeyVault(raw, providerId), [providerId]: legacyApiKey };
    await secretSet(JSON.stringify(vault));
    savePersisted({ ...persisted, providerId });
    return { settings: { ...persisted, providerId, apiKey: legacyApiKey }, vault };
  }

  const raw = await secretGet();
  let vault = parseKeyVault(raw, providerId);
  // 旧版单 key 被错误归桶时自动归还（如 DeepSeek 的 key 存到了 openai 桶）
  const adopted = adoptMisplacedSingleKey(
    vault,
    providerId,
    isLocalhostEndpoint(persisted.endpoint),
  );
  if (adopted) {
    vault = adopted;
    await secretSet(JSON.stringify(vault));
  }
  return {
    settings: { ...persisted, providerId, apiKey: vault[providerId] ?? "" },
    vault,
  };
}

/** 保存设置 + 完整密钥库（异步）。vault 中当前服务商的桶以 settings.apiKey 为准。 */
export async function saveSettingsFullAsync(
  settings: AppSettings,
  vault: KeyVault,
): Promise<void> {
  const providerId = providerIdFor(settings, await resolvePlatformEndpoint());
  const merged: KeyVault = { ...vault, [providerId]: settings.apiKey };
  const { apiKey: _omitted, ...rest } = settings;

  const previousRaw = localStorage.getItem(STORAGE_KEY);
  savePersisted({ ...rest, providerId });
  try {
    await secretSet(JSON.stringify(merged));
  } catch (error) {
    try {
      if (previousRaw === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previousRaw);
    } catch (rollbackError) {
      throw new Error(
        `保存 API Key 失败：${formatPersistenceError(error)}；恢复设置失败：${formatPersistenceError(rollbackError)}`,
      );
    }
    throw error;
  }
}

/**
 * 加载设置（异步）。apiKey 取当前服务商桶里的值，其余从 localStorage。
 * 兼容旧签名；需要完整 vault（切换服务商）时用 loadSettingsFullAsync。
 */
export async function loadSettingsAsync(): Promise<AppSettings> {
  const { settings } = await loadSettingsFullAsync();
  return settings;
}

/**
 * 保存设置（异步）。apiKey 写入当前服务商桶，其余桶保持 DPAPI 里已有的值。
 */
export async function saveSettingsAsync(settings: AppSettings): Promise<void> {
  const providerId = providerIdFor(settings, await resolvePlatformEndpoint());
  const raw = await secretGet();
  const vault = parseKeyVault(raw, providerId);
  await saveSettingsFullAsync(settings, vault);
}

// ---- 同步读取（仅用于翻译浮窗的快速校验 / 缺 Key 时引导）----
// 注意：同步版本读不到 DPAPI 里的 apiKey，只能拿到 hasApiKey 标记外的字段。
// 翻译流程现在统一走 loadSettingsAsync。

/**
 * 同步读取非敏感设置 + DPAPI 不可用的占位 apiKey（空串）。
 * 仅用于不需要真实 Key 的快速路径。需要 Key 的流程请用 loadSettingsAsync。
 */
export function loadSettings(): AppSettings {
  return { ...loadPersisted(), apiKey: "" };
}

export function saveSettings(settings: AppSettings): void {
  // 向后兼容：老的同步调用退化为只存非敏感字段 + fire-and-forget 写 Key。
  void saveSettingsAsync(settings).catch((error) => {
    console.error("[settingsStore] save failed", error);
  });
}

/**
 * 判断是否已配置好可用的接口。
 * 沉浸云：账号令牌由 Rust 网关自动附带（endpoint 命中即识别），允许空 Key；
 * 本地接口（localhost）允许留空 API Key。
 */
export function hasValidSettings(settings: AppSettings): boolean {
  const endpointOk = settings.endpoint.trim() !== "";
  if (!endpointOk) return false;
  if (settings.providerId === PLATFORM_PROVIDER_ID) return true;
  const isLocal = isLocalhostEndpoint(settings.endpoint);
  return settings.apiKey.trim() !== "" || isLocal;
}

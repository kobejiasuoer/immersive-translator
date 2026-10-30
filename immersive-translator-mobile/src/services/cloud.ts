import { useSyncExternalStore } from "react";
import { invokeRaw, isTauri } from "./device";

export interface Account { id: string; email: string; nickname: string | null; plan: string }
interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; user: Account }
export interface CloudConfig {
  gateway: { llm: string; voiceTicket: string; voiceAsrStream: string; voiceTtsStream: string };
  models: (string | { id: string })[];
  voice: { ttsVoices: unknown[]; asrLanguages: string[]; iseEnabled: boolean; quota: unknown };
  features: { sync: boolean };
  sync?: { protocolVersion: number; collections: Record<string, { schemaVersions: number[]; maxEntityBytes: number }>; maxPushEntities: number; maxBodyBytes: number };
}
interface CloudState { account: Account | null; config: CloudConfig | null; baseUrl: string; generation: number; restored: boolean }
const DEFAULT_BASE = import.meta.env.VITE_API_BASE_URL || "https://www.prismspace.online";
let state: CloudState = { account: null, config: null, baseUrl: DEFAULT_BASE, generation: 0, restored: false };
let tokens: Tokens | null = null;
let refreshFlight: { generation: number; promise: Promise<void> } | null = null;
let restoreFlight: Promise<void> | null = null;
let secretQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const active = new Set<AbortController>();
const SECRET = "mobile.account.session.v1";
function emit() { listeners.forEach(fn => fn()); }
export function cloudState(): CloudState { return state; }
export function useCloud(): CloudState { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, cloudState); }
export class CloudError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "network_error", readonly retryAfter?: string) { super(message); }
}
export interface HttpResult { status: number; body: string; headers: Record<string,string>; url: string }
export async function httpRequest(url: string, method = "GET", body?: unknown, headers: Record<string,string> = {}, signal?: AbortSignal, followRedirects = false, responseType: "text" | "base64" = "text"): Promise<HttpResult> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  const requestHeaders = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  if (isTauri()) {
    const requestId = crypto.randomUUID();
    const abort = () => { void invokeRaw("mobile_http_cancel", { requestId }).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await invokeRaw<HttpResult>("mobile_http_request", { request: { requestId, url, method, body: serialized ?? null, headers: requestHeaders, followRedirects, responseType } });
      if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
      return result;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
      throw new CloudError(String(error), 0, "unknown_result");
    } finally { signal?.removeEventListener("abort", abort); }
  }
  const response = await fetch(url, { method, headers: requestHeaders, body: serialized, signal, redirect: followRedirects ? "follow" : "error", credentials: "omit" });
  let content: string;
  if (responseType === "base64") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 32 * 1024 * 1024) throw new CloudError("文件超过 32 MiB 限制", 413, "response_too_large");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    content = btoa(binary);
  } else content = await response.text();
  return { status: response.status, body: content, headers: Object.fromEntries(response.headers.entries()), url: response.url };
}
function parsed<T>(response: HttpResult): T {
  let data: unknown;
  try { data = response.body ? JSON.parse(response.body) : null; } catch { throw new CloudError("服务返回了无法识别的响应", response.status); }
  if (response.status < 200 || response.status >= 300) {
    const error = data && typeof data === "object" ? data as Record<string,unknown> : {};
    const nested = error.error && typeof error.error === "object" ? error.error as Record<string,unknown> : error;
    throw new CloudError(typeof nested.message === "string" ? nested.message : `服务请求失败（${response.status}）`, response.status, typeof nested.code === "string" ? nested.code : "request_failed", response.headers["retry-after"]);
  }
  return data as T;
}
export function setCloudBase(value: string): void {
  const url = new URL(value.trim());
  if (url.username || url.password || (url.protocol !== "https:" && !(import.meta.env.DEV && url.protocol === "http:"))) throw new Error("服务地址需要 HTTPS");
  if (tokens) throw new Error("请先退出账号再切换服务");
  if (url.origin === state.baseUrl) return;
  invalidate(); state = { ...state, baseUrl: url.origin, config: null }; emit();
}
function endpoint(path: string): string {
  const url = new URL(path, state.baseUrl);
  if (url.origin !== new URL(state.baseUrl).origin) throw new Error("拒绝向其他服务发送账号凭证");
  return url.toString();
}
function invalidate(): number {
  active.forEach(request => request.abort()); active.clear();
  state = { ...state, generation: state.generation + 1 };
  return state.generation;
}
function checkGeneration(generation: number): void {
  if (generation !== state.generation) throw new DOMException("账号已切换", "AbortError");
}
function serialSecret<T>(work: () => Promise<T>): Promise<T> {
  const next = secretQueue.catch(() => undefined).then(work); secretQueue = next; return next;
}
async function persistSession(value: Tokens | null, generation: number, baseUrl = state.baseUrl): Promise<void> {
  await serialSecret(async () => {
    checkGeneration(generation);
    // Browser preview is memory-only. Never fall back to plaintext token storage.
    if (isTauri()) {
      if (value) await invokeRaw("secret_put", { key: SECRET, value: JSON.stringify({ ...value, baseUrl }) });
      else await invokeRaw("secret_delete", { key: SECRET });
    }
    checkGeneration(generation);
  });
}
export async function restoreCloud(): Promise<void> {
  if (state.restored) return;
  if (restoreFlight) return restoreFlight;
  const generation = state.generation;
  const flight = (async () => {
  if (isTauri()) {
    let raw: string | null;
    try { raw = await serialSecret(() => invokeRaw<string | null>("secret_get", { key: SECRET })); }
    catch(error) { if (import.meta.env.DEV && String(error).includes("SECURE_STORAGE_UNSUPPORTED")) raw = null; else throw error; }
    checkGeneration(generation);
    if (raw) {
      const session = JSON.parse(raw) as Tokens & { baseUrl: string };
      if (!session.user?.id || !session.refreshToken || !session.accessToken || !session.baseUrl) throw new Error("账号凭证损坏，请重新登录；本机资料仍保留");
      const url = new URL(session.baseUrl);
      if (url.username || url.password || (url.protocol !== "https:" && !(import.meta.env.DEV && url.protocol === "http:"))) throw new Error("保存的服务地址不安全，请重新登录");
      tokens = session; state = { ...state, baseUrl: url.origin, account: session.user };
    }
  }
  checkGeneration(generation);
  state = { ...state, restored: true }; emit();
  })();
  restoreFlight = flight;
  try { await flight; } finally { if (restoreFlight === flight) restoreFlight = null; }
}
async function rotate(failedAccess: string, generation: number): Promise<void> {
  checkGeneration(generation);
  if (tokens?.accessToken !== failedAccess) return;
  if (!refreshFlight || refreshFlight.generation !== generation) {
    const refreshToken = tokens?.refreshToken;
    if (!refreshToken) throw new CloudError("请重新登录后继续，草稿已保留", 401, "login_required");
    const accountId = tokens!.user.id;
    const controller = new AbortController(); active.add(controller);
    const flight = { generation, promise: Promise.resolve() };
    flight.promise = (async () => {
      let next: Tokens;
      try { next = parsed<Tokens>(await httpRequest(endpoint("/v1/auth/refresh"), "POST", { refreshToken }, {}, controller.signal)); }
      catch (error) {
        checkGeneration(generation);
        if (error instanceof CloudError && error.status === 401) {
          tokens = null; const clearedGeneration = invalidate(); state = { ...state, account: null, config: null }; emit();
          await persistSession(null, clearedGeneration);
          throw new CloudError("登录已失效，请重新登录；本地草稿仍保留", 401, "login_required");
        }
        throw error;
      }
      checkGeneration(generation);
      if (next.user?.id !== accountId || !next.accessToken || !next.refreshToken) throw new Error("刷新凭证响应不完整或账号不符");
      // Persist the rotated token before any request can replay. A failed save blocks replay.
      try { await persistSession(next, generation); } catch(error) {
        checkGeneration(generation);
        tokens = null; const nextGeneration = invalidate(); state = { ...state, account: null, config: null }; emit();
        await persistSession(null, nextGeneration).catch(() => undefined);
        throw new Error("刷新凭证未能安全保存，请重新登录；本地资料仍保留。" + String(error));
      }
      checkGeneration(generation);
      tokens = next; state = { ...state, account: next.user }; emit();
    })().finally(() => { active.delete(controller); if (refreshFlight === flight) refreshFlight = null; });
    refreshFlight = flight;
  }
  await refreshFlight.promise; checkGeneration(generation);
}
export async function cloudRequest<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!tokens) throw new CloudError("登录后即可继续当前操作", 401, "login_required");
  const generation = state.generation;
  const access = tokens.accessToken;
  const controller = new AbortController(); active.add(controller);
  const abort = () => controller.abort(); if(signal?.aborted) controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  try {
    const execute = () => { checkGeneration(generation); if (!tokens) throw new CloudError("请重新登录后继续", 401, "login_required"); return httpRequest(endpoint(path), method, body, { authorization: `Bearer ${tokens.accessToken}` }, controller.signal); };
    let result: T;
    try { result = parsed<T>(await execute()); } catch (error) {
      if (!(error instanceof CloudError) || error.status !== 401 || error.code !== "token_expired") throw error;
      await rotate(access, generation); result = parsed<T>(await execute());
    }
    if (generation !== state.generation) throw new DOMException("账号已切换", "AbortError");
    return result;
  } finally { active.delete(controller); signal?.removeEventListener("abort", abort); }
}
export async function requestOtp(email: string): Promise<void> { parsed(await httpRequest(endpoint("/v1/auth/otp/request"), "POST", { email: email.trim().toLowerCase() })); }
export async function login(email: string, credential: string, mode: "otp" | "password"): Promise<Account> {
  const generation = invalidate(); const baseUrl = state.baseUrl;
  const device = { platform: "ios", name: isTauri() ? "iPhone" : "移动端浏览器预览" };
  const next = parsed<Tokens>(await httpRequest(endpoint(mode === "otp" ? "/v1/auth/otp/verify" : "/v1/auth/login"), "POST", { email: email.trim().toLowerCase(), [mode === "otp" ? "code" : "password"]: credential, device }));
  if (!next.user?.id || !next.accessToken || !next.refreshToken) throw new Error("登录响应不完整");
  checkGeneration(generation); await persistSession(next, generation, baseUrl); checkGeneration(generation);
  tokens = next; state = { ...state, account: next.user, config: null }; emit(); return next.user;
}
export async function loadCloudConfig(): Promise<CloudConfig> {
  const generation = state.generation;
  const config = await cloudRequest<CloudConfig>("/v1/me/config"); checkGeneration(generation); state = { ...state, config }; emit(); return config;
}
export async function logout(): Promise<void> {
  const previous = tokens, url = endpoint("/v1/auth/logout");
  const generation = invalidate(); tokens = null; state = { ...state, account: null, config: null }; emit();
  if (previous) void httpRequest(url, "POST", undefined, { authorization: `Bearer ${previous.accessToken}` }).catch(() => undefined);
  await persistSession(null, generation);
}
export async function cloudChat(system: string, messages: { role: "user" | "assistant"; content: string }[], signal?: AbortSignal): Promise<string> {
  const generation = state.generation;
  const input = messages.map(message => ({ ...message }));
  const config = state.config ?? await loadCloudConfig();
  if (signal?.aborted || generation !== state.generation) throw new DOMException("账号已切换或操作已取消", "AbortError");
  const model = config.models[0];
  if (!model) throw new Error("当前账号没有可用模型");
  const result = await cloudRequest<{ choices?: { message?: { content?: string } }[] }>(config.gateway.llm, "POST", { model: typeof model === "string" ? model : model.id, stream: false, messages: [{ role: "system", content: system }, ...input] }, signal);
  const text = result.choices?.[0]?.message?.content; if (!text?.trim()) throw new Error("模型没有返回有效内容"); return text;
}

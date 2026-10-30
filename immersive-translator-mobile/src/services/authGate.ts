import { useSyncExternalStore } from "react";
import { actions, activeRepository, finishGuestClaim, flushPersist, getState, mergeGuestClaim, prepareGuestClaim, profileIdentity, replaceSyncedState, switchProfile, type DictEntry, type Sheet } from "../store";
import { createPersistence } from "../core/persistence";
import type { AudioRead } from "../core/persistence";
import { cloudState, logout } from "./cloud";
export interface LoginIntent { taskId?: string; articleId?: string; reason?: string; dictionary?: { entry: DictEntry; signal: AbortSignal } }
let intent: LoginIntent | null = null;
let pending: Promise<boolean> | null = null;
let settle: ((ok: boolean) => void) | null = null;
let claimSource: { intent: LoginIntent | null; accountId: string; profile: string; state: ReturnType<typeof getState>; audio: { id: string; data: AudioRead }[] } | null = null;
let claimFlight: Promise<void> | null = null;
let loginProfile: string | null = null;
let cancelFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
const continuedDictionary = new WeakMap<AbortSignal, { entry: DictEntry; accountId: string; generation: number }>();
export function canContinueDictionaryLogin(entry: DictEntry, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  const current = getState().sheet;
  if (current?.kind !== "dict" || current.entry !== entry) return false;
  if (intent?.dictionary?.entry === entry && intent.dictionary.signal === signal) return true;
  const completed = continuedDictionary.get(signal), cloud = cloudState();
  return !!completed && completed.entry === entry && completed.accountId === cloud.account?.id && completed.generation === cloud.generation && profileIdentity() === completed.accountId;
}
export function useLoginIntent() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => intent); }
export function ensureAccount(next: LoginIntent = {}): Promise<boolean> {
  if (cloudState().account && profileIdentity() === cloudState().account!.id) return Promise.resolve(true);
  if (pending) return pending;
  loginProfile = profileIdentity(); intent = next; pending = new Promise(resolve => { settle = resolve; }); emit(); return pending;
}
export async function cancelLogin(): Promise<void> {
  if (cancelFlight) return cancelFlight;
  const flight = (async () => {
    const dictionary = intent?.dictionary, sheet = getState().sheet;
    const retainSheet = dictionary && sheet?.kind === "dict" && sheet.entry === dictionary.entry ? {sheet,valid:()=>!dictionary.signal.aborted} : undefined;
    if (cloudState().account) {
      await logout();
      // A completed account write remains in that account's repository.
      if (loginProfile) await switchProfile(loginProfile, false, {retainSheet});
    }
    const resolve = settle; intent = null; pending = null; settle = null; claimSource = null; loginProfile = null; emit(); resolve?.(false);
  })();
  cancelFlight = flight;
  try { await flight; } finally { if (cancelFlight === flight) cancelFlight = null; }
}
export async function completeLogin(bringGuest: boolean): Promise<void> {
  if (claimFlight) return claimFlight;
  const flight = claimLogin(bringGuest); claimFlight = flight;
  try { await flight; } finally { if (claimFlight === flight) claimFlight = null; }
}
/** Restore only an already account-bound transaction before App/sync starts. */
export async function recoverPendingGuestClaim(): Promise<void> {
  const account=cloudState().account;
  if (!account) return;
  if (profileIdentity()!==account.id) throw new Error("请先载入当前账号资料再恢复认领");
  if (claimFlight) return claimFlight;
  const flight=claimLogin(false,true);claimFlight=flight;
  try { await flight; } finally { if(claimFlight===flight)claimFlight=null; }
}
async function claimLogin(bringGuest: boolean, recoverOnly = false): Promise<void> {
  const account = cloudState().account; if (!account) throw new Error("登录尚未完成");
  const generation = cloudState().generation, requestedIntent = intent;
  const check = () => { if (cloudState().generation !== generation || cloudState().account?.id !== account.id || intent !== requestedIntent) throw new DOMException("登录或资料认领已取消", "AbortError"); };
  if (!claimSource || claimSource.intent !== requestedIntent || claimSource.accountId !== account.id) {
    await flushPersist(); check();
    const oldRepository = activeRepository(), current = getState();
    // Never import data from a different signed-in profile.
    if (oldRepository.identity !== "guest" && oldRepository.identity !== account.id) throw new Error("当前资料属于其他账号，请先退出再登录");
    check();
    claimSource = { intent: requestedIntent, accountId: account.id, profile: oldRepository.identity, state: current, audio: [] };
  }
  const source = claimSource, current = source.state;
  const task = current.tasks.find(t => t.id === requestedIntent?.taskId);
  const articleId = requestedIntent?.articleId ?? task?.source?.articleId;
  const article = current.articles.find(a => a.id === articleId);
  const valid = () => cloudState().generation === generation && cloudState().account?.id === account.id && intent === requestedIntent;
  const guestClaim = await prepareGuestClaim(account.id, bringGuest, {taskId: requestedIntent?.taskId,articleId}, valid, recoverOnly);
  check();
  if (recoverOnly && !guestClaim) { claimSource=null;return; }
  const selectedTasks = guestClaim ? guestClaim.state.tasks : source.profile === "guest" ? [] : task ? [task] : [];
  const clips = new Set(selectedTasks.flatMap(t => t.attempts.flatMap(a => a.clipId ? [a.clipId] : [])));
  // Recovery reads audio only from the original guest namespace.
  if (guestClaim && clips.size) {
    const guest = await createPersistence("guest");
    try {
      source.audio = [];
      for (const id of clips) {
        check();
        try {
          let manifest = await guest.audioManifest(id); check();
          if (!manifest) throw new Error("源录音不存在");
          if (manifest.status === "interrupted" && manifest.byteLength > 0) manifest = await guest.audioFinalize(id);
          if (manifest.status !== "ready") throw new Error("源录音尚未完整保存");
          const data = await guest.audioRead(id); check();
          source.audio.push({id,data});
        } catch (error) {
          check();
          throw new Error("原声迁移尚未完成，资料仍绑定此账号保留，请修复本地存储后重试：" + (error instanceof Error ? error.message : String(error)));
        }
      }
    } finally { guest.close(); }
    check();
  }
  const dictionary = requestedIntent?.dictionary;
  const originalSheet: Sheet | null = getState().sheet;
  const retainSheet = dictionary && originalSheet?.kind === "dict" && originalSheet.entry === dictionary.entry ? { sheet: originalSheet, valid: () => intent === requestedIntent && !dictionary.signal.aborted } : undefined;
  await switchProfile(account.id, false, {valid,retainSheet}); check();
  const target = activeRepository();
  const checkTarget = () => { check(); if (activeRepository() !== target || target.identity !== account.id) throw new DOMException("本地资料已切换", "AbortError"); };
  for (const clip of source.audio) if (clips.has(clip.id)) {
    checkTarget();
    const manifest = await target.audioManifest(clip.id); checkTarget();
    if (manifest?.status === "ready") continue;
    if (manifest && manifest.status !== "recording") { await target.audioDelete(clip.id); checkTarget(); }
    const bytes = atob(clip.data.wavB64).slice(44);
    await target.audioBegin(clip.id, clip.data.manifest.metadata); checkTarget();
    for(let offset=0,seq=0;offset<bytes.length;offset+=524288,seq++) { await target.audioAppend(clip.id,seq,btoa(bytes.slice(offset,offset+524288))); checkTarget(); }
    await target.audioFinalize(clip.id); checkTarget();
  }
  const merge = <T extends { id: string }>(left: T[], right: T[]) => [...left, ...right.filter(row => !left.some(old => old.id === row.id))];
  checkTarget();
  await replaceSyncedState(latest => {
    checkTarget();
    return guestClaim ? mergeGuestClaim(latest,guestClaim.state) : { articles: source.profile !== "guest" && article ? merge(latest.articles,[article]) : latest.articles, tasks: source.profile !== "guest" && task ? merge(latest.tasks,[task]) : latest.tasks, onboarded: true };
  });
  checkTarget(); actions.setOnboarded(); await flushPersist(); checkTarget();
  if (guestClaim) { await finishGuestClaim(account.id,valid); checkTarget(); }
  if (dictionary && !dictionary.signal.aborted && getState().sheet?.kind === "dict" && (getState().sheet as Extract<Sheet,{kind:"dict"}>).entry === dictionary.entry) continuedDictionary.set(dictionary.signal,{entry:dictionary.entry,accountId:account.id,generation});
  const resolve = settle; intent = null; pending = null; settle = null; claimSource = null; loginProfile = null; emit(); resolve?.(true);
}

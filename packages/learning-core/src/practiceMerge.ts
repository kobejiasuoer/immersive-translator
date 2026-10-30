type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const clocks = (row: Row): Row => object(row.fieldUpdatedAt) ? row.fieldUpdatedAt : {};
const ignored = new Set(["updatedAt", "fieldUpdatedAt", "fieldShadow", "attempts", "removedAttemptIds"]);
// Unicode scalar ordering also matches Rust's UTF-8 string ordering.
function compare(a: string, b: string): number {
  const aa = Array.from(a), bb = Array.from(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) { const d = aa[i].codePointAt(0)! - bb[i].codePointAt(0)!; if (d) return d; }
  return aa.length - bb.length;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort(compare).map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const encoded = (value: unknown) => value === undefined ? "􏿿" : stable(value);
const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const parts = (path: string) => path.slice(1).split("/").map(k=>k.replace(/~1/g,"/").replace(/~0/g,"~"));
interface Register { at: number; value: unknown }
type Registers = Map<string, Register>;
function flatten(row: Row): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const visit = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (object(value) && Object.keys(value).some(k=>value[k]!==undefined)) {
      for (const key of Object.keys(value)) visit(value[key], `${path}/${escape(key)}`);
    } else result.set(path, value);
  };
  for (const key of Object.keys(row)) if (!ignored.has(key)) visit(row[key], `/${escape(key)}`);
  return result;
}
function registers(row: Row, fallback: number): Registers {
  const values = flatten(row), result: Registers = new Map();
  if (object(row.fieldShadow)) for (const [path, value] of Object.entries(row.fieldShadow)) if (path.startsWith("/")) values.set(path,value);
  for (const [path,value] of values) {
    const legacy = clocks(row)[parts(path)[0]];
    result.set(path, {at:time(clocks(row)[path]) || time(legacy) || fallback,value});
  }
  for (const [key,at] of Object.entries(clocks(row))) {
    const path = key.startsWith("/") ? key : `/${escape(key)}`;
    if (!result.has(path) && (key.startsWith("/") || row[key] === undefined)) result.set(path,{at:time(at),value:undefined});
  }
  return result;
}
const rank = (a:Register,b:Register) => a.at-b.at || compare(encoded(a.value),encoded(b.value));
function materialize(regs: Registers, updatedAt: number): Row {
  const result: Row = {}, all = [...regs], visible = new Map<string,unknown>();
  for (const [path,reg] of all) {
    if (reg.value === undefined) continue;
    const blocked = all.some(([p,r])=>path.startsWith(`${p}/`)&&rank(r,reg)>=0);
    const descendant = all.some(([p,r])=>p.startsWith(`${path}/`)&&r.value!==undefined&&rank(r,reg)>0&&
      !all.some(([q,s])=>p.startsWith(`${q}/`)&&rank(s,r)>=0));
    if (!blocked&&!descendant) visible.set(path,reg.value);
  }
  for (const [path,value] of visible) {
    const keys = parts(path); let target=result;
    for (const key of keys.slice(0,-1)) {
      if (!Object.prototype.hasOwnProperty.call(target,key)||!object(target[key])) Object.defineProperty(target,key,{value:{},writable:true,enumerable:true,configurable:true});
      target=target[key] as Row;
    }
    Object.defineProperty(target,keys[keys.length-1],{value,writable:true,enumerable:true,configurable:true});
  }
  const fieldUpdatedAt:Record<string,number>={},fieldShadow:Row={};
  for(const [path,reg] of all.sort((a,b)=>compare(a[0],b[0]))) {
    fieldUpdatedAt[path]=reg.at;
    if(reg.value!==undefined&&!visible.has(path))fieldShadow[path]=reg.value;
  }
  result.updatedAt=Math.max(updatedAt,...all.map(([,r])=>r.at));
  result.fieldUpdatedAt=fieldUpdatedAt;
  // Hidden prefix/leaf values are rare; retain them to avoid order-dependent type changes.
  if(Object.keys(fieldShadow).length)result.fieldShadow=fieldShadow;
  return result;
}
function mergeFields(a: Row, b: Row, fallbackA: number, fallbackB: number): Row {
  const regs=registers(a,fallbackA);
  for(const [path,reg] of registers(b,fallbackB)){const old=regs.get(path);if(!old||rank(reg,old)>0)regs.set(path,reg);}
  return materialize(regs,Math.max(time(a.updatedAt),time(b.updatedAt),fallbackA,fallbackB));
}
/** Stamp only changed leaves; a clock with no visible/shadow value is a field clear. */
function stampFields(previous: Row | undefined, next: Row, at: number, fallback: number): Row {
  const regs=previous?registers(previous,fallback):registers(next,time(next.updatedAt));
  const before=flatten(previous??{}),after=flatten(next);
  for(const path of new Set([...before.keys(),...after.keys()])) {
    if(!previous||encoded(before.get(path))!==encoded(after.get(path)))regs.set(path,{at:Math.max(time(at),previous?(regs.get(path)?.at??0)+1:0),value:after.get(path)});
  }
  // Object promotion clears an old parent scalar and writes children in one edit.
  // Give those new leaves a later logical tick than the parent clear.
  for(const [path,value] of after){
    if(previous&&encoded(before.get(path))===encoded(value))continue;
    const ancestors=[...regs].filter(([p])=>path.startsWith(`${p}/`));
    const reg=regs.get(path)!;
    regs.set(path,{...reg,at:Math.max(reg.at,...ancestors.map(([,r])=>r.at+1))});
  }
  return materialize(regs,Math.max(time(at),time(previous?.updatedAt)));
}
export function stampPracticeTask<T extends object>(previous: T | undefined, next: T, at: number): T {
  const before = previous as Row | undefined, after = next as Row;
  const result = stampFields(before, after, at, time(before?.updatedAt));
  const oldAttempts = Array.isArray(before?.attempts) ? before.attempts.filter(object) : [];
  result.attempts = (Array.isArray(after.attempts) ? after.attempts.filter(object) : []).map(attempt => {
    const old = oldAttempts.find(a => a.id === attempt.id);
    return stampFields(old, attempt, at, time(old?.updatedAt) || time(before?.updatedAt));
  });
  const removed = [...new Set([before?.removedAttemptIds,after.removedAttemptIds].flatMap(value=>Array.isArray(value)?value.filter((id):id is string=>typeof id==="string"):[]))].sort(compare);
  if(removed.length){result.removedAttemptIds=removed;result.attempts=(result.attempts as Row[]).filter(a=>!removed.includes(String(a.id)));}
  return result as T;
}
/** Grow-only attempt IDs and removal IDs; task/attempt fields are stable LWW registers. */
export function mergePracticeTask<T extends object>(existing: T, incoming: T): T {
  const a = existing as Row, b = incoming as Row;
  if (typeof a.id !== "string" || a.id !== b.id) throw new Error("Practice task IDs differ");
  const ta = time(a.updatedAt), tb = time(b.updatedAt), result = mergeFields(a, b, ta, tb);
  const removed = new Set<string>([a.removedAttemptIds, b.removedAttemptIds].flatMap(value => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []));
  const attempts = new Map<string, Row>();
  for (const [task, fallback] of [[a, ta], [b, tb]] as const) {
    for (const attempt of Array.isArray(task.attempts) ? task.attempts.filter(object) : []) {
      if (typeof attempt.id !== "string" || removed.has(attempt.id)) continue;
      const normalized = mergeFields(attempt, attempt, time(attempt.updatedAt) || fallback, time(attempt.updatedAt) || fallback);
      const old = attempts.get(attempt.id);
      attempts.set(attempt.id, old ? mergeFields(old, normalized, time(old.updatedAt), time(normalized.updatedAt)) : normalized);
    }
  }
  result.attempts = [...attempts.values()].sort((x, y) => time(x.createdAt) - time(y.createdAt) || compare(String(x.id), String(y.id)));
  if (removed.size) result.removedAttemptIds = [...removed].sort(compare);
  return result as T;
}
/** Null means these are not two live versions of the same practice-task envelope. */
export function mergePracticePayload(existing: unknown, incoming: unknown): Row | null {
  if (!object(existing) || !object(incoming) || existing.kind !== "practice-task" || incoming.kind !== "practice-task" ||
      !object(existing.task) || !object(incoming.task) || typeof existing.task.id !== "string" || existing.task.id !== incoming.task.id) return null;
  const a = time(existing.updatedAt), b = time(incoming.updatedAt);
  const {task:_aTask,...envelopeA}=existing,{task:_bTask,...envelopeB}=incoming;
  envelopeA.endedAt=Math.max(a,b);envelopeB.endedAt=Math.max(a,b);
  const result = mergeFields(envelopeA,envelopeB,a,b);
  result.task = mergePracticeTask(existing.task, incoming.task);
  result.updatedAt = Math.max(a, b, time((result.task as Row).updatedAt));
  result.endedAt = result.updatedAt;
  return result;
}

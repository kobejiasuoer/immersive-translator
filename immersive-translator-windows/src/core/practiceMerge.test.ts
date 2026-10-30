import { describe, expect, it } from "vitest";
import { mergePracticePayload, mergePracticeTask, stampPracticeTask } from "../../../packages/learning-core/src/practiceMerge";
import { withoutAudio } from "../../../packages/learning-core/src/relay";
const attempt = (id: string, extra: Record<string, unknown> = {}) => ({ id, step: 0, text: id, deviceId: "phone", status: "draft", createdAt: 1, ...extra });
const task = (extra: Record<string, unknown> = {}) => ({ id: "practice-a", mode: "word", title: "Test", reference: "Hello", step: 0, draft: "", status: "active", createdAt: 1, updatedAt: 10, attempts: [attempt("old")], ...extra });
const envelope = (value: ReturnType<typeof task>) => ({ v: 2, kind: "practice-task", id: value.id, updatedAt: value.updatedAt, task: value });
describe("practice task offline merge", () => {
  it("scrubs audio bytes hidden in leaf-register metadata",()=>{
    const input={clipId:"local",fieldShadow:{"/audioB64":"secret","/future/pcm":"secret","/future/data":{audio:"secret",safe:true},"/clipId":"local"},fieldUpdatedAt:{"/audioB64":10,"/clipId":10}};
    expect(withoutAudio(input)).toEqual({clipId:"local",fieldShadow:{"/future/data":{safe:true},"/clipId":"local"},fieldUpdatedAt:{"/clipId":10}});
  });
  it("keeps each device's appended attempt and deterministic ordering", () => {
    const a = task({ attempts: [attempt("old"), attempt("phone", { createdAt: 20 })], updatedAt: 20 });
    const b = task({ attempts: [attempt("old"), attempt("windows", { createdAt: 30 })], updatedAt: 30 });
    expect(mergePracticeTask(a, b).attempts.map(a => a.id)).toEqual(["old", "phone", "windows"]);
    expect(mergePracticeTask(a, b)).toEqual(mergePracticeTask(b, a));
  });
  it("preserves independent expression feedback and acoustic assessment for one attempt", () => {
    const original = stampPracticeTask(undefined, task(), 10);
    const a = stampPracticeTask(original, task({ attempts: [attempt("old", { feedback: { message: "Good", extension: true } })] }), 20);
    const b = stampPracticeTask(original, task({ attempts: [attempt("old", { pronunciation: { total: 4.5 } })] }), 30);
    const merged = mergePracticeTask(a, b);
    expect(merged.attempts[0]).toMatchObject({ feedback: { message: "Good", extension: true }, pronunciation: { total: 4.5 } });
    expect(mergePracticeTask(b, a)).toEqual(merged);
  });
  it("advances only fields actually edited, preserving old scalar clocks", () => {
    const original = stampPracticeTask(undefined, task(), 10);
    const a = stampPracticeTask(original, { ...original, draft: "phone draft" }, 20);
    const b = stampPracticeTask(original, { ...original, step: 1 }, 30);
    expect(mergePracticeTask(a, b)).toMatchObject({ draft: "phone draft", step: 1 });
    expect((b as unknown as { fieldUpdatedAt: Record<string,number> }).fieldUpdatedAt["/draft"]).toBe(10);
  });
  it("resolves equal timestamps with a stable scalar tie-break", () => {
    const a = task({ draft: "a" }), b = task({ draft: "z" });
    expect(mergePracticeTask(a, b).draft).toBe("z");
    expect(mergePracticeTask(a, b)).toEqual(mergePracticeTask(b, a));
  });
  it("keeps explicit field clears across stale saves", () => {
    const original = stampPracticeTask(undefined, task({ attempts: [attempt("old", { error: "old failure" })] }), 10);
    const cleared = stampPracticeTask(original, task({ attempts: [attempt("old")] }), 20);
    const merged = mergePracticeTask(original, cleared);
    expect(merged.attempts[0]).not.toHaveProperty("error");
    expect(mergePracticeTask(merged, original)).toEqual(merged);
  });
  it("never resurrects canceled recording IDs from a stale device", () => {
    const canceled = task({ attempts: [], removedAttemptIds: ["old"], updatedAt: 20 });
    const stale = task({ attempts: [attempt("old", { clipId: "clip" })], updatedAt: 30 });
    const merged = mergePracticeTask(canceled, stale);
    expect(merged.attempts).toEqual([]);
    expect(merged).toMatchObject({ removedAttemptIds: ["old"] });
    expect(mergePracticeTask(stale, canceled)).toEqual(merged);
  });
  it("is associative and idempotent for three independent offline edits", () => {
    const original = stampPracticeTask(undefined, task(), 10);
    const a = stampPracticeTask(original, { ...original, draft: "A" }, 20);
    const b = stampPracticeTask(original, { ...original, step: 1 }, 25);
    const c = stampPracticeTask(original, { ...original, attempts: [...original.attempts, attempt("new")] }, 30);
    const merged = mergePracticeTask(mergePracticeTask(a, b), c);
    expect(mergePracticeTask(a, mergePracticeTask(b, c))).toEqual(merged);
    expect(mergePracticeTask(merged, merged)).toEqual(merged);
  });
  it("retains unknown nested fields when the updated result changes", () => {
    const a = task({ attempts: [attempt("old", { feedback: { message: "a", future: { format: 2 } } })] });
    const b = task({ attempts: [attempt("old", { feedback: { message: "b" } })], updatedAt: 20 });
    expect(mergePracticeTask(a, b).attempts[0]).toMatchObject({ feedback: { message: "b", future: { format: 2 } } });
  });
  it("converges for three equal-clock nested objects in every merge order",()=>{
    const a=task({future:{x:"A",z:0}}),b=task({future:{x:"B",y:0}}),c=task({future:{x:"C",a:0}});
    const left=mergePracticeTask(mergePracticeTask(a,b),c),right=mergePracticeTask(a,mergePracticeTask(b,c));
    expect(left).toEqual(right);expect(left).toMatchObject({future:{x:"C",z:0,y:0,a:0}});
  });
  it("retains independent nested feedback clocks across different edit times",()=>{
    const a=stampPracticeTask(undefined,task({attempts:[attempt("old",{feedback:{message:"newer"}})]}),20);
    const b=stampPracticeTask(undefined,task({attempts:[attempt("old",{feedback:{future:{version:2}}})]}),30);
    const c=stampPracticeTask(undefined,task({attempts:[attempt("old",{feedback:{message:"older"}})]}),10);
    const left=mergePracticeTask(mergePracticeTask(a,b),c),right=mergePracticeTask(a,mergePracticeTask(b,c));
    expect(left).toEqual(right);expect(left.attempts[0]).toMatchObject({feedback:{message:"newer",future:{version:2}}});
  });
  it("converges when an unknown field changes between object and scalar",()=>{
    const a=task({future:{x:1},updatedAt:10}),b=task({future:0,updatedAt:20}),c=task({future:{y:2},updatedAt:30});
    const left=mergePracticeTask(mergePracticeTask(a,b),c),right=mergePracticeTask(a,mergePracticeTask(b,c));
    expect(left).toEqual(right);expect(left).toMatchObject({future:{y:2}});
    expect(mergePracticeTask(left,left)).toEqual(left);
  });
  it("merges only matching task envelopes and retains envelope extensions", () => {
    const a = { ...envelope(task()), future: { level: 2 } }, b = envelope(task({ attempts: [attempt("new")], updatedAt: 20 }));
    expect(mergePracticePayload(a, b)).toMatchObject({ future: { level: 2 }, task: { attempts: [expect.objectContaining({ id: "new" }), expect.objectContaining({ id: "old" })] } });
    expect(mergePracticePayload(a, { ...b, task: { ...b.task, id: "other" } })).toBeNull();
    expect(mergePracticePayload(a, null)).toBeNull();
  });
  it("converges across every merge order for nested envelope fields",()=>{
    const a={...envelope(task()),future:{x:"A",z:0}},b={...envelope(task()),future:{x:"B",y:0}},c={...envelope(task()),future:{x:"C",a:0}};
    expect(mergePracticePayload(mergePracticePayload(a,b),c)).toEqual(mergePracticePayload(a,mergePracticePayload(b,c)));
  });
  it("normalizes derived envelope fields once, including legacy missing endedAt",()=>{
    const value=envelope(task()),merged=mergePracticePayload(value,value)!;
    expect(mergePracticePayload(merged,merged)).toEqual(merged);
  });
  it("keeps register algebra for object, scalar, array and clear transitions",()=>{
    const values=[undefined,null,0,"z",[],[1],{x:1},{x:2,y:0},{z:{a:2}}];
    for(let i=0;i<values.length;i++)for(let j=0;j<values.length;j++)for(let k=0;k<values.length;k++){
      const a=stampPracticeTask(undefined,task({future:values[i]}),10);
      const b=stampPracticeTask(a,task({future:values[j]}),20);
      const c=stampPracticeTask(a,task({future:values[k]}),30);
      expect(mergePracticeTask(mergePracticeTask(a,b),c)).toEqual(mergePracticeTask(a,mergePracticeTask(b,c)));
    }
  });
  it.each([0,null,[],"text"])("renders an object after a stamped scalar/array round trip %j",value=>{
    const old=stampPracticeTask(undefined,{...task(),future:{x:1}} as ReturnType<typeof task>&{future:unknown},10);
    const scalar=stampPracticeTask(old,{...old,future:value},20);
    const restored=stampPracticeTask(scalar,{...scalar,future:{y:2}},30);
    expect(restored).toMatchObject({future:{y:2}});
    expect(restored).not.toMatchObject({future:{x:1}});
    expect(mergePracticeTask(mergePracticeTask(old,scalar),restored)).toEqual(mergePracticeTask(old,mergePracticeTask(scalar,restored)));
    expect(mergePracticeTask(restored,restored)).toEqual(restored);
  });
});

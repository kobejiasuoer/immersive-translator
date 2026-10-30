import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const directory = await mkdtemp(join(tmpdir(), "ita-idb-tests-"));
const output = join(directory, "persistence.mjs");
const repositories = []; let tests = 0;
try {
  await build({ entryPoints: [fileURLToPath(new URL("../src/core/persistence.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", external: ["@tauri-apps/api/core"] });
  const { createPersistence } = await import(pathToFileURL(output).href);
  const open = async identity => { const repo = await createPersistence(identity); repositories.push(repo); return repo; };
  const id = crypto.randomUUID();
  const guest = await open(`guest-${id}`); const user = await open(`user-${id}`);
  assert.deepEqual(await guest.loadSnapshot(), { revision: 0, state: null });
  await guest.saveSnapshot({ learned: true }, 0);
  assert.equal((await user.loadSnapshot()).state, null);
  await assert.rejects(guest.saveSnapshot({ learned: false }, 0), /REVISION_CONFLICT:1/); tests++;

  const event = { eventId: "event-1", payload: { grade: "good", word: "w" } };
  const input = { expectedRevision: 1, state: { learned: true }, events: [event], outbox: [{ id: event.eventId, payload: event.payload, createdAt: 10 }] };
  assert.deepEqual(await guest.commit(input), { revision: 2, alreadyApplied: false });
  assert.deepEqual(await guest.commit({ ...input, state: { learned: false } }), { revision: 2, alreadyApplied: true });
  assert.equal((await guest.loadSnapshot()).state.learned, true);
  assert.equal((await guest.listEvents()).length, 1); assert.equal((await guest.listOutbox()).length, 1);
  await assert.rejects(guest.commit({ expectedRevision: 2, events: [event, { eventId: "new", payload: {} }] }), /MIXED_EVENT_RETRY/); tests++;

  await assert.rejects(guest.commit({ expectedRevision: 2, records: [{ collection: "notes", id: "must-rollback", payload: { body: "n" } }], events: [{ eventId: "also-rollback", payload: {} }], outbox: [{ id: event.eventId, payload: { collision: true } }] }), /OUTBOX_ID_COLLISION/);
  assert.equal(await guest.get("notes", "must-rollback"), null);
  assert.equal((await guest.listEvents()).length, 1); assert.equal((await guest.loadSnapshot()).revision, 2); tests++;

  await guest.set("notes", "n", { body: "first" }, 2, 0);
  await assert.rejects(guest.set("notes", "n", { body: "stale" }, 3, 0), /RECORD_VERSION_CONFLICT:1/);
  await guest.remove("notes", "n", 3, 1);
  assert.equal((await guest.get("notes", "n")).deleted, true);
  assert.equal((await guest.get("notes", "n")).version, 2);
  await guest.ackOutbox([event.eventId]); assert.deepEqual(await guest.listOutbox(), []); tests++;

  const migration = { migrationId: "v3", entries: { legacy: "{\"dueAt\":42}" }, state: { dueAt: 42 } };
  await assert.rejects(user.migrateLegacy({ ...migration, records: [{ collection: "", id: "n", payload: {} }] }), /INVALID_COLLECTION/);
  assert.equal((await user.loadSnapshot()).revision, 0);
  assert.deepEqual(await user.migrateLegacy(migration), { revision: 1, migrated: true });
  assert.deepEqual(await user.migrateLegacy(migration), { revision: 1, migrated: false });
  assert.equal((await user.loadSnapshot()).state.dueAt, 42); tests++;

  const clip = "../clip"; const pcm = btoa(String.fromCharCode(1, 0, 2, 0));
  await guest.audioBegin(clip, { taskId: "task" });
  assert.equal((await guest.audioAppend(clip, 0, pcm)).byteLength, 4);
  assert.equal((await guest.audioAppend(clip, 0, pcm)).byteLength, 4);
  await assert.rejects(guest.audioAppend(clip, 0, btoa(String.fromCharCode(3, 0))), /AUDIO_SEQUENCE_COLLISION/);
  await assert.rejects(guest.audioAppend(clip, 2, pcm), /AUDIO_SEQUENCE_CONFLICT:1/);
  assert.equal(await user.audioManifest(clip), null);
  const sameProfile = await open(`guest-${id}`);
  assert.equal((await sameProfile.audioManifest(clip)).status, "recording", "Opening a second repository must not interrupt a live recorder");
  await guest.audioFinalize(clip);
  const wav = Buffer.from((await guest.audioRead(clip)).wavB64, "base64");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF"); assert.equal(wav.readUInt32LE(40), 4); assert.equal(wav.length, 48); tests++;

  const recoveryId = `recover-${id}`; const source = await open(recoveryId); await source.audioBegin("interrupted", null); await source.audioAppend("interrupted", 0, pcm); source.close();
  // A second isolated module emulates restarting the preview process.
  const restarted = await import(`${pathToFileURL(output).href}?restart=${id}`);
  const recovered = await restarted.createPersistence(recoveryId); repositories.push(recovered);
  assert.equal((await recovered.audioManifest("interrupted")).status, "interrupted");
  await recovered.audioFinalize("interrupted"); assert.equal((await recovered.audioRead("interrupted")).manifest.status, "ready"); tests++;
  await guest.audioDelete(clip); await guest.audioDelete(clip); assert.equal(await guest.audioManifest(clip), null);
  guest.close(); await assert.rejects(guest.loadSnapshot()); tests++;
  console.log(`PASS: ${tests} IndexedDB persistence scenarios (isolation, CAS, idempotency, rollback, migration, audio and recovery)`);
} finally {
  for (const repository of repositories) repository.close();
  await rm(directory, { recursive: true, force: true });
}

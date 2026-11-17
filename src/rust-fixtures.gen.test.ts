/**
 * Generates golden fixtures for the Rust port (prosecraft-rs) from this code base.
 * It does nothing unless PROSECRAFT_FIXTURE_OUT names an output folder:
 *
 *   PROSECRAFT_FIXTURE_OUT=/path/to/fixtures npx vitest run src/rust-fixtures.gen.test.ts
 *
 * Randomness (salts, nonces, vault keys) comes from a fixed byte stream, so the
 * encrypted outputs are reproducible and the Rust side can check them byte for byte.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, it, vi } from "vitest";
import { createVault, deriveKek, encryptEntity, type EntityMetaPlain } from "$lib/storage/crypto";
import { serializeEncryptedBundle } from "$lib/storage/encrypted-bundle";
import { createStoredProject, stableStringify } from "$lib/storage/schema";
import { SCHEMA_VERSION, type ProjectData } from "$lib/storage/types";

const OUT = process.env.PROSECRAFT_FIXTURE_OUT;

/** A deterministic byte stream (xorshift32), replacing crypto.getRandomValues. */
function fixedRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return <T extends ArrayBufferView | null>(array: T): T => {
    if (!array) return array;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i += 1) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      bytes[i] = state & 0xff;
    }
    return array;
  };
}

function write(name: string, value: unknown) {
  writeFileSync(join(OUT!, name), `${JSON.stringify(value, null, 2)}\n`);
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A project that touches every field the app stores, plus the awkward cases. */
function richProject(): ProjectData {
  return {
    id: "project-1",
    name: "The Lighthouse 🌊 Keeper",
    author: "A. Writer",
    kind: "novel",
    activeDocumentId: "doc-1",
    projectGoal: 80_000,
    chapterGoals: { "chapter-1": 2_500, "10": 3, "2": 1.5, "-1": 4, "01": 5 },
    activity: { "2026-11-01": { edits: 12, wordsAdded: 345 }, "2026-11-02": { edits: 0.5, wordsAdded: -3 } },
    chapters: [
      { id: "chapter-1", title: "Chapter One", expanded: true, summary: "It begins.", labelId: "label-1" },
      { id: "chapter-2", title: "Chapitre deux — « voilà »", expanded: false, trashed: true }
    ],
    documents: [
      {
        id: "doc-1",
        title: "Opening Scene",
        chapterId: "chapter-1",
        content: '<p>It was <em>dark</em>.<sup class="footnote-ref" data-footnote-id="fn-1" contenteditable="false"></sup></p><p>Then <span class="cite-ref" data-cites="[{&quot;id&quot;:&quot;smith2020&quot;}]">(Smith 2020)</span>.</p>',
        footnotes: [{ id: "fn-1", html: "A note with <em>emphasis</em>." }]
      },
      {
        id: "doc-2",
        title: "Mara",
        space: "Wiki",
        folderId: "folder-1",
        content: "<p>Notes about Mara. 𝔐𝔞𝔯𝔞</p>",
        character: { role: "Protagonist", age: "32", pronouns: "she/her" } as never
      },
      {
        id: "doc-3",
        title: "INT. LIGHTHOUSE - NIGHT",
        chapterId: "chapter-1",
        format: "screenplay",
        content: '<p data-sp="scene-heading">INT. LIGHTHOUSE - NIGHT</p>',
        markdownSource: "INT. LIGHTHOUSE - NIGHT"
      }
    ],
    storyboardRows: [{ id: "row-1", title: "Act I" }],
    storyboardCards: [{ id: "card-1", sourceId: "doc-1", rowId: "row-1", x: 12.5, y: 0.1 + 0.2, kind: "scene", title: "Opening", note: "" }],
    storyboardDrawings: [{ id: "draw-1", type: "arrow", x1: -0, y1: 1e21, x2: 1e-7, y2: 123456789.125 } as never],
    timelineNodes: [{ id: "t-1", title: "Day One", date: "2026-01-01", time: "", description: "Start" }],
    labels: [{ id: "label-1", name: "Draft", color: "#d69e2e" }],
    comments: [{
      id: "comment-1",
      documentId: "doc-1",
      quote: "dark",
      // A context cut by UTF-16 index can split an emoji and leave a lone surrogate.
      prefix: "It was \ud83c",
      suffix: ".",
      body: "Darker?",
      author: "Editor",
      createdAt: 1_763_370_000_000,
      resolved: false
    }],
    snapshots: [{ id: "snap-1", documentId: "doc-1", createdAt: 1_763_360_000_000, title: "Opening Scene", content: "<p>It was dark.</p>", reason: "manual", note: "first" }],
    citations: [{ id: "smith2020", type: "book", title: "Lighthouses", author: [{ family: "Smith", given: "Jo" }], issued: { "date-parts": [[2020]] } } as never],
    publishOptions: { futureOption: { nested: [1, 2.25, null, true] } } as never,
    // A field from a future release: it must survive a round trip untouched.
    futureField: { kept: "as is", n: 7 }
  } as ProjectData;
}

beforeAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(fixedRandom(0x5eed) as never);
});

afterAll(() => {
  vi.restoreAllMocks();
});

it.skipIf(!OUT)("writes JSON round-trip fixtures", () => {
  const inputs = [
    '{"b":1,"a":2,"10":3,"2":4,"-1":5,"01":6,"4294967295":7,"4294967294":8}',
    '{"s":"lone \\ud83d high","t":"lone \\ude00 low","u":"pair \\ud83d\\ude00","v":"\\u0000\\u001f\\u007f\\u2028\\u2029","w":"\\"\\\\\\/\\b\\f\\n\\r\\t"}',
    '[1,1.0,-0,0.1,1e21,1e-7,1.5e-7,123456789012345680000,5e-324,1.7976931348623157e308,-1e-7,100,1e2,0.000001,1E+300]',
    '{"nested":{"empty_obj":{},"empty_arr":[],"arr":[{},[],[[]]],"null":null,"t":true,"f":false}}',
    '"just a string"',
    '{"dup":1,"dup":2}',
    '{"__proto__":1,"constructor":2}',
    ' \n\t{ "spaced" : [ 1 , 2 ] } \n'
  ];
  write("json-cases.json", inputs.map((input) => {
    const value = JSON.parse(input);
    return {
      input,
      compact: JSON.stringify(value),
      pretty: JSON.stringify(value, null, 2),
      stable: stableStringify(value)
    };
  }));
});

it.skipIf(!OUT)("writes number formatting fixtures", () => {
  const special = [0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 2 / 3, 100, 1e20, 1e21, 1e-6, 1e-7, 1.5e-7,
    123456789.125, 9007199254740991, 9007199254740992, 2 ** 64, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, 1763370000000, 0.5, 4.35, 1e300, -1e-300, 255, 1e15, 1e16, 1e17];
  const view = new DataView(new ArrayBuffer(8));
  const random = fixedRandom(0xbeef);
  const cases: Array<{ bits: string; string: string }> = [];
  const push = (value: number) => {
    view.setFloat64(0, value);
    cases.push({ bits: view.getBigUint64(0).toString(16).padStart(16, "0"), string: String(value) });
  };
  special.forEach(push);
  const bytes = new Uint8Array(8);
  while (cases.length < 3000) {
    random(bytes);
    const value = new DataView(bytes.buffer).getFloat64(0);
    if (Number.isFinite(value)) push(value);
  }
  for (let i = 0; i < 500; i += 1) {
    random(bytes);
    push(new DataView(bytes.buffer).getUint32(0) / 1000);
  }
  write("numbers.json", cases);
});

it.skipIf(!OUT)("writes crypto fixtures", async () => {
  const passphrases = ["correct horse battery", "ﬁnal Ｐａｓｓ ⅷ é", "pass\ud800word"];
  const vaults = [];
  for (const [index, passphrase] of passphrases.entries()) {
    const fast = index > 0;
    const { header, vaultKey } = await createVault(passphrase, fast ? { memoryKiB: 64, iterations: 1, parallelism: 1, hint: "a hint" } : {});
    const kek = await deriveKek(passphrase, header.kdf);
    const meta: EntityMetaPlain = { kind: "document", id: "doc-\ud83d", projectId: "project-1", deviceId: "device-a", updatedAt: 1763370000000.5, revision: 3 };
    const payload = { title: "T", n: [1, 0.1, -0, 1e21], lone: "x\udfffy" };
    const envelope = encryptEntity(vaultKey, meta, payload);
    vaults.push({ passphrase, header, kek: hex(kek), vaultKey: hex(vaultKey), meta, payload, envelope });
  }
  write("crypto.json", vaults);
});

it.skipIf(!OUT)("writes bundle fixtures", async () => {
  const project = createStoredProject(richProject(), "device-a", 1_763_000_000_000);
  const second = createStoredProject({ ...richProject(), id: "project-2", name: "Second", futureField: undefined } as ProjectData, "device-b", 1_763_000_000_001);
  const plain = {
    format: "prosecraft.bundle",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: 1_763_370_000_000,
    deviceId: "device-a",
    projects: [project, second]
  };
  writeFileSync(join(OUT!, "bundle-plain.prosecraft"), JSON.stringify(plain, null, 2));

  const passphrase = "correct horse battery";
  const { header, vaultKey } = await createVault(passphrase, { memoryKiB: 64, iterations: 1, parallelism: 1, hint: "the usual" });
  const encrypted = serializeEncryptedBundle([project, second], header, vaultKey, "device-a", 1_763_370_000_000, "the usual");
  writeFileSync(join(OUT!, "bundle-encrypted.prosecraft"), encrypted);
  write("bundle-encrypted.key.json", { passphrase, vaultKey: hex(vaultKey) });
});

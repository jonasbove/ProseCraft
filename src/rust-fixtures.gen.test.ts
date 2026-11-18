/**
 * Generates golden fixtures for the Rust port (prosecraft-rs) from this code base.
 * It does nothing unless PROSECRAFT_FIXTURE_OUT names an output folder:
 *
 *   PROSECRAFT_FIXTURE_OUT=/path/to/fixtures npx vitest run src/rust-fixtures.gen.test.ts
 *
 * Randomness (salts, nonces, vault keys) comes from a fixed byte stream, so the
 * encrypted outputs are reproducible and the Rust side can check them byte for byte.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, it, vi } from "vitest";
import { createVault, deriveKek, encryptEntity, type EntityMetaPlain } from "$lib/storage/crypto";
import { serializeEncryptedBundle } from "$lib/storage/encrypted-bundle";
import { countWords, htmlToPlainText } from "$lib/publish/content";
import { markdownToDocument } from "$lib/publish/markdown";
import { compileBook } from "$lib/publish/compile";
import { exportText } from "$lib/publish/text";
import { exportHtml } from "$lib/publish/html";
import { exportEpub } from "$lib/publish/epub";
import { MemoryFileSystem } from "$lib/storage/sync/memory-fs";
import { FolderSyncProvider } from "$lib/storage/sync/folder-provider";
import { EncryptedFileSyncProvider } from "$lib/storage/sync/bundle-provider";
import { mergeProjects } from "$lib/storage/sync/merge";
import { safeName } from "$lib/storage/sync/layout";
import { commentText } from "$lib/comment-dom";
import { buildAnchor, locateAnchor } from "$lib/comments";
import { STARTERS, STARTER_MODULES, starterBlueprint, buildFromBlueprint, addModule, allBlueprintKeys, type StarterBlueprint } from "$lib/starters";
import { defaultPublishOptions } from "$lib/publish/types";
import { searchDocuments, findFirstMatch } from "$lib/search";
import { replaceInDocuments } from "$lib/replace";
import { unzipSync, strFromU8 } from "fflate";
import { exportMarkdown, htmlToInlineMarkdown, htmlToMarkdown } from "$lib/publish/markdown";
import { sanitizeInlineHtml } from "$lib/sanitize";
import { normalizePublishOptions } from "$lib/publish/types";
import { sanitizeHtml } from "$lib/sanitize";
import { createStoredProject, projectContentKey, stableStringify, stampProject } from "$lib/storage/schema";
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

it.skipIf(!OUT)("writes plain-text and word-count fixtures", () => {
  const html = [
    ...richProject().documents.map((document) => document.content),
    "<p>One  two\tthree</p><p>  </p><p>four<br>five</p>",
    "<h1>Title</h1><blockquote><p>Quoted <em>words</em> here</p></blockquote><hr><p>after</p>",
    "<ul><li>first item</li><li>second <strong>bold</strong></li></ul><ol><li>one</li><li><p>two</p></li></ol>",
    "<p>a&nbsp;b &amp; c&lt;d&gt; &#x1F600; &mdash;</p><p>\u00a0\u2003\ufeff\u0085x</p>",
    '<p>Math <span class="math-inline" data-tex="x^2"></span> inline.</p><div class="math-block" data-tex="E=mc^2"></div><div class="mermaid-diagram" data-source="graph TD; A--&gt;B"></div><p>end</p>',
    '<p>Note<sup class="footnote-ref" data-footnote-id="fn-1" contenteditable="false"></sup> here.</p>',
    "<div><div>nested <div>blocks</div> text</div></div><pre>code\n  kept</pre>",
    "<p>unclosed paragraph<p>second",
    "<table><tr><td>cell one</td><td>cell two</td></tr></table>",
    '<p><img src="data:image/png;base64,AA==" alt="pic"> caption</p>',
    "",
    "plain text without tags"
  ];
  write("plain-text.json", html.map((input) => {
    const clean = sanitizeHtml(input);
    const omit = htmlToPlainText(clean, { rich: "omit" });
    return { input, clean, omit, source: htmlToPlainText(clean, { rich: "source" }), words: countWords(omit) };
  }));
});

it.skipIf(!OUT)("writes stamping fixtures", () => {
  const base = richProject();
  const created = createStoredProject(base, "device-a", 1_000);
  const steps: Array<{ name: string; previous: unknown; project: unknown; device: string; now: number; result: unknown }> = [];
  const step = (name: string, previous: ReturnType<typeof createStoredProject> | undefined, project: ProjectData, device: string, now: number) => {
    const result = stampProject(previous, project, device, now);
    steps.push({ name, previous: previous ?? null, project, device, now, result });
    return result;
  };
  const same = step("unchanged", created, structuredClone(created.project), "device-b", 2_000);
  const edited = step("edit one scene", same, { ...same.project, documents: same.project.documents.map((d) => d.id === "doc-1" ? { ...d, content: "<p>It was very dark.</p>" } : d) }, "device-b", 3_000);
  const removed = step("remove a scene", edited, { ...edited.project, documents: edited.project.documents.filter((d) => d.id !== "doc-3") }, "device-a", 4_000);
  const again = step("tombstone kept", removed, structuredClone(removed.project), "device-a", 5_000);
  const readded = step("re-add the scene", again, { ...again.project, documents: [...again.project.documents, base.documents[2]] }, "device-c", 6_000);
  step("rename project", readded, { ...readded.project, name: "Renamed" }, "device-c", 7_000);
  step("active document only", readded, { ...readded.project, activeDocumentId: "doc-2" }, "device-c", 8_000);
  step("new project", undefined, base, "device-z", 9_000);
  write("stamping.json", { created, steps, contentKey: projectContentKey(base) });
});

it.skipIf(!OUT)("writes a corpus of ProseCraft's rich HTML", () => {
  const markdown = [
    "It was *dark*. Then it was **not**.",
    "A _quiet_ ~~loud~~ word and `code`.",
    "# Title\n\n## Heading\n\n### Subheading\n\nBody text.",
    "> A quoted line.\n\nAfter the quote.",
    "> First quoted paragraph.\n>\n> Second quoted paragraph.",
    "- one\n- two\n- three",
    "1. first\n2. second",
    "- *styled* item\n- plain item",
    "A note.[^n1]\n\n[^n1]: The note text.",
    "See [the site](https://example.com) now.",
    "***bold italic*** and **bold with *italic* inside**",
    "Line one\nline two in the same paragraph.",
    "---\n\nAfter a rule.",
    "Inline math $x^2$ here.",
    "<u>underlined</u> text",
    "Smart quotes “like these” and an em dash — here.",
    "",
  ];
  write("rich-corpus.json", markdown.map((md) => {
    const html = sanitizeHtml(markdownToDocument(md).html);
    return { markdown: md, html };
  }));
});

/** A project with two live chapters and footnotes in several scenes, for the exporters. */
function bookProject(): ProjectData {
  const base = richProject();
  return {
    ...base,
    chapters: [
      ...base.chapters,
      { id: "chapter-3", title: "Chapter 7", expanded: true, summary: "" },
      { id: "chapter-4", title: "Epilogue", expanded: true }
    ],
    documents: [
      ...base.documents,
      { id: "doc-4", title: "Morning", chapterId: "chapter-3", content: '<p>The sea was calm.<sup class="footnote-ref" data-footnote-id="a" contenteditable="false"></sup></p><ul><li>bread</li><li>salt</li></ul><p>Then <strong>nothing</strong>.<sup class="footnote-ref" data-footnote-id="b" contenteditable="false"></sup></p>', footnotes: [{ id: "a", html: "Calm, mostly." }, { id: "b", html: "Truly <em>nothing</em>." }] },
      { id: "doc-5", title: "Noon", chapterId: "chapter-3", content: "<p>Light.</p><p>More light.</p>" },
      { id: "doc-6", title: "Empty", chapterId: "chapter-3", content: "<p><br></p>" },
      { id: "doc-7", title: "Gone", chapterId: "chapter-3", content: "<p>Trashed text.</p>", trashed: true },
      { id: "doc-8", title: "", chapterId: "chapter-4", content: '<h2>After</h2><blockquote><p>A quote.</p></blockquote><p>Last line.<sup class="footnote-ref" data-footnote-id="z" contenteditable="false"></sup></p>', footnotes: [{ id: "z", html: "The end." }] }
    ]
  } as ProjectData;
}

it.skipIf(!OUT)("writes plain-text export fixtures", async () => {
  const project = bookProject();
  const variants: Record<string, Record<string, unknown>> = {
    defaults: {},
    everything: {
      style: "modern", includeTableOfContents: true, includeSceneTitles: true, includeCopyrightPage: true,
      sceneSeparator: "asterisks", subtitle: "A Novel", copyright: "© 2026 A. Writer", dedication: "For the keepers.",
      frontMatter: [{ id: "f1", title: "Epigraph", body: "Some words." }, { id: "f2", title: "", body: "", blank: true }],
      backMatter: [{ id: "b1", title: "Acknowledgments", body: "Thank you." }]
    },
    perChapter: { footnotesRestartPerChapter: true, sceneSeparator: "none", includeTitlePage: false, includeChapterTitles: false }
  };
  const out: Record<string, { options: unknown; text: string }> = {};
  for (const [name, raw] of Object.entries(variants)) {
    const options = normalizePublishOptions(raw);
    const live = project.chapters.filter((c) => !c.trashed);
    const book = compileBook({
      title: project.name, author: project.author, subtitle: options.subtitle, copyright: options.copyright,
      dedication: options.dedication, frontMatter: options.frontMatter, backMatter: options.backMatter,
      chapters: live, documents: project.documents, footnotesRestartPerChapter: options.footnotesRestartPerChapter
    });
    const payload = exportText(book, options);
    out[name] = { options: raw, text: await payload.blob.text() };
  }
  write("export-text.json", { project, exports: out, filename: exportText(compileBook({ title: project.name, author: "", subtitle: "", copyright: "", dedication: "", frontMatter: [], backMatter: [], chapters: [], documents: [] }), normalizePublishOptions({})).filename });
});

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** HTML a sanitizer meets: ProseCraft's own output, pasted markup, and hostile input. */
const SANITIZE_CASES: string[] = [
  "<p>Plain <em>emphasis</em> and <strong>strong</strong>.</p>",
  "<p class=\"eyebrow\" style=\"color:red\" onclick=\"x()\">Eyebrow</p>",
  "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5>",
  "<p>a<span style=\"x\">b<font>c</font></span>d</p>",
  "<script>alert(1)</script><p>after</p><style>p{}</style>",
  "<iframe src=\"x\"></iframe><p>x<object>y</object></p>",
  "<p><a href=\"https://example.com/a?b=1&amp;c=2\" target=\"_blank\">web</a> <a href=\"javascript:alert(1)\">js</a> <a href=\" JavaScript:alert(1)\">js2</a> <a href=\"java\nscript:x\">js3</a> <a href=\"mailto:a@b.c\">mail</a> <a href=\"/relative\">rel</a> <a href=\"#frag\">frag</a> <a href=\"ftp://x\">ftp</a> <a>none</a> <a href=\"\">empty</a></p>",
  `<p><img src="${IMG}" alt="dot" width="20" height="0" title="t"></p>`,
  `<p><img src="${IMG}" alt="a&quot;b" width="2401" height="12.5" data-size="small" data-align="left" data-wrap="wrap-right"></p>`,
  `<p><img src="${IMG}" data-size="custom" data-width="33.33"><img src="${IMG}" data-size="custom" data-width="5"><img src="${IMG}" data-size="custom"><img src="${IMG}" data-size="huge" data-align="middle"></p>`,
  "<p><img src=\"https://example.com/x.png\"><img src=\"data:image/gif;base64,R0lGOD==\"></p>",
  "<p>Note<sup class=\"footnote-ref\" data-footnote-id=\"fn-1\" style=\"x\">1</sup> bad<sup class=\"footnote-ref\" data-footnote-id=\"bad id\">2</sup> plain<sup>3</sup></p>",
  "<p>See <span class=\"cite-ref\" data-cites=\"[{&quot;id&quot;:&quot;smith2020&quot;,&quot;locator&quot;:&quot; 42 &quot;,&quot;label&quot;:&quot;page&quot;,&quot;prefix&quot;:&quot;  see &quot;,&quot;suffix&quot;:&quot; ff. &quot;}]\">x</span>.</p>",
  "<p><span class=\"cite-ref\" data-cites=\"[{&quot;id&quot;:&quot;a&quot;,&quot;extra&quot;:1}]\"></span><span class=\"cite-ref\" data-cites=\"not json\"></span><span class=\"cite-ref\" data-cites=\"[]\"></span><span class=\"cite-ref\" data-cites=\"[{&quot;id&quot;:&quot;b&quot;,&quot;label&quot;:&quot;chapter&quot;,&quot;suppressAuthor&quot;:true}]\"></span></p>",
  "<p>Inline <span class=\"math-inline\" data-tex=\" x^2 \" style=\"x\"><svg><g></g></svg></span> and <span class=\"math-inline\" data-tex=\"  \">gone</span>.</p><div class=\"math-block\" data-tex=\"\\int_0^1 x\\,dx\"><span>rendered</span></div><div class=\"mermaid-diagram\" data-source=\"graph TD; A--&gt;B\"></div><div class=\"calc-worksheet\" data-source=\"x = 2\"></div>",
  "<p data-sp=\"scene-heading\">INT. ROOM</p><p data-sp=\"bogus\">x</p><p data-sp=\"dialogue\" class=\"eyebrow\">y</p>",
  "<div class=\"scene-break scene-break-line extra\" style=\"x\">* * *</div><div class=\"scene-break\"><b>#</b></div>",
  "<p><strike>old</strike> <del>gone</del> <s>s</s> <u>u</u> <i>i</i> <b>b</b> <code>c &lt;x&gt;</code></p>",
  "<blockquote><p>Quote</p><p>Two</p></blockquote><ul><li>a</li><li>b<ol><li>c</li></ol></li></ul><hr><pre><code>let x = 1;\n  y</code></pre>",
  "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>",
  "<p>a &amp; b &lt; c &gt; d&nbsp;e \"q\" 'a'</p>",
  "<div><p>in div</p></div><section><p>in section</p></section>",
  "text at top <em>level</em><br>after break",
  "<!-- comment --><p>x<!-- inner --></p>",
  "<p>a<br/>b</p><p></p><p><br></p>",
  "<P CLASS=\"EYEBROW\">Upper</P><EM>loud</EM>",
  "<p>Unicode: café 🌊   tab\tend</p>",
  // Whitespace before the body, which a document drops.
  " \n\t<p>x</p>",
  "</b> 日本",
  "<!-- c -->  x",
  "\u00a0lead nbsp",
  "  <em>a</em> b",
  "\n\n",
  "</p>\n<p>x</p>",
  // Links new URL() accepts or rejects.
  "<p><a href=\"http://x.y&]\"\">u</a></p>",
  "<p><a href=\"http://x.y%5Br%5D\">u</a></p>",
  "<p><a href=\"http://a b/\">u</a></p>",
  "<p><a href=\"http://[::1]/\">u</a></p>",
  "<p><a href=\"http://[bad/\">u</a></p>",
  "<p><a href=\"http://x:99999/\">u</a></p>",
  "<p><a href=\"http://x:80/\">u</a></p>",
  "<p><a href=\"http:///x\">u</a></p>",
  "<p><a href=\"http://\">u</a></p>",
  "<p><a href=\"https://exa mple.com\">u</a></p>",
  "<p><a href=\"http://ex%41mple.com\">u</a></p>",
  "<p><a href=\"http://ex%00ample.com\">u</a></p>",
  "<p><a href=\"http://xn--nxasmq6b.com\">u</a></p>",
  "<p><a href=\"http://ünïcode.com\">u</a></p>",
  "<p><a href=\"http://a@b@c/\">u</a></p>",
  "<p><a href=\"http://user:pass@host/\">u</a></p>",
  "<p><a href=\"mailto:\">u</a></p>",
  "<p><a href=\"mailto:a b\">u</a></p>",
  "<p><a href=\"http:x\">u</a></p>",
  "<p><a href=\"https:/x\">u</a></p>",
  "<p><a href=\"http:\\\\x\\y\">u</a></p>",
  "<p><a href=\"http://1.2.3.4.5/\">u</a></p>",
  "<p><a href=\"http://0x7f.1/\">u</a></p>",
  "<p><a href=\"http://256.0.0.1/\">u</a></p>",
  "<p><a href=\"http://%zz/\">u</a></p>",
  "<p><a href=\"//proto-relative/x\">u</a></p>",
  "<p><a href=\"?q\">u</a></p>",
  "<p><a href=\"/rel\">u</a></p>",
  "<p><a href=\"http://x.y/%zz\">u</a></p>",
  "<p><a href=\"http://x.y#frag]\">u</a></p>",
  "<p><a href=\"http://x.y?<>\">u</a></p>",
  "<p><a href=\"http://-x.y/\">u</a></p>",
  "<p><a href=\"http://x_y.z/\">u</a></p>",
  "<p><a href=\"http://x..y/\">u</a></p>",
  "<p><a href=\"HTTP://X.Y\">u</a></p>",
  "<p><a href=\"http://x.y:/\">u</a></p>",
  "<p><a href=\"http://x.y:0x50/\">u</a></p>",
  "<p><a href=\"http://[1:2::3]:8080/\">u</a></p>",
  "<p><a href=\"http://x.y|z/\">u</a></p>",
  "<p><a href=\"http://x^y/\">u</a></p>",
  "<p><a href=\"http://x.y\u00a0z/\">u</a></p>",
  "<p><a href=\"http://xn--a.com/\">u</a></p>",
  "<p><a href=\"https://例え.jp/\">u</a></p>",
  "<p><a href=\"http://x.y%2Fz/\">u</a></p>",
  "<p><a href=\"http://x.y%3Az/\">u</a></p>"
];

/** HTML for turndown: ProseCraft's rules, escaping, whitespace and nesting. */
const MARKDOWN_CASES: string[] = [
  "<p>Plain text.</p><p>Second paragraph.</p>",
  "<h1>One</h1><h2>Two</h2><h3>Three</h3>",
  "<p>A <em>b</em> c <strong>d</strong> <em>e <strong>f</strong></em>.</p>",
  "<p>Space<em> inside </em>em and<strong> strong</strong>x and <em> </em>empty</p>",
  "<p>a<em>b</em>c and a <em> b </em> c</p>",
  "<p>* star _ under # hash ` tick [b] \\ slash</p><p>- dash</p><p>+ plus</p><p>1. one</p><p>> gt</p><p>## hd</p><p>=== eq</p><p>~~~ tilde</p><p>12. twelve</p>",
  "<p>   leading and trailing   </p><p>multi    space\n\nnewlines\ttab</p>",
  "<ul><li>one</li><li>two<ul><li>nested</li><li>more</li></ul></li><li>three</li></ul>",
  "<ol><li>first</li><li>second</li></ol><ol start=\"5\"><li>five</li><li>six</li></ol>",
  "<ul><li><p>para item</p></li><li><p>another</p><p>with two</p></li></ul>",
  "<blockquote><p>Quote one</p><p>Quote two</p></blockquote>",
  "<blockquote><p>Outer</p><blockquote><p>Inner</p></blockquote></blockquote>",
  "<p>Code <code>a`b</code> and <code>`x`</code> and <code>plain</code> and <code></code></p>",
  "<pre><code>line 1\n  line 2\n</code></pre><pre>no code child</pre>",
  "<hr><p>after rule</p><p>a<br>b<br>c</p>",
  "<p><a href=\"https://e.com\">link</a> <a href=\"https://e.com/a b\" title=\"T &quot;q&quot;\">spaced</a> <a href=\"https://e.com/(x)\">paren</a> <a>no href</a> <a href=\"https://e.com\"></a></p>",
  `<p><img src="${IMG}" alt="a*b"> <img src="${IMG}" alt="dot" title="T"> <img src="${IMG}" data-size="small" data-align="left"></p>`,
  "<p>Inline <span class=\"math-inline\" data-tex=\"x^2\"></span> math.</p><div class=\"math-block\" data-tex=\"\\int x\"></div>",
  "<div class=\"mermaid-diagram\" data-source=\"graph TD; A--&gt;B\"></div><div class=\"mermaid-diagram\" data-source=\"a ``` b\"></div><div class=\"calc-worksheet\" data-source=\"x = 2\"></div>",
  "<p>Note<sup class=\"footnote-ref\" data-footnote-id=\"n1\" contenteditable=\"false\"></sup> and bad<sup class=\"footnote-ref\" data-footnote-id=\"bad id\"></sup>.</p>",
  "<p>See <span class=\"cite-ref\" data-cites=\"[{&quot;id&quot;:&quot;smith2020&quot;,&quot;locator&quot;:&quot;42&quot;,&quot;label&quot;:&quot;page&quot;,&quot;prefix&quot;:&quot;see&quot;,&quot;suffix&quot;:&quot;ff.&quot;},{&quot;id&quot;:&quot;doe&quot;,&quot;suppressAuthor&quot;:true,&quot;suffix&quot;:&quot;; more [x]&quot;}]\" contenteditable=\"false\"></span> and <span class=\"cite-ref\" data-cites=\"broken\"></span>.</p>",
  "<p><u>under</u> <s>strike</s> <del>del</del> <u> sp </u></p><p class=\"eyebrow\">Kicker</p>",
  "<table><tr><th>H</th><td>c</td></tr></table><div>div text</div>",
  "<p>a&nbsp;b &amp; c &lt;d&gt;</p><p> lead nbsp</p><p><br></p><p></p>",
  "<p>one<span> two </span>three</p><p><em>x</em> <strong>y</strong></p>",
  "<p>Unicode 🌊 café soft</p>"
];

it.skipIf(!OUT)("writes sanitizer and Markdown fixtures", async () => {
  const sanitize = SANITIZE_CASES.map((html) => ({ html, full: sanitizeHtml(html), inline: sanitizeInlineHtml(html) }));
  const corpus = JSON.parse(readFileSync(join(OUT!, "rich-corpus.json"), "utf8")) as Array<{ html: string }>;
  const markdownInputs = [...MARKDOWN_CASES, ...corpus.map((c) => c.html), ...richProject().documents.map((d) => d.content ?? "")];
  const markdown = markdownInputs.map((html) => ({
    html,
    markdown: htmlToMarkdown(html),
    inline: htmlToInlineMarkdown(html),
    withNotes: htmlToMarkdown(html, [{ id: "n1", html: "A <em>note</em>\nover lines." }, { id: "bad id", html: "x" }, { id: "n2", html: "" }])
  }));
  write("sanitize.json", { cases: sanitize });
  write("markdown.json", { cases: markdown });

  const project = bookProject();
  const variants: Record<string, Record<string, unknown>> = {
    defaults: {},
    everything: {
      style: "modern", includeTableOfContents: true, includeSceneTitles: true, includeCopyrightPage: true,
      sceneSeparator: "asterisks", subtitle: "A Novel", copyright: "© 2026 A. Writer", dedication: "For the keepers.\nAll of them.",
      frontMatter: [{ id: "f1", title: "Epigraph", body: "Some words." }, { id: "f2", title: "", body: "", blank: true }],
      backMatter: [{ id: "b1", title: "Acknowledgments", body: "Thank you." }]
    },
    perChapter: { footnotesRestartPerChapter: true, sceneSeparator: "blank", includeTitlePage: false, includeChapterTitles: false }
  };
  const out: Record<string, { options: unknown; markdown: string }> = {};
  for (const [name, raw] of Object.entries(variants)) {
    const options = normalizePublishOptions(raw);
    const live = project.chapters.filter((c) => !c.trashed);
    const book = compileBook({
      title: project.name, author: project.author, subtitle: options.subtitle, copyright: options.copyright,
      dedication: options.dedication, frontMatter: options.frontMatter, backMatter: options.backMatter,
      chapters: live, documents: project.documents, footnotesRestartPerChapter: options.footnotesRestartPerChapter
    });
    out[name] = { options: raw, markdown: await exportMarkdown(book, options).blob.text() };
  }
  write("export-markdown.json", { project, exports: out });
});

it.skipIf(!OUT)("writes HTML export fixtures", async () => {
  const project = bookProject();
  const variants: Record<string, Record<string, unknown>> = {
    defaults: {},
    everything: {
      style: "modern", includeTableOfContents: true, includeSceneTitles: true, includeCopyrightPage: true,
      sceneSeparator: "asterisks", subtitle: "A Novel <&>", copyright: "© 2026 A. Writer\nAll rights reserved.", dedication: "For the keepers.\nAll of them.",
      frontMatter: [{ id: "f1", title: "Epigraph", body: "Some words.\n\nMore & more.\r\nSame paragraph." }, { id: "f2", title: "", body: "", blank: true }],
      backMatter: [{ id: "b1", title: "Acknowledgments", body: "Thank you." }]
    },
    classicPerChapter: { style: "classic", footnotesRestartPerChapter: true, sceneSeparator: "line", includeChapterTitles: false, pageBreakBeforeChapters: false },
    classicNoDropCaps: { style: "classic", dropCaps: false, sceneSeparator: "blank", includeTitlePage: false },
    ebook: { style: "ebook", sceneSeparator: "none", includeCopyrightPage: true, copyright: "© Someone" }
  };
  const out: Record<string, { options: unknown; html: string }> = {};
  for (const [name, raw] of Object.entries(variants)) {
    const options = normalizePublishOptions(raw);
    const live = project.chapters.filter((c) => !c.trashed);
    const book = compileBook({
      title: project.name, author: project.author, subtitle: options.subtitle, copyright: options.copyright,
      dedication: options.dedication, frontMatter: options.frontMatter, backMatter: options.backMatter,
      chapters: live, documents: project.documents, footnotesRestartPerChapter: options.footnotesRestartPerChapter
    });
    out[name] = { options: raw, html: await exportHtml(book, options).blob.text() };
  }
  write("export-html.json", { project, exports: out });
});

it.skipIf(!OUT)("writes EPUB export fixtures", async () => {
  const project = bookProject();
  const variants: Record<string, Record<string, unknown>> = {
    defaults: {},
    everything: {
      style: "modern", includeTableOfContents: true, includeSceneTitles: true, includeCopyrightPage: true,
      sceneSeparator: "asterisks", subtitle: "A Novel <&>", copyright: "© 2026 A. Writer\nAll rights reserved.", dedication: "For the keepers.",
      frontMatter: [{ id: "f1", title: "Epigraph", body: "Some words.\n\nMore & more." }, { id: "f2", title: "", body: "", blank: true }],
      backMatter: [{ id: "b1", title: "Acknowledgments", body: "Thank you." }]
    },
    classicPerChapter: { style: "classic", footnotesRestartPerChapter: true, sceneSeparator: "line", includeChapterTitles: false },
    ebook: { style: "ebook", sceneSeparator: "none", includeTitlePage: false }
  };
  const out: Record<string, { options: unknown; entries: Array<{ name: string; text: string }> }> = {};
  for (const [name, raw] of Object.entries(variants)) {
    const options = normalizePublishOptions(raw);
    const live = project.chapters.filter((c) => !c.trashed);
    const book = compileBook({
      title: project.name, author: project.author, subtitle: options.subtitle, copyright: options.copyright,
      dedication: options.dedication, frontMatter: options.frontMatter, backMatter: options.backMatter,
      chapters: live, documents: project.documents, footnotesRestartPerChapter: options.footnotesRestartPerChapter
    });
    const payload = await exportEpub(book, options);
    const files = unzipSync(new Uint8Array(await payload.blob.arrayBuffer()));
    const entries = Object.entries(files).map(([entry, bytes]) => ({
      name: entry,
      text: strFromU8(bytes)
        .replace(/urn:uuid:[0-9a-f-]{36}/g, "urn:uuid:ID")
        .replace(/<meta property="dcterms:modified">[^<]*<\/meta>/, '<meta property="dcterms:modified">MODIFIED</meta>')
    }));
    out[name] = { options: raw, entries };
  }
  write("export-epub.json", { project, exports: out });
});

/** A second project: storyboard rows and cards, a deleted scene, and an id that needs encoding. */
function storyProject(): ProjectData {
  return {
    id: "proj/../x é",
    name: "Second",
    author: "",
    activeDocumentId: "d1",
    projectGoal: 0,
    chapterGoals: {},
    activity: {},
    chapters: [{ id: "c1", title: "Part", expanded: true }],
    documents: [
      { id: "d1", title: "Keep", chapterId: "c1", content: "<p>kept</p>" },
      { id: "d2", title: "Gone", chapterId: "c1", content: "<p>deleted later</p>" }
    ],
    storyboardRows: [{ id: "r1", title: "Row" }],
    storyboardCards: [{ id: "k1", rowId: "r1", title: "Card", text: "beat" }]
  } as unknown as ProjectData;
}

async function dump(fs: MemoryFileSystem): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of fs.paths()) out[path] = await fs.readText(path);
  return out;
}

it.skipIf(!OUT)("writes sync folder, single-file and merge fixtures", async () => {
  const passphrase = "sync passphrase ✓";
  const first = createStoredProject(richProject(), "device-a", 1_763_000_000_000);
  const draft = createStoredProject(storyProject(), "device-a", 1_763_000_000_000);
  // Delete scene d2: a tombstone in the header, no content file.
  const edited = { ...draft.project, documents: draft.project.documents.filter((d) => d.id !== "d2") };
  const second = stampProject(draft, edited, "device-b", 1_763_000_100_000);
  const projects = [first, second];

  const folderFs = new MemoryFileSystem();
  const folder = new FolderSyncProvider(folderFs, { memoryKiB: 64, iterations: 1, parallelism: 1 });
  const folderConnection = await folder.connect(passphrase);
  await folder.push(projects, folderConnection.vaultKey);

  const fileFs = new MemoryFileSystem();
  const file = new EncryptedFileSyncProvider(fileFs);
  const fileConnection = await file.connect(passphrase);
  await file.push(projects, fileConnection.vaultKey);

  const safeNames = ["project-1", "a.b_c-d", ".hidden", "proj/../x é", "..", "", "日本"].map((id) => ({ id, name: safeName(id) }));

  // Merge cases. Math.random is pinned so conflict-copy ids are predictable.
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const base = createStoredProject({ ...richProject(), id: "m" }, "device-a", 1000);
  const edit = (from: typeof base, name: string, device: string, now: number) =>
    stampProject(from, { ...from.project, name }, device, now);
  const stamp = (p: typeof base) => ({ updatedAt: p.updatedAt, revision: p.revision });
  const localEdit = edit(base, "Local", "device-a", 2000);
  const remoteEdit = edit(base, "Remote", "device-b", 3000);
  const sameTime = edit(base, "Same time", "device-c", 3000);
  const cases: Record<string, { local: unknown[]; remote: unknown[]; lastSynced: Record<string, unknown> }> = {
    newOnBothSides: { local: [base], remote: [{ ...createStoredProject({ ...richProject(), id: "n" }, "device-b", 1500) }], lastSynced: {} },
    onlyLocalChanged: { local: [localEdit], remote: [base], lastSynced: { m: stamp(base) } },
    onlyRemoteChanged: { local: [base], remote: [remoteEdit], lastSynced: { m: stamp(base) } },
    bothChanged: { local: [localEdit], remote: [remoteEdit], lastSynced: { m: stamp(base) } },
    bothChangedSameTime: { local: [sameTime], remote: [remoteEdit], lastSynced: { m: stamp(base) } },
    sameContent: { local: [base], remote: [{ ...base, revision: base.revision + 1 }], lastSynced: {} },
    deletedRemotely: { local: [base], remote: [], lastSynced: { m: stamp(base) } },
    deletedRemotelyAfterLocalEdit: { local: [localEdit], remote: [], lastSynced: { m: stamp(base) } },
    deletedLocally: { local: [], remote: [base], lastSynced: { m: stamp(base) } },
    deletedLocallyAfterRemoteEdit: { local: [], remote: [remoteEdit], lastSynced: { m: stamp(base) } },
    forgotten: { local: [], remote: [], lastSynced: { gone: { updatedAt: 1, revision: 1 } } }
  };
  const merges: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cases)) {
    merges[name] = { ...c, outcome: mergeProjects(c.local as never, c.remote as never, c.lastSynced as never, 5_000_000, "device-z") };
  }
  random.mockRestore();

  write("sync.json", {
    passphrase,
    projects,
    folder: await dump(folderFs),
    singleFile: await dump(fileFs),
    safeNames,
    merges
  });
});

const INTEROP = process.env.PROSECRAFT_INTEROP_DIR;

/** Reads the sync layouts prosecraft-rs wrote with ProseCraft's own providers. */
it.skipIf(!INTEROP)("reads the sync layouts prosecraft-rs writes", async () => {
  const fixture = JSON.parse(readFileSync(join(OUT ?? INTEROP!, "sync.json"), "utf8"));
  for (const [name, Provider] of [["folder", FolderSyncProvider], ["single-file", EncryptedFileSyncProvider]] as const) {
    const files = JSON.parse(readFileSync(join(INTEROP!, `${name}.json`), "utf8")) as Record<string, string>;
    const fs = new MemoryFileSystem();
    for (const [path, content] of Object.entries(files)) await fs.writeText(path, content);
    const connection = await new Provider(fs).connect(fixture.passphrase);
    if (connection.created) throw new Error(`${name}: ProseCraft didn't recognise the layout`);
    const byId = (list: typeof fixture.projects) => [...list].sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1)).map((p: unknown) => stableStringify(p));
    const got = byId(connection.projects);
    const want = byId(fixture.projects);
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name}: projects differ`);
    console.log(`interop ${name}: ProseCraft read ${connection.projects.length} projects, identical`);
  }
});

it.skipIf(!OUT)("writes comment anchor fixtures", async () => {
  const corpus = JSON.parse(readFileSync(join(OUT!, "rich-corpus.json"), "utf8")) as Array<{ html: string }>;
  const htmls = [
    ...corpus.map((c) => c.html),
    ...richProject().documents.map((d) => d.content ?? ""),
    "<p>The cat sat. The cat ran. The cat sat again.</p>",
    "<p>a&nbsp;b &amp; c</p><p>  spaced  </p><ul><li>one</li><li>two</li></ul>",
    "<p>Emoji 🌊 and 𝔐 here.</p><p>x<br>y</p>"
  ];
  const texts = htmls.map((html) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    // The editor shows equations and diagrams as non-editable widgets.
    for (const el of div.querySelectorAll(".math-inline, .math-block, .mermaid-diagram, .calc-worksheet")) el.setAttribute("contenteditable", "false");
    return { html, text: commentText(div) };
  });
  const sample = "The cat sat. The cat ran. The cat sat again. 🌊 end";
  const anchors = [[4, 7], [17, 20], [30, 33], [0, 0], [12, 13], [45, 47], [40, 100], [7, 4]].map(([s, e]) => ({ start: s, end: e, anchor: buildAnchor(sample, s, e) }));
  const edited = "Intro. The cat sat. The cat ran! The dog sat again. 🌊 end";
  const located = anchors.filter((a) => a.anchor).map((a) => ({ anchor: a.anchor, found: locateAnchor(edited, a.anchor!) }));
  write("comments.json", { texts, sample, anchors, edited, located });
});

/** Starter data for prosecraft-rs to embed (ProseCraft's own templates), and build checks. */
it.skipIf(!OUT)("writes starter data and fixtures", async () => {
  const blueprints = Object.fromEntries(STARTERS.map((s) => [s.id, starterBlueprint(s.id)]));
  write("starters-data.json", { starters: STARTERS, blueprints, modules: STARTER_MODULES, defaultPublishOptions: defaultPublishOptions() });
  let screenplay: StarterBlueprint = { folders: [] };
  for (const moduleId of ["characters", "places", "items"]) screenplay = addModule(screenplay, moduleId);
  const counter = () => { let n = 0; return () => `id-${++n}`; };
  const builds = Object.fromEntries(STARTERS.map((s) => [s.id, buildFromBlueprint(starterBlueprint(s.id), counter())]));
  write("starters.json", {
    builds,
    screenplay: { blueprint: screenplay, keys: [...allBlueprintKeys(screenplay)], build: buildFromBlueprint(screenplay, counter()) },
    fantasyPlusFactions: addModule(starterBlueprint("fantasy"), "factions")
  });
});

it.skipIf(!OUT)("writes search and replace fixtures", async () => {
  const base = bookProject();
  const documents = [
    ...base.documents,
    { id: "s1", title: "Käpten's log", chapterId: "chapter-1", content: "<p>The Kapten met the käpten. KAPTEN!</p><p>Cat, catalogue, the cat's hat. 🌊 cat</p>" },
    { id: "s2", title: "Spanning", chapterId: "chapter-3", content: "<p>It was da<em>rk</em> and dark &amp; darker.</p>", markdownSource: "It was da*rk*" },
    { id: "s3", title: "Trashed dark", chapterId: "chapter-1", content: "<p>dark dark</p>", trashed: true },
    { id: "w1", title: "Dark lore", space: "Wiki", content: "<p>Notes about the dark tower. 한국어 dark.</p>" },
    { id: "x1", title: "Loose", content: "<p>dark but in no chapter</p>" }
  ];
  const chapters = base.chapters;
  const queries: Array<[string, Record<string, boolean>]> = [
    ["dark", {}], ["Dark", { caseSensitive: true }], ["dark", { wholeWord: true }], ["kapten", {}], ["KAPTEN", { caseSensitive: true }],
    ["cat", { wholeWord: true }], ["cat", {}], ["dark", { includeTrashed: true }], ["  the  ", {}], ["🌊", {}], ["", {}], ["nothing here", {}], ["한국어", {}], ["&", {}]
  ];
  const searches = queries.map(([query, options]) => ({ query, options, hits: searchDocuments(documents as never, chapters as never, query, options) }));
  const replaces = [
    ["dark", "light", {}], ["dark", "", { wholeWord: true }], ["kapten", "Captain", {}], ["Dark", "Night", { caseSensitive: true, includeTitles: true }], ["dark", "x", { includeTrashed: true }], ["&", "and", {}]
  ].map(([query, replacement, options]) => {
    const result = replaceInDocuments(documents as never, query as string, replacement as string, options as never);
    return { query, replacement, options, changed: result.changed, total: result.total, documents: result.documents.filter((d) => result.changed.some((c) => c.id === (d as { id: string }).id)) };
  });
  const only = replaceInDocuments(documents as never, "dark", "light", {}, new Set(["s2", "w1"]));
  const firsts = [["The Käpten sails", "kapten", {}], ["a cat and the cat", "cat", { wholeWord: true }], ["concatenate", "cat", { wholeWord: true }], ["Ünïcödé text", "unicode", {}], ["x", "", {}]].map(([text, query, options]) => ({ text, query, options, match: findFirstMatch(text as string, query as string, options as never) }));
  write("search.json", { documents, chapters, searches, replaces, only: { changed: only.changed, total: only.total }, firsts });
});

it.skipIf(!OUT)("writes EPUB import fixtures", async () => {
  const { parseEpub, buildEpubProject } = await import("$lib/import/epub");
  const { strToU8, zipSync } = await import("fflate");
  const { MAX_EMBEDDED_IMAGE_BYTES } = await import("$lib/sanitize");
  type Spec = { title?: string; creator?: string; metadata?: string; manifest: { id: string; href: string; type?: string; properties?: string; linear?: string }[]; spine: string[]; ncx?: string; guide?: string; files: Record<string, string | Uint8Array> };
  const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const packageDocument = (spec: Spec) => {
    const metadata = [spec.title === undefined ? "" : `<dc:title>${spec.title}</dc:title>`, spec.creator === undefined ? "" : `<dc:creator>${spec.creator}</dc:creator>`, spec.metadata ?? ""].join("");
    const manifest = spec.manifest.map((item) => `<item id="${item.id}" href="${item.href}" media-type="${item.type ?? "application/xhtml+xml"}"${item.properties ? ` properties="${item.properties}"` : ""}/>`).join("\n    ");
    const spine = spec.spine.map((id) => {
      const linear = spec.manifest.find((m) => m.id === id)?.linear;
      return `<itemref idref="${id}"${linear ? ` linear="${linear}"` : ""}/>`;
    }).join("\n    ");
    return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">test-book</dc:identifier>
    ${metadata}
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine${spec.ncx ? ` toc="${spec.ncx}"` : ""}>
    ${spine}
  </spine>
  ${spec.guide ?? ""}
</package>`;
  };
  const makeEpub = (spec: Spec): Uint8Array => {
    const files: Record<string, Uint8Array> = { "META-INF/container.xml": strToU8(CONTAINER), "OEBPS/content.opf": strToU8(packageDocument(spec)) };
    for (const [name, value] of Object.entries(spec.files)) files[name] = typeof value === "string" ? strToU8(value) : value;
    return zipSync(files);
  };
  const xhtml = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Test</title></head>
<body>${body}</body>
</html>`;
  const nav = (entries: string) => xhtml(`<nav epub:type="toc"><ol>${entries}</ol></nav>`);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const huge = new Uint8Array(MAX_EMBEDDED_IMAGE_BYTES + 1).fill(0x42);
  const navItem = { id: "nav", href: "nav.xhtml", properties: "nav" };
  const cases: Array<{ name: string; data: Uint8Array; fallbackTitle?: string }> = [
    { name: "nav-and-metadata", data: makeEpub({ title: "A Test Book", creator: "Ada Lovelace", manifest: [navItem, { id: "cover", href: "cover.xhtml" }, { id: "title-page", href: "title-page.xhtml" }, { id: "ch1", href: "ch1.xhtml" }, { id: "ch2", href: "ch2.xhtml" }], spine: ["nav", "cover", "title-page", "ch1", "ch2"], guide: `<guide><reference type="title-page" href="title-page.xhtml"/></guide>`, files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li><li><a href="ch2.xhtml#start">Chapter Two</a></li>'), "OEBPS/cover.xhtml": xhtml("<p>Cover</p>"), "OEBPS/title-page.xhtml": xhtml("<p>Title Page</p>"), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>First <strong>scene</strong>.</p>"), "OEBPS/ch2.xhtml": xhtml('<h2 id="start">Chapter Two</h2><p>Second scene.</p>') } }) },
    { name: "ncx", data: makeEpub({ manifest: [{ id: "ncx", href: "toc.ncx", type: "application/x-dtbncx+xml" }, { id: "ch1", href: "ch1.xhtml" }, { id: "ch2", href: "ch2.xhtml" }], spine: ["ch1", "ch2"], ncx: "ncx", files: { "OEBPS/toc.ncx": `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="p1"><navLabel><text>Opening</text></navLabel><content src="ch1.xhtml"/>
      <navPoint id="p1a"><navLabel><text>Opening, really</text></navLabel><content src="ch1.xhtml"/></navPoint>
    </navPoint>
    <navPoint id="p2"><navLabel><text>Closing</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`, "OEBPS/ch1.xhtml": xhtml("<p>Opening line.</p>"), "OEBPS/ch2.xhtml": xhtml("<p>Closing line.</p>") } }) },
    { name: "spine-fallback", data: makeEpub({ manifest: [{ id: "alpha", href: "alpha.xhtml" }, { id: "numeric", href: "chapter1.xhtml" }, { id: "named", href: "the_lost-letters.xhtml" }, { id: "aside", href: "aside.xhtml", linear: "no" }], spine: ["alpha", "numeric", "named", "aside"], files: { "OEBPS/alpha.xhtml": xhtml("<h1>Alpha</h1><p>Alpha text.</p>"), "OEBPS/chapter1.xhtml": xhtml("<p>Numeric text.</p>"), "OEBPS/the_lost-letters.xhtml": xhtml("Loose text at the top.<p>More.</p>"), "OEBPS/aside.xhtml": xhtml("<p>Not linear.</p>") } }) },
    { name: "scene-breaks", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>First part.</p><hr/>" + '<p>Second part.</p><p class="scene-break">* * *</p><p>Third part.</p><p>⁂</p><p>Fourth <em>part</em>.</p><div class="ornament"><img src="x.png"/></div><p>Fifth part.</p><p>---</p><p>Sixth part.</p>') } }) },
    { name: "wrappers-and-furniture", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml#contents">Contents</a></li><li><a href="ch1.xhtml#one">Chapter One Begins</a></li>'), "OEBPS/ch1.xhtml": xhtml('<div id="contents"><h2>Contents</h2><p>Chapter One Begins</p></div><div class="chapter" id="chap01"><h2><a id="one"/>Chapter One<br/>Begins</h2><p>Body text.</p></div>') } }) },
    { name: "title-page", data: makeEpub({ manifest: [navItem, { id: "title", href: "title.xhtml" }, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "title", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="title.xhtml#title">Book Title</a></li><li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/title.xhtml": xhtml('<h1 id="title">Book Title</h1><h2>by A. Writer</h2>'), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>Story text.</p>") } }) },
    { name: "gutenberg-licence", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }, { id: "license", href: "backmatter.xhtml" }, { id: "ch2", href: "ch2.xhtml" }], spine: ["nav", "ch1", "license", "ch2"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li><li><a href="backmatter.xhtml">The Full Project Gutenberg™ License</a></li><li><a href="ch2.xhtml">Chapter Two</a></li>'), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>First story.</p>"), "OEBPS/backmatter.xhtml": xhtml("<h1>Licence</h1><p>Legal boilerplate.</p>"), "OEBPS/ch2.xhtml": xhtml("<h1>Chapter Two</h1><p>Second story.</p>") } }) },
    { name: "images", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "Text/ch1.xhtml" }, { id: "map", href: "Images/pic.png", type: "image/png" }, { id: "anim", href: "Images/anim.gif", type: "image/gif" }, { id: "huge", href: "Images/huge.png", type: "image/png" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="Text/ch1.xhtml">Illustrated</a></li>'), "OEBPS/Text/ch1.xhtml": xhtml("<h1>Illustrated</h1>" + '<figure><img src="../Images/pic.png" alt="Map"/></figure>' + '<figure><svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="../Images/pic.png" alt="Diagram"/></svg></figure>' + '<p><img src="../Images/anim.gif" alt="Animated"/></p>' + '<p><img src="../Images/huge.png" alt="Huge"/></p>'), "OEBPS/Images/pic.png": PNG, "OEBPS/Images/anim.gif": GIF, "OEBPS/Images/huge.png": huge } }) },
    { name: "images-xml", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "Text/ch1.xhtml" }, { id: "map", href: "Images/pic.png", type: "image/png" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="Text/ch1.xhtml">Illustrated</a></li>'), "OEBPS/Text/ch1.xhtml": xhtml("<h1>Illustrated</h1>" + '<p>Before <img src="../Images/pic.png" alt="Map"/> after &amp; <span>more</span>.</p>' + '<figure><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../Images/pic.png"/></svg><figcaption>Caption</figcaption></figure>' + '<p><img src="data:image/gif;base64,R0lGOD"/>Kept text<a id="n1"/></p>'), "OEBPS/Images/pic.png": PNG } }) },
    { name: "cover-meta", data: makeEpub({ title: "Covered Book", metadata: '<meta name="cover" content="cover-art"/>', manifest: [navItem, { id: "cover-art", href: "Images/art.jpg", type: "image/jpeg" }, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>Text.</p>"), "OEBPS/Images/art.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) } }) },
    { name: "cover-property", data: makeEpub({ title: "Property Cover", manifest: [navItem, { id: "art", href: "Images/cover.png", type: "image/png", properties: "cover-image" }, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>Text.</p>"), "OEBPS/Images/cover.png": PNG } }) },
    { name: "cover-too-big", data: makeEpub({ title: "Huge Cover", manifest: [navItem, { id: "art", href: "Images/cover.png", type: "image/png", properties: "cover-image" }, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<h1>Chapter One</h1><p>Text.</p>"), "OEBPS/Images/cover.png": huge } }) },
    { name: "drm", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<p>Readable text.</p>"), "META-INF/encryption.xml": `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData></enc:EncryptedData>
</encryption>` } }) },
    { name: "font-obfuscation", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<p>Readable text.</p>"), "META-INF/encryption.xml": `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/Fonts/book.otf"/></enc:CipherData></enc:EncryptedData>
</encryption>` } }) },
    { name: "rights", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<p>Readable text.</p>"), "META-INF/rights.xml": "<rights/>" } }) },
    { name: "sanitized", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Safe</a></li>'), "OEBPS/ch1.xhtml": xhtml('<p onclick="steal()">Safe text.</p><p><a href="javascript:alert(1)">Bad link</a> and <a href="https://example.com/a?b=1&amp;c=2">good</a></p>') } }) },
    { name: "not-a-zip", data: strToU8("this is not a zip") },
    { name: "no-container", data: zipSync({ "readme.txt": strToU8("hello") }) },
    { name: "traversal", data: zipSync({ "META-INF/container.xml": strToU8(CONTAINER), "OEBPS/content.opf": strToU8(packageDocument({ manifest: [navItem, { id: "outside", href: "../../outside.xhtml" }, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "outside", "ch1"], files: {} })), "OEBPS/nav.xhtml": strToU8(nav('<li><a href="ch1.xhtml">Chapter One</a></li>')), "OEBPS/ch1.xhtml": strToU8(xhtml("<p>Inside text.</p>")), "../../outside.xhtml": strToU8(xhtml("<p>Outside text.</p>")) }) },
    { name: "fallback-title", fallbackTitle: "my_book.epub", data: makeEpub({ manifest: [navItem, { id: "ch1", href: "ch1.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch1.xhtml">Chapter One</a></li>'), "OEBPS/ch1.xhtml": xhtml("<p>Text.</p>") } }) },
    { name: "only-furniture", data: makeEpub({ manifest: [navItem, { id: "cover", href: "cover.xhtml" }], spine: ["nav", "cover"], files: { "OEBPS/nav.xhtml": nav('<li><a href="cover.xhtml">Cover</a></li>'), "OEBPS/cover.xhtml": xhtml("<p>Cover art</p>") } }) },
    { name: "html-fallback", data: makeEpub({ creator: "One", metadata: "<dc:creator>  Two  Names </dc:creator>", manifest: [navItem, { id: "ch1", href: "ch%201.xhtml" }], spine: ["nav", "ch1"], files: { "OEBPS/nav.xhtml": nav('<li><a href="ch%201.xhtml#s2">  Second\n  Half </a></li><li><a href="ch%201.xhtml">First Half</a></li>'), "OEBPS/ch 1.xhtml": `<html><body><h1>First Half</h1><p>Caf&eacute; &nbsp;au lait<p>Unclosed para<br>line<section><p id="s2">Second&nbsp;half text.</p><blockquote>Quoted <b>bold</b></blockquote></section></body></html>` } }) }
  ];
  // Books ProseCraft itself exported, read back.
  const exported = bookProject();
  const exportVariants: Record<string, Record<string, unknown>> = {
    defaults: {},
    everything: { style: "modern", includeTableOfContents: true, includeSceneTitles: true, includeCopyrightPage: true, sceneSeparator: "asterisks", subtitle: "A Novel <&>", copyright: "© 2026 A. Writer", dedication: "For the keepers.", frontMatter: [{ id: "f1", title: "Epigraph", body: "Some words." }], backMatter: [{ id: "b1", title: "Acknowledgments", body: "Thank you." }] },
    ebook: { style: "ebook", sceneSeparator: "line", includeTitlePage: false, includeChapterTitles: false }
  };
  for (const [variant, raw] of Object.entries(exportVariants)) {
    const options = normalizePublishOptions(raw);
    const book = compileBook({
      title: exported.name, author: exported.author, subtitle: options.subtitle, copyright: options.copyright,
      dedication: options.dedication, frontMatter: options.frontMatter, backMatter: options.backMatter,
      chapters: exported.chapters.filter((c) => !c.trashed), documents: exported.documents, footnotesRestartPerChapter: options.footnotesRestartPerChapter
    });
    const payload = await exportEpub(book, options);
    cases.push({ name: `exported-${variant}`, data: new Uint8Array(await payload.blob.arrayBuffer()), fallbackTitle: "exported.epub" });
  }
  const results = [];
  for (const c of cases) {
    let result: unknown = null;
    let error: string | null = null;
    try {
      result = await parseEpub(c.data, c.fallbackTitle ? { fallbackTitle: c.fallbackTitle } : {});
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({ name: c.name, epub: Buffer.from(c.data).toString("base64"), fallbackTitle: c.fallbackTitle ?? null, result, error });
  }
  let n = 0;
  const manuscript = await parseEpub(cases.find((c) => c.name === "cover-meta")!.data);
  const project = buildEpubProject(manuscript, { createId: () => `id-${++n}` });
  write("epub-import.json", { cases: results, project });
});

it.skipIf(!OUT)("writes Scrivener and RTF import fixtures", async () => {
  const { rtfToHtml } = await import("$lib/import/rtf");
  const { buildScrivenerProject, scrivenerFilesFromZip, scrivenerFilesFromEntries } = await import("$lib/import/scrivener");
  const { strToU8, zipSync } = await import("fflate");
  const enc = new TextEncoder();
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  // RTF: as text bytes (Scrivener passes bytes), including raw 8-bit and CJK code pages.
  const rtfInputs: Array<string | Uint8Array> = [
    "{\\rtf1\\ansi Hello\\par World\\par}", "{\\rtf1\\ansi first\\line second\\par}", "{\\rtf1\\ansi Hello\r\nWorld\\par}", "{\\rtf1\\ansi Hello\\\nWorld\\par}",
    "{\\rtf1\\ansi Hello\\\r\nWorld\\par}", "{\\rtf1\\ansi one\\par\r\ntwo\\par}", "", "{\\rtf1\\ansi}", "{\\rtf1\\ansi\\par}", "{\\rtf1\\ansi\\ansicpg1252 M\\'e4dchen\\par}",
    "{\\rtf1\\ansi\\ansicpg1252 \\'93quoted\\'94\\par}", "{\\rtf1\\ansi \\u228?\\par}", "{\\rtf1\\ansi \\uc0\\u228?\\par}", "{\\rtf1\\ansi \\u-10179\\u-8704\\par}",
    "{\\rtf1\\ansi \\u-10179?\\u-8704?\\par}", "{\\rtf1\\ansi \\uc2\\u20013\\'d6\\'d0 x\\par}", "{\\rtf1\\ansi \\b bold \\i both\\i0 bold\\b0 plain\\par}", "{\\rtf1\\ansi \\i \\ul \\strike all\\plain none\\par}",
    "{\\rtf1\\ansi one\\par\\par}", "{\\rtf1\\ansi a\\tab b\\~c\\_d\\-e\\par}", "{\\rtf1\\ansi \\{x\\}\\\\y < & \"\\par}", "{\\rtf1\\ansi {\\b bold} plain\\par}", "{\\rtf1\\ansi broken",
    "{\\rtf1\\ansi \\b bold", "{\\rtf1\\ansi a} extra\\par}", "\\rtf1 no groups", "{\\rtf1\\ansi\\ansicpg1252\\deff0 {\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator x}{\\info{\\title T}}\\pard Visible{\\footnote note}\\par}",
    "{\\rtf1\\ansi\\ansicpg1251 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2\\par}", "{\\rtf1\\ansi\\ansicpg936 \\'d6\\'d0\\'ce\\'c4\\par}", "{\\rtf1\\ansi\\ansicpg932 \\'82\\'a0\\par}",
    "{\\rtf1\\ansi\\ansicpg65001 \\'e2\\'82\\'ac\\par}", "{\\rtf1\\ansi\\ansicpg65001 \\'ef\\'bb\\'bfBOM\\par}", "{\\rtf1\\ansi\\ansicpg949 \\'c7\\'d1 \\par}",
    // Code pages without a windows-N label, and \\uN text, bytes, tabs and symbols in order
    // (jennraeross/ProseCraft#49).
    "{\\rtf1\\ansi\\ansicpg950 \\'a4\\'a4\\'a4\\'e5\\par}", "{\\rtf1\\mac\\ansicpg10000 caf\\'8e\\par}", "{\\rtf1\\ansi\\ansicpg932 \\'93\\'fa\\'96\\'7b\\par}",
    "{\\rtf1\\ansi\\ansicpg932\\uc0 \\u9731 \\'93\\'fa\\par}", "{\\rtf1\\ansi\\ansicpg1252 x\\'e9\\tab y\\'e9\\{\\'e9\\}\\'e9\\\\\\par}", "{\\rtf1\\ansi\\ansicpg99999 \\'e4\\par}",
    "{\\rtf1\\ansi \\b\\i x\\b0 y\\i0 z\\par}", "{\\rtf1\\ansi \\b x\\pard y\\plain z\\par}", "{\\rtf1\\ansi a\\'zz b\\'4\\par}", "{\\rtf1\\ansi \\uc1\\u8364\\'80 euro\\par}",
    "{\\rtf1\\ansi \\u65 \\u66\\u67 x\\par}", "{\\rtf1\\ansi {\\*\\ignored {\\b nested}} after\\par}", "{\\rtf1\\ansi {\\pict\\pngblip 89504e47} text\\par}", "{\\rtf1\\ansi \\b {\\i inner} \\par next\\par}", "{\\rtf1\\ansi\\ansicpg1251 \\'cf\\ansicpg- \\'cf\\par}", "{\\rtf1\\ansi \\ucx\\u228?? \\b- bold\\par}",
    new Uint8Array([...strToU8("{\\rtf1\\ansi\\ansicpg1252 raw "), 0xe4, 0xf6, ...strToU8("\\par}")]), new Uint8Array([...strToU8("{\\rtf1\\ansi\\ansicpg65001 raw "), 0xe2, 0x82, 0xac, ...strToU8("\\par}")])
  ];
  const rtf = rtfInputs.map((input) => {
    const bytes = typeof input === "string" ? enc.encode(input) : input;
    return { input: b64(bytes), html: rtfToHtml(bytes) };
  });
  const r = (text: string) => `{\\rtf1\\ansi\\ansicpg1252\\deff0 {\\fonttbl{\\f0 Arial;}}\\pard ${text}\\par}`;
  const item = (type: string, attrs: string, title: string, children: string[] = [], meta = "") => `<BinderItem ${attrs} Type="${type}"><Title>${title}</Title>${meta}${children.length ? `<Children>${children.join("")}</Children>` : ""}</BinderItem>`;
  const scene = (id: string, title: string, children: string[] = [], ext?: string) => item("Text", `ID="${id}"`, title, children, ext ? `<MetaData><FileExtension>${ext}</FileExtension></MetaData>` : "");
  const folder = (id: string, title: string, children: string[] = []) => item("Folder", `ID="${id}"`, title, children);
  const scrivx = (...items: Array<string | string[]>) => `<ScrivenerProject Version="1.0"><Binder>${items.flat().join("")}</Binder></ScrivenerProject>`;
  const draft = (children: string[] = []) => item("DraftFolder", 'ID="1"', "Manuscript", children);
  const research = (children: string[] = []) => item("ResearchFolder", 'ID="2"', "Research", children);
  const projects: Record<string, { files: Record<string, string>; projectName?: string }> = {
    docs: { files: { "project.scrivx": scrivx(draft([scene("5", "Opening")])), "Files/Docs/1_synopsis.txt": "Draft overview.", "Files/Docs/5.rtf": r("First scene."), "Files/Docs/5_synopsis.txt": "  A short\r\nsynopsis  ", "Files/Docs/5_notes.rtf": r("A note") } },
    data: { files: { "project.scrivx": scrivx(item("DraftFolder", 'UUID="D"', "Draft", [item("Text", 'UUID="A"', "Alpha"), item("Folder", 'UUID="F"', "Part One", [item("Text", 'UUID="B"', "Beta")])])), "Files/Data/A/content.rtf": r("Alpha text \\b bold\\b0 ."), "Files/Data/B/content.rtf": r("Beta text."), "Files/Data/F/synopsis.txt": "Part synopsis", "Files/Data/B/notes.rtf": r("n") } },
    folders: { files: { "project.scrivx": scrivx(draft([folder("10", "Chapter One", [scene("11", "Scene A"), scene("12", "Scene B", [scene("13", "Child")])]), folder("20", "Chapter Two", [folder("21", "Nested", [scene("22", "Deep")])]), scene("30", "Loose"), item("Image", 'ID="40"', "Picture")])), "Files/Docs/10.rtf": r("Folder text."), "Files/Docs/11.rtf": r("A."), "Files/Docs/12.rtf": r("B."), "Files/Docs/13.rtf": r("C."), "Files/Docs/22.rtf": r("D."), "Files/Docs/30.rtf": r("L.") } },
    wiki: { files: { "project.scrivx": scrivx(draft([scene("5", "S")]), research([folder("60", "People", [scene("61", "Mara", [scene("62", "Sub")])]), scene("63", "Loose page"), item("PDF", 'ID="64"', "Paper")]), folder("70", "Other Stuff", [scene("71", "Idea")]), scene("80", "Top note"), item("TrashFolder", 'ID="3"', "Trash", [scene("90", "Deleted")]), research([scene("95", "Second research")])), "Files/Docs/5.rtf": r("S."), "Files/Docs/61.rtf": r("Mara text."), "Files/Docs/63.rtf": r("Page."), "Files/Docs/71.rtf": r("Idea."), "Files/Docs/80.rtf": r("Note."), "Files/Docs/90.rtf": r("Gone."), "Files/Docs/62_notes.rtf": r("x") } },
    missing: { files: { "project.scrivx": scrivx(draft([scene("5", "Edited", [], "rtf"), scene("6", "Never edited"), scene("7", "Broken", [], "rtf")])), "Files/Docs/7.rtf": "not rtf at all \u0000" } },
    empty: { files: { "project.scrivx": scrivx(draft([])) } },
    "draft-text": { files: { "project.scrivx": scrivx(draft([scene("5", "One")])), "Files/Docs/1.rtf": r("Draft's own text."), "Files/Docs/5.rtf": r("One.") } },
    wrapped: { files: { "My Novel.scriv/project.scrivx": scrivx(draft([scene("5", "Opening")])), "My Novel.scriv/Files/Docs/5.rtf": r("Wrapped."), "Other/project.scrivx": "<x/>" } },
    named: { files: { "project.scrivx": scrivx(draft([scene("5", "  Spaced\n title  ")])), "Files/Docs/5.rtf": r("x") }, projectName: "  Given Name.scriv " },
    untitled: { files: { "project.scrivx": scrivx(item("DraftFolder", 'ID="1"', "", [item("Text", 'ID="5"', ""), item("Folder", 'ID="6"', "")])) } },
    "long-synopsis": { files: { "project.scrivx": scrivx(draft([folder("6", "F", [scene("7", "s")])])), "Files/Docs/6_synopsis.txt": "word ".repeat(1000), "Files/Docs/7.rtf": r("x") } },
    "bad-xml": { files: { "project.scrivx": "<ScrivenerProject><Binder>" } },
    "no-binder": { files: { "project.scrivx": "<ScrivenerProject/>" } },
    "no-scrivx": { files: { "Files/Docs/1.rtf": r("x") } }
  };
  const scrivener = Object.entries(projects).map(([name, spec]) => {
    let n = 0;
    const entries = Object.entries(spec.files).map(([path, text]) => ({ path, bytes: enc.encode(text) }));
    let result: unknown = null;
    let error: string | null = null;
    try {
      result = buildScrivenerProject(scrivenerFilesFromEntries(entries), { createId: () => `id-${++n}`, ...(spec.projectName ? { projectName: spec.projectName } : {}) });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { name, files: entries.map((e) => ({ path: e.path, bytes: b64(e.bytes) })), projectName: spec.projectName ?? null, result, error };
  });
  const zips = [
    { name: "zip", data: zipSync({ "Novel.scriv/project.scrivx": strToU8(scrivx(draft([scene("5", "Zipped")]))), "Novel.scriv/Files/Docs/5.rtf": strToU8(r("From a zip.")), "__MACOSX/Novel.scriv/._x": strToU8("junk"), "Novel.scriv/.DS_Store": strToU8("junk") }) },
    { name: "zip-traversal", data: zipSync({ "../evil/project.scrivx": strToU8(scrivx(draft([]))) }) },
    { name: "zip-absolute", data: zipSync({ "/abs/project.scrivx": strToU8(scrivx(draft([]))) }) },
    { name: "not-zip", data: strToU8("not a zip") }
  ].map(({ name, data }) => {
    let n = 0;
    let result: unknown = null;
    let error: string | null = null;
    try {
      result = buildScrivenerProject(scrivenerFilesFromZip(data), { createId: () => `id-${++n}` });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { name, zip: b64(data), result, error };
  });
  write("scrivener-import.json", { rtf, scrivener, zips });
});

it.skipIf(!OUT)("writes Fountain fixtures", async () => {
  const { parseFountain, serializeFountain } = await import("$lib/screenplay/fountain");
  const { elementsToHtml, htmlToElements } = await import("$lib/screenplay/layout");
  const SAMPLE = `Title: The Last Lighthouse
Credit: Written by
Author: Sascha
Draft date: 12/11/2026

EXT. LIGHTHOUSE - NIGHT

Waves crash against the rocks.

MARA
(quietly)
Is anyone there?

CUT TO:

INT. LIGHTHOUSE - NIGHT

MARA
(into the dark)
Hello?

> THE END <

===
`;
  const inputs = [
    SAMPLE,
    "Title: A Very\n    Long Title\nAuthor: Mara\n\nINT. ROOM - DAY\n",
    "A door opens.\nINT. NOT A HEADING\n",
    "INT. ROOM - DAY\n\nCUT TO:\n\ncut to:\n",
    "INT. KITCHEN - DAY\n\nALICE\nLeft.\n\nBOB ^\nRight.\n",
    "INT. ROOM - DAY\n\n[[first\nsecond]]\n\nAction.\n",
    "", "  \n\n\t\n",
    "title: lower case key\nNotes: kept\n    on two lines\nUnknown: stops here\n\nAction.\n",
    "Title: Only a title\n",
    ".FORCED HEADING #12#\n\nINT. HOUSE - DAY #1A#\n\nEXT. PARK #  #\n\nI/E. CAR - MOVING\n\nINT/EXT. HALL\n\nEST. CITY\n\nINTERIOR DESIGN is not a heading.\n",
    "..not forced\n\n.\n\n!INT. FORCED ACTION\n\n!\n",
    "@McCLANE\nYippee ki-yay.\n\nMcCLANE (V.O.)\nStill not a cue? (lowercase c)\n\nSTEEL (CONT'D)\n(beat)\nRight.\n[[aside]] More.\n\nSTEEL\n\nAfter a blank line, not dialogue.\n",
    "HANS ^\n\nSOLO\n",
    "> Forced transition\n\n>CENTERED<\n\n> < \n\nFADE TO BLACK.\n\nSMASH CUT TO:\n\nfade out to:\n",
    "# Act One\n\n## Sequence\n\n####### Seven\n\n#\n\n= A synopsis\n\n=\n\n===\n\n==\n\nINT. AFTER SECTION - DAY\n",
    "Action with [[an inline note]] and [[another]]  text.\n\nAction [[unclosed note\ncontinues\n\nnext]] tail text\n",
    "[[note at end]] and the rest\n\n[[never closed\nat all",
    "Boneyard /* hidden\nacross lines */ visible.\n\n/* unclosed boneyard\nto the end",
    "Emphasis: *italic*, **bold**, ***both***, _under_, * not*, **mixed*, a < b & c > d\n\n_un_der_score_\n",
    "INT. ROOM - DAY\r\n\r\nWindows lines.\r\nMore.\rOld Mac.\r\n",
    "   Indented action.\n\n\tTabbed.\n\nINT. ROOM - DAY\nNo blank before this action.\nMARA\nNot a cue (no blank before).\n",
    "MARA\n(beat)\n\n(not parenthetical\n",
    "1 2 3 numbers ONLY\n\nX-RAY 2\nDialogue.\n\nA.B.C.\nTalk.\n"
  ];
  const { estimatePages, estimateRuntime, wrapScreenplayText } = await import("$lib/screenplay/layout");
  const { nextElementType, autoDetectType, autoCase, EDITOR_ELEMENT_TYPES } = await import("$lib/screenplay/editor-keys");
  const long = "INT. HOUSE - DAY\n\n" + Array.from({ length: 40 }, (_, i) => `ALICE\n(beat ${i})\nA line of dialogue that is long enough to wrap over more than one column of the page, number ${i}.\n\nShe moves to the window and waits for a very long time while the rain falls.\n\nEXT. STREET ${i} - NIGHT\n\nBOB\nHi.\n`).join("\n") + "\nCUT TO:\n\n===\n\n> THE END <\n";
  inputs.push(long);
  const cases = inputs.map((input) => {
    const parsed = parseFountain(input);
    const html = elementsToHtml(parsed.elements);
    const estimate = estimatePages(parsed.elements);
    return { input, title: parsed.title, elements: parsed.elements, html, back: htmlToElements(html), fountain: serializeFountain(parsed.title, parsed.elements), estimate, runtime: estimateRuntime(estimate.pages) };
  });
  const keys = [];
  for (const type of EDITOR_ELEMENT_TYPES) for (const key of ["Enter", "Tab", "ShiftTab"] as const) for (const empty of [false, true]) keys.push({ type, key, empty, next: nextElementType(type, key, { empty }) });
  const lines = ["", "  ", "INT. HOUSE", "int. house - day", "INT", "INT.", "EXT.", "EST", "I/E", "INT./EXT. CAR", "INTERIOR", "CUT TO:", "Cut to:", "MARA", "MARA (V.O.)", "Mara", "MARA (cont'd)", "123", "SMASH TO:", "FADE OUT."];
  const detect = lines.map((line) => ({ line, type: autoDetectType(line) }));
  const cased = EDITOR_ELEMENT_TYPES.map((type) => ({ type, text: autoCase(type, "Mara's straße – ok") }));
  const wraps = [["", 10], ["one two three four five", 9], ["  spaced   words\nsecond line  ", 7], ["averyveryverylongword short", 5]].map(([text, width]) => ({ text, width, lines: wrapScreenplayText(text as string, width as number) }));
  const { bookToFountain } = await import("$lib/screenplay/export-fountain");
  const documents = [
    { id: "d1", title: "Opening", chapterId: "c1", content: cases[0].html, format: "screenplay" },
    { id: "d2", title: "Prose", chapterId: "c1", content: "<p>A <em>prose</em> scene.</p>" },
    { id: "d3", title: "Second", chapterId: "c2", content: cases[4].html, format: "screenplay" },
    { id: "d4", title: "Trashed", chapterId: "c2", content: cases[2].html, trashed: true }
  ];
  const chapters = [{ id: "c1", title: "Act One" }, { id: "c2", title: "Chapter 2" }];
  const books = [["The Pilot", "A. Writer"], ["Untitled <&>", "  "]].map(([title, author]) => {
    const book = compileBook({ title, author, subtitle: "", copyright: "", dedication: "", frontMatter: [], backMatter: [], chapters: chapters as never, documents: documents as never });
    return { title, author, fountain: bookToFountain(book) };
  });
  const { proseToScreenplayElements, convertDocumentToScreenplay } = await import("$lib/screenplay/convert");
  const prose = [
    "<p>Mara: Is anyone there?</p><p>Old Tom (V.O.): \"Nobody, child.\"</p><p>The door creaks.</p>",
    "<p>— Hello? she said. — Who is it?</p><p>– Leave, he whispered.</p><p>- Fine, I will, — Mara said.</p>",
    "<p>She said \"Go away\" and then “Now!” and „Bitte“ and «Allez» to nobody.</p>",
    "<p>Note: not a speaker</p><p>http: also not</p><p>Van der Berg: a speaker</p><p>de la Cruz: also one</p><p>The very long name of five: too many words</p><p>Who, me: no</p>",
    "<blockquote><p>Quoted <em>prose</em> line.</p><p>Second <strong>bold</strong> <u>under</u>.</p></blockquote><ul><li>One</li><li>Two<br>Three</li></ul>",
    "<h1>Title</h1><p>Line one<br>Line two</p><div><p>Nested</p></div><div>Loose div text</div>",
    "<p>Élodie: Bonjour.</p><p>ÉLODIE (O.S.): Encore.</p><p>Ünal: Merhaba.</p><p>3PO: Beep.</p>",
    "<p>Text with a footnote<sup class=\"footnote-ref\" data-footnote-id=\"fn-1\" contenteditable=\"false\"></sup>.</p>",
    "", "<p><br></p>", "<p>   </p>"
  ];
  const conversions = prose.map((html) => ({ html, elements: proseToScreenplayElements(html) }));
  const converted = convertDocumentToScreenplay({ id: "d1", title: "Prose", content: prose[0], chapterId: "c1", markdownSource: "Mara: x", labelId: "l1" } as never);
  write("fountain.json", { cases, keys, detect, cased, wraps, documents, chapters, books, conversions, converted });
});

it.skipIf(!OUT)("writes custom starter fixtures", async () => {
  const { normalizeCustomStarters, saveCustomStarters, CUSTOM_STARTERS_KEY, addCustomFolder, addCustomPage, renameCustomFolder, renameCustomPage, removeCustomPage, removeCustomFolder, starterBlueprint, filterBlueprint, allBlueprintKeys } = await import("$lib/starters");
  const stored = [
    { id: "a", name: "  Fantasy mine  ", blueprint: { folders: [
      { key: "module:magic", name: "Magic", pages: [{ key: "x", title: " Spell ", html: "<p onclick=\"x\">Fire</p><b>bold</b>" }, { title: "", html: 5 }, "junk", null] },
      { key: "module:magic", name: "Magic again", pages: [{ title: "Dup module" }] },
      { key: "module:unknown", name: "", pages: "nope" },
      { key: "folder:9", name: "People", pages: [{ title: "A".repeat(200), html: "<p>" + "x".repeat(60000) + "</p>" }] },
      "not a folder"
    ] } },
    { id: "a", name: "Duplicate id", blueprint: { folders: [] } },
    { id: "", name: "No id", blueprint: { folders: [] } },
    { id: "b", name: "", blueprint: { folders: "no" } },
    { id: "c", blueprint: { folders: Array.from({ length: 45 }, (_, i) => ({ name: `F${i}`, pages: Array.from({ length: 6 }, (_, j) => ({ title: `P${i}.${j}` })) })) } },
    null, 7, { id: "d", name: 12, blueprint: { folders: [{ name: "Only", pages: [] }] } },
    ...Array.from({ length: 25 }, (_, i) => ({ id: `many-${i}`, name: `T${i}`, blueprint: { folders: [] } }))
  ];
  const normalized = normalizeCustomStarters(stored);
  let saved = "";
  saveCustomStarters({ setItem: (_key: string, value: string) => { saved = value; } } as never, normalized);
  let working = starterBlueprint("fantasy");
  working = addCustomFolder(working, "  My folder ");
  const folderKey = working.folders[working.folders.length - 1].key;
  working = addCustomPage(working, folderKey, " Page one ", "<p>Hi</p>");
  working = addCustomPage(working, folderKey, "");
  working = addCustomFolder(working, "");
  working = renameCustomFolder(working, folderKey, " Renamed ");
  const pageKey = working.folders.find((f) => f.key === folderKey)!.pages[0].key;
  working = renameCustomPage(working, pageKey, "   ");
  working = removeCustomPage(working, working.folders.find((f) => f.key === folderKey)!.pages[1].key);
  working = removeCustomFolder(working, working.folders[0].key);
  const keys = [...allBlueprintKeys(working)];
  const template = filterBlueprint(working, new Set(keys.filter((_, i) => i % 3 !== 1)));
  write("custom-starters.json", { key: CUSTOM_STARTERS_KEY, stored, normalized, saved, working, template });
});

it.skipIf(!OUT)("writes Markdown (marked) fixtures", async () => {
  const { markdownToHtml, markdownToDocument } = await import("$lib/publish/markdown");
  const { marked } = await import("marked");
  const spec = JSON.parse(readFileSync(join(__dirname, "lib/commonmark-spec.gen.json"), "utf8")) as Array<{ markdown: string; example: number; section: string }>;
  const own = [
    "Text with a footnote[^n1] and another[^n-2].\n\n[^n1]: The *first* note.\n[^n-2]: Second note\n    continued line.\n",
    "[^bad id!]: not a footnote\n\nText[^missing].\n",
    "Inline $x^2$ and $$display$$ and \\(paren\\) math, but $5 and $ 5 and 5$ are money.\n\n$$\nE = mc^2\n$$\n\n\\[\na + b\n\\]\n",
    "As shown [@smith2020, p. 4; @jones] and [see @doe2019] but not [plain] or [link](x) or [@a][b] or [^fn].\n",
    "```mermaid\ngraph TD; A-->B;\n```\n\n```calc\n1 + 2\n```\n\n```mathcad\nx := 3\n```\n\n```js\nconst a = 1;\n```\n",
    "# Title\n\nA paragraph with **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.com \"T\").\n\n> Quote\n\n- one\n- two\n\n1. a\n2. b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n![img](data:image/png;base64,AA==)\n",
    "* * *\n\nText after a scene break.\n\n<div class=\"x\">raw html</div>\n\nwww.example.com and https://autolink.org/path?q=1.\n",
    "Line one  \nLine two\\\nLine three\n\n- [ ] task\n- [x] done\n"
  ];
  const fromExports: string[] = [];
  for (const file of ["export-markdown.json"]) {
    try {
      const data = JSON.parse(readFileSync(join(OUT!, file), "utf8"));
      for (const value of Object.values(data.exports ?? {})) fromExports.push((value as { markdown: string }).markdown);
    } catch { /* not generated yet */ }
  }
  const tree = (tokens: unknown[]): unknown[] => (tokens as Array<Record<string, unknown>>).map((t) => {
    const node: Record<string, unknown> = { type: t.type, raw: t.raw };
    if (Array.isArray(t.tokens)) node.tokens = tree(t.tokens);
    if (Array.isArray(t.items)) node.items = tree(t.items);
    return node;
  });
  const inputs = [...spec.map((s) => s.markdown), ...own, ...fromExports];
  const cases = inputs.map((markdown) => {
    const html = markdownToHtml(markdown);
    const doc = markdownToDocument(markdown);
    return { markdown, html, document: doc, tokens: tree(marked.lexer(markdown)) };
  });
  write("marked.json", { cases });
});

const REGRESSIONS: string[] = ["\ud83c\udf0a\\[| a | b |\n|---|---|\n$x$\\\u201c[a@b.co%- [ ] [ref]: /u \"t\"\n__<a href=\"x\">\u0000| a | b |\n|---|---|\n| a | b |\n|---|---|\n``", "\n\n\ud83c\udf0a\\[B`  \n- [x] - [ ] a\u00e9", ">\ud83c\udf0a\\[)[@key, p. 4]", "$>\n\nhttp://x.y  \n_\n- [ ]   \n*\ud83d\ude00\t@k*\ud83d\ude00\u201c]()~~[^a]: n\n\u201c[^a]*\ud83d\ude00 ](\u00a0&#169;**$", "_\u00a0:\n\n$_\ud83c\udf0a*\r\n_\r\n- [ ] >[^a]![&(> ahttp://x.y@k~~&[)](\u201c&\u00e9[^a]: n\n*\ud83d\ude00#[r][^a]: n\n](", "[^a]&[#\n\n\u00e9](  \n- [ ] ~~\n)\ud83c\udf0a#>\\http://x.y\r\n[^a]: n\n$#> \u00e9~~*`~~<\u201c\r\n__*\ud83d\ude00\u00e9a[^a]![&#169;  \n\ud83c\udf0a  \n@k  \n\r\n\u201c\r\n", "- \ud83d\ude00*~~\"_- [ ] - :\r\n*\ud83d\ude00#&&#169;\"*\\*\ud83d\ude00\t\r\n(  \n[^a][r]&#169;\\>- [ ] \ud83d\ude00*a\n\n[|@k#&[r]: /u\n[ [^a]@k*\ud83d\ude00", "- \ud83d\ude00*|&)[\ud83d\ude00**~~![&#169;[^a][r]: /u\n*\ud83d\ude00\t**![\u201c[^a]: n\n*\\~~\n[r]*\ud83d\ude00a)![\u00e9:- **\u201c\"\\\t\\\n*\n\n**&#169;\"[r]: /u\n\ud83d\ude00*\"**![\n`"];

it.skipIf(!OUT)("writes Markdown (marked) random fixtures", async () => {
  const { markdownToHtml, markdownToDocument } = await import("$lib/publish/markdown");
  const { marked } = await import("marked");
  // Fixed-seed generators, so the corpus is the same on every run.
  let seed = 0x2f6b1d;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  // Short pieces: delimiters, escapes, entities, HTML, non-ASCII and astral characters.
  const pieces = [
    "*", "**", "***", "_", "__", "~", "~~", "`", "``", "[", "]", "(", ")", "![", "](", "\\", "\\*", "\\“",
    "<", ">", "<b>", "</b>", "<a href=\"x\">", "</a>", "<pre>", "\n", "\n\n", " ", "  \n", "\t", "    ",
    "a", "word", "B", "#", "## ", "- ", "* ", "1. ", "2) ", "> ", "| a | b |\n|---|---|\n", "|", "---\n",
    "```\n", "~~~", "é", "“", "”", "‘", "—", "🌊", "日本", " ", " ", "&", "&amp;", "&#169;", "&#x1F30A;",
    "$", "$$", "$x$", "\\(", "\\)", "\\[", "\\]", "@key", "[@key, p. 4]", "[see @a; -@b]", "[^n1]", "[^n1]: note\n",
    "http://ex.am/p?q=1", "www.ex.am", "a@b.co", ":", "\"", "'", ".", ",", "!", "?", "%", "[ref]", "[ref]: /u \"t\"\n",
    "- [ ] ", "- [x] ", "<!-- c -->", "&nbsp;", "\r\n", "\u0000", "😀*", "*😀", "_é_", "**“q”**", "Σ"
  ];
  // Whole lines: indents and tabs, list, quote and heading markers, fences, table rows,
  // footnote and link definitions with continuation lines.
  const indents = ["", "", "", " ", "  ", "   ", "    ", "     ", "      ", "        ", "\t", " \t", "\t\t", "  \t"];
  const markers = ["", "", "", "- ", "* ", "+ ", "1. ", "2) ", "10. ", "> ", ">> ", "> - ", "- > ", "# ", "### ", "```", "```js", "~~~", "| a | b |", "|---|:-:|", "|:-|-:|", "| x \\| y | z |", "[^n1]: ", "[^n-2]:", "[r]: /u 't'", "[R]:\n/v", "***", "---", "===", "$$", "\\[", "\\]", "<div>", "</div>", "<!-- ", "-->", "- [ ] ", "- [x] ", "    ", "> > ", "1) "];
  const words = ["a", "word", "*em*", "**b**", "_u_", "__s__", "~~d~~", "`c`", "[l](x)", "[r]", "![i](p.png)", "[^n1]", "[@k]", "[see @k, p. 2]", "$x$", "\\*", "&amp;", "&#169;", "é", "“q”", "🌊", "日本", " ", "<b>", "</b>", "http://a.b/c", "www.a.b", "x@y.co", "|", "\\", "*", "_", "~", "[", "]", "(", ")", "!", ":", "-", "#"];
  const line = () => {
    let s = indents[rand(indents.length)] + markers[rand(markers.length)];
    const n = rand(6);
    for (let k = 0; k < n; k += 1) s += (k ? " " : "") + words[rand(words.length)];
    return s + "\n";
  };
  const inputs: string[] = [...REGRESSIONS];
  for (let i = 0; i < 400; i += 1) {
    let markdown = "";
    const count = 1 + rand(40);
    for (let j = 0; j < count; j += 1) markdown += pieces[rand(pieces.length)];
    inputs.push(markdown);
  }
  for (let i = 0; i < 400; i += 1) {
    let markdown = "";
    const lines = 1 + rand(12);
    for (let j = 0; j < lines; j += 1) markdown += rand(5) === 0 ? "\n" : line();
    inputs.push(markdown);
  }
  const tree = (tokens: unknown[]): unknown[] => (tokens as Array<Record<string, unknown>>).map((t) => {
    const node: Record<string, unknown> = { type: t.type, raw: t.raw };
    if (Array.isArray(t.tokens)) node.tokens = tree(t.tokens);
    if (Array.isArray(t.items)) node.items = tree(t.items);
    return node;
  });
  const cases = [];
  for (const markdown of inputs) {
    try {
      const html = markdownToHtml(markdown);
      const doc = markdownToDocument(markdown);
      // The document's HTML is always the same as markdownToHtml's, so only its footnotes are kept.
      if (doc.html !== html) throw new Error("document HTML differs");
      cases.push({ markdown, html, footnotes: doc.footnotes, tokens: tree(marked.lexer(markdown)) });
    } catch {
      // marked threw; such inputs are left out.
    }
  }
  write("marked-random.json", { cases });
});

it.skipIf(!OUT)("writes Markdown folder import fixtures", async () => {
  const mf = await import("$lib/import/markdown-folder");
  const f = (path: string, text: string) => ({ path, text });
  const frontmatter = [
    "---\ntitle: T\ntags: [a, \"b\", 'c', ]\naliases:\n  - One\n  - \"Two\"\nposition: 3\n---\nBody",
    "---\ntitle: Unclosed\nBody",
    "No header",
    "﻿---\r\ntitle: 'Quoted'\r\n---\r\nWindows\r\nlines\rold mac",
    "---\nlist:\n- a\nnot: pair here\n  - b\nkey:value\nk-e_y: v\n---\n",
    "---\n---\nempty header",
    "---\ntitle:\n  - In a list\n---\nx",
    "--- \ntitle: space after dashes\n---\nx",
    "---\na: 1\n---",
    "---\nx: [a,b\n---\nrest\n---\nmore"
  ].map((text) => ({ text, ...mf.parseFrontmatter(text) }));
  const names = ["03_CHARACTERS", "entwurf_v4_master", "03_C02_die_treppe.md", "README.md", "12.Draft", "1 - One", "__init__", "007", "ÉCOLE", "ünder_score", "x.markdown", "CHAPTER.MD", "a__b", "99_", "🌊_wave", "  spaced  ", "ß_test", "MiXeD_Case"]
    .map((name) => ({ name, human: mf.humanizeName(name) }));
  const paths = ["a/b.md", "a/.obsidian/x.md", "a/_archiv/x.md", "a/b.md~", "a/b.json", "B.MARKDOWN", ".hidden.md", "x/y/z.Md", "_x.md", "a/b.mdx"]
    .map((path) => ({ path, importable: mf.isImportableMarkdownPath(path) }));
  const suggest = ["Manuscript", "my-drafts", "Kapitel 3", "TEXTE", "World", "notes", "bookends", "Roman", "Characters", "chapter"]
    .map((name) => ({ name, role: mf.suggestRole(name) }));
  const folderSets = [
    [f("02_WORLD/a.md", ""), f("12_MANUSKRIPT/b.md", ""), f("13_ENTWURF/c.md", ""), f("README.md", "")],
    [f("MANUSCRIPT/draft_v1/a.md", ""), f("MANUSCRIPT/draft_v2/a.md", ""), f("MANUSCRIPT/draft_v10_master/a.md", ""), f("WORLD/x/a.md", ""), f("WORLD/x/b.md", ""), f("WORLD/y/c.md", "")],
    [f("Book/ch2.md", ""), f("Book/ch10.md", ""), f("Book/ch1.md", ""), f("Book/intro.md", ""), f("notes.md", ""), f(".git/x.md", ""), f("Book/_old/y.md", ""), f("a.txt", "")],
    [f("Draft/a/b/c.md", ""), f("Draft/a/d.md", ""), f("Draft/e/f.md", ""), f("Text 2/x.md", ""), f("Text 10/x.md", "")],
    []
  ].map((files) => ({ files, folders: mf.listImportFolders(files) }));
  const roleCases = [["MS/new/a.md", { MS: "manuscript", "MS/old": "skip", "(loose files)": "wiki" }], ["MS/old/a.md", { MS: "manuscript", "MS/old": "skip" }], ["MS/old/deeper/a.md", { MS: "manuscript", "MS/old": "skip" }], ["README.md", { "(loose files)": "wiki" }], ["README.md", {}], ["OTHER/a.md", { MS: "wiki" }]]
    .map(([path, roles]) => ({ path, roles, role: mf.roleOf(path as string, roles as Record<string, "wiki">) }));
  const estimateFiles = [f("A/a.md", "x".repeat(1000)), f("B/b.md", "y🌊".repeat(50)), f("A/_old/c.md", "z".repeat(99)), f("A/d.json", "q".repeat(99)), f("top.md", "abc")];
  const estimates = [{ A: "wiki", B: "skip" }, { A: "wiki", B: "wiki", "(loose files)": "manuscript" }, {}]
    .map((roles) => ({ roles, chars: mf.estimateStoredChars(estimateFiles, roles as Record<string, "wiki">) }));
  const sets: Array<{ name: string; files: Array<{ path: string; text: string }>; roles: Record<string, string>; modes: string[]; projectName?: string }> = [
    {
      name: "prosecraft-test",
      files: [
        f("12_MS/v1/02_b.md", "---\ntitle: Second\nposition: 2\n---\n# Second\n\nBeta text [[CHR_a]]."),
        f("12_MS/v1/01_a.md", "---\ntitle: First\nposition: 1\n---\n# First\n\nAlpha text."),
        f("12_MS/v2/x.md", "# Other draft\n\nOther."),
        f("03_CHARS/CHR_a.md", "---\ntitle: Anna\naliases:\n  - A\n---\nAnna is [[nobody|someone]] and [[missing]]."),
        f("03_CHARS/sub/CHR_b.md", "No heading here."),
        f("03_CHARS/_old/hidden.md", "hidden"),
        f("notes.json", "{}")
      ],
      roles: { "12_MS": "manuscript", "03_CHARS": "wiki" },
      modes: ["folders", "files"],
      projectName: "My Book"
    },
    {
      name: "positions-and-links",
      files: [
        f("Book/c.md", "---\nposition: 1e1\n---\nTen [[a#Heading]] and ![[img.png]] and [[A|alias|extra]] and [[ b ]]."),
        f("Book/a.md", "---\nposition: 0x2\n---\n# A\n\nTwo **bold** <span style=\"x\">s</span><font>f</font><b onclick=\"y\">ok</b>"),
        f("Book/b.md", "---\nposition:  3 \n---\n## Not a title\n\nThree $x^2$ and [^n]\n\n[^n]: A note."),
        f("Book/d.md", "---\nposition: x\n---\nNo number so everything sorts by path"),
        f("Wiki/Deep/Deeper/Deepest/page.md", "# page\n\n- list\n- items"),
        f("Wiki/A very long folder name that goes on and on past sixty characters for sure/p.md", ""),
        f("Wiki/🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊🌊/p.md", "x"),
        f("loose.md", "# Loose\n\n```mermaid\ngraph TD; A-->B;\n```")
      ],
      roles: { Book: "manuscript", Wiki: "wiki", "(loose files)": "wiki" },
      modes: ["folders", "files"],
      projectName: "  "
    },
    {
      name: "all-positioned-ties-and-natural-order",
      files: [
        f("Ch/s10.md", "---\nposition: 1\n---\nten"),
        f("Ch/s2.md", "---\nposition: 1\n---\ntwo"),
        f("Ch/s1.md", "---\nposition: -1.5\n---\none"),
        f("Ch 10/a.md", "x"),
        f("Ch 2/a.md", "y"),
        f("Ch 2/sub/a.md", "z")
      ],
      roles: { "Ch": "manuscript", "Ch 10": "manuscript", "Ch 2": "manuscript", "Ch 2/sub": "wiki" },
      modes: ["folders", "files"],
      projectName: "x".repeat(150)
    },
    {
      name: "wiki-only-and-empty",
      files: [f("W/a.md", "---\ntitle: \"\"\n---\n# Heading Title\n\nbody"), f("W/b.md", "# Same\n# Same\n"), f("W/c.md", "   # Spaced heading ###   \nrest"), f("W/d.md", "")],
      roles: { W: "wiki" },
      modes: ["folders"]
    },
    { name: "nothing", files: [f("a.txt", "x")], roles: {}, modes: ["folders"] },
    {
      name: "loose-manuscript",
      files: [f("one.md", "# One\n\nfirst"), f("two.md", "second"), f("Notes/n.md", "[[one]] [[TWO]] [[three]]")],
      roles: { "(loose files)": "manuscript", Notes: "wiki" },
      modes: ["folders", "files"]
    }
  ];
  const builds = [];
  for (const set of sets) {
    for (const mode of set.modes) {
      let n = 0;
      const createId = () => `id-${++n}`;
      const result = mf.buildMarkdownProject(set.files, { roles: set.roles as Record<string, "wiki">, chapterMode: mode as "folders" }, { createId, name: set.projectName });
      builds.push({ name: set.name, mode, files: set.files, roles: set.roles, projectName: set.projectName ?? null, project: result.project, report: result.report });
    }
  }
  write("markdown-folder.json", { frontmatter, names, paths, suggest, folderSets, roleCases, estimates: { files: estimateFiles, cases: estimates }, builds });
});

it.skipIf(!OUT)("writes CSL normalization fixtures", async () => {
  const { normalizeCslItemsDetailed, sanitizeCitationId } = await import("$lib/citations/csl");
  const big = (n: number) => "é".repeat(n);
  const inputs: unknown[] = [
    [{ id: "smith2020", type: "book", title: "  The   Long\tRoad\n ", author: [{ family: "Smith", given: "Ann" }], issued: { "date-parts": [[2020, 5, 1]] } }],
    [{ type: "article-journal", title: "No id here", author: [{ family: "Ångström", given: "A." }], issued: { "date-parts": [["2019"]] }, "container-title": "Journal", volume: 12, issue: 3.5, page: "1-10", DOI: "10.1/x", URL: "https://example.com/a b" }],
    [{ type: "book", title: "Same" }, { type: "book", title: "Same" }, { id: "dup", type: "book", title: "A" }, { id: "dup", type: "book", title: "B" }, { id: "dup", type: "book", title: "C" }],
    [{ id: "x", type: "BOOK", title: "upper type" }, { id: "y", type: "9book", title: "bad type" }, { id: "z", type: "book" }, "not an object", null, [1], { type: "webpage", URL: "javascript:alert(1)" }, { type: "webpage", URL: "ftp://files.example.org/a" }],
    [{ id: 42, type: "chapter", editor: [{ literal: "The Committee" }, { family: "" }, {}, { given: "Only" }], issued: { literal: "Spring 1999", season: 2, circa: true } }],
    [{ id: "  we!rd id // with spaces--and--dashes.. ", type: "book", title: "x" }, { id: "-./", type: "book", title: "Fallback after empty sanitized id" }],
    [{ type: "thesis", "abstract": "Line one\r\nLine two\u0001", title: "T", issued: { "date-parts": [[2001, "Jan", 1, 9], [2002], [2003]], raw: "2001" } }],
    [{ type: "book", title: big(2100), publisher: big(1200), "container-title": "C\u0000ontrol\u0007chars", citeKey: "key", provider: "zotero", language: "en", ISBN: "978", edition: 2, "publisher-place": "Oslo" }],
    [{ type: "report", issued: { "date-parts": [[1.5, 2]], season: "Summer" } }, { type: "report", issued: { "date-parts": "bad" } }, { type: "report", author: "nope", title: "Anon" }],
    "not an array",
    [],
    [{ id: "a".repeat(200), type: "book", title: "Long id" }, { id: "a".repeat(200), type: "book", title: "Long id again" }],
    [{ type: "book", title: "🌊 Waves and more", author: [{ family: "Ōe" }] }, { type: "book", title: "   " }, { type: "book", DOI: "10.2/y" }]
  ];
  const cases = inputs.map((input) => ({ input, output: normalizeCslItemsDetailed(input) }));
  const ids = ["  Smith 2020!!", "a..b", "-x-", "日本", "a\u0001b", "x".repeat(140), "./weird/.", "keep:this/one-1"].map((raw) => ({ raw, id: sanitizeCitationId(raw) }));
  const many = Array.from({ length: 5003 }, (_, i) => ({ id: `r${i}`, type: "book", title: `T${i}` }));
  const capped = normalizeCslItemsDetailed(many);
  write("csl.json", { cases, ids, capped: { count: capped.items.length, last: capped.items[capped.items.length - 1], warnings: capped.warnings } });
});

it.skipIf(!OUT)("writes open sync folder fixtures", async () => {
  const { OpenFolderSyncProvider } = await import("$lib/storage/sync/open-provider");
  const { readOpenProjects, normalizeDocument } = await import("$lib/storage/sync/open-layout");
  const NOW = 1_763_500_000_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const first = createStoredProject(richProject(), "device-a", 1_763_000_000_000);
    const draft = createStoredProject(storyProject(), "device-a", 1_763_000_000_000);
    const edited = { ...draft.project, documents: draft.project.documents.filter((d) => d.id !== "d2") };
    const second = stampProject(draft, edited, "device-b", 1_763_000_100_000);
    const projects = [first, second];

    const fs = new MemoryFileSystem();
    const provider = new OpenFolderSyncProvider(fs);
    const connection = await provider.connect("");
    const normalized = provider.normalize(projects);
    await provider.push(normalized);
    const files = await dump(fs);
    const read = await readOpenProjects(fs, NOW);

    const docPath = (project: string, id: string) => `projects/${safeName(project)}/documents/${safeName(id)}.md`;
    const chapterPath = `projects/${safeName("project-1")}/chapters/chapter-1.json`;
    const scenarios: Array<[string, (f: Record<string, string>) => void]> = [
      ["bodyEdited", (f) => { f[docPath("project-1", "doc-1")] = f[docPath("project-1", "doc-1")].replace("It was", "It was *very*"); }],
      ["titleEdited", (f) => { f[docPath("project-1", "doc-1")] = f[docPath("project-1", "doc-1")].replace('title: "Opening Scene"', 'title: "Renamed outside"'); }],
      ["hashRemoved", (f) => { f[docPath("project-1", "doc-3")] = f[docPath("project-1", "doc-3")].replace(/^hash: .*\n/m, ""); }],
      ["newFile", (f) => { f[`projects/${safeName("project-1")}/documents/new.md`] = "---\nid: \"x-new\"\ntitle: \"New\"\n# a comment line\nchapterId: \"chapter-1\"\ntrashed: true\nlabelId: \"label-1\"\nformat: \"poem\"\ncharacter: {\"role\":\"Cameo\"}\nunknown: 12.5\nflag: false\nnothing: null\nbare: plain words\n---\n\nHello [^n] and $x$.\r\n\r\n[^n]: A *new* note.\n\n\n"; }],
      ["missingDocument", (f) => { delete f[docPath("project-1", "doc-2")]; }],
      ["duplicateId", (f) => { f[`projects/${safeName("project-1")}/documents/copy.md`] = f[docPath("project-1", "doc-1")]; }],
      ["invalidFrontmatter", (f) => { f[`projects/${safeName("project-1")}/documents/bad.md`] = "no frontmatter at all"; }],
      ["invalidKey", (f) => { f[`projects/${safeName("project-1")}/documents/bad.md`] = "---\nid: \"z\"\nbad key: 1\n---\n"; }],
      ["missingId", (f) => { f[`projects/${safeName("project-1")}/documents/bad.md`] = "---\ntitle: \"No id\"\n---\nbody"; }],
      ["chapterEdited", (f) => { f[chapterPath] = f[chapterPath].replace('"Chapter One"', '"Chapter One, edited"'); }],
      ["chapterCorrupt", (f) => { f[chapterPath] = "{ not json"; }],
      ["rowsEdited", (f) => { const p = `projects/${safeName("project-1")}/storyboard/rows.json`; f[p] = f[p].replace('"Act I"', '"Act One"'); }],
      ["projectEdited", (f) => { const p = `projects/${safeName("project-1")}/project.json`; f[p] = f[p].replace('"A. Writer"', '"Another Writer"'); }],
      ["projectMissing", (f) => { delete f[`projects/${safeName("project-1")}/project.json`]; }]
    ];
    const outside = [];
    for (const [name, mutate] of scenarios) {
      const copy = { ...files };
      mutate(copy);
      const scenarioFs = new MemoryFileSystem();
      for (const [path, content] of Object.entries(copy)) await scenarioFs.writeText(path, content);
      try {
        outside.push({ name, files: copy, projects: await readOpenProjects(scenarioFs, NOW) });
      } catch (error) {
        outside.push({ name, files: copy, error: (error as Error).message });
      }
    }

    const refusals = [];
    for (const [name, setup] of [
      ["vault", { "vault.json": "{}" }],
      ["bundle", { "prosecraft-sync.prosecraft": "{}" }],
      ["encryptedProject", { "projects/p/project.enc": "x" }],
      ["openProject", { "projects/p/project.json": "{}" }],
      ["badMarker", { "prosecraft-folder.json": "{\"format\":\"other\"}" }],
      ["unreadableMarker", { "prosecraft-folder.json": "not json" }]
    ] as const) {
      const refusalFs = new MemoryFileSystem();
      for (const [path, content] of Object.entries(setup)) await refusalFs.writeText(path, content);
      try {
        await new OpenFolderSyncProvider(refusalFs).connect("");
        refusals.push({ name, files: setup, error: null, after: await dump(refusalFs) });
      } catch (error) {
        refusals.push({ name, files: setup, error: (error as Error).message });
      }
    }

    // A whole sync: an edit outside ProseCraft and one inside since the last sync.
    const syncFiles = { ...files };
    syncFiles[docPath("project-1", "doc-1")] = syncFiles[docPath("project-1", "doc-1")].replace("It was", "Outside, it was");
    const syncFs = new MemoryFileSystem();
    for (const [path, content] of Object.entries(syncFiles)) await syncFs.writeText(path, content);
    const lastSynced = Object.fromEntries(normalized.map((p) => [p.id, { updatedAt: p.updatedAt, revision: p.revision }]));
    const localEdit = stampProject(normalized[1], { ...normalized[1].project, name: "Second, renamed" }, "device-a", NOW - 10);
    const result = await new OpenFolderSyncProvider(syncFs).sync("", [normalized[0], localEdit], lastSynced, NOW, "device-a");
    const sync = { files: syncFiles, local: [normalized[0], localEdit], lastSynced, result, after: await dump(syncFs) };

    const documents = [...richProject().documents, ...storyProject().documents, { id: "n", title: "", content: "<p>x</p>", format: "weird" }, { id: "e", title: "", content: "", markdownSource: "\r\nLine\r\n\r\n\n" }]
      .map((document) => ({ document, normalized: normalizeDocument(document as never) }));

    write("sync-open.json", { now: NOW, projects, connection, normalized, files, read, outside, refusals, sync, documents });
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
});

it.skipIf(!OUT)("writes citation formatting fixtures", async () => {
  const { formatCitation, formatBibliography, computeDisambiguation } = await import("$lib/citations/format");
  const { STYLES } = await import("$lib/citations/styles");
  const a = (family: string, given?: string, extra: Record<string, string> = {}) => ({ family, ...(given ? { given } : {}), ...extra });
  const library = [
    { id: "smith2020", type: "book", title: "The Lighthouse Keeper", author: [a("Smith", "Jo Ann")], issued: { "date-parts": [[2020]] }, publisher: "Harbour Press", "publisher-place": "Bristol", edition: "2" },
    { id: "smith2020b", type: "book", title: "Another Lighthouse", author: [a("Smith", "Jo Ann")], issued: { "date-parts": [[2020]] }, publisher: "Harbour Press" },
    { id: "doe-roe", type: "article-journal", title: "Tides and the moon", author: [a("Doe", "Jane"), a("Roe", "Richard")], issued: { "date-parts": [[2019, 4]] }, "container-title": "Journal of Sea Studies", volume: "12", issue: "3", page: "101-120", DOI: "https://doi.org/10.1000/xyz123" },
    { id: "three", type: "article-journal", title: "Three authors", author: [a("Alpha", "A."), a("Beta", "B. C."), a("Gamma", "G.")], issued: { "date-parts": [[2018]] }, "container-title": "Letters", volume: "5", page: "7" },
    { id: "many", type: "article-journal", title: "Many hands make light work", author: Array.from({ length: 23 }, (_, i) => a(`Author${i + 1}`, `Given ${String.fromCharCode(65 + (i % 26))}.`)), issued: { "date-parts": [[2021, 1, 15]] }, "container-title": "Big Science", volume: "1", issue: "1", page: "1-99", URL: "https://example.org/many" },
    { id: "vonhumboldt", type: "book", title: "Kosmos", author: [a("Humboldt", "Alexander", { "non-dropping-particle": "von" })], issued: { "date-parts": [[1845]] }, publisher: "Cotta", "publisher-place": "Stuttgart" },
    { id: "departicle", type: "book", title: "Particles", author: [a("Gaulle", "Charles", { "dropping-particle": "de", suffix: "Jr." })], issued: { "date-parts": [[1954]] } },
    { id: "corp", type: "report", title: "Annual report on lighthouses", author: [{ literal: "World Lighthouse Organization" }], issued: { "date-parts": [[2022]] }, publisher: "WLO", URL: "https://wlo.example.org/report" },
    { id: "edited", type: "book", title: "Collected essays", editor: [a("Editor", "Ed"), a("Second", "Sam")], issued: { "date-parts": [[2015]] }, publisher: "Uni Press", "publisher-place": "Cambridge" },
    { id: "chapter1", type: "chapter", title: "On beams of light", author: [a("Chapman", "Chris")], editor: [a("Editor", "Ed")], "container-title": "Collected essays", issued: { "date-parts": [[2015]] }, page: "33-58", publisher: "Uni Press", "publisher-place": "Cambridge" },
    { id: "web", type: "webpage", title: "How lighthouses work", author: [a("Webber", "Wendy")], issued: { "date-parts": [[2023, 6, 1]] }, "container-title": "Light Blog", URL: "https://light.example.org/how" },
    { id: "nodate", type: "book", title: "Undated wisdom", author: [a("Nobody", "N.")], publisher: "Somewhere" },
    { id: "noauthor", type: "book", title: "Anonymous classic", issued: { "date-parts": [[1900]] } },
    { id: "thesis", type: "thesis", title: "A thesis on fog", author: [a("Student", "Sue")], issued: { "date-parts": [[2017]] }, publisher: "Harbour University", genre: "PhD thesis" },
    { id: "conf", type: "paper-conference", title: "Fog horns revisited", author: [a("Horn", "Harry"), a("Bell", "Belle")], issued: { "date-parts": [[2016]] }, "container-title": "Proceedings of Coastal Sound", page: "12-19", publisher: "CS Society", "publisher-place": "Oslo" },
    { id: "umlaut", type: "book", title: "Über Leuchttürme", author: [a("Müller", "Jürgen")], issued: { "date-parts": [[2011]] }, publisher: "Verlag Meer", "publisher-place": "Kiel", language: "de" },
    { id: "ostrom", type: "book", title: "Ångström and light", author: [a("Ångström", "Anders")], issued: { "date-parts": [[1868]] } },
    { id: "two-same", type: "article-journal", title: "Same pair one", author: [a("Doe", "Jane"), a("Roe", "Richard")], issued: { "date-parts": [[2019]] }, "container-title": "Journal of Sea Studies", volume: "13" },
    { id: "edition-ord", type: "book", title: "Third edition", author: [a("Ed", "Ition")], issued: { "date-parts": [[2005]] }, edition: "3", publisher: "Pub" },
    { id: "edition-text", type: "book", title: "Revised", author: [a("Rev", "Ised")], issued: { "date-parts": [[2006]] }, edition: "Revised edition", publisher: "Pub" },
    { id: "doi-only", type: "article-journal", title: "DOI bare", author: [a("Doi", "D.")], issued: { "date-parts": [[2024]] }, "container-title": "J", DOI: "10.5555/abc" },
    { id: "seven", type: "article-journal", title: "Seven authors", author: Array.from({ length: 7 }, (_, i) => a(`Seven${i}`, "S.")), issued: { "date-parts": [[2012]] }, "container-title": "Septet", volume: "7", page: "77" }
  ];
  const variants = [
    {},
    { locator: "12", label: "page" },
    { locator: "12-15", label: "page" },
    { locator: "3", label: "chapter" },
    { locator: "2.1", label: "section" },
    { prefix: "see", suffix: "for details" },
    { suppressAuthor: true },
    { suppressAuthor: true, locator: "9", label: "page" }
  ];
  const styles = [];
  for (const style of STYLES) {
    for (const locale of ["en", "de"] as const) {
      const yearSuffixes = computeDisambiguation(style.id, library as never, locale);
      const bibliography = formatBibliography(style.id, library as never, locale);
      const singles = library.map((item, i) => variants.map((v) => formatCitation(style.id, [{ item, ...v } as never], { locale, index: i + 1, yearSuffixes })));
      const clusters = [
        formatCitation(style.id, [{ item: library[0] }, { item: library[2], locator: "105" }, { item: library[1] }] as never, { locale, index: 4, yearSuffixes }),
        formatCitation(style.id, [{ item: library[2] }, { item: library[17] }] as never, { locale, indices: { "doe-roe": 3, "two-same": 9 }, library: library as never }),
        formatCitation(style.id, [{ item: library[0], prefix: "cf." }, { item: library[4], suppressAuthor: true }] as never, { locale, library: library as never }),
        formatCitation(style.id, [] as never, { locale })
      ];
      styles.push({ style: style.id, locale, yearSuffixes, bibliography, singles, clusters });
    }
  }
  write("citations-format.json", { library, variants, styles });
});

/** ProseCraft's citation styles and locale terms, for prosecraft-rs to embed as data. */
it.skipIf(!OUT)("writes citation style data", async () => {
  const { STYLES, STYLE_TEMPLATES, LOCALE_TERMS } = await import("$lib/citations/styles");
  write("citation-styles.json", { styles: STYLES, templates: STYLE_TEMPLATES, terms: LOCALE_TERMS });
});

it.skipIf(!OUT)("writes citation export fixtures", async () => {
  const { exportMarkdown: toMarkdown } = await import("$lib/publish/markdown");
  const cite = (items: Array<Record<string, unknown>>) =>
    `<span class="cite-ref" data-cites="${JSON.stringify(items).replace(/"/g, "&quot;")}" contenteditable="false"></span>`;
  const base = bookProject();
  const citations = [
    { id: "smith2020", type: "book", title: "Lighthouses", author: [{ family: "Smith", given: "Jo" }], issued: { "date-parts": [[2020]] }, publisher: "Harbour Press" },
    { id: "doe-roe", type: "article-journal", title: "Tides and the moon", author: [{ family: "Doe", given: "Jane" }, { family: "Roe", given: "Richard" }], issued: { "date-parts": [[2019]] }, "container-title": "Journal of Sea Studies", volume: "12", issue: "3", page: "101-120", DOI: "10.1000/xyz" },
    { id: "keyed-item", citeKey: "keyed", type: "chapter", title: "On beams", author: [{ family: "Chapman", given: "Chris" }], editor: [{ family: "Editor", given: "Ed" }], "container-title": "Essays", issued: { "date-parts": [[2015]] }, page: "33-58" },
    { id: "uncited", type: "book", title: "Never cited", author: [{ family: "Nobody" }], issued: { "date-parts": [[2000]] } },
    { id: "smith2020b", type: "webpage", title: "A blog post", author: [{ family: "Smith", given: "Jo" }], issued: { "date-parts": [[2020]] }, URL: "https://example.org/post" }
  ];
  const project = {
    ...base,
    citations,
    documents: base.documents.map((doc) => {
      if (doc.id === "doc-4") {
        return {
          ...doc,
          content: `<p>The sea was calm ${cite([{ id: "doe-roe", locator: "12", label: "page" }])}.<sup class="footnote-ref" data-footnote-id="a" contenteditable="false"></sup></p><ul><li>bread ${cite([{ id: "keyed", prefix: "see" }, { id: "smith2020b" }])}</li><li>salt</li></ul><p>Then <strong>nothing</strong> ${cite([{ id: "ghost" }])} ${cite([{ id: "smith2020", suppressAuthor: true }, { id: "ghost2" }])}.<sup class="footnote-ref" data-footnote-id="b" contenteditable="false"></sup></p>`,
          footnotes: [{ id: "a", html: `Calm, mostly ${cite([{ id: "doe-roe", locator: "3", label: "chapter" }])}.` }, { id: "b", html: "Truly <em>nothing</em>." }]
        };
      }
      if (doc.id === "doc-5") return { ...doc, content: `<p>Light ${cite([{ id: "smith2020" }])}.</p><p>More light.</p>` };
      return doc;
    })
  } as ProjectData;
  const variants: Record<string, Record<string, unknown>> = {
    apa: { citationStyle: "apa7" },
    notes: { citationStyle: "chicago-notes" },
    ieee: { citationStyle: "ieee", footnotesRestartPerChapter: true },
    mlaDe: { citationStyle: "mla9", citationLocale: "de" },
    noBibliography: { citationStyle: "harvard", includeBibliography: false },
    din: { citationStyle: "din1505", citationLocale: "de", backMatter: [{ id: "b1", title: "Acknowledgments", body: "Thank you." }] }
  };
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(variants)) {
    const options = normalizePublishOptions(raw);
    const live = project.chapters.filter((c) => !c.trashed);
    const book = compileBook({
      title: project.name, author: project.author, subtitle: options.subtitle, copyright: options.copyright,
      dedication: options.dedication, frontMatter: options.frontMatter, backMatter: options.backMatter,
      chapters: live, documents: project.documents, footnotesRestartPerChapter: options.footnotesRestartPerChapter,
      citations: project.citations, citationStyle: options.citationStyle, citationLocale: options.citationLocale,
      includeBibliography: options.includeBibliography
    });
    const epub = await exportEpub(book, options);
    const files = unzipSync(new Uint8Array(await epub.blob.arrayBuffer()));
    out[name] = {
      options: raw,
      text: await exportText(book, options).blob.text(),
      markdown: await toMarkdown(book, options).blob.text(),
      html: await (await exportHtml(book, options)).blob.text(),
      epub: Object.entries(files).map(([entry, bytes]) => ({
        name: entry,
        text: strFromU8(bytes)
          .replace(/urn:uuid:[0-9a-f-]{36}/g, "urn:uuid:ID")
          .replace(/<meta property="dcterms:modified">[^<]*<\/meta>/, '<meta property="dcterms:modified">MODIFIED</meta>')
      }))
    };
  }
  write("export-citations.json", { project, exports: out });
});

it.skipIf(!OUT)("writes citation import and library fixtures", async () => {
  const { importCitations } = await import("$lib/citations/import");
  const { parseBibtex, decodeLatex } = await import("$lib/citations/bibtex");
  const { parseRis } = await import("$lib/citations/ris");
  const lib = await import("$lib/citations/library");
  // ProseCraft's own import test inputs, read from its test file and evaluated as written.
  const testSource = readFileSync(join(__dirname, "lib/citations/import.test.ts"), "utf8");
  const own: Record<string, string> = {};
  for (const m of testSource.matchAll(/const (\w+) = ((?:String\.raw)?`[\s\S]*?`);/g)) {
    own[m[1]] = new Function(`return ${m[2]}`)() as string;
  }
  const bib = [
    ...Object.values(own),
    "@book{a, title = {Plain}, author = {Doe, Jane and John Smith and {Lighthouse Society}}, year = {2020}, editor = {Ed, It}}",
    "@inproceedings{conf, title = \"Quoted title\", booktitle = {Proc. of {X}}, pages = {1-5}, year = 2018, month = {jul}, publisher = {P}, address = {Oslo}}",
    "@misc{web, title = {A page}, howpublished = {\\url{https://example.org}}, note = {Accessed 2024}, urldate = {2024-01-02}}",
    "@phdthesis{t, author = {Student, Sue}, title = {Fog}, school = {Harbour U}, year = {2017}}",
    "@techreport{r, author = {Org}, title = {Report}, institution = {Inst}, number = {7}, year = {2001}}",
    "@incollection{c, author = {Chap, C.}, title = {Ch}, booktitle = {Book}, editor = {E, E. and F, F.}, pages = {3--9}, year = {1999}, publisher = {Pub}}",
    "@article{x, title = {Unbalanced {brace}, year = {2000}}\n@article{y, title = {Next}, year = {2001}}",
    "@preamble{\"\\newcommand{\\noop}[1]{}\"}\n@string{a = {A}}\n@article{z, title = a # { and B}, journal = {J}, year = {2002}, volume = {3}, number = {4}}",
    "@article{, title = {No key}}",
    "@article{dup, title = {First}}\n@article{dup, title = {Second}}",
    "@online{o, author = {Online, O.}, title = {Online thing}, url = {https://o.example}, date = {2023-05-06}}",
    "no entries here",
    "@book{acc, title = {\\'Ecole, na\\\"ive, {\\ss}, \\o, \\aa, \\c{c}, \\~n, ---, --, ``q''}, author = {{\\'E}mile Zola}}",
    // Words that are Object.prototype members (jennraeross/ProseCraft#47).
    "@constructor{c1, title = {Odd type}, year = 2020}\n@article{c2, title = constructor # { and } # __proto__, year = 2020, month = constructor}\n@article{c3, title = {T}, year = 2021, month = __proto__}"
  ];
  const ris = [
    ...Object.values(own).filter((t) => /^\s*TY\s/m.test(t)),
    "TY  - JOUR\nAU  - Doe, Jane\nAU  - Roe, R.\nTI  - Tides\nJO  - Journal\nVL  - 12\nIS  - 3\nSP  - 101\nEP  - 120\nPY  - 2019/04/01/\nDO  - 10.1/x\nUR  - https://x.y\nER  - \n",
    "TY  - BOOK\nA1  - Smith, Jo\nED  - Editor, Ed\nT1  - Book title\nPB  - Press\nCY  - Bristol\nDA  - 2020///\nSN  - 978\nER  -\nTY  - CHAP\nAU  - Chap, C\nT1  - Chapter\nT2  - Container\nSP  - 3\nY1  - 1999\nER  - ",
    "TY  - THES\nAU  - Student\nTI  - Thesis\nPB  - University\nPY  - 2017\nM3  - PhD\nER  - \nTY  - RPRT\nTI  - No end",
    "TY  - ELEC\nTI  - Page\nUR  - https://example.org\nY2  - 2024/01/02\nER  - ",
    "garbage\nTI  - before TY\nTY  - GEN\nTI  - generic\nER  - "
  ];
  const json = [
    own.CSL_JSON_FIXTURE ?? "",
    JSON.stringify({ items: [{ id: "a", type: "book", title: "T" }] }),
    JSON.stringify({ id: "single", type: "book", title: "One" }),
    JSON.stringify({ nope: true }),
    "[{\"id\": \"broken\", ",
    "﻿[]"
  ];
  const imports = [
    ...bib.map((text, i) => ({ text, filename: i % 3 === 0 ? `lib${i}.bib` : "" })),
    ...ris.map((text, i) => ({ text, filename: i % 2 === 0 ? `lib${i}.ris` : "x.txt" })),
    ...json.map((text, i) => ({ text, filename: i % 2 === 0 ? "refs.json" : "" })),
    { text: "   \n", filename: "empty.bib" },
    { text: "plain words", filename: "" },
    { text: "@article{q, title={T}}", filename: "refs.CSL" },
    // Found by the differential corpus (src/citation-compare.gen.test.ts): `/^[a-z0-9_.-]+$/i`
    // rejects the long s and accepts the Kelvin sign (lower-cased to "k"), a JSON escape of a
    // character past U+00FF, and lone surrogates written as JSON escapes.
    { text: "@string{\u017f = {x}}\n@book{k, \u017f = {y}, \u212aey = {z}, title = \u017f}", filename: "refs.bib" },
    { text: "[\"\\\u0130\"]", filename: "refs.json" },
    { text: "[{\"type\":\"book\",\"title\":\"cut \\ud83d\"},{\"type\":\"book\",\"title\":\"\\ude00 x\",\"container-title\":\"a\\ud83d\\ude00\"}]", filename: "refs.json" }
  ].map((c) => ({ ...c, result: importCitations(c.text, c.filename) }));
  const bibtex = bib.map((text) => ({ text, result: parseBibtex(text) }));
  const risParsed = ris.map((text) => ({ text, result: parseRis(text) }));
  const latex = ["{\\\"o}", "\\'e", "\\v{C}", "{\\ss}", "--", "---", "1--5", "\\&", "\\%", "$x^2$", "{\\em it}", "\\textit{t}", "~", "\\\\", "\\url{u}", "a\\,b"]
    .flatMap((input) => [{ input, pages: false, out: decodeLatex(input) }, { input, pages: true, out: decodeLatex(input, { isPages: true }) }]);
  const names = [[], [{ family: "Doe", given: "Jane" }], [{ family: "Doe" }, { literal: "Org" }], [{ family: "A" }, { family: "B" }, { family: "C" }], [{ given: "Only" }]]
    .map((n) => ({ names: n, list: lib.formatAuthorList(n as never) }));
  const parsedNames = ["Doe, Jane; Roe, Richard", "Jane Doe and Richard Roe", "  ", "Plato", "Doe, J.; ; Smith", "van der Berg, Anna"]
    .map((raw) => ({ raw, names: lib.parseAuthorList(raw) ?? null }));
  const items = (await import("$lib/citations/csl")).normalizeCslItems([
    { id: "mueller2020", citeKey: "mueller2020", type: "book", title: "Ü", author: [{ family: "Müller" }], issued: { "date-parts": [[2020]] } },
    { id: "x", type: "article-journal", title: "Y", issued: { literal: "Spring 1999" } },
    { id: "z", type: "webpage", title: "Z", editor: [{ family: "Ed" }], issued: { raw: "2001-02" } },
    { id: "n", type: "thesis", title: "N" }
  ]);
  const library = {
    items,
    years: items.map((item) => lib.itemYearText(item)),
    contributors: items.map((item) => lib.formatItemContributors(item)),
    types: ["book", "article-journal", "chapter", "webpage", "thesis", "report", "BOOK", "weird"].map((t) => ({ type: t, label: lib.sourceTypeLabel(t), manual: lib.cslTypeToManualKind(t) })),
    manual: ["book", "article", "chapter", "website"].map((k) => ({ kind: k, type: lib.manualKindToCslType(k as never) })),
    keys: [
      [{ author: [{ family: "Müller" }], year: "2020" }, items, undefined],
      [{ author: [{ family: "Müller" }], year: "2020" }, items, "mueller2020"],
      [{ editor: [{ literal: "Ørsted Society" }], year: "c. 1850" }, items, undefined],
      [{ title: "  The lighthouse keeper", year: "" }, items, undefined],
      [{}, [], undefined],
      [{ author: [{ family: "Zoë" }], year: "2021" }, [{ id: "zoe2021", type: "book" }, { id: "x", citeKey: "zoe2021-2", type: "book" }], undefined]
    ].map(([params, existing, exclude]) => ({ params, existing, exclude: exclude ?? null, key: lib.generateCitationKey(params as never, existing as never, exclude as never) })),
    merges: [
      [items, [{ id: "x", type: "book", title: "New x" }, { id: "fresh", type: "book", title: "Fresh" }, { id: "x", type: "book", title: "Another x" }]],
      [[], items]
    ].map(([existing, imported]) => ({ existing, imported, result: lib.mergeImportedCitations(existing as never, imported as never) })),
    counts: (() => {
      const cite = (ids: string[]) => `<span class="cite-ref" data-cites="${JSON.stringify(ids.map((id) => ({ id }))).replace(/"/g, "&quot;")}"></span>`;
      const documents = [
        { id: "d1", title: "", content: `<p>${cite(["mueller2020"])}</p>` },
        { id: "d2", title: "", content: "<p>none</p>", footnotes: [{ id: "f", html: `n ${cite(["x", "z"])}` }] },
        { id: "d3", title: "", content: `<p>${cite(["mueller2020", "x"])}</p>` }
      ];
      return items.map((item) => ({ item, documents, count: lib.countSourceCitations(item, documents as never) }));
    })(),
    queries: ["", "müller", "MULLER", "2020", "lighthouse", "ed", "z", "spring"].map((query) => ({ query, matches: items.map((item) => lib.matchesLibraryQuery(item, query)) }))
  };
  write("citations-import.json", { imports, bibtex, ris: risParsed, latex, names, parsedNames, library });
});

it.skipIf(!OUT)("writes editor citation label fixtures", async () => {
  const { renderCitationLabels, citeMarkerHtml } = await import("$lib/citations/cite-marker");
  const { STYLES } = await import("$lib/citations/styles");
  const { normalizeCslItems } = await import("$lib/citations/csl");
  const a = (family: string, given?: string) => ({ family, ...(given ? { given } : {}) });
  const library = normalizeCslItems([
    { id: "smith2020", citeKey: "smithLH", type: "book", title: "The Lighthouse Keeper", author: [a("Smith", "Jo Ann")], issued: { "date-parts": [[2020]] }, publisher: "Harbour Press" },
    { id: "smith2020b", type: "book", title: "Another Lighthouse", author: [a("Smith", "Jo Ann")], issued: { "date-parts": [[2020]] } },
    { id: "doe-roe", type: "article-journal", title: "Tides", author: [a("Doe", "Jane"), a("Roe", "Richard")], issued: { "date-parts": [[2019]] }, "container-title": "Sea", page: "101-120" },
    { id: "corp", type: "report", title: "Annual report", author: [{ literal: "World Lighthouse Organization" }], issued: { "date-parts": [[2022]] } },
    { id: "nodate", type: "book", title: "Undated", author: [a("Nobody", "N.")] },
    // Ids that are Object.prototype members (jennraeross/ProseCraft#47).
    { id: "constructor", type: "book", title: "Built", author: [a("Builder", "B.")], issued: { "date-parts": [[2018]] } },
    { id: "toString", type: "book", title: "Strung", author: [a("Stringer", "S.")], issued: { "date-parts": [[2017]] } }
  ]);
  const marker = (cites: unknown) => `<span class="cite-ref" data-cites="${JSON.stringify(cites).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" contenteditable="false"></span>`;
  const markers = [
    citeMarkerHtml([{ id: "doe-roe" }]),
    citeMarkerHtml([{ id: "smithLH", locator: "42", label: "page" }]),
    citeMarkerHtml([{ id: "smith2020b", prefix: "see ", suffix: "for more" }, { id: "corp", locator: "3", label: "chapter" }]),
    citeMarkerHtml([{ id: "missing" }]),
    citeMarkerHtml([{ id: "nodate", suppressAuthor: true }, { id: "gone" }]),
    citeMarkerHtml([{ id: "doe-roe", locator: "7-9", label: "section" }]),
    marker("not an array"),
    marker([{ id: "smith2020" }, { id: "smith2020" }]),
    citeMarkerHtml([{ id: "constructor" }]),
    citeMarkerHtml([{ id: "toString" }, { id: "__proto__" }])
  ];
  const html = `<p>A ${markers.slice(0, 4).join(" b ")}.</p><p>${markers.slice(4).join(" and ")}</p>`;
  const cases = [];
  for (const style of STYLES.map((s) => s.id)) {
    for (const locale of ["en", "de"] as const) {
      const root = document.createElement("div");
      root.innerHTML = html;
      renderCitationLabels(root, library, style, locale);
      cases.push({ style, locale, labels: Array.from(root.querySelectorAll("span.cite-ref")).map((e) => e.getAttribute("data-label")) });
    }
  }
  const emptyRoot = document.createElement("div");
  emptyRoot.innerHTML = html;
  renderCitationLabels(emptyRoot, [], "apa7", "en");
  cases.push({ style: "apa7", locale: "en", empty: true, labels: Array.from(emptyRoot.querySelectorAll("span.cite-ref")).map((e) => e.getAttribute("data-label")) });
  write("citation-labels.json", { library, markers, cases });
});

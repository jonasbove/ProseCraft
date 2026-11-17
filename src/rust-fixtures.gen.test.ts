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
  "<p>Unicode: café 🌊   tab\tend</p>"
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

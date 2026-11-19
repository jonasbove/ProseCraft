/**
 * Golden fixture for the Rust port (prosecraft-rs): what ProseCraft's rich editor stores for
 * scene HTML of unusual shapes (text in no block, `<div>` wrappers, empty elements, a stray
 * end tag) once the scene is edited. It does nothing unless PROSECRAFT_FIXTURE_OUT names an
 * output folder:
 *
 *   PROSECRAFT_FIXTURE_OUT=/path/to/fixtures npx vitest run src/editor-load.gen.test.ts
 *
 * The editor is a contenteditable element: `setEditorContent` sets its `innerHTML` and adds
 * empty paragraphs around rich blocks, and every save stores `sanitizeHtml(editor.innerHTML)`.
 * jsdom can't type, so `saved` is that save before any typed change: the shape a first edit
 * keeps everywhere but at the caret.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { sanitizeHtml } from "$lib/sanitize";
import { ensureParagraphsAroundRichBlocks } from "$lib/rich/dom";

const OUT = process.env.PROSECRAFT_FIXTURE_OUT;

const IMG = '<img src="data:image/png;base64,iVBORw0KGgoAAQI=" alt="Map">';

const CASES: [string, string][] = [
  ["text in no block", "<em>a</em> b"],
  ["text after a paragraph", "<p>Upper</p><em>loud</em>"],
  ["text after headings", "<h1>One</h1><h2>Two</h2><h3>Three</h3>FourFive"],
  ["style text left as text", "<p>after</p>p{}"],
  ["a picture in no block", `${IMG}\n${IMG}\n<p></p>\n<p></p>`],
  ["a picture and a caption in no block", `<p>Before ${IMG} after.</p>\n${IMG}Caption\n<p>Kept text<a></a></p>`],
  ["a blockquote holding text", "<p>Second&nbsp;half text.</p>\n<blockquote>Quoted <b>bold</b></blockquote>"],
  ["an import's newlines", "<h3>Morning</h3>\n<p>The sea was calm.<a href=\"#fn-2\">2</a></p>\n<ul><li>bread</li><li>salt</li></ul>\n<p>Then.</p>"],
  ["empty paragraphs", "<p>a<br>b</p><p></p><p><br></p>"],
  ["an empty mark", "<p>It was <em></em>.</p>"],
  [
    "scene breaks",
    '<div class="scene-break scene-break-line" contenteditable="false">* * *</div><div class="scene-break" contenteditable="false"><b>#</b></div>'
  ],
  ["a div wrapper", "<div><p>in div</p></div><p>in section</p>"],
  ["a fourth-level heading", "<p>Before</p><h4>Fourth level</h4><p>After</p>"],
  ["paragraphs in a list item", "<ul><li><p>a</p><p>b</p></li><li>c</li></ul>"],
  ["a stray end tag after a list", `<ol><li>One.</li><li>Two.</li></ul><p>Three ${IMG}.</p><p>Four.</p>`],
  ["an eyebrow screenplay element", '<p data-sp="scene-heading">INT. ROOM</p><p>x</p><p class="eyebrow" data-sp="dialogue">y</p>'],
  ["a line separator", "<p>Unicode: café   tab\tend</p>"]
];

it.skipIf(!OUT)("writes editor load fixtures", () => {
  const cases = CASES.map(([name, html]) => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(editor);
    editor.innerHTML = html;
    ensureParagraphsAroundRichBlocks(editor);
    const saved = sanitizeHtml(editor.innerHTML);
    editor.remove();
    return { name, html, sanitized: sanitizeHtml(html), saved };
  });
  writeFileSync(join(OUT!, "editor-load.json"), `${JSON.stringify({ cases }, null, 2)}\n`);
});

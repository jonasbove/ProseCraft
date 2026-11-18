/**
 * Differential corpus for prosecraft-rs's citation importers: a large, seeded set of BibTeX,
 * RIS and CSL-JSON inputs, each with what `importCitations(text, filename)` returns here.
 * The Rust side (`crates/core/tests/citation_compare.rs` in prosecraft-rs) reads the file and
 * compares its own `import_citations` output with every expected result.
 *
 * It does nothing unless PROSECRAFT_CITATION_CORPUS names the output file:
 *
 *   PROSECRAFT_CITATION_CORPUS=/tmp/citation-corpus.json \
 *   PROSECRAFT_CITATION_SEED=20261118 PROSECRAFT_CITATION_SCALE=1 \
 *     npx vitest run src/citation-compare.gen.test.ts
 *
 * The same seed, scale and ProseCraft commit always give the same file (its sha256 is in
 * `meta.sha256`). Only the error text of `JSON.parse` depends on the Node version, which is
 * recorded in `meta.node`.
 *
 * PROSECRAFT_CITATION_REPLAY=in.json,out.json instead runs `importCitations` on the
 * `[{ text, filename }]` cases of `in.json` and writes the results to `out.json` (used to check
 * a hand-shrunk input against ProseCraft).
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { importCitations } from "$lib/citations/import";

const OUT = process.env.PROSECRAFT_CITATION_CORPUS;
const SEED = Number.parseInt(process.env.PROSECRAFT_CITATION_SEED ?? "20261118", 10);
const SCALE = Number.parseFloat(process.env.PROSECRAFT_CITATION_SCALE ?? "1");
const REPLAY = process.env.PROSECRAFT_CITATION_REPLAY;

// ---------------------------------------------------------------------------------------------
// Seeded randomness (mulberry32).

type Rng = {
  next(): number;
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  some<T>(list: readonly T[], lo: number, hi: number): T[];
};

function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick,
    some: (list, lo, hi) => Array.from({ length: int(lo, hi) }, () => pick(list))
  };
}

// ---------------------------------------------------------------------------------------------
// Shared vocabulary. `constructor` and `__proto__` never appear here: ProseCraft finds
// `Object.prototype` members for them in its lookup tables (being fixed upstream), so they get
// their own category.

const WORDS = [
  "the", "lighthouse", "keeper", "of", "a", "study", "on", "Light", "and", "Sea", "AND", "and",
  "Others", "others", "History", "theory", "Data", "Methods", "Über", "die", "Kunst", "été",
  "naïve", "Øresund", "Łódź", "İstanbul", "straße", "ſhip", "Kelvin", "日本語", "研究", "Ελληνικά",
  "Русский", "עברית", "عربي", "😀", "𝔘𝔫𝔦", "🌊wave", "x", "Z", "von", "van", "der", "de", "la",
  "Jr.", "III", "2020", "1999", "vol.", "pp.", "No.", "e.g.", "i.e.", "&", "%", "#", "$", "_"
];

const SPACES = [" ", " ", " ", "  ", "\t", "\u00a0", "\u2028", "\u2029", "\u3000", "\ufeff", "\u2009", "\n", "\r\n"];
const ASTRAL = ["😀", "𝔘", "🌊", "𠜎", "🧪"];
const ODD_CHARS = [
  "{", "}", "\"", "@", ",", "=", "#", "\\", "(", ")", "%", "~", "$", "&", "-", "\n", "\r", "\t",
  " ", "a", "Z", "0", "9", ".", "'", "`", "^", "\u00a0", "\u2028", "é", "ß", "K", "İ", "😀", "\u0000",
  "\u0007", "\u007f", "[", "]", ":", "/", "TY", "ER", "  - ", "and"
];

function words(r: Rng, lo: number, hi: number): string {
  return r.some(WORDS, lo, hi).join(" ");
}

function space(r: Rng): string {
  return r.chance(0.85) ? " " : r.pick(SPACES);
}

/** Random char-level edits: deletion, duplication, insertion of awkward characters, swaps. */
function mutate(r: Rng, text: string, edits: number): string {
  let s = text;
  for (let n = 0; n < edits; n += 1) {
    if (!s.length) {
      s = r.pick(ODD_CHARS);
      continue;
    }
    let at = r.int(0, s.length);
    // Never split a surrogate pair: the Rust side takes well-formed text.
    if (at > 0 && at < s.length && /[\uDC00-\uDFFF]/.test(s[at])) at -= 1;
    const op = r.int(0, 6);
    if (op === 0) {
      const len = r.int(1, 4);
      let end = Math.min(s.length, at + len);
      if (end < s.length && /[\uDC00-\uDFFF]/.test(s[end])) end += 1;
      s = s.slice(0, at) + s.slice(end);
    } else if (op === 1) {
      s = s.slice(0, at) + r.pick(ODD_CHARS) + s.slice(at);
    } else if (op === 2) {
      const len = r.int(1, 12);
      let end = Math.min(s.length, at + len);
      if (end < s.length && /[\uDC00-\uDFFF]/.test(s[end])) end += 1;
      s = s.slice(0, end) + s.slice(at, end) + s.slice(end);
    } else if (op === 3) {
      s = s.slice(0, at);
    } else if (op === 4) {
      const lines = s.split("\n");
      const i = r.int(0, lines.length - 1);
      if (r.chance(0.5)) lines.splice(i, 1);
      else lines.splice(i, 0, lines[r.int(0, lines.length - 1)]);
      s = lines.join("\n");
    } else if (op === 5) {
      s = s.slice(0, at) + r.pick(ASTRAL) + s.slice(at);
    } else {
      s = s.slice(0, at) + r.pick(SPACES) + s.slice(at);
    }
  }
  return s;
}

function lineEndings(r: Rng, text: string): string {
  const roll = r.next();
  if (roll < 0.1) return text.replace(/\n/g, "\r\n");
  if (roll < 0.13) return text.replace(/\n/g, "\r");
  return text;
}

function bom(r: Rng, text: string): string {
  return r.chance(0.05) ? `\ufeff${text}` : text;
}

// ---------------------------------------------------------------------------------------------
// BibTeX.

const BIB_TYPES = [
  "article", "book", "mvbook", "collection", "mvcollection", "inbook", "incollection", "bookinbook",
  "inproceedings", "conference", "proceedings", "phdthesis", "mastersthesis", "thesis", "techreport",
  "report", "online", "electronic", "www", "webpage", "unpublished", "manuscript", "dataset",
  "software", "misc", "booklet", "manual", "Article", "BOOK", "InProceedings", "patent", "foo",
  "toString", "valueOf", "hasOwnProperty", "x", "ARTICLE"
];

const BIB_FIELDS = [
  "title", "booktitle", "author", "editor", "year", "month", "date", "journal", "journaltitle",
  "publisher", "school", "institution", "organization", "address", "location", "volume", "issue",
  "number", "pages", "doi", "url", "isbn", "edition", "language", "langid", "abstract", "note",
  "keywords", "Title", "AUTHOR", "Year", "file", "x-custom", "a.b", "field_1", "tostring"
];

const MONTH_TOKENS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "Jan", "DEC",
  "january", "February", "März", "maerz", "Mai", "sept", "sept.", "Oct.", "oktober", "dezember",
  "1", "01", "12", "13", "0", "00", "5.", " 3 ", "spring", "Summer", "jan # \"~1\"", "", "1/2",
  "jän", "ſept", "MAR", "June", "juli"
];

const LATEX_PIECES = [
  "{\\\"u}", "\\\"{u}", "\\\"u", "\\\"{\\i}", "{\\'e}", "\\'{e}", "\\'e", "\\' e", "\\`a", "\\^o",
  "\\~n", "\\=a", "\\.z", "{\\v c}", "\\v{c}", "\\v c", "{\\v{s}}", "\\c{c}", "\\c c", "{\\c s}",
  "\\H{o}", "\\H o", "\\k{a}", "\\r{a}", "\\r a", "\\u{g}", "\\d{s}", "\\b{b}", "\\d s", "\\v{\\i}",
  "\\'{\\j}", "\\\"{ o }", "{\\\" o}", "\\^{}", "\\'{}", "\\\"{oo}", "\\v{C}", "\\'\\i", "\\`\\i",
  "\\'E", "\\.I", "\\'x", "\\v x", "\\u{q}",
  "{\\ss}", "\\ss{}", "\\ss ", "\\ss", "\\SS", "\\ae", "{\\AE}", "\\oe", "\\OE", "\\aa", "{\\AA}",
  "\\o", "{\\O}", "\\l", "\\L", "\\dh", "\\DH", "\\th", "\\TH", "\\i", "\\j", "\\textendash",
  "\\textemdash{}", "\\textquotedblleft", "\\textquotedblright", "\\textquoteleft", "\\textquoteright",
  "\\textquotesingle", "\\textasciitilde", "\\textbackslash", "\\ldots", "\\dots", "\\dotsx", "\\ox",
  "\\&", "\\%", "\\$", "\\_", "\\#", "--", "---", "----", "~", "\\{", "\\}", "{}", "{{", "}}",
  "\\emph{it}", "\\textbf{bold}", "{\\em it}", "$x^2$", "\\url{https://e.org}", "\\\\", "a\\,b",
  "\\LaTeX", "{\\relax}", "\\'{\\i}", "\\H{\\i}", "{\\'{e}}", "\\i{}", "\\l{}x", "\\O x"
];

const NAMES = [
  "Doe, Jane", "Jane Doe", "Doe, Jr., Jane", "Doe, Jr, Jane, Q.", "{World Health Organization}",
  "{Barnes and Noble}", "Ludwig van Beethoven", "van Beethoven, Ludwig", "Maria de la Cruz",
  "Charles de Gaulle", "Johann von der Heide", "Al Gore", "Anna van der Berg", "Plato", "others",
  "Müller, Jürgen", "M{\\\"u}ller, J{\\\"u}rgen", "{\\v{S}}koda, Emil", "J. R. R. Tolkien",
  "Tolkien, J. R. R.", "{Tolkien}, J.R.R.", "Doe,", ", Jane", ",", "{}", "  ", "Doe, {Jane, Q.}",
  "{Doe, Jane}", "{Doe} {Jane}", "Le Corbusier", "du Bois, W. E. B.", "Zhang San", "张三", "Ζήνων",
  "😀 Emoji", "O'Brien, Pat", "{\\relax Ch}ristophe", "Jean-Paul Sartre", "Della Robbia, Luca",
  "Della Robbia", "da Vinci, Leonardo", "Leonardo da Vinci", "di Lampedusa", "zu Guttenberg, K.",
  "Doe, Jane and Roe, Richard", "Jane{ }Doe", "Jane~Doe", "D\\'iaz, Ana"
];

function bibValueRaw(r: Rng, field: string): string {
  const f = field.toLowerCase();
  if (f === "author" || f === "editor") {
    const sep = () => r.pick([" and ", " AND ", " And ", "\nand\n", " and\u00a0", "  and  ", " and{} ", " and"]);
    const names = r.some(NAMES, 1, r.chance(0.1) ? 30 : 5);
    let s = names.join(sep());
    if (r.chance(0.15)) s += `${sep()}others`;
    if (r.chance(0.05)) s = `and ${s}`;
    if (r.chance(0.05)) s += " and";
    return s;
  }
  if (f === "year") {
    return r.pick(["2020", "1999", "-44", "0", "12345", "2020a", "c. 1850", "{2020}", "20 20", "n.d.", "1066", "999", "-1234", "2020/2021", "forthcoming", " 2001 ", "٢٠٢٠", "2e3"]);
  }
  if (f === "month") return r.pick(MONTH_TOKENS);
  if (f === "date") {
    return r.pick(["2020-05-03", "2020-05", "2020", "2020-5-3", "2020-13-45", "2020/05/03", "05/03/2020", "2020-05-03/2021-01-01", "2020-00", "spring 2020", "", "20200", "2020-123", "1999-1", "{2020}-01", "2020--01", "2020-05-03T10:00", "\\textendash", "2020~05"]);
  }
  if (f === "pages") {
    return r.pick(["1--10", "1-10", "1---10", "1 -- 10", "1\\textendash 10", "12", "e123", "1–10", "1—10", "1 - 10", "iv--x", "10--", "--5", "1,3--5", "1 – – 2", "{1}--{2}"]);
  }
  if (f === "doi") return r.pick(["10.1000/xyz", "{10.1000/a\\_b}", "\\{10.1/x\\}", "https://doi.org/10.1/x", " 10.1/x ", "{{10.1/x}}", "10.1/a\\&b\\#c\\%d", "10.1/x}"]);
  if (f === "url") {
    return r.pick([
      "https://example.org/a?b=c", "http://e.org", "ftp://files.e.org/x", "www.example.org", "javascript:alert(1)",
      "HTTP://E.ORG", "https://e.org/a\\_b", "https://e.org/a b", "http:/x", "https://[::1]:80/", "https://e.org:99999/",
      "mailto:x@e.org", "https:\\\\e.org", "file:///etc/x", "https://ex ample.org", "{https://e.org/{x}}", "https://exämple.org/ü",
      "\\url{https://e.org}", "https://e.org/%zz", "  https://e.org  ", "https://e.org/\u00a0x", "data:text/plain,x"
    ]);
  }
  if (f === "isbn") return r.pick(["978-3-16-148410-0", "{0-306-40615-2}", "ISBN 0306406152", "\\_x", "  "]);
  if (f === "abstract") {
    return Array.from({ length: r.int(1, 4) }, () => words(r, 1, 30)).join(r.pick(["\n\n", "\n", "\r\n", " "]));
  }
  const pieces: string[] = [];
  const count = r.int(1, 8);
  for (let i = 0; i < count; i += 1) {
    const roll = r.next();
    if (roll < 0.55) pieces.push(words(r, 1, 3));
    else if (roll < 0.85) pieces.push(r.pick(LATEX_PIECES));
    else if (roll < 0.95) pieces.push(`{${words(r, 1, 2)}}`);
    else pieces.push(r.pick(ASTRAL));
  }
  return pieces.join(r.chance(0.7) ? " " : "");
}

/** A field value expression: braced, quoted, bare number, macro, or `#` concatenation. */
function bibValueExpr(r: Rng, field: string, macros: string[]): string {
  const parts = r.chance(0.12) ? r.int(2, 4) : 1;
  const out: string[] = [];
  for (let i = 0; i < parts; i += 1) {
    const roll = r.next();
    if (roll < 0.6) out.push(`{${bibValueRaw(r, field)}}`);
    else if (roll < 0.8) out.push(`"${bibValueRaw(r, field).replace(/"/g, "{\"}")}"`);
    else if (roll < 0.88 && macros.length) out.push(r.chance(0.5) ? r.pick(macros) : r.pick(macros).toUpperCase());
    else if (roll < 0.94) out.push(r.pick(["2020", "12", "jan", "Feb", "dec", "nov", "undefinedmacro", "k", "ß"]));
    else out.push(r.pick(["\"\"", "{}", "{ }", "\"{}\"", "{\"}", "\"a{\"}b\""]));
  }
  return out.join(r.pick([" # ", "#", " #\n ", "  #  "]));
}

function bibEntry(r: Rng, macros: string[], opts: { types?: readonly string[]; fields?: readonly string[] } = {}): string {
  const type = r.pick(opts.types ?? BIB_TYPES);
  const paren = r.chance(0.08);
  const keyRoll = r.next();
  const key =
    keyRoll < 0.8 ? `${r.pick(["doe", "Roe", "smith", "müller", "key", "a"])}${r.int(1900, 2030)}${r.pick(["", "a", "b", ":x", "-y", "_z", ".1", "/2"])}`
      : keyRoll < 0.88 ? r.pick(["", " ", "has space", "a=b", "😀key", "k{1}", "\"q\"", "x\u00a0y", "k\u2028", "a,b"])
        : `k${r.int(0, 3)}`;
  const fields = opts.fields ?? BIB_FIELDS;
  const lines: string[] = [];
  const n = r.int(0, 10);
  for (let i = 0; i < n; i += 1) {
    const name = r.pick(fields);
    const eq = r.pick([" = ", "=", " =  ", "\t=\t", " =\n  "]);
    lines.push(`${name}${eq}${bibValueExpr(r, name, macros)}`);
  }
  const indent = r.pick(["  ", "\t", "", "    "]);
  const sep = r.pick([",\n", ", ", ",\r\n", ",\n\n"]);
  const trailing = r.chance(0.3) ? "," : "";
  const body = `${key},${lines.length ? "\n" : ""}${lines.map((l) => indent + l).join(sep)}${trailing}\n`;
  return paren ? `@${type}(${body})` : `@${type}${r.chance(0.1) ? " " : ""}{${body}}`;
}

function bibStrings(r: Rng): { text: string[]; names: string[] } {
  const names: string[] = [];
  const text: string[] = [];
  const n = r.chance(0.4) ? r.int(1, 4) : 0;
  for (let i = 0; i < n; i += 1) {
    const name = r.pick(["acm", "ieee", "jn", "pub", "MyMacro", "jan", "x.y", "a-b", "k_1", "Kelvin", "straße", "ſ", "bad key", "@"]);
    const value = r.chance(0.2) && names.length
      ? `${r.pick(names)} # " and more"`
      : bibValueExpr(r, "title", names);
    const open = r.chance(0.15) ? ["(", ")"] : ["{", "}"];
    text.push(`@${r.pick(["string", "STRING", "String"])}${open[0]}${name}${r.pick([" = ", "="])}${value}${open[1]}`);
    names.push(name);
  }
  return { text, names };
}

function bibDocument(r: Rng, entryOpts: Parameters<typeof bibEntry>[2] = {}): string {
  const { text: strings, names } = bibStrings(r);
  const blocks: string[] = [];
  if (r.chance(0.1)) blocks.push(r.pick(["% exported by a reference manager", "Some preamble text, not an entry.", "@comment{ignored @article{x, title={no}} }", "@preamble{\"\\newcommand{\\noop}[1]{}\"}", "@Comment jabref-meta: x;"]));
  blocks.push(...strings);
  const n = r.int(1, 4);
  for (let i = 0; i < n; i += 1) {
    blocks.push(bibEntry(r, names, entryOpts));
    if (r.chance(0.05)) blocks.push(r.pick(["email me @ home", "@", "@123{x}", "@{x}", "@ article{y, title={t}}", "%@article{z}"]));
  }
  return blocks.join(r.pick(["\n\n", "\n", "", "\r\n\r\n", " "]));
}

function bibFilename(r: Rng): string {
  return r.pick(["refs.bib", "refs.bib", "refs.bib", "", "", "REFS.BIB", "x.bibtex", " lib.bib ", "notes.txt", "refs.Bib", "a.bib\u00a0"]);
}

// ---------------------------------------------------------------------------------------------
// RIS.

const RIS_TYPES = [
  "BOOK", "WHOLE", "EDBOOK", "JOUR", "JFULL", "EJOUR", "MGZN", "NEWS", "CHAP", "SECT", "CONF",
  "CPAPER", "THES", "RPRT", "ELEC", "WEB", "ENCYC", "DICT", "MANSCPT", "UNPB", "DATA", "COMP",
  "GEN", "MISC", "STD", "PAT", "jour", "Book", "ABST", "ADVS", "XYZ", "", " JOUR ", "JOUR\u00a0",
  "TOSTRING", "ſect"
];

const RIS_TAGS = [
  "AU", "A1", "A2", "ED", "TI", "T1", "T2", "BT", "JO", "J2", "JF", "PY", "Y1", "DA", "VL", "IS",
  "SP", "EP", "PB", "CY", "DO", "UR", "SN", "ID", "LA", "ET", "AB", "N2", "KW", "N1", "A3", "Y2",
  "M3", "C1", "L1", "ST"
];

function risValue(r: Rng, tag: string): string {
  if (["AU", "A1", "A2", "ED", "A3"].includes(tag)) return r.pick(NAMES).replace(/[{}\\]/g, "");
  if (["PY", "Y1", "DA", "Y2"].includes(tag)) {
    return r.pick([
      "2020", "2020///", "2020/05/03/", "2020/05/03", "2020-05-03", "2020/May/3", "2020/may.", "2020/13/1",
      "2020/05/32", "2020/05/0", "2020/05/ 7", "2020/Spring", "Spring 2020", "20/05/2020", "2020/ 5 /3",
      "2020/sept/9/extra", "2020-/05", "202", "02020", "2020/März/1", "2020/maerz", "", "  ", "2020/12/031",
      "2020/1/1", "1999/Dec", "٢٠٢٠", "2020//", "/2020", "2020/05/03/Original publication"
    ]);
  }
  if (tag === "UR") return r.pick(["https://example.org/x", "www.e.org", "javascript:x", "http:/x", "ftp://a.b/c", "https://e.org/a b", "HTTPS://E.ORG/", "https://[::1]/", "x:y"]);
  if (tag === "ID") return r.pick(["key1", "doe2020", "has space", "ü-key", "a/b", "--x--", "😀", "k".repeat(200), "a..b", "Ref 1"]);
  return words(r, 1, tag === "AB" || tag === "N2" ? 40 : 6);
}

function risRecord(r: Rng): string {
  const lines: string[] = [];
  const sep = () => r.pick(["  - ", "  - ", " - ", "  -", "  -  ", "   - ", "\t- ", "  -\u00a0"]);
  lines.push(`TY${sep()}${r.pick(RIS_TYPES)}`);
  const n = r.int(0, 12);
  for (let i = 0; i < n; i += 1) {
    const tag = r.pick(RIS_TAGS);
    lines.push(`${tag}${sep()}${risValue(r, tag)}${r.chance(0.05) ? "   " : ""}`);
    if (r.chance(0.08)) lines.push(r.pick(["continued on the next line", "  indented continuation", "😀 more", "", "\u00a0"]));
  }
  if (r.chance(0.92)) lines.push(`ER${r.pick(["  - ", "  -", "  - ", " - ", "  - trailing"])}`);
  return lines.join("\n");
}

function risDocument(r: Rng): string {
  const blocks: string[] = [];
  if (r.chance(0.08)) blocks.push(r.pick(["Provider: Export\nDatabase: X", "garbage", "ER  - ", "AU  - Orphan, A.", "%"]));
  const n = r.int(1, 4);
  for (let i = 0; i < n; i += 1) blocks.push(risRecord(r));
  return blocks.join(r.pick(["\n\n", "\n", "\n\n\n"]));
}

function risFilename(r: Rng): string {
  return r.pick(["refs.ris", "refs.ris", "", "", "REFS.RIS", "export.txt", " x.ris", "a.ris\t"]);
}

// ---------------------------------------------------------------------------------------------
// CSL-JSON.

const CSL_TYPES = ["book", "article-journal", "chapter", "webpage", "thesis", "report", "BOOK", "Article", "x", "a_b-c", "1book", "", " book ", "bo ok", "b".repeat(64), "b".repeat(65), "dataset", "émoji"];

function cslString(r: Rng, cap = 50): unknown {
  const roll = r.next();
  if (roll < 0.6) return words(r, 1, 8);
  if (roll < 0.7) return r.pick(["", "  ", "\n\tx\r\ny", "a\u0000b\u0007c\u007f", "\u2028x\u2029", "x  y", "\u00a0x\u00a0"]);
  if (roll < 0.8) return r.pick([12, 0, -0, 1.5, 1e21, 2 ** 53 + 2, -7, 1e-7, 123456789012]);
  if (roll < 0.85) return r.pick([null, true, false, [], {}, ["a"], { a: 1 }]);
  if (roll < 0.95) {
    const len = r.pick([cap - 1, cap, cap + 1, 127, 128, 129, 299, 300, 301, 600, 601, 1000, 1001, 1999, 2000, 2001]);
    const unit = r.pick(["a", "é", "😀", "a ", " "]);
    return unit.repeat(Math.ceil(len / unit.length)).slice(0, len) + (r.chance(0.5) ? r.pick(ASTRAL) : "");
  }
  return r.pick(ASTRAL) + words(r, 0, 3);
}

function cslName(r: Rng): unknown {
  if (r.chance(0.05)) return r.pick(["Doe", 1, null, [], { family: "" }, { given: 2 }]);
  const name: Record<string, unknown> = {};
  for (const k of ["family", "given", "literal", "non-dropping-particle", "dropping-particle", "suffix", "extra"]) {
    if (r.chance(k === "family" || k === "given" ? 0.75 : 0.12)) name[k] = cslString(r, 300);
  }
  return name;
}

function cslDate(r: Rng): unknown {
  if (r.chance(0.05)) return r.pick(["2020", 2020, null, [[2020]]]);
  const d: Record<string, unknown> = {};
  if (r.chance(0.7)) {
    const groups = r.int(0, 3);
    d["date-parts"] = r.chance(0.05) ? r.pick(["2020", [2020], [[]], null]) : Array.from({ length: groups }, () =>
      Array.from({ length: r.int(0, 4) }, () => r.pick<unknown>([2020, 1999, 5, 31, "2020", " 7 ", "", 1.5, -3, 2 ** 53 + 2, 1e21, null, "x".repeat(20), NaN, "😀".repeat(9)])));
  }
  if (r.chance(0.25)) d.literal = cslString(r, 128);
  if (r.chance(0.2)) d.raw = cslString(r, 128);
  if (r.chance(0.15)) d.season = r.pick<unknown>([1, 2.5, "Spring", "", 0, "s".repeat(40)]);
  if (r.chance(0.15)) d.circa = r.pick<unknown>([true, false, "yes", 1]);
  return d;
}

function cslItem(r: Rng): unknown {
  if (r.chance(0.04)) return r.pick<unknown>([null, 1, "item", [], true]);
  const item: Record<string, unknown> = {};
  if (r.chance(0.85)) item.id = r.pick<unknown>(["a", "doe2020", "doe2020", "has space", "ü", "--x--", "a/b", "", 7, 1.5, -0, 1e21, null, "x".repeat(140), "😀", "a..b", "-", "ref-1", "k:1"]);
  item.type = r.chance(0.9) ? r.pick(CSL_TYPES) : r.pick<unknown>([1, null, ["book"]]);
  const keys = ["title", "author", "editor", "issued", "container-title", "publisher", "publisher-place", "volume", "issue", "page", "DOI", "URL", "ISBN", "edition", "language", "abstract-free", "abstract", "citeKey", "provider", "note", "unknown"];
  for (const k of keys) {
    if (!r.chance(0.3)) continue;
    if (k === "author" || k === "editor") {
      item[k] = r.chance(0.05) ? r.pick<unknown>(["Doe", {}, null]) : Array.from({ length: r.chance(0.03) ? 205 : r.int(0, 4) }, () => cslName(r));
    } else if (k === "issued") item[k] = cslDate(r);
    else if (k === "URL") {
      item[k] = r.pick<unknown>(["https://example.org", "http://e.org/a b", "ftp://x", "javascript:alert(1)", "www.e.org", "HTTPS://E.ORG", "https://[::1]:8080/", "https://e.org:70000", "https:\\\\e.org\\x", "http:/x", " https://e.org ", "https://exämple.org", "", 5, "mailto:a@b", "https://e.org/\u0000x", "https://e.org/" + "p".repeat(2000)]);
    } else item[k] = cslString(r, k === "abstract-free" || k === "abstract" ? 20000 : 128);
  }
  return item;
}

function cslDocument(r: Rng): string {
  const items = Array.from({ length: r.int(0, 6) }, () => cslItem(r));
  const roll = r.next();
  const value = roll < 0.7 ? items : roll < 0.85 ? { items } : roll < 0.95 ? items[0] ?? { type: "book", title: "One" } : { items: r.pick<unknown>([null, {}, "x"]) };
  return JSON.stringify(value, null, r.pick([undefined, 2, "\t"]) as never);
}

function cslMalformed(r: Rng): string {
  const base = cslDocument(r);
  const roll = r.next();
  if (roll < 0.3) return base.slice(0, r.int(0, base.length));
  if (roll < 0.5) return mutate(r, base, r.int(1, 4));
  return r.pick([
    "[1, 2,]", "{'a': 1}", "[NaN]", "[Infinity]", "// c\n[]", "[] x", "[1e999]", "[-]", "[01]", "[.5]",
    "{\"items\": [}", "\"str\"", "123", "null", "true", "[\"\\u12\"]", "[\"\\x41\"]", "[\"a\nb\"]", "{\"a\" 1}",
    "{\"type\": 5}", "{\"items\": {}}", "[[[]]]", "{", "[", "[\"\u0000\"]", "{\"__x\": 1, \"type\": \"book\"}", "[{\"type\":\"book\",\"title\":\"T\",\"title\":\"U\"}]",
    "\u00a0[]", "[]\u00a0", "\u2028[]", "\ufeff\ufeff[]", "{\"items\": [{\"type\": \"book\", \"title\": \"x\"}], \"type\": \"book\"}",
    "[{\"id\": 1e21, \"type\": \"book\", \"title\": \"x\"}]", "[{\"id\": -0, \"type\": \"book\", \"title\": \"x\"}]",
    "[{\"id\": 0.000001, \"type\": \"book\", \"title\": \"x\"}]", "[{\"id\": 1e-7, \"type\": \"book\", \"title\": \"x\"}]",
    "[{\"type\": \"book\", \"title\": \"x\", \"issued\": {\"date-parts\": [[2020.0, 1e0, 3]]}}]"
  ]);
}

function duplicateIds(r: Rng): string {
  const id = r.pick(["a", "a-2", "x".repeat(127), "x".repeat(128), "ref", "😀", "-"]);
  const items = Array.from({ length: r.int(2, 12) }, () => ({
    id: r.chance(0.8) ? id : r.pick([`${id}-2`, `${id}-3`, "", "a-2-2"]),
    type: "book",
    title: r.chance(0.5) ? "Same" : words(r, 1, 3)
  }));
  return JSON.stringify(items);
}

function cslFilename(r: Rng): string {
  return r.pick(["refs.json", "refs.json", "", "", "x.csljson", "x.CSL", "lib.JSON", " a.json ", "data.txt"]);
}

// ---------------------------------------------------------------------------------------------
// Categories.

type Case = { category: string; filename: string; text: string };
type Gen = (r: Rng) => { filename: string; text: string };

const LATEX_FIELDS = ["title", "journal", "booktitle", "publisher", "address", "edition", "language", "volume", "number", "abstract"];
const NAME_FIELDS = ["author", "editor", "title"];
const DATE_FIELDS = ["year", "month", "date", "title"];
const ID_FIELDS = ["doi", "url", "isbn", "title"];

const CATEGORIES: Array<[string, number, Gen]> = [
  ["bibtex/valid", 5000, (r) => ({ filename: bibFilename(r), text: bom(r, lineEndings(r, bibDocument(r))) })],
  ["bibtex/latex", 4000, (r) => ({ filename: bibFilename(r), text: bibDocument(r, { fields: LATEX_FIELDS }) })],
  ["bibtex/names", 3000, (r) => ({ filename: bibFilename(r), text: bibDocument(r, { fields: NAME_FIELDS }) })],
  ["bibtex/dates", 3000, (r) => ({ filename: bibFilename(r), text: bibDocument(r, { fields: DATE_FIELDS }) })],
  ["bibtex/identifiers", 1500, (r) => ({ filename: bibFilename(r), text: bibDocument(r, { fields: ID_FIELDS }) })],
  ["bibtex/malformed", 5000, (r) => ({ filename: bibFilename(r), text: mutate(r, bibDocument(r), r.int(1, 6)) })],
  ["bibtex/unicode", 2000, (r) => ({ filename: bibFilename(r), text: mutate(r, bibDocument(r), 0).replace(/ /g, () => space(r)) })],
  ["ris/valid", 4000, (r) => ({ filename: risFilename(r), text: bom(r, lineEndings(r, risDocument(r))) })],
  ["ris/malformed", 3000, (r) => ({ filename: risFilename(r), text: mutate(r, risDocument(r), r.int(1, 6)) })],
  ["ris/unicode", 1500, (r) => ({ filename: risFilename(r), text: risDocument(r).replace(/ /g, () => space(r)) })],
  ["csl-json/valid", 3500, (r) => ({ filename: cslFilename(r), text: bom(r, cslDocument(r)) })],
  ["csl-json/malformed", 2500, (r) => ({ filename: cslFilename(r), text: cslMalformed(r) })],
  ["csl-json/duplicate-ids", 500, (r) => ({ filename: cslFilename(r), text: duplicateIds(r) })],
  ["detect", 2000, (r) => {
    const body = r.pick([bibDocument, risDocument, cslDocument, (q: Rng) => words(q, 0, 20)])(r);
    const lead = r.pick(["", "", " ", "\n\n", "\ufeff", "\u00a0", "\u2028", "\ufeff\ufeff", "x\n", "text TY  - JOUR\n", "@\n", "\t"]);
    const filename = r.pick(["", "", "refs.bib", "refs.ris", "refs.json", "a.csl", "A.CSLJSON", "x.txt", "x.bib.txt", ".bib", "bib", " ", "x.ris ", "x.\u0130", "noext"]);
    const text = r.chance(0.05) ? r.pick(["", " ", "\n\t", "\u00a0", "\ufeff", "\ufeff \u2028", "\u3000"]) : lead + body;
    return { filename, text };
  }],
  ["noise", 1500, (r) => ({
    filename: r.pick(["", "a.bib", "a.ris", "a.json"]),
    text: Array.from({ length: r.int(0, 60) }, () => r.pick(ODD_CHARS)).join("")
  })]
];

/** Inputs that make ProseCraft look up `constructor`/`__proto__` in a plain object. */
function prototypeCases(r: Rng): Case[] {
  const out: Case[] = [];
  const words = ["constructor", "__proto__", "Constructor", "CONSTRUCTOR.", "__PROTO__"];
  for (let i = 0; i < 300; i += 1) {
    const w = r.pick(words);
    const kind = r.int(0, 4);
    let text: string;
    let filename = "refs.bib";
    if (kind === 0) text = `@${w.replace(/[^A-Za-z]/g, "") || "constructor"}{k${i}, title={T}}`;
    else if (kind === 1) text = `@book{k${i}, title={T}, year=2020, month=${w}}`;
    else if (kind === 2) text = `@book{k${i}, title={T}, year=2020, month={${w}}}`;
    else if (kind === 3) text = `@string{m = ${w}}\n@book{k${i}, title=m # ${w}}`;
    else {
      text = `TY  - JOUR\nTI  - T\nPY  - 2020/${w}/3\nER  - `;
      filename = "refs.ris";
    }
    out.push({ category: "js-prototype", filename, text });
  }
  return out;
}

function generate(seed: number, scale: number): Case[] {
  const cases: Case[] = [];
  CATEGORIES.forEach(([category, count, gen], index) => {
    const r = rng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    for (let i = 0; i < Math.round(count * scale); i += 1) {
      const raw = gen(r);
      // The Rust side takes well-formed text (`&str`): no lone surrogates.
      const text = raw.text.toWellFormed();
      const filename = raw.filename.toWellFormed();
      // Keep the prototype-name lookups out of the main categories (see above).
      const c = /constructor|__proto__/i.test(text) ? "js-prototype" : category;
      cases.push({ category: c, filename, text });
    }
  });
  cases.push(...prototypeCases(rng(seed ^ 0x5eed)));
  // Five inputs over the 5,000-item cap.
  const big = rng(seed ^ 0xb16);
  for (let i = 0; i < 5; i += 1) {
    const n = 5000 + big.int(-1, 30);
    const items = Array.from({ length: n }, (_, k) => ({ id: big.chance(0.1) ? "dup" : `i${k}`, type: "book", title: `T${k}` }));
    if (i === 4) {
      const bib = Array.from({ length: n }, (_, k) => `@book{k${k % 4000}, title={T${k}}}`).join("\n");
      cases.push({ category: "cap", filename: "big.bib", text: bib });
    } else {
      cases.push({ category: "cap", filename: "big.json", text: JSON.stringify(items) });
    }
  }
  return cases;
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

it.skipIf(!OUT)("writes the citation differential corpus", () => {
  const generated = generate(SEED, SCALE);
  const cases = generated.map((c, id) => ({ id, ...c, result: importCitations(c.text, c.filename) }));
  const body = JSON.stringify(cases);
  const counts: Record<string, number> = {};
  for (const c of cases) counts[c.category] = (counts[c.category] ?? 0) + 1;
  const meta = {
    generator: "src/citation-compare.gen.test.ts",
    prosecraftCommit: gitCommit(),
    seed: SEED,
    scale: SCALE,
    node: process.version,
    total: cases.length,
    counts,
    sha256: createHash("sha256").update(body).digest("hex")
  };
  writeFileSync(OUT!, `{"meta":${JSON.stringify(meta)},"cases":${body}}\n`);
  console.log(JSON.stringify(meta, null, 2));
}, 600_000);

it.skipIf(!REPLAY)("replays inputs through importCitations", () => {
  const [input, output] = REPLAY!.split(",");
  const cases = JSON.parse(readFileSync(input, "utf8")) as Array<{ text: string; filename?: string }>;
  writeFileSync(output, JSON.stringify(cases.map((c) => importCitations(c.text, c.filename ?? ""))));
});

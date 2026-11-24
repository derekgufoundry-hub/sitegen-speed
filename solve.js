// solve.js — a fast, dependency-free reimplementation of makefun-site 1.0.0.
//
// build(input) turns one site's sources into its output tree (a JSON object of
// path -> text), byte for byte the same as the reference for every input. The
// speed comes from the hot paths only: a fused Markdown lexer+renderer, a
// single-pass inline scanner that escapes literal runs in bulk, an ASCII fast
// path plus a cache for slugs, index-based front-matter scanning, and a
// template renderer that appends to an array instead of concatenating strings.
// The pipeline, the report lines and every error message follow the reference
// exactly. Pure JavaScript, no imports, no clock, no randomness, no I/O.
//
// The driver (main.ts) calls run(input) once per case.

const SLUG_MAX = 64;
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped; the input itself when it holds none. */
function esc(s) {
  return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ESCAPES[c]) : s;
}

/** Per-build caches (slugify and longDate are pure functions of their input). */
let slugCache = new Map();
let dateCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when nothing
 * is left. Pure ASCII takes a fast path (NFKD is identity there, and ASCII has
 * no combining marks); anything else runs the full rule.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || (c >= 9 && c <= 13);
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (only spaces/tabs, or empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Scanned by line offsets
 * (no split of the whole file, no join of the body): the body is a slice.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = 4;
  let bodyStart = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon === -1) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    let keyOk = key.length > 0;
    for (let k = 0; k < key.length && keyOk; k++) {
      const cc = key.charCodeAt(k);
      if (!((cc >= 97 && cc <= 122) || cc === 95)) keyOk = false;
    }
    if (!keyOk) return { error: `line ${j + 2} is not "key: value"` };
    const rest = line.slice(colon + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
    else return { error: `line ${j + 2} is not "key: value"` };
    let rEnd = raw.length;
    while (rEnd > 0 && (raw.charCodeAt(rEnd - 1) === 32 || raw.charCodeAt(rEnd - 1) === 9)) rEnd--;
    raw = raw.slice(0, rEnd);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** Whether a character code is one a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/** Whether a character code is whitespace (\s). */
function isWSCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * Whether the character at `k` is escaped: the run of backslashes ending at
 * k-1 has odd length (a backslash pairs with the character after it, so pairs
 * cancel and one left over escapes it). The run cannot reach before `from`:
 * every call starts just after an opener that is not a backslash.
 */
function isEscapedAt(s, k, from) {
  let n = 0;
  let p = k - 1;
  while (p >= from && s.charCodeAt(p) === 92) {
    n++;
    p--;
  }
  return (n & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    if (!isEscapedAt(s, k, from)) return k;
    j = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    if (isEscapedAt(s, k, from)) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. It jumps from one
 * inline construct to the next (native indexOf scans) and escapes the literal
 * text between them in bulk; a construct that does not close is literal text.
 */
function inline(s, env) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    let j = s.indexOf('\\', i);
    if (j === -1) j = Infinity;
    let k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j === Infinity) {
      out.push(esc(s.slice(i, n)));
      break;
    }
    if (j > i) out.push(esc(s.slice(i, j)));
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
        const nc = s.charCodeAt(j + 1);
        out.push(nc === 62 ? '&gt;' : s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const m = s.indexOf('`', j + 1);
      if (m > j + 1) {
        out.push('<code>', esc(s.slice(j + 1, m)), '</code>');
        i = m + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const m = findUnescaped(s, '**', j + 2);
        if (m > j + 2) {
          out.push('<strong>', inline(s.slice(j + 2, m), env), '</strong>');
          i = m + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const m = findSingleStar(s, j + 1);
      if (m > j + 1) {
        out.push('<em>', inline(s.slice(j + 1, m), env), '</em>');
        i = m + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    const k2 = findUnescaped(s, ']', j + 1);
    const m = k2 !== -1 && s.charCodeAt(k2 + 1) === 40 ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', esc(env.link(target)), '">', inline(s.slice(j + 1, k2), env), '</a>');
      i = m + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
  return out.join('');
}

// --- block scanning on a line range src[p..e) (e is the '\n' or the end) ---

/** Whether src[p..e) is blank (only spaces/tabs, or empty). */
function blankRange(s, p, e) {
  for (let i = p; i < e; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language ('' when none), or null when the line does not open one. */
function fenceOpen(s, p, e) {
  if (s.charCodeAt(p) !== 96 || s.charCodeAt(p + 1) !== 96 || s.charCodeAt(p + 2) !== 96) return null;
  let j = p + 3;
  const langStart = j;
  while (j < e) {
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  const lang = s.slice(langStart, j);
  while (j < e && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  return j === e ? lang : null;
}

/** Whether the line closes a fence: ``` then spaces/tabs only. */
function fenceClose(s, p, e) {
  if (s.charCodeAt(p) !== 96 || s.charCodeAt(p + 1) !== 96 || s.charCodeAt(p + 2) !== 96) return false;
  for (let j = p + 3; j < e; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingRange(s, p, e) {
  let n = 0;
  while (n < 6 && p + n < e && s.charCodeAt(p + n) === 35) n++;
  if (n === 0 || p + n >= e) return null;
  const c = s.charCodeAt(p + n);
  if (c !== 32 && c !== 9) return null;
  let t = p + n;
  while (t < e && (s.charCodeAt(t) === 32 || s.charCodeAt(t) === 9)) t++;
  let te = e;
  while (te > t && (s.charCodeAt(te - 1) === 32 || s.charCodeAt(te - 1) === 9)) te--;
  if (te === t) return null;
  return { depth: n, text: s.slice(t, te) };
}

/** Whether the line is a thematic break: --- or *** then spaces/tabs only. */
function hrRange(s, p, e) {
  const c = s.charCodeAt(p);
  if (c !== 45 && c !== 42) return false;
  if (s.charCodeAt(p + 1) !== c || s.charCodeAt(p + 2) !== c) return false;
  for (let j = p + 3; j < e; j++) {
    const cc = s.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether the line ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraphRange(s, p, e) {
  return blankRange(s, p, e) || fenceOpen(s, p, e) !== null || headingRange(s, p, e) !== null || hrRange(s, p, e);
}

/** src[p..e) with spaces and tabs at either end dropped. */
function trimRange(s, p, e) {
  let a = p;
  let b = e;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** A list's opening line: { ordered, start } or null. */
function listOpen(s, p, e) {
  const c = s.charCodeAt(p);
  if (c === 45 || c === 42) {
    if (s.charCodeAt(p + 1) === 32) return { ordered: false, start: 1 };
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = p;
    let n = 0;
    while (j < e && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
      j++;
      n++;
    }
    if (n >= 1 && n <= 9 && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) === 32) {
      return { ordered: true, start: Number(s.slice(p, j)) };
    }
  }
  return null;
}

/** A list item line of this kind: its trimmed text, or null. */
function listItem(s, p, e, ordered) {
  if (!ordered) {
    const c = s.charCodeAt(p);
    if ((c === 45 || c === 42) && s.charCodeAt(p + 1) === 32) return trimRange(s, p + 2, e);
    return null;
  }
  const c = s.charCodeAt(p);
  if (c < 48 || c > 57) return null;
  let j = p;
  let n = 0;
  while (j < e && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) {
    j++;
    n++;
  }
  if (n >= 1 && n <= 9 && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) === 32) return trimRange(s, j + 2, e);
  return null;
}

/** Whether the line continues a list item: two or more spaces, then a non-whitespace character. */
function continuedRange(s, p, e) {
  if (s.charCodeAt(p) !== 32 || s.charCodeAt(p + 1) !== 32) return false;
  let j = p + 2;
  while (j < e && s.charCodeAt(j) === 32) j++;
  if (j >= e) return false;
  return !isWSCode(s.charCodeAt(j));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML), its excerpt (the first paragraph's inline HTML, or "") and its word
 * count. Lexing and rendering run in one pass over the lines, so no token list
 * is built.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const N = src.length;
  let p = 0;
  while (p <= N) {
    let e = src.indexOf('\n', p);
    if (e === -1) e = N;
    if (blankRange(src, p, e)) {
      p = e + 1;
      continue;
    }
    const lang = fenceOpen(src, p, e);
    if (lang !== null) {
      const parts = [];
      p = e + 1;
      while (p <= N) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = N;
        if (fenceClose(src, p, e2)) {
          p = e2 + 1;
          break;
        }
        parts.push(esc(src.slice(p, e2)) + '\n');
        if (e2 === N) {
          p = N + 1;
          break;
        }
        p = e2 + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      blocks.push(`<pre><code${cls}>${parts.join('')}</code></pre>`);
      continue;
    }
    const hd = headingRange(src, p, e);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, env);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      p = e + 1;
      continue;
    }
    if (hrRange(src, p, e)) {
      blocks.push('<hr>');
      p = e + 1;
      continue;
    }
    if (src.charCodeAt(p) === 62) {
      const lines = [];
      while (p <= N) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = N;
        if (src.charCodeAt(p) !== 62) break;
        let q = p + 1;
        if (q < e2 && src.charCodeAt(q) === 32) q++;
        const t = trimRange(src, q, e2);
        if (t !== '') lines.push(t);
        if (e2 === N) {
          p = N + 1;
          break;
        }
        p = e2 + 1;
      }
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(lines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const li = listOpen(src, p, e);
    if (li !== null) {
      const items = [];
      while (p <= N) {
        let e2 = src.indexOf('\n', p);
        if (e2 === -1) e2 = N;
        const m = listItem(src, p, e2, li.ordered);
        if (m !== null) {
          items.push([m]);
          if (e2 === N) {
            p = N + 1;
            break;
          }
          p = e2 + 1;
          continue;
        }
        if (continuedRange(src, p, e2)) {
          items[items.length - 1].push(trimRange(src, p, e2));
          if (e2 === N) {
            p = N + 1;
            break;
          }
          p = e2 + 1;
          continue;
        }
        break;
      }
      const tag = li.ordered ? 'ol' : 'ul';
      const open = li.ordered && li.start !== 1 ? `<ol start="${li.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const parts = [trimRange(src, p, e)];
    p = e + 1;
    while (p <= N) {
      let e2 = src.indexOf('\n', p);
      if (e2 === -1) e2 = N;
      if (endsParagraphRange(src, p, e2)) break;
      parts.push(trimRange(src, p, e2));
      if (e2 === N) {
        p = N + 1;
        break;
      }
      p = e2 + 1;
    }
    const html = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt, words: wordsOf(src) };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. `ctx`
 * holds the parsed templates (a Map of name to nodes; a template that did not
 * parse is absent) and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderTemplate(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * A parsed template rendered, compiled when possible, walked otherwise.
 * `t` is { nodes, fn } (fn null when compilation failed); the two agree.
 */
function renderTemplate(t, scope, ctx, depth, out) {
  if (t.fn !== null) t.fn(scope, ctx, depth, out);
  else renderNodes(t.nodes, scope, ctx, depth, out);
}

/**
 * A parsed template compiled to one function (scope, ctx, depth, out) that
 * appends its output to `out`: straight-line code and native loops instead of
 * a node walk. Paths are hoisted into the array P (no allocation per render).
 * Null when compilation fails, in which case the walker renders the template.
 */
function compileTemplate(nodes) {
  const paths = [];
  let uid = 0;
  const gen = (ns, scopeVar, code) => {
    for (const n of ns) {
      if (n.kind === 'text') {
        code.push(`out.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const pi = paths.length;
        paths.push(n.path);
        if (n.kind === 'var') code.push(`out.push(esc(textOf(lookup(${scopeVar},P[${pi}]))));`);
        else code.push(`out.push(textOf(lookup(${scopeVar},P[${pi}])));`);
      } else if (n.kind === 'if') {
        const pi = paths.length;
        paths.push(n.path);
        code.push(`if(truthy(lookup(${scopeVar},P[${pi}]))!==${n.not}){`);
        gen(n.then, scopeVar, code);
        if (n.else !== null) {
          code.push('}else{');
          gen(n.else, scopeVar, code);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const pi = paths.length;
        paths.push(n.path);
        const xs = `__xs${uid}`;
        const k = `__k${uid}`;
        const sv = `__s${uid}`;
        uid++;
        // One scope for the whole loop, its element and loop record rewritten
        // per element: the body only ever reads them while it renders.
        code.push(`{const ${xs}=lookup(${scopeVar},P[${pi}]);if(Array.isArray(${xs})){const ${sv}={vars:{[${JSON.stringify(n.name)}]:undefined,loop:{index:0,first:false,last:false,length:${xs}.length}},parent:${scopeVar}};for(let ${k}=0;${k}<${xs}.length;${k}++){${sv}.vars[${JSON.stringify(n.name)}]=${xs}[${k}];${sv}.vars.loop.index=${k}+1;${sv}.vars.loop.first=${k}===0;${sv}.vars.loop.last=${k}===${xs}.length-1;`);
        gen(n.body, sv, code);
        code.push('}}}');
      } else if (n.kind === 'include') {
        const t = `__t${uid}`;
        uid++;
        code.push(`{const ${t}=ctx.templates.get(${JSON.stringify(n.name)});if(${t}!==undefined&&depth<8)renderTemplate(${t},${scopeVar},ctx,depth+1,out);}`);
      }
    }
  };
  const code = [];
  gen(nodes, 'scope', code);
  try {
    const factory = new Function('P', 'lookup', 'textOf', 'truthy', 'esc', 'renderTemplate', `return function(scope,ctx,depth,out){${code.join('')}}`);
    return factory(paths, lookup, textOf, truthy, esc, renderTemplate);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- pipeline

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(b, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(b, s) {
  const card = b.cards.get(s) ?? cardOf(s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const t = b.templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderTemplate(t, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function reportFn(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function build(input) {
  slugCache = new Map();
  dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, { nodes, fn: compileTemplate(nodes) });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  reportFn(b);
  return b.output;
}

/** The driver's entry point: one case's answer. */
export function run(input) {
  return build(input);
}

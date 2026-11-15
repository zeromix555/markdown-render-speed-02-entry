// Fast Markdown renderer, fourth build: parse(markdown) returns exactly
// the HTML that marked 18.1.3 renders with its default options (GFM on,
// breaks off, pedantic off, async off). Dependency-free ES module.
//
// Shape of this build, deliberately unlike a straight transliteration:
// - grammar rules live in two plain objects (B for block, I for inline),
//   filled by assignment so rules composed from earlier rules can refer
//   to them by name;
// - every tokenizer and helper is a plain function declaration; per-parse
//   state is a handful of module-level `let` bindings, reset by parse();
// - block dispatch is a switch on the first non-space character whose
//   cases chain candidate rules with ||, in the reference order;
// - inline rules return [html, length] pairs, and the inline loop is an
//   if/else chain, not a switch;
// - the text-stop scan is split in two: one pass finds the earliest cheap
//   stop, another finds the earliest email stop, and the answer is the
//   smaller of the two (an email run may legitimately reach back before
//   a cheap stop);
// - emphasis and strikethrough collect their right delimiters into an
//   array with one exec loop, then walk the array;
// - rendering goes through a dispatch object of methods, one per token
//   type, joined by an explicit loop.

'use strict';

// ---------------------------------------------------------------------------
// Regex construction
// ---------------------------------------------------------------------------

// Compose a regex from a template, replacing each [pattern, value] pair in
// order. A value's ^ anchors are stripped the way the reference grammar's
// composer does it: a ^ survives only right after '['.
function compose(template, subs, flags) {
  let source = typeof template === 'string' ? template : template.source;
  for (let k = 0; k < subs.length; k++) {
    const name = subs[k][0];
    const val = subs[k][1];
    let valSource = typeof val === 'string' ? val : val.source;
    valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
    source = source.replace(name, valSource);
  }
  return new RegExp(source, flags || '');
}

// Turn an anchored (^...) regex into a sticky one that matches at an index
// inside a longer string. The ^ anchor cannot stay: with the sticky flag
// it would only match at index 0, and the sticky flag itself is the
// anchor. A ^ is dropped when it is not escaped, not inside a character
// class, and sits at the start or right after |, ( or :. Implemented as a
// replace with a running in-class flag instead of a manual scan.
function sticky(re) {
  let inClass = false;
  const out = re.source.replace(/\\.|[\[\]]|\^/g, function (m) {
    if (m === '[') { inClass = true; return m; }
    if (m === ']') { inClass = false; return m; }
    if (m === '^' && !inClass) return '';
    return m;
  });
  const flags = re.flags.replace('g', '').replace('y', '') + 'y';
  return new RegExp(out, flags);
}

// Execute a sticky regex at `pos` (lastIndex is always set first, so
// shared regexes stay safe under re-entrant calls).
function atRe(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

function hasRe(re, str, pos) {
  re.lastIndex = pos;
  return re.test(str);
}

// First line of s (up to the first \n, or the whole string).
function firstLine(s) {
  const i = s.indexOf('\n');
  if (i === -1) return s;
  return s.slice(0, i);
}

// True when the single line is empty or only spaces/tabs.
function blankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Index of the first character that is not a space, or -1.
function nonSpaceAt(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ') return i;
  }
  return -1;
}

// Whether raw ends with a blank line: \n[ \t]*\n[ \t]*$ (marked's
// doubleBlankLine), checked without a regex.
function dblBlankEnd(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return i > 0 && raw[i - 1] === '\n';
}

// One cached indent-dependent regex per indent level (0..3).
function indentReFor(make) {
  const cache = [];
  return function (indent) {
    const idx = Math.max(0, Math.min(3, indent - 1));
    if (cache[idx] === undefined) cache[idx] = make(idx);
    return cache[idx];
  };
}

// ---------------------------------------------------------------------------
// Shared small patterns
// ---------------------------------------------------------------------------

const CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const LINK_BRACKET_ESC = /\\([\[\]])/g;
const FENCE_INDENT = /^(\s+)(?:```)/;
const LEAD_SPACE = /^\s+/;
const TRAIL_HASH = /#$/;
const LEAD_ONE_SPACE = /^ /;
const TRAIL_ONE_SPACE = / $/;
const TRAIL_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const NL_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEAD_SPACE_TAB = /^[ \t]+/;
const SPACE_RUN = /\s+/g;
const BLANK_RE = /^[ \t]*$/;
const DBL_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const QUOTE_START = /^ {0,3}>/;
const QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const QUOTE_STRIP = /^ {0,3}>[ \t]?/gm;
const QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const TASK_TEST = /^\[[ xX]\][ \t]+\S/;
const TASK_STRIP = /^\[[ xX]\][ \t]+/;
const TASK_BOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const ALIGN_TRIM = /^\||\| *$/g;
const ROW_TRAIL_BLANK = /\n[ \t]*$/;
const ALIGN_RIGHT = /^ *-+: *$/;
const ALIGN_CENTER = /^ *:-+: *$/;
const ALIGN_LEFT = /^ *:-+ *$/;
const A_OPEN = /^<a /i;
const A_CLOSE = /^<\/a>/i;
const PRE_OPEN = /^<(pre|code|kbd|script)(\s|>)/i;
const PRE_CLOSE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const ANGLE_OPEN = /^</;
const ANGLE_CLOSE = />$/;
const ALNUM_UNICODE = /[\p{L}\p{N}]/u;
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PCT25 = /%25/g;
const PIPE_FIND = /\|/g;
const PIPE_SPLIT = / \|/;
const PIPE_SLASH = /\\\|/g;
const CR_RE = /\r\n|\r/g;
const SPACES_ONLY_LINE = /^ +$/gm;
const NON_SPACE_START = /^\S*/;
const TRAIL_NL = /\n$/;

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

function listItemRe(bull) {
  return sticky(new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`));
}
const nextBulletRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)));
const hrRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)));
const fencesRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)));
const headingRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)));
const htmlRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')));
const quoteRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}>`)));

// ---------------------------------------------------------------------------
// Block grammar (GFM). Rules are assigned into the B object in dependency
// order so composed rules can name earlier ones.
// ---------------------------------------------------------------------------

const B = {};
B.newline = sticky(/^(?:[ \t]*(?:\n|$))+/);
B.code = sticky(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
B.fences = sticky(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
B.hr = sticky(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
B.heading = sticky(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);
B.bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
B.text = sticky(/^[^\n]+/);

B.lheading = sticky(compose(/^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/, [
  [/bull/g, B.bullet],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
  [/blockquote/g, / {0,3}>/],
  [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
  [/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  [/html/g, / {0,3}<[^\n>]+>\n/],
  [/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
]));

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
B.def = sticky(compose(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/, [
  ['label', BLOCK_LABEL],
  ['title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/],
]));

B.list = sticky(compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, [[/bull/g, B.bullet]]));

B.html = sticky(compose(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', [
  ['comment', COMMENT],
  ['tag', TAG],
  ['attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/],
], 'i'));

const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const TABLE_IN_PARA = compose(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', [
  ['hr', B.hr],
  ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
  ['blockquote', ' {0,3}>'],
  ['code', '(?: {4}| {0,3}\t)[^\\n]'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
  ['tag', TAG],
]);
B.paragraph = sticky(compose(PARA_CORE, [
  ['hr', B.hr],
  ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
  ['|lheading', ''],
  ['table', TABLE_IN_PARA],
  ['blockquote', ' {0,3}>'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
  ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
  ['tag', TAG],
]));

B.table = sticky(compose(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', [
  ['hr', B.hr],
  ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
  ['blockquote', ' {0,3}>'],
  ['code', '(?: {4}| {0,3}\t)[^\\n]'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
  ['tag', TAG],
]));

B.blockquote = sticky(compose(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, [
  ['paragraph', compose(PARA_CORE, [
    ['hr', B.hr],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['|lheading', ''],
    ['|table', ''],
    ['blockquote', ' {0,3}>'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/],
    ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
    ['tag', TAG],
  ])],
]));

// ---------------------------------------------------------------------------
// Inline grammar (GFM), same treatment: assigned into the I object.
// ---------------------------------------------------------------------------

const I = {};
I.escape = sticky(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/);
I.code = sticky(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
I.br = sticky(/^( {2,}|\\)\n(?!\s*$)[ \t]*/);

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM_STRONG = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM_STRONG = /(?:[^\s\p{P}\p{S}]|~)/u;
I.punctuation = compose(/^((?![*_])punctSpace)/, [[/punctSpace/g, PUNCT_OR_SPACE]], 'u');

I.blockSkip = compose(/link|precode-code|html/, [
  ['link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/],
  ['precode-', '(?<!`)()'],
  ['code', /(?<b>`+)[^`]+\k<b>(?!`)/],
  ['html', /<(?! )[^<>]*?>/],
], 'g');

I.emStrongLDelim = sticky(compose(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, [[/punct/g, PUNCT_GFM_STRONG]], 'u'));

const EM_STRONG_R_AST =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

I.emStrongRDelimAst = compose(EM_STRONG_R_AST, [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM_STRONG],
  [/punctSpace/g, PUNCT_OR_SPACE_GFM_STRONG],
  [/punct/g, PUNCT_GFM_STRONG],
], 'gu');

I.emStrongRDelimUnd = compose(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
  [/punctSpace/g, PUNCT_OR_SPACE],
  [/punct/g, PUNCT],
], 'gu'); // (5) #___# can be either Left or Right Delimiter

I.delLDelim = sticky(compose(/^~~?(?:((?!~)punct)|[^\s~])/, [[/punct/g, PUNCT]], 'u'));

const DEL_R_DELIM =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

I.delRDelim = compose(DEL_R_DELIM, [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
  [/punctSpace/g, PUNCT_OR_SPACE],
  [/punct/g, PUNCT],
], 'gu');

I.del = sticky(/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/);
I.anyPunct = compose(/\\(punct)/, [[/punct/g, PUNCT]], 'gu');
I.anyPunctOutsideCode = compose(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, [[/punct/g, PUNCT]], 'gu');

const INLINE_COMMENT = compose(COMMENT, [['(?:-->|$)', '-->']]);
I.tag = sticky(compose(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', [
  ['comment', INLINE_COMMENT],
  ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
]));

I.autolink = sticky(compose(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [
  ['scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
  ['email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/],
]));

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/, [
  ['brackets', INLINE_LABEL_BRACKETS],
]);

I.link = sticky(compose(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, [
  ['label', INLINE_LABEL],
  ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
  ['title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
]));

I.reflink = sticky(compose(/^!?\[(label)\]\[(ref)\]/, [
  ['label', INLINE_LABEL],
  ['ref', BLOCK_LABEL],
]));

I.nolink = sticky(compose(/^!?\[(ref)\](?:\[\])?/, [
  ['ref', BLOCK_LABEL],
]));

const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = compose(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/, [
  ['brackets', INLINE_LABEL_BRACKETS],
]);

I.reflinkSearch = compose('reflink|nolink(?!\\()', [
  ['reflink', compose(/^!?\[(label)\]\[(ref)\]/, [
    ['label', BOUNDED_INLINE_LABEL],
    ['ref', BOUNDED_BLOCK_LABEL],
  ])],
  ['nolink', compose(/^!?\[(ref)\](?:\[\])?/, [
    ['ref', BOUNDED_BLOCK_LABEL],
  ])],
], 'g');

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, [
  [/email/g, EXTENDED_EMAIL],
]);

I.url = sticky(compose(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, [
  ['emailProtocol', EXTENDED_EMAIL_PROTOCOL],
  ['protocol', CASE_INSENSITIVE_PROTOCOL],
  ['email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/],
]));

I.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escHtml(html, encode) {
  if (encode) {
    if (ESC_TEST.test(html)) return html.replace(ESC_REPLACE, (ch) => ESCAPE_MAP[ch]);
    return html;
  }
  if (ESC_TEST_NOENC.test(html)) return html.replace(ESC_REPLACE_NOENC, (ch) => ESCAPE_MAP[ch]);
  return html;
}

function decodeRefs(text) {
  if (!NUM_REF.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, function (ref, dec, hex) {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanHref(href) {
  try {
    return encodeURI(href).replace(PCT25, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, trimming cells and padding or
// truncating to `count` when given.
function splitCells(tableRow, count) {
  const row = tableRow.replace(PIPE_FIND, function (match, offset, str) {
    let escaped = false;
    for (let curr = offset - 1; curr >= 0 && str[curr] === '\\'; curr--) escaped = !escaped;
    if (escaped) return '|';
    return ' |';
  });
  const cells = row.split(PIPE_SPLIT);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else cells.push(...Array(count - cells.length).fill(''));
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(PIPE_SLASH, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if ((currChar === c) !== !!invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimBlankTail(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && BLANK_RE.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normLabel(label) {
  return label.trim().replace(SPACE_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function closeBracketAt(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (ch === b[0]) level++;
    else if (ch === b[1] && --level < 0) return i;
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent) {
  let col = indent || 0;
  let expanded = '';
  for (const char of line) {
    if (char !== '\t') {
      expanded += char;
      col++;
      continue;
    }
    const added = 4 - (col % 4);
    expanded += ' '.repeat(added);
    col += added;
  }
  return expanded;
}

// Last indexes of `*` / `_` / `~` runs that can close emphasis, strong or
// strikethrough: a run counts only when not preceded by ASCII whitespace
// or the start of the string. Scanned fresh per inline run (the reference
// caches this per run, and the cache never hits once the source is sliced).
function scanClosers(src) {
  const out = { star: -1, under: -1, tilde: -1 };
  const keys = { '*': 'star', '_': 'under', '~': 'tilde' };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!(ch in keys)) continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < src.length && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      out[keys[ch]] = i;
    }
    i = j - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-parse state: plain module-level bindings, reset by parse().
// ---------------------------------------------------------------------------

let links;
let linkCount;
let inLink;
let inRawBlock;
let linkEmitted;
let linkParenPossible;
let top;

function resetState() {
  links = Object.create(null);
  linkCount = 0;
  inLink = false;
  inRawBlock = false;
  linkEmitted = false;
  linkParenPossible = true;
  top = true;
}

// ---------------------------------------------------------------------------
// Block guards and token construction
// ---------------------------------------------------------------------------

// A table needs a header line and, on the next line, a delimiter row made
// only of | : - and spaces, starting with | : or -, holding at least one -
// and at least one | or :.
function isTableAt(src, pos) {
  const headEnd = src.indexOf('\n', pos);
  if (headEnd === -1) return false;
  const head = src.slice(pos, headEnd).replace(/^ +/, '');
  if (head === '') return false;
  const line2 = firstLine(src.slice(headEnd + 1));
  const delim = line2.replace(/^ {0,3}/, '');
  if (!/^[|:|-]/.test(delim)) return false;
  let dash = false;
  let pipeColon = false;
  for (const c of delim) {
    if (c === '-') dash = true;
    else if (c === '|' || c === ':') pipeColon = true;
    else if (c !== ' ') return false;
  }
  return dash && pipeColon;
}

function tok(type, raw, extra) {
  return { type, raw, ...extra };
}

function indentComp(raw, text) {
  const m = raw.match(FENCE_INDENT);
  if (m === null) return text;
  const indentToCode = m[1];
  const lines = text.split('\n');
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    const mm = lines[k].match(LEAD_SPACE);
    if (mm === null) out.push(lines[k]);
    else out.push(lines[k].slice(Math.min(mm[0].length, indentToCode.length)));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes (src, pos) and returns a token or undefined.
// Tokens carry only what the renderer needs: inline text is rendered on
// demand from the token's `text` field, never pre-tokenized.
// ---------------------------------------------------------------------------

function codeTok(src, pos) {
  const cap = atRe(B.code, src, pos);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return tok('code', raw, { text: raw.replace(CODE_INDENT, '') });
}

function fenceTok(src, pos) {
  const cap = atRe(B.fences, src, pos);
  if (!cap) return undefined;
  return tok('code', cap[0], {
    lang: cap[2] ? cap[2].trim().replace(I.anyPunct, '$1') : cap[2],
    text: indentComp(cap[0], cap[3] || ''),
  });
}

function headTok(src, pos) {
  const cap = atRe(B.heading, src, pos);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (TRAIL_HASH.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || TRAIL_SPACE_TAB.test(trimmed)) text = trimmed.trim();
  }
  return tok('heading', rtrim(cap[0], '\n'), { depth: cap[1].length, text });
}

function hrTok(src, pos) {
  const cap = atRe(B.hr, src, pos);
  if (!cap) return undefined;
  return tok('hr', rtrim(cap[0], '\n'), {});
}

function htmlTok(src, pos) {
  const cap = atRe(B.html, src, pos);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return tok('html', raw, {
    block: true,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  });
}

function defTok(src, pos) {
  const cap = atRe(B.def, src, pos);
  if (!cap) return undefined;
  if (!ANGLE_OPEN.test(cap[2]) && closeBracketAt(cap[2], '()') !== -1) return undefined;
  const tag = normLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(HREF_BRACKETS, '$1').replace(I.anyPunct, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(I.anyPunct, '$1') : cap[3];
  return tok('def', rtrim(cap[0], '\n'), { tag, href, title });
}

function tableTok(src, pos) {
  const cap = atRe(B.table, src, pos);
  if (!cap || !TABLE_DELIM.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(ALIGN_TRIM, '').split('|');
  if (headers.length !== aligns.length) return undefined;
  const rows = cap[3]?.trim() ? cap[3].replace(ROW_TRAIL_BLANK, '').split('\n') : [];
  const item = tok('table', rtrim(cap[0], '\n'), { header: [], align: [], rows: [] });
  for (let a = 0; a < aligns.length; a++) {
    const align = aligns[a];
    if (ALIGN_RIGHT.test(align)) item.align.push('right');
    else if (ALIGN_CENTER.test(align)) item.align.push('center');
    else if (ALIGN_LEFT.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let h = 0; h < headers.length; h++) {
    item.header.push({ text: headers[h], header: true, align: item.align[h] });
  }
  for (let r = 0; r < rows.length; r++) {
    const cells = splitCells(rows[r], item.header.length);
    const mapped = [];
    for (let c = 0; c < cells.length; c++) {
      mapped.push({ text: cells[c], header: false, align: item.align[c] });
    }
    item.rows.push(mapped);
  }
  return item;
}

// Setext heading: the anchored heading regex directly, no guard. (A guard
// that split the remaining input and ran a per-line regex before every
// paragraph made this path slower than the reference.)
function setextTok(src, pos) {
  const cap = atRe(B.lheading, src, pos);
  if (!cap) return undefined;
  return tok('heading', rtrim(cap[0], '\n'), {
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text: cap[1].trim(),
  });
}

function paraTok(src, pos) {
  const cap = atRe(B.paragraph, src, pos);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return tok('paragraph', cap[0], { text });
}

function textTok(src, pos) {
  const cap = atRe(B.text, src, pos);
  if (!cap) return undefined;
  return tok('text', cap[0], { text: cap[0] });
}

function quoteTok(src, pos) {
  const cap = atRe(B.blockquote, src, pos);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i = 0;
    for (; i < lines.length; i++) {
      if (QUOTE_START.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (inBlockquote) {
        break;
      } else {
        currentLines.push(lines[i]);
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(QUOTE_MARKER_WS, function (_m, marker, whitespace) {
        return marker + expandTabs(whitespace, marker.length);
      })
      .replace(QUOTE_SETEXT, '\n    $1')
      .replace(QUOTE_STRIP, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const savedTop = top;
    top = true;
    lexBlocks(currentText, tokens, true);
    top = savedTop;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    const lastType = lastToken?.type;
    if (lastType === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(QUOTE_STRIP, '');
      const newToken = quoteTok(newText, 0);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && QUOTE_START.test(lines[0])) continue;
      break;
    }
    if (lastType === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = listTok(newText, 0);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
    if (lastType === 'code' || lastType === 'heading' || lastType === 'hr'
      || lastType === 'html' || lastType === 'table') {
      break;
    }
  }
  return tok('blockquote', raw, { tokens, text });
}

function listTok(src, pos) {
  let s = src.slice(pos);
  let cap = atRe(B.list, s, 0);
  if (!cap) return undefined;
  const listSrc = s;
  const taken = () => listSrc.length - s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = tok('list', '', {
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  });
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRe(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    cap = atRe(itemRegex, s, 0);
    if (!cap) break;
    if (hasRe(B.hr, s, 0)) break;
    const itemStart = taken();
    s = s.substring(cap[0].length);
    const first = firstLine(cap[2]);
    const bulletIndent = cap[1].length;
    let line;
    if (first[0] === ' ' || first[0] === '\t') {
      line = first.replace(LEAD_SPACE_TAB, (whitespace) => expandTabs(whitespace, bulletIndent));
    } else {
      line = first;
    }
    let nextLine = firstLine(s);
    let isBlank = blankLine(line);
    let indent = 0;
    if (isBlank) {
      indent = bulletIndent + 1;
    } else {
      indent = nonSpaceAt(line);
      if (indent > 4) indent = 1;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (isBlank && BLANK_RE.test(nextLine)) {
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const bulletRe = nextBulletRe(indent);
      const hrR = hrRe(indent);
      const fencesR = fencesRe(indent);
      const headingR = headingRe(indent);
      const htmlR = htmlRe(indent);
      const quoteR = quoteRe(indent);
      const starts = [fencesR, headingR, htmlR, quoteR, bulletRe, hrR];
      const lineStarts = [fencesR, headingR, htmlR, hrR];
      const anyStarts = (res, ln) => {
        for (let k = 0; k < res.length; k++) {
          if (hasRe(res[k], ln, 0)) return true;
        }
        return false;
      };
      while (s) {
        const rawLine = firstLine(s);
        nextLine = rawLine;
        let nextLineWithoutTabs;
        if (nextLine[0] === ' ' || nextLine[0] === '\t') {
          nextLineWithoutTabs = nextLine.replace(LEAD_SPACE_TAB, (whitespace) => expandTabs(whitespace));
        } else {
          nextLineWithoutTabs = nextLine;
        }
        // Block-start guards: fences/heading/html/blockquote/bullet/hr can
        // only match when the line's first non-space char (within the
        // allowed indent) is one of their markers.
        const nonSpaceIdx = nonSpaceAt(nextLineWithoutTabs);
        if (nonSpaceIdx !== -1 && nonSpaceIdx <= indent) {
          const c = nextLineWithoutTabs[nonSpaceIdx];
          if ('`~#<>-_*+0123456789'.includes(c) && anyStarts(starts, nextLine)) break;
        }
        if (nonSpaceIdx >= indent || blankLine(nextLine)) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (isBlank) break;
          const lineNonSpace = line.indexOf('\t') === -1
            ? nonSpaceAt(line)
            : line.replace(TAB_GLOBAL, '    ').search(NON_SPACE);
          if (lineNonSpace >= 4) break;
          const lineNonSpaceIdx = nonSpaceAt(line);
          if (lineNonSpaceIdx !== -1) {
            const lc = line[lineNonSpaceIdx];
            if ('`~#<-_*'.includes(lc) && anyStarts(lineStarts, line)) break;
          }
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && hasRe(B.lheading, `${line}\n${nextLine}`, 0);
          let continuation;
          if (setextContinuation) continuation = `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`;
          else continuation = nextLine;
          itemContents += '\n' + continuation;
        }
        isBlank = blankLine(nextLine);
        s = s.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (dblBlankEnd(raw)) endsWithBlankLine = true;
    }
    list.items.push(tok('list_item', raw, {
      task: !!TASK_TEST.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    }));
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (let q = 0; q < list.items.length; q++) {
    const item = list.items[q];
    top = false;
    item.tokens = lexBlocks(item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      let hasMultipleLineBreaks = false;
      for (let w = 0; w < spacers.length; w++) {
        if (ANY_LINE.test(spacers[w].raw)) { hasMultipleLineBreaks = true; break; }
      }
      if (spacers.length > 0 && hasMultipleLineBreaks) list.loose = true;
    }
  }
  for (let q = 0; q < list.items.length; q++) {
    const item = list.items[q];
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(TASK_STRIP, '');
      itemToken.raw = itemToken.raw.replace(TASK_STRIP, '');
      itemToken.text = itemToken.text.replace(TASK_STRIP, '');
      const taskRaw = TASK_BOX.exec(item.raw);
      if (taskRaw) {
        item.checked = taskRaw[0] !== '[ ]';
        item.checkboxRaw = taskRaw[0] + ' ';
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (let q = 0; q < list.items.length; q++) {
      const item = list.items[q];
      item.loose = true;
      for (let w = 0; w < item.tokens.length; w++) {
        if (item.tokens[w].type === 'text') item.tokens[w].type = 'paragraph';
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Block lexer: a switch on the first non-space character. Each case chains
// its candidate rules with || in the reference order; the first rule that
// matches wins. Returns [token, kind] so the lexer can merge paragraph,
// text, code and definition tokens the way the reference does.
// ---------------------------------------------------------------------------

function tableTry(src, pos) {
  if (!isTableAt(src, pos)) return undefined;
  return tableTok(src, pos);
}

function paraTry(src, pos) {
  if (!top) return undefined;
  return paraTok(src, pos);
}

function kindOf(t) {
  // Fenced code also has type 'code', but unlike indented code it must
  // never merge into a preceding paragraph: it carries a `lang` field,
  // indented code does not.
  if (t.type === 'code') return 'lang' in t ? 'fences' : 'code';
  if (t.type === 'def') return 'def';
  if (t.type === 'paragraph') return 'paragraph';
  if (t.type === 'text') return 'text';
  if (t.type === 'list') return 'list';
  return t.type;
}

function blockToken(src, pos) {
  let indent = 0;
  while (src[pos + indent] === ' ') indent++;
  const c = src[pos + indent];
  // Indented code outranks everything when the indent reaches 4, and a
  // tab first character is code too; digits always try the list first.
  if (c === '\t' || indent >= 4) {
    const t = codeTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
      || paraTry(src, pos) || textTok(src, pos);
    if (t) return [t, kindOf(t)];
    return [undefined, ''];
  }
  if (c >= '0' && c <= '9') {
    const t = listTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
      || paraTry(src, pos) || textTok(src, pos);
    if (t) return [t, kindOf(t)];
    return [undefined, ''];
  }
  let t;
  switch (c) {
    case '#':
      t = headTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
    case '>':
      t = quoteTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
    case '`':
    case '~':
      t = fenceTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
    case '-':
    case '+':
    case '*':
      t = hrTok(src, pos) || listTok(src, pos) || tableTry(src, pos)
        || setextTok(src, pos) || paraTry(src, pos) || textTok(src, pos);
      break;
    case '_':
      t = hrTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
    case '<':
      t = htmlTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
    case '[':
      t = defTok(src, pos) || tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
    default:
      t = tableTry(src, pos) || setextTok(src, pos)
        || paraTry(src, pos) || textTok(src, pos);
      break;
  }
  if (!t) return [undefined, ''];
  return [t, kindOf(t)];
}

function lexBlocks(src, tokens, lastParagraphClipped) {
  if (!tokens) tokens = [];
  lastParagraphClipped = !!lastParagraphClipped;
  let pos = 0;
  const len = src.length;
  let prevRemaining = Infinity;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining >= prevRemaining) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    prevRemaining = remaining;

    let j = pos;
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (src[j] === '\n' || j >= len) {
      const cap = atRe(B.newline, src, pos);
      const raw = cap[0];
      pos += raw.length;
      const last = tokens[tokens.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok('space', raw, {}));
      continue;
    }

    const pair = blockToken(src, pos);
    const token = pair[0];
    const kind = pair[1];
    if (!token) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    pos += token.raw.length;
    const last = tokens[tokens.length - 1];
    if (kind === 'code') {
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
      } else tokens.push(token);
    } else if (kind === 'def') {
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.raw;
      } else {
        if (!Object.hasOwn(links, token.tag)) {
          links[token.tag] = { href: token.href, title: token.title };
          linkCount++;
        }
        tokens.push(token);
      }
    } else if (kind === 'paragraph') {
      if (lastParagraphClipped && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
      } else tokens.push(token);
      lastParagraphClipped = false;
    } else if (kind === 'text') {
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
      } else tokens.push(token);
    } else {
      tokens.push(token);
    }
  }
  top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline rendering. renderInline(src, textOnly) renders one inline run to
// HTML (textOnly: plain text, as the reference's TextRenderer does, used
// for image alt text). No token tree is built: structural rules are
// dispatched on their first character and plain-text runs are consumed by
// one scan. Inline rules return [html, length] pairs.
// ---------------------------------------------------------------------------

function hasLinkIn(text) {
  if (!text.includes('[')) return false;
  const direct = [...text.matchAll(I.blockSkip)].some(function (m) {
    return hasRe(I.link, m[0], 0) && text.charAt(m.index - 1) !== '!';
  });
  if (direct) return true;
  return [...text.matchAll(I.reflinkSearch)].some(function (m) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!') return false;
    if (!Object.hasOwn(links, normLabel(m0.slice(refStart + 1, -1)))) return false;
    if (refStart > 1 && hasLinkIn(m0.slice(1, refStart - 1))) return false;
    return true;
  });
}

function maskReflink(m0) {
  const refStart = m0.lastIndexOf('[');
  if (!Object.hasOwn(links, normLabel(m0.slice(refStart + 1, -1)))) return m0;
  if (refStart > 1 && m0.charAt(0) !== '!') {
    const text = m0.slice(1, refStart - 1);
    if (hasLinkIn(text)) {
      return '[' + text.replace(I.reflinkSearch, maskReflink)
        + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m0.length - 2) + ']';
}

function maskSrc(src) {
  let masked = src;
  if (src.includes('[') && linkCount > 0) masked = masked.replace(I.reflinkSearch, maskReflink);
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(I.anyPunctOutsideCode, function (m0, code, punct) {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(I.blockSkip, function (m0, _link, context) {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// One inline run's masked source and closer scan, computed lazily and
// shared by every opener in the run.
class Run {
  constructor(src) {
    this.src = src;
    this.masked = null;
    this.closers = null;
  }

  mask() {
    if (this.masked === null) this.masked = maskSrc(this.src);
    return this.masked;
  }

  closerScan() {
    if (this.closers === null) this.closers = scanClosers(this.mask());
    return this.closers;
  }
}

function labelEndInTag(src, label, labelStart) {
  if (!label.includes('<')) return false;
  let i = 0;
  while (i < label.length) {
    const ch = label[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const code = atRe(I.code, label, i);
      if (code) { i += code[0].length; continue; }
    }
    if (ch !== '<') { i++; continue; }
    const token = atRe(I.tag, src.slice(labelStart + i), 0) || atRe(I.autolink, src.slice(labelStart + i), 0);
    if (token) {
      if (token[0].length > label.length - i) return true;
      i += token[0].length;
      continue;
    }
    i++;
  }
  return false;
}

function linkTag(href, title, inner, autolink) {
  const clean = cleanHref(href);
  if (clean === null) return inner;
  const safe = escHtml(clean, autolink);
  let out = '<a href="' + safe + '"';
  if (title) out += ' title="' + escHtml(title) + '"';
  return out + '>' + inner + '</a>';
}

// Builds a link or image from a matched [label](href "title") /
// [label][ref] / [label] form. Returns [html, length] or null when the
// outer link must fall through to plain text (a link inside a link's
// label).
function makeLink(cap, link, textOnly) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(LINK_BRACKET_ESC, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = inLink;
  const savedEmitted = linkEmitted;
  const savedRaw = inRawBlock;
  inLink = true;
  linkEmitted = false;
  const inner = renderInline(text, isImage ? true : textOnly);
  const textHasLink = linkEmitted;
  linkEmitted = savedEmitted;
  inLink = savedInLink;
  if (isImage) {
    const altText = inner;
    if (textOnly) return [altText, cap[0].length];
    const clean = cleanHref(href);
    if (clean === null) return [escHtml(altText), cap[0].length];
    let html = `<img src="${escHtml(clean)}" alt="${escHtml(altText)}"`;
    if (title) html += ` title="${escHtml(title)}"`;
    return [html + '>', cap[0].length];
  }
  if (textHasLink) {
    inRawBlock = savedRaw;
    return null;
  }
  linkEmitted = true;
  if (textOnly) return [inner, cap[0].length];
  return [linkTag(href, title, inner, false), cap[0].length];
}

function tryEscape(src, pos, textOnly) {
  const cap = atRe(I.escape, src, pos);
  if (!cap) return null;
  if (textOnly) return [cap[1], cap[0].length];
  return [escHtml(cap[1]), cap[0].length];
}

function tryTag(src, pos) {
  const cap = atRe(I.tag, src, pos);
  if (!cap) return null;
  if (!inLink && hasRe(A_OPEN, cap[0], 0)) inLink = true;
  else if (inLink && hasRe(A_CLOSE, cap[0], 0)) inLink = false;
  if (!inRawBlock && hasRe(PRE_OPEN, cap[0], 0)) inRawBlock = true;
  else if (inRawBlock && hasRe(PRE_CLOSE, cap[0], 0)) inRawBlock = false;
  return [cap[0], cap[0].length];
}

function tryCode(src, pos, textOnly) {
  const cap = atRe(I.code, src, pos);
  if (!cap) return null;
  let text = cap[2].replace(NL_GLOBAL, ' ');
  const trimBoth = NON_SPACE.test(text) && LEAD_ONE_SPACE.test(text) && TRAIL_ONE_SPACE.test(text);
  if (trimBoth) text = text.substring(1, text.length - 1);
  if (textOnly) return [text, cap[0].length];
  return ['<code>' + escHtml(text, true) + '</code>', cap[0].length];
}

function tryBreak(src, pos, textOnly) {
  const cap = atRe(I.br, src, pos);
  if (!cap) return null;
  if (textOnly) return ['', cap[0].length];
  return ['<br>', cap[0].length];
}

function tryAuto(src, pos, textOnly) {
  const cap = atRe(I.autolink, src, pos);
  if (!cap) return null;
  const isMail = cap[2] === '@';
  const text = cap[1];
  const href = isMail ? 'mailto:' + text : text;
  if (textOnly) return [text, cap[0].length];
  return [linkTag(href, null, escHtml(text, true), true), cap[0].length];
}

function tryUrl(src, pos, textOnly) {
  const cap = atRe(I.url, src, pos);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      const bp = I.backpedal.exec(cap[0]);
      cap[0] = bp ? bp[0] : '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (textOnly) return [text, cap[0].length];
  return [linkTag(href, null, escHtml(text, true), true), cap[0].length];
}

function tryLink(src, pos, textOnly) {
  if (linkParenPossible === false) return null;
  const cap = atRe(I.link, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && labelEndInTag(src.slice(pos), cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (ANGLE_OPEN.test(trimmedUrl)) {
    if (!ANGLE_CLOSE.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = closeBracketAt(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (ANGLE_OPEN.test(href)) href = href.slice(1, -1);
  return makeLink(cap, {
    href: href ? href.replace(I.anyPunct, '$1') : href,
    title: title ? title.replace(I.anyPunct, '$1') : title,
  }, textOnly);
}

function tryRef(src, pos, textOnly) {
  const cap = atRe(I.reflink, src, pos) ?? atRe(I.nolink, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && labelEndInTag(src.slice(pos), cap[1], labelStart)) return null;
  const link = links[normLabel(cap[2] || cap[1])];
  if (!link) return [cap[0].charAt(0), 1];
  return makeLink(cap, link, textOnly);
}

// Walk every right-delimiter match of `re` over `text` in order, calling
// `fn` on each until it returns a non-undefined value (which is returned)
// or the match index passes `lastInWindow`. Lazy: matches after the one
// the caller uses are never produced.
function walkDelims(re, text, lastInWindow, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastInWindow) break;
    const out = fn(m);
    if (out === false) return undefined;
    if (out !== undefined) return out;
  }
  return undefined;
}

function tryEm(src, pos, prevChar, run, textOnly) {
  const match = atRe(I.emStrongLDelim, src, pos);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  if (delimChar !== '*' && delimChar !== '_') return null;
  const midRun = prevChar === delimChar;
  const maskedSrc = run.mask();
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  let runPrevChar = '';
  if (runStart > 0) {
    const i = runStart - 1;
    const c = maskedSrc[i];
    const low = c >= '\uDC00' && c <= '\uDFFF';
    if (low && i > 0 && maskedSrc[i - 1] >= '\uD800' && maskedSrc[i - 1] <= '\uDBFF') {
      runPrevChar = maskedSrc[i - 1] + c;
    } else {
      runPrevChar = c;
    }
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!I.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!I.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(ALNUM_UNICODE)) return null;
  const nextChar = match[1] || match[3] || '';
  if (nextChar && prevChar && !prevPunct) return null;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  const runLength = srcStart - runStart + lLength;
  const openerCanClose = !!runPrevChar.trim()
    && (!!nextChar || (delimChar === '*' && !runPrevPunct));
  const endReg = delimChar === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
  const closers = run.closerScan();
  const lastPossible = delimChar === '*' ? closers.star : closers.under;
  const windowStart = pos + lLength;
  if (lastPossible < windowStart) return null;
  const masked = run.mask().slice(pos + lLength);
  const lastInWindow = lastPossible - windowStart;
  let delimTotal = lLength;
  let midDelimTotal = 0;
  return walkDelims(endReg, masked, lastInWindow, function (m) {
    const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!rDelim) return undefined;
    const rLength = rDelim.length;
    if (m[3] || m[4]) { delimTotal += rLength; return undefined; }
    if (m[5] || m[6] || openerCanClose) {
      if (midRun && (m[5] || m[6])) return false;
      if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; return undefined; }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) return undefined;
    const useLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + useLength);
    if (Math.min(lLength, useLength) % 2) {
      const inner = renderInline(raw.slice(1, -1), textOnly);
      if (textOnly) return [inner, raw.length];
      return [`<em>${inner}</em>`, raw.length];
    }
    const inner = renderInline(raw.slice(2, -2), textOnly);
    if (textOnly) return [inner, raw.length];
    return [`<strong>${inner}</strong>`, raw.length];
  }) ?? null;
}

function tryDel(src, pos, prevChar, run, textOnly) {
  const match = atRe(I.delLDelim, src, pos);
  if (!match) return null;
  const nextChar = match[1] || '';
  // An opener can open at the start of a run, after punctuation, or when
  // there is no next character; it cannot open between two non-punctuation
  // characters.
  if (nextChar && prevChar && !I.punctuation.exec(prevChar)) return null;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  const closers = run.closerScan();
  const windowStart = pos + lLength;
  if (closers.tilde < windowStart) return null;
  const masked = run.mask().slice(pos + lLength);
  const lastInWindow = closers.tilde - windowStart;
  let delimTotal = lLength;
  const found = walkDelims(I.delRDelim, masked, lastInWindow, function (m) {
    const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!rDelim) return undefined;
    const rLength = rDelim.length;
    if (rLength !== lLength) return undefined;
    if (m[3] || m[4]) { delimTotal += rLength; return undefined; }
    delimTotal -= rLength;
    if (delimTotal > 0) return undefined;
    const useLength = Math.min(rLength, rLength + delimTotal);
    const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + useLength);
    const inner = renderInline(raw.slice(lLength, -lLength), textOnly);
    if (textOnly) return [inner, raw.length];
    return [`<del>${inner}</del>`, raw.length];
  });
  return found ?? null;
}

// Could a URL (extended autolink) start at pos? Covers www., http(s)://,
// ftp://, mailto:, xmpp: and bare email addresses. The check is a superset
// of the matcher's: a false positive only costs a failed regex attempt.
function urlStartAt(src, pos) {
  const c = src.charCodeAt(pos);
  if (c === 119) { // w
    if (src[pos + 1] === 'w' && src[pos + 2] === 'w' && src[pos + 3] === '.') return true;
  } else if (c === 104 || c === 72 || c === 102 || c === 70) { // h H f F
    const s = src.slice(pos, pos + 8).toLowerCase();
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) return true;
  } else if (c === 109) { // m
    if (src.startsWith('mailto:', pos)) return true;
  } else if (c === 120) { // x
    if (src.startsWith('xmpp:', pos)) return true;
  }
  const atIdx = src.indexOf('@', pos);
  if (atIdx === -1) return false;
  for (let k = pos; k < atIdx; k++) {
    const cc = src.charCodeAt(k);
    const ok = (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
      || cc === 46 || cc === 95 || cc === 43 || cc === 45;
    if (!ok) return false;
  }
  return true;
}

function emailLocalChar(ch) {
  const cc = ch.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
    || cc === 46 || cc === 95 || cc === 43 || cc === 45;
}

function renderInline(src, textOnly) {
  const run = new Run(src);
  const prevParen = linkParenPossible;
  linkParenPossible = prevParen && src.includes(')');
  try {
    return renderInlineGo(src, run, textOnly);
  } finally {
    linkParenPossible = prevParen;
  }
}

function renderInlineGo(src, run, textOnly) {
  let out = '';
  let pos = 0;
  const len = src.length;
  let keepPrevChar = false;
  let prevChar = '';
  let prevRemaining = Infinity;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining >= prevRemaining) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    prevRemaining = remaining;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[pos];
    let r = null;
    if (ch === '\\') {
      r = tryEscape(src, pos, textOnly);
      if (!r) r = tryBreak(src, pos, textOnly);
    } else if (ch === '<') {
      r = tryTag(src, pos);
      if (!r) r = tryAuto(src, pos, textOnly);
    } else if (ch === '[' || ch === '!') {
      r = tryLink(src, pos, textOnly);
      if (!r) r = tryRef(src, pos, textOnly);
    } else if (ch === '*' || ch === '_') {
      r = tryEm(src, pos, prevChar, run, textOnly);
      // The URL rule runs before text for every position: an email can
      // start with _ (narrow local set), so try it once emphasis fails.
      if (!r && ch === '_' && !inLink && urlStartAt(src, pos)) r = tryUrl(src, pos, textOnly);
    } else if (ch === '`') {
      r = tryCode(src, pos, textOnly);
    } else if (ch === '~') {
      r = tryDel(src, pos, prevChar, run, textOnly);
    } else if (ch === ' ') {
      r = tryBreak(src, pos, textOnly);
    } else if (!inLink && emailLocalChar(ch) && urlStartAt(src, pos)) {
      r = tryUrl(src, pos, textOnly);
    }
    if (r) {
      out += r[0];
      pos += r[1];
      continue;
    }
    const stop = textStop(src, pos);
    const rawText = src.slice(pos, stop);
    const decoded = inRawBlock ? rawText : decodeRefs(rawText);
    if (textOnly) out += decoded;
    else if (inRawBlock) out += decoded;
    else out += escHtml(decoded);
    if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
    keepPrevChar = true;
    pos += rawText.length;
  }
  return out;
}

// GFM inline text: stops before structural characters, hard breaks,
// autolinkable protocols / www. / email starts. The scan is split in two
// independent passes so neither stop can hide the other:
//  - cheapStop finds the first structural char, 2+ spaces before \n, or
//    protocol / www. / mailto: / xmpp: start, mirroring the reference's
//    lazy text regex;
//  - emailStopAt finds the earliest start of an email-local run that
//    reaches an @;
//  - textStop returns the smaller of the two (or the end of the string).
// The first character (or a run of ` / ~) is always consumed. www. only
// counts after whitespace / * / _ / ~ / ( or at the start; mailto:/xmpp:
// only after a non-alphanumeric char the lazy part can consume, and
// mailto: at exactly minEnd is only a stop when the run started with a
// single character (a ` / ~ run of 2+ consumes the run first).
const STRUCT_CHARS = '\\`<[!*_~';

function isEmailLocalCode(cc) {
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
    || cc === 46 || cc === 33 || cc === 35 || cc === 36 || cc === 37 || cc === 38
    || cc === 39 || cc === 42 || cc === 43 || cc === 47 || cc === 61 || cc === 63
    || cc === 96 || cc === 123 || cc === 124 || cc === 125 || cc === 126
    || cc === 45 || cc === 95;
}

function cheapStop(src, pos, minEnd) {
  const len = src.length;
  for (let i = minEnd; i < len; i++) {
    const ch = src[i];
    if (STRUCT_CHARS.includes(ch)) return i;
    if (ch === ' ' && src[i + 1] === ' ') {
      let j = i + 2;
      while (src[j] === ' ') j++;
      if (src[j] === '\n') return i;
      continue;
    }
    if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
      const s = src.slice(i, i + 8).toLowerCase();
      if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) return i;
      continue;
    }
    if (ch === 'w' && src.startsWith('www.', i)) {
      const prev = i === 0 ? '' : src[i - 1];
      if (prev === '' || ' \t\n\r\f\v*_~('.includes(prev)) return i;
      continue;
    }
    if ((ch === 'm' && src.startsWith('mailto:', i)) || (ch === 'x' && src.startsWith('xmpp:', i))) {
      const prev = i === 0 ? '' : src[i - 1];
      const prevAlnum = prev !== '' && /[a-zA-Z0-9]/.test(prev);
      if (!prevAlnum && prev !== '') {
        if (i === minEnd && minEnd !== pos + 1) continue;
        return i;
      }
    }
  }
  return null;
}

function emailStopAt(src, pos, minEnd, cheap) {
  const len = src.length;
  let localStart = pos;
  for (let i = minEnd; i < len; i++) {
    const ch = src[i];
    if (ch === '@') {
      if (localStart < i) {
        const s = localStart < minEnd ? minEnd : localStart;
        if (s < i) return s;
      }
      // A later @ can only help if its local run starts at or before
      // the cheap stop; once the run start passes it, stop scanning.
      if (cheap !== null && i + 1 > cheap) return null;
      localStart = i + 1;
      continue;
    }
    if (!isEmailLocalCode(src.charCodeAt(i))) {
      localStart = i + 1;
      if (cheap !== null && localStart > cheap) return null;
    }
  }
  return null;
}

function textStop(src, pos) {
  const len = src.length;
  let minEnd = pos + 1;
  const c0 = src[pos];
  if (c0 === '`' || c0 === '~') {
    while (minEnd < len && src[minEnd] === c0) minEnd++;
  }
  const cheap = cheapStop(src, pos, minEnd);
  const email = emailStopAt(src, pos, minEnd, cheap);
  if (cheap === null) return email === null ? len : email;
  if (email === null) return cheap;
  return email < cheap ? email : cheap;
}

// ---------------------------------------------------------------------------
// Block rendering, through a dispatch object of methods, one per token
// type. Output is assembled with an explicit loop into a parts array.
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  if (checked) return '<input checked="" disabled="" type="checkbox"> ';
  return '<input disabled="" type="checkbox"> ';
}

function cellHtml(cell) {
  inRawBlock = false;
  const content = renderInline(cell.text, false);
  const type = cell.header ? 'th' : 'td';
  let open = `<${type}`;
  if (cell.align) open += ` align="${cell.align}"`;
  return open + '>' + content + `</${type}>\n`;
}

function tableHtml(token) {
  const headParts = [];
  for (let h = 0; h < token.header.length; h++) headParts.push(cellHtml(token.header[h]));
  const headCells = headParts.join('');
  let body = '';
  for (let r = 0; r < token.rows.length; r++) {
    const rowParts = [];
    for (let c = 0; c < token.rows[r].length; c++) rowParts.push(cellHtml(token.rows[r][c]));
    body += `<tr>\n${rowParts.join('')}</tr>\n`;
  }
  let out = '<table>\n<thead>\n<tr>\n' + headCells + '</tr>\n</thead>\n';
  if (body) out += `<tbody>${body}</tbody>`;
  return out + '</table>\n';
}

function itemHtml(item, listLoose) {
  if (!item.task) return `<li>${renderTokens(item.tokens)}</li>\n`;
  const box = checkboxHtml(item.checked);
  if (!listLoose) return `<li>${box}${renderTokens(item.tokens)}</li>\n`;
  const first = item.tokens[0];
  if (first?.type === 'paragraph') {
    inRawBlock = false;
    const firstHtml = renderInline(first.text, false);
    const parts = [`<li><p>${box}`, firstHtml, '</p>\n'];
    for (let k = 1; k < item.tokens.length; k++) parts.push(RENDER[item.tokens[k].type](item.tokens[k]));
    parts.push('</li>\n');
    return parts.join('');
  }
  return `<li><p>${box}</p>\n${renderTokens(item.tokens)}</li>\n`;
}

function listHtml(token) {
  const type = token.ordered ? 'ol' : 'ul';
  let open = '<' + type;
  if (token.ordered && token.start !== 1) open += ' start="' + token.start + '"';
  const parts = [open + '>\n'];
  for (let q = 0; q < token.items.length; q++) parts.push(itemHtml(token.items[q], token.loose));
  parts.push('</' + type + '>\n');
  return parts.join('');
}

const RENDER = {
  space(token) {
    return '';
  },
  hr(token) {
    return '<hr>\n';
  },
  heading(token) {
    inRawBlock = false;
    return `<h${token.depth}>${renderInline(token.text, false)}</h${token.depth}>\n`;
  },
  code(token) {
    const langString = (token.lang || '').match(NON_SPACE_START)?.[0];
    const code = token.text ? token.text.replace(TRAIL_NL, '') + '\n' : '';
    if (!langString) return '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
    return '<pre><code class="language-' + escHtml(langString) + '">'
      + escHtml(code, true) + '</code></pre>\n';
  },
  table(token) {
    return tableHtml(token);
  },
  blockquote(token) {
    return `<blockquote>\n${renderTokens(token.tokens)}</blockquote>\n`;
  },
  list(token) {
    return listHtml(token);
  },
  html(token) {
    return token.text;
  },
  def(token) {
    return '';
  },
  paragraph(token) {
    inRawBlock = false;
    return `<p>${renderInline(token.text, false)}</p>\n`;
  },
  text(token) {
    inRawBlock = false;
    return renderInline(token.text, false);
  },
};

function renderTokens(tokens) {
  const parts = [];
  for (let k = 0; k < tokens.length; k++) {
    const fn = RENDER[tokens[k].type];
    if (!fn) throw new Error('Token with "' + tokens[k].type + '" type was not found.');
    parts.push(fn(tokens[k]));
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  resetState();
  const src = markdown.replace(CR_RE, '\n');
  return renderTokens(lexBlocks(src, []));
}

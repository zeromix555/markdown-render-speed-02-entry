// Fast Markdown renderer: parse(markdown) returns exactly the HTML that
// marked 18.1.3 renders with its default options (GFM on, breaks off,
// pedantic off, async off). Dependency-free ES module.
//
// This build takes a different shape from the usual transliteration:
// - a single module-level context object, reset by parse() on every call;
// - arrow-function helpers throughout, no lexer/parser/renderer classes;
// - block dispatch through a per-first-character candidate table instead of
//   a long if/else chain, and inline dispatch through a switch;
// - inline rendering writes HTML straight out of the scanner instead of
//   building a token tree; plain-text runs are consumed by one scan;
// - the emphasis / strikethrough closer scan is a generator, and the text
//   stop scanner is a single character loop with explicit state.

'use strict';

// ---------------------------------------------------------------------------
// Regex construction helpers
// ---------------------------------------------------------------------------

// Build a regex from a string or regex, substituting each [pattern, value]
// pair in order. Values have their ^ anchors stripped the way the reference
// grammar's composer does (a ^ survives only right after '[').
const compose = (template, subs, flags) => {
  let source = typeof template === 'string' ? template : template.source;
  for (const [name, val] of subs) {
    let valSource = typeof val === 'string' ? val : val.source;
    valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
    source = source.replace(name, valSource);
  }
  return new RegExp(source, flags || '');
};

// Turn an anchored (^...) regex into a sticky one that matches at an index
// inside a longer string. The ^ anchor cannot stay: with the sticky flag it
// would only match at index 0. The sticky flag itself is the anchor.
// Written as a character scan: a ^ is dropped when it is not escaped, not
// inside a character class, and sits at the start or right after |, ( or :.
const mkSticky = (re) => {
  const src = re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      out += ch + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    if (ch === '^' && !inClass) {
      const prev = i === 0 ? '' : src[i - 1];
      if (prev === '' || prev === '|' || prev === '(' || prev === ':') continue;
    }
    out += ch;
  }
  const flags = re.flags.replace('g', '').replace('y', '') + 'y';
  return new RegExp(out, flags);
};

// Execute a sticky regex at `pos` (lastIndex is always set first, so shared
// regexes stay safe under re-entrant calls).
const atRe = (re, str, pos) => {
  re.lastIndex = pos;
  return re.exec(str);
};

const hasRe = (re, str, pos) => {
  re.lastIndex = pos;
  return re.test(str);
};

// First line of s (up to the first \n, or the whole string).
const firstLine = (s) => {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
};

// True when the single line is empty or only spaces/tabs.
const blankLine = (line) => {
  for (const c of line) if (c !== ' ' && c !== '\t') return false;
  return true;
};

// Index of the first character that is not a space, or -1.
const nonSpaceAt = (line) => {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ') return i;
  return -1;
};

// Whether raw ends with a blank line: \n[ \t]*\n[ \t]*$ (marked's
// doubleBlankLine), checked without a regex.
const dblBlankEnd = (raw) => {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return i > 0 && raw[i - 1] === '\n';
};

// One cached indent-dependent regex per indent level (0..3).
const indentReFor = (make) => {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    return (cache[idx] ??= make(idx));
  };
};

// ---------------------------------------------------------------------------
// Shared small patterns, one const each
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

const listItemRe = (bull) => mkSticky(new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`));
const nextBulletRe = indentReFor((i) => mkSticky(new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)));
const hrRe = indentReFor((i) => mkSticky(new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)));
const fencesRe = indentReFor((i) => mkSticky(new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)));
const headingRe = indentReFor((i) => mkSticky(new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)));
const htmlRe = indentReFor((i) => mkSticky(new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')));
const quoteRe = indentReFor((i) => mkSticky(new RegExp(`^ {0,${i}}>`)));

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const R_NEWLINE = mkSticky(/^(?:[ \t]*(?:\n|$))+/);
const R_BLOCK_CODE = mkSticky(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
const R_FENCES = mkSticky(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
const R_HR = mkSticky(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
const R_HEADING = mkSticky(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const R_BLOCK_TEXT = mkSticky(/^[^\n]+/);

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const R_LHEADING = mkSticky(compose(LHEADING_CORE, [
  [/bull/g, BULLET],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
  [/blockquote/g, / {0,3}>/],
  [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
  [/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  [/html/g, / {0,3}<[^\n>]+>\n/],
  [/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
]));

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const R_DEF = mkSticky(compose(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/, [
  ['label', BLOCK_LABEL],
  ['title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/],
]));

const R_LIST = mkSticky(compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, [[/bull/g, BULLET]]));

const R_HTML = mkSticky(compose(
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

const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const TABLE_IN_PARA = compose(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', [
  ['hr', R_HR],
  ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
  ['blockquote', ' {0,3}>'],
  ['code', '(?: {4}| {0,3}\t)[^\\n]'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
  ['tag', TAG],
]);
const R_PARAGRAPH = mkSticky(compose(PARAGRAPH_CORE, [
  ['hr', R_HR],
  ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
  ['|lheading', ''],
  ['table', TABLE_IN_PARA],
  ['blockquote', ' {0,3}>'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
  ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
  ['tag', TAG],
]));

const R_TABLE = mkSticky(compose(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', [
  ['hr', R_HR],
  ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
  ['blockquote', ' {0,3}>'],
  ['code', '(?: {4}| {0,3}\t)[^\\n]'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
  ['tag', TAG],
]));

const R_BLOCKQUOTE = mkSticky(compose(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, [
  ['paragraph', compose(PARAGRAPH_CORE, [
    ['hr', R_HR],
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
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const R_ESCAPE = mkSticky(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/);
const R_INLINE_CODE = mkSticky(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
const R_BR = mkSticky(/^( {2,}|\\)\n(?!\s*$)[ \t]*/);

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM_STRONG = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM_STRONG = /(?:[^\s\p{P}\p{S}]|~)/u;
const R_PUNCTUATION = compose(/^((?![*_])punctSpace)/, [[/punctSpace/g, PUNCT_OR_SPACE]], 'u');

const BLOCK_SKIP = compose(/link|precode-code|html/, [
  ['link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/],
  ['precode-', '(?<!`)()'],
  ['code', /(?<b>`+)[^`]+\k<b>(?!`)/],
  ['html', /<(?! )[^<>]*?>/],
], 'g');

const EM_STRONG_L_DELIM_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const R_EM_STRONG_L_DELIM = mkSticky(compose(EM_STRONG_L_DELIM_CORE, [[/punct/g, PUNCT_GFM_STRONG]], 'u'));

const EM_STRONG_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const R_EM_STRONG_R_DELIM_AST = compose(EM_STRONG_R_DELIM_AST_CORE, [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM_STRONG],
  [/punctSpace/g, PUNCT_OR_SPACE_GFM_STRONG],
  [/punct/g, PUNCT_GFM_STRONG],
], 'gu');

const R_EM_STRONG_R_DELIM_UND = compose(
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

const R_DEL_L_DELIM = mkSticky(compose(/^~~?(?:((?!~)punct)|[^\s~])/, [[/punct/g, PUNCT]], 'u'));

const DEL_R_DELIM_CORE =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const R_DEL_R_DELIM = compose(DEL_R_DELIM_CORE, [
  [/notPunctSpace/g, NOT_PUNCT_OR_SPACE],
  [/punctSpace/g, PUNCT_OR_SPACE],
  [/punct/g, PUNCT],
], 'gu');

const R_DEL = mkSticky(/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/);

const R_ANY_PUNCT = compose(/\\(punct)/, [[/punct/g, PUNCT]], 'gu');

const R_ANY_PUNCT_OUTSIDE_CODE = compose(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, [[/punct/g, PUNCT]], 'gu');

const INLINE_COMMENT = compose(COMMENT, [['(?:-->|$)', '-->']]);
const R_TAG = mkSticky(compose(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', [
  ['comment', INLINE_COMMENT],
  ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
]));

const R_AUTOLINK = mkSticky(compose(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [
  ['scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
  ['email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/],
]));

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/, [
  ['brackets', INLINE_LABEL_BRACKETS],
]);

const R_LINK = mkSticky(compose(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, [
  ['label', INLINE_LABEL],
  ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
  ['title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
]));

const R_REFLINK = mkSticky(compose(/^!?\[(label)\]\[(ref)\]/, [
  ['label', INLINE_LABEL],
  ['ref', BLOCK_LABEL],
]));

const R_NOLINK = mkSticky(compose(/^!?\[(ref)\](?:\[\])?/, [
  ['ref', BLOCK_LABEL],
]));

const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = compose(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/, [
  ['brackets', INLINE_LABEL_BRACKETS],
]);

const R_REFLINK_SEARCH = compose('reflink|nolink(?!\\()', [
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

const R_URL = mkSticky(compose(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, [
  ['emailProtocol', EXTENDED_EMAIL_PROTOCOL],
  ['protocol', CASE_INSENSITIVE_PROTOCOL],
  ['email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/],
]));

const R_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escHtml = (html, encode) => {
  if (encode) return ESC_TEST.test(html) ? html.replace(ESC_REPLACE, (ch) => ESCAPE_MAP[ch]) : html;
  return ESC_TEST_NOENC.test(html) ? html.replace(ESC_REPLACE_NOENC, (ch) => ESCAPE_MAP[ch]) : html;
};

const decodeRefs = (text) => {
  if (!NUM_REF.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
};

const cleanHref = (href) => {
  try {
    return encodeURI(href).replace(PCT25, '%');
  } catch {
    return null;
  }
};

// Split a table row on unescaped pipes, trimming cells and padding/truncating
// to `count` when given.
const splitCells = (tableRow, count) => {
  const row = tableRow.replace(PIPE_FIND, (match, offset, str) => {
    let escaped = false;
    for (let curr = offset - 1; curr >= 0 && str[curr] === '\\'; curr--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(PIPE_SPLIT);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    cells.length > count ? cells.splice(count) : cells.push(...Array(count - cells.length).fill(''));
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(PIPE_SLASH, '|');
  return cells;
};

const rtrim = (str, c, invert) => {
  const l = str.length;
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if ((currChar === c) !== !!invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
};

const trimBlankTail = (str) => {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && BLANK_RE.test(lines[end])) end--;
  return lines.length - end <= 2 ? str : lines.slice(0, end + 1).join('\n');
};

const normLabel = (label) => label.trim().replace(SPACE_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();

const closeBracketAt = (str, b) => {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (ch === b[0]) level++;
    else if (ch === b[1] && --level < 0) return i;
  }
  return level > 0 ? -2 : -1;
};

const expandTabs = (line, indent) => {
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
};

// Last indexes of `*` / `_` / `~` runs that can close emphasis, strong or
// strikethrough: a run counts only when not preceded by ASCII whitespace or
// the start of the string. Scanned fresh per inline run (the reference
// caches this per run, and the cache never hits once the source is sliced).
const scanClosers = (src) => {
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
};

// ---------------------------------------------------------------------------
// Per-parse state (reset by parse())
// ---------------------------------------------------------------------------

const CX = {
  links: null,
  linkCount: 0,
  inLink: false,
  inRawBlock: false,
  linkEmitted: false,
  linkParenPossible: true,
  top: true,
};

const resetState = () => {
  CX.links = Object.create(null);
  CX.linkCount = 0;
  CX.inLink = false;
  CX.inRawBlock = false;
  CX.linkEmitted = false;
  CX.linkParenPossible = true;
  CX.top = true;
};

// ---------------------------------------------------------------------------
// Block guards: cheap necessary conditions for the two expensive rules
// ---------------------------------------------------------------------------

// A table needs a header line and, on the next line, a delimiter row made
// only of | : - and spaces, starting with | : or -, holding at least one -
// and at least one | or :.
const isTableAt = (src, pos) => {
  const headEnd = src.indexOf('\n', pos);
  if (headEnd === -1) return false;
  const head = src.slice(pos, headEnd).replace(/^ +/, '');
  if (head === '') return false;
  const line2 = firstLine(src.slice(headEnd + 1));
  const delim = line2.replace(/^ {0,3}/, '');
  if (!/^[|:|-]/.test(delim)) return false;
  let dash = false, pipeColon = false;
  for (const c of delim) {
    if (c === '-') dash = true;
    else if (c === '|' || c === ':') pipeColon = true;
    else if (c !== ' ') return false;
  }
  return dash && pipeColon;
};

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes (src, pos) and returns a token or undefined.
// Tokens carry only what the renderer needs: inline text is rendered on
// demand from the token's `text` field, never pre-tokenized.
// ---------------------------------------------------------------------------

const mkTok = (type, raw, extra) => Object.assign({ type, raw }, extra);

const indentComp = (raw, text) => {
  const m = raw.match(FENCE_INDENT);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(LEAD_SPACE);
    return mm === null ? node : node.slice(Math.min(mm[0].length, indentToCode.length));
  }).join('\n');
};

const codeTok = (src, pos) => {
  const cap = atRe(R_BLOCK_CODE, src, pos);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return mkTok('code', raw, { text: raw.replace(CODE_INDENT, '') });
};

const fenceTok = (src, pos) => {
  const cap = atRe(R_FENCES, src, pos);
  if (!cap) return undefined;
  return mkTok('code', cap[0], {
    lang: cap[2] ? cap[2].trim().replace(R_ANY_PUNCT, '$1') : cap[2],
    text: indentComp(cap[0], cap[3] || ''),
  });
};

const headTok = (src, pos) => {
  const cap = atRe(R_HEADING, src, pos);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (TRAIL_HASH.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || TRAIL_SPACE_TAB.test(trimmed)) text = trimmed.trim();
  }
  return mkTok('heading', rtrim(cap[0], '\n'), { depth: cap[1].length, text });
};

const hrTok = (src, pos) => {
  const cap = atRe(R_HR, src, pos);
  return cap ? mkTok('hr', rtrim(cap[0], '\n'), {}) : undefined;
};

const quoteTok = (src, pos) => {
  const cap = atRe(R_BLOCKQUOTE, src, pos);
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
      .replace(QUOTE_MARKER_WS, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(QUOTE_SETEXT, '\n    $1')
      .replace(QUOTE_STRIP, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = CX.top;
    CX.top = true;
    lexBlocks(currentText, tokens, true);
    CX.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    switch (lastToken?.type) {
      case 'code':
      case 'heading':
      case 'hr':
      case 'html':
      case 'table':
        break;
      case 'blockquote': {
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
      case 'list': {
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
      default:
        break;
    }
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr'
      || lastToken?.type === 'html' || lastToken?.type === 'table' || lastToken?.type === 'blockquote') {
      break;
    }
  }
  return mkTok('blockquote', raw, { tokens, text });
};

const listTok = (src, pos) => {
  let s = src.slice(pos);
  let cap = atRe(R_LIST, s, 0);
  if (!cap) return undefined;
  const listSrc = s;
  const taken = () => listSrc.length - s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = mkTok('list', '', {
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
    if (!(cap = atRe(itemRegex, s, 0))) break;
    if (hasRe(R_HR, s, 0)) break;
    const itemStart = taken();
    s = s.substring(cap[0].length);
    const first = firstLine(cap[2]);
    const bulletIndent = cap[1].length;
    let line = (first[0] === ' ' || first[0] === '\t')
      ? first.replace(LEAD_SPACE_TAB, (whitespace) => expandTabs(whitespace, bulletIndent))
      : first;
    let nextLine = firstLine(s);
    let isBlank = blankLine(line);
    let indent = 0;
    if (isBlank) {
      indent = bulletIndent + 1;
    } else {
      indent = nonSpaceAt(line);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (isBlank && BLANK_RE.test(nextLine)) {
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const regs = {
        bullet: nextBulletRe(indent),
        hr: hrRe(indent),
        fences: fencesRe(indent),
        heading: headingRe(indent),
        html: htmlRe(indent),
        quote: quoteRe(indent),
      };
      const starts = [regs.fences, regs.heading, regs.html, regs.quote, regs.bullet, regs.hr];
      const lineStarts = [regs.fences, regs.heading, regs.html, regs.hr];
      while (s) {
        const rawLine = firstLine(s);
        nextLine = rawLine;
        const nextLineWithoutTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
          ? nextLine.replace(LEAD_SPACE_TAB, (whitespace) => expandTabs(whitespace))
          : nextLine;
        // Block-start guards: fences/heading/html/blockquote/bullet/hr can
        // only match when the line's first non-space char (within the
        // allowed indent) is one of their markers.
        const nonSpaceIdx = nonSpaceAt(nextLineWithoutTabs);
        if (nonSpaceIdx !== -1 && nonSpaceIdx <= indent) {
          const c = nextLineWithoutTabs[nonSpaceIdx];
          const markers = '`~#<>-_*+0123456789';
          if (markers.includes(c) && starts.some((re) => hasRe(re, nextLine, 0))) break;
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
            if ('`~#<-_*'.includes(lc) && lineStarts.some((re) => hasRe(re, line, 0))) break;
          }
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && hasRe(R_LHEADING, `${line}\n${nextLine}`, 0);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
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
    list.items.push(mkTok('list_item', raw, {
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
  list.items.forEach((item) => {
    CX.top = false;
    item.tokens = lexBlocks(item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => ANY_LINE.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  });
  list.items.forEach((item) => {
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
  });
  if (list.loose) {
    list.items.forEach((item) => {
      item.loose = true;
      item.tokens.forEach((token) => {
        if (token.type === 'text') token.type = 'paragraph';
      });
    });
  }
  return list;
};

const htmlTok = (src, pos) => {
  const cap = atRe(R_HTML, src, pos);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return mkTok('html', raw, {
    block: true,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  });
};

const defTok = (src, pos) => {
  const cap = atRe(R_DEF, src, pos);
  if (!cap) return undefined;
  if (!ANGLE_OPEN.test(cap[2]) && closeBracketAt(cap[2], '()') !== -1) return undefined;
  const tag = normLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(HREF_BRACKETS, '$1').replace(R_ANY_PUNCT, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(R_ANY_PUNCT, '$1') : cap[3];
  return mkTok('def', rtrim(cap[0], '\n'), { tag, href, title });
};

const tableTok = (src, pos) => {
  const cap = atRe(R_TABLE, src, pos);
  if (!cap || !TABLE_DELIM.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(ALIGN_TRIM, '').split('|');
  if (headers.length !== aligns.length) return undefined;
  const rows = cap[3]?.trim() ? cap[3].replace(ROW_TRAIL_BLANK, '').split('\n') : [];
  const item = mkTok('table', rtrim(cap[0], '\n'), { header: [], align: [], rows: [] });
  for (const align of aligns) {
    item.align.push(
      ALIGN_RIGHT.test(align) ? 'right'
      : ALIGN_CENTER.test(align) ? 'center'
      : ALIGN_LEFT.test(align) ? 'left' : null);
  }
  headers.forEach((h, i) => item.header.push({ text: h, header: true, align: item.align[i] }));
  rows.forEach((row) => {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({ text: cell, header: false, align: item.align[i] })));
  });
  return item;
};

const setextTok = (src, pos) => {
  const cap = atRe(R_LHEADING, src, pos);
  if (!cap) return undefined;
  return mkTok('heading', rtrim(cap[0], '\n'), {
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text: cap[1].trim(),
  });
};

const paraTok = (src, pos) => {
  const cap = atRe(R_PARAGRAPH, src, pos);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return mkTok('paragraph', cap[0], { text });
};

const textTok = (src, pos) => {
  const cap = atRe(R_BLOCK_TEXT, src, pos);
  return cap ? mkTok('text', cap[0], { text: cap[0] }) : undefined;
};

// ---------------------------------------------------------------------------
// Block lexer: dispatch through a per-first-character candidate table.
// Each candidate is tried in the reference order until one matches.
// ---------------------------------------------------------------------------

const tryTable = (src, pos) => (isTableAt(src, pos) ? tableTok(src, pos) : undefined);
const trySetext = setextTok;
const tryPara = (src, pos) => (CX.top ? paraTok(src, pos) : undefined);
const tryText = (src, pos) => textTok(src, pos);

// Candidate lists by the line's first non-space character. The `fallbacks`
// run after the character-specific candidates, in the reference order.
const BLOCK_CANDIDATES = {
  '\t': [[codeTok, 'code'], [tryTable, 'table'], [tryPara, 'paragraph'], [tryText, 'text']],
  '#': [[headTok, 'heading'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '>': [[quoteTok, 'blockquote'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '`': [[fenceTok, 'fences'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '~': [[fenceTok, 'fences'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '-': [[hrTok, 'hr'], [listTok, 'list'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '+': [[hrTok, 'hr'], [listTok, 'list'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '*': [[hrTok, 'hr'], [listTok, 'list'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '_': [[hrTok, 'hr'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '<': [[htmlTok, 'html'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
  '[': [[defTok, 'def'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']],
};
const BLOCK_DEFAULT = [[tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']];

const lexBlocks = (src, tokens, lastParagraphClipped) => {
  tokens = tokens || [];
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
      const cap = atRe(R_NEWLINE, src, pos);
      const raw = cap[0];
      pos += raw.length;
      const last = tokens[tokens.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(mkTok('space', raw, {}));
      continue;
    }

    let indent = 0;
    while (src[pos + indent] === ' ') indent++;
    const c = src[pos + indent];
    // Indented code outranks everything when the indent reaches 4, and a
    // tab first character is code too; digits always try the list first.
    let candidates;
    if (c === '\t' || indent >= 4) {
      candidates = [[codeTok, 'code'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']];
    } else if (c >= '0' && c <= '9') {
      candidates = [[listTok, 'list'], [tryTable, 'table'], [trySetext, 'lheading'], [tryPara, 'paragraph'], [tryText, 'text']];
    } else {
      candidates = BLOCK_CANDIDATES[c] ?? BLOCK_DEFAULT;
    }
    let token;
    let kind = '';
    for (const [fn, k] of candidates) {
      token = fn(src, pos);
      if (token) { kind = k; break; }
    }
    if (!token) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    pos += token.raw.length;
    const last = tokens[tokens.length - 1];
    switch (kind) {
      case 'code':
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
          last.text += '\n' + token.text;
        } else tokens.push(token);
        break;
      case 'def':
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
          last.text += '\n' + token.raw;
        } else {
          if (!Object.hasOwn(CX.links, token.tag)) {
            CX.links[token.tag] = { href: token.href, title: token.title };
            CX.linkCount++;
          }
          tokens.push(token);
        }
        break;
      case 'paragraph':
        if (lastParagraphClipped && last && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
          last.text += '\n' + token.text;
        } else tokens.push(token);
        lastParagraphClipped = false;
        break;
      case 'text':
        if (last && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
          last.text += '\n' + token.text;
        } else tokens.push(token);
        break;
      default:
        tokens.push(token);
        break;
    }
  }
  CX.top = true;
  return tokens;
};

// ---------------------------------------------------------------------------
// Inline rendering. renderInline(src, textOnly) renders one inline run to
// HTML (textOnly: plain text, as the reference's TextRenderer does, used for
// image alt text). No token tree is built: structural tokens are dispatched
// on their first character and plain-text runs are consumed by one scan.
// ---------------------------------------------------------------------------

const hasLinkIn = (text) => {
  if (!text.includes('[')) return false;
  const direct = [...text.matchAll(BLOCK_SKIP)].some(
    (m) => hasRe(R_LINK, m[0], 0) && text.charAt(m.index - 1) !== '!');
  if (direct) return true;
  return [...text.matchAll(R_REFLINK_SEARCH)].some((m) => {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!') return false;
    if (!Object.hasOwn(CX.links, normLabel(m0.slice(refStart + 1, -1)))) return false;
    return !(refStart > 1 && hasLinkIn(m0.slice(1, refStart - 1)));
  });
};

const maskReflink = (m0) => {
  const refStart = m0.lastIndexOf('[');
  if (!Object.hasOwn(CX.links, normLabel(m0.slice(refStart + 1, -1)))) return m0;
  if (refStart > 1 && m0.charAt(0) !== '!') {
    const text = m0.slice(1, refStart - 1);
    if (hasLinkIn(text)) {
      return '[' + text.replace(R_REFLINK_SEARCH, maskReflink)
        + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m0.length - 2) + ']';
};

const maskSrc = (src) => {
  let masked = src;
  if (src.includes('[') && CX.linkCount > 0) masked = masked.replace(R_REFLINK_SEARCH, maskReflink);
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(R_ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) =>
      punct ? '+'.repeat(m0.length)
      : code ? code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code
      : m0);
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(BLOCK_SKIP, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
};

const getMask = (run) => (run.masked ??= maskSrc(run.src));

// One scan of the run's masked source for the last emphasis, strong and
// strikethrough closers, shared by every opener in the run.
const getClosers = (run) => (run.closers ??= scanClosers(getMask(run)));

const labelEndInTag = (src, label, labelStart) => {
  if (!label.includes('<')) return false;
  let i = 0;
  while (i < label.length) {
    const ch = label[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const code = atRe(R_INLINE_CODE, label, i);
      if (code) { i += code[0].length; continue; }
    }
    if (ch !== '<') { i++; continue; }
    const token = atRe(R_TAG, src.slice(labelStart + i), 0) || atRe(R_AUTOLINK, src.slice(labelStart + i), 0);
    if (token) {
      if (token[0].length > label.length - i) return true;
      i += token[0].length;
      continue;
    }
    i++;
  }
  return false;
};

const linkTag = (href, title, inner, autolink) => {
  const clean = cleanHref(href);
  if (clean === null) return inner;
  const safe = escHtml(clean, autolink);
  return '<a href="' + safe + '"'
    + (title ? ' title="' + escHtml(title) + '"' : '')
    + '>' + inner + '</a>';
};

// Builds a link or image from a matched [label](href "title") /
// [label][ref] / [label] form. Returns {html, adv} or null when the outer
// link must fall through to plain text (a link inside a link's label).
const makeLink = (cap, link, textOnly) => {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(LINK_BRACKET_ESC, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const saved = [CX.inLink, CX.linkEmitted, CX.inRawBlock];
  CX.inLink = true;
  CX.linkEmitted = false;
  const inner = renderInline(text, isImage ? true : textOnly);
  const textHasLink = CX.linkEmitted;
  [CX.linkEmitted, CX.inLink] = [saved[1], saved[0]];
  if (isImage) {
    const altText = inner;
    if (textOnly) return { html: altText, adv: cap[0].length };
    const clean = cleanHref(href);
    if (clean === null) return { html: escHtml(altText), adv: cap[0].length };
    return {
      html: `<img src="${escHtml(clean)}" alt="${escHtml(altText)}"`
        + (title ? ` title="${escHtml(title)}"` : '') + '>',
      adv: cap[0].length,
    };
  }
  if (textHasLink) {
    CX.inRawBlock = saved[2];
    return null;
  }
  CX.linkEmitted = true;
  if (textOnly) return { html: inner, adv: cap[0].length };
  return { html: linkTag(href, title, inner, false), adv: cap[0].length };
};

const tryEscape = (src, pos, textOnly) => {
  const cap = atRe(R_ESCAPE, src, pos);
  return cap ? { html: textOnly ? cap[1] : escHtml(cap[1]), adv: cap[0].length } : null;
};

const tryTag = (src, pos) => {
  const cap = atRe(R_TAG, src, pos);
  if (!cap) return null;
  if (!CX.inLink && hasRe(A_OPEN, cap[0], 0)) CX.inLink = true;
  else if (CX.inLink && hasRe(A_CLOSE, cap[0], 0)) CX.inLink = false;
  if (!CX.inRawBlock && hasRe(PRE_OPEN, cap[0], 0)) CX.inRawBlock = true;
  else if (CX.inRawBlock && hasRe(PRE_CLOSE, cap[0], 0)) CX.inRawBlock = false;
  return { html: cap[0], adv: cap[0].length };
};

const tryCode = (src, pos, textOnly) => {
  const cap = atRe(R_INLINE_CODE, src, pos);
  if (!cap) return null;
  let text = cap[2].replace(NL_GLOBAL, ' ');
  const trimBoth = NON_SPACE.test(text) && LEAD_ONE_SPACE.test(text) && TRAIL_ONE_SPACE.test(text);
  if (trimBoth) text = text.substring(1, text.length - 1);
  return { html: textOnly ? text : '<code>' + escHtml(text, true) + '</code>', adv: cap[0].length };
};

const tryBreak = (src, pos, textOnly) => {
  const cap = atRe(R_BR, src, pos);
  return cap ? { html: textOnly ? '' : '<br>', adv: cap[0].length } : null;
};

const tryAuto = (src, pos, textOnly) => {
  const cap = atRe(R_AUTOLINK, src, pos);
  if (!cap) return null;
  const isMail = cap[2] === '@';
  const text = cap[1];
  const href = isMail ? 'mailto:' + text : text;
  if (textOnly) return { html: text, adv: cap[0].length };
  return { html: linkTag(href, null, escHtml(text, true), true), adv: cap[0].length };
};

const tryUrl = (src, pos, textOnly) => {
  const cap = atRe(R_URL, src, pos);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      const bp = R_BACKPEDAL.exec(cap[0]);
      cap[0] = bp ? bp[0] : '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (textOnly) return { html: text, adv: cap[0].length };
  return { html: linkTag(href, null, escHtml(text, true), true), adv: cap[0].length };
};

const tryLink = (src, pos, textOnly) => {
  if (CX.linkParenPossible === false) return null;
  const cap = atRe(R_LINK, src, pos);
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
    href: href ? href.replace(R_ANY_PUNCT, '$1') : href,
    title: title ? title.replace(R_ANY_PUNCT, '$1') : title,
  }, textOnly);
};

const tryRef = (src, pos, textOnly) => {
  const cap = atRe(R_REFLINK, src, pos) ?? atRe(R_NOLINK, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && labelEndInTag(src.slice(pos), cap[1], labelStart)) return null;
  const link = CX.links[normLabel(cap[2] || cap[1])];
  if (!link) return { html: cap[0].charAt(0), adv: 1 };
  return makeLink(cap, link, textOnly);
};

// Yield every right-delimiter match of `re` over `text`, in order, stopping
// once the match index passes `lastInWindow`.
function* delimMatches(re, text, lastInWindow) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastInWindow) break;
    yield m;
  }
}

const tryEm = (src, pos, prevChar, run, textOnly) => {
  const match = atRe(R_EM_STRONG_L_DELIM, src, pos);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const maskedSrc = getMask(run);
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  let runPrevChar = '';
  if (runStart > 0) {
    const i = runStart - 1;
    const c = maskedSrc[i];
    const low = c >= '\uDC00' && c <= '\uDFFF';
    runPrevChar = (low && i > 0 && maskedSrc[i - 1] >= '\uD800' && maskedSrc[i - 1] <= '\uDBFF')
      ? maskedSrc[i - 1] + c : c;
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!R_PUNCTUATION.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!R_PUNCTUATION.exec(prevChar);
  if (match[4] && prevChar.match(ALNUM_UNICODE)) return null;
  const nextChar = match[1] || match[3] || '';
  if (nextChar && prevChar && !prevPunct) return null;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  const runLength = srcStart - runStart + lLength;
  const openerCanClose = !!runPrevChar.trim()
    && (!!nextChar || (delimChar === '*' && !runPrevPunct));
  if (delimChar !== '*' && delimChar !== '_') return null;
  const endReg = delimChar === '*' ? R_EM_STRONG_R_DELIM_AST : R_EM_STRONG_R_DELIM_UND;
  const closers = getClosers(run);
  const lastPossible = delimChar === '*' ? closers.star : closers.under;
  const windowStart = pos + lLength;
  if (lastPossible < windowStart) return null;
  const masked = getMask(run).slice(pos + lLength);
  const lastInWindow = lastPossible - windowStart;
  let delimTotal = lLength, midDelimTotal = 0;
  for (const m of delimMatches(endReg, masked, lastInWindow)) {
    const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!rDelim) continue;
    const rLength = rDelim.length;
    if (m[3] || m[4]) { delimTotal += rLength; continue; }
    if (m[5] || m[6] || openerCanClose) {
      if (midRun && (m[5] || m[6])) break;
      if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    const useLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + useLength);
    if (Math.min(lLength, useLength) % 2) {
      const inner = renderInline(raw.slice(1, -1), textOnly);
      return { html: textOnly ? inner : `<em>${inner}</em>`, adv: raw.length };
    }
    const inner = renderInline(raw.slice(2, -2), textOnly);
    return { html: textOnly ? inner : `<strong>${inner}</strong>`, adv: raw.length };
  }
  return null;
};

const tryDel = (src, pos, prevChar, run, textOnly) => {
  const match = atRe(R_DEL_L_DELIM, src, pos);
  if (!match) return null;
  const nextChar = match[1] || '';
  // An opener can open at the start of a run, after punctuation, or when
  // there is no next character; it cannot open between two non-punctuation
  // characters.
  if (nextChar && prevChar && !R_PUNCTUATION.exec(prevChar)) return null;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  const closers = getClosers(run);
  const windowStart = pos + lLength;
  if (closers.tilde < windowStart) return null;
  const masked = getMask(run).slice(pos + lLength);
  const lastInWindow = closers.tilde - windowStart;
  let delimTotal = lLength;
  for (const m of delimMatches(R_DEL_R_DELIM, masked, lastInWindow)) {
    const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!rDelim) continue;
    const rLength = rDelim.length;
    if (rLength !== lLength) continue;
    if (m[3] || m[4]) { delimTotal += rLength; continue; }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    const useLength = Math.min(rLength, rLength + delimTotal);
    const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + useLength);
    const inner = renderInline(raw.slice(lLength, -lLength), textOnly);
    return { html: textOnly ? inner : `<del>${inner}</del>`, adv: raw.length };
  }
  return null;
};

// Could a URL (extended autolink) start at pos? Covers www., http(s)://,
// ftp://, mailto:, xmpp: and bare email addresses. The check is a superset
// of the matcher's: a false positive only costs a failed regex attempt.
const urlStartAt = (src, pos) => {
  const c = src.charCodeAt(pos);
  switch (c) {
    case 119: // w
      if (src[pos + 1] === 'w' && src[pos + 2] === 'w' && src[pos + 3] === '.') return true;
      break;
    case 104: // h
    case 72: // H
    case 102: // f
    case 70: { // F
      const s = src.slice(pos, pos + 8).toLowerCase();
      if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) return true;
      break;
    }
    case 109: // m
      if (src.startsWith('mailto:', pos)) return true;
      break;
    case 120: // x
      if (src.startsWith('xmpp:', pos)) return true;
      break;
    default:
      break;
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
};

const emailLocalChar = (ch) => {
  const cc = ch.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
    || cc === 46 || cc === 95 || cc === 43 || cc === 45;
};

const renderInline = (src, textOnly) => {
  const run = { src, masked: null, closers: null };
  const prevParen = CX.linkParenPossible;
  CX.linkParenPossible = prevParen && src.includes(')');
  try {
    return renderInlineGo(src, run, textOnly);
  } finally {
    CX.linkParenPossible = prevParen;
  }
};

const renderInlineGo = (src, run, textOnly) => {
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
    switch (ch) {
      case '\\':
        r = tryEscape(src, pos, textOnly) ?? tryBreak(src, pos, textOnly);
        break;
      case '<':
        r = tryTag(src, pos) ?? tryAuto(src, pos, textOnly);
        break;
      case '[':
      case '!':
        r = tryLink(src, pos, textOnly) ?? tryRef(src, pos, textOnly);
        break;
      case '*':
      case '_':
        r = tryEm(src, pos, prevChar, run, textOnly);
        // The URL rule runs before text for every position: an email can
        // start with _ (narrow local set), so try it once emphasis fails.
        if (!r && ch === '_' && !CX.inLink && urlStartAt(src, pos)) r = tryUrl(src, pos, textOnly);
        break;
      case '`':
        r = tryCode(src, pos, textOnly);
        break;
      case '~':
        r = tryDel(src, pos, prevChar, run, textOnly);
        break;
      case ' ':
        r = tryBreak(src, pos, textOnly);
        break;
      default:
        if (!CX.inLink && emailLocalChar(ch) && urlStartAt(src, pos)) r = tryUrl(src, pos, textOnly);
        break;
    }
    if (r) {
      out += r.html;
      pos += r.adv;
      continue;
    }
    const rawText = src.slice(pos, textStop(src, pos));
    const decoded = CX.inRawBlock ? rawText : decodeRefs(rawText);
    out += textOnly ? decoded : (CX.inRawBlock ? decoded : escHtml(decoded));
    if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
    keepPrevChar = true;
    pos += rawText.length;
  }
  return out;
};

// GFM inline text: stops before structural characters, hard breaks,
// autolinkable protocols / www. / email starts. A single character loop
// with explicit state, mirroring marked's lazy text regex exactly:
//  - the first character (or a run of ` / ~) is always consumed;
//  - cheap stops: a structural char, 2+ spaces before \n, a protocol,
//    www. (only after whitespace / * / _ / ~ / ( or at the start),
//    mailto:/xmpp: (only after a non-alphanumeric char the lazy part can
//    consume);
//  - email stops: before an email-local run ending at @. The earliest
//    valid one is max(localRunStart, minEnd) when that is before the @.
//    mailto: at exactly minEnd is only a stop when the run started with a
//    single character (the regex's outer alternative); a ` / ~ run of 2+
//    consumes the run first, so mailto: right after it is not a stop.
const STRUCT_CHARS = '\\`<[!*_~';

const isEmailLocalCode = (cc) =>
  (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
  || cc === 46 || cc === 33 || cc === 35 || cc === 36 || cc === 37 || cc === 38
  || cc === 39 || cc === 42 || cc === 43 || cc === 47 || cc === 61 || cc === 63
  || cc === 96 || cc === 123 || cc === 124 || cc === 125 || cc === 126
  || cc === 45 || cc === 95;

const textStop = (src, pos) => {
  const len = src.length;
  let minEnd = pos + 1;
  const c0 = src[pos];
  if (c0 === '`' || c0 === '~') {
    while (minEnd < len && src[minEnd] === c0) minEnd++;
  }
  let emailStop = null;
  let firstCheap = null;
  let localStart = pos;
  for (let i = minEnd; i < len; i++) {
    const ch = src[i];
    if (ch === '@') {
      if (localStart < i && emailStop === null) {
        const s = localStart < minEnd ? minEnd : localStart;
        if (s < i) {
          emailStop = s;
          if (firstCheap !== null && emailStop < firstCheap) return emailStop;
        }
      }
      localStart = i + 1;
      continue;
    }
    if (!isEmailLocalCode(src.charCodeAt(i))) localStart = i + 1;
    if (firstCheap !== null) {
      if (emailStop !== null) return emailStop < firstCheap ? emailStop : firstCheap;
      if (localStart > firstCheap) return firstCheap;
      continue;
    }
    if (STRUCT_CHARS.includes(ch)) { firstCheap = i; continue; }
    if (ch === ' ' && src[i + 1] === ' ') {
      let j = i + 2;
      while (src[j] === ' ') j++;
      if (src[j] === '\n') { firstCheap = i; continue; }
      continue;
    }
    if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
      const s = src.slice(i, i + 8).toLowerCase();
      if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) {
        firstCheap = i;
      }
      continue;
    }
    if (ch === 'w' && src.startsWith('www.', i)) {
      const prev = i === 0 ? '' : src[i - 1];
      if (prev === '' || ' \t\n\r\f\v*_~('.includes(prev)) firstCheap = i;
      continue;
    }
    if ((ch === 'm' && src.startsWith('mailto:', i)) || (ch === 'x' && src.startsWith('xmpp:', i))) {
      const prev = i === 0 ? '' : src[i - 1];
      const prevAlnum = prev !== '' && /[a-zA-Z0-9]/.test(prev);
      if (!prevAlnum && prev !== '') {
        if (i === minEnd && minEnd !== pos + 1) continue;
        firstCheap = i;
      }
    }
  }
  if (firstCheap === null) return emailStop ?? len;
  return emailStop !== null && emailStop < firstCheap ? emailStop : firstCheap;
};

// ---------------------------------------------------------------------------
// Block rendering (array-joined)
// ---------------------------------------------------------------------------

const checkboxHtml = (checked) =>
  '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';

const cellHtml = (cell) => {
  CX.inRawBlock = false;
  const content = renderInline(cell.text, false);
  const type = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return open + content + `</${type}>\n`;
};

const tableHtml = (token) => {
  const headCells = token.header.map(cellHtml).join('');
  let body = '';
  for (const row of token.rows) {
    body += `<tr>\n${row.map(cellHtml).join('')}</tr>\n`;
  }
  return '<table>\n<thead>\n<tr>\n' + headCells + '</tr>\n</thead>\n'
    + (body ? `<tbody>${body}</tbody>` : '') + '</table>\n';
};

const itemHtml = (item, listLoose) => {
  if (!item.task) return `<li>${blocksHtml(item.tokens)}</li>\n`;
  const box = checkboxHtml(item.checked);
  if (!listLoose) return `<li>${box}${blocksHtml(item.tokens)}</li>\n`;
  const first = item.tokens[0];
  if (first?.type === 'paragraph') {
    CX.inRawBlock = false;
    const firstHtml = renderInline(first.text, false);
    const parts = [`<li><p>${box}`, firstHtml, '</p>\n'];
    for (let k = 1; k < item.tokens.length; k++) parts.push(blockHtml(item.tokens[k]));
    parts.push('</li>\n');
    return parts.join('');
  }
  return `<li><p>${box}</p>\n${blocksHtml(item.tokens)}</li>\n`;
};

const listHtml = (token) => {
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n'
    + token.items.map((item) => itemHtml(item, token.loose)).join('')
    + '</' + type + '>\n';
};

const blockHtml = (token) => {
  switch (token.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading':
      CX.inRawBlock = false;
      return `<h${token.depth}>${renderInline(token.text, false)}</h${token.depth}>\n`;
    case 'code': {
      const langString = (token.lang || '').match(NON_SPACE_START)?.[0];
      const code = token.text ? token.text.replace(TRAIL_NL, '') + '\n' : '';
      if (!langString) return '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
      return '<pre><code class="language-' + escHtml(langString) + '">'
        + escHtml(code, true) + '</code></pre>\n';
    }
    case 'table': return tableHtml(token);
    case 'blockquote': return `<blockquote>\n${blocksHtml(token.tokens)}</blockquote>\n`;
    case 'list': return listHtml(token);
    case 'html': return token.text;
    case 'def': return '';
    case 'paragraph':
      CX.inRawBlock = false;
      return `<p>${renderInline(token.text, false)}</p>\n`;
    case 'text':
      CX.inRawBlock = false;
      return renderInline(token.text, false);
    default: throw new Error('Token with "' + token.type + '" type was not found.');
  }
};

const blocksHtml = (tokens) => tokens.map(blockHtml).join('');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const parse = (markdown) => {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  resetState();
  const src = markdown.replace(CR_RE, '\n');
  return blocksHtml(lexBlocks(src, []));
};

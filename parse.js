// Fast Markdown renderer, sixth build: parse(markdown) returns exactly
// the HTML that marked 18.1.3 renders with its default options (GFM on,
// breaks off, pedantic off, async off). Dependency-free ES module.
//
// Shape of this build, deliberately unlike v3, v4 and v5:
// - no class and no method dispatch: one plain context object per parse()
//   is threaded through module-level functions as the first argument;
// - tokens are positional arrays, e.g. ['heading', raw, depth, text] and
//   ['list', raw, ordered, start, loose, items]; there is no token class
//   and no object with named fields;
// - grammar rules are assigned one by one into the BLK / INL tables with
//   a small compose() helper, not built by a loop over [name, factory]
//   pairs and not held in one big rule object;
// - block dispatch is a route table: an array of [chars, [fns...]] rows
//   scanned in order, instead of a Map keyed by first character;
// - inline dispatch is a lookup object from character to a single
//   handler function, and every handler takes the same six arguments
//   (ctx, src, pos, prev, run, textOnly) — no arity mismatches;
// - the text-stop scan is split into two while-loop passes, findCheapStop
//   and findEmailStop, whose minimum is the answer;
// - emphasis and strikethrough walk their right-delimiter regex directly
//   with an exec loop inside the handler, collecting nothing;
// - rendering is an if/else chain that pushes strings into an output
//   array, instead of a switch that returns strings.

'use strict';

// ---------------------------------------------------------------------------
// Regex construction
// ---------------------------------------------------------------------------

// Build a regex from a template string (or another regex's source) by
// replacing each key of `repl` with its value, in insertion order. A
// value's ^ anchors are dropped the way the reference grammar's composer
// does it: a ^ survives only when it sits right after '['.
function compose(template, repl, flags) {
  let src = typeof template === 'string' ? template : template.source;
  for (const [key, val] of Object.entries(repl)) {
    let vs = typeof val === 'string' ? val : val.source;
    vs = vs.replace(/(^|[^\[])\^/g, '$1');
    src = src.split(key).join(vs);
  }
  return new RegExp(src, flags || '');
}

// Turn an anchored (^...) regex into a sticky one matching at an index
// inside a longer string. With the sticky flag, ^ would only match at
// index 0, so unescaped ^ outside character classes is removed and the
// sticky flag itself becomes the anchor. Pieces are collected in an
// array and joined at the end.
function anchor(re) {
  const src = re.source;
  const pieces = [];
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      pieces.push(ch, src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    if (ch === '^' && !inClass) {
      i++;
      continue;
    }
    pieces.push(ch);
    i++;
  }
  const flags = re.flags.replace('g', '').replace('y', '') + 'y';
  return new RegExp(pieces.join(''), flags);
}

// Execute a sticky regex at `pos`; lastIndex is always set first so a
// regex shared between re-entrant calls stays safe.
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
  return i === -1 ? s : s.slice(0, i);
}

// True when the line holds only spaces and tabs.
function blankLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
    i++;
  }
  return true;
}

// Index of the first character that is not a space, or -1.
function nonSpaceAt(line) {
  let i = 0;
  while (i < line.length) {
    if (line[i] !== ' ') return i;
    i++;
  }
  return -1;
}

// Whether raw ends with a blank line: \n[ \t]*\n[ \t]*$ (the reference's
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
  return anchor(new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`));
}
const nextBulletRe = indentReFor((i) => anchor(new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)));
const hrRe = indentReFor((i) => anchor(new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)));
const fencesRe = indentReFor((i) => anchor(new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)));
const headingRe = indentReFor((i) => anchor(new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)));
const htmlRe = indentReFor((i) => anchor(new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')));
const quoteRe = indentReFor((i) => anchor(new RegExp(`^ {0,${i}}>`)));

// ---------------------------------------------------------------------------
// Block grammar. Each rule is assigned directly into BLK, in the order
// the reference builds them, so a rule composed from earlier rules names
// them through the table.
// ---------------------------------------------------------------------------

const BLK = {};
const INL = {};

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function tableInPara() {
  return compose(
    '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
    {
      hr: BLK.hr,
      heading: ' {0,3}#{1,6}(?:\\s|$)',
      blockquote: ' {0,3}>',
      code: '(?: {4}| {0,3}\t)[^\\n]',
      fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
      html: ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
      tag: TAG,
    });
}

BLK.newline = anchor(/^(?:[ \t]*(?:\n|$))+/);
BLK.code = anchor(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
BLK.fences = anchor(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
BLK.hr = anchor(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
BLK.heading = anchor(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);
BLK.bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
BLK.text = anchor(/^[^\n]+/);
BLK.lheading = anchor(compose(/^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/, {
  bull: BLK.bullet,
  blockCode: /(?: {4}| {0,3}\t)/,
  fences: / {0,3}(?:`{3,}|~{3,})/,
  blockquote: / {0,3}>/,
  heading: / {0,3}#{1,6}(?:\s|$)/,
  hr: / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  html: / {0,3}<[^\n>]+>\n/,
  table: / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/,
}));
BLK.def = anchor(compose(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/, {
  label: BLOCK_LABEL,
  title: /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
}));
BLK.list = anchor(compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, { bull: BLK.bullet }));
BLK.html = anchor(compose(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')',
  {
    comment: COMMENT,
    tag: TAG,
    attribute: / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  },
  'i'));
BLK.paragraph = anchor(compose(PARA_CORE, {
  '|lheading': '',
  hr: BLK.hr,
  heading: ' {0,3}#{1,6}(?:\\s|$)',
  table: tableInPara(),
  blockquote: ' {0,3}>',
  fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  html: ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  tag: TAG,
}));
BLK.table = anchor(tableInPara());
BLK.blockquote = anchor(compose(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, {
  paragraph: compose(PARA_CORE, {
    '|lheading': '',
    '|table': '',
    hr: BLK.hr,
    heading: ' {0,3}#{1,6}(?:\\s|$)',
    blockquote: ' {0,3}>',
    fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    list: / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/,
    html: ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    tag: TAG,
  }),
}));

// ---------------------------------------------------------------------------
// Inline grammar, same treatment: direct assignments into INL.
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM_STRONG = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM_STRONG = /(?:[^\s\p{P}\p{S}]|~)/u;

const EM_STRONG_R_AST =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const DEL_R_DELIM =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/, {
  brackets: INLINE_LABEL_BRACKETS,
});
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = compose(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/, {
  brackets: INLINE_LABEL_BRACKETS,
});

INL.escape = anchor(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/);
INL.code = anchor(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
INL.br = anchor(/^( {2,}|\\)\n(?!\s*$)[ \t]*/);
INL.punctuation = compose(/^((?![*_])punctSpace)/, { punctSpace: PUNCT_OR_SPACE }, 'u');
INL.blockSkip = compose(/link|precode-code|html/, {
  link: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  'precode-': '(?<!`)()',
  code: /(?<b>`+)[^`]+\k<b>(?!`)/,
  html: /<(?! )[^<>]*?>/,
}, 'g');
INL.emStrongLDelim = anchor(compose(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, { punct: PUNCT_GFM_STRONG }, 'u'));
INL.emStrongRDelimAst = compose(EM_STRONG_R_AST, {
  notPunctSpace: NOT_PUNCT_OR_SPACE_GFM_STRONG,
  punctSpace: PUNCT_OR_SPACE_GFM_STRONG,
  punct: PUNCT_GFM_STRONG,
}, 'gu');
INL.emStrongRDelimUnd = compose(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)',
  {
    notPunctSpace: NOT_PUNCT_OR_SPACE,
    punctSpace: PUNCT_OR_SPACE,
    punct: PUNCT,
  },
  'gu');
INL.delLDelim = anchor(compose(/^~~?(?:((?!~)punct)|[^\s~])/, { punct: PUNCT }, 'u'));
INL.delRDelim = compose(DEL_R_DELIM, {
  notPunctSpace: NOT_PUNCT_OR_SPACE,
  punctSpace: PUNCT_OR_SPACE,
  punct: PUNCT,
}, 'gu');
INL.del = anchor(/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/);
INL.anyPunct = compose(/\\(punct)/, { punct: PUNCT }, 'gu');
INL.anyPunctOutsideCode = compose(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, { punct: PUNCT }, 'gu');

INL.tag = anchor(compose(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  {
    comment: compose(COMMENT, { '(?:-->|$)': '-->' }),
    attribute: /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  }));
INL.autolink = anchor(compose(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, {
  scheme: /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/,
  email: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
}));
INL.link = anchor(compose(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, {
  label: INLINE_LABEL,
  href: /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/,
  title: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
}));
INL.reflink = anchor(compose(/^!?\[(label)\]\[(ref)\]/, {
  label: INLINE_LABEL,
  ref: BLOCK_LABEL,
}));
INL.nolink = anchor(compose(/^!?\[(ref)\](?:\[\])?/, { ref: BLOCK_LABEL }));
INL.reflinkSearch = compose('reflink|nolink(?!\\()', {
  reflink: compose(/^!?\[(label)\]\[(ref)\]/, {
    label: BOUNDED_INLINE_LABEL,
    ref: BOUNDED_BLOCK_LABEL,
  }),
  nolink: compose(/^!?\[(ref)\](?:\[\])?/, { ref: BOUNDED_BLOCK_LABEL }),
}, 'g');
INL.url = anchor(compose(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, {
  emailProtocol: compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, { email: /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/ }),
  protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
  email: /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
}));
INL.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// ---------------------------------------------------------------------------
// Small helpers
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
// or the start of the string. Returned as a plain [star, under, tilde]
// array; scanned fresh per inline run.
function scanClosers(src) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code !== 42 && code !== 95 && code !== 126) { i++; continue; }
    const prev = i === 0 ? 10 : src.charCodeAt(i - 1);
    let j = i + 1;
    while (j < src.length && src.charCodeAt(j) === code) j++;
    if (prev !== 32 && prev !== 9 && prev !== 10 && prev !== 13 && prev !== 12) {
      if (code === 42) star = i;
      else if (code === 95) under = i;
      else tilde = i;
    }
    i = j;
  }
  return [star, under, tilde];
}

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
// Tokens: positional arrays. Layout per type:
//   space     ['space', raw]
//   hr        ['hr', raw]
//   heading   ['heading', raw, depth, text]
//   code      ['code', raw, text, lang]      (lang undefined = indented)
//   table     ['table', raw, header, align, rows]
//             header cell: [text, true, align]; body cell: [text, false, align]
//   blockquote ['blockquote', raw, tokens, text]
//   list      ['list', raw, ordered, start, loose, items]
//   list_item ['list_item', raw, task, loose, text, tokens, checked, checkboxRaw]
//   html      ['html', raw, pre]             (text is the raw itself)
//   def       ['def', raw, tag, href, title]
//   paragraph ['paragraph', raw, text]
//   text      ['text', raw, text]
// ---------------------------------------------------------------------------

// Build a token array from a type, a raw string and positional fields.
function tok(type, raw, ...fields) {
  const arr = [type, raw];
  for (let i = 0; i < fields.length; i++) arr.push(fields[i]);
  return arr;
}

// Classify a token for the lexer's merge rules. Fenced code also has type
// 'code', but unlike indented code it must never merge into a preceding
// paragraph: it carries a lang field, indented code does not.
function classify(t) {
  if (t[0] === 'code') return t[3] !== undefined ? 'fences' : 'code';
  return t[0];
}

// Fresh per-parse context: links, flags and the inline output buffer.
function newContext(src) {
  return {
    src,
    links: new Map(),
    linkCount: 0,
    inLink: false,
    inRaw: false,
    emitted: false,
    parenOk: true,
    top: true,
    out: [],
  };
}

// ---------------------------------------------------------------------------
// Block dispatch: a route table. Each row pairs the first characters it
// serves with the tokenizer functions to try, in reference order.
// ---------------------------------------------------------------------------

function routeFor(ctx, src, pos) {
  let indent = 0;
  while (src[pos + indent] === ' ') indent++;
  const c = src[pos + indent];
  if (c === '\t' || indent >= 4) return [tokCode, tableTry, setextTok, paraTry, tokText];
  if (c >= '0' && c <= '9') return [tokList, tableTry, setextTok, paraTry, tokText];
  for (let r = 0; r < BLOCK_ROUTES.length; r++) {
    if (BLOCK_ROUTES[r][0].includes(c)) return BLOCK_ROUTES[r][1];
  }
  return [tableTry, setextTok, paraTry, tokText];
}

const BLOCK_ROUTES = [
  ['#', [tokHeading, tableTry, setextTok, paraTry, tokText]],
  ['>', [tokBlockquote, tableTry, setextTok, paraTry, tokText]],
  ['`~', [tokFences, tableTry, setextTok, paraTry, tokText]],
  ['-+*', [tokHr, tokList, tableTry, setextTok, paraTry, tokText]],
  ['_', [tokHr, tableTry, setextTok, paraTry, tokText]],
  ['<', [tokHtml, tableTry, setextTok, paraTry, tokText]],
  ['[', [tokDef, tableTry, setextTok, paraTry, tokText]],
];

function pickBlock(ctx, src, pos) {
  const fns = routeFor(ctx, src, pos);
  for (let i = 0; i < fns.length; i++) {
    const t = fns[i](ctx, src, pos);
    if (t) return [t, classify(t)];
  }
  return [undefined, ''];
}

// ---------------------------------------------------------------------------
// Simple block tokenizers. Each takes (ctx, src, pos) and returns a token
// array, or undefined when its rule does not match here.
// ---------------------------------------------------------------------------

function tokCode(ctx, src, pos) {
  const cap = atRe(BLK.code, src, pos);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return tok('code', raw, raw.replace(CODE_INDENT, ''), undefined);
}

function tokFences(ctx, src, pos) {
  const cap = atRe(BLK.fences, src, pos);
  if (!cap) return undefined;
  const lang = cap[2] ? cap[2].trim().replace(INL.anyPunct, '$1') : cap[2];
  return tok('code', cap[0], indentComp(cap[0], cap[3] || ''), lang);
}

function tokHeading(ctx, src, pos) {
  const cap = atRe(BLK.heading, src, pos);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (TRAIL_HASH.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || TRAIL_SPACE_TAB.test(trimmed)) text = trimmed.trim();
  }
  return tok('heading', rtrim(cap[0], '\n'), cap[1].length, text);
}

function tokHr(ctx, src, pos) {
  const cap = atRe(BLK.hr, src, pos);
  if (!cap) return undefined;
  return tok('hr', rtrim(cap[0], '\n'));
}

function tokHtml(ctx, src, pos) {
  const cap = atRe(BLK.html, src, pos);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  const pre = cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style';
  return tok('html', raw, pre);
}

function tokDef(ctx, src, pos) {
  const cap = atRe(BLK.def, src, pos);
  if (!cap) return undefined;
  if (!ANGLE_OPEN.test(cap[2]) && closeBracketAt(cap[2], '()') !== -1) return undefined;
  const tag = normLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(HREF_BRACKETS, '$1').replace(INL.anyPunct, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INL.anyPunct, '$1') : cap[3];
  return tok('def', rtrim(cap[0], '\n'), tag, href, title);
}

function tokTable(ctx, src, pos) {
  const cap = atRe(BLK.table, src, pos);
  if (!cap || !TABLE_DELIM.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(ALIGN_TRIM, '').split('|');
  if (headers.length !== aligns.length) return undefined;
  const rows = cap[3]?.trim() ? cap[3].replace(ROW_TRAIL_BLANK, '').split('\n') : [];
  const align = [];
  for (let a = 0; a < aligns.length; a++) {
    const al = aligns[a];
    if (ALIGN_RIGHT.test(al)) align.push('right');
    else if (ALIGN_CENTER.test(al)) align.push('center');
    else if (ALIGN_LEFT.test(al)) align.push('left');
    else align.push(null);
  }
  const header = [];
  for (let h = 0; h < headers.length; h++) header.push([headers[h], true, align[h]]);
  const outRows = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = splitCells(rows[r], header.length);
    const mapped = [];
    for (let c = 0; c < cells.length; c++) mapped.push([cells[c], false, align[c]]);
    outRows.push(mapped);
  }
  return tok('table', rtrim(cap[0], '\n'), header, align, outRows);
}

// Setext heading: the anchored heading regex directly, no guard. (A guard
// that split the remaining input and ran a per-line regex before every
// paragraph made this path slower than the reference.)
function setextTok(ctx, src, pos) {
  const cap = atRe(BLK.lheading, src, pos);
  if (!cap) return undefined;
  const depth = cap[2].charAt(0) === '=' ? 1 : 2;
  return tok('heading', rtrim(cap[0], '\n'), depth, cap[1].trim());
}

function tokPara(ctx, src, pos) {
  const cap = atRe(BLK.paragraph, src, pos);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return tok('paragraph', cap[0], text);
}

function tokText(ctx, src, pos) {
  const cap = atRe(BLK.text, src, pos);
  if (!cap) return undefined;
  return tok('text', cap[0], cap[0]);
}

function tableTry(ctx, src, pos) {
  if (!isTableAt(src, pos)) return undefined;
  return tokTable(ctx, src, pos);
}

function paraTry(ctx, src, pos) {
  if (!ctx.top) return undefined;
  return tokPara(ctx, src, pos);
}

// ---------------------------------------------------------------------------
// Blockquote. The captured block is re-lexed chunk by chunk; a trailing
// nested blockquote or list is re-tokenized with the remaining lines so
// its raw span covers the continuation.
// ---------------------------------------------------------------------------

function tokBlockquote(ctx, src, pos) {
  const cap = atRe(BLK.blockquote, src, pos);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i = 0;
    while (i < lines.length) {
      if (QUOTE_START.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
        i++;
      } else if (inBlockquote) {
        break;
      } else {
        currentLines.push(lines[i]);
        i++;
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
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(ctx, currentText, tokens, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    const lastType = lastToken?.[0];
    if (lastType === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken[1] + '\n' + continuation.replace(QUOTE_STRIP, '');
      const newToken = tokBlockquote(ctx, newText, 0);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken[1].length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken[3].length) + newToken[3];
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && QUOTE_START.test(lines[0])) continue;
      break;
    }
    if (lastType === 'list') {
      const oldToken = lastToken;
      const newText = oldToken[1] + '\n' + lines.join('\n');
      const newToken = tokList(ctx, newText, 0);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken[1].length > oldToken[1].length
        ? newText.slice(oldToken[1].length + 1, newToken[1].length).split('\n').length
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
  return tok('blockquote', raw, tokens, text);
}

// ---------------------------------------------------------------------------
// List. Items are lexed with top=false; task markers are stripped from
// the first text/paragraph token afterwards.
// ---------------------------------------------------------------------------

function tokList(ctx, src, pos) {
  let s = src.slice(pos);
  let cap = atRe(BLK.list, s, 0);
  if (!cap) return undefined;
  const listSrc = s;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = tok('list', '', isordered, isordered ? +bull.slice(0, -1) : '', false, []);
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRe(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    cap = atRe(itemRegex, s, 0);
    if (!cap) break;
    if (hasRe(BLK.hr, s, 0)) break;
    const itemStart = listSrc.length - s.length;
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
            && hasRe(BLK.lheading, `${line}\n${nextLine}`, 0);
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
    const raw = listSrc.slice(itemStart, listSrc.length - s.length);
    if (!list[4]) {
      if (endsWithBlankLine) list[4] = true;
      else if (dblBlankEnd(raw)) endsWithBlankLine = true;
    }
    const item = tok('list_item', raw, !!TASK_TEST.test(itemContents), false, itemContents, []);
    list[5].push(item);
  }
  const lastItem = list[5][list[5].length - 1];
  if (!lastItem) return undefined;
  lastItem[1] = lastItem[1].trimEnd();
  lastItem[4] = lastItem[4].trimEnd();
  list[1] = listSrc.slice(0, listSrc.length - s.length).trimEnd();
  for (let q = 0; q < list[5].length; q++) {
    const item = list[5][q];
    ctx.top = false;
    item[5] = lexBlocks(ctx, item[4], []);
    if (!list[4]) {
      const spacers = item[5].filter((t) => t[0] === 'space');
      let hasMultipleLineBreaks = false;
      for (let w = 0; w < spacers.length; w++) {
        if (ANY_LINE.test(spacers[w][1])) { hasMultipleLineBreaks = true; break; }
      }
      if (spacers.length > 0 && hasMultipleLineBreaks) list[4] = true;
    }
  }
  for (let q = 0; q < list[5].length; q++) {
    const item = list[5][q];
    const itemToken = item[5][0];
    if (item[2] && (itemToken?.[0] === 'text' || itemToken?.[0] === 'paragraph')) {
      item[4] = item[4].replace(TASK_STRIP, '');
      itemToken[1] = itemToken[1].replace(TASK_STRIP, '');
      itemToken[2] = itemToken[2].replace(TASK_STRIP, '');
      const taskRaw = TASK_BOX.exec(item[1]);
      if (taskRaw) {
        item[6] = taskRaw[0] !== '[ ]';
        item[7] = taskRaw[0] + ' ';
      }
    } else if (item[2]) {
      item[2] = false;
    }
  }
  if (list[4]) {
    for (let q = 0; q < list[5].length; q++) {
      const item = list[5][q];
      item[3] = true;
      for (let w = 0; w < item[5].length; w++) {
        if (item[5][w][0] === 'text') item[5][w][0] = 'paragraph';
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Block lexer: consumes src into `tokens`, merging paragraph, text,
// indented-code and definition tokens the way the reference does.
// ---------------------------------------------------------------------------

function lexBlocks(ctx, src, tokens, lastParagraphClipped) {
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
      const cap = atRe(BLK.newline, src, pos);
      const raw = cap[0];
      pos += raw.length;
      const last = tokens[tokens.length - 1];
      if (raw.length === 1 && last !== undefined) last[1] += '\n';
      else tokens.push(tok('space', raw));
      continue;
    }

    const pair = pickBlock(ctx, src, pos);
    const token = pair[0];
    const kind = pair[1];
    if (!token) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    pos += token[1].length;
    const last = tokens[tokens.length - 1];
    if (kind === 'code') {
      if (last && (last[0] === 'paragraph' || last[0] === 'text')) {
        last[1] += (last[1].endsWith('\n') ? '' : '\n') + token[1];
        last[2] += '\n' + token[2];
      } else tokens.push(token);
    } else if (kind === 'def') {
      if (last && (last[0] === 'paragraph' || last[0] === 'text')) {
        last[1] += (last[1].endsWith('\n') ? '' : '\n') + token[1];
        last[2] += '\n' + token[1];
      } else {
        if (!ctx.links.has(token[2])) {
          ctx.links.set(token[2], { href: token[3], title: token[4] });
          ctx.linkCount++;
        }
        tokens.push(token);
      }
    } else if (kind === 'paragraph') {
      if (lastParagraphClipped && last && last[0] === 'paragraph') {
        last[1] += (last[1].endsWith('\n') ? '' : '\n') + token[1];
        last[2] += '\n' + token[2];
      } else tokens.push(token);
      lastParagraphClipped = false;
    } else if (kind === 'text') {
      if (last && last[0] === 'text') {
        last[1] += (last[1].endsWith('\n') ? '' : '\n') + token[1];
        last[2] += '\n' + token[2];
      } else tokens.push(token);
    } else {
      tokens.push(token);
    }
  }
  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline masking. Reference links are masked before emphasis scanning so
// a `[...][...]` pair is never mistaken for emphasis delimiters; code
// spans and link destinations are masked the same way.
// ---------------------------------------------------------------------------

function hasLinkIn(ctx, text) {
  if (!text.includes('[')) return false;
  const direct = [...text.matchAll(INL.blockSkip)].some((m) => {
    return hasRe(INL.link, m[0], 0) && text.charAt(m.index - 1) !== '!';
  });
  if (direct) return true;
  return [...text.matchAll(INL.reflinkSearch)].some((m) => {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!') return false;
    if (!ctx.links.has(normLabel(m0.slice(refStart + 1, -1)))) return false;
    if (refStart > 1 && hasLinkIn(ctx, m0.slice(1, refStart - 1))) return false;
    return true;
  });
}

function maskReflink(ctx, m0) {
  const refStart = m0.lastIndexOf('[');
  if (!ctx.links.has(normLabel(m0.slice(refStart + 1, -1)))) return m0;
  if (refStart > 1 && m0.charAt(0) !== '!') {
    const text = m0.slice(1, refStart - 1);
    if (hasLinkIn(ctx, text)) {
      return '[' + text.replace(INL.reflinkSearch, (mm) => maskReflink(ctx, mm))
        + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m0.length - 2) + ']';
}

function maskSrc(ctx, src) {
  let masked = src;
  if (src.includes('[') && ctx.linkCount > 0) {
    masked = masked.replace(INL.reflinkSearch, (m0) => maskReflink(ctx, m0));
  }
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(INL.anyPunctOutsideCode, function (m0, code, punct) {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(INL.blockSkip, function (m0, _link, context) {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

function labelEndInTag(ctx, src, label, labelStart) {
  if (!label.includes('<')) return false;
  let i = 0;
  while (i < label.length) {
    const ch = label[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const code = atRe(INL.code, label, i);
      if (code) { i += code[0].length; continue; }
    }
    if (ch !== '<') { i++; continue; }
    const token = atRe(INL.tag, src.slice(labelStart + i), 0) || atRe(INL.autolink, src.slice(labelStart + i), 0);
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
// [label][ref] / [label] form. Appends its HTML to ctx.out and returns
// how many source characters it consumed, or 0 when the outer link must
// fall through to plain text (a link inside a link's label).
function makeLink(ctx, cap, link, textOnly) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(LINK_BRACKET_ESC, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.emitted;
  const savedRaw = ctx.inRaw;
  ctx.inLink = true;
  ctx.emitted = false;
  const inner = renderInline(ctx, text, isImage ? true : textOnly);
  const textHasLink = ctx.emitted;
  ctx.emitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (isImage) {
    const altText = inner;
    if (textOnly) {
      ctx.out.push(altText);
      return cap[0].length;
    }
    const clean = cleanHref(href);
    if (clean === null) {
      ctx.out.push(escHtml(altText));
      return cap[0].length;
    }
    let html = `<img src="${escHtml(clean)}" alt="${escHtml(altText)}"`;
    if (title) html += ` title="${escHtml(title)}"`;
    ctx.out.push(html + '>');
    return cap[0].length;
  }
  if (textHasLink) {
    ctx.inRaw = savedRaw;
    return 0;
  }
  ctx.emitted = true;
  if (textOnly) {
    ctx.out.push(inner);
    return cap[0].length;
  }
  ctx.out.push(linkTag(href, title, inner, false));
  return cap[0].length;
}

// ---------------------------------------------------------------------------
// Inline handlers. Every handler takes the same six arguments
// (ctx, src, pos, prev, run, textOnly), appends its HTML to ctx.out and
// returns the characters consumed, or 0 when it does not match. Handlers
// that need neither prev nor run ignore them; `textOnly` renders plain
// text, the way the reference's TextRenderer does for image alt text.
// ---------------------------------------------------------------------------

function hEscape(ctx, src, pos, _prev, _run, textOnly) {
  const cap = atRe(INL.escape, src, pos);
  if (!cap) return 0;
  ctx.out.push(textOnly ? cap[1] : escHtml(cap[1]));
  return cap[0].length;
}

function hTag(ctx, src, pos, _prev, _run, _textOnly) {
  const cap = atRe(INL.tag, src, pos);
  if (!cap) return 0;
  if (!ctx.inLink && hasRe(A_OPEN, cap[0], 0)) ctx.inLink = true;
  else if (ctx.inLink && hasRe(A_CLOSE, cap[0], 0)) ctx.inLink = false;
  if (!ctx.inRaw && hasRe(PRE_OPEN, cap[0], 0)) ctx.inRaw = true;
  else if (ctx.inRaw && hasRe(PRE_CLOSE, cap[0], 0)) ctx.inRaw = false;
  ctx.out.push(cap[0]);
  return cap[0].length;
}

function hCode(ctx, src, pos, _prev, _run, textOnly) {
  const cap = atRe(INL.code, src, pos);
  if (!cap) return 0;
  let text = cap[2].replace(NL_GLOBAL, ' ');
  const trimBoth = NON_SPACE.test(text) && LEAD_ONE_SPACE.test(text) && TRAIL_ONE_SPACE.test(text);
  if (trimBoth) text = text.substring(1, text.length - 1);
  if (textOnly) ctx.out.push(text);
  else ctx.out.push('<code>' + escHtml(text, true) + '</code>');
  return cap[0].length;
}

function hBreak(ctx, src, pos, _prev, _run, textOnly) {
  const cap = atRe(INL.br, src, pos);
  if (!cap) return 0;
  if (!textOnly) ctx.out.push('<br>');
  return cap[0].length;
}

function hAuto(ctx, src, pos, _prev, _run, textOnly) {
  const cap = atRe(INL.autolink, src, pos);
  if (!cap) return 0;
  const isMail = cap[2] === '@';
  const text = cap[1];
  const href = isMail ? 'mailto:' + text : text;
  if (textOnly) ctx.out.push(text);
  else ctx.out.push(linkTag(href, null, escHtml(text, true), true));
  return cap[0].length;
}

function hUrl(ctx, src, pos, _prev, _run, textOnly) {
  const cap = atRe(INL.url, src, pos);
  if (!cap) return 0;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      const bp = INL.backpedal.exec(cap[0]);
      cap[0] = bp ? bp[0] : '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (textOnly) ctx.out.push(text);
  else ctx.out.push(linkTag(href, null, escHtml(text, true), true));
  return cap[0].length;
}

function hLink(ctx, src, pos, _prev, _run, textOnly) {
  if (ctx.parenOk === false) return 0;
  const cap = atRe(INL.link, src, pos);
  if (!cap) return 0;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && labelEndInTag(ctx, src.slice(pos), cap[1], labelStart)) return 0;
  const trimmedUrl = cap[2].trim();
  if (ANGLE_OPEN.test(trimmedUrl)) {
    if (!ANGLE_CLOSE.test(trimmedUrl)) return 0;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return 0;
  } else {
    const lastParenIndex = closeBracketAt(cap[2], '()');
    if (lastParenIndex === -2) return 0;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return 0;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (ANGLE_OPEN.test(href)) href = href.slice(1, -1);
  return makeLink(ctx, cap, {
    href: href ? href.replace(INL.anyPunct, '$1') : href,
    title: title ? title.replace(INL.anyPunct, '$1') : title,
  }, textOnly);
}

function hRef(ctx, src, pos, _prev, _run, textOnly) {
  const cap = atRe(INL.reflink, src, pos) ?? atRe(INL.nolink, src, pos);
  if (!cap) return 0;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && labelEndInTag(ctx, src.slice(pos), cap[1], labelStart)) return 0;
  const link = ctx.links.get(normLabel(cap[2] || cap[1]));
  if (!link) {
    ctx.out.push(cap[0].charAt(0));
    return 1;
  }
  return makeLink(ctx, cap, link, textOnly);
}

function hEm(ctx, src, pos, prevChar, run, textOnly) {
  const match = atRe(INL.emStrongLDelim, src, pos);
  if (!match) return 0;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return 0;
  const delimChar = match[0][0];
  if (delimChar !== '*' && delimChar !== '_') return 0;
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
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INL.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INL.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(ALNUM_UNICODE)) return 0;
  const nextChar = match[1] || match[3] || '';
  if (nextChar && prevChar && !prevPunct) return 0;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  const runLength = srcStart - runStart + lLength;
  const openerCanClose = !!runPrevChar.trim()
    && (!!nextChar || (delimChar === '*' && !runPrevPunct));
  const endReg = delimChar === '*' ? INL.emStrongRDelimAst : INL.emStrongRDelimUnd;
  const closers = run.scan();
  const lastPossible = delimChar === '*' ? closers[0] : closers[1];
  const windowStart = pos + lLength;
  if (lastPossible < windowStart) return 0;
  const masked = run.mask().slice(pos + lLength);
  const lastInWindow = lastPossible - windowStart;
  // Walk the right-delimiter matches directly: the first match that
  // balances the delimiter run wins, so nothing is collected first.
  let delimTotal = lLength;
  let midDelimTotal = 0;
  endReg.lastIndex = 0;
  let m;
  while ((m = endReg.exec(masked)) !== null) {
    if (m.index > lastInWindow) break;
    const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!rDelim) continue;
    const rLength = rDelim.length;
    if (m[3] || m[4]) { delimTotal += rLength; continue; }
    if (m[5] || m[6] || openerCanClose) {
      if (midRun && (m[5] || m[6])) return 0;
      if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    const useLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + useLength);
    if (Math.min(lLength, useLength) % 2) {
      const inner = renderInline(ctx, raw.slice(1, -1), textOnly);
      if (textOnly) ctx.out.push(inner);
      else ctx.out.push(`<em>${inner}</em>`);
      return raw.length;
    }
    const inner = renderInline(ctx, raw.slice(2, -2), textOnly);
    if (textOnly) ctx.out.push(inner);
    else ctx.out.push(`<strong>${inner}</strong>`);
    return raw.length;
  }
  return 0;
}

function hDel(ctx, src, pos, prevChar, run, textOnly) {
  const match = atRe(INL.delLDelim, src, pos);
  if (!match) return 0;
  const nextChar = match[1] || '';
  // An opener can open at the start of a run, after punctuation, or when
  // there is no next character; it cannot open between two non-punctuation
  // characters.
  if (nextChar && prevChar && !INL.punctuation.exec(prevChar)) return 0;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  const closers = run.scan();
  const windowStart = pos + lLength;
  if (closers[2] < windowStart) return 0;
  const masked = run.mask().slice(pos + lLength);
  const lastInWindow = closers[2] - windowStart;
  let delimTotal = lLength;
  INL.delRDelim.lastIndex = 0;
  let m;
  while ((m = INL.delRDelim.exec(masked)) !== null) {
    if (m.index > lastInWindow) break;
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
    const inner = renderInline(ctx, raw.slice(lLength, -lLength), textOnly);
    if (textOnly) ctx.out.push(inner);
    else ctx.out.push(`<del>${inner}</del>`);
    return raw.length;
  }
  return 0;
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

// First cheap stop at or after minEnd: a structural character, 2+ spaces
// before \n, or a protocol / www. / mailto: / xmpp: start, mirroring the
// reference's lazy text regex. -1 when there is none. www. only counts
// after whitespace / * / _ / ~ / ( or at the start; mailto:/xmpp: only
// after a non-alphanumeric char the lazy part can consume, and mailto: at
// exactly minEnd is only a stop when the run started with a single
// character (a ` / ~ run of 2+ consumes the run first).
function findCheapStop(src, pos, minEnd) {
  const len = src.length;
  let i = minEnd;
  while (i < len) {
    const cc = src.charCodeAt(i);
    switch (cc) {
      case 92: // \
      case 96: // `
      case 60: // <
      case 91: // [
      case 33: // !
      case 42: // *
      case 95: // _
      case 126: // ~
        return i;
      case 32: { // space
        if (src[i + 1] === ' ') {
          let j = i + 2;
          while (src[j] === ' ') j++;
          if (src[j] === '\n') return i;
        }
        break;
      }
      case 104: // h
      case 72: // H
      case 102: // f
      case 70: { // F
        const s = src.slice(i, i + 8).toLowerCase();
        if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) return i;
        break;
      }
      case 119: // w
        if (src.startsWith('www.', i)) {
          const prev = i === 0 ? '' : src[i - 1];
          if (prev === '' || ' \t\n\r\f\v*_~('.includes(prev)) return i;
        }
        break;
      case 109: // m
      case 120: { // x
        if ((cc === 109 && src.startsWith('mailto:', i)) || (cc === 120 && src.startsWith('xmpp:', i))) {
          const prev = i === 0 ? '' : src[i - 1];
          const prevAlnum = prev !== '' && /[a-zA-Z0-9]/.test(prev);
          if (!prevAlnum && prev !== '' && !(i === minEnd && minEnd !== pos + 1)) return i;
        }
        break;
      }
      default:
        break;
    }
    i++;
  }
  return -1;
}

// Earliest start of an email-local run that reaches an @, or -1. A run
// may legitimately reach back before the cheap stop, so the answer is
// the smaller of the two stops; a run whose start passes the cheap stop
// can never win, so scanning ends there.
function findEmailStop(src, pos, minEnd, cheap) {
  const len = src.length;
  if (src.indexOf('@', pos) === -1) return -1;
  let localStart = pos;
  let i = minEnd;
  while (i < len) {
    const cc = src.charCodeAt(i);
    if (cc === 64) { // @
      if (localStart < i) {
        const s = localStart < minEnd ? minEnd : localStart;
        if (s < i) return cheap === -1 || s < cheap ? s : cheap;
      }
      // A later @ can only help if its local run starts at or before
      // the cheap stop; once the run start passes it, stop scanning.
      if (cheap !== -1 && i + 1 > cheap) return cheap;
      localStart = i + 1;
    } else if (cc >= 128 || !EMAIL_LOCAL[cc]) {
      localStart = i + 1;
      if (cheap !== -1 && localStart > cheap) return cheap;
    }
    i++;
  }
  return -1;
}

// GFM inline text: stops before structural characters, hard breaks,
// autolinkable protocols / www. / email starts. The first character (or
// a run of ` / ~) is always consumed.
function textStop(src, pos) {
  const len = src.length;
  let minEnd = pos + 1;
  const c0 = src[pos];
  if (c0 === '`' || c0 === '~') {
    while (minEnd < len && src[minEnd] === c0) minEnd++;
  }
  const cheap = findCheapStop(src, pos, minEnd);
  const email = findEmailStop(src, pos, minEnd, cheap);
  if (email !== -1) return email;
  if (cheap === -1) return len;
  return cheap;
}

// ---------------------------------------------------------------------------
// Inline driver. Handlers are looked up by character in INLINE_BY_CHAR;
// a character with no handler falls through to the URL check and then to
// plain text. The URL rule runs before text for every position: an email
// can start with _ (narrow local set), so it is tried once emphasis
// fails for _ as well.
// ---------------------------------------------------------------------------

const INLINE_BY_CHAR = {
  '\\': (ctx, src, pos, prev, run, textOnly) =>
    hEscape(ctx, src, pos, prev, run, textOnly) || hBreak(ctx, src, pos, prev, run, textOnly),
  '<': (ctx, src, pos, prev, run, textOnly) =>
    hTag(ctx, src, pos, prev, run, textOnly) || hAuto(ctx, src, pos, prev, run, textOnly),
  '[': (ctx, src, pos, prev, run, textOnly) =>
    hLink(ctx, src, pos, prev, run, textOnly) || hRef(ctx, src, pos, prev, run, textOnly),
  '!': (ctx, src, pos, prev, run, textOnly) =>
    hLink(ctx, src, pos, prev, run, textOnly) || hRef(ctx, src, pos, prev, run, textOnly),
  '*': hEm,
  '_': hEm,
  '`': hCode,
  '~': hDel,
  ' ': hBreak,
};

function renderInline(ctx, src, textOnly) {
  const savedOut = ctx.out;
  const savedParen = ctx.parenOk;
  ctx.parenOk = savedParen && src.includes(')');
  ctx.out = [];
  try {
    inlineGo(ctx, src, textOnly);
    return ctx.out.join('');
  } finally {
    ctx.out = savedOut;
    ctx.parenOk = savedParen;
  }
}

function inlineGo(ctx, src, textOnly) {
  // One inline run's masked source and closer scan, computed lazily and
  // shared by every opener in the run.
  let masked = null;
  let closers = null;
  const run = {
    src,
    mask() {
      if (masked === null) masked = maskSrc(ctx, src);
      return masked;
    },
    scan() {
      if (closers === null) closers = scanClosers(this.mask());
      return closers;
    },
  };
  const len = src.length;
  let pos = 0;
  let prevChar = '';
  let keepPrevChar = false;
  let prevRemaining = Infinity;
  while (pos < len) {
    const remaining = len - pos;
    if (remaining >= prevRemaining) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    prevRemaining = remaining;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[pos];
    let used = 0;
    const handler = INLINE_BY_CHAR[ch];
    if (handler) used = handler(ctx, src, pos, prevChar, run, textOnly);
    if (!used && ch === '_' && !ctx.inLink && urlStartAt(src, pos)) {
      used = hUrl(ctx, src, pos, prevChar, run, textOnly);
    }
    if (!used && !ctx.inLink && emailLocalChar(ch) && urlStartAt(src, pos)) {
      used = hUrl(ctx, src, pos, prevChar, run, textOnly);
    }
    if (used) {
      pos += used;
      continue;
    }
    const stop = textStop(src, pos);
    const rawText = src.slice(pos, stop);
    const decoded = ctx.inRaw ? rawText : decodeRefs(rawText);
    if (textOnly || ctx.inRaw) ctx.out.push(decoded);
    else ctx.out.push(escHtml(decoded));
    if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
    keepPrevChar = true;
    pos += rawText.length;
  }
}

// True when any regex in `res` matches `ln` at position 0.
function anyStarts(res, ln) {
  for (let k = 0; k < res.length; k++) {
    if (hasRe(res[k], ln, 0)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block rendering. emitBlock pushes HTML strings into `parts` through an
// if/else chain on the token type; renderTokens joins a token list.
// ---------------------------------------------------------------------------

function codeHtml(ctx, token) {
  const langString = (token[3] || '').match(NON_SPACE_START)?.[0];
  const code = token[2] ? token[2].replace(TRAIL_NL, '') + '\n' : '';
  if (!langString) return '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escHtml(langString) + '">'
    + escHtml(code, true) + '</code></pre>\n';
}

function checkboxHtml(checked) {
  if (checked) return '<input checked="" disabled="" type="checkbox"> ';
  return '<input disabled="" type="checkbox"> ';
}

function cellHtml(ctx, cell) {
  ctx.inRaw = false;
  const content = renderInline(ctx, cell[0], false);
  const type = cell[1] ? 'th' : 'td';
  let open = `<${type}`;
  if (cell[2]) open += ` align="${cell[2]}"`;
  return open + '>' + content + `</${type}>\n`;
}

function tableHtml(ctx, token) {
  const headParts = [];
  for (let h = 0; h < token[2].length; h++) headParts.push(cellHtml(ctx, token[2][h]));
  const headCells = headParts.join('');
  let body = '';
  for (let r = 0; r < token[4].length; r++) {
    const rowParts = [];
    for (let c = 0; c < token[4][r].length; c++) rowParts.push(cellHtml(ctx, token[4][r][c]));
    body += `<tr>\n${rowParts.join('')}</tr>\n`;
  }
  let out = '<table>\n<thead>\n<tr>\n' + headCells + '</tr>\n</thead>\n';
  if (body) out += `<tbody>${body}</tbody>`;
  return out + '</table>\n';
}

function itemHtml(ctx, item, listLoose) {
  if (!item[2]) return `<li>${renderTokens(ctx, item[5])}</li>\n`;
  const box = checkboxHtml(item[6]);
  if (!listLoose) return `<li>${box}${renderTokens(ctx, item[5])}</li>\n`;
  const first = item[5][0];
  if (first?.[0] === 'paragraph') {
    ctx.inRaw = false;
    const firstHtml = renderInline(ctx, first[2], false);
    const parts = [`<li><p>${box}`, firstHtml, '</p>\n'];
    for (let k = 1; k < item[5].length; k++) emitBlock(ctx, item[5][k], parts);
    parts.push('</li>\n');
    return parts.join('');
  }
  return `<li><p>${box}</p>\n${renderTokens(ctx, item[5])}</li>\n`;
}

function listHtml(ctx, token) {
  const type = token[2] ? 'ol' : 'ul';
  let open = '<' + type;
  if (token[2] && token[3] !== 1) open += ' start="' + token[3] + '"';
  const parts = [open + '>\n'];
  for (let q = 0; q < token[5].length; q++) parts.push(itemHtml(ctx, token[5][q], token[4]));
  parts.push('</' + type + '>\n');
  return parts.join('');
}

function emitBlock(ctx, token, parts) {
  const type = token[0];
  if (type === 'space') {
    return;
  } else if (type === 'hr') {
    parts.push('<hr>\n');
  } else if (type === 'heading') {
    ctx.inRaw = false;
    parts.push(`<h${token[2]}>${renderInline(ctx, token[3], false)}</h${token[2]}>\n`);
  } else if (type === 'code') {
    parts.push(codeHtml(ctx, token));
  } else if (type === 'table') {
    parts.push(tableHtml(ctx, token));
  } else if (type === 'blockquote') {
    parts.push(`<blockquote>\n${renderTokens(ctx, token[2])}</blockquote>\n`);
  } else if (type === 'list') {
    parts.push(listHtml(ctx, token));
  } else if (type === 'html') {
    parts.push(token[1]);
  } else if (type === 'def') {
    return;
  } else if (type === 'paragraph') {
    ctx.inRaw = false;
    parts.push(`<p>${renderInline(ctx, token[2], false)}</p>\n`);
  } else if (type === 'text') {
    ctx.inRaw = false;
    parts.push(renderInline(ctx, token[2], false));
  } else {
    throw new Error('Token with "' + type + '" type was not found.');
  }
}

function renderTokens(ctx, tokens) {
  const parts = [];
  for (let k = 0; k < tokens.length; k++) emitBlock(ctx, tokens[k], parts);
  return parts.join('');
}

// Email-local characters (the reference's extended-email local set), as
// a 128-entry lookup table for the text-stop scan.
const EMAIL_LOCAL = new Uint8Array(128);
for (const cc of [46, 33, 35, 36, 37, 38, 39, 42, 43, 47, 61, 63, 96, 123, 124, 125, 126, 45, 95]) {
  EMAIL_LOCAL[cc] = 1;
}
for (let cc = 48; cc <= 57; cc++) EMAIL_LOCAL[cc] = 1;
for (let cc = 65; cc <= 90; cc++) EMAIL_LOCAL[cc] = 1;
for (let cc = 97; cc <= 122; cc++) EMAIL_LOCAL[cc] = 1;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const ctx = newContext(markdown.replace(CR_RE, '\n'));
  return renderTokens(ctx, lexBlocks(ctx, ctx.src, []));
}

// Fast Markdown renderer, fifth build: parse(markdown) returns exactly
// the HTML that marked 18.1.3 renders with its default options (GFM on,
// breaks off, pedantic off, async off). Dependency-free ES module.
//
// Shape of this build, deliberately unlike the earlier ones:
// - one Parser class per parse() call: every scrap of per-parse state
//   (links, inLink, inRaw, top, output) lives on the instance, and the
//   tokenizers and renderers are its methods;
// - grammar rules are built by a data-driven loop over [name, factory]
//   pairs, each factory receiving the partially built rule set, so a
//   rule composed from earlier rules names them through that argument;
// - block dispatch is a Map from first character to a list of method
//   names, tried in order; inline dispatch is the same idea, a Map from
//   character to handler names, with handlers appending to an output
//   array and reporting how many characters they consumed (0 = no match);
// - the text-stop scan is a single for loop with a switch on the
//   character code, tracking the cheap stop and the email stop together;
// - emphasis walks a collected array of right-delimiter matches instead
//   of a callback walk;
// - links live in a Map; tokens are instances of a small Tok class;
// - rendering is a switch on token type inside renderTokens.

'use strict';

// ---------------------------------------------------------------------------
// Regex construction
// ---------------------------------------------------------------------------

// Compose a regex from a template, replacing each key of `repl` (in
// insertion order) with its value. A value's ^ anchors are stripped the
// way the reference grammar's composer does it: a ^ survives only right
// after '['.
function sub(template, repl, flags) {
  let src = typeof template === 'string' ? template : template.source;
  for (const key of Object.keys(repl)) {
    let val = repl[key];
    let vs = typeof val === 'string' ? val : val.source;
    vs = vs.replace(/(^|[^\[])\^/g, '$1');
    src = src.split(key).join(vs);
  }
  return new RegExp(src, flags || '');
}

// Turn an anchored (^...) regex into a sticky one that matches at an index
// inside a longer string. The ^ anchor cannot stay: with the sticky flag
// it would only match at index 0, and the sticky flag itself is the
// anchor. A ^ is dropped when it is not escaped and not inside a
// character class. Built with a plain char loop tracking class state.
function sticky(re) {
  const src = re.source;
  let out = '';
  let cls = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      out += ch + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '[') cls = true;
    else if (ch === ']') cls = false;
    else if (ch === '^' && !cls) continue;
    out += ch;
  }
  return new RegExp(out, re.flags.replace('g', '').replace('y', '') + 'y');
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
  return i === -1 ? s : s.slice(0, i);
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
  return sticky(new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`));
}
const nextBulletRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)));
const hrRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)));
const fencesRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)));
const headingRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)));
const htmlRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')));
const quoteRe = indentReFor((i) => sticky(new RegExp(`^ {0,${i}}>`)));

// ---------------------------------------------------------------------------
// Grammar, built by a data-driven loop. BLOCK_RULES is a list of
// [name, factory] pairs; each factory receives the rule set built so far,
// so a rule composed from earlier rules names them through that argument.
// ---------------------------------------------------------------------------

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function tableInPara(b) {
  return sub(
    '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
    {
      hr: b.hr,
      heading: ' {0,3}#{1,6}(?:\\s|$)',
      blockquote: ' {0,3}>',
      code: '(?: {4}| {0,3}\t)[^\\n]',
      fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
      html: ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
      tag: TAG,
    });
}

const BLOCK_RULES = [
  ['newline', () => sticky(/^(?:[ \t]*(?:\n|$))+/ )],
  ['code', () => sticky(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/ )],
  ['fences', () => sticky(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/ )],
  ['hr', () => sticky(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/ )],
  ['heading', () => sticky(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/ )],
  ['bullet', () => / {0,3}(?:[*+-]|\d{1,9}[.)])/ ],
  ['text', () => sticky(/^[^\n]+/ )],
  ['lheading', (b) => sticky(sub(/^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/, {
    bull: b.bullet,
    blockCode: /(?: {4}| {0,3}\t)/,
    fences: / {0,3}(?:`{3,}|~{3,})/,
    blockquote: / {0,3}>/,
    heading: / {0,3}#{1,6}(?:\s|$)/,
    hr: / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
    html: / {0,3}<[^\n>]+>\n/,
    table: / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/,
  }))],
  ['def', () => sticky(sub(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/, {
    label: BLOCK_LABEL,
    title: /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
  }))],
  ['list', (b) => sticky(sub(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, { bull: b.bullet }))],
  ['html', () => sticky(sub(
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
    'i'))],
  ['paragraph', (b) => sticky(sub(PARA_CORE, {
    '|lheading': '',
    hr: b.hr,
    heading: ' {0,3}#{1,6}(?:\\s|$)',
    table: tableInPara(b),
    blockquote: ' {0,3}>',
    fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    list: ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
    html: ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    tag: TAG,
  }))],
  ['table', (b) => sticky(tableInPara(b))],
  ['blockquote', (b) => sticky(sub(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/, {
    paragraph: sub(PARA_CORE, {
      '|lheading': '',
      '|table': '',
      hr: b.hr,
      heading: ' {0,3}#{1,6}(?:\\s|$)',
      blockquote: ' {0,3}>',
      fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      list: / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/,
      html: ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
      tag: TAG,
    }),
  }))],
];

// ---------------------------------------------------------------------------
// Inline grammar, same treatment.
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
const INLINE_LABEL = sub(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/, {
  brackets: INLINE_LABEL_BRACKETS,
});
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = sub(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/, {
  brackets: INLINE_LABEL_BRACKETS,
});

const INLINE_RULES = [
  ['escape', () => sticky(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/ )],
  ['code', () => sticky(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/ )],
  ['br', () => sticky(/^( {2,}|\\)\n(?!\s*$)[ \t]*/ )],
  ['punctuation', () => sub(/^((?![*_])punctSpace)/, { punctSpace: PUNCT_OR_SPACE }, 'u')],
  ['blockSkip', () => sub(/link|precode-code|html/, {
    link: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    'precode-': '(?<!`)()',
    code: /(?<b>`+)[^`]+\k<b>(?!`)/,
    html: /<(?! )[^<>]*?>/,
  }, 'g')],
  ['emStrongLDelim', () => sticky(sub(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, { punct: PUNCT_GFM_STRONG }, 'u'))],
  ['emStrongRDelimAst', () => sub(EM_STRONG_R_AST, {
    notPunctSpace: NOT_PUNCT_OR_SPACE_GFM_STRONG,
    punctSpace: PUNCT_OR_SPACE_GFM_STRONG,
    punct: PUNCT_GFM_STRONG,
  }, 'gu')],
  ['emStrongRDelimUnd', () => sub(
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
    'gu')],
  ['delLDelim', () => sticky(sub(/^~~?(?:((?!~)punct)|[^\s~])/, { punct: PUNCT }, 'u'))],
  ['delRDelim', () => sub(DEL_R_DELIM, {
    notPunctSpace: NOT_PUNCT_OR_SPACE,
    punctSpace: PUNCT_OR_SPACE,
    punct: PUNCT,
  }, 'gu')],
  ['del', () => sticky(/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/ )],
  ['anyPunct', () => sub(/\\(punct)/, { punct: PUNCT }, 'gu')],
  ['anyPunctOutsideCode', () => sub(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, { punct: PUNCT }, 'gu')],
  ['tag', () => sticky(sub(
    '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
    + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
    {
      comment: sub(COMMENT, { '(?:-->|$)': '-->' }),
      attribute: /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
    }))],
  ['autolink', () => sticky(sub(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, {
    scheme: /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/,
    email: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  }))],
  ['link', () => sticky(sub(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, {
    label: INLINE_LABEL,
    href: /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/,
    title: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
  }))],
  ['reflink', () => sticky(sub(/^!?\[(label)\]\[(ref)\]/, {
    label: INLINE_LABEL,
    ref: BLOCK_LABEL,
  }))],
  ['nolink', () => sticky(sub(/^!?\[(ref)\](?:\[\])?/, { ref: BLOCK_LABEL }))],
  ['reflinkSearch', () => sub('reflink|nolink(?!\\()', {
    reflink: sub(/^!?\[(label)\]\[(ref)\]/, {
      label: BOUNDED_INLINE_LABEL,
      ref: BOUNDED_BLOCK_LABEL,
    }),
    nolink: sub(/^!?\[(ref)\](?:\[\])?/, { ref: BOUNDED_BLOCK_LABEL }),
  }, 'g')],
  ['url', () => sticky(sub(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, {
    emailProtocol: sub(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, { email: /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/ }),
    protocol: /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    email: /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  }))],
  ['backpedal', () => /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/ ],
];

function buildGrammar() {
  const g = { blk: {}, inl: {} };
  for (const [name, make] of BLOCK_RULES) g.blk[name] = make(g.blk);
  for (const [name, make] of INLINE_RULES) g.inl[name] = make(g.inl, g.blk);
  return g;
}
const G = buildGrammar();

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
// or the start of the string. Scanned fresh per inline run (the reference
// caches this per run, and the cache never hits once the source is sliced).
function scanClosers(src) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code !== 42 && code !== 95 && code !== 126) continue;
    const prev = i === 0 ? 10 : src.charCodeAt(i - 1);
    let j = i + 1;
    while (j < src.length && src.charCodeAt(j) === code) j++;
    if (prev !== 32 && prev !== 9 && prev !== 10 && prev !== 13 && prev !== 12) {
      if (code === 42) star = i;
      else if (code === 95) under = i;
      else tilde = i;
    }
    i = j - 1;
  }
  return { star, under, tilde };
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
// Tokens
// ---------------------------------------------------------------------------

class Tok {
  constructor(type, raw) {
    this.type = type;
    this.raw = raw;
  }
}

// Classify a token for the lexer's merge rules. Fenced code also has type
// 'code', but unlike indented code it must never merge into a preceding
// paragraph: it carries a `lang` field, indented code does not.
function classify(t) {
  switch (t.type) {
    case 'code': return 'lang' in t ? 'fences' : 'code';
    case 'def': return 'def';
    case 'paragraph': return 'paragraph';
    case 'text': return 'text';
    case 'list': return 'list';
    default: return t.type;
  }
}

// ---------------------------------------------------------------------------
// Block dispatch: first character -> list of tokenizer method names, in
// the reference order. The lexer tries them in order; the first match wins.
// ---------------------------------------------------------------------------

const BLOCK_DISPATCH = new Map([
  ['#', ['headTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['>', ['quoteTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['`', ['fenceTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['~', ['fenceTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['-', ['hrTok', 'listTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['+', ['hrTok', 'listTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['*', ['hrTok', 'listTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['_', ['hrTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['<', ['htmlTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
  ['[', ['defTok', 'tableTry', 'setextTok', 'paraTry', 'textTok']],
]);
const BLOCK_DEFAULT = ['tableTry', 'setextTok', 'paraTry', 'textTok'];
const BLOCK_CODE_INDENT = ['codeTok', 'tableTry', 'setextTok', 'paraTry', 'textTok'];
const BLOCK_DIGIT = ['listTok', 'tableTry', 'setextTok', 'paraTry', 'textTok'];

// ---------------------------------------------------------------------------
// Parser: one instance per parse() call.
// ---------------------------------------------------------------------------

class Parser {
  constructor(src) {
    this.src = src;
    this.links = new Map();
    this.linkCount = 0;
    this.inLink = false;
    this.inRaw = false;
    this.emitted = false;
    this.parenOk = true;
    this.top = true;
    this.out = [];
  }

  document() {
    return this.renderAll(this.lex(this.src, []));
  }

  // -- simple block tokenizers -------------------------------------------

  codeTok(src, pos) {
    const cap = atRe(G.blk.code, src, pos);
    if (!cap) return undefined;
    const raw = trimBlankTail(cap[0]);
    const t = new Tok('code', raw);
    t.text = raw.replace(CODE_INDENT, '');
    return t;
  }

  fenceTok(src, pos) {
    const cap = atRe(G.blk.fences, src, pos);
    if (!cap) return undefined;
    const t = new Tok('code', cap[0]);
    t.lang = cap[2] ? cap[2].trim().replace(G.inl.anyPunct, '$1') : cap[2];
    t.text = indentComp(cap[0], cap[3] || '');
    return t;
  }

  headTok(src, pos) {
    const cap = atRe(G.blk.heading, src, pos);
    if (!cap) return undefined;
    let text = cap[2].trim();
    if (TRAIL_HASH.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || TRAIL_SPACE_TAB.test(trimmed)) text = trimmed.trim();
    }
    const t = new Tok('heading', rtrim(cap[0], '\n'));
    t.depth = cap[1].length;
    t.text = text;
    return t;
  }

  hrTok(src, pos) {
    const cap = atRe(G.blk.hr, src, pos);
    if (!cap) return undefined;
    return new Tok('hr', rtrim(cap[0], '\n'));
  }

  htmlTok(src, pos) {
    const cap = atRe(G.blk.html, src, pos);
    if (!cap) return undefined;
    const raw = trimBlankTail(cap[0]);
    const t = new Tok('html', raw);
    t.block = true;
    t.pre = cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style';
    t.text = raw;
    return t;
  }

  defTok(src, pos) {
    const cap = atRe(G.blk.def, src, pos);
    if (!cap) return undefined;
    if (!ANGLE_OPEN.test(cap[2]) && closeBracketAt(cap[2], '()') !== -1) return undefined;
    const t = new Tok('def', rtrim(cap[0], '\n'));
    t.tag = normLabel(cap[1]);
    t.href = cap[2] ? cap[2].replace(HREF_BRACKETS, '$1').replace(G.inl.anyPunct, '$1') : '';
    t.title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(G.inl.anyPunct, '$1') : cap[3];
    return t;
  }

  tableTok(src, pos) {
    const cap = atRe(G.blk.table, src, pos);
    if (!cap || !TABLE_DELIM.test(cap[2])) return undefined;
    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(ALIGN_TRIM, '').split('|');
    if (headers.length !== aligns.length) return undefined;
    const rows = cap[3]?.trim() ? cap[3].replace(ROW_TRAIL_BLANK, '').split('\n') : [];
    const item = new Tok('table', rtrim(cap[0], '\n'));
    item.header = [];
    item.align = [];
    item.rows = [];
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
  setextTok(src, pos) {
    const cap = atRe(G.blk.lheading, src, pos);
    if (!cap) return undefined;
    const t = new Tok('heading', rtrim(cap[0], '\n'));
    t.depth = cap[2].charAt(0) === '=' ? 1 : 2;
    t.text = cap[1].trim();
    return t;
  }

  paraTok(src, pos) {
    const cap = atRe(G.blk.paragraph, src, pos);
    if (!cap) return undefined;
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    const t = new Tok('paragraph', cap[0]);
    t.text = text;
    return t;
  }

  textTok(src, pos) {
    const cap = atRe(G.blk.text, src, pos);
    if (!cap) return undefined;
    const t = new Tok('text', cap[0]);
    t.text = cap[0];
    return t;
  }

  tableTry(src, pos) {
    if (!isTableAt(src, pos)) return undefined;
    return this.tableTok(src, pos);
  }

  paraTry(src, pos) {
    if (!this.top) return undefined;
    return this.paraTok(src, pos);
  }

  // -- blockquote and list -----------------------------------------------

  quoteTok(src, pos) {
    const cap = atRe(G.blk.blockquote, src, pos);
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
      const savedTop = this.top;
      this.top = true;
      this.lex(currentText, tokens, true);
      this.top = savedTop;
      if (lines.length === 0) break;
      const lastToken = tokens[tokens.length - 1];
      const lastType = lastToken?.type;
      if (lastType === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(QUOTE_STRIP, '');
        const newToken = this.quoteTok(newText, 0);
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
        const newToken = this.listTok(newText, 0);
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
    const t = new Tok('blockquote', raw);
    t.tokens = tokens;
    t.text = text;
    return t;
  }

  listTok(src, pos) {
    let s = src.slice(pos);
    let cap = atRe(G.blk.list, s, 0);
    if (!cap) return undefined;
    const listSrc = s;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = new Tok('list', '');
    list.ordered = isordered;
    list.start = isordered ? +bull.slice(0, -1) : '';
    list.loose = false;
    list.items = [];
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = listItemRe(bull);
    let endsWithBlankLine = false;
    while (s) {
      let endEarly = false;
      let itemContents = '';
      cap = atRe(itemRegex, s, 0);
      if (!cap) break;
      if (hasRe(G.blk.hr, s, 0)) break;
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
              && hasRe(G.blk.lheading, `${line}\n${nextLine}`, 0);
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
      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (dblBlankEnd(raw)) endsWithBlankLine = true;
      }
      const item = new Tok('list_item', raw);
      item.task = !!TASK_TEST.test(itemContents);
      item.loose = false;
      item.text = itemContents;
      item.tokens = [];
      list.items.push(item);
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = listSrc.slice(0, listSrc.length - s.length).trimEnd();
    for (let q = 0; q < list.items.length; q++) {
      const item = list.items[q];
      this.top = false;
      item.tokens = this.lex(item.text, []);
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

  // -- block lexer ---------------------------------------------------------

  blockToken(src, pos) {
    let indent = 0;
    while (src[pos + indent] === ' ') indent++;
    const c = src[pos + indent];
    // Indented code outranks everything when the indent reaches 4, and a
    // tab first character is code too; digits always try the list first.
    let cands;
    if (c === '\t' || indent >= 4) cands = BLOCK_CODE_INDENT;
    else if (c >= '0' && c <= '9') cands = BLOCK_DIGIT;
    else cands = BLOCK_DISPATCH.get(c) ?? BLOCK_DEFAULT;
    for (const name of cands) {
      const t = this[name](src, pos);
      if (t) return [t, classify(t)];
    }
    return [undefined, ''];
  }

  lex(src, tokens, lastParagraphClipped) {
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
        const cap = atRe(G.blk.newline, src, pos);
        const raw = cap[0];
        pos += raw.length;
        const last = tokens[tokens.length - 1];
        if (raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(new Tok('space', raw));
        continue;
      }

      const pair = this.blockToken(src, pos);
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
          if (!this.links.has(token.tag)) {
            this.links.set(token.tag, { href: token.href, title: token.title });
            this.linkCount++;
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
    this.top = true;
    return tokens;
  }

  // -- inline masking ------------------------------------------------------
  // Reference links are masked before emphasis scanning so a `[...][...]`
  // pair is never mistaken for emphasis delimiters; code spans and link
  // destinations are masked the same way.

  hasLinkIn(text) {
    if (!text.includes('[')) return false;
    const direct = [...text.matchAll(G.inl.blockSkip)].some((m) => {
      return hasRe(G.inl.link, m[0], 0) && text.charAt(m.index - 1) !== '!';
    });
    if (direct) return true;
    return [...text.matchAll(G.inl.reflinkSearch)].some((m) => {
      const m0 = m[0];
      const refStart = m0.lastIndexOf('[');
      if (m0.charAt(0) === '!') return false;
      if (!this.links.has(normLabel(m0.slice(refStart + 1, -1)))) return false;
      if (refStart > 1 && this.hasLinkIn(m0.slice(1, refStart - 1))) return false;
      return true;
    });
  }

  maskReflink(m0) {
    const refStart = m0.lastIndexOf('[');
    if (!this.links.has(normLabel(m0.slice(refStart + 1, -1)))) return m0;
    if (refStart > 1 && m0.charAt(0) !== '!') {
      const text = m0.slice(1, refStart - 1);
      if (this.hasLinkIn(text)) {
        return '[' + text.replace(G.inl.reflinkSearch, (mm) => this.maskReflink(mm))
          + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
      }
    }
    return '[' + 'a'.repeat(m0.length - 2) + ']';
  }

  maskSrc(src) {
    let masked = src;
    if (src.includes('[') && this.linkCount > 0) {
      masked = masked.replace(G.inl.reflinkSearch, (m0) => this.maskReflink(m0));
    }
    if (src.includes('\\') || src.includes('`')) {
      masked = masked.replace(G.inl.anyPunctOutsideCode, function (m0, code, punct) {
        if (punct) return '+'.repeat(m0.length);
        if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        return m0;
      });
    }
    if (src.includes('[') || src.includes('`') || src.includes('<')) {
      masked = masked.replace(G.inl.blockSkip, function (m0, _link, context) {
        const offset = context ? context.length : 0;
        return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
      });
    }
    return masked;
  }

  labelEndInTag(src, label, labelStart) {
    if (!label.includes('<')) return false;
    let i = 0;
    while (i < label.length) {
      const ch = label[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        const code = atRe(G.inl.code, label, i);
        if (code) { i += code[0].length; continue; }
      }
      if (ch !== '<') { i++; continue; }
      const token = atRe(G.inl.tag, src.slice(labelStart + i), 0) || atRe(G.inl.autolink, src.slice(labelStart + i), 0);
      if (token) {
        if (token[0].length > label.length - i) return true;
        i += token[0].length;
        continue;
      }
      i++;
    }
    return false;
  }

  linkTag(href, title, inner, autolink) {
    const clean = cleanHref(href);
    if (clean === null) return inner;
    const safe = escHtml(clean, autolink);
    let out = '<a href="' + safe + '"';
    if (title) out += ' title="' + escHtml(title) + '"';
    return out + '>' + inner + '</a>';
  }

  // Builds a link or image from a matched [label](href "title") /
  // [label][ref] / [label] form. Appends its HTML to this.out and returns
  // how many source characters it consumed, or 0 when the outer link must
  // fall through to plain text (a link inside a link's label).
  makeLink(cap, link, textOnly) {
    const href = link.href;
    const title = link.title || null;
    const text = cap[1].replace(LINK_BRACKET_ESC, '$1');
    const isImage = cap[0].charAt(0) === '!';
    const savedInLink = this.inLink;
    const savedEmitted = this.emitted;
    const savedRaw = this.inRaw;
    this.inLink = true;
    this.emitted = false;
    const inner = this.renderInline(text, isImage ? true : textOnly);
    const textHasLink = this.emitted;
    this.emitted = savedEmitted;
    this.inLink = savedInLink;
    if (isImage) {
      const altText = inner;
      if (textOnly) {
        this.out.push(altText);
        return cap[0].length;
      }
      const clean = cleanHref(href);
      if (clean === null) {
        this.out.push(escHtml(altText));
        return cap[0].length;
      }
      let html = `<img src="${escHtml(clean)}" alt="${escHtml(altText)}"`;
      if (title) html += ` title="${escHtml(title)}"`;
      this.out.push(html + '>');
      return cap[0].length;
    }
    if (textHasLink) {
      this.inRaw = savedRaw;
      return 0;
    }
    this.emitted = true;
    if (textOnly) {
      this.out.push(inner);
      return cap[0].length;
    }
    this.out.push(this.linkTag(href, title, inner, false));
    return cap[0].length;
  }

  // -- inline tokenizers ---------------------------------------------------
  // Each appends its HTML to this.out and returns the characters consumed,
  // or 0 when it does not match. All take the same five arguments
  // (src, pos, prevChar, run, textOnly); handlers that need neither
  // prevChar nor run ignore them. `textOnly` renders plain text, the way
  // the reference's TextRenderer does for image alt text.

  tryEscape(src, pos, _prev, _run, textOnly) {
    const cap = atRe(G.inl.escape, src, pos);
    if (!cap) return 0;
    this.out.push(textOnly ? cap[1] : escHtml(cap[1]));
    return cap[0].length;
  }

  tryTag(src, pos) {
    const cap = atRe(G.inl.tag, src, pos);
    if (!cap) return 0;
    if (!this.inLink && hasRe(A_OPEN, cap[0], 0)) this.inLink = true;
    else if (this.inLink && hasRe(A_CLOSE, cap[0], 0)) this.inLink = false;
    if (!this.inRaw && hasRe(PRE_OPEN, cap[0], 0)) this.inRaw = true;
    else if (this.inRaw && hasRe(PRE_CLOSE, cap[0], 0)) this.inRaw = false;
    this.out.push(cap[0]);
    return cap[0].length;
  }

  tryCode(src, pos, _prev, _run, textOnly) {
    const cap = atRe(G.inl.code, src, pos);
    if (!cap) return 0;
    let text = cap[2].replace(NL_GLOBAL, ' ');
    const trimBoth = NON_SPACE.test(text) && LEAD_ONE_SPACE.test(text) && TRAIL_ONE_SPACE.test(text);
    if (trimBoth) text = text.substring(1, text.length - 1);
    if (textOnly) this.out.push(text);
    else this.out.push('<code>' + escHtml(text, true) + '</code>');
    return cap[0].length;
  }

  tryBreak(src, pos, _prev, _run, textOnly) {
    const cap = atRe(G.inl.br, src, pos);
    if (!cap) return 0;
    if (!textOnly) this.out.push('<br>');
    return cap[0].length;
  }

  tryAuto(src, pos, _prev, _run, textOnly) {
    const cap = atRe(G.inl.autolink, src, pos);
    if (!cap) return 0;
    const isMail = cap[2] === '@';
    const text = cap[1];
    const href = isMail ? 'mailto:' + text : text;
    if (textOnly) this.out.push(text);
    else this.out.push(this.linkTag(href, null, escHtml(text, true), true));
    return cap[0].length;
  }

  tryUrl(src, pos, _prev, _run, textOnly) {
    const cap = atRe(G.inl.url, src, pos);
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
        const bp = G.inl.backpedal.exec(cap[0]);
        cap[0] = bp ? bp[0] : '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    if (textOnly) this.out.push(text);
    else this.out.push(this.linkTag(href, null, escHtml(text, true), true));
    return cap[0].length;
  }

  tryLink(src, pos, _prev, _run, textOnly) {
    if (this.parenOk === false) return 0;
    const cap = atRe(G.inl.link, src, pos);
    if (!cap) return 0;
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (cap[1].includes('<') && this.labelEndInTag(src.slice(pos), cap[1], labelStart)) return 0;
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
    return this.makeLink(cap, {
      href: href ? href.replace(G.inl.anyPunct, '$1') : href,
      title: title ? title.replace(G.inl.anyPunct, '$1') : title,
    }, textOnly);
  }

  tryRef(src, pos, _prev, _run, textOnly) {
    const cap = atRe(G.inl.reflink, src, pos) ?? atRe(G.inl.nolink, src, pos);
    if (!cap) return 0;
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (cap[1].includes('<') && this.labelEndInTag(src.slice(pos), cap[1], labelStart)) return 0;
    const link = this.links.get(normLabel(cap[2] || cap[1]));
    if (!link) {
      this.out.push(cap[0].charAt(0));
      return 1;
    }
    return this.makeLink(cap, link, textOnly);
  }

  tryEm(src, pos, prevChar, run, textOnly) {
    const match = atRe(G.inl.emStrongLDelim, src, pos);
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
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!G.inl.punctuation.exec(runPrevChar);
    if (runStart < srcStart) prevChar = runPrevChar;
    const prevPunct = runStart < srcStart ? runPrevPunct : !!G.inl.punctuation.exec(prevChar);
    if (match[4] && prevChar.match(ALNUM_UNICODE)) return 0;
    const nextChar = match[1] || match[3] || '';
    if (nextChar && prevChar && !prevPunct) return 0;
    let lLength = match[0].length - 1;
    if (nextChar.length === 2) lLength--;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? G.inl.emStrongRDelimAst : G.inl.emStrongRDelimUnd;
    const closers = run.scan();
    const lastPossible = delimChar === '*' ? closers.star : closers.under;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return 0;
    const masked = run.mask().slice(pos + lLength);
    const lastInWindow = lastPossible - windowStart;
    // Collect the right-delimiter matches in the window first, then walk
    // the array: the first match that balances the delimiter run wins.
    const hits = [];
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(masked)) !== null) {
      if (m.index > lastInWindow) break;
      hits.push(m);
    }
    let delimTotal = lLength;
    let midDelimTotal = 0;
    for (let k = 0; k < hits.length; k++) {
      m = hits[k];
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
        const inner = this.renderInline(raw.slice(1, -1), textOnly);
        if (textOnly) this.out.push(inner);
        else this.out.push(`<em>${inner}</em>`);
        return raw.length;
      }
      const inner = this.renderInline(raw.slice(2, -2), textOnly);
      if (textOnly) this.out.push(inner);
      else this.out.push(`<strong>${inner}</strong>`);
      return raw.length;
    }
    return 0;
  }

  tryDel(src, pos, prevChar, run, textOnly) {
    const match = atRe(G.inl.delLDelim, src, pos);
    if (!match) return 0;
    const nextChar = match[1] || '';
    // An opener can open at the start of a run, after punctuation, or when
    // there is no next character; it cannot open between two non-punctuation
    // characters.
    if (nextChar && prevChar && !G.inl.punctuation.exec(prevChar)) return 0;
    let lLength = match[0].length - 1;
    if (nextChar.length === 2) lLength--;
    const closers = run.scan();
    const windowStart = pos + lLength;
    if (closers.tilde < windowStart) return 0;
    const masked = run.mask().slice(pos + lLength);
    const lastInWindow = closers.tilde - windowStart;
    const hits = [];
    G.inl.delRDelim.lastIndex = 0;
    let m;
    while ((m = G.inl.delRDelim.exec(masked)) !== null) {
      if (m.index > lastInWindow) break;
      hits.push(m);
    }
    let delimTotal = lLength;
    for (let k = 0; k < hits.length; k++) {
      m = hits[k];
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
      const inner = this.renderInline(raw.slice(lLength, -lLength), textOnly);
      if (textOnly) this.out.push(inner);
      else this.out.push(`<del>${inner}</del>`);
      return raw.length;
    }
    return 0;
  }

  // Could a URL (extended autolink) start at pos? Covers www., http(s)://,
  // ftp://, mailto:, xmpp: and bare email addresses. The check is a superset
  // of the matcher's: a false positive only costs a failed regex attempt.
  urlStartAt(src, pos) {
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

  emailLocalChar(ch) {
    const cc = ch.charCodeAt(0);
    return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
      || cc === 46 || cc === 95 || cc === 43 || cc === 45;
  }

  // -- inline driver -------------------------------------------------------
  // Handlers append to this.out and report characters consumed (0 = no
  // match). Plain-text runs are consumed by one scan (textStop).

  renderInline(src, textOnly) {
    const savedOut = this.out;
    const savedParen = this.parenOk;
    this.parenOk = savedParen && src.includes(')');
    this.out = [];
    try {
      this.inlineGo(src, textOnly);
      return this.out.join('');
    } finally {
      this.out = savedOut;
      this.parenOk = savedParen;
    }
  }

  inlineGo(src, textOnly) {
    const run = makeRun(this, src);
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
      switch (ch) {
        case '\\':
          used = this.tryEscape(src, pos, prevChar, run, textOnly)
            || this.tryBreak(src, pos, prevChar, run, textOnly);
          break;
        case '<':
          used = this.tryTag(src, pos)
            || this.tryAuto(src, pos, prevChar, run, textOnly);
          break;
        case '[':
        case '!':
          used = this.tryLink(src, pos, prevChar, run, textOnly)
            || this.tryRef(src, pos, prevChar, run, textOnly);
          break;
        case '*':
        case '_':
          used = this.tryEm(src, pos, prevChar, run, textOnly);
          break;
        case '`':
          used = this.tryCode(src, pos, prevChar, run, textOnly);
          break;
        case '~':
          used = this.tryDel(src, pos, prevChar, run, textOnly);
          break;
        case ' ':
          used = this.tryBreak(src, pos, prevChar, run, textOnly);
          break;
        default:
          break;
      }
      // The URL rule runs before text for every position: an email can
      // start with _ (narrow local set), so try it once emphasis fails.
      if (!used && ch === '_' && !this.inLink && this.urlStartAt(src, pos)) {
        used = this.tryUrl(src, pos, textOnly);
      }
      if (!used && !this.inLink && this.emailLocalChar(ch) && this.urlStartAt(src, pos)) {
        used = this.tryUrl(src, pos, textOnly);
      }
      if (used) {
        pos += used;
        continue;
      }
      const stop = this.textStop(src, pos);
      const rawText = src.slice(pos, stop);
      const decoded = this.inRaw ? rawText : decodeRefs(rawText);
      if (textOnly || this.inRaw) this.out.push(decoded);
      else this.out.push(escHtml(decoded));
      if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
      keepPrevChar = true;
      pos += rawText.length;
    }
  }

  // GFM inline text: stops before structural characters, hard breaks,
  // autolinkable protocols / www. / email starts. One for loop over the
  // character codes tracks both stops at once and quits as soon as the
  // answer is settled:
  //  - cheap: the first structural char, 2+ spaces before \n, or protocol
  //    / www. / mailto: / xmpp: start, mirroring the reference's lazy
  //    text regex;
  //  - email: the earliest start of an email-local run that reaches an @
  //    (a run may legitimately reach back before the cheap stop).
  // The answer is the smaller of the two (or the end of the string).
  // The first character (or a run of ` / ~) is always consumed. www. only
  // counts after whitespace / * / _ / ~ / ( or at the start; mailto:/xmpp:
  // only after a non-alphanumeric char the lazy part can consume, and
  // mailto: at exactly minEnd is only a stop when the run started with a
  // single character (a ` / ~ run of 2+ consumes the run first).
  textStop(src, pos) {
    const len = src.length;
    let minEnd = pos + 1;
    const c0 = src[pos];
    if (c0 === '`' || c0 === '~') {
      while (minEnd < len && src[minEnd] === c0) minEnd++;
    }
    let cheap = -1;
    let localStart = pos;
    for (let i = minEnd; i < len; i++) {
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
      if (cheap === -1) {
        switch (cc) {
          case 92: // \
          case 96: // `
          case 60: // <
          case 91: // [
          case 33: // !
          case 42: // *
          case 95: // _
          case 126: // ~
            cheap = i;
            break;
          case 32: // space
            if (src[i + 1] === ' ') {
              let j = i + 2;
              while (src[j] === ' ') j++;
              if (src[j] === '\n') cheap = i;
            }
            break;
          case 104: // h
          case 72: // H
          case 102: // f
          case 70: { // F
            const s = src.slice(i, i + 8).toLowerCase();
            if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ftp://')) cheap = i;
            break;
          }
          case 119: // w
            if (src.startsWith('www.', i)) {
              const prev = i === 0 ? '' : src[i - 1];
              if (prev === '' || ' \t\n\r\f\v*_~('.includes(prev)) cheap = i;
            }
            break;
          case 109: // m
          case 120: { // x
            if ((cc === 109 && src.startsWith('mailto:', i)) || (cc === 120 && src.startsWith('xmpp:', i))) {
              const prev = i === 0 ? '' : src[i - 1];
              const prevAlnum = prev !== '' && /[a-zA-Z0-9]/.test(prev);
              if (!prevAlnum && prev !== '' && !(i === minEnd && minEnd !== pos + 1)) cheap = i;
            }
            break;
          }
          default:
            break;
        }
        if (cheap !== -1 && localStart > cheap) return cheap;
      }
    }
    if (cheap === -1) return len;
    return cheap;
  }

  // -- block rendering -----------------------------------------------------

  renderOne(token) {
    switch (token.type) {
      case 'space':
        return '';
      case 'hr':
        return '<hr>\n';
      case 'heading':
        this.inRaw = false;
        return `<h${token.depth}>${this.renderInline(token.text, false)}</h${token.depth}>\n`;
      case 'code':
        return this.codeHtml(token);
      case 'table':
        return this.tableHtml(token);
      case 'blockquote':
        return `<blockquote>\n${this.renderAll(token.tokens)}</blockquote>\n`;
      case 'list':
        return this.listHtml(token);
      case 'html':
        return token.text;
      case 'def':
        return '';
      case 'paragraph':
        this.inRaw = false;
        return `<p>${this.renderInline(token.text, false)}</p>\n`;
      case 'text':
        this.inRaw = false;
        return this.renderInline(token.text, false);
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }

  renderAll(tokens) {
    const parts = [];
    for (let k = 0; k < tokens.length; k++) parts.push(this.renderOne(tokens[k]));
    return parts.join('');
  }

  codeHtml(token) {
    const langString = (token.lang || '').match(NON_SPACE_START)?.[0];
    const code = token.text ? token.text.replace(TRAIL_NL, '') + '\n' : '';
    if (!langString) return '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
    return '<pre><code class="language-' + escHtml(langString) + '">'
      + escHtml(code, true) + '</code></pre>\n';
  }

  checkboxHtml(checked) {
    if (checked) return '<input checked="" disabled="" type="checkbox"> ';
    return '<input disabled="" type="checkbox"> ';
  }

  cellHtml(cell) {
    this.inRaw = false;
    const content = this.renderInline(cell.text, false);
    const type = cell.header ? 'th' : 'td';
    let open = `<${type}`;
    if (cell.align) open += ` align="${cell.align}"`;
    return open + '>' + content + `</${type}>\n`;
  }

  tableHtml(token) {
    const headParts = [];
    for (let h = 0; h < token.header.length; h++) headParts.push(this.cellHtml(token.header[h]));
    const headCells = headParts.join('');
    let body = '';
    for (let r = 0; r < token.rows.length; r++) {
      const rowParts = [];
      for (let c = 0; c < token.rows[r].length; c++) rowParts.push(this.cellHtml(token.rows[r][c]));
      body += `<tr>\n${rowParts.join('')}</tr>\n`;
    }
    let out = '<table>\n<thead>\n<tr>\n' + headCells + '</tr>\n</thead>\n';
    if (body) out += `<tbody>${body}</tbody>`;
    return out + '</table>\n';
  }

  itemHtml(item, listLoose) {
    if (!item.task) return `<li>${this.renderAll(item.tokens)}</li>\n`;
    const box = this.checkboxHtml(item.checked);
    if (!listLoose) return `<li>${box}${this.renderAll(item.tokens)}</li>\n`;
    const first = item.tokens[0];
    if (first?.type === 'paragraph') {
      this.inRaw = false;
      const firstHtml = this.renderInline(first.text, false);
      const parts = [`<li><p>${box}`, firstHtml, '</p>\n'];
      for (let k = 1; k < item.tokens.length; k++) parts.push(this.renderOne(item.tokens[k]));
      parts.push('</li>\n');
      return parts.join('');
    }
    return `<li><p>${box}</p>\n${this.renderAll(item.tokens)}</li>\n`;
  }

  listHtml(token) {
    const type = token.ordered ? 'ol' : 'ul';
    let open = '<' + type;
    if (token.ordered && token.start !== 1) open += ' start="' + token.start + '"';
    const parts = [open + '>\n'];
    for (let q = 0; q < token.items.length; q++) parts.push(this.itemHtml(token.items[q], token.loose));
    parts.push('</' + type + '>\n');
    return parts.join('');
  }
}

// One inline run's masked source and closer scan, computed lazily and
// shared by every opener in the run.
function makeRun(p, src) {
  let masked = null;
  let closers = null;
  return {
    src,
    mask() {
      if (masked === null) masked = p.maskSrc(src);
      return masked;
    },
    scan() {
      if (closers === null) closers = scanClosers(this.mask());
      return closers;
    },
  };
}

// True when any regex in `res` matches `ln` at position 0.
function anyStarts(res, ln) {
  for (let k = 0; k < res.length; k++) {
    if (hasRe(res[k], ln, 0)) return true;
  }
  return false;
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
  const p = new Parser(markdown.replace(CR_RE, '\n'));
  return p.document();
}

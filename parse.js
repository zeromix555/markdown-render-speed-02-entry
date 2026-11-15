// Fast Markdown renderer: parse(markdown) returns exactly the HTML that
// marked 18.1.3 renders with its default options (GFM on, breaks off,
// pedantic off, async off). Dependency-free ES module.
//
// Design: a fresh implementation of the same grammar, built for speed.
// - One module-level state object, reset per parse() call; no classes, no
//   per-parse allocation of lexer/parser/renderer objects.
// - Block and inline scanning run on an index into the source string with
//   sticky regexes (no repeated substring slicing of the remainder).
// - Block dispatch: the first characters of a line narrow the candidate
//   block rules to the few that can match, in the reference order.
// - Inline rendering writes HTML straight out of the scanner instead of
//   building an intermediate token tree; plain-text runs are consumed by
//   one regex call, and structural tokens are dispatched on the first char.
// - The emphasis/strikethrough mask is built lazily, only when a run
//   actually contains a possible opener.

'use strict';

// ---------------------------------------------------------------------------
// Regex construction helpers
// ---------------------------------------------------------------------------

// Build a regex from a string or regex, with replace()/getRegex() chaining
// (the same device the reference grammar uses to compose its rules).
function edit(pattern, flags) {
  let source = typeof pattern === 'string' ? pattern : pattern.source;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, flags || '');
    },
  };
  return obj;
}

// Turn an anchored (^...) regex into a sticky one that matches at an index
// inside a longer string. The ^ anchor cannot stay: with the sticky flag it
// would only match at index 0. The sticky flag itself is the anchor.
function sticky(re) {
  let s = re.source;
  // Strip every ^ that is an anchor: at the start, or after | or ( (including
  // (?: ). A ^ inside a character class ([^...) or an escaped \^ is not an
  // anchor and is left alone.
  s = s.replace(/(^|[|(:])\^/g, '$1');
  const flags = re.flags.replace('g', '').replace('y', '') + 'y';
  return new RegExp(s, flags);
}

// Execute a sticky regex at `pos` (lastIndex is always set first, so shared
// regexes stay safe under re-entrant calls).
function at(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

function atTest(re, str, pos) {
  re.lastIndex = pos;
  return re.test(str);
}

// First line of s (up to the first \n, or the whole string).
function firstLineOf(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// True when the single line is empty or only spaces/tabs.
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Index of the first character that is not a space, or -1.
function firstNonSpace(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ') return i;
  }
  return -1;
}

// Whether raw ends with a blank line: \n[ \t]*\n[ \t]*$ (marked's
// doubleBlankLine), checked without a regex.
function endsWithDoubleBlank(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return i > 0 && raw[i - 1] === '\n';
}

function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = make(idx);
      cache[idx] = re;
    }
    return re;
  };
}

// ---------------------------------------------------------------------------
// Shared small patterns ("other")
// ---------------------------------------------------------------------------

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => sticky(new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`)),
  nextBulletRegex: cachedIndentRegex((i) => sticky(new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`))),
  hrRegex: cachedIndentRegex((i) => sticky(new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`))),
  fencesBeginRegex: cachedIndentRegex((i) => sticky(new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`))),
  headingBeginRegex: cachedIndentRegex((i) => sticky(new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`))),
  htmlBeginRegex: cachedIndentRegex((i) => sticky(new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'))),
  blockquoteBeginRegex: cachedIndentRegex((i) => sticky(new RegExp(`^ {0,${i}}>`))),
};

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const R_NEWLINE = sticky(/^(?:[ \t]*(?:\n|$))+/);
const R_BLOCK_CODE = sticky(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
const R_FENCES = sticky(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
const R_HR = sticky(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
const R_HEADING = sticky(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const R_BLOCK_TEXT = sticky(/^[^\n]+/);

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const R_LHEADING = sticky(edit(LHEADING_CORE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex());

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const R_DEF = sticky(edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', BLOCK_LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex());

const R_LIST = sticky(edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET)
  .getRegex());

const R_HTML = sticky(edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', COMMENT)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex());

const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const R_PARAGRAPH = sticky(edit(PARAGRAPH_CORE)
  .replace('hr', R_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', edit(
    '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
    .replace('hr', R_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG)
    .getRegex())
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .getRegex());

const R_TABLE = sticky(edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', R_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .getRegex());

const R_BLOCKQUOTE = sticky(edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', edit(PARAGRAPH_CORE)
    .replace('hr', R_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG)
    .getRegex())
  .getRegex());

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const R_ESCAPE = sticky(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/);
const R_INLINE_CODE = sticky(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
const R_BR = sticky(/^( {2,}|\\)\n(?!\s*$)[ \t]*/);

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM_STRONG = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM_STRONG = /(?:[^\s\p{P}\p{S}]|~)/u;
const R_PUNCTUATION = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_OR_SPACE).getRegex();

const BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const EM_STRONG_L_DELIM_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const R_EM_STRONG_L_DELIM = sticky(edit(EM_STRONG_L_DELIM_CORE, 'u')
  .replace(/punct/g, PUNCT_GFM_STRONG)
  .getRegex());

const EM_STRONG_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const R_EM_STRONG_R_DELIM_AST = edit(EM_STRONG_R_DELIM_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM_STRONG)
  .replace(/punctSpace/g, PUNCT_OR_SPACE_GFM_STRONG)
  .replace(/punct/g, PUNCT_GFM_STRONG)
  .getRegex();

const R_EM_STRONG_R_DELIM_UND = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const R_DEL_L_DELIM = sticky(edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex());

const DEL_R_DELIM_CORE =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const R_DEL_R_DELIM = edit(DEL_R_DELIM_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const R_DEL = sticky(/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/);

const R_ANY_PUNCT = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();

const R_ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();

const INLINE_COMMENT = edit(COMMENT).replace('(?:-->|$)', '-->').getRegex();
const R_TAG = sticky(edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // self-closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .replace('comment', INLINE_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex());

const R_AUTOLINK = sticky(edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex());

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .getRegex();

const R_LINK = sticky(edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', INLINE_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex());

const R_REFLINK = sticky(edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', INLINE_LABEL)
  .replace('ref', BLOCK_LABEL)
  .getRegex());

const R_NOLINK = sticky(edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', BLOCK_LABEL)
  .getRegex());

const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .getRegex();

const R_REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', BOUNDED_INLINE_LABEL)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .getRegex())
  .getRegex();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EXTENDED_EMAIL)
  .getRegex();

const R_URL = sticky(edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex());

const R_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// GFM inline text: stops before structural characters, hard breaks,
// autolinkable protocols / www. / email starts. Implemented as a manual
// stop scanner instead of marked's lazy text regex: the regex's lazy part
// re-checks the email lookahead at every position (quadratic on long
// words), while the scanner finds the earliest stop in one pass.
//
// The scanner mirrors the regex exactly:
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
const TEXT_STOP = /[\\`<\[!*_~]| {2,}(?=\n)|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|(?<=[^a-zA-Z0-9])mailto:|(?<=[^a-zA-Z0-9])xmpp:/g;

function isEmailLocalCode(cc) {
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
    || cc === 46 || cc === 33 || cc === 35 || cc === 36 || cc === 37 || cc === 38
    || cc === 39 || cc === 42 || cc === 43 || cc === 47 || cc === 61 || cc === 63
    || cc === 96 || cc === 123 || cc === 124 || cc === 125 || cc === 126
    || cc === 45 || cc === 95;
}

function textEnd(src, pos) {
  const len = src.length;
  let minEnd = pos + 1;
  const c0 = src[pos];
  if (c0 === '`' || c0 === '~') {
    while (minEnd < len && src[minEnd] === c0) minEnd++;
  }
  let stop = len;
  TEXT_STOP.lastIndex = minEnd;
  let m;
  while ((m = TEXT_STOP.exec(src)) !== null) {
    const P = m.index;
    // mailto:/xmpp: right after a multi-char ` / ~ run is not a stop.
    if ((m[0] === 'mailto:' || m[0] === 'xmpp:') && P === minEnd && minEnd !== pos + 1) continue;
    stop = P;
    break;
  }
  // Earliest email stop: scan @s in order; walk each local run back.
  let at = src.indexOf('@', pos);
  while (at !== -1) {
    let P = at;
    while (P > pos && isEmailLocalCode(src.charCodeAt(P - 1))) P--;
    if (P < at) {
      const S = P < minEnd ? minEnd : P;
      if (S < at) {
        if (S < stop) stop = S;
        break;
      }
    }
    at = src.indexOf('@', at + 1);
  }
  return stop;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent) {
  let col = indent || 0;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// Last indexes of `*` / `_` / `~` runs that can close emphasis, strong or
// strikethrough: a run counts only when not preceded by ASCII whitespace or
// the start of the string. Scanned fresh per inline run (the reference
// caches this per run, and the cache never hits once the source is sliced).
function scanClosers(src) {
  let star = -1, under = -1, tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else under = i;
    }
    i = j - 1;
  }
  return { star, under, tilde };
}

// ---------------------------------------------------------------------------
// Per-parse state (reset by parse())
// ---------------------------------------------------------------------------

const S = {
  links: null,
  linkCount: 0,
  inLink: false,
  inRawBlock: false,
  linkEmitted: false,
  linkParenPossible: true,
  top: true,
};

// ---------------------------------------------------------------------------
// Block guards: cheap necessary conditions for the two expensive rules
// ---------------------------------------------------------------------------

// A table needs a header line and, on the next line, a delimiter row made
// only of | : - and spaces, starting with | : or -, holding at least one -
// and at least one | or :.
function tableGuard(src, pos) {
  let i = pos;
  while (src[i] === ' ') i++;
  if (src[i] === '\n' || src[i] === undefined) return false;
  const e1 = src.indexOf('\n', pos);
  if (e1 === -1) return false;
  let l2 = e1 + 1;
  let sp = 0;
  while (src[l2 + sp] === ' ' && sp < 3) sp++;
  const first = src[l2 + sp];
  if (first !== '|' && first !== ':' && first !== '-') return false;
  let hasDash = false, hasPipeColon = false;
  let k = l2 + sp;
  while (k < src.length && src[k] !== '\n') {
    const cc = src[k];
    if (cc === '-') hasDash = true;
    else if (cc === '|' || cc === ':') hasPipeColon = true;
    else if (cc !== ' ') return false;
    k++;
  }
  return hasDash && hasPipeColon;
}

// A setext heading needs an underline line (<=3 spaces, then all = or all -,
// then spaces/tabs) on some line before the next blank line.
function lheadingGuard(src, pos) {
  const len = src.length;
  let lineStart = src.indexOf('\n', pos);
  if (lineStart === -1) return false;
  lineStart++;
  while (lineStart < len) {
    let k = lineStart;
    while (src[k] === ' ' || src[k] === '\t') k++;
    if (src[k] === '\n' || k >= len) return false;
    let j = lineStart, sp = 0;
    while (src[j] === ' ' && sp < 3) { j++; sp++; }
    const u = src[j];
    if (u === '=' || u === '-') {
      let m = j + 1;
      while (src[m] === u || src[m] === ' ' || src[m] === '\t') m++;
      if (src[m] === '\n' || m >= len) return true;
    }
    const nl = src.indexOf('\n', lineStart);
    if (nl === -1) return false;
    lineStart = nl + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes (src, pos) and returns a token or undefined.
// Tokens carry only what the renderer needs: inline text is rendered on
// demand from the token's `text` field, never pre-tokenized.
// ---------------------------------------------------------------------------

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(O.beginningSpace);
    if (mm === null) return node;
    const [indentInNode] = mm;
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function tokCode(src, pos) {
  const cap = at(R_BLOCK_CODE, src, pos);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(O.codeRemoveIndent, '');
    return { type: 'code', raw, text };
  }
}

function tokFences(src, pos) {
  const cap = at(R_FENCES, src, pos);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code', raw,
      lang: cap[2] ? cap[2].trim().replace(R_ANY_PUNCT, '$1') : cap[2],
      text,
    };
  }
}

function tokHeading(src, pos) {
  const cap = at(R_HEADING, src, pos);
  if (cap) {
    let text = cap[2].trim();
    if (O.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
  }
}

function tokHr(src, pos) {
  const cap = at(R_HR, src, pos);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(src, pos) {
  const cap = at(R_BLOCKQUOTE, src, pos);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(O.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = S.top;
    S.top = true;
    blockTokens(currentText, tokens, true);
    S.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
      break;
    } else if (lastToken?.type === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(newText, 0);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(newText, 0);
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
  }
  return { type: 'blockquote', raw, tokens, text };
}

function tokList(src, pos) {
  let s = src.slice(pos);
  let cap = at(R_LIST, s, 0);
  if (!cap) return undefined;
  const listSrc = s;
  const taken = () => listSrc.length - s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list', raw: '', ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = at(itemRegex, s, 0))) break;
    if (atTest(R_HR, s, 0)) break;
    const itemStart = taken();
    s = s.substring(cap[0].length);
    const firstLine = firstLineOf(cap[2]);
    const bulletIndent = cap[1].length;
    let line = (firstLine[0] === ' ' || firstLine[0] === '\t')
      ? firstLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent))
      : firstLine;
    let nextLine = firstLineOf(s);
    let blankLine = isBlankLine(line);
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = firstNonSpace(line);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && O.blankLine.test(nextLine)) {
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);
      while (s) {
        const rawLine = firstLineOf(s);
        nextLine = rawLine;
        const nextLineWithoutTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
          ? nextLine.replace(O.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
          : nextLine;
        // Block-start guards: fences/heading/html/blockquote/bullet/hr can
        // only match when the line's first non-space char (within the
        // allowed indent) is one of their markers.
        const nonSpaceIdx = firstNonSpace(nextLineWithoutTabs);
        if (nonSpaceIdx !== -1 && nonSpaceIdx <= indent) {
          const c = nextLineWithoutTabs[nonSpaceIdx];
          if (c === '`' || c === '~' || c === '#' || c === '<' || c === '>' ||
              c === '-' || c === '_' || c === '*' || c === '+' || (c >= '0' && c <= '9')) {
            if (atTest(fencesBeginRegex, nextLine, 0)) break;
            if (atTest(headingBeginRegex, nextLine, 0)) break;
            if (atTest(htmlBeginRegex, nextLine, 0)) break;
            if (atTest(blockquoteBeginRegex, nextLine, 0)) break;
            if (atTest(nextBulletRegex, nextLine, 0)) break;
            if (atTest(hrRegex, nextLine, 0)) break;
          }
        }
        if (nonSpaceIdx >= indent || isBlankLine(nextLine)) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          const lineNonSpace = line.indexOf('\t') === -1
            ? firstNonSpace(line)
            : line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar);
          if (lineNonSpace >= 4) break;
          const lineNonSpaceIdx = firstNonSpace(line);
          if (lineNonSpaceIdx !== -1) {
            const lc = line[lineNonSpaceIdx];
            if (lc === '`' || lc === '~' || lc === '#' || lc === '<' ||
                lc === '-' || lc === '_' || lc === '*') {
              if (atTest(fencesBeginRegex, line, 0)) break;
              if (atTest(headingBeginRegex, line, 0)) break;
              if (atTest(htmlBeginRegex, line, 0)) break;
              if (atTest(hrRegex, line, 0)) break;
            }
          }
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && atTest(R_LHEADING, `${line}\n${nextLine}`, 0);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = isBlankLine(nextLine);
        s = s.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (endsWithDoubleBlank(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      type: 'list_item', raw, task: !!O.listIsTask.test(itemContents),
      loose: false, text: itemContents, tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (const item of list.items) {
    S.top = false;
    item.tokens = blockTokens(item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        item.checked = taskRaw[0] !== '[ ]';
        item.checkboxRaw = taskRaw[0] + ' ';
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return list;
}

function tokHtml(src, pos) {
  const cap = at(R_HTML, src, pos);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html', block: true, raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokDef(src, pos) {
  const cap = at(R_DEF, src, pos);
  if (cap) {
    if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(R_ANY_PUNCT, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(R_ANY_PUNCT, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(src, pos) {
  const cap = at(R_TABLE, src, pos);
  if (!cap) return undefined;
  if (!O.tableDelimiter.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return undefined;
  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) item.align.push('right');
    else if (O.tableAlignCenter.test(align)) item.align.push('center');
    else if (O.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({ text: cell, header: false, align: item.align[i] })));
  }
  return item;
}

function tokLheading(src, pos) {
  const cap = at(R_LHEADING, src, pos);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text };
  }
}

function tokParagraph(src, pos) {
  const cap = at(R_PARAGRAPH, src, pos);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text };
  }
}

function tokText(src, pos) {
  const cap = at(R_BLOCK_TEXT, src, pos);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0] };
}

// ---------------------------------------------------------------------------
// Block lexer: dispatch on the line's indent and first character, trying only
// the rules that can match, in the reference order.
// ---------------------------------------------------------------------------

function blockTokens(src, tokens, lastParagraphClipped) {
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
      const cap = at(R_NEWLINE, src, pos);
      const raw = cap[0];
      pos += raw.length;
      const last = tokens[tokens.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push({ type: 'space', raw });
      continue;
    }

    let indent = 0;
    while (src[pos + indent] === ' ') indent++;
    const c = src[pos + indent];
    let token;
    let kind = '';

    const tryTable = () => { if (tableGuard(src, pos)) { token = tokTable(src, pos); kind = 'table'; } };
    const tryLheading = () => { if (lheadingGuard(src, pos)) { token = tokLheading(src, pos); kind = 'lheading'; } };
    const tryParagraph = () => { if (S.top) { token = tokParagraph(src, pos); kind = 'paragraph'; } };
    const tryText = () => { token = tokText(src, pos); kind = 'text'; };

    if (c === '\t') {
      token = tokCode(src, pos); kind = 'code';
      if (!token) { tryTable(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (indent >= 4) {
      token = tokCode(src, pos); kind = 'code';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c === '#') {
      token = tokHeading(src, pos); kind = 'heading';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c === '>') {
      token = tokBlockquote(src, pos); kind = 'blockquote';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c === '`' || c === '~') {
      token = tokFences(src, pos); kind = 'fences';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c === '-' || c === '+' || c === '*' || c === '_') {
      token = tokHr(src, pos); kind = 'hr';
      if (!token && c !== '_') { token = tokList(src, pos); kind = 'list'; }
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c >= '0' && c <= '9') {
      token = tokList(src, pos); kind = 'list';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c === '<') {
      token = tokHtml(src, pos); kind = 'html';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else if (c === '[') {
      token = tokDef(src, pos); kind = 'def';
      if (!token) { tryTable(); }
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    } else {
      tryTable();
      if (!token) { tryLheading(); }
      if (!token) { tryParagraph(); }
      if (!token) { tryText(); }
    }

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
        if (!Object.hasOwn(S.links, token.tag)) { S.links[token.tag] = { href: token.href, title: token.title }; S.linkCount++; }
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
  S.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline rendering. renderInline(src, textOnly) renders one inline run to
// HTML (textOnly: plain text, as the reference's TextRenderer does, used for
// image alt text). No token tree is built: structural tokens are dispatched
// on their first character and plain-text runs are consumed by one regex.
// ---------------------------------------------------------------------------

function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (atTest(R_LINK, match[0], 0) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(R_REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskSrc(src) {
  let masked = src;
  if (src.includes('[') && S.linkCount > 0) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(R_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(R_REFLINK_SEARCH, maskReflink);
  }
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(R_ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return masked;
}

function getMask(run) {
  if (run.masked === null) run.masked = maskSrc(run.src);
  return run.masked;
}

// One scan of the run's masked source for the last emphasis, strong and
// strikethrough closers, shared by every opener in the run.
function getClosers(run) {
  if (run.closers === null) run.closers = scanClosers(getMask(run));
  return run.closers;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = at(R_INLINE_CODE, label, i);
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = at(R_TAG, tokenSrc, 0) || at(R_AUTOLINK, tokenSrc, 0);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function renderLinkHtml(href, title, parsedText, autolink) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return parsedText;
  href = escapeHtmlEntities(cleanHref, autolink);
  let out = '<a href="' + href + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}

// Builds a link or image from a matched [label](href "title") /
// [label][ref] / [label] form. Returns {html, adv} or null when the outer
// link must fall through to plain text (a link inside a link's label).
function outputLink(cap, link, textOnly) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const inner = renderInline(text, isImage ? true : textOnly);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      S.inRawBlock = outerInRawBlock;
      return null;
    }
    S.linkEmitted = true;
    if (textOnly) return { html: inner, adv: cap[0].length };
    return { html: renderLinkHtml(href, title, inner, false), adv: cap[0].length };
  }
  const altText = inner;
  if (textOnly) return { html: altText, adv: cap[0].length };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: escapeHtmlEntities(altText), adv: cap[0].length };
  let out = `<img src="${escapeHtmlEntities(cleanHref)}" alt="${escapeHtmlEntities(altText)}"`;
  if (title) out += ` title="${escapeHtmlEntities(title)}"`;
  out += '>';
  return { html: out, adv: cap[0].length };
}

function tryEscape(src, pos, textOnly) {
  const cap = at(R_ESCAPE, src, pos);
  if (cap) return { html: textOnly ? cap[1] : escapeHtmlEntities(cap[1]), adv: cap[0].length };
  return null;
}

function tryTag(src, pos) {
  const cap = at(R_TAG, src, pos);
  if (cap) {
    if (!S.inLink && atTest(O.startATag, cap[0], 0)) S.inLink = true;
    else if (S.inLink && atTest(O.endATag, cap[0], 0)) S.inLink = false;
    if (!S.inRawBlock && atTest(O.startPreScriptTag, cap[0], 0)) S.inRawBlock = true;
    else if (S.inRawBlock && atTest(O.endPreScriptTag, cap[0], 0)) S.inRawBlock = false;
    return { html: cap[0], adv: cap[0].length };
  }
  return null;
}

function tryCodespan(src, pos, textOnly) {
  const cap = at(R_INLINE_CODE, src, pos);
  if (cap) {
    let text = cap[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpaceChars = O.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { html: textOnly ? text : '<code>' + escapeHtmlEntities(text, true) + '</code>', adv: cap[0].length };
  }
  return null;
}

function tryBr(src, pos, textOnly) {
  const cap = at(R_BR, src, pos);
  if (cap) return { html: textOnly ? '' : '<br>', adv: cap[0].length };
  return null;
}

function tryAutolink(src, pos, textOnly) {
  const cap = at(R_AUTOLINK, src, pos);
  if (cap) {
    let text, href;
    if (cap[2] === '@') { text = cap[1]; href = 'mailto:' + text; }
    else { text = cap[1]; href = text; }
    if (textOnly) return { html: text, adv: cap[0].length };
    return { html: renderLinkHtml(href, null, escapeHtmlEntities(text, true), true), adv: cap[0].length };
  }
  return null;
}

function tryUrl(src, pos, textOnly) {
  const cap = at(R_URL, src, pos);
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
  return { html: renderLinkHtml(href, null, escapeHtmlEntities(text, true), true), adv: cap[0].length };
}

function tryLink(src, pos, textOnly) {
  if (S.linkParenPossible === false) return null;
  const cap = at(R_LINK, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && isLabelEndInsideToken(src.slice(pos), cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    if (!O.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
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
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(cap, {
    href: href ? href.replace(R_ANY_PUNCT, '$1') : href,
    title: title ? title.replace(R_ANY_PUNCT, '$1') : title,
  }, textOnly);
}

function tryReflink(src, pos, textOnly) {
  let cap = at(R_REFLINK, src, pos);
  if (!cap) cap = at(R_NOLINK, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (cap[1].includes('<') && isLabelEndInsideToken(src.slice(pos), cap[1], labelStart)) return null;
  const link = S.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    return { html: text, adv: 1 };
  }
  return outputLink(cap, link, textOnly);
}

function tryEmStrong(src, pos, prevChar, run, textOnly) {
  const match = at(R_EM_STRONG_L_DELIM, src, pos);
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
    runPrevChar = (c >= '\uDC00' && c <= '\uDFFF' && i > 0 && maskedSrc[i - 1] >= '\uD800' && maskedSrc[i - 1] <= '\uDBFF')
      ? maskedSrc[i - 1] + c : c;
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!R_PUNCTUATION.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!R_PUNCTUATION.exec(prevChar);
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    let lLength = match[0].length - 1;
    if (nextChar.length === 2) lLength--;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
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
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(masked)) !== null) {
      if (m.index > lastInWindow) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (m[3] || m[4]) { delimTotal += rLength; continue; }
      else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const inner = renderInline(raw.slice(1, -1), textOnly);
        return { html: textOnly ? inner : `<em>${inner}</em>`, adv: raw.length };
      }
      const inner = renderInline(raw.slice(2, -2), textOnly);
      return { html: textOnly ? inner : `<strong>${inner}</strong>`, adv: raw.length };
    }
  }
  return null;
}

function tryDel(src, pos, prevChar, run, textOnly) {
  const match = at(R_DEL_L_DELIM, src, pos);
  if (!match) return null;
  const nextChar = match[1] || '';
  // An opener can open at the start of a run, after punctuation, or when
  // there is no next character; it cannot open between two non-punctuation
  // characters.
  if (nextChar && prevChar && !R_PUNCTUATION.exec(prevChar)) return null;
  let lLength = match[0].length - 1;
  if (nextChar.length === 2) lLength--;
  let rDelim, rLength, delimTotal = lLength;
  const closers = getClosers(run);
  const windowStart = pos + lLength;
  if (closers.tilde < windowStart) return null;
  const masked = getMask(run).slice(pos + lLength);
  const lastInWindow = closers.tilde - windowStart;
  R_DEL_R_DELIM.lastIndex = 0;
  let m;
  while ((m = R_DEL_R_DELIM.exec(masked)) !== null) {
    if (m.index > lastInWindow) break;
    rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!rDelim) continue;
    rLength = rDelim.length;
    if (rLength !== lLength) continue;
    if (m[3] || m[4]) { delimTotal += rLength; continue; }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;
    rLength = Math.min(rLength, rLength + delimTotal);
    const lastCharLength = m[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + rLength);
    const inner = renderInline(raw.slice(lLength, -lLength), textOnly);
    return { html: textOnly ? inner : `<del>${inner}</del>`, adv: raw.length };
  }
  return null;
}

// Could a URL (extended autolink) start at pos? Covers www., http(s)://,
// ftp://, mailto:, xmpp: and bare email addresses. The check is a superset
// of the matcher's: a false positive only costs a failed regex attempt.
function isUrlStart(src, pos) {
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

function isEmailLocalChar(ch) {
  const cc = ch.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)
    || cc === 46 || cc === 95 || cc === 43 || cc === 45;
}

function renderInline(src, textOnly) {
  const run = { src, masked: null, closers: null };
  const prevParen = S.linkParenPossible;
  S.linkParenPossible = prevParen && src.includes(')');
  try {
    return renderInlineInner(src, run, textOnly);
  } finally {
    S.linkParenPossible = prevParen;
  }
}

function renderInlineInner(src, run, textOnly) {
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
      if (!r) r = tryBr(src, pos, textOnly);
    } else if (ch === '<') {
      r = tryTag(src, pos);
      if (!r) r = tryAutolink(src, pos, textOnly);
    } else if (ch === '[' || ch === '!') {
      r = tryLink(src, pos, textOnly);
      if (!r) r = tryReflink(src, pos, textOnly);
    } else if (ch === '*' || ch === '_') {
      r = tryEmStrong(src, pos, prevChar, run, textOnly);
      // The URL rule runs before text for every position: an email can
      // start with _ (narrow local set), so try it once emphasis fails.
      if (!r && ch === '_' && !S.inLink && isUrlStart(src, pos)) r = tryUrl(src, pos, textOnly);
    } else if (ch === '`') {
      r = tryCodespan(src, pos, textOnly);
    } else if (ch === '~') {
      r = tryDel(src, pos, prevChar, run, textOnly);
    } else if (ch === ' ') {
      r = tryBr(src, pos, textOnly);
    } else if (!S.inLink && isEmailLocalChar(ch)) {
      if (isUrlStart(src, pos)) r = tryUrl(src, pos, textOnly);
    }
    if (r) {
      out += r.html;
      pos += r.adv;
      continue;
    }
    const rawText = src.slice(pos, textEnd(src, pos));
    const decoded = S.inRawBlock ? rawText : decodeNumericCharacterReferences(rawText);
    out += textOnly ? decoded : (S.inRawBlock ? decoded : escapeHtmlEntities(decoded));
    if (rawText.charAt(rawText.length - 1) !== '_') prevChar = rawText.charAt(rawText.length - 1);
    keepPrevChar = true;
    pos += rawText.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTableCell(cell) {
  S.inRawBlock = false;
  const content = renderInline(cell.text, false);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(token) {
  let header = '';
  let cell = '';
  for (let j = 0; j < token.header.length; j++) cell += renderTableCell(token.header[j]);
  header += `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (let j = 0; j < token.rows.length; j++) {
    const row = token.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) cell += renderTableCell(row[k]);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n' + '<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderListItem(item, listLoose) {
  if (item.task) {
    const box = checkboxHtml(item.checked);
    if (listLoose) {
      const first = item.tokens[0];
      if (first && first.type === 'paragraph') {
        let out = `<li><p>${box}`;
        S.inRawBlock = false;
        out += renderInline(first.text, false);
        out += '</p>\n';
        for (let k = 1; k < item.tokens.length; k++) out += renderBlockToken(item.tokens[k]);
        out += '</li>\n';
        return out;
      }
      let out = `<li><p>${box}</p>\n`;
      out += renderBlocks(item.tokens);
      out += '</li>\n';
      return out;
    }
    return `<li>${box}${renderBlocks(item.tokens)}</li>\n`;
  }
  return `<li>${renderBlocks(item.tokens)}</li>\n`;
}

function renderList(token) {
  const ordered = token.ordered;
  const start = token.start;
  let body = '';
  for (let j = 0; j < token.items.length; j++) body += renderListItem(token.items[j], token.loose);
  const type = ordered ? 'ol' : 'ul';
  const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlockToken(token) {
  switch (token.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': {
      S.inRawBlock = false;
      return `<h${token.depth}>${renderInline(token.text, false)}</h${token.depth}>\n`;
    }
    case 'code': {
      const langString = (token.lang || '').match(O.notSpaceStart)?.[0];
      const code = token.text ? token.text.replace(O.endingNewline, '') + '\n' : '';
      if (!langString) return '<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n';
      return '<pre><code class="language-' + escapeHtmlEntities(langString) + '">'
        + escapeHtmlEntities(code, true) + '</code></pre>\n';
    }
    case 'table': return renderTable(token);
    case 'blockquote': return `<blockquote>\n${renderBlocks(token.tokens)}</blockquote>\n`;
    case 'list': return renderList(token);
    case 'html': return token.text;
    case 'def': return '';
    case 'paragraph': {
      S.inRawBlock = false;
      return `<p>${renderInline(token.text, false)}</p>\n`;
    }
    case 'text': {
      S.inRawBlock = false;
      return renderInline(token.text, false);
    }
    default: throw new Error('Token with "' + token.type + '" type was not found.');
  }
}

function renderBlocks(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) out += renderBlockToken(tokens[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  S.links = Object.create(null);
  S.linkCount = 0;
  S.inLink = false;
  S.inRawBlock = false;
  S.linkEmitted = false;
  S.linkParenPossible = true;
  S.top = true;
  const src = markdown.replace(O.carriageReturn, '\n');
  const tokens = blockTokens(src, []);
  return renderBlocks(tokens);
}

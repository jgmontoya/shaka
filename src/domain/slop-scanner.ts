/**
 * Slop scanner: detects AI writing patterns in prose content.
 *
 * Pure functions — no I/O. All file/stdin handling lives in the CLI command.
 * Scores content on a 100-point scale where 100 = clean, 0 = maximally sloppy.
 */

// ============================================================================
// Types
// ============================================================================

export interface Violation {
  type: ViolationType;
  severity: "critical" | "high" | "medium";
  line: number;
  column: number;
  text: string;
  context: string;
  suggestion?: string;
}

export type ViolationType =
  | "cardinal_sin"
  | "banned_word"
  | "banned_construction"
  | "dash"
  | "rhythm"
  | "hedging"
  | "ai_tell";

export interface ScanResult {
  file: string;
  violations: Violation[];
  score: number;
  passesReview: boolean;
  wordCount: number;
  slopDensity: number;
  paragraphScores?: ParagraphScore[];
  qualitative?: QualitativeScore;
  summary: ViolationSummary;
}

export interface ViolationSummary {
  cardinalSins: number;
  bannedWords: number;
  bannedConstructions: number;
  dashes: number;
  rhythmIssues: number;
  hedging: number;
  aiTells: number;
}

export interface ParagraphScore {
  index: number;
  text: string;
  wordCount: number;
  violations: Violation[];
  score: number;
  slopDensity: number;
}

export interface QualitativeScore {
  directness: number;
  rhythm: number;
  trust: number;
  density: number;
  total: number;
  maxTotal: number;
  fleschKincaid?: number;
  sentenceVariance?: number;
  difficultWordPct?: number;
  readingTimeMin?: number;
}

/** Pass threshold — content must score at or above this to pass. */
export const PASS_THRESHOLD = 80;

// ============================================================================
// Pattern Definitions
// ============================================================================

interface PatternDef {
  pattern: RegExp;
  name: string;
  suggestion: string;
}

const CARDINAL_SINS: PatternDef[] = [
  {
    pattern: /\brather than\b/gi,
    name: "rather than",
    suggestion: "State only the positive (what it IS)",
  },
  {
    pattern: /\bnot by\s+[^,]+,\s*but by\b/gi,
    name: "not by X, but by Y",
    suggestion: "State the positive directly",
  },
  {
    pattern: /\bnot from\s+[^,]+,\s*but from\b/gi,
    name: "not from X, but from Y",
    suggestion: "State the positive directly",
  },
  {
    pattern: /\bless about\s+[^,]+,\s*more about\b/gi,
    name: "less about X, more about Y",
    suggestion: "State the positive directly",
  },
  {
    pattern: /\bnot just\s+[^,]+,\s*(but |it's )/gi,
    name: "not just X, but Y",
    suggestion: "State the positive directly",
  },
  {
    pattern: /\bnot because\s+[^.]+\.\s*because\b/gi,
    name: "Not because X. Because Y.",
    suggestion: "State Y directly",
  },
  {
    pattern: /\bisn't the problem\.\s*\w+\s+is\b/gi,
    name: "X isn't the problem. Y is.",
    suggestion: "State the problem directly",
  },
  {
    pattern: /\bit feels like\s+[^.]+\.\s*it's actually\b/gi,
    name: "It feels like X. It's actually Y.",
    suggestion: "State Y directly",
  },
];

const BANNED_WORDS: Map<string, string> = new Map([
  // Tier 1: Dead giveaways
  ["delve", "examine, study"],
  ["tapestry", "mix, combination"],
  ["testament", "proof, evidence"],
  ["pivotal", "important, key"],
  ["multifaceted", "complex, varied"],
  ["realm", "domain, field"],
  ["landscape", "field, area"],
  ["embark", "begin, start"],
  ["beacon", "signal, guide"],
  // Tier 2: Overused adjectives
  ["robust", "strong, solid"],
  ["crucial", "important, necessary"],
  ["vital", "necessary, essential"],
  ["seamless", "smooth, integrated"],
  ["comprehensive", "complete, full"],
  ["innovative", "new, novel"],
  ["cutting-edge", "new, advanced"],
  ["revolutionary", "new, different"],
  ["unparalleled", "unusual, rare"],
  ["meticulous", "careful, precise"],
  ["compelling", "strong, persuasive"],
  ["intricate", "complex, detailed"],
  ["vibrant", "active, lively"],
  ["nuanced", "subtle, detailed"],
  ["quiet", "use a more specific descriptor"],
  // Tier 3: Corporate buzzwords
  ["leverage", "use"],
  ["utilize", "use"],
  ["synergy", "cooperation"],
  ["ecosystem", "system, environment"],
  ["paradigm", "model, framework"],
  ["stakeholder", "participant, those involved"],
  ["holistic", "complete, whole"],
  ["proactive", "active, forward-looking"],
  ["empower", "enable, allow"],
  ["foster", "encourage, support"],
  ["facilitate", "help, enable"],
  ["optimize", "improve"],
  ["streamline", "simplify"],
  ["game-changing", "significant"],
  ["best-in-class", "leading, top"],
  // Tier 4: Vague intensifiers
  ["significantly", "be specific about magnitude"],
  ["substantially", "be specific"],
  ["considerably", "be specific"],
  ["notably", "delete or restructure"],
  ["remarkably", "be specific"],
  ["particularly", "be specific or delete"],
  ["especially", "be specific or delete"],
  ["importantly", "be specific or delete"],
  ["essentially", "be specific or delete"],
  ["fundamentally", "be specific"],
  // Tier 5: Additional AI tells
  ["genuine", "real, actual"],
  ["genuinely", "delete or be specific"],
  ["honestly", "delete"],
  ["literally", "delete or be specific"],
  ["straightforward", "simple, direct"],
  ["unlock", "enable, reveal"],
  ["navigate", "handle, manage"],
  ["underscores", "shows, emphasizes"],
  ["journey", "process, path"],
  ["arguably", "commit to the claim or delete"],
  ["excels", "be specific about what it does well"],
  ["moreover", "restructure sentence"],
  ["furthermore", "restructure sentence"],
  ["additionally", "restructure sentence"],
  ["dive into", "examine, explore"],
  ["merely", "delete or state the positive"],
  ["demonstrates", "shows, proves"],
  ["instructive", "useful, informative"],
  ["leveraging", "using, applying"],
  ["leveraged", "used, applied"],
  ["unpack", "explain"],
]);

const BANNED_CONSTRUCTIONS: PatternDef[] = [
  {
    pattern: /\bIt's worth noting that\b/gi,
    name: "It's worth noting that",
    suggestion: "State it directly",
  },
  {
    pattern: /\bIt bears mentioning\b/gi,
    name: "It bears mentioning",
    suggestion: "Mention it directly",
  },
  { pattern: /\bThe reality is\b/gi, name: "The reality is", suggestion: "State the reality" },
  { pattern: /\bThe truth is\b/gi, name: "The truth is", suggestion: "State the truth" },
  { pattern: /\bMake no mistake\b/gi, name: "Make no mistake", suggestion: "Delete" },
  { pattern: /\bLet's be clear\b/gi, name: "Let's be clear", suggestion: "Delete" },
  { pattern: /\bTo be clear\b/gi, name: "To be clear", suggestion: "Delete" },
  { pattern: /\bAt its core\b/gi, name: "At its core", suggestion: "Delete" },
  { pattern: /\bAt the heart of\b/gi, name: "At the heart of", suggestion: "Delete" },
  { pattern: /\bThe bottom line is\b/gi, name: "The bottom line is", suggestion: "Delete" },
  {
    pattern: /\bAnd that's a (good|bad|important) thing\b/gi,
    name: "And that's a X thing",
    suggestion: "Delete",
  },
  {
    pattern: /\bIn today's (world|digital|fast|modern)/gi,
    name: "In today's X",
    suggestion: "Delete throat-clearing",
  },
  {
    pattern: /\bLet's (explore|dive|delve|examine)\b/gi,
    name: "Let's explore...",
    suggestion: "Just do it",
  },
  {
    pattern: /\bWelcome to the world of\b/gi,
    name: "Welcome to the world of",
    suggestion: "Delete",
  },
  {
    pattern: /\bI hope this helps\b/gi,
    name: "I hope this helps",
    suggestion: "Delete chatbot artifact",
  },
  {
    pattern: /\bContrary to popular belief\b/gi,
    name: "Contrary to popular belief",
    suggestion: "State your view",
  },
  {
    pattern: /\bFull stop\b/gi,
    name: "Full stop",
    suggestion: "Delete",
  },
  {
    pattern: /\bLet that sink in\b/gi,
    name: "Let that sink in",
    suggestion: "Delete",
  },
  {
    pattern: /\bHere's the thing\b/gi,
    name: "Here's the thing",
    suggestion: "Delete, state the point",
  },
  {
    pattern: /\bHere's what I mean\b/gi,
    name: "Here's what I mean",
    suggestion: "Delete, state the point",
  },
  {
    pattern: /\bThink about it\b/gi,
    name: "Think about it",
    suggestion: "Delete",
  },
  {
    pattern: /\bAnd that's okay\b/gi,
    name: "And that's okay",
    suggestion: "Delete",
  },
  {
    pattern: /\blean into\b/gi,
    name: "lean into",
    suggestion: "accept, embrace",
  },
];

const HEDGING_PATTERNS: PatternDef[] = [
  {
    pattern: /\bit could be said\b/gi,
    name: "it could be said",
    suggestion: "Commit to the claim or delete",
  },
  {
    pattern: /\bone might think\b/gi,
    name: "one might think",
    suggestion: "Commit to the claim or delete",
  },
  {
    pattern: /\bsome might argue\b/gi,
    name: "some might argue",
    suggestion: "Commit to the claim or delete",
  },
  { pattern: /\bperhaps\b/gi, name: "perhaps", suggestion: "Commit to the claim or delete" },
  { pattern: /\bpotentially\b/gi, name: "potentially", suggestion: "Commit or delete" },
  { pattern: /\bit could be argued\b/gi, name: "it could be argued", suggestion: "Just argue it" },
];

const AI_TELL_PATTERNS: PatternDef[] = [
  {
    pattern: /\bhighlighting the\b/gi,
    name: "highlighting the",
    suggestion: "Explain HOW, or delete",
  },
  {
    pattern: /\breflecting a\b/gi,
    name: "reflecting a",
    suggestion: "Explain the connection directly",
  },
  {
    pattern: /\bshowcasing the\b/gi,
    name: "showcasing the",
    suggestion: "Describe what it shows concretely",
  },
  {
    pattern: /\bunderscoring the\b/gi,
    name: "underscoring the",
    suggestion: "State the point directly",
  },
  { pattern: /\bserves as a?\b/gi, name: "serves as (use 'is')", suggestion: "Use 'is' instead" },
  { pattern: /\bacts as a?\b/gi, name: "acts as (use 'is')", suggestion: "Use 'is' instead" },
  {
    pattern: /\bfunctions as a?\b/gi,
    name: "functions as (use 'is')",
    suggestion: "Use 'is' instead",
  },
  {
    pattern: /\bmarks a (significant |major )?shift\b/gi,
    name: "marks a shift",
    suggestion: "Describe the specific change",
  },
  {
    pattern: /\brepresents a (significant |major |fundamental )?shift\b/gi,
    name: "represents a shift",
    suggestion: "Describe the specific change",
  },
  {
    pattern: /\bexperts say\b/gi,
    name: "experts say (vague)",
    suggestion: "Name the expert or delete",
  },
  {
    pattern: /\bobservers note\b/gi,
    name: "observers note (vague)",
    suggestion: "Name the observer or delete",
  },
  {
    pattern: /\breports indicate\b/gi,
    name: "reports indicate (vague)",
    suggestion: "Name the report or delete",
  },
  {
    pattern: /\bstudies show\b/gi,
    name: "studies show (vague)",
    suggestion: "Cite the study or delete",
  },
  {
    pattern: /\bNot only\b[^.]*\bbut also\b/gi,
    name: "Not only...but also",
    suggestion: "State both points directly",
  },
  // False agency: inanimate objects performing human actions
  {
    pattern: /\bthe data tells\b/gi,
    name: "false agency: the data tells",
    suggestion: "Name who analyzed the data",
  },
  {
    pattern: /\bthe (market|industry) rewards\b/gi,
    name: "false agency: the market rewards",
    suggestion: "Name who pays or benefits",
  },
  {
    pattern: /\bthe (conversation|discussion) moves\b/gi,
    name: "false agency: the conversation moves",
    suggestion: "Name who steered it",
  },
  {
    pattern: /\bthe (decision|answer) emerges\b/gi,
    name: "false agency: the decision emerges",
    suggestion: "Name who decided",
  },
  {
    pattern: /\bthe culture shifts\b/gi,
    name: "false agency: the culture shifts",
    suggestion: "Name who changed behavior",
  },
  // Dramatic fragmentation
  {
    pattern: /That's it\.\s*That's the\b/gi,
    name: "dramatic fragmentation",
    suggestion: "Write a complete sentence",
  },
];

const DASH_PATTERNS: PatternDef[] = [
  { pattern: /\s--\s/g, name: "em dash (--)", suggestion: "Use colon, comma, or parentheses" },
  {
    pattern: /\s\u2014\s/g,
    name: "em dash (unicode)",
    suggestion: "Use colon, comma, or parentheses",
  },
  {
    pattern: / - (?![0-9])/g,
    name: "dash as punctuation",
    suggestion: "Use colon, comma, or parentheses",
  },
];

// ============================================================================
// Scoring weights — calibrated so a single natural occurrence doesn't nuke the score
// ============================================================================

const WEIGHTS: Record<ViolationType, number> = {
  cardinal_sin: 10,
  banned_word: 2,
  banned_construction: 2,
  dash: 3,
  rhythm: 3,
  hedging: 2,
  ai_tell: 3,
};

// ============================================================================
// Markdown preprocessing
// ============================================================================

/** Replace non-prose regions with whitespace, preserving line/column offsets. */
function stripNonProse(content: string): string {
  const mask = (m: string) => m.replace(/[^\n]/g, " ");
  return (
    content
      // YAML frontmatter (must start at beginning of file)
      .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, mask)
      // Fenced code blocks (``` ... ```)
      .replace(/```[^\n]*\n[\s\S]*?\n```/g, mask)
      // Inline code (`...`)
      .replace(/`[^`\n]+`/g, mask)
  );
}

// ============================================================================
// Core scanning functions
// ============================================================================

function getLineAndColumn(content: string, index: number): { line: number; column: number } {
  const lines = content.substring(0, index).split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  return { line: lines.length, column: lastLine.length + 1 };
}

function getContext(content: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + matchLength + 40);
  let ctx = content.substring(start, end);
  if (start > 0) ctx = `...${ctx}`;
  if (end < content.length) ctx = `${ctx}...`;
  return ctx.replace(/\n/g, " ").trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function scanForPattern(
  content: string,
  pattern: RegExp,
  type: ViolationType,
  severity: Violation["severity"],
  name: string,
  suggestion?: string,
): Violation[] {
  const violations: Violation[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);

  for (const match of content.matchAll(regex)) {
    const { line, column } = getLineAndColumn(content, match.index ?? 0);
    violations.push({
      type,
      severity,
      line,
      column,
      text: match[0],
      context: getContext(content, match.index ?? 0, match[0].length),
      suggestion,
    });
  }

  return violations;
}

function scanForBannedWords(content: string): Violation[] {
  const violations: Violation[] = [];
  for (const [word, alternative] of BANNED_WORDS) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
    violations.push(
      ...scanForPattern(content, pattern, "banned_word", "high", word, `Use: ${alternative}`),
    );
  }
  return violations;
}

/** Protect periods inside URLs, versions, and domains from sentence splitting. */
function protectPeriods(text: string): string {
  const PH = "\x00";
  return text
    .replace(/https?:\/\/[^\s)>\]]+/g, (m) => m.replace(/\./g, PH))
    .replace(/!?\]\([^)]+\)/g, (m) => m.replace(/\./g, PH))
    .replace(/v?\d+\.\d+(\.\d+)*(-[a-zA-Z0-9.]+)?/g, (m) => m.replace(/\./g, PH))
    .replace(/\b[a-z]+\.(com|org|net|io|dev)\b/gi, (m) => m.replace(/\./g, PH));
}

function locateSentence(sentences: string[], idx: number, content: string) {
  const startSentence = (sentences[idx] ?? "").trim();
  const index = content.indexOf(startSentence);
  return getLineAndColumn(content, index >= 0 ? index : 0);
}

function buildRhythmViolation(
  text: string,
  context: string,
  loc: { line: number; column: number },
  suggestion: string,
): Violation {
  return {
    type: "rhythm",
    severity: "medium",
    line: loc.line,
    column: loc.column,
    text,
    context,
    suggestion,
  };
}

function detectStaccato(sentences: string[], content: string): Violation[] {
  const violations: Violation[] = [];
  let consecutiveShort = 0;
  let shortStart = 0;

  for (let i = 0; i < sentences.length; i++) {
    const wc = (sentences[i] ?? "").trim().split(/\s+/).length;
    if (wc < 10) {
      if (consecutiveShort === 0) shortStart = i;
      consecutiveShort++;
      if (consecutiveShort >= 3) {
        const ctx = sentences
          .slice(shortStart, i + 1)
          .join(". ")
          .substring(0, 100);
        const loc = locateSentence(sentences, shortStart, content);
        violations.push(
          buildRhythmViolation(
            `${consecutiveShort} consecutive short sentences`,
            `${ctx}...`,
            loc,
            "Combine into longer, flowing sentences",
          ),
        );
        consecutiveShort = 0;
      }
    } else {
      consecutiveShort = 0;
    }
  }
  return violations;
}

function detectSameOpeners(sentences: string[], content: string): Violation[] {
  const violations: Violation[] = [];
  let streakCount = 1;
  let currentOpener = "";
  let streakStart = 0;

  for (let i = 0; i < sentences.length; i++) {
    const trimmed = (sentences[i] ?? "").trim();
    const match = trimmed.match(/^(\w+)/);
    const opener = match?.[1]?.toLowerCase() ?? "";
    if (!opener) continue;

    if (opener === currentOpener) {
      streakCount++;
      if (streakCount >= 3) {
        const ctx = sentences
          .slice(streakStart, i + 1)
          .map((s) => (s ?? "").trim().substring(0, 40))
          .join(" | ");
        const loc = locateSentence(sentences, streakStart, content);
        violations.push(
          buildRhythmViolation(
            `${streakCount} consecutive sentences starting with "${opener}"`,
            ctx.substring(0, 120),
            loc,
            "Vary sentence openings",
          ),
        );
      }
    } else {
      currentOpener = opener;
      streakCount = 1;
      streakStart = i;
    }
  }
  return violations;
}

function detectMetronomicParagraphs(content: string): Violation[] {
  const paragraphs = content
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 0 && !p.startsWith("#"));
  if (paragraphs.length < 5) return [];

  const lengths = paragraphs.map((p) => countWords(p));
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const allSimilar = lengths.every((l) => Math.abs(l - avg) < avg * 0.25);
  if (!allSimilar || avg <= 30) return [];

  return [
    {
      type: "rhythm" as const,
      severity: "medium" as const,
      line: 1,
      column: 1,
      text: "All paragraphs similar length (metronomic rhythm)",
      context: `${paragraphs.length} paragraphs, avg ${Math.round(avg)} words, all within 25% of mean`,
      suggestion: "Vary paragraph lengths",
    },
  ];
}

function scanForRhythmIssues(content: string): Violation[] {
  const protectedContent = protectPeriods(content);
  const sentences = protectedContent.split(/[.!?]+/).filter((s) => s.trim().length > 0);

  return [
    ...detectStaccato(sentences, protectedContent),
    ...detectSameOpeners(sentences, protectedContent),
    ...detectMetronomicParagraphs(content),
  ];
}

function scanForAiTells(content: string): Violation[] {
  const violations: Violation[] = [];

  for (const tell of AI_TELL_PATTERNS) {
    violations.push(
      ...scanForPattern(content, tell.pattern, "ai_tell", "high", tell.name, tell.suggestion),
    );
  }

  // Smart/curly quotes
  for (const match of content.matchAll(/[\u201C\u201D\u2018\u2019]/g)) {
    const { line, column } = getLineAndColumn(content, match.index ?? 0);
    violations.push({
      type: "ai_tell",
      severity: "medium",
      line,
      column,
      text: "Smart/curly quote detected",
      context: getContext(content, match.index ?? 0, match[0].length),
      suggestion: "Use straight quotes only",
    });
  }

  return violations;
}

// ============================================================================
// Qualitative scoring
// ============================================================================

const FILLER_WORDS = new Set([
  "basically",
  "essentially",
  "actually",
  "literally",
  "obviously",
  "clearly",
  "certainly",
  "definitely",
  "absolutely",
  "simply",
  "really",
  "very",
  "quite",
  "somewhat",
  "fairly",
  "pretty",
  "overall",
  "general",
]);

const INDIRECT_PATTERNS = [
  /\bit (is|was) (important|worth|necessary) (to|that)\b/gi,
  /\bthere (is|are|was|were) (several|many|numerous|various)\b/gi,
  /\b(one|you|we) (can|could|might|should) (see|note|observe|argue)\b/gi,
  /\bit (can|could|should|might) be (said|argued|noted|seen)\b/gi,
  /\bit is (clear|evident|apparent|obvious) that\b/gi,
];

const OVER_EXPLANATION_PATTERNS = [
  /\bin other words\b/gi,
  /\bthat is to say\b/gi,
  /\bsimply put\b/gi,
  /\bto put it (simply|another way|differently)\b/gi,
  /\bwhat this means is\b/gi,
  /\bas (you|we) (may|might|probably) know\b/gi,
  /\bin (simple|layman|plain) terms\b/gi,
];

function countSyllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  w = w.replace(/^y/, "");
  const matches = w.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

export function computeQualitativeScore(content: string): QualitativeScore {
  const sentences = content
    .split(/[.!?]+\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  const totalSentences = sentences.length || 1;
  const totalWords = words.length || 1;
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);
  const totalParagraphs = paragraphs.length || 1;

  // Directness
  let indirectCount = 0;
  for (const pat of INDIRECT_PATTERNS) {
    const matches = content.match(new RegExp(pat.source, pat.flags));
    indirectCount += matches ? matches.length : 0;
  }
  const directness = Math.round(
    Math.max(1, Math.min(10, 10 * (1 - (indirectCount / totalSentences) * 5))),
  );

  // Rhythm (coefficient of variation of sentence lengths)
  const sentLengths = sentences.map((s) => s.split(/\s+/).length);
  const sentMean = sentLengths.reduce((a, b) => a + b, 0) / (sentLengths.length || 1);
  const sentVariance =
    sentLengths.reduce((sum, l) => sum + (l - sentMean) ** 2, 0) / (sentLengths.length || 1);
  const cv = sentMean > 0 ? Math.sqrt(sentVariance) / sentMean : 0;
  const rhythm = Math.round(Math.max(1, Math.min(10, cv * 15)));

  // Trust (inverse of over-explanation)
  let overExplainCount = 0;
  for (const pat of OVER_EXPLANATION_PATTERNS) {
    const matches = content.match(new RegExp(pat.source, pat.flags));
    overExplainCount += matches ? matches.length : 0;
  }
  const trust = Math.round(
    Math.max(1, Math.min(10, 10 * (1 - (overExplainCount / totalParagraphs) * 3))),
  );

  // Density (inverse of filler word frequency)
  let fillerCount = 0;
  for (const w of words) {
    if (FILLER_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ""))) fillerCount++;
  }
  const density = Math.round(Math.max(1, Math.min(10, 10 * (1 - (fillerCount / totalWords) * 20))));

  // Readability
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgSyllablesPerWord = totalSyllables / totalWords;
  const avgWordsPerSentence = totalWords / totalSentences;
  const fleschKincaid = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  const sentStd = Math.sqrt(sentVariance);
  const difficultWords = words.filter((w) => countSyllables(w) >= 3).length;
  const difficultWordPct = (difficultWords / totalWords) * 100;
  const readingTimeMin = totalWords / 238;

  return {
    directness,
    rhythm,
    trust,
    density,
    total: directness + rhythm + trust + density,
    maxTotal: 40,
    fleschKincaid: Math.round(fleschKincaid * 10) / 10,
    sentenceVariance: Math.round(sentStd * 10) / 10,
    difficultWordPct: Math.round(difficultWordPct * 10) / 10,
    readingTimeMin: Math.round(readingTimeMin * 10) / 10,
  };
}

// ============================================================================
// Main scan entry point
// ============================================================================

export function scanContent(
  content: string,
  filename: string,
  options: { includeParagraphs?: boolean } = {},
): ScanResult {
  const prose = stripNonProse(content);
  const violations: Violation[] = [];

  // Cardinal sins
  for (const sin of CARDINAL_SINS) {
    violations.push(
      ...scanForPattern(prose, sin.pattern, "cardinal_sin", "critical", sin.name, sin.suggestion),
    );
  }

  // Banned words
  violations.push(...scanForBannedWords(prose));

  // Banned constructions
  for (const c of BANNED_CONSTRUCTIONS) {
    violations.push(
      ...scanForPattern(prose, c.pattern, "banned_construction", "high", c.name, c.suggestion),
    );
  }

  // Dash patterns
  for (const d of DASH_PATTERNS) {
    violations.push(...scanForPattern(prose, d.pattern, "dash", "high", d.name, d.suggestion));
  }

  // Hedging
  for (const h of HEDGING_PATTERNS) {
    violations.push(...scanForPattern(prose, h.pattern, "hedging", "medium", h.name, h.suggestion));
  }

  // AI tells
  violations.push(...scanForAiTells(prose));

  // Rhythm issues
  violations.push(...scanForRhythmIssues(prose));

  // Score calculation
  let score = 100;
  const summary: ViolationSummary = {
    cardinalSins: 0,
    bannedWords: 0,
    bannedConstructions: 0,
    dashes: 0,
    rhythmIssues: 0,
    hedging: 0,
    aiTells: 0,
  };

  for (const v of violations) {
    score -= WEIGHTS[v.type];
    switch (v.type) {
      case "cardinal_sin":
        summary.cardinalSins++;
        break;
      case "banned_word":
        summary.bannedWords++;
        break;
      case "banned_construction":
        summary.bannedConstructions++;
        break;
      case "dash":
        summary.dashes++;
        break;
      case "rhythm":
        summary.rhythmIssues++;
        break;
      case "hedging":
        summary.hedging++;
        break;
      case "ai_tell":
        summary.aiTells++;
        break;
    }
  }

  score = Math.max(0, score);

  const wordCount = countWords(prose);
  const slopDensity = wordCount > 0 ? (violations.length / wordCount) * 100 : 0;

  let paragraphScores: ParagraphScore[] | undefined;
  if (options.includeParagraphs) {
    paragraphScores = scanParagraphs(prose);
  }

  let qualitative: QualitativeScore | undefined;
  if (wordCount > 100) {
    qualitative = computeQualitativeScore(prose);
  }

  return {
    file: filename,
    violations,
    score,
    passesReview: score >= PASS_THRESHOLD,
    wordCount,
    slopDensity,
    paragraphScores,
    qualitative,
    summary,
  };
}

function scanParagraphs(content: string): ParagraphScore[] {
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const scores: ParagraphScore[] = [];

  for (const [i, para] of paragraphs.entries()) {
    const wc = countWords(para);
    if (wc < 5) continue;

    const result = scanContent(para, `paragraph-${i + 1}`, { includeParagraphs: false });
    scores.push({
      index: i + 1,
      text: para.substring(0, 80) + (para.length > 80 ? "..." : ""),
      wordCount: wc,
      violations: result.violations,
      score: result.score,
      slopDensity: wc > 0 ? (result.violations.length / wc) * 100 : 0,
    });
  }

  return scores;
}

// ============================================================================
// Output formatting
// ============================================================================

const R = "\x1b[0m";

function formatSingleViolation(v: Violation): string {
  const sColor =
    v.severity === "critical" ? "\x1b[31m" : v.severity === "high" ? "\x1b[33m" : "\x1b[36m";
  let out = `  ${sColor}[${v.severity.toUpperCase()}]${R} Line ${v.line}: ${v.text}\n`;
  out += `    Context: "${v.context}"\n`;
  if (v.suggestion) out += `    Suggestion: ${v.suggestion}\n`;
  return out;
}

function groupByType(violations: Violation[]): Map<string, Violation[]> {
  const byType = new Map<string, Violation[]>();
  for (const v of violations) {
    const arr = byType.get(v.type) ?? [];
    arr.push(v);
    byType.set(v.type, arr);
  }
  return byType;
}

function formatViolations(violations: Violation[]): string {
  let out = "Violations:\n";
  const byType = groupByType(violations);

  const typeOrder: [string, string][] = [
    ["cardinal_sin", "CARDINAL SINS"],
    ["banned_word", "BANNED WORDS"],
    ["banned_construction", "BANNED CONSTRUCTIONS"],
    ["ai_tell", "AI TELLS"],
    ["dash", "DASH VIOLATIONS"],
    ["rhythm", "RHYTHM ISSUES"],
    ["hedging", "HEDGING"],
  ];

  for (const [key, label] of typeOrder) {
    const items = byType.get(key);
    if (!items) continue;
    out += `\n  ${label}:\n`;
    for (const v of items) {
      out += formatSingleViolation(v);
    }
  }
  return out;
}

function formatQualitative(q: QualitativeScore): string {
  const bar = (score: number) => {
    const filled = "\u2588".repeat(score);
    const empty = "\u2591".repeat(10 - score);
    const color = score >= 8 ? "\x1b[32m" : score >= 5 ? "\x1b[33m" : "\x1b[31m";
    return `  ${color}${filled}${empty}${R} ${score}/10`;
  };

  let out = `\n${"=".repeat(60)}\n`;
  out += "QUALITATIVE ASSESSMENT:\n";
  out += `${"=".repeat(60)}\n\n`;
  out += `  Directness:   ${bar(q.directness)}\n`;
  out += `  Rhythm:       ${bar(q.rhythm)}\n`;
  out += `  Trust:        ${bar(q.trust)}\n`;
  out += `  Density:      ${bar(q.density)}\n`;
  out += `\n  Total: ${q.total}/${q.maxTotal}`;
  const pct = (q.total / q.maxTotal) * 100;
  if (pct >= 80) out += " \x1b[32m(Strong)\x1b[0m\n";
  else if (pct >= 60) out += " \x1b[33m(Adequate)\x1b[0m\n";
  else out += " \x1b[31m(Needs revision)\x1b[0m\n";

  if (q.fleschKincaid !== undefined) {
    out += "\n  Readability:\n";
    out += `    Flesch-Kincaid Grade: ${q.fleschKincaid}\n`;
    out += `    Sentence Length Variance: ${q.sentenceVariance}\n`;
    out += `    Difficult Words: ${q.difficultWordPct}%\n`;
    out += `    Reading Time: ${q.readingTimeMin} min\n`;
  }
  return out;
}

function formatParagraphBreakdown(paragraphScores: ParagraphScore[]): string {
  let out = `\n${"=".repeat(60)}\n`;
  out += "PARAGRAPH BREAKDOWN:\n";
  out += `${"=".repeat(60)}\n\n`;

  for (const para of paragraphScores) {
    const pColor =
      para.score >= PASS_THRESHOLD ? "\x1b[32m" : para.score >= 60 ? "\x1b[33m" : "\x1b[31m";
    out += `  ${pColor}[${para.score}]${R} P${para.index} (${para.wordCount}w): ${para.text}\n`;
    for (const v of para.violations) {
      out += `         ${v.type}: ${v.text}\n`;
    }
  }
  return out;
}

export function formatResult(result: ScanResult, verbose = true): string {
  const passColor = result.passesReview ? "\x1b[32m" : "\x1b[31m";

  let out = `\n${"=".repeat(60)}\n`;
  out += `File: ${result.file}\n`;
  out += `Score: ${passColor}${result.score}/100${R} ${result.passesReview ? "PASS" : "FAIL"}\n`;
  out += `Words: ${result.wordCount} | Slop density: ${result.slopDensity.toFixed(2)} violations/100 words\n`;
  out += `${"=".repeat(60)}\n\n`;

  out += "Summary:\n";
  out += `  Cardinal sins: ${result.summary.cardinalSins}\n`;
  out += `  Banned words: ${result.summary.bannedWords}\n`;
  out += `  Banned constructions: ${result.summary.bannedConstructions}\n`;
  out += `  AI tells: ${result.summary.aiTells}\n`;
  out += `  Dash violations: ${result.summary.dashes}\n`;
  out += `  Rhythm issues: ${result.summary.rhythmIssues}\n`;
  out += `  Hedging: ${result.summary.hedging}\n`;
  out += `  Total violations: ${result.violations.length}\n\n`;

  if (verbose && result.violations.length > 0) {
    out += formatViolations(result.violations);
  }

  if (result.qualitative) {
    out += formatQualitative(result.qualitative);
  }

  if (result.paragraphScores && result.paragraphScores.length > 0) {
    out += formatParagraphBreakdown(result.paragraphScores);
  }

  return out;
}

#!/usr/bin/env bun
/**
 * anti-slop-scanner.ts -- AI Slop Detection CLI
 *
 * Scans prose content for AI writing patterns (slop) and scores quality.
 * Part of the Shaka AntiSlop skill.
 *
 * Usage:
 *   bun anti-slop-scanner.ts <file.md>           # Scan single file
 *   bun anti-slop-scanner.ts --dir <path>        # Scan directory
 *   bun anti-slop-scanner.ts --stdin             # Scan from stdin
 *   bun anti-slop-scanner.ts --json              # JSON output
 *   bun anti-slop-scanner.ts --summary           # Summary only
 *   bun anti-slop-scanner.ts --paragraph         # Paragraph-level breakdown
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

interface Violation {
  type: "cardinal_sin" | "banned_word" | "banned_construction" | "dash" | "rhythm" | "hedging" | "ai_tell";
  severity: "critical" | "high" | "medium";
  line: number;
  column: number;
  text: string;
  context: string;
  suggestion?: string;
}

interface ParagraphScore {
  index: number;
  text: string;
  wordCount: number;
  violations: Violation[];
  score: number;
  slopDensity: number;
}

interface QualitativeScore {
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

interface ScanResult {
  file: string;
  violations: Violation[];
  score: number;
  passesReview: boolean;
  wordCount: number;
  slopDensity: number;
  paragraphScores?: ParagraphScore[];
  qualitative?: QualitativeScore;
  summary: {
    cardinalSins: number;
    bannedWords: number;
    bannedConstructions: number;
    dashes: number;
    rhythmIssues: number;
    hedging: number;
    aiTells: number;
    sameOpeners: number;
    syntacticTemplates: number;
  };
}

// ============================================================================
// Anti-Pattern Definitions
// ============================================================================

const CARDINAL_SINS = [
  { pattern: /\brather than\b/gi, name: "rather than", suggestion: "State only the positive (what it IS)" },
  { pattern: /\bnot by\s+[^,]+,\s*but by\b/gi, name: "not by X, but by Y", suggestion: "State the positive directly" },
  { pattern: /\bnot from\s+[^,]+,\s*but from\b/gi, name: "not from X, but from Y", suggestion: "State the positive directly" },
  { pattern: /\bless about\s+[^,]+,\s*more about\b/gi, name: "less about X, more about Y", suggestion: "State the positive directly" },
  { pattern: /\bThis is not\s+[^,]+,\s*it is\b/gi, name: "This is not X, it is Y", suggestion: "State what it IS directly" },
  { pattern: /\bnot just\s+[^,]+,\s*(but |it's )/gi, name: "not just X, but Y", suggestion: "State the positive directly" },
];

const BANNED_WORDS: Map<string, string> = new Map([
  ["genuine", "real, actual, authentic"],
  ["robust", "strong, resilient, durable"],
  ["comprehensive", "complete, thorough, full"],
  ["crucial", "essential, necessary, critical"],
  ["innovative", "new, novel, original"],
  ["game-changing", "transformative, significant"],
  ["revolutionary", "new, different"],
  ["groundbreaking", "new, original"],
  ["cutting-edge", "new, advanced"],
  ["straightforward", "simple, direct, clear"],
  ["landscape", "environment, field, domain"],
  ["delve", "explore, examine, investigate"],
  ["unlock", "enable, reveal, access"],
  ["leverage", "use, employ, apply"],
  ["leveraging", "using, applying"],
  ["leveraged", "used, applied"],
  ["navigate", "handle, manage, work through"],
  ["ecosystem", "system, network, environment"],
  ["paradigm", "model, framework, approach"],
  ["realm", "domain, sphere, area"],
  ["foster", "encourage, support, develop"],
  ["underscores", "emphasizes, shows"],
  ["multifaceted", "complex, varied, diverse"],
  ["nuanced", "subtle, complex, detailed"],
  ["pivotal", "central, decisive"],
  ["seamless", "smooth, integrated, unified"],
  ["utilize", "use"],
  ["arguably", "(delete entirely or commit to the claim)"],
  ["vital", "essential, necessary"],
  ["empower", "enable, allow, give power to"],
  ["stakeholder", "participant, party, those involved"],
  ["synergy", "cooperation, collaboration"],
  ["holistic", "complete, whole, integrated"],
  ["proactive", "active, forward-looking"],
  ["journey", "process, path, experience"],
  ["tapestry", "(find concrete description)"],
  ["beacon", "(find concrete description)"],
  ["embark", "begin, start"],
  ["compelling", "strong, persuasive"],
  ["intricate", "complex, detailed"],
  ["vibrant", "active, lively"],
  ["unparalleled", "unusual, extreme"],
  ["meticulous", "careful, precise"],
  ["moreover", "(restructure sentence)"],
  ["furthermore", "(restructure sentence)"],
  ["additionally", "(restructure sentence)"],
  ["notably", "(delete or restructure)"],
  ["significantly", "(delete or be specific about magnitude)"],
  ["testament", "(find concrete description)"],
  ["excels", "(be specific about what it does well)"],
  ["dive into", "examine, explore"],
  ["merely", "(delete or state the positive directly)"],
  ["demonstrates", "shows, proves, confirms"],
  ["demonstrated", "showed, proved, confirmed"],
  ["demonstrating", "showing, proving"],
  ["instructive", "useful, telling, informative"],
]);

const BANNED_CONSTRUCTIONS = [
  { pattern: /\bIt's worth noting that\b/gi, name: "It's worth noting that", suggestion: "Just state it directly" },
  { pattern: /\bIt bears mentioning\b/gi, name: "It bears mentioning", suggestion: "Just mention it directly" },
  { pattern: /\bThe reality is\b/gi, name: "The reality is", suggestion: "Just state the reality" },
  { pattern: /\bThe truth is\b/gi, name: "The truth is", suggestion: "Just state the truth" },
  { pattern: /\bMake no mistake\b/gi, name: "Make no mistake", suggestion: "Delete" },
  { pattern: /\bLet's be clear\b/gi, name: "Let's be clear", suggestion: "Delete" },
  { pattern: /\bTo be clear\b/gi, name: "To be clear", suggestion: "Delete" },
  { pattern: /\bAt its core\b/gi, name: "At its core", suggestion: "Delete" },
  { pattern: /\bAt the heart of\b/gi, name: "At the heart of", suggestion: "Delete" },
  { pattern: /\bThe bottom line is\b/gi, name: "The bottom line is", suggestion: "Delete" },
  { pattern: /\bContrary to popular belief\b/gi, name: "Contrary to popular belief", suggestion: "Just state your view" },
  { pattern: /\bAnd that's a (good|bad|important) thing\b/gi, name: "And that's a X thing", suggestion: "Delete" },
  { pattern: /\bIn today's (world|digital|fast|modern)/gi, name: "In today's X", suggestion: "Delete throat-clearing" },
  { pattern: /\bLet's (explore|dive|delve|examine)\b/gi, name: "Let's explore...", suggestion: "Just explore it" },
  { pattern: /\bWelcome to the world of\b/gi, name: "Welcome to the world of", suggestion: "Delete" },
  { pattern: /\bI hope this helps\b/gi, name: "I hope this helps", suggestion: "Delete chatbot artifact" },
  { pattern: /\bthe future (looks|remains|is) (bright|promising|uncertain)\b/gi, name: "generic conclusion", suggestion: "Make a specific claim about the future" },
  { pattern: /\btime will tell\b/gi, name: "time will tell", suggestion: "Make a specific prediction or skip" },
];

const HEDGING_PATTERNS = [
  { pattern: /\bit could be said\b/gi, name: "it could be said", suggestion: "Commit to the claim or delete" },
  { pattern: /\bone might think\b/gi, name: "one might think", suggestion: "Commit to the claim or delete" },
  { pattern: /\bsome might argue\b/gi, name: "some might argue", suggestion: "Commit to the claim or delete" },
  { pattern: /\bperhaps\b/gi, name: "perhaps", suggestion: "Commit to the claim or delete" },
  { pattern: /\bpotentially\b/gi, name: "potentially", suggestion: "Commit or delete" },
  { pattern: /\bit could be argued\b/gi, name: "it could be argued", suggestion: "Just argue it" },
];

const AI_TELL_PATTERNS = [
  { pattern: /\bhighlighting the\b/gi, name: "highlighting the (superficial analysis)", suggestion: "Explain HOW it highlights, or delete" },
  { pattern: /\breflecting a\b/gi, name: "reflecting a (superficial analysis)", suggestion: "Explain the connection directly" },
  { pattern: /\bshowcasing the\b/gi, name: "showcasing the (superficial analysis)", suggestion: "Describe what it shows concretely" },
  { pattern: /\bunderscoring the\b/gi, name: "underscoring the (superficial analysis)", suggestion: "State the point directly" },
  { pattern: /\bserves as a?\b/gi, name: "serves as (copula avoidance)", suggestion: "Use 'is' instead" },
  { pattern: /\bacts as a?\b/gi, name: "acts as (copula avoidance)", suggestion: "Use 'is' instead" },
  { pattern: /\bfunctions as a?\b/gi, name: "functions as (copula avoidance)", suggestion: "Use 'is' instead" },
  { pattern: /\bmarks a (significant |major )?shift\b/gi, name: "marks a shift (significance inflation)", suggestion: "Describe the specific change" },
  { pattern: /\brepresents a (significant |major |fundamental )?shift\b/gi, name: "represents a shift (significance inflation)", suggestion: "Describe the specific change" },
  { pattern: /\bexperts say\b/gi, name: "experts say (vague attribution)", suggestion: "Name the expert or delete" },
  { pattern: /\bobservers note\b/gi, name: "observers note (vague attribution)", suggestion: "Name the observer or delete" },
  { pattern: /\breports indicate\b/gi, name: "reports indicate (vague attribution)", suggestion: "Name the report or delete" },
  { pattern: /\bstudies show\b/gi, name: "studies show (vague attribution)", suggestion: "Cite the study or delete" },
  { pattern: /\bNot only\b[^.]*\bbut also\b/gi, name: "Not only...but also (negative parallelism)", suggestion: "State both points directly" },
  { pattern: /\ba sense of\b/gi, name: "a sense of (vague)", suggestion: "Name the feeling directly" },
  { pattern: /\bthe weight of\b/gi, name: "the weight of (vague)", suggestion: "Be specific about what is heavy" },
  { pattern: /\ba mix of\b/gi, name: "a mix of (vague)", suggestion: "Name the components directly" },
  { pattern: /\bstood as a\b/gi, name: "stood as a (copula avoidance)", suggestion: "Use 'was' instead" },
  { pattern: /\bstands as a\b/gi, name: "stands as a (copula avoidance)", suggestion: "Use 'is' instead" },
];

const DASH_PATTERNS = [
  { pattern: /\s--\s/g, name: "em dash (--)", suggestion: "Use colon, comma, or parentheses" },
  { pattern: /\s\u2014\s/g, name: "em dash (unicode)", suggestion: "Use colon, comma, or parentheses" },
  { pattern: / - (?![0-9])/g, name: "dash as punctuation", suggestion: "Use colon, comma, or parentheses" },
];

// ============================================================================
// Scanner Functions
// ============================================================================

function getLineAndColumn(content: string, index: number): { line: number; column: number } {
  const lines = content.substring(0, index).split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function getContext(content: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + matchLength + 40);
  let context = content.substring(start, end);
  if (start > 0) context = "..." + context;
  if (end < content.length) context = context + "...";
  return context.replace(/\n/g, " ").trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function scanForPattern(
  content: string,
  pattern: RegExp,
  type: Violation["type"],
  severity: Violation["severity"],
  name: string,
  suggestion?: string,
): Violation[] {
  const violations: Violation[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);
  let match;

  while ((match = regex.exec(content)) !== null) {
    const { line, column } = getLineAndColumn(content, match.index);
    violations.push({
      type,
      severity,
      line,
      column,
      text: match[0],
      context: getContext(content, match.index, match[0].length),
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

function protectPeriodsForSentenceSplit(text: string): string {
  const PLACEHOLDER = "\x00";
  return text
    .replace(/https?:\/\/[^\s)>\]]+/g, (m) => m.replace(/\./g, PLACEHOLDER))
    .replace(/\]\([^)]+\)/g, (m) => m.replace(/\./g, PLACEHOLDER))
    .replace(/v?\d+\.\d+(\.\d+)*(-[a-zA-Z0-9.]+)?/g, (m) => m.replace(/\./g, PLACEHOLDER))
    .replace(/\b[a-z]+\.(com|org|net|io|dev|fm|space|cash|band|stream)\b/gi, (m) =>
      m.replace(/\./g, PLACEHOLDER),
    );
}

function scanForRhythmIssues(content: string): Violation[] {
  const violations: Violation[] = [];

  // Check for staccato rhythm (3+ short sentences in a row)
  const protectedContent = protectPeriodsForSentenceSplit(content);
  const sentences = protectedContent.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  let consecutiveShort = 0;
  let shortStart = 0;

  for (let i = 0; i < sentences.length; i++) {
    const wordCount = sentences[i].trim().split(/\s+/).length;
    if (wordCount < 10) {
      if (consecutiveShort === 0) shortStart = i;
      consecutiveShort++;
      if (consecutiveShort >= 3) {
        const context = sentences.slice(shortStart, i + 1).join(". ").substring(0, 100);
        const index = content.indexOf(sentences[shortStart].trim());
        const { line, column } = getLineAndColumn(content, index >= 0 ? index : 0);
        violations.push({
          type: "rhythm",
          severity: "medium",
          line,
          column,
          text: `${consecutiveShort} consecutive short sentences`,
          context: context + "...",
          suggestion: "Combine into longer, flowing sentences",
        });
        consecutiveShort = 0;
      }
    } else {
      consecutiveShort = 0;
    }
  }

  // Check for Q&A catechism pattern
  const qaPattern = /\?[\s\n]+[A-Z][^.!?]{0,30}[.!]/g;
  let match;
  while ((match = qaPattern.exec(content)) !== null) {
    const { line, column } = getLineAndColumn(content, match.index);
    violations.push({
      type: "rhythm",
      severity: "medium",
      line,
      column,
      text: "Q&A catechism pattern",
      context: getContext(content, match.index, match[0].length),
      suggestion: "Restructure to avoid rhetorical question followed by immediate answer",
    });
  }

  // Check for paragraphs starting with vague "This"
  const vagueThisPattern =
    /\n\nThis\s+(is|was|has|means|shows|demonstrates|represents|indicates|reflects|highlights|showcases)/gi;
  while ((match = vagueThisPattern.exec(content)) !== null) {
    const { line, column } = getLineAndColumn(content, match.index);
    violations.push({
      type: "banned_construction",
      severity: "high",
      line,
      column,
      text: "Paragraph starting with vague 'This'",
      context: getContext(content, match.index, match[0].length),
      suggestion: "Be specific about what 'This' refers to",
    });
  }

  // Check for equal-length paragraph uniformity
  const paragraphs = content
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 0 && !p.startsWith("#"));
  if (paragraphs.length >= 5) {
    const lengths = paragraphs.map((p) => countWords(p));
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const allSimilar = lengths.every((l) => Math.abs(l - avg) < avg * 0.25);
    if (allSimilar && avg > 30) {
      violations.push({
        type: "rhythm",
        severity: "medium",
        line: 1,
        column: 1,
        text: "All paragraphs similar length (metronomic rhythm)",
        context: `${paragraphs.length} paragraphs, average ${Math.round(avg)} words, all within 25% of mean`,
        suggestion: "Vary paragraph lengths: some short (2-3 sentences), some longer (6-8 sentences)",
      });
    }
  }

  return violations;
}

function getOpenerWord(sentence: string): string {
  const trimmed = sentence.trim();
  const match = trimmed.match(/^(\w+)/);
  return match ? match[1].toLowerCase() : "";
}

function scanForSameOpeners(content: string): Violation[] {
  const violations: Violation[] = [];
  const protectedContent = protectPeriodsForSentenceSplit(content);
  const sentences = protectedContent.split(/[.!?]+/).filter((s) => s.trim().length > 0);

  let consecutiveCount = 1;
  let currentOpener = "";
  let streakStart = 0;

  for (let i = 0; i < sentences.length; i++) {
    const opener = getOpenerWord(sentences[i]);
    if (!opener) continue;

    if (opener === currentOpener) {
      consecutiveCount++;
      if (consecutiveCount >= 3) {
        const context = sentences
          .slice(streakStart, i + 1)
          .map((s) => s.trim().substring(0, 40))
          .join(" | ");
        const index = content.indexOf(sentences[streakStart].trim());
        const { line, column } = getLineAndColumn(content, index >= 0 ? index : 0);
        violations.push({
          type: "rhythm",
          severity: "medium",
          line,
          column,
          text: `${consecutiveCount} consecutive sentences starting with "${opener}"`,
          context: context.substring(0, 120) + "...",
          suggestion: "Vary sentence openings. Repeated openers create monotonous rhythm.",
        });
      }
    } else {
      currentOpener = opener;
      consecutiveCount = 1;
      streakStart = i;
    }
  }

  return violations;
}

function scanForSyntacticTemplates(content: string): Violation[] {
  const violations: Violation[] = [];
  const nominalizationPattern = /the \w+ of [^,.]+ and the \w+ of [^,.]+/gi;
  let match;
  while ((match = nominalizationPattern.exec(content)) !== null) {
    const { line, column } = getLineAndColumn(content, match.index);
    violations.push({
      type: "ai_tell",
      severity: "medium",
      line,
      column,
      text: "Repeated nominalization template",
      context: getContext(content, match.index, match[0].length),
      suggestion:
        "Use active verbs. 'The creation of X and the implementation of Y' -> 'Creating X and implementing Y'",
    });
  }
  return violations;
}

function scanForAiTells(content: string): Violation[] {
  const violations: Violation[] = [];

  for (const tell of AI_TELL_PATTERNS) {
    violations.push(
      ...scanForPattern(content, tell.pattern, "ai_tell", "high", tell.name, tell.suggestion),
    );
  }

  // Check for three-item lists (rule of three AI cadence)
  const threeItemListPatterns = [
    /([^,\n.;:!?]{3,60}),\s+([^,\n.;:!?]{3,60}),\s+and\s+([^,\n.;:!?]{3,60})/g,
    /([^,\n.;:!?]{3,60}),\s+([^,\n.;:!?]{3,60}),\s+or\s+([^,\n.;:!?]{3,60})/g,
  ];

  // Catch repeated-prefix triplets
  const repeatedPrefixPattern =
    /\b(no|without|with|for|by|from|to|in|every|each|all|any)\s+[^,\n.;:!?]{2,50},\s+\1\s+[^,\n.;:!?]{2,50},\s+\1\s+[^,\n.;:!?]{2,50}/gi;
  let rpMatch;
  while ((rpMatch = repeatedPrefixPattern.exec(content)) !== null) {
    const { line, column } = getLineAndColumn(content, rpMatch.index);
    const displayText =
      rpMatch[0].length > 80 ? rpMatch[0].substring(0, 77) + "..." : rpMatch[0];
    violations.push({
      type: "ai_tell",
      severity: "medium",
      line,
      column,
      text: `Three-item list (repeated prefix): "${displayText}"`,
      context: getContext(content, rpMatch.index, rpMatch[0].length),
      suggestion: "Avoid rule-of-three AI cadence. Use two items, four items, or restructure.",
    });
  }

  for (const listPattern of threeItemListPatterns) {
    let match;
    while ((match = listPattern.exec(content)) !== null) {
      // Skip if part of a longer list (4+ items)
      const preContext = content.substring(Math.max(0, match.index - 10), match.index);
      if (/,\s*$/.test(preContext)) continue;

      const fullMatch = match[0];
      const { line, column } = getLineAndColumn(content, match.index);
      const displayText =
        fullMatch.length > 80 ? fullMatch.substring(0, 77) + "..." : fullMatch;
      violations.push({
        type: "ai_tell",
        severity: "medium",
        line,
        column,
        text: `Three-item list: "${displayText}"`,
        context: getContext(content, match.index, fullMatch.length),
        suggestion: "Avoid rule-of-three AI cadence. Use two items, four items, or restructure.",
      });
    }
  }

  // Check for curly/smart quotes
  let match;
  const smartQuotePattern = /[\u201C\u201D\u2018\u2019]/g;
  while ((match = smartQuotePattern.exec(content)) !== null) {
    const { line, column } = getLineAndColumn(content, match.index);
    violations.push({
      type: "ai_tell",
      severity: "medium",
      line,
      column,
      text: "Smart/curly quote detected",
      context: getContext(content, match.index, match[0].length),
      suggestion: "Use straight quotes only",
    });
  }

  // Check for exclamation marks outside quotes
  const exclPattern = /!/g;
  let exclMatch;
  while ((exclMatch = exclPattern.exec(content)) !== null) {
    const lineStart = content.lastIndexOf("\n", exclMatch.index) + 1;
    const beforeOnLine = content.substring(lineStart, exclMatch.index);
    const quoteCount = (beforeOnLine.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) continue; // inside quotes, skip

    const { line, column } = getLineAndColumn(content, exclMatch.index);
    violations.push({
      type: "ai_tell",
      severity: "medium",
      line,
      column,
      text: "Exclamation mark in prose",
      context: getContext(content, exclMatch.index, 1),
      suggestion: "Remove exclamation mark. Reserve for direct quotes only.",
    });
  }

  // Syntactic template detection
  violations.push(...scanForSyntacticTemplates(content));

  return violations;
}

// ============================================================================
// Qualitative Scoring
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
  /\bfor those unfamiliar\b/gi,
  /\bas (you|we) (may|might|probably) know\b/gi,
  /\bin (simple|layman|plain) terms\b/gi,
];

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function computeQualitativeScore(content: string): QualitativeScore {
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

  // 1. DIRECTNESS
  let indirectCount = 0;
  for (const pat of INDIRECT_PATTERNS) {
    const matches = content.match(new RegExp(pat.source, pat.flags));
    indirectCount += matches ? matches.length : 0;
  }
  const indirectRatio = indirectCount / totalSentences;
  const directness = Math.round(Math.max(1, Math.min(10, 10 * (1 - indirectRatio * 5))));

  // 2. RHYTHM (coefficient of variation of sentence lengths)
  const sentLengths = sentences.map((s) => s.split(/\s+/).length);
  const sentMean = sentLengths.reduce((a, b) => a + b, 0) / (sentLengths.length || 1);
  const sentVariance =
    sentLengths.reduce((sum, l) => sum + (l - sentMean) ** 2, 0) / (sentLengths.length || 1);
  const cv = sentMean > 0 ? Math.sqrt(sentVariance) / sentMean : 0;
  const rhythm = Math.round(Math.max(1, Math.min(10, cv * 15)));

  // 3. TRUST (inverse of over-explanation frequency)
  let overExplainCount = 0;
  for (const pat of OVER_EXPLANATION_PATTERNS) {
    const matches = content.match(new RegExp(pat.source, pat.flags));
    overExplainCount += matches ? matches.length : 0;
  }
  const overExplainRatio = overExplainCount / totalParagraphs;
  const trust = Math.round(Math.max(1, Math.min(10, 10 * (1 - overExplainRatio * 3))));

  // 4. DENSITY (inverse of filler word frequency)
  let fillerCount = 0;
  for (const w of words) {
    if (FILLER_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ""))) {
      fillerCount++;
    }
  }
  const fillerRatio = fillerCount / totalWords;
  const density = Math.round(Math.max(1, Math.min(10, 10 * (1 - fillerRatio * 20))));

  // Readability metrics
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgSyllablesPerWord = totalSyllables / totalWords;
  const avgWordsPerSentence = totalWords / totalSentences;
  const fleschKincaid = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  const sentStd = Math.sqrt(sentVariance);
  const DIFFICULT_THRESHOLD = 3;
  const difficultWords = words.filter((w) => countSyllables(w) >= DIFFICULT_THRESHOLD).length;
  const difficultWordPct = (difficultWords / totalWords) * 100;
  const readingTimeMin = totalWords / 238;

  const scoredDimensions = [directness, rhythm, trust, density];

  return {
    directness,
    rhythm,
    trust,
    density,
    total: scoredDimensions.reduce((a, b) => a + b, 0),
    maxTotal: 40,
    fleschKincaid: Math.round(fleschKincaid * 10) / 10,
    sentenceVariance: Math.round(sentStd * 10) / 10,
    difficultWordPct: Math.round(difficultWordPct * 10) / 10,
    readingTimeMin: Math.round(readingTimeMin * 10) / 10,
  };
}

function scanContent(
  content: string,
  filename: string,
  includeParagraphs: boolean = false,
): ScanResult {
  const violations: Violation[] = [];

  // Cardinal sins (critical, -20 each)
  for (const sin of CARDINAL_SINS) {
    violations.push(
      ...scanForPattern(content, sin.pattern, "cardinal_sin", "critical", sin.name, sin.suggestion),
    );
  }

  // Banned words (high, -2 each)
  violations.push(...scanForBannedWords(content));

  // Banned constructions (high, -2 each)
  for (const construction of BANNED_CONSTRUCTIONS) {
    violations.push(
      ...scanForPattern(
        content,
        construction.pattern,
        "banned_construction",
        "high",
        construction.name,
        construction.suggestion,
      ),
    );
  }

  // Dash patterns (high, -5 each)
  for (const dash of DASH_PATTERNS) {
    violations.push(
      ...scanForPattern(content, dash.pattern, "dash", "high", dash.name, dash.suggestion),
    );
  }

  // Hedging patterns (medium, -2 each)
  for (const hedge of HEDGING_PATTERNS) {
    violations.push(
      ...scanForPattern(content, hedge.pattern, "hedging", "medium", hedge.name, hedge.suggestion),
    );
  }

  // AI tell patterns (high, -3 each)
  violations.push(...scanForAiTells(content));

  // Rhythm issues (medium, -5 each)
  violations.push(...scanForRhythmIssues(content));

  // Same-opener detection
  violations.push(...scanForSameOpeners(content));

  // Calculate score
  let score = 100;
  const summary = {
    cardinalSins: 0,
    bannedWords: 0,
    bannedConstructions: 0,
    dashes: 0,
    rhythmIssues: 0,
    hedging: 0,
    aiTells: 0,
    sameOpeners: 0,
    syntacticTemplates: 0,
  };

  for (const v of violations) {
    switch (v.type) {
      case "cardinal_sin":
        summary.cardinalSins++;
        score -= 20;
        break;
      case "banned_word":
        summary.bannedWords++;
        score -= 2;
        break;
      case "banned_construction":
        summary.bannedConstructions++;
        score -= 2;
        break;
      case "dash":
        summary.dashes++;
        score -= 5;
        break;
      case "rhythm":
        summary.rhythmIssues++;
        score -= 5;
        break;
      case "hedging":
        summary.hedging++;
        score -= 2;
        break;
      case "ai_tell":
        summary.aiTells++;
        score -= 3;
        break;
    }
  }

  score = Math.max(0, score);

  summary.sameOpeners = violations.filter((v) =>
    v.text.includes("consecutive sentences starting with"),
  ).length;
  summary.syntacticTemplates = violations.filter(
    (v) => v.text === "Repeated nominalization template",
  ).length;

  const wordCount = countWords(content);
  const slopDensity = wordCount > 0 ? (violations.length / wordCount) * 100 : 0;

  let paragraphScores: ParagraphScore[] | undefined;
  if (includeParagraphs) {
    paragraphScores = analyzeParagraphs(content);
  }

  let qualitative: QualitativeScore | undefined;
  if (wordCount > 100) {
    qualitative = computeQualitativeScore(content);
  }

  return {
    file: filename,
    violations,
    score,
    passesReview: score >= 95,
    wordCount,
    slopDensity,
    paragraphScores,
    qualitative,
    summary,
  };
}

function analyzeParagraphs(content: string): ParagraphScore[] {
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const scores: ParagraphScore[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const wordCount = countWords(para);

    if (wordCount < 5) continue;

    const result = scanContent(para, `paragraph-${i + 1}`);

    scores.push({
      index: i + 1,
      text: para.substring(0, 80) + (para.length > 80 ? "..." : ""),
      wordCount,
      violations: result.violations,
      score: result.score,
      slopDensity: wordCount > 0 ? (result.violations.length / wordCount) * 100 : 0,
    });
  }

  return scores;
}

function scanFile(filepath: string, includeParagraphs: boolean = false): ScanResult {
  const content = readFileSync(filepath, "utf-8");
  return scanContent(content, filepath, includeParagraphs);
}

function scanDirectory(dirpath: string): ScanResult[] {
  const results: ScanResult[] = [];
  const files = readdirSync(dirpath);

  for (const file of files) {
    const filepath = join(dirpath, file);
    const stat = statSync(filepath);

    if (stat.isFile() && file.endsWith(".md")) {
      results.push(scanFile(filepath));
    }
  }

  return results;
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatViolation(v: Violation): string {
  const severityColors: Record<string, string> = {
    critical: "\x1b[31m",
    high: "\x1b[33m",
    medium: "\x1b[36m",
  };
  const reset = "\x1b[0m";
  const color = severityColors[v.severity] || "";

  let output = `  ${color}[${v.severity.toUpperCase()}]${reset} Line ${v.line}: ${v.text}\n`;
  output += `    Context: "${v.context}"\n`;
  if (v.suggestion) {
    output += `    Suggestion: ${v.suggestion}\n`;
  }
  return output;
}

function formatResult(result: ScanResult, verbose: boolean = true): string {
  const passColor = result.passesReview ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";

  let output = `\n${"=".repeat(60)}\n`;
  output += `File: ${result.file}\n`;
  output += `Score: ${passColor}${result.score}/100${reset} ${result.passesReview ? "PASS" : "FAIL"}\n`;
  output += `Words: ${result.wordCount} | Slop density: ${result.slopDensity.toFixed(2)} violations/100 words\n`;
  output += `${"=".repeat(60)}\n\n`;

  output += `Summary:\n`;
  output += `  Cardinal sins (rather than, etc.): ${result.summary.cardinalSins}\n`;
  output += `  Banned words: ${result.summary.bannedWords}\n`;
  output += `  Banned constructions: ${result.summary.bannedConstructions}\n`;
  output += `  AI tells: ${result.summary.aiTells}\n`;
  output += `  Dash violations: ${result.summary.dashes}\n`;
  output += `  Rhythm issues: ${result.summary.rhythmIssues}\n`;
  output += `  Hedging: ${result.summary.hedging}\n`;
  output += `  Same-opener runs: ${result.summary.sameOpeners}\n`;
  output += `  Syntactic templates: ${result.summary.syntacticTemplates}\n`;
  output += `  Total violations: ${result.violations.length}\n\n`;

  // Slop density assessment
  if (result.slopDensity > 1.0) {
    output += `  \x1b[31mSLOP DENSITY: HIGH (${result.slopDensity.toFixed(2)}/100 words)\x1b[0m\n`;
    output += `  Text is saturated with AI patterns. Rewrite from scratch.\n\n`;
  } else if (result.slopDensity > 0.5) {
    output += `  \x1b[33mSLOP DENSITY: MODERATE (${result.slopDensity.toFixed(2)}/100 words)\x1b[0m\n`;
    output += `  Several AI patterns detected. Fix flagged issues.\n\n`;
  } else if (result.slopDensity > 0) {
    output += `  \x1b[36mSLOP DENSITY: LOW (${result.slopDensity.toFixed(2)}/100 words)\x1b[0m\n\n`;
  } else {
    output += `  \x1b[32mSLOP DENSITY: CLEAN\x1b[0m\n\n`;
  }

  if (verbose && result.violations.length > 0) {
    output += `Violations:\n`;

    const byType = new Map<string, Violation[]>();
    for (const v of result.violations) {
      const key = v.type;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(v);
    }

    if (byType.has("cardinal_sin")) {
      output += `\n  CARDINAL SINS (CRITICAL):\n`;
      for (const v of byType.get("cardinal_sin")!) {
        output += formatViolation(v);
      }
    }

    if (byType.has("banned_word")) {
      output += `\n  BANNED WORDS:\n`;
      for (const v of byType.get("banned_word")!) {
        output += formatViolation(v);
      }
    }

    if (byType.has("banned_construction")) {
      output += `\n  BANNED CONSTRUCTIONS:\n`;
      for (const v of byType.get("banned_construction")!) {
        output += formatViolation(v);
      }
    }

    if (byType.has("ai_tell")) {
      output += `\n  AI TELLS:\n`;
      for (const v of byType.get("ai_tell")!) {
        output += formatViolation(v);
      }
    }

    if (byType.has("dash")) {
      output += `\n  DASH VIOLATIONS:\n`;
      for (const v of byType.get("dash")!) {
        output += formatViolation(v);
      }
    }

    if (byType.has("rhythm")) {
      output += `\n  RHYTHM ISSUES:\n`;
      for (const v of byType.get("rhythm")!) {
        output += formatViolation(v);
      }
    }

    if (byType.has("hedging")) {
      output += `\n  HEDGING:\n`;
      for (const v of byType.get("hedging")!) {
        output += formatViolation(v);
      }
    }
  }

  // Qualitative assessment
  if (result.qualitative) {
    const q = result.qualitative;
    output += `\n${"=".repeat(60)}\n`;
    output += `QUALITATIVE ASSESSMENT:\n`;
    output += `${"=".repeat(60)}\n\n`;

    const bar = (score: number) => {
      const filled = "\u2588".repeat(score);
      const empty = "\u2591".repeat(10 - score);
      const color = score >= 8 ? "\x1b[32m" : score >= 5 ? "\x1b[33m" : "\x1b[31m";
      return `  ${color}${filled}${empty}${reset} ${score}/10`;
    };

    output += `  Directness:   ${bar(q.directness)}  Claims stated directly vs. announced\n`;
    output += `  Rhythm:       ${bar(q.rhythm)}  Sentence length variation (burstiness)\n`;
    output += `  Trust:        ${bar(q.trust)}  Respects reader intelligence\n`;
    output += `  Density:      ${bar(q.density)}  Every phrase necessary, no filler\n`;
    output += `\n  Total: ${q.total}/${q.maxTotal}`;
    const pct = (q.total / q.maxTotal) * 100;
    if (pct >= 80) output += ` \x1b[32m(Strong)\x1b[0m\n`;
    else if (pct >= 60) output += ` \x1b[33m(Adequate)\x1b[0m\n`;
    else output += ` \x1b[31m(Needs revision)\x1b[0m\n`;

    if (q.fleschKincaid !== undefined) {
      output += `\n  Readability Metrics (informational):\n`;
      output += `    Flesch-Kincaid Grade: ${q.fleschKincaid}`;
      if (q.fleschKincaid < 9 || q.fleschKincaid > 15) {
        output += ` \x1b[33m(target: 9-15)\x1b[0m`;
      }
      output += `\n`;
      output += `    Sentence Length Variance: ${q.sentenceVariance}`;
      if (q.sentenceVariance !== undefined && q.sentenceVariance < 4.0) {
        output += ` \x1b[33m(low variance, target: 4.0+)\x1b[0m`;
      }
      output += `\n`;
      output += `    Difficult Words: ${q.difficultWordPct}%\n`;
      output += `    Reading Time: ${q.readingTimeMin} min\n`;
    }
  }

  // Paragraph breakdown
  if (result.paragraphScores && result.paragraphScores.length > 0) {
    output += `\n${"=".repeat(60)}\n`;
    output += `PARAGRAPH BREAKDOWN:\n`;
    output += `${"=".repeat(60)}\n\n`;

    for (const para of result.paragraphScores) {
      const pColor =
        para.score >= 95 ? "\x1b[32m" : para.score >= 80 ? "\x1b[33m" : "\x1b[31m";
      output += `  ${pColor}[${para.score}]${reset} P${para.index} (${para.wordCount}w): ${para.text}\n`;
      if (para.violations.length > 0) {
        for (const v of para.violations) {
          output += `         ${v.type}: ${v.text}\n`;
        }
      }
    }
  }

  return output;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  let jsonOutput = false;
  let summaryOnly = false;
  let paragraphMode = false;
  let scanDir: string | null = null;
  let scanFile_: string | null = null;
  let useStdin = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--summary") {
      summaryOnly = true;
    } else if (arg === "--paragraph" || arg === "--paragraphs" || arg === "-p") {
      paragraphMode = true;
    } else if (arg === "--dir") {
      scanDir = args[++i];
    } else if (arg === "--stdin") {
      useStdin = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
anti-slop-scanner -- AI Slop Detection CLI

Usage:
  bun anti-slop-scanner.ts <file.md>       Scan single file
  bun anti-slop-scanner.ts --dir <path>    Scan all .md files in directory
  bun anti-slop-scanner.ts --stdin         Scan content from stdin

Options:
  --json         Output as JSON
  --summary      Summary only (no violation details)
  --paragraph    Show per-paragraph breakdown with scores
  --help         Show this help

Scoring:
  Cardinal sins (rather than, etc.): -20 points each
  Banned words: -2 points each
  Banned constructions: -2 points each
  AI tells: -3 points each
  Dash violations: -5 points each
  Rhythm issues: -5 points each
  Hedging: -2 points each

  Pass threshold: 95/100

Slop Density:
  Violations per 100 words. Lower is better.
  CLEAN: 0 | LOW: <0.5 | MODERATE: 0.5-1.0 | HIGH: >1.0
`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      scanFile_ = arg;
    }
  }

  let results: ScanResult[] = [];

  if (useStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString("utf-8");
    results.push(scanContent(content, "stdin", paragraphMode));
  } else if (scanDir) {
    results = scanDirectory(scanDir);
  } else if (scanFile_) {
    results.push(scanFile(scanFile_, paragraphMode));
  } else {
    console.error("Error: No input specified. Use --help for usage.");
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(formatResult(result, !summaryOnly));
    }

    // Aggregate summary for directory scans
    if (results.length > 1) {
      const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);
      const passingFiles = results.filter((r) => r.passesReview).length;
      const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
      const avgDensity = results.reduce((sum, r) => sum + r.slopDensity, 0) / results.length;

      console.log(`\n${"=".repeat(60)}`);
      console.log(`AGGREGATE SUMMARY`);
      console.log(`${"=".repeat(60)}`);
      console.log(`Files scanned: ${results.length}`);
      console.log(`Files passing (95+): ${passingFiles}/${results.length}`);
      console.log(`Average score: ${avgScore.toFixed(1)}/100`);
      console.log(`Average slop density: ${avgDensity.toFixed(2)}/100 words`);
      console.log(`Total violations: ${totalViolations}`);
    }
  }

  // Exit with error code if any file fails
  const anyFailed = results.some((r) => !r.passesReview);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

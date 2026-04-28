import { describe, expect, test } from "bun:test";
import {
  PASS_THRESHOLD,
  computeQualitativeScore,
  countWords,
  scanContent,
} from "../../../src/domain/slop-scanner";

describe("slop-scanner", () => {
  describe("scanContent", () => {
    test("clean text scores 100 with zero violations", () => {
      const result = scanContent(
        "Request processing happens in three stages. " +
          "Validation checks input against the schema before anything else runs. " +
          "A transformation step converts the validated data into the internal format. " +
          "The persistence layer writes results to the database.",
        "clean.md",
      );
      expect(result.score).toBe(100);
      expect(result.violations).toHaveLength(0);
      expect(result.passesReview).toBe(true);
    });

    test("detects banned words", () => {
      const result = scanContent(
        "We need to leverage robust solutions to navigate the complex landscape of modern development.",
        "slop.md",
      );
      const bannedWords = result.violations.filter((v) => v.type === "banned_word");
      expect(bannedWords.length).toBeGreaterThanOrEqual(3);
      expect(result.score).toBeLessThan(100);
    });

    test("detects cardinal sins (comparison structures)", () => {
      const result = scanContent(
        "This approach works by focusing on outcomes rather than processes.",
        "sin.md",
      );
      const sins = result.violations.filter((v) => v.type === "cardinal_sin");
      expect(sins.length).toBeGreaterThanOrEqual(1);
    });

    test("detects banned constructions", () => {
      const result = scanContent(
        "It's worth noting that the system handles errors. " +
          "At its core, the architecture prioritizes reliability. " +
          "The bottom line is that performance matters.",
        "construction.md",
      );
      const constructions = result.violations.filter((v) => v.type === "banned_construction");
      expect(constructions.length).toBeGreaterThanOrEqual(3);
    });

    test("detects hedging patterns", () => {
      const result = scanContent(
        "Perhaps the best approach is to refactor. " +
          "It could be argued that performance matters more. " +
          "Some might argue testing is optional.",
        "hedge.md",
      );
      const hedging = result.violations.filter((v) => v.type === "hedging");
      expect(hedging.length).toBeGreaterThanOrEqual(3);
    });

    test("detects AI tells (copula avoidance, vague attribution)", () => {
      const result = scanContent(
        "The framework serves as a bridge between old and new systems. " +
          "Experts say this approach is industry standard.",
        "tell.md",
      );
      const tells = result.violations.filter((v) => v.type === "ai_tell");
      expect(tells.length).toBeGreaterThanOrEqual(2);
    });

    test("detects em dash violations", () => {
      const result = scanContent(
        "The system -- as we will see -- handles errors. " +
          "Performance is good \u2014 but could be better.",
        "dash.md",
      );
      const dashes = result.violations.filter((v) => v.type === "dash");
      expect(dashes.length).toBeGreaterThanOrEqual(2);
    });

    test("detects smart/curly quotes", () => {
      const result = scanContent(
        "The system is \u201Cfast\u201D and \u2018reliable\u2019.",
        "quotes.md",
      );
      const smartQuotes = result.violations.filter((v) => v.text === "Smart/curly quote detected");
      expect(smartQuotes.length).toBeGreaterThanOrEqual(2);
    });

    test("detects Unicode arrows", () => {
      const result = scanContent("Click here \u2192 to continue, then \u21D2 profit.", "arrows.md");
      const arrows = result.violations.filter((v) => v.text === "Unicode arrow detected");
      expect(arrows.length).toBe(2);
      expect(arrows[0]!.type).toBe("ai_tell");
      expect(arrows[0]!.suggestion).toBe('Use "to", a plain hyphen, or rewrite the sentence');
      expect(arrows[0]!.line).toBe(1);
      expect(arrows[0]!.column).toBe(12);
      expect(arrows[1]!.line).toBe(1);
      expect(arrows[1]!.column).toBe(32);
    });

    test("heavily sloppy content fails review", () => {
      const result = scanContent(
        "In today's rapidly evolving digital landscape, we must leverage robust and seamless solutions " +
          "that utilize cutting-edge innovation. Furthermore, it's crucial to navigate the complex ecosystem " +
          "of stakeholder needs. The paradigm shift underscores the importance of holistic approaches. " +
          "Moreover, we must foster synergy rather than working in silos.",
        "fail.md",
      );
      expect(result.passesReview).toBe(false);
      expect(result.score).toBeLessThan(PASS_THRESHOLD);
    });

    test("provides violation summary counts", () => {
      const result = scanContent(
        "We must leverage robust solutions. Perhaps the approach is seamless. " +
          "The system serves as a bridge. Performance is good -- but could be better.",
        "summary.md",
      );
      expect(result.summary.bannedWords).toBeGreaterThanOrEqual(2);
      expect(typeof result.summary.cardinalSins).toBe("number");
      expect(typeof result.summary.dashes).toBe("number");
    });

    test("includes paragraph scores when requested", () => {
      const result = scanContent(
        "The first paragraph is clean and simple.\n\n" +
          "The second paragraph contains a robust and seamless approach.\n\n" +
          "The third paragraph is direct and clear.",
        "para.md",
        { includeParagraphs: true },
      );
      expect(result.paragraphScores).toBeDefined();
      expect(result.paragraphScores?.length).toBeGreaterThanOrEqual(2);
    });

    test("does not include paragraph scores by default", () => {
      const result = scanContent("Some text.", "default.md");
      expect(result.paragraphScores).toBeUndefined();
    });

    test("ignores fenced code blocks", () => {
      const result = scanContent(
        "Clean introduction.\n\n" +
          "```javascript\n" +
          "// leverage robust ecosystem\n" +
          "const x = 'seamless';\n" +
          "```\n\n" +
          "Clean closing.",
        "codeblock.md",
      );
      expect(result.violations).toHaveLength(0);
    });

    test("ignores YAML frontmatter", () => {
      const result = scanContent(
        "---\ntitle: Leverage the Robust Ecosystem\ndescription: seamless\n---\n\nClean body text.",
        "frontmatter.md",
      );
      expect(result.violations).toHaveLength(0);
    });

    test("ignores inline code", () => {
      const result = scanContent(
        "Use the `leverage` function to call `robust` checks.",
        "inline.md",
      );
      expect(result.violations).toHaveLength(0);
    });

    test("calculates slop density", () => {
      const result = scanContent(
        "We must leverage robust solutions to optimize the ecosystem.",
        "density.md",
      );
      expect(result.slopDensity).toBeGreaterThan(0);
      expect(result.wordCount).toBeGreaterThan(0);
    });

    describe("negative parallelism cardinal sin", () => {
      test("flags 'It's not X, it's Y' pattern", () => {
        const result = scanContent(
          "It's not a bug, it's a feature. It's not slow, it's thoughtful.",
          "parallelism.md",
        );
        const sins = result.violations.filter(
          (v) => v.type === "cardinal_sin" && v.text.toLowerCase().includes("it"),
        );
        expect(sins.length).toBeGreaterThanOrEqual(1);
        expect(sins.some((v) => v.suggestion === "State the positive directly")).toBe(true);
      });

      test("does not flag factual negations with 'it'", () => {
        const result = scanContent(
          "It's not raining outside. It's not worth the risk.",
          "not-parallelism.md",
        );
        // "It's not raining" has no ", it's" continuation so should not fire
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins).toHaveLength(0);
      });
    });

    describe("negative reframe cardinal sin", () => {
      test("flags reframing nouns: question, problem, issue", () => {
        const result = scanContent(
          "The question isn't whether to ship. The problem isn't the budget.",
          "reframe.md",
        );
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins.length).toBeGreaterThanOrEqual(2);
        expect(sins.some((v) => v.suggestion === "State what it IS, not what it isn't")).toBe(true);
      });

      test("does not flag factual negations like 'The car isn't running'", () => {
        const result = scanContent(
          "The car isn't running. The test isn't passing. The button isn't responding.",
          "not-reframe.md",
        );
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins).toHaveLength(0);
      });
    });

    describe("dramatic countdown cardinal sin", () => {
      test("flags 'Not X. Not Y.' countdown pattern", () => {
        const result = scanContent(
          "Not a bug. Not a feature. A fundamental design flaw that nobody wanted to address.",
          "countdown.md",
        );
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins.length).toBeGreaterThanOrEqual(1);
        expect(sins.some((v) => v.suggestion === "State the point directly")).toBe(true);
      });

      test("does not flag a single 'Not X.' sentence", () => {
        const result = scanContent(
          "Not all configurations require this setting.",
          "not-countdown.md",
        );
        const sins = result.violations.filter(
          (v) => v.type === "cardinal_sin" && v.suggestion === "State the point directly",
        );
        expect(sins).toHaveLength(0);
      });
    });

    describe("guideline-only negatives", () => {
      test("does not flag 'This happens because we initialized the cache.'", () => {
        const result = scanContent(
          "This happens because we initialized the cache.",
          "negative-cache.md",
        );
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins).toHaveLength(0);
      });

      test("does not flag 'People tend to prefer the default.'", () => {
        const result = scanContent("People tend to prefer the default.", "negative-default.md");
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins).toHaveLength(0);
      });

      test("does not flag 'Nobody designed this for that use case.'", () => {
        const result = scanContent(
          "Nobody designed this for that use case.",
          "negative-usecase.md",
        );
        const sins = result.violations.filter((v) => v.type === "cardinal_sin");
        expect(sins).toHaveLength(0);
      });
    });

    test("score does not go below 0", () => {
      // Pack as many violations as possible into a short text
      const result = scanContent(
        "In today's digital landscape, we must leverage robust, seamless, and comprehensive " +
          "solutions rather than outdated approaches. It's worth noting that stakeholders " +
          "must foster synergy. Furthermore, perhaps the ecosystem paradigm represents a " +
          "significant shift. The truth is, at its core, we must utilize innovative, " +
          "cutting-edge tools -- to navigate the complex realm. Moreover, experts say " +
          "studies show it could be argued that the journey serves as a testament. " +
          "Additionally, we must delve into the multifaceted tapestry of pivotal, " +
          "holistic, and proactive approaches. The bottom line is we need to embark " +
          "on a journey to unlock seamless, game-changing outcomes rather than settling. " +
          "Let's explore how to facilitate vital, meticulous optimization. Perhaps " +
          "it could be said that observers note the compelling, intricate beacon " +
          "of streamlined best-in-class solutions -- showcasing the potential.",
        "maximum-slop.md",
      );
      expect(result.score).toBe(0);
    });
  });

  describe("countWords", () => {
    test("counts words in normal text", () => {
      expect(countWords("hello world")).toBe(2);
      expect(countWords("one two three four")).toBe(4);
    });

    test("handles empty and whitespace", () => {
      expect(countWords("")).toBe(0);
      expect(countWords("   ")).toBe(0);
    });
  });

  describe("computeQualitativeScore", () => {
    test("returns scores for substantial content", () => {
      const content =
        "Garbage collection in Go uses a concurrent, tri-color mark-and-sweep algorithm. " +
        "That sentence is accurate but tells you nothing about why the design was chosen. " +
        "Every garbage collector trades throughput for latency. Go chose low latency because " +
        "its target workload is network servers, where tail latency matters more than raw throughput.\n\n" +
        "The collector runs concurrently with application goroutines. It does not stop the world " +
        "for the entire collection cycle. Instead, it uses write barriers to track pointer mutations " +
        "while the marker runs. The pause happens only during the initial stack scan and the final " +
        "termination check. Both pauses are measured in microseconds, not milliseconds.\n\n" +
        "Memory allocation in Go uses a thread-local cache called mcache. Each processor gets its " +
        "own mcache, so most allocations require no locking. When the mcache runs dry, it refills " +
        "from a shared mcentral. The mcentral itself pulls from a global mheap that maps virtual " +
        "memory from the operating system.";

      const q = computeQualitativeScore(content);
      expect(q.directness).toBeGreaterThanOrEqual(1);
      expect(q.directness).toBeLessThanOrEqual(10);
      expect(q.rhythm).toBeGreaterThanOrEqual(1);
      expect(q.trust).toBeGreaterThanOrEqual(1);
      expect(q.density).toBeGreaterThanOrEqual(1);
      expect(q.total).toBeGreaterThanOrEqual(4);
      expect(q.maxTotal).toBe(40);
      expect(q.fleschKincaid).toBeDefined();
      expect(q.readingTimeMin).toBeDefined();
    });
  });
});

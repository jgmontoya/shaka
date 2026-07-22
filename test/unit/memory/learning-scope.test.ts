import { describe, expect, test } from "bun:test";
import { join, parse, sep } from "node:path";
import {
  type LearningScopeState,
  type PromotionEvidence,
  allowScopeWidening,
  effectiveSourceCwds,
  findCommonAncestorCandidate,
  generalizeLearningScope,
  includeCwdInScope,
  independentPositiveRoots,
  narrowScopeForExclusion,
  narrowScopeForExclusions,
  normalizeCwdPath,
  reviewScopeWidening,
  validateLearningScope,
} from "../../../src/memory/learning-scope";
import { matchesCwd } from "../../../src/memory/learnings";

const filesystemRoot = parse(process.cwd()).root;

function absolutePath(...segments: string[]): string {
  return join(filesystemRoot, ...segments);
}

function makeEvidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    sourceCwds: overrides.sourceCwds ?? [absolutePath("work", "company-a", "project-1")],
    excludedCwds: overrides.excludedCwds ?? [],
    exposures: overrides.exposures ?? [],
    reasons: overrides.reasons ?? ["manual-scope-correction"],
  };
}

function makeState(overrides: Partial<LearningScopeState> = {}): LearningScopeState {
  return {
    cwds: overrides.cwds ?? [absolutePath("work", "company-a", "project-1")],
    nonglobal: overrides.nonglobal ?? false,
    ...(overrides.promotionEvidence ? { promotionEvidence: overrides.promotionEvidence } : {}),
  };
}

describe("normalizeCwdPath", () => {
  test("resolves relative command input against one captured absolute CWD", () => {
    expect(
      normalizeCwdPath(
        ["..", "project-2", ".", "src", ""].join(sep),
        absolutePath("work", "company-a", "project-1"),
      ),
    ).toBe(absolutePath("work", "company-a", "project-2", "src"));
  });

  test("normalizes dot segments and trailing separators on absolute paths", () => {
    const raw = `${absolutePath("work", "company-a", "project-1")}${sep}..${sep}project-2${sep}`;
    expect(normalizeCwdPath(raw)).toBe(absolutePath("work", "company-a", "project-2"));
  });

  test("does not resolve relative input without an absolute captured base", () => {
    expect(normalizeCwdPath("project-1")).toBeUndefined();
    expect(normalizeCwdPath("project-1", "relative/base")).toBeUndefined();
  });
});

describe("independentPositiveRoots", () => {
  test("keeps the shallowest root from nested duplicates in deterministic order", () => {
    expect(
      independentPositiveRoots([
        absolutePath("work", "b", "project", "src"),
        absolutePath("work", "a", "project", "src"),
        absolutePath("work", "b", "project"),
        `${absolutePath("work", "a", "project")}${sep}`,
        absolutePath("work", "a", "project"),
      ]),
    ).toEqual([absolutePath("work", "a", "project"), absolutePath("work", "b", "project")]);
  });

  test("keeps lexical paths distinct without resolving symlinks", () => {
    expect(
      independentPositiveRoots([
        absolutePath("work", "link", "project"),
        absolutePath("work", "real", "project"),
      ]),
    ).toEqual([absolutePath("work", "link", "project"), absolutePath("work", "real", "project")]);
  });
});

describe("effectiveSourceCwds", () => {
  test("removes every positive source related to an exclusion", () => {
    const evidence = makeEvidence({
      sourceCwds: [
        absolutePath("work", "company-b", "project-x"),
        absolutePath("work", "company-a", "project-2"),
        absolutePath("work", "company-c"),
        absolutePath("work", "company-a", "project-1"),
      ],
      excludedCwds: [
        absolutePath("work", "company-b"),
        absolutePath("work", "company-c", "legacy"),
      ],
    });

    expect(effectiveSourceCwds(evidence)).toEqual([
      absolutePath("work", "company-a", "project-1"),
      absolutePath("work", "company-a", "project-2"),
    ]);
  });
});

describe("generalizeLearningScope", () => {
  test("generalizes three sibling repositories to their project", () => {
    const sources = [
      absolutePath("work", "company-a", "project-1", "repo-a"),
      absolutePath("work", "company-a", "project-1", "repo-b"),
      absolutePath("work", "company-a", "project-1", "repo-c"),
    ];
    const exposure = { date: "2026-07-22", sessionHash: "abcd1234" };

    const result = generalizeLearningScope(
      makeState({ cwds: sources }),
      [exposure],
      [absolutePath("home", "alice")],
    );

    expect(result).toEqual({
      ok: true,
      changed: true,
      state: {
        cwds: [absolutePath("work", "company-a", "project-1")],
        nonglobal: false,
        promotionEvidence: {
          sourceCwds: sources,
          excludedCwds: [],
          exposures: [exposure],
          reasons: ["automatic-hierarchical-generalization"],
        },
      },
    });
  });

  test("does not treat repeated evidence in one child branch as another branch", () => {
    const sources = [
      absolutePath("work", "company-a", "project-2", "repo-a"),
      absolutePath("work", "company-a", "project-1", "repo-b"),
      absolutePath("work", "company-a", "project-1", "repo-a"),
    ];
    const state = makeState({ cwds: sources });

    expect(generalizeLearningScope(state, [], [])).toEqual({
      ok: true,
      changed: false,
      state,
    });
  });

  test("keeps independently generalized clusters and exact outliers as a forest", () => {
    const firstProject = absolutePath("work", "company-a", "project-1");
    const secondProject = absolutePath("work", "company-b", "project-1");
    const outlier = absolutePath("work", "company-b", "project-2", "repo-x");
    const sources = [
      join(secondProject, "repo-b"),
      join(firstProject, "repo-c"),
      outlier,
      join(secondProject, "repo-a"),
      join(firstProject, "repo-a"),
      join(secondProject, "repo-c"),
      join(firstProject, "repo-b"),
    ];

    const result = generalizeLearningScope(makeState({ cwds: sources }), [], []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toBe(true);
      expect(result.state.cwds).toEqual([firstProject, secondProject, outlier]);
    }
  });

  test("widens an existing generalized project when three project branches are supported", () => {
    const firstExposure = { date: "2026-07-21", sessionHash: "aaaa1111" };
    const nextExposure = { date: "2026-07-22", sessionHash: "bbbb2222" };
    const sources = [
      absolutePath("work", "company-a", "project-1", "repo-a"),
      absolutePath("work", "company-a", "project-1", "repo-b"),
      absolutePath("work", "company-a", "project-1", "repo-c"),
      absolutePath("work", "company-a", "project-2", "repo-a"),
      absolutePath("work", "company-a", "project-3", "repo-a"),
    ];
    const state = makeState({
      cwds: [absolutePath("work", "company-a", "project-1"), sources[3] ?? "", sources[4] ?? ""],
      promotionEvidence: makeEvidence({
        sourceCwds: sources,
        exposures: [firstExposure],
        reasons: ["manual-common-ancestor-review"],
      }),
    });

    const result = generalizeLearningScope(state, [nextExposure], []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.cwds).toEqual([absolutePath("work", "company-a")]);
      expect(result.state.promotionEvidence).toEqual({
        sourceCwds: sources,
        excludedCwds: [],
        exposures: [firstExposure, nextExposure],
        reasons: ["automatic-hierarchical-generalization", "manual-common-ancestor-review"],
      });
    }
  });

  test("canonicalizes a qualifying filesystem root as global", () => {
    const sources = [
      absolutePath("company-a", "project"),
      absolutePath("company-b", "project"),
      absolutePath("company-c", "project"),
    ];

    const result = generalizeLearningScope(makeState({ cwds: sources }), [], []);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.cwds).toEqual(["*"]);
  });

  test("does not generalize to an exact forbidden root", () => {
    const home = absolutePath("home", "alice");
    const sources = [join(home, "company-a"), join(home, "company-b"), join(home, "company-c")];
    const state = makeState({ cwds: sources });

    expect(generalizeLearningScope(state, [], [home])).toEqual({
      ok: true,
      changed: false,
      state,
    });
  });

  test("counts a forbidden subtree as one branch for a valid ancestor above it", () => {
    const forbidden = absolutePath("work", "home", "alice");
    const sources = [
      join(forbidden, "company-a"),
      join(forbidden, "company-b"),
      join(forbidden, "company-c"),
      absolutePath("work", "team-b", "project"),
      absolutePath("work", "team-c", "project"),
    ];

    const result = generalizeLearningScope(makeState({ cwds: sources }), [], [forbidden]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.cwds).toEqual([absolutePath("work")]);
  });

  test("preserves a reviewed ancestor when evidence derives a narrower scope", () => {
    const company = absolutePath("work", "company-a");
    const state = makeState({
      cwds: [company],
      promotionEvidence: makeEvidence({
        sourceCwds: [
          join(company, "project-1", "repo-a"),
          join(company, "project-1", "repo-b"),
          join(company, "project-1", "repo-c"),
        ],
        reasons: ["manual-common-ancestor-review"],
      }),
    });

    expect(generalizeLearningScope(state, [], [])).toEqual({
      ok: true,
      changed: false,
      state,
    });
  });

  test("is independent of source ordering and idempotent", () => {
    const sources = [
      absolutePath("work", "company-a", "project-1", "repo-a"),
      absolutePath("work", "company-a", "project-1", "repo-b"),
      absolutePath("work", "company-a", "project-1", "repo-c"),
    ];
    const forward = generalizeLearningScope(makeState({ cwds: sources }), [], []);
    const reversed = generalizeLearningScope(makeState({ cwds: [...sources].reverse() }), [], []);

    expect(forward.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (forward.ok && reversed.ok) {
      expect(reversed.state).toEqual(forward.state);
      expect(generalizeLearningScope(forward.state, [], [])).toEqual({
        ok: true,
        changed: false,
        state: forward.state,
      });
    }
  });

  test("leaves global, nonglobal, and excluded states unchanged", () => {
    const sourceCwds = [
      absolutePath("work", "company-a", "project-1"),
      absolutePath("work", "company-a", "project-2"),
      absolutePath("work", "company-a", "project-3"),
      absolutePath("work", "company-b", "project-1"),
    ];
    const blockedStates = [
      makeState({ cwds: ["*"] }),
      makeState({ cwds: sourceCwds.slice(0, 3), nonglobal: true }),
      makeState({
        cwds: sourceCwds.slice(0, 3),
        promotionEvidence: makeEvidence({
          sourceCwds,
          excludedCwds: [sourceCwds[3] ?? ""],
        }),
      }),
    ];

    for (const state of blockedStates) {
      expect(generalizeLearningScope(state, [], [])).toEqual({
        ok: true,
        changed: false,
        state,
      });
    }
  });

  test("returns a validation issue for malformed persisted scope state", () => {
    const result = generalizeLearningScope(
      makeState({
        cwds: [absolutePath("work", "company-a")],
        promotionEvidence: makeEvidence({
          sourceCwds: [absolutePath("work", "company-b", "project-1")],
        }),
      }),
      [],
      [],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-persisted-state");
  });

  if (process.platform === "win32") {
    test("generalizes three distinct parsed roots through the virtual root", () => {
      const result = generalizeLearningScope(
        makeState({ cwds: ["C:\\work\\project", "D:\\work\\project", "E:\\work\\project"] }),
        [],
        [],
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state.cwds).toEqual(["*"]);
    });

    test("counts Windows path case variants as one logical branch", () => {
      const state = makeState({
        cwds: ["C:\\Users\\J\\Repo", "c:\\users\\j\\repo", "C:\\USERS\\J\\REPO"],
      });

      expect(generalizeLearningScope(state, [], [])).toEqual({
        ok: true,
        changed: false,
        state,
      });
    });

    test("matches forbidden Windows roots without regard to casing", () => {
      const state = makeState({
        cwds: ["C:\\Users\\J\\company-a", "C:\\Users\\J\\company-b", "C:\\Users\\J\\company-c"],
      });

      expect(generalizeLearningScope(state, [], ["c:\\users\\j"])).toEqual({
        ok: true,
        changed: false,
        state,
      });
    });
  }
});

describe("findCommonAncestorCandidate", () => {
  test("compares path segments instead of string prefixes", () => {
    expect(
      findCommonAncestorCandidate(
        [
          absolutePath("work", "company-a", "project-1"),
          absolutePath("work", "company-a", "project-10"),
        ],
        [],
      ),
    ).toBe(absolutePath("work", "company-a"));
  });

  test("rejects the filesystem root and exact forbidden roots", () => {
    expect(
      findCommonAncestorCandidate(
        [absolutePath("company-a", "project"), absolutePath("company-b", "project")],
        [],
      ),
    ).toBeUndefined();
    expect(
      findCommonAncestorCandidate(
        [
          absolutePath("home", "alice", "company", "project-1"),
          absolutePath("home", "alice", "company", "project-2"),
        ],
        [absolutePath("home", "alice", "company")],
      ),
    ).toBeUndefined();
  });

  test("allows a project ancestor below an exact forbidden home root", () => {
    expect(
      findCommonAncestorCandidate(
        [
          absolutePath("home", "alice", "company", "project-1"),
          absolutePath("home", "alice", "company", "project-2"),
        ],
        [absolutePath("home", "alice")],
      ),
    ).toBe(absolutePath("home", "alice", "company"));
  });

  if (process.platform === "win32") {
    test("uses Windows case equivalence and rejects different volumes", () => {
      expect(
        findCommonAncestorCandidate(
          ["C:\\Work\\Company\\project-1", "c:\\work\\company\\project-2"],
          [],
        )?.toLowerCase(),
      ).toBe("c:\\work\\company");
      expect(
        findCommonAncestorCandidate(
          ["C:\\Work\\Company\\project-1", "D:\\Work\\Company\\project-2"],
          [],
        ),
      ).toBeUndefined();
      expect(
        findCommonAncestorCandidate(
          ["C:\\Work\\Company\\project-1", "C:\\Work\\Company\\project-2"],
          ["c:\\work\\company"],
        ),
      ).toBeUndefined();
    });
  }
});

describe("validateLearningScope", () => {
  test("rejects global scope with exclusions", () => {
    const result = validateLearningScope(
      makeState({
        cwds: ["*"],
        promotionEvidence: makeEvidence({
          excludedCwds: [absolutePath("work", "company-b")],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("scope-matches-exclusion");
  });

  test("rejects a wildcard mixed with path scopes", () => {
    const result = validateLearningScope(
      makeState({ cwds: ["*", absolutePath("work", "company-a")] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-global-shape");
  });

  test("rejects an empty active scope", () => {
    const result = validateLearningScope(makeState({ cwds: [] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-persisted-state");
  });

  test("rejects global scope marked nonglobal", () => {
    const result = validateLearningScope(makeState({ cwds: ["*"], nonglobal: true }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-persisted-state");
  });

  test("rejects relative persisted scope paths", () => {
    const result = validateLearningScope(makeState({ cwds: ["company-a/project-1"] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-path");
  });

  test("rejects promotion evidence without positive sources", () => {
    const result = validateLearningScope(
      makeState({ promotionEvidence: makeEvidence({ sourceCwds: [] }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-evidence");
  });

  test("rejects noncanonical source and exclusion arrays", () => {
    const result = validateLearningScope(
      makeState({
        promotionEvidence: makeEvidence({
          sourceCwds: [
            absolutePath("work", "company-b"),
            absolutePath("work", "company-a"),
            absolutePath("work", "company-a"),
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-evidence");
  });

  test("rejects empty or relative evidence paths", () => {
    for (const evidence of [
      makeEvidence({ sourceCwds: ["company-a/project-1"] }),
      makeEvidence({ excludedCwds: [""] }),
    ]) {
      const result = validateLearningScope(makeState({ promotionEvidence: evidence }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issue.code).toBe("invalid-evidence");
    }
  });

  test("rejects an active scope related to an exclusion", () => {
    const result = validateLearningScope(
      makeState({
        cwds: [absolutePath("work", "company-a")],
        promotionEvidence: makeEvidence({
          sourceCwds: [
            absolutePath("work", "company-a", "project-1"),
            absolutePath("work", "company-b", "project-1"),
          ],
          excludedCwds: [absolutePath("work", "company-a", "legacy")],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("scope-matches-exclusion");
  });

  test("rejects active scope that does not cover every effective positive source", () => {
    const result = validateLearningScope(
      makeState({
        cwds: [absolutePath("work", "company-a", "project-1")],
        promotionEvidence: makeEvidence({
          sourceCwds: [
            absolutePath("work", "company-a", "project-1"),
            absolutePath("work", "company-b", "project-1"),
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-persisted-state");
  });

  test("accepts exact fallback roots that cover all effective sources and no exclusion", () => {
    const evidence = makeEvidence({
      sourceCwds: [
        absolutePath("work", "company-a", "project-1"),
        absolutePath("work", "company-a", "project-2"),
        absolutePath("work", "company-b", "project-x"),
      ],
      excludedCwds: [absolutePath("work", "company-b", "project-x")],
    });
    const exactFallback = independentPositiveRoots(effectiveSourceCwds(evidence));

    expect(
      validateLearningScope(
        makeState({ cwds: exactFallback, nonglobal: true, promotionEvidence: evidence }),
      ),
    ).toEqual({ ok: true });
  });
});

describe("narrowScopeForExclusion", () => {
  test("narrows a global learning to its exact effective sources", () => {
    const sourceCwds = [
      absolutePath("work", "company-a", "project-1"),
      absolutePath("work", "company-a", "project-2"),
    ];
    const result = narrowScopeForExclusion(
      makeState({
        cwds: ["*"],
        promotionEvidence: makeEvidence({ sourceCwds }),
      }),
      absolutePath("work", "company-b", "project-x"),
    );

    expect(result).toEqual({
      ok: true,
      state: {
        cwds: sourceCwds,
        nonglobal: true,
        promotionEvidence: {
          sourceCwds,
          excludedCwds: [absolutePath("work", "company-b", "project-x")],
          exposures: [],
          reasons: ["manual-scope-correction"],
        },
      },
    });
  });

  test("uses only the recomputed confirmed ancestor", () => {
    const sourceCwds = [
      absolutePath("work", "company-a", "project-1"),
      absolutePath("work", "company-a", "project-2"),
    ];
    const ancestor = absolutePath("work", "company-a");
    const result = narrowScopeForExclusion(
      makeState({
        cwds: ["*"],
        promotionEvidence: makeEvidence({ sourceCwds }),
      }),
      absolutePath("work", "company-b"),
      { scopeChoice: { kind: "confirmed-ancestor", cwd: ancestor, forbiddenRoots: [] } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.cwds).toEqual([ancestor]);
  });

  test("rejects an arbitrary broader ancestor", () => {
    const result = narrowScopeForExclusion(
      makeState({
        cwds: ["*"],
        promotionEvidence: makeEvidence({
          sourceCwds: [
            absolutePath("work", "company-a", "project-1"),
            absolutePath("work", "company-a", "project-2"),
          ],
        }),
      }),
      absolutePath("work", "company-b"),
      {
        scopeChoice: {
          kind: "confirmed-ancestor",
          cwd: absolutePath("work"),
          forbiddenRoots: [],
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-ancestor");
  });

  test("rejects a common ancestor that would cover the exclusion", () => {
    const result = narrowScopeForExclusion(
      makeState({
        cwds: ["*"],
        promotionEvidence: makeEvidence({
          sourceCwds: [
            absolutePath("work", "company-a", "project-1"),
            absolutePath("work", "company-a", "project-2"),
          ],
        }),
      }),
      absolutePath("work", "company-a", "legacy"),
      {
        scopeChoice: {
          kind: "confirmed-ancestor",
          cwd: absolutePath("work", "company-a"),
          forbiddenRoots: [],
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("scope-matches-exclusion");
  });

  test("keeps an excluded positive source as historical evidence", () => {
    const excludedSource = absolutePath("work", "company-a", "project-1");
    const retainedSource = absolutePath("work", "company-a", "project-2");
    const result = narrowScopeForExclusion(
      makeState({
        cwds: ["*"],
        promotionEvidence: makeEvidence({ sourceCwds: [excludedSource, retainedSource] }),
      }),
      excludedSource,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.cwds).toEqual([retainedSource]);
      expect(result.state.promotionEvidence?.sourceCwds).toEqual([excludedSource, retainedSource]);
      const evidence = result.state.promotionEvidence;
      expect(evidence).toBeDefined();
      if (evidence) expect(effectiveSourceCwds(evidence)).toEqual([retainedSource]);
    }
  });

  test("does not record an exclusion outside a non-global active scope", () => {
    const activeCwd = absolutePath("work", "company-a", "project-1");
    const target = absolutePath("work", "company-b", "project-x");

    for (const state of [
      makeState({ cwds: [activeCwd] }),
      makeState({
        cwds: [activeCwd],
        promotionEvidence: makeEvidence({ sourceCwds: [activeCwd] }),
      }),
    ]) {
      const result = narrowScopeForExclusion(state, target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issue.code).toBe("already-inapplicable");
      expect(state.promotionEvidence?.excludedCwds).toEqual(
        state.promotionEvidence ? [] : undefined,
      );
    }
  });

  test("requires a positive source after excluding the last effective source", () => {
    const excludedSource = absolutePath("work", "company-a", "project-1");
    const assertedSource = absolutePath("work", "company-a", "project-2");
    const state = makeState({
      cwds: [excludedSource],
      promotionEvidence: makeEvidence({ sourceCwds: [excludedSource] }),
    });

    const rejected = narrowScopeForExclusion(state, excludedSource);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issue.code).toBe("no-effective-sources");

    const accepted = narrowScopeForExclusion(state, excludedSource, {
      assertedSourceCwds: [assertedSource],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.state.cwds).toEqual([assertedSource]);
      expect(accepted.state.promotionEvidence?.sourceCwds).toEqual([
        excludedSource,
        assertedSource,
      ]);
    }
  });

  test("repeating the same exclusion is idempotent", () => {
    const excludedCwd = absolutePath("work", "company-b", "project-x");
    const state = makeState({
      cwds: [absolutePath("work", "company-a", "project-1")],
      nonglobal: true,
      promotionEvidence: makeEvidence({
        sourceCwds: [absolutePath("work", "company-a", "project-1")],
        excludedCwds: [excludedCwd],
      }),
    });

    expect(narrowScopeForExclusion(state, `${excludedCwd}${sep}`)).toEqual({
      ok: true,
      state,
    });
  });

  test("bootstraps evidence from a matching ordinary scoped learning", () => {
    const excludedCwd = absolutePath("work", "company-a", "project-1");
    const retainedCwd = absolutePath("work", "company-a", "project-2");
    const exposure = { date: "2026-07-21", sessionHash: "abcd1234" };
    const result = narrowScopeForExclusion(
      makeState({ cwds: [excludedCwd, retainedCwd] }),
      excludedCwd,
      { supportingExposures: [exposure] },
    );

    expect(result).toEqual({
      ok: true,
      state: {
        cwds: [retainedCwd],
        nonglobal: true,
        promotionEvidence: {
          sourceCwds: [excludedCwd, retainedCwd],
          excludedCwds: [excludedCwd],
          exposures: [exposure],
          reasons: ["manual-scope-correction"],
        },
      },
    });
  });

  test("requires an explicit exposure snapshot when bootstrapping evidence", () => {
    const excludedCwd = absolutePath("work", "company-a", "project-1");
    const retainedCwd = absolutePath("work", "company-a", "project-2");

    const result = narrowScopeForExclusion(
      makeState({ cwds: [excludedCwd, retainedCwd] }),
      excludedCwd,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("invalid-evidence");
  });

  test("requires asserted roots to narrow an evidence-less legacy global", () => {
    const excludedCwd = absolutePath("work", "company-b", "project-x");
    const assertedCwd = absolutePath("work", "company-a", "project-1");
    const state = makeState({ cwds: ["*"] });

    const rejected = narrowScopeForExclusion(state, excludedCwd);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issue.code).toBe("no-effective-sources");

    const accepted = narrowScopeForExclusion(state, excludedCwd, {
      assertedSourceCwds: [`${assertedCwd}${sep}`],
      supportingExposures: [],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.state.cwds).toEqual([assertedCwd]);
      expect(accepted.state.promotionEvidence?.sourceCwds).toEqual([assertedCwd]);
    }
  });

  test("rejects asserted roots that conflict with the exclusion", () => {
    const excludedCwd = absolutePath("work", "company-b");
    const result = narrowScopeForExclusion(makeState({ cwds: ["*"] }), excludedCwd, {
      assertedSourceCwds: [absolutePath("work", "company-b", "project-x")],
      supportingExposures: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("scope-matches-exclusion");
  });
});

describe("includeCwdInScope", () => {
  test("removes the selected exclusion and restores exact scoped applicability", () => {
    const retainedCwd = absolutePath("work", "company-a", "project-1");
    const includedCwd = absolutePath("work", "company-a", "project-2");
    const state = makeState({
      cwds: [retainedCwd],
      nonglobal: true,
      promotionEvidence: makeEvidence({
        sourceCwds: [retainedCwd, includedCwd],
        excludedCwds: [includedCwd],
      }),
    });

    expect(includeCwdInScope(state, includedCwd, includedCwd)).toEqual({
      ok: true,
      state: {
        cwds: [retainedCwd, includedCwd],
        nonglobal: true,
        promotionEvidence: {
          sourceCwds: [retainedCwd, includedCwd],
          excludedCwds: [],
          exposures: [],
          reasons: ["manual-scope-correction"],
        },
      },
    });
  });

  test("removing a broad exclusion adds every newly effective sibling source", () => {
    const activeCwd = absolutePath("work", "company-a", "project-1");
    const siblingOne = absolutePath("work", "company-b", "project-1");
    const siblingTwo = absolutePath("work", "company-b", "project-2");
    const broadExclusion = absolutePath("work", "company-b");
    const state = makeState({
      cwds: [activeCwd],
      nonglobal: true,
      promotionEvidence: makeEvidence({
        sourceCwds: [activeCwd, siblingOne, siblingTwo],
        excludedCwds: [broadExclusion],
      }),
    });

    const result = includeCwdInScope(state, siblingOne, broadExclusion);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.cwds).toEqual([activeCwd, siblingOne, siblingTwo]);
  });

  test("restores an effective ancestor after its child exclusion is removed", () => {
    const project = absolutePath("work", "project");
    const excluded = join(project, "a");
    const retained = join(project, "b");
    const original = makeState({
      cwds: [project],
      promotionEvidence: makeEvidence({ sourceCwds: [project, retained] }),
    });
    const narrowed = narrowScopeForExclusion(original, excluded);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;

    const included = includeCwdInScope(narrowed.state, excluded, excluded);

    expect(included.ok).toBe(true);
    if (included.ok) {
      expect(included.state.cwds).toEqual([project]);
      expect(validateLearningScope(included.state)).toEqual({ ok: true });
      expect(
        matchesCwd(
          {
            category: "pattern",
            cwds: [...included.state.cwds],
            exposures: [{ date: "2026-07-22", sessionHash: "include0" }],
            nonglobal: included.state.nonglobal,
            title: "Restored ancestor",
            body: "Applies below the restored ancestor.",
            promotionEvidence: included.state.promotionEvidence,
          },
          join(project, "c"),
        ),
      ).toBe(true);
    }
  });

  test("removing a child exclusion leaves a covering parent exclusion in force", () => {
    const activeCwd = absolutePath("work", "company-a", "project-1");
    const target = absolutePath("work", "company-b", "project-1");
    const parentExclusion = absolutePath("work", "company-b");
    const state = makeState({
      cwds: [activeCwd],
      nonglobal: true,
      promotionEvidence: makeEvidence({
        sourceCwds: [activeCwd, target],
        excludedCwds: [parentExclusion, target],
      }),
    });

    const result = includeCwdInScope(state, target, target);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.cwds).toEqual([activeCwd]);
      expect(result.state.promotionEvidence?.excludedCwds).toEqual([parentExclusion]);
      const evidence = result.state.promotionEvidence;
      expect(evidence).toBeDefined();
      if (evidence) expect(effectiveSourceCwds(evidence)).toEqual([activeCwd]);
    }
  });

  test("returns a normalized preview without mutating the input state", () => {
    const activeCwd = absolutePath("work", "company-a", "project-1");
    const target = absolutePath("work", "company-b", "project-1");
    const state = makeState({
      cwds: [activeCwd],
      promotionEvidence: makeEvidence({
        sourceCwds: [activeCwd],
        excludedCwds: [target],
        reasons: ["legacy-source-reconstruction"],
      }),
    });
    const before = structuredClone(state);

    const result = includeCwdInScope(state, `${target}${sep}`, `${target}${sep}`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.cwds).toEqual([activeCwd, target]);
      expect(result.state.promotionEvidence?.sourceCwds).toEqual([activeCwd, target]);
      expect(result.state.promotionEvidence?.reasons).toEqual([
        "legacy-source-reconstruction",
        "manual-scope-correction",
      ]);
    }
    expect(state).toEqual(before);
  });

  test("reports related exclusions when no exact exclusion was selected", () => {
    const activeCwd = absolutePath("work", "company-a", "project-1");
    const target = absolutePath("work", "company-b", "project-1", "src");
    const state = makeState({
      cwds: [activeCwd],
      promotionEvidence: makeEvidence({
        sourceCwds: [activeCwd],
        excludedCwds: [
          absolutePath("work", "company-b"),
          absolutePath("work", "company-b", "project-1"),
        ],
      }),
    });

    const result = includeCwdInScope(state, target, target);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe("ambiguous-exclusion");
  });
});

describe("allowScopeWidening", () => {
  test("clears nonglobal without changing active or evidence scope", () => {
    const cwd = absolutePath("work", "company-a", "project-1");
    const state = makeState({
      cwds: [cwd],
      nonglobal: true,
      promotionEvidence: makeEvidence({ sourceCwds: [cwd] }),
    });

    expect(allowScopeWidening(state)).toEqual({
      ok: true,
      state: { ...state, nonglobal: false },
    });
    expect(state.nonglobal).toBe(true);
  });
});

describe("reviewScopeWidening", () => {
  const sources = [
    absolutePath("work", "company-a", "project-1"),
    absolutePath("work", "company-a", "project-2"),
    absolutePath("work", "company-a", "project-3"),
  ];
  const exposure = { date: "2026-07-21", sessionHash: "aaaa0000" };

  test("accepts the current common ancestor and records reviewed evidence", () => {
    const state = makeState({ cwds: sources });
    const result = reviewScopeWidening(state, [exposure], {
      kind: "confirmed-ancestor",
      cwd: absolutePath("work", "company-a"),
      forbiddenRoots: [absolutePath("work")],
    });

    expect(result).toEqual({
      ok: true,
      state: {
        cwds: [absolutePath("work", "company-a")],
        nonglobal: true,
        promotionEvidence: {
          sourceCwds: sources,
          excludedCwds: [],
          exposures: [exposure],
          reasons: ["manual-common-ancestor-review"],
        },
      },
    });
  });

  test("accepts global scope explicitly and retains prior evidence", () => {
    const state = makeState({
      cwds: [absolutePath("work", "company-a")],
      promotionEvidence: makeEvidence({
        sourceCwds: sources,
        exposures: [exposure],
        reasons: ["manual-common-ancestor-review"],
      }),
    });

    const result = reviewScopeWidening(state, [], { kind: "global" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.cwds).toEqual(["*"]);
      expect(result.state.nonglobal).toBe(false);
      expect(result.state.promotionEvidence?.reasons).toEqual([
        "manual-common-ancestor-review",
        "manual-global-review",
      ]);
    }
  });

  test("keeping the current scope only records a terminal nonglobal decision", () => {
    const state = makeState({ cwds: sources });

    expect(reviewScopeWidening(state, [exposure], { kind: "keep-current" })).toEqual({
      ok: true,
      state: { ...state, nonglobal: true },
    });
  });

  test("rejects widening when exclusions exist or fewer than three roots support it", () => {
    const excluded = makeState({
      cwds: sources.slice(0, 2),
      promotionEvidence: makeEvidence({
        sourceCwds: sources,
        excludedCwds: [sources[2] ?? ""],
      }),
    });

    const excludedResult = reviewScopeWidening(excluded, [], { kind: "global" });
    const insufficientResult = reviewScopeWidening(
      makeState({ cwds: sources.slice(0, 2) }),
      [exposure],
      { kind: "global" },
    );

    expect(excludedResult.ok).toBe(false);
    if (!excludedResult.ok) expect(excludedResult.issue.code).toBe("not-eligible");
    expect(insufficientResult.ok).toBe(false);
    if (!insufficientResult.ok) expect(insufficientResult.issue.code).toBe("not-eligible");
  });
});

describe("narrowScopeForExclusions", () => {
  test("atomically subtracts multiple roots with contradiction provenance", () => {
    const firstExcluded = absolutePath("work", "company-a", "project-1");
    const secondExcluded = absolutePath("work", "company-a", "project-2");
    const retainedCwd = absolutePath("work", "company-b", "project-1");
    const state = makeState({
      cwds: ["*"],
      promotionEvidence: makeEvidence({
        sourceCwds: [firstExcluded, secondExcluded, retainedCwd],
        reasons: ["legacy-source-reconstruction"],
      }),
    });

    const result = narrowScopeForExclusions(state, [secondExcluded, firstExcluded]);

    expect(result).toEqual({
      ok: true,
      state: {
        cwds: [retainedCwd],
        nonglobal: false,
        promotionEvidence: {
          sourceCwds: [firstExcluded, secondExcluded, retainedCwd],
          excludedCwds: [firstExcluded, secondExcluded],
          exposures: [],
          reasons: ["contradiction-scope-subtraction", "legacy-source-reconstruction"],
        },
      },
    });
    expect(state.promotionEvidence?.excludedCwds).toEqual([]);
  });
});

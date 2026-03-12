import { describe, expect, test } from "bun:test";
import { parseGitHubUrl } from "../../../src/domain/github-url";

describe("parseGitHubUrl", () => {
  describe("shorthand format", () => {
    test("parses user/repo", () => {
      const result = parseGitHubUrl("user/repo");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe("user");
        expect(result.value.repo).toBe("repo");
        expect(result.value.ref).toBeNull();
        expect(result.value.subdirectory).toBeNull();
        expect(result.value.cloneUrl).toBe("https://github.com/user/repo.git");
      }
    });

    test("parses user/repo#ref", () => {
      const result = parseGitHubUrl("user/repo#main");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe("user");
        expect(result.value.repo).toBe("repo");
        expect(result.value.ref).toBe("main");
      }
    });

    test("parses user/repo#tag with version tag", () => {
      const result = parseGitHubUrl("user/repo#v1.2.3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBe("v1.2.3");
      }
    });

    test("trims whitespace", () => {
      const result = parseGitHubUrl("  user/repo  ");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe("user");
        expect(result.value.repo).toBe("repo");
      }
    });
  });

  describe("HTTPS format", () => {
    test("parses https://github.com/user/repo", () => {
      const result = parseGitHubUrl("https://github.com/user/repo");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe("user");
        expect(result.value.repo).toBe("repo");
        expect(result.value.ref).toBeNull();
        expect(result.value.subdirectory).toBeNull();
        expect(result.value.cloneUrl).toBe("https://github.com/user/repo.git");
      }
    });

    test("parses URL with .git suffix", () => {
      const result = parseGitHubUrl("https://github.com/user/repo.git");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.repo).toBe("repo");
        expect(result.value.cloneUrl).toBe("https://github.com/user/repo.git");
      }
    });

    test("parses URL with #ref fragment", () => {
      const result = parseGitHubUrl("https://github.com/user/repo#develop");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBe("develop");
      }
    });

    test("parses /tree/branch URL", () => {
      const result = parseGitHubUrl("https://github.com/user/repo/tree/main");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBe("main");
        expect(result.value.subdirectory).toBeNull();
      }
    });

    test("parses /tree/branch/path URL", () => {
      const result = parseGitHubUrl("https://github.com/user/repo/tree/main/skills/my-skill");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBe("main");
        expect(result.value.subdirectory).toBe("skills/my-skill");
      }
    });

    test("parses /tree/branch/deep/path URL", () => {
      const result = parseGitHubUrl("https://github.com/user/repo/tree/v2/a/b/c");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBe("v2");
        expect(result.value.subdirectory).toBe("a/b/c");
      }
    });

    test("rejects non-GitHub host", () => {
      const result = parseGitHubUrl("https://gitlab.com/user/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported host");
        expect(result.error.message).toContain("gitlab.com");
      }
    });

    test("rejects URL with only user (no repo)", () => {
      const result = parseGitHubUrl("https://github.com/user");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Expected at least user/repo");
      }
    });

    test("rejects /blob/ URL path", () => {
      const result = parseGitHubUrl("https://github.com/user/repo/blob/main/SKILL.md");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported GitHub URL path");
      }
    });

    test("rejects /releases/ URL path", () => {
      const result = parseGitHubUrl("https://github.com/user/repo/releases/tag/v1.0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported GitHub URL path");
      }
    });
  });

  describe("SSH format", () => {
    test("parses git@github.com:user/repo.git", () => {
      const result = parseGitHubUrl("git@github.com:user/repo.git");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe("user");
        expect(result.value.repo).toBe("repo");
        expect(result.value.ref).toBeNull();
        expect(result.value.cloneUrl).toBe("https://github.com/user/repo.git");
      }
    });

    test("parses SSH URL without .git suffix", () => {
      const result = parseGitHubUrl("git@github.com:user/repo");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.repo).toBe("repo");
      }
    });

    test("parses SSH URL with #ref", () => {
      const result = parseGitHubUrl("git@github.com:user/repo.git#v1.0");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBe("v1.0");
      }
    });

    test("rejects invalid SSH format", () => {
      const result = parseGitHubUrl("git@gitlab.com:user/repo.git");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid SSH URL");
      }
    });
  });

  describe("error cases", () => {
    test("rejects empty string", () => {
      const result = parseGitHubUrl("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("cannot be empty");
      }
    });

    test("rejects whitespace-only string", () => {
      const result = parseGitHubUrl("   ");
      expect(result.ok).toBe(false);
    });

    test("rejects single word (not user/repo)", () => {
      const result = parseGitHubUrl("just-a-word");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid shorthand");
      }
    });

    test("rejects three-segment path as shorthand", () => {
      const result = parseGitHubUrl("a/b/c");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid shorthand");
      }
    });

    test("handles empty fragment as null ref", () => {
      const result = parseGitHubUrl("user/repo#");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ref).toBeNull();
      }
    });
  });
});

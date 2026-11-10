import { test } from "node:test";
import assert from "node:assert/strict";
import { readPrStatuses } from "../src/pr-status.js";

function fixture() {
  const graph = {
    revision: "v1",
    repo: "https://github.enterprise/team/repo",
    base: "develop",
    groups: [{ name: "one", branch: "user/one", pr: null }],
  };
  const pr = {
    number: 42,
    url: "https://github.enterprise/team/repo/pull/42",
    state: "OPEN",
    isDraft: false,
    headRefName: "user/one",
    baseRefName: "develop",
    headRefOid: "abc",
    headRepository: { nameWithOwner: "team/repo" },
    reviewDecision: "REVIEW_REQUIRED",
    commits: {
      nodes: [
        { commit: { oid: "abc", statusCheckRollup: { state: "SUCCESS" } } },
      ],
    },
    reviewThreads: {
      nodes: [{ isResolved: true }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  let pages = 0;
  const calls = [];
  const manager = {
    graph: () => structuredClone(graph),
    gh: (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list")
        return JSON.stringify([
          {
            number: 42,
            url: pr.url,
            baseRefName: "develop",
            headRefName: "user/one",
            isCrossRepository: false,
          },
          {
            number: 43,
            baseRefName: "develop",
            headRefName: "user/one",
            isCrossRepository: true,
          },
        ]);
      assert.deepEqual(args.slice(0, 4), [
        "api",
        "graphql",
        "--hostname",
        "github.enterprise",
      ]);
      pages++;
      const copy = structuredClone(pr);
      if (args.includes("cursor=next")) {
        copy.reviewThreads = {
          nodes: [{ isResolved: false }],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      }
      return JSON.stringify({ data: { repository: { pullRequest: copy } } });
    },
  };
  return { graph, pr, calls, manager, pages: () => pages };
}

test("discovers an existing PR without adoption; ignores matching fork branches", () => {
  const f = fixture(),
    before = structuredClone(f.graph);
  const result = readPrStatuses(f.manager);
  assert.deepEqual(f.graph, before);
  assert.equal(result.revision, "v1");
  assert.equal(result.features[0].pr, 42);
  assert.equal(result.features[0].ci, "PASSING");
  assert.equal(result.features[0].actionable, false);
  assert.equal(result.features[0].unresolvedThreads, 0);
  assert.ok(f.calls.every((a) => a[0] === "api" || a[1] === "list"));
});

test("paginates unresolved threads and highlights failing CI and requested changes", () => {
  const f = fixture();
  f.pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "next" };
  f.pr.commits.nodes[0].commit.statusCheckRollup.state = "FAILURE";
  f.pr.reviewDecision = "CHANGES_REQUESTED";
  const pr = readPrStatuses(f.manager).features[0];
  assert.equal(f.pages(), 2);
  assert.equal(pr.unresolvedThreads, 1);
  assert.equal(pr.ci, "FAILING");
  assert.equal(pr.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(pr.actionable, true);
});

test("pending checks, missing checks, and checks on an old commit are not reported as passing", () => {
  const f = fixture();
  f.pr.commits.nodes[0].commit.statusCheckRollup.state = "PENDING";
  assert.equal(readPrStatuses(f.manager).features[0].ci, "PENDING");
  f.pr.commits.nodes[0].commit.statusCheckRollup = null;
  assert.equal(readPrStatuses(f.manager).features[0].ci, "UNKNOWN");
  f.pr.commits.nodes[0].commit.statusCheckRollup = { state: "SUCCESS" };
  f.pr.commits.nodes[0].commit.oid = "old";
  assert.equal(readPrStatuses(f.manager).features[0].ci, "UNKNOWN");
});

test("tracked merged PRs are visible without mutating local dependency state", () => {
  const f = fixture();
  f.graph.groups[0].pr = 42;
  f.pr.state = "MERGED";
  f.pr.reviewDecision = "CHANGES_REQUESTED";
  const pr = readPrStatuses(f.manager).features[0];
  assert.equal(pr.state, "MERGED");
  assert.equal(pr.actionable, false);
  assert.equal(
    f.calls.some((a) => a[0] === "pr"),
    false,
  );
});

test("API failures and incomplete thread pages show unavailable while retaining discovered links", () => {
  const f = fixture();
  f.pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: null };
  let result = readPrStatuses(f.manager).features[0];
  assert.match(result.error, /pagination/);
  assert.equal(result.url, f.pr.url);
  assert.equal(result.ci, undefined);
  f.manager.gh = () => {
    throw new Error("Not authenticated");
  };
  assert.match(readPrStatuses(f.manager).features[0].error, /authenticated/);
});

test("rejects mismatched head repositories and PR changes between thread pages", () => {
  const f = fixture();
  f.pr.headRepository.nameWithOwner = "someone/fork";
  assert.match(readPrStatuses(f.manager).features[0].error, /does not match/);
  f.pr.headRepository.nameWithOwner = "team/repo";
  f.pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "next" };
  const gh = f.manager.gh;
  f.manager.gh = (args) => {
    if (args.includes("cursor=next")) f.pr.headRefOid = "new";
    return gh(args);
  };
  assert.match(readPrStatuses(f.manager).features[0].error, /changed during/);
});

test("discovers a merged PR for an explicit branch override when no open PR remains", () => {
  const f = fixture(),
    gh = f.manager.gh;
  f.graph.groups[0].branchName = "user/one";
  f.pr.state = "MERGED";
  f.manager.gh = (args) =>
    args[1] === "list" && args.includes("open") ? "[]" : gh(args);
  const pr = readPrStatuses(f.manager).features[0];
  assert.equal(pr.pr, 42);
  assert.equal(pr.state, "MERGED");
  assert.equal(pr.actionable, false);
  assert.ok(f.calls.some((args) => args.includes("merged")));
  assert.equal(f.graph.groups[0].pr, null);
});

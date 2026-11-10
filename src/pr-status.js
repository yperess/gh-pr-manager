// Read-only GitHub snapshots. Discovery never adopts branches or changes workflow state.
const query = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number url state isDraft headRefName baseRefName headRefOid reviewDecision
      headRepository { nameWithOwner }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      reviewThreads(first: 100, after: $cursor) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export function readPrStatuses(manager) {
  const graph = manager.graph();
  const url = new URL(graph.repo);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  const snapshots = [];
  for (const group of graph.groups) {
    let number = group.pr,
      link = group.url;
    try {
      if (!number) {
        const find = (state) =>
          JSON.parse(
            manager.gh([
              "pr",
              "list",
              "--repo",
              graph.repo,
              "--head",
              group.branch,
              "--state",
              state,
              "--limit",
              "100",
              "--json",
              "number,url,baseRefName,headRefName,isCrossRepository",
            ]),
          ).filter(
            (pr) =>
              pr.isCrossRepository === false && pr.headRefName === group.branch,
          );
        let candidates = find("open");
        if (!candidates.length && group.branchName !== null)
          candidates = find("merged");
        if (
          candidates.length > 1 ||
          candidates.some((pr) => pr.baseRefName !== graph.base)
        )
          throw new Error(
            `No unique PR against ${graph.base} for ${group.branch}.`,
          );
        number = candidates[0]?.number;
        link = candidates[0]?.url;
      }
      if (!number) {
        snapshots.push({ name: group.name, pr: null });
        continue;
      }
      let cursor = null,
        snapshot,
        unresolvedThreads = 0;
      const cursors = new Set();
      do {
        const args = [
          "api",
          "graphql",
          "--hostname",
          url.hostname,
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `repo=${repo}`,
          "-F",
          `number=${number}`,
        ];
        if (cursor) args.push("-f", `cursor=${cursor}`);
        const result = JSON.parse(manager.gh(args));
        if (result.errors?.length)
          throw new Error(result.errors.map((e) => e.message).join("; "));
        const pr = result.data?.repository?.pullRequest;
        if (!pr) throw new Error("PR status unavailable.");
        if (
          pr.number !== number ||
          pr.headRefName !== group.branch ||
          pr.baseRefName !== graph.base ||
          pr.headRepository?.nameWithOwner.toLowerCase() !==
            `${owner}/${repo}`.toLowerCase()
        )
          throw new Error(
            "PR head repository, branch, or base does not match this feature.",
          );
        if (snapshot && snapshot.head !== pr.headRefOid)
          throw new Error("PR changed during status refresh. Refresh again.");
        const commit = pr.commits?.nodes?.[0]?.commit;
        const rollup =
          commit?.oid === pr.headRefOid
            ? commit.statusCheckRollup?.state
            : null;
        const ci = ["FAILURE", "ERROR"].includes(rollup)
          ? "FAILING"
          : ["PENDING", "EXPECTED"].includes(rollup)
            ? "PENDING"
            : rollup === "SUCCESS"
              ? "PASSING"
              : "UNKNOWN";
        const threads = pr.reviewThreads;
        if (
          !Array.isArray(threads?.nodes) ||
          !threads.pageInfo ||
          threads.nodes.some(
            (thread) => typeof thread?.isResolved !== "boolean",
          )
        )
          throw new Error("Review thread status unavailable.");
        unresolvedThreads += threads.nodes.filter(
          (thread) => !thread.isResolved,
        ).length;
        snapshot = {
          name: group.name,
          pr: number,
          url: pr.url,
          state: pr.state,
          draft: pr.isDraft,
          head: pr.headRefOid,
          ci,
          reviewDecision: pr.reviewDecision,
          unresolvedThreads,
        };
        cursor = threads.pageInfo.hasNextPage
          ? threads.pageInfo.endCursor
          : null;
        if (threads.pageInfo.hasNextPage && (!cursor || cursors.has(cursor)))
          throw new Error("Incomplete review thread pagination.");
        cursors.add(cursor);
      } while (cursor);
      snapshot.actionable =
        snapshot.state === "OPEN" &&
        (snapshot.ci === "FAILING" ||
          snapshot.reviewDecision === "CHANGES_REQUESTED" ||
          unresolvedThreads > 0);
      snapshots.push(snapshot);
    } catch (error) {
      snapshots.push({
        name: group.name,
        pr: number,
        url: link,
        error: error.message,
      });
    }
  }
  return {
    revision: graph.revision,
    checkedAt: new Date().toISOString(),
    features: snapshots,
  };
}

// A short-lived process keeps Git and gh work out of the VS Code extension host.
import { Manager } from "./core.js";

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("Request too large.");
  }
  const { route, data } = JSON.parse(input);
  const manager = new Manager();
  let result;
  if (route === "graph") result = manager.graph();
  else if (typeof route === "string" && route.startsWith("diff?sha=")) {
    const sha = new URLSearchParams(route.slice(5)).get("sha");
    if (!manager.graph().commits.some((c) => c.sha === sha))
      throw new Error("Unknown commit.");
    result = {
      diff: manager.git(
        "show",
        "--format=fuller",
        "--no-ext-diff",
        "--no-textconv",
        sha,
        "--",
      ),
    };
  } else {
    if (data?.revision !== manager.graph().revision)
      throw new Error("The repository changed. Refresh before editing.");
    if (route === "metadata")
      result = manager.metadata(data.sha, data.overrides, data.revision);
    else if (route === "branch")
      result = manager.branchName(data.name, data.branchName, data.revision);
    else if (
      route === "deps" &&
      Array.isArray(data.deps) &&
      data.deps.every((x) => typeof x === "string")
    )
      result = manager.dependencies(data.name, data.deps);
    else if (
      route === "tag" &&
      Array.isArray(data.commits) &&
      data.commits.length &&
      data.commits.every((x) => typeof x === "string")
    )
      result = manager.tag(data.name, data.commits);
    else throw new Error("Unknown operation.");
  }
  process.stdout.write(JSON.stringify(result));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}

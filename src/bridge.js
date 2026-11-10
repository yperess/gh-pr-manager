// A short-lived process keeps Git and gh work out of the VS Code extension host.
import { readPrStatuses } from "./pr-status.js";
import { Manager, run } from "./core.js";
import { operationRequest } from "./requests.js";

let stream = false;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("Request too large.");
  }
  const { route, data, stream: requestedStream } = JSON.parse(input);
  stream =
    requestedStream === true &&
    (["sync", "adopt"].includes(route) ||
      (route === "push" && data?.dryRun === false));
  const manager = new Manager(process.cwd(), undefined, {
    onProgress: (event) => {
      if (stream) emit({ type: "progress", ...event });
    },
  });
  const controller = new AbortController();
  if (route === "push" && data?.wait) {
    process.on("SIGTERM", () => controller.abort());
    process.on("SIGINT", () => controller.abort());
  }
  let result;
  if (route === "graph") result = manager.graph();
  else if (route === "pr-status") result = readPrStatuses(manager);
  else if (typeof route === "string" && route.startsWith("diff?sha=")) {
    const sha = new URLSearchParams(route.slice(5)).get("sha");
    if (!manager.graph().commits.some((c) => c.sha === sha))
      throw new Error("Unknown commit.");
    result = {
      diff: run(
        "git",
        [
          "show",
          "--format=fuller",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          sha,
          "--",
        ],
        manager.root,
        { trimEnd: false },
      ),
    };
  } else {
    if (route !== "push-stop" && data?.revision !== manager.graph().revision)
      throw new Error("The repository changed. Refresh before editing.");
    if (["push", "sync", "adopt", "push-stop"].includes(route))
      result = await operationRequest(manager, route, data, {
        signal: controller.signal,
      });
    else if (route === "metadata")
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
  if (stream) emit({ type: "result", result });
  else process.stdout.write(JSON.stringify(result));
} catch (e) {
  if (stream) emit({ type: "error", error: e.message });
  console.error(e.message);
  process.exitCode = 1;
}

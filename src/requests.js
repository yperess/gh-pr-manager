import { continuousPush, planPushRun, stopPushRun } from "./push-run.js";
import { prepareUiWorktree } from "./ui-worktree.js";

// Both UI transports use the same validation and core push workflow.
export function pushRequest(manager, data, { signal } = {}) {
  if (
    !data ||
    typeof data.revision !== "string" ||
    !data.revision ||
    typeof data.dryRun !== "boolean" ||
    !Array.isArray(data.names) ||
    !data.names.every((name) => typeof name === "string" && name.length > 0)
  )
    throw new Error(
      "Provide a revision, feature names, and an explicit dryRun boolean.",
    );
  if (data.wait !== undefined && typeof data.wait !== "boolean")
    throw new Error("wait must be a boolean.");
  if (data.wait) {
    const options = { names: data.names, expectedRevision: data.revision };
    return data.dryRun
      ? { ...planPushRun(manager, options), continuous: true, dryRun: true }
      : continuousPush(manager, options, {
          signal,
          prepare: prepareUiWorktree,
        });
  }
  return {
    ...manager.push({
      names: data.names,
      dryRun: data.dryRun,
      expectedRevision: data.revision,
    }),
    revision: data.revision,
  };
}

export function operationRequest(manager, route, data, options) {
  if (route === "push") return pushRequest(manager, data, options);
  if (route === "push-stop") {
    if (!data || typeof data.id !== "string" || !data.id)
      throw new Error("Provide a push run ID.");
    return stopPushRun(manager, data.id);
  }
  if (route === "adopt") {
    if (
      !data ||
      typeof data.revision !== "string" ||
      !data.revision ||
      typeof data.name !== "string" ||
      !data.name ||
      !Number.isSafeInteger(data.pr) ||
      data.pr <= 0 ||
      typeof data.head !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(data.head)
    )
      throw new Error(
        "Provide a repository revision, feature name, PR number, and discovered head.",
      );
    return manager.adopt(data.name, data.pr, {
      expectedRevision: data.revision,
      expectedHead: data.head,
    });
  }
  if (
    route !== "sync" ||
    !data ||
    typeof data.revision !== "string" ||
    !data.revision
  )
    throw new Error("Provide a repository revision for sync.");
  return manager.sync({ expectedRevision: data.revision });
}

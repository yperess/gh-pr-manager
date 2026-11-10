import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const runPath = (manager) => path.join(manager.dir, "push-run.json");

export function readPushRun(manager) {
  if (!fs.existsSync(runPath(manager))) return null;
  const run = JSON.parse(fs.readFileSync(runPath(manager), "utf8"));
  const stop = path.join(manager.dir, "push-stop");
  if (fs.existsSync(stop) && fs.readFileSync(stop, "utf8") === run.id)
    run.cancelRequested = true;
  if (run.status === "running") {
    try {
      process.kill(run.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") run.status = "interrupted";
    }
  }
  return run;
}

function save(manager, run) {
  run.updatedAt = new Date().toISOString();
  const temp = `${runPath(manager)}.${randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, runPath(manager));
}

export function assertPushRunOwner(manager) {
  const run = readPushRun(manager);
  if (run?.status === "running" && run.id !== manager.pushRunId)
    throw new Error(
      "A continuous push is running. Stop it before pushing or syncing manually.",
    );
}

export function stopPushRun(manager, id) {
  const run = readPushRun(manager);
  if (!run || run.id !== id)
    throw new Error("This push run is no longer current.");
  if (run.status === "running") {
    // Cancellation must work even while a Git operation holds the repository lock.
    const stop = path.join(manager.dir, "push-stop"),
      temp = `${stop}.${randomUUID()}`;
    fs.writeFileSync(temp, run.id, { mode: 0o600 });
    fs.renameSync(temp, stop);
    run.cancelRequested = true;
  }
  return run;
}

function snapshot(graph, group) {
  return {
    commits: group.commits,
    notes: group.commits.map(
      (sha) => graph.commits.find((c) => c.sha === sha).note,
    ),
    deps: group.deps,
    branch: group.branch,
  };
}

export function planPushRun(manager, { names = [], expectedRevision } = {}) {
  const plan = manager.plan(expectedRevision),
    graph = manager.graph();
  if (expectedRevision && graph.revision !== expectedRevision)
    throw new Error(
      "The repository changed. Refresh and preview the push again.",
    );
  const selected = names.length
    ? [...new Set(names)]
    : graph.groups.map((g) => g.name);
  if (!names.length && plan.unassigned.length)
    throw new Error("Tag all commits before starting a continuous push.");
  const features = selected.map((name) => {
    const group = graph.groups.find((g) => g.name === name);
    if (!group) throw new Error(`Unknown feature ${name}.`);
    return { name, ...snapshot(graph, group), status: "pending" };
  });
  // Already-published prerequisites can be watched without adding them to the
  // user's publication selection. Their current source must match what was pushed.
  const prerequisites = [],
    state = manager.state();
  const seen = new Set(selected);
  const watch = (name) => {
    if (seen.has(name) || Object.hasOwn(graph.merged, name)) return;
    seen.add(name);
    const group = graph.groups.find((g) => g.name === name),
      published = state.features[name];
    if (
      !group ||
      !published?.pr ||
      !Array.isArray(published.publishedCommits) ||
      JSON.stringify(group.commits) !==
        JSON.stringify(published.publishedCommits)
    )
      return;
    prerequisites.push({
      name,
      ...snapshot(graph, group),
      status: "published",
      pr: published.pr,
      url: published.url,
    });
    for (const dep of group.deps) watch(dep);
  };
  for (const entry of features) for (const dep of entry.deps) watch(dep);
  return {
    mode: names.length ? "choose" : "ready",
    features,
    prerequisites,
    revision: graph.revision,
  };
}

function observe(run, graph) {
  const entries = [...run.features, ...(run.prerequisites || [])];
  for (const entry of entries) {
    if (["dropped", "unreachable", "merged"].includes(entry.status)) continue;
    const group = graph.groups.find((g) => g.name === entry.name);
    if (!group && Object.hasOwn(graph.merged, entry.name)) {
      entry.status = "merged";
      continue;
    }
    const previous = {
      commits: entry.commits,
      notes: entry.notes,
      deps: entry.deps,
      branch: entry.branch,
    };
    if (
      !group ||
      JSON.stringify(snapshot(graph, group)) !== JSON.stringify(previous)
    ) {
      entry.status = "dropped";
      entry.reason =
        "Feature commits or notes changed since this push started.";
    }
  }
  const reachable = (name, visiting = new Set()) => {
    const entry = entries.find((f) => f.name === name);
    if (entry && ["dropped", "unreachable"].includes(entry.status))
      return false;
    if (Object.hasOwn(graph.merged, name)) return true;
    if (!entry || visiting.has(name)) return false;
    return entry.deps.every((dep) =>
      reachable(dep, new Set([...visiting, name])),
    );
  };
  for (const entry of run.features) {
    if (entry.status === "pending" && !reachable(entry.name)) {
      entry.status = "unreachable";
      entry.reason =
        "A prerequisite is outside this run or was dropped from it.";
    }
  }
}

function result(manager, run) {
  const state = manager.state();
  return {
    run,
    pushed: run.features
      .filter((f) => f.pr)
      .map((f) => ({
        name: f.name,
        pr: f.pr,
        url: f.url || state.features[f.name]?.url,
      })),
    previews: [],
  };
}

// The sleep releases all Git locks. Each iteration uses the ordinary verified
// sync/push operations; only this run's own sync may remap its commit snapshot.
export async function continuousPush(
  manager,
  options = {},
  { signal, interval = 30000, sleep = delay } = {},
) {
  if (!Number.isFinite(interval) || interval <= 0)
    throw new Error("Invalid polling interval.");
  let run;
  manager.locked(() => {
    if (readPushRun(manager)?.status === "running")
      throw new Error(
        "A continuous push is running. Stop it before starting another.",
      );
    manager.onBranch(manager.state());
    manager.clean();
    const plan = planPushRun(manager, options);
    run = {
      ...plan,
      id: randomUUID(),
      pid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    manager.pushRunId = run.id;
    save(manager, run);
  });
  const emit = () => {
    manager.onProgress?.({
      run: structuredClone(run),
      graph: manager.graph(),
      command: `Continuous push: ${run.status}`,
    });
  };
  const cancelled = () =>
    signal?.aborted || readPushRun(manager)?.cancelRequested;
  const checkpoint = () => {
    if (cancelled())
      throw Object.assign(new Error("Push run stopped."), {
        code: "PUSH_STOPPED",
      });
  };
  const persist = () =>
    manager.locked(
      () => {
        // Do not erase a stop request arriving while Git/gh was running.
        if (readPushRun(manager)?.cancelRequested) run.cancelRequested = true;
        save(manager, run);
      },
      { recovery: true },
    );
  try {
    emit();
    while (true) {
      checkpoint();
      let graph = manager.graph();
      manager.onBranch(manager.state());
      observe(run, graph);
      const pending = run.features.filter((f) => f.status === "pending");
      if (!pending.length) {
        run.status = run.features.some((f) =>
          ["dropped", "unreachable"].includes(f.status),
        )
          ? "blocked"
          : "completed";
        break;
      }
      persist();
      emit();
      // Editing is expected during a long run. Never stash or sync a dirty tree.
      let clean = true;
      try {
        manager.clean();
      } catch {
        clean = false;
      }
      if (clean) {
        const active = [...run.features, ...run.prerequisites]
          .filter((f) => ["pending", "published"].includes(f.status))
          .map((f) => f.name);
        const synced = manager.sync({
          expectedRevision: graph.revision,
          featureNames: active,
          onPrStatus: (name, pr) => {
            if (pr.state === "CLOSED") {
              const entry = [...run.features, ...run.prerequisites].find(
                (f) => f.name === name,
              );
              if (entry) {
                entry.status = "dropped";
                entry.reason = `PR #${pr.number} was closed without merging.`;
              }
            }
          },
        });
        const queue = graph.commits.filter(
          (c) => !synced.merged.includes(c.name),
        );
        const mapping = new Map(
          queue.map((c, i) => [c.sha, synced.remaining[i]]),
        );
        for (const entry of [...run.features, ...run.prerequisites])
          entry.commits = entry.commits.map((sha) => mapping.get(sha) || sha);
        graph = manager.graph();
        observe(run, graph);
        checkpoint();
        const ready = run.features.filter(
          (f) =>
            f.status === "pending" &&
            graph.groups.find((g) => g.name === f.name)?.ready,
        );
        if (ready.length) {
          let pushed;
          try {
            pushed = manager.push({
              names: ready.map((f) => f.name),
              expectedRevision: graph.revision,
              beforePublish: (group) => {
                checkpoint();
                const current = manager.graph(),
                  entry = run.features.find((f) => f.name === group.name);
                observe(run, current);
                const actual = current.groups.find(
                  (g) => g.name === group.name,
                );
                if (
                  entry.status !== "pending" ||
                  !actual ||
                  JSON.stringify(snapshot(current, actual)) !==
                    JSON.stringify({
                      commits: entry.commits,
                      notes: entry.notes,
                      deps: entry.deps,
                      branch: entry.branch,
                    })
                )
                  throw Object.assign(
                    new Error("Feature changed before publication."),
                    { code: "PUSH_CHANGED" },
                  );
                try {
                  manager.clean();
                } catch (error) {
                  error.code = "PUSH_DIRTY";
                  throw error;
                }
              },
            });
          } catch (error) {
            if (!["PUSH_CHANGED", "PUSH_DIRTY"].includes(error.code))
              throw error;
            observe(run, manager.graph());
            persist();
            continue;
          }
          for (const item of pushed.pushed)
            Object.assign(
              run.features.find((f) => f.name === item.name),
              { status: "published", pr: item.pr, url: item.url },
            );
        }
      } else
        run.message = "Working tree is dirty; waiting for a clean checkout.";
      if (clean) delete run.message;
      persist();
      emit();
      if (!run.features.some((f) => f.status === "pending")) continue;
      // Check cancellation at least once a second, without holding Git locks.
      for (let remaining = interval; remaining > 0; remaining -= 1000) {
        checkpoint();
        await sleep(Math.min(1000, remaining), undefined, { signal });
      }
    }
  } catch (error) {
    run.status =
      signal?.aborted || error.code === "PUSH_STOPPED" ? "cancelled" : "failed";
    run.error = run.status === "failed" ? error.message : undefined;
    if (run.status === "failed") throw error;
  } finally {
    persist();
    emit();
    delete manager.pushRunId;
  }
  return result(manager, run);
}

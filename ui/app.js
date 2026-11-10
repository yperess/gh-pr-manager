/* Shared by the browser app and the VS Code webview; all repository text uses textContent. */
const vscode =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
const token =
  new URLSearchParams(location.hash.slice(1)).get("token") ||
  sessionStorage.getItem("prm-token");
if (token) {
  sessionStorage.setItem("prm-token", token);
  history.replaceState(null, "", location.pathname);
}
const $ = (id) => document.getElementById(id);
const colors = [
  "#93b7ff",
  "#c7a7ff",
  "#7bd4c5",
  "#f0bb83",
  "#e8a5d2",
  "#c5d888",
];
let graph, selectedFeature, selectedCommit;
let historyFeature = null;
let prStatuses = new Map(),
  statusGeneration = 0;
let inspectorMode = "feature";
const featureMetadataEdits = new Set();
const selectedCommits = new Set();
const pending = new Map();
let requestId = 0;
let pushPlan = null,
  publishing = false,
  backgroundPush = false;
const pushFeatures = new Set();
let pushMode = "ready",
  adoptingFeature = null;
const adoptionErrors = new Map();

let savedDiffMode = "unified";
try {
  savedDiffMode =
    vscode?.getState?.()?.diffMode ??
    sessionStorage.getItem("prm-diff-mode") ??
    "unified";
} catch {
  /* Default layout remains available without storage. */
}
const diffViewer = PrmDiff.createViewer(document, $("diff"), {
  mode: savedDiffMode,
});
let diffRequestVersion = 0;
let diffFeature = null,
  featureDiffKey = null;
function updateDiffControls() {
  $("diff-unified").setAttribute(
    "aria-pressed",
    String(diffViewer.mode === "unified"),
  );
  $("diff-split").setAttribute(
    "aria-pressed",
    String(diffViewer.mode === "split"),
  );
  $("diff-expand").disabled = $("diff-collapse").disabled =
    !diffViewer.hasFiles;
}
function diffMessage(message) {
  diffViewer.setMessage(message);
  updateDiffControls();
}
for (const mode of ["unified", "split"])
  $(`diff-${mode}`).addEventListener("click", () => {
    diffViewer.setMode(mode);
    updateDiffControls();
    try {
      if (vscode?.setState)
        vscode.setState({ ...vscode.getState?.(), diffMode: mode });
      else sessionStorage.setItem("prm-diff-mode", mode);
    } catch {
      /* The viewer still works without persistence. */
    }
  });
$("diff-expand").addEventListener("click", () => diffViewer.setExpanded(true));
$("diff-collapse").addEventListener("click", () =>
  diffViewer.setExpanded(false),
);
updateDiffControls();

window.addEventListener("message", (event) => {
  if (!vscode || !event.data?.id) return;
  const p = pending.get(event.data.id);
  if (!p) return;
  if (event.data.progress) {
    p.onProgress?.(event.data.progress);
    return;
  }
  clearTimeout(p.timeout);
  pending.delete(event.data.id);
  if (event.data.error) p.reject(new Error(event.data.error));
  else p.resolve(event.data.result);
});
async function api(route, data, onProgress) {
  if (
    publishing &&
    !backgroundPush &&
    data &&
    !["push", "sync", "adopt", "push-stop", "feature-diff"].includes(route)
  )
    throw new Error("Wait for the operation to finish before editing.");
  if (vscode)
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timeout =
        ["sync", "adopt", "feature-diff"].includes(route) ||
        (route === "push" && data?.dryRun === false)
          ? null
          : setTimeout(() => {
              pending.delete(id);
              reject(new Error("Extension request timed out."));
            }, 30000);
      pending.set(id, { resolve, reject, timeout, onProgress });
      vscode.postMessage({ id, route, data });
    });
  const result = await fetch(`/api/${route}`, {
    method: data ? "POST" : "GET",
    headers: { "X-PRM-Token": token || "", "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (result.headers?.get("content-type")?.includes("application/x-ndjson")) {
    const reader = result.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      value,
      failure;
    const consume = (line) => {
      if (!line) return;
      const event = JSON.parse(line);
      if (event.type === "progress") onProgress?.(event);
      else if (event.type === "result") value = event.result;
      else if (event.type === "error") failure = new Error(event.error);
    };
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        buffer += decoder.decode(chunk, { stream: !done });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          consume(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (done) break;
      }
      if (buffer) consume(buffer);
    } finally {
      reader.releaseLock();
    }
    if (failure) throw failure;
    if (value === undefined)
      throw new Error(
        "Operation ended without a result. Refresh before retrying.",
      );
    return value;
  }
  const body = await result.json();
  if (!result.ok) throw new Error(body.error);
  return body;
}
function error(e) {
  $("error").textContent = e.message;
  $("error").hidden = false;
}
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function svg(tag, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}
function color(name) {
  return colors[
    Math.max(
      0,
      graph.groups.findIndex((g) => g.name === name),
    ) % colors.length
  ];
}
function prInfo(g) {
  return prStatuses.get(g.name);
}
function prSignals(g) {
  const pr = prInfo(g);
  if (!pr) return "";
  if (pr.error) return "PR status unavailable";
  if (!pr.pr) return "";
  if (pr.state !== "OPEN")
    return pr.state === "MERGED" ? "Merged · sync needed" : "PR closed";
  const signals = [];
  if (pr.ci === "FAILING") signals.push("CI failing");
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    signals.push("Changes requested");
  if (pr.unresolvedThreads)
    signals.push(
      `${pr.unresolvedThreads} open thread${pr.unresolvedThreads === 1 ? "" : "s"}`,
    );
  if (!signals.length)
    signals.push(
      pr.ci === "PENDING"
        ? "CI pending"
        : pr.ci === "PASSING"
          ? "CI passing"
          : "CI unknown / no checks",
    );
  return signals.join(" · ");
}
function status(g) {
  const pr = prInfo(g),
    number = pr?.pr || g.pr;
  return g.status === "MERGED"
    ? "Merged"
    : pr?.state === "MERGED"
      ? "Merged · sync needed"
      : pr?.state === "CLOSED"
        ? `Closed · #${number}`
        : number
          ? `${pr?.draft ? "Draft" : "In review"} · #${number}`
          : g.blockedBy.length
            ? `Waiting for ${g.blockedBy.join(", ")}`
            : "Ready to publish";
}
function renderPrDetails(group) {
  const pr = prInfo(group),
    link = $("pr-link");
  const url = pr?.url || group.url;
  const safeUrl = typeof url === "string" && /^https?:\/\//.test(url);
  link.hidden = !safeUrl;
  if (safeUrl) link.href = url;
  else link.removeAttribute("href");
  link.textContent = `Open pull request${pr?.pr || group.pr ? ` #${pr?.pr || group.pr}` : ""} ↗`;
  $("feature-state").textContent = status(group);
  $("pr-tracking").textContent = group.pr
    ? `Tracking PR #${group.pr}`
    : pr?.pr
      ? `PR #${pr.pr} found · Not tracked`
      : "No PR tracked";
  const button = $("adopt-pr");
  button.hidden = !!group.pr || !pr?.pr || pr.state !== "OPEN" || !!pr.error;
  button.disabled = publishing || !group.ready || graph.paused;
  button.title = !group.ready
    ? "Merge prerequisites before adopting this PR."
    : "Track this PR without pushing its branch.";
  button.textContent =
    adoptingFeature === group.name ? "Adopting…" : "Adopt PR";
  $("adopt-progress").hidden = adoptingFeature !== group.name;
  $("adopt-error").hidden = !adoptionErrors.has(group.name);
  $("adopt-error").textContent = adoptionErrors.get(group.name) || "";
  const details = $("pr-details");
  details.replaceChildren();
  if (!pr) details.append(element("li", "Checking PR status…", "muted"));
  else if (pr.error)
    details.append(
      element("li", `PR status unavailable: ${pr.error}`, "muted"),
    );
  else if (pr.pr) {
    details.append(
      element(
        "li",
        `CI: ${{ FAILING: "failing", PENDING: "pending", PASSING: "passing", UNKNOWN: "unknown / no checks reported" }[pr.ci]}`,
      ),
    );
    details.append(
      element(
        "li",
        `Review: ${{ CHANGES_REQUESTED: "changes requested", APPROVED: "approved", REVIEW_REQUIRED: "required" }[pr.reviewDecision] || "no decision reported"}`,
      ),
    );
    details.append(
      element(
        "li",
        `${pr.unresolvedThreads} unresolved review thread${pr.unresolvedThreads === 1 ? "" : "s"}`,
      ),
    );
  } else details.append(element("li", "No matching PR found.", "muted"));
  details.classList.toggle("needs-attention", !!pr?.actionable);
}
$("adopt-pr").addEventListener("click", async () => {
  if (publishing || !graph || inspectorMode !== "feature") return;
  const group = graph.groups.find((g) => g.name === selectedFeature),
    pr = group && prInfo(group);
  if (
    !group ||
    group.pr ||
    !group.ready ||
    graph.paused ||
    !pr?.pr ||
    pr.error ||
    pr.state !== "OPEN"
  )
    return;
  const name = group.name;
  adoptionErrors.delete(name);
  adoptingFeature = name;
  clearPushPlan();
  pushBusy(true);
  renderPrDetails(group);
  try {
    const result = await api("adopt", {
      name,
      pr: pr.pr,
      head: pr.head,
      revision: graph.revision,
    });
    graph = result.graph;
    ++statusGeneration; // Discard any snapshot taken before adoption changed state.
    renderGraph();
    renderPushFeatures();
    $("notice").textContent = `Tracking PR #${result.pr} for ${name}.`;
    void refreshPrStatuses(statusGeneration, graph.revision);
  } catch (e) {
    adoptionErrors.set(name, e.message);
  } finally {
    adoptingFeature = null;
    pushBusy(false);
    if (inspectorMode === "feature") {
      const current = graph.groups.find((g) => g.name === selectedFeature);
      if (current) renderPrDetails(current);
    }
  }
});
async function refreshPrStatuses(generation, revision) {
  try {
    const result = await api("pr-status");
    if (generation !== statusGeneration) return;
    if (result.revision !== revision || graph.revision !== revision)
      throw new Error(
        "Repository changed during status refresh. Refresh again.",
      );
    prStatuses = new Map(result.features.map((pr) => [pr.name, pr]));
    const failures = result.features.filter((pr) => pr.error).length;
    const actions = result.features.filter((pr) => pr.actionable).length;
    $("pr-status-summary").textContent =
      `${actions} feature${actions === 1 ? "" : "s"} need attention · PR status checked ${new Date(result.checkedAt).toLocaleTimeString()}${failures ? ` · ${failures} unavailable` : ""}`;
  } catch (e) {
    if (generation !== statusGeneration) return;
    prStatuses = new Map(
      graph.groups.map((g) => [g.name, { error: e.message }]),
    );
    $("pr-status-summary").textContent = `PR status unavailable: ${e.message}`;
  }
  renderGraph();
  if (inspectorMode === "feature" && selectedFeature) {
    const group = graph.groups.find((g) => g.name === selectedFeature);
    if (group) renderPrDetails(group);
  }
}
function renderGraph() {
  const root = $("graph");
  root.replaceChildren();
  const groups = [
    ...Object.entries(graph.merged).map(([name, value]) => ({
      name,
      deps: [],
      commits: [],
      pr: value.pr,
      status: "MERGED",
      blockedBy: [],
    })),
    ...graph.groups,
  ];
  const nodes = new Map(groups.map((g) => [g.name, g]));
  for (const g of groups)
    for (const d of g.deps)
      if (!nodes.has(d))
        nodes.set(d, {
          name: d,
          deps: [],
          commits: [],
          status: "UNKNOWN",
          blockedBy: [],
        });
  const depths = new Map();
  const visiting = new Set();
  function depth(name) {
    if (depths.has(name)) return depths.get(name);
    if (visiting.has(name)) return 0; // Display invalid manually edited notes; saves still validate cycles.
    visiting.add(name);
    const g = nodes.get(name);
    const d = g.deps.length ? 1 + Math.max(...g.deps.map(depth)) : 0;
    visiting.delete(name);
    depths.set(name, d);
    return d;
  }
  const lanes = new Map(),
    positions = new Map();
  for (const name of nodes.keys()) {
    const d = depth(name);
    const n = lanes.get(d) || 0;
    positions.set(name, { x: 30 + d * 270, y: 25 + n * 125 });
    lanes.set(d, n + 1);
  }
  const width = Math.max(600, (Math.max(0, ...lanes.keys()) + 1) * 270 + 40);
  const height = Math.max(210, Math.max(0, ...lanes.values()) * 125 + 30);
  root.setAttribute("width", width);
  root.setAttribute("height", height);
  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const defs = svg("defs", {}),
    marker = svg("marker", {
      id: "arrow",
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: "auto-start-reverse",
    });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#647695" }));
  defs.append(marker);
  root.append(defs);
  for (const g of nodes.values())
    for (const dep of g.deps) {
      const a = positions.get(dep),
        b = positions.get(g.name),
        x = a.x + 220,
        y = a.y + 37;
      root.append(
        svg("path", {
          d: `M${x},${y} C${x + 25},${y} ${b.x - 25},${b.y + 37} ${b.x},${b.y + 37}`,
          class: "dependency-edge",
          "marker-end": "url(#arrow)",
        }),
      );
    }
  for (const g of nodes.values()) {
    const p = positions.get(g.name),
      card = svg("g", {
        transform: `translate(${p.x} ${p.y})`,
        class: `feature-card ${graph.pushRun?.status === "running" && graph.pushRun.features.some((f) => f.name === g.name && f.status === "pending") ? "push-pending" : ""} ${prInfo(g)?.actionable ? "needs-attention" : ""} ${selectedFeature === g.name ? "selected" : ""}`,
        tabindex: 0,
        role: "button",
        "aria-label": `${g.name}: ${status(g)}. ${prSignals(g)}`,
      });
    card.append(svg("rect", { width: 220, height: 94, rx: 9 }));
    card.append(
      svg("circle", {
        cx: 16,
        cy: 23,
        r: 4,
        fill:
          g.status === "MERGED"
            ? "#85d5ae"
            : g.blockedBy.length
              ? "#f2c778"
              : prInfo(g)?.pr || g.pr
                ? "#c7a7ff"
                : "#8eb4ff",
      }),
    );
    const title = svg(
      "text",
      { x: 29, y: 28, "font-size": 13 },
      g.name.length > 23 ? `${g.name.slice(0, 22)}…` : g.name,
    );
    title.append(svg("title", {}, g.name));
    card.append(title);
    card.append(
      svg(
        "text",
        { x: 15, y: 54, class: "card-meta" },
        g.status === "MERGED"
          ? "Merged"
          : `${g.commits.length} commits · ${prInfo(g)?.pr || g.pr ? `PR #${prInfo(g)?.pr || g.pr}` : g.blockedBy.length ? "Waiting" : "Ready"}`,
      ),
    );
    const runEntry = graph.pushRun?.features.find((f) => f.name === g.name);
    const signal =
      runEntry && graph.pushRun.status === "running"
        ? `Push: ${runEntry.status}`
        : prSignals(g);
    const signalText = svg(
      "text",
      { x: 15, y: 77, class: "card-meta" },
      signal.length > 29 ? `${signal.slice(0, 28)}…` : signal,
    );
    signalText.append(svg("title", {}, signal));
    card.append(signalText);
    card.addEventListener("click", () => filterFeatureHistory(g.name));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        filterFeatureHistory(g.name);
      }
    });
    root.append(card);
  }
  $("empty").hidden = nodes.size > 0;
}
function filterFeatureHistory(name) {
  historyFeature = name;
  openFeature(name);
}
function clearFeatureHistory() {
  historyFeature = null;
  selectedFeature = undefined;
  resetDiffSelection();
  inspectorMode = "feature";
  $("metadata-panel").hidden = true;
  $("inspector").hidden = true;
  $("inspector-title").textContent = "Manage a feature";
  $("inspector-hint").hidden = false;
  $("inspector-hint").textContent =
    "Select a feature in the graph to edit its dependencies.";
  renderGraph();
  renderCommits();
}
$("graph-wrap").addEventListener("click", (event) => {
  if (!event.target.closest(".feature-card")) clearFeatureHistory();
});
$("graph-wrap").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    clearFeatureHistory();
  }
});
function renderCommits() {
  if (
    historyFeature &&
    !graph.groups.some(
      (g) => g.name === historyFeature || g.deps.includes(historyFeature),
    ) &&
    !Object.hasOwn(graph.merged, historyFeature)
  )
    historyFeature = null;
  const commits = historyFeature
    ? graph.commits.filter((c) => c.name === historyFeature)
    : graph.commits;
  if (selectedCommit && !commits.some((c) => c.sha === selectedCommit)) {
    resetDiffSelection();
    inspectorMode = "feature";
    $("metadata-panel").hidden = true;
    diffFeature = selectedFeature || null;
  }
  if (diffFeature) void loadFeatureDiff(diffFeature);
  $("history-context").textContent = historyFeature
    ? `${historyFeature} · ${commits.length} of ${graph.commits.length} commits · Click empty canvas or press Escape to show all`
    : "Oldest first · colors connect commits to their PR group";
  $("history-empty").hidden = commits.length !== 0;
  $("history-empty").textContent = historyFeature
    ? `No active commits in ${historyFeature}. Click empty canvas to show all commits.`
    : "No commits to show.";
  $("commits").replaceChildren();
  for (const c of commits) {
    const row = element("tr"),
      checkCell = element("td"),
      check = element("input");
    check.type = "checkbox";
    check.checked = selectedCommits.has(c.sha);
    check.setAttribute("aria-label", `Select ${c.sha.slice(0, 7)}`);
    check.addEventListener("change", () => {
      if (check.checked) selectedCommits.add(c.sha);
      else selectedCommits.delete(c.sha);
      updateSelected();
    });
    checkCell.append(check);
    row.dataset.sha = c.sha;
    row.classList.toggle("selected", c.sha === selectedCommit);
    row.addEventListener("click", (event) => {
      if (!event.target.closest("button, input")) openCommit(c.sha);
    });
    row.append(checkCell);
    row.append(element("td", c.sha.slice(0, 7)));
    const messageCell = element("td"),
      button = element("button", c.subject, "commit-message");
    button.addEventListener("click", () => openCommit(c.sha));
    messageCell.append(button);
    row.append(messageCell);
    const featureCell = element("td"),
      dot = element("span", undefined, "group-dot");
    dot.style.background = c.name ? color(c.name) : "#647086";
    featureCell.append(dot);
    if (c.name) {
      const b = element("button", c.name, "feature-label");
      b.addEventListener("click", () => openFeature(c.name));
      featureCell.append(b);
    } else featureCell.append(element("span", "Unassigned", "muted"));
    row.append(featureCell);
    const fields = [
      c.title != null && "Title",
      c.description != null && "Description",
    ].filter(Boolean);
    const metadataCell = element("td");
    const metadataButton = element(
      "button",
      fields.length ? `${fields.join(" + ")} override` : "Inherited",
      "feature-label",
    );
    metadataButton.addEventListener("click", () => button.click());
    metadataCell.append(metadataButton);
    row.append(metadataCell);
    $("commits").append(row);
  }
}
function updateSelected() {
  $("tag-button").textContent =
    `Assign ${selectedCommits.size || "selected"} commit${selectedCommits.size === 1 ? "" : "s"}`;
}
function resetDiffSelection() {
  selectedCommit = null;
  diffFeature = null;
  featureDiffKey = null;
  ++diffRequestVersion;
  $("diff-title").textContent = "Commit details";
  diffMessage("Select a feature or commit to see its diff.");
}
function openFeature(name) {
  selectedCommit = null;
  diffFeature = name;
  selectFeature(name, true);
  renderCommits();
}
async function loadFeatureDiff(name) {
  const group = graph.groups.find((g) => g.name === name);
  const revision = graph.revision,
    key = `${name}:${revision}`;
  if (featureDiffKey === key) return;
  featureDiffKey = key;
  const request = ++diffRequestVersion;
  $("diff-title").textContent =
    `Feature: ${name}${group ? ` · ${group.commits.length} commit${group.commits.length === 1 ? "" : "s"}` : ""}`;
  if (!group) {
    diffMessage("This feature has no active commits.");
    return;
  }
  diffMessage("Loading feature patch…");
  const current = () =>
    diffFeature === name &&
    !selectedCommit &&
    request === diffRequestVersion &&
    graph.revision === revision;
  try {
    const result = await api("feature-diff", { name, revision });
    if (!current()) return;
    if (result.diff) {
      diffViewer.setPatch(result.diff);
      updateDiffControls();
    } else diffMessage("No net changes in this feature.");
  } catch (error) {
    if (!current()) return;
    featureDiffKey = null;
    diffMessage(`Could not load feature patch: ${error.message}`);
  }
}
function selectFeature(name, reveal = false) {
  inspectorMode = "feature";
  selectedFeature = name;
  $("metadata-panel").hidden = true;
  renderGraph();
  const group = graph.groups.find((g) => g.name === name);
  $("inspector-title").textContent = name;
  $("inspector-hint").hidden = !!group;
  $("inspector").hidden = !group;
  if (!group) {
    $("inspector-hint").textContent =
      "This feature has merged. Its dependents can now be published.";
    return;
  }
  $("feature-name").value = name;
  $("feature-state").textContent = status(group);
  $("feature-branch").textContent = group.branch ?? `prm/${group.name}`;
  $("branch-name").value = group.branchName ?? "";
  featureMetadataEdits.clear();
  $("feature-title").value = group.title ?? group.name;
  $("feature-title-source").textContent = metadataSource(
    group.titleSource,
    "title",
  );
  $("feature-description").value = group.description ?? "";
  $("feature-metadata-target").textContent =
    `Saves to the latest commit for this feature: ${group.commits.at(-1).slice(0, 7)}.`;
  $("feature-description-source").textContent = metadataSource(
    group.descriptionSource,
    "description",
  );
  renderPrDetails(group);
  $("deps-options").replaceChildren();
  for (const other of [
    ...graph.groups.map((g) => g.name),
    ...Object.keys(graph.merged),
  ].filter((n) => n !== name)) {
    const label = element("label", undefined, "dependency-option"),
      check = element("input");
    check.type = "checkbox";
    check.value = other;
    check.checked = group.deps.includes(other);
    label.append(check, document.createTextNode(other));
    $("deps-options").append(label);
  }
  if (!$("deps-options").children.length)
    $("deps-options").append(element("p", "No other features yet.", "muted"));
  if (reveal) $("inspector-sidebar").scrollTo?.({ top: 0 });
}
for (const field of ["title", "description"])
  $(`feature-${field}`).addEventListener("input", () =>
    featureMetadataEdits.add(field),
  );
$("feature-metadata-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const group = graph.groups.find((g) => g.name === selectedFeature);
    if (!group) throw new Error("Select a feature first.");
    const overrides = {};
    for (const field of ["title", "description"]) {
      const value = $(`feature-${field}`).value;
      if (
        featureMetadataEdits.has(field) ||
        value !== (group[field] ?? (field === "title" ? group.name : ""))
      )
        overrides[field] = value;
    }
    if (!Object.keys(overrides).length) {
      $("notice").textContent = "No feature metadata changes to save.";
      return;
    }
    $("notice").textContent = "Saving feature metadata…";
    await api("metadata", {
      sha: group.commits.at(-1),
      overrides,
      revision: graph.revision,
    });
    await refresh();
    $("notice").textContent =
      `Feature metadata saved to ${group.commits.at(-1).slice(0, 7)}.`;
  } catch (e) {
    error(e);
  }
});
$("show-feature").addEventListener("click", () => {
  const commit = graph.commits.find((c) => c.sha === selectedCommit);
  if (commit?.name) openFeature(commit.name);
});
$("branch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    $("notice").textContent = "Saving branch name…";
    await api("branch", {
      name: selectedFeature,
      branchName: $("branch-name").value || null,
      revision: graph.revision,
    });
    await refresh();
    $("notice").textContent = "Branch name saved to notes.";
  } catch (e) {
    error(e);
  }
});
function metadataSource(sha, field) {
  return sha
    ? `From commit ${sha.slice(0, 7)}`
    : field === "title"
      ? "Default: feature name"
      : "Default: generated description";
}
function metadataBefore(commit) {
  const state = {
    title: commit.name,
    description: null,
    titleSource: null,
    descriptionSource: null,
  };
  for (const earlier of graph.commits) {
    if (earlier.sha === commit.sha) break;
    if (earlier.name !== commit.name) continue;
    for (const field of ["title", "description"])
      if (earlier[field] != null) {
        state[field] = earlier[field];
        state[`${field}Source`] = earlier.sha;
      }
  }
  return state;
}
function selectCommit(sha) {
  if (selectedCommit !== sha) {
    ++diffRequestVersion;
    diffMessage("Select the commit message to load its patch.");
  }
  selectedCommit = sha;
  const commit = graph.commits.find((c) => c.sha === sha);
  if (commit?.name) selectFeature(commit.name);
  inspectorMode = "commit";
  $("inspector").hidden = true;
  $("inspector-hint").hidden = true;
  $("metadata-panel").hidden = !commit;
  if (!commit) return;
  $("inspector-title").textContent = `Commit ${sha.slice(0, 7)}`;
  $("commit-subject").textContent = commit.subject;
  $("show-feature").hidden = !commit.name;
  $("diff-title").textContent = `${sha.slice(0, 7)} · ${commit.subject}`;
  for (const row of $("commits").children)
    row.classList.toggle("selected", row.dataset.sha === sha);
  $("metadata-context").textContent = commit.name
    ? `${commit.name} · ${sha.slice(0, 7)} · values after this commit, before later overrides`
    : "Assign this commit to a feature to edit its PR metadata.";
  $("metadata-fields").disabled = !commit.name;
  const inherited = metadataBefore(commit);
  for (const field of ["title", "description"]) {
    const override = commit[field] != null;
    $(`${field}-override`).checked = override;
    $(`metadata-${field}`).disabled = !override;
    $(`metadata-${field}`).value =
      (override ? commit[field] : inherited[field]) ?? "";
    $(`${field}-source`).textContent =
      `${override ? "Explicit override at this commit. " : "Inherited. "}${metadataSource(override ? commit.sha : inherited[`${field}Source`], field)}`;
  }
}
async function openCommit(sha) {
  diffFeature = null;
  featureDiffKey = null;
  selectCommit(sha);
  $("inspector-sidebar").scrollTo?.({ top: 0 });
  const request = ++diffRequestVersion;
  diffMessage("Loading patch…");
  try {
    const result = await api(`diff?sha=${sha}`);
    if (selectedCommit === sha && request === diffRequestVersion) {
      diffViewer.setPatch(result.diff);
      updateDiffControls();
    }
  } catch (e) {
    if (selectedCommit === sha && request === diffRequestVersion) {
      diffMessage(`Could not load patch: ${e.message}`);
      error(e);
    }
  }
}
for (const field of ["title", "description"]) {
  $(`${field}-override`).addEventListener("change", () => {
    const commit = graph.commits.find((c) => c.sha === selectedCommit);
    if (!commit) return;
    const override = $(`${field}-override`).checked;
    const inherited = metadataBefore(commit);
    $(`metadata-${field}`).disabled = !override;
    if (!override) $(`metadata-${field}`).value = inherited[field] ?? "";
    $(`${field}-source`).textContent =
      `${override ? "Override will be saved on this commit. " : "Inherited. "}${metadataSource(override ? commit.sha : inherited[`${field}Source`], field)}`;
  });
}
async function refresh() {
  if (diffFeature) featureDiffKey = null;
  const generation = ++statusGeneration;
  try {
    const nextGraph = await api("graph");
    if (generation !== statusGeneration) return;
    graph = nextGraph;
    renderPushRun(graph.pushRun);
    prStatuses.clear();
    $("pr-status-summary").textContent = "Checking PR status…";
    renderPushFeatures();
    $("error").hidden = true;
    $("repository").textContent = graph.repo.replace(/^https?:\/\//, "");
    $("branch").textContent = `${graph.branch} → ${graph.base}`;
    $("counts").textContent =
      `${graph.groups.filter((g) => g.ready).length} ready · ${graph.groups.filter((g) => !g.ready).length} waiting`;
    const active = new Set(graph.commits.map((c) => c.sha));
    for (const sha of selectedCommits)
      if (!active.has(sha)) selectedCommits.delete(sha);
    renderGraph();
    renderCommits();
    updateSelected();
    if (inspectorMode === "commit" && selectedCommit)
      selectCommit(selectedCommit);
    else if (selectedFeature) selectFeature(selectedFeature);
    $("notice").textContent = graph.paused
      ? "Sync is paused. Resolve or abort in the terminal."
      : `${graph.commits.length} commits · ${graph.groups.length} active features · refreshed ${new Date().toLocaleTimeString()}`;
    void refreshPrStatuses(generation, graph.revision);
  } catch (e) {
    error(e);
  }
}
$("refresh").addEventListener("click", refresh);
function openDialog(id) {
  const dialog = $(id);
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute("open", "");
}
for (const kind of ["push", "sync"]) {
  $(`close-${kind}`).addEventListener("click", () => {
    if (publishing && !(kind === "push" && backgroundPush)) return;
    const dialog = $(`${kind}-dialog`);
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
  });
  $(`${kind}-dialog`).addEventListener("cancel", (event) => {
    if (publishing && !(kind === "push" && backgroundPush))
      event.preventDefault();
  });
}
function renderPushRun(run, nextGraph) {
  if (nextGraph) {
    graph = nextGraph;
    ++statusGeneration;
    renderGraph();
    renderCommits();
  }
  const workspace = graph.uiWorktree;
  $("workspace-info").hidden = !workspace;
  $("workspace-info").textContent = workspace
    ? `Managed checkout: ${workspace.path}. Your original workspace is free for other branches. This checkout is retained after the run finishes.`
    : "";
  if (!run) {
    $("push-run-banner").hidden = true;
    return;
  }
  graph.pushRun = run;
  $("push-run-banner").hidden = false;
  const counts = new Map();
  for (const entry of run.features)
    counts.set(entry.status, (counts.get(entry.status) || 0) + 1);
  $("push-run-summary").textContent =
    `Push run ${run.status}${run.worktree ? ` in ${run.worktree}` : ""}: ${[...counts].map(([state, count]) => `${count} ${state}`).join(" · ")}${run.message || run.error ? ` · ${run.message || run.error}` : ""}`;
  $("push-run-features").hidden = false;
  $("push-run-features").replaceChildren(
    ...[
      ...run.features,
      ...(run.prerequisites || []).map((entry) => ({
        ...entry,
        name: `${entry.name} (watching existing PR)`,
      })),
    ].map((entry) =>
      element(
        "li",
        `${entry.name}: ${entry.status}${entry.pr ? ` · PR #${entry.pr}` : ""}${entry.reason ? ` · ${entry.reason}` : ""}`,
      ),
    ),
  );
  for (const id of ["stop-push", "stop-push-run"]) {
    $(id).hidden = run.status !== "running";
    $(id).disabled = !!run.cancelRequested;
    $(id).textContent = run.cancelRequested ? "Stopping…" : "Stop push run";
  }
  if (run.status === "running") {
    $("push-progress").textContent =
      run.message || "Waiting for merges and publishing ready features…";
    $("open-push").disabled = true;
    $("open-sync").disabled = true;
  }
}
async function stopContinuousPush() {
  if (!graph?.pushRun || graph.pushRun.status !== "running") return;
  try {
    renderPushRun(await api("push-stop", { id: graph.pushRun.id }));
  } catch (e) {
    error(e);
  }
}
$("stop-push").addEventListener("click", stopContinuousPush);
$("stop-push-run").addEventListener("click", stopContinuousPush);
$("view-push-run").addEventListener("click", () => {
  if (!publishing || backgroundPush) openDialog("push-dialog");
});
$("push-wait").addEventListener("change", () => {
  clearPushPlan();
  $("push-wait-help").hidden = !$("push-wait").checked;
  $("push-choice-help").textContent = $("push-wait").checked
    ? "Only selected features are included. Missing prerequisites can make features unreachable."
    : "A waiting feature pushes the full working history as a preview branch, without a PR.";
  renderPushFeatures();
});
function selectedPushNames() {
  return pushMode === "ready" ? [] : [...pushFeatures];
}
function updatePushControls() {
  $("preview-push").disabled =
    publishing ||
    !graph?.groups.length ||
    graph.paused ||
    (pushMode === "choose" && !pushFeatures.size);
}
function setPushMode(mode) {
  pushMode = mode;
  $("push-ready").setAttribute("aria-pressed", String(mode === "ready"));
  $("push-choose").setAttribute("aria-pressed", String(mode === "choose"));
  $("push-choice").hidden = mode !== "choose";
  clearPushPlan();
  updatePushControls();
}
$("push-ready").addEventListener("click", () => {
  if (!publishing) setPushMode("ready");
});
$("push-choose").addEventListener("click", () => {
  if (!publishing) setPushMode("choose");
});
$("open-push").addEventListener("click", () => {
  if (!graph || publishing || graph.pushRun?.status === "running") return;
  pushFeatures.clear();
  renderPushFeatures();
  setPushMode("ready");
  $("push-result").hidden = true;
  $("push-error").hidden = true;
  $("push-log").hidden = true;
  $("push-log").textContent = "";
  $("push-run-features").hidden = true;
  openDialog("push-dialog");
});
function logCommand(kind, event) {
  if (event.run) {
    renderPushRun(event.run, event.graph);
    return;
  }
  const log = $(`${kind}-log`);
  log.hidden = false;
  log.textContent += `$ ${event.command}\n`;
  log.scrollTop = log.scrollHeight;
}
$("open-sync").addEventListener("click", async () => {
  if (!graph || publishing || graph.pushRun?.status === "running") return;
  $("sync-log").textContent = "";
  $("sync-error").hidden = true;
  $("sync-result").hidden = true;
  $("sync-target").textContent =
    `${graph.branch} → ${graph.remote || "origin"}/${graph.base}`;
  $("sync-progress").textContent =
    "Syncing: fetching the base, checking PRs, and rebasing remaining commits…";
  openDialog("sync-dialog");
  pushBusy(true);
  let result, failure;
  try {
    result = await api("sync", { revision: graph.revision }, (event) =>
      logCommand("sync", event),
    );
  } catch (error) {
    failure = error;
  } finally {
    pushBusy(false);
  }
  await refresh();
  $("sync-progress").textContent = failure ? "Sync stopped." : "Sync finished.";
  if (failure) {
    $("sync-error").hidden = false;
    $("sync-error").textContent = failure.message;
  } else {
    $("sync-result").hidden = false;
    $("sync-result").textContent = result.unchanged
      ? "Already up to date."
      : `Merged ${result.merged.length} feature(s); ${result.remaining.length} commit(s) remain.`;
  }
});
function clearPushPlan() {
  pushPlan = null;
  $("push-plan").hidden = true;
  $("execute-push").disabled = true;
}
function renderPushFeatures() {
  clearPushPlan();
  const active = new Set(graph.groups.map((g) => g.name));
  for (const name of pushFeatures)
    if (!active.has(name)) pushFeatures.delete(name);
  $("push-features").replaceChildren();
  for (const group of graph.groups) {
    const label = element("label", undefined, "dependency-option");
    const check = element("input");
    check.type = "checkbox";
    check.value = group.name;
    check.checked = pushFeatures.has(group.name);
    check.addEventListener("change", () => {
      if (check.checked) pushFeatures.add(group.name);
      else pushFeatures.delete(group.name);
      clearPushPlan();
      updatePushControls();
    });
    label.append(
      check,
      document.createTextNode(
        `${group.name}${group.ready ? "" : $("push-wait").checked ? " (waiting for prerequisites)" : " (preview branch)"}`,
      ),
    );
    $("push-features").append(label);
  }
  $("open-push").disabled =
    publishing ||
    !graph.groups.length ||
    graph.paused ||
    graph.pushRun?.status === "running";
  $("open-sync").disabled = publishing || graph.pushRun?.status === "running";
  updatePushControls();
}
function pushBusy(busy, { background = false } = {}) {
  publishing = busy;
  backgroundPush = busy && background;
  $("push-progress").hidden = !busy;
  $("push-progress").textContent =
    "Pushing branches and creating or updating PRs…";
  $("execute-push").disabled = busy || !pushPlan;
  $("preview-push").disabled = busy;
  $("push-features").disabled = busy;
  for (const id of [
    "open-push",
    "open-sync",
    "refresh",
    "push-ready",
    "push-choose",
    "push-wait",
    "close-push",
    "close-sync",
  ])
    $(id).disabled = busy;
  $("close-push").disabled = busy && !backgroundPush;
  $("refresh").disabled = busy && !backgroundPush;
  $("view-push-run").disabled = busy && !backgroundPush;
  if (!busy) updatePushControls();
  if (graph && inspectorMode === "feature") {
    const group = graph.groups.find((g) => g.name === selectedFeature);
    if (group) renderPrDetails(group);
  }
}
$("preview-push").addEventListener("click", async () => {
  if (publishing || (pushMode === "choose" && !pushFeatures.size)) return;
  clearPushPlan();
  $("push-result").hidden = true;
  $("push-error").hidden = true;
  $("preview-push").disabled = true;
  try {
    const names = selectedPushNames();
    const revision = graph.revision;
    const wait = !!$("push-wait").checked;
    const plan = await api("push", {
      names,
      revision,
      dryRun: true,
      ...(wait ? { wait } : {}),
    });
    // Ignore a preview if the user refreshed or changed selection while it ran.
    if (
      graph.revision !== revision ||
      JSON.stringify(names) !== JSON.stringify(selectedPushNames()) ||
      wait !== !!$("push-wait").checked
    )
      return;
    pushPlan = { names, revision, ...(wait ? { wait } : {}) };
    $("error").hidden = true;
    $("push-target").textContent =
      `${graph.repo} · remote ${graph.remote || "origin"} · base ${graph.base}`;
    $("push-actions").replaceChildren();
    if (plan.continuous) {
      for (const watch of plan.prerequisites || [])
        $("push-actions").append(
          element(
            "li",
            `${watch.name}: watch existing PR #${watch.pr}; do not push`,
          ),
        );
      for (const entry of plan.features)
        $("push-actions").append(
          element(
            "li",
            `${entry.name} → ${entry.branch}: ${entry.deps.length ? `wait for ${entry.deps.join(", ")}, then publish PR` : "publish PR"}`,
          ),
        );
    }
    for (const group of plan.ready || [])
      $("push-actions").append(
        element(
          "li",
          `${group.name} → ${group.branch}: ${group.pr ? `update PR #${group.pr}` : "create or adopt PR"} (${group.commits.length} commits)`,
        ),
      );
    for (const group of plan.previews || [])
      $("push-actions").append(
        element(
          "li",
          `${group.name} → ${group.branch}: full-history preview branch, no PR; waiting for ${group.blockedBy.join(", ")}`,
        ),
      );
    const count = plan.continuous
      ? plan.features.length
      : plan.ready.length + plan.previews.length;
    if (!count)
      $("push-actions").append(element("li", "No branches are ready to push."));
    $("push-plan").hidden = false;
    $("execute-push").textContent = wait
      ? `Start push run (${count} features)`
      : `Push ${count} branch${count === 1 ? "" : "es"}`;
    $("execute-push").disabled = !count;
    if (!count) pushPlan = null;
  } catch (e) {
    $("push-error").hidden = false;
    $("push-error").textContent = e.message;
  } finally {
    updatePushControls();
  }
});
$("execute-push").addEventListener("click", async () => {
  if (publishing || !pushPlan) return;
  const request = { ...pushPlan, dryRun: false };
  $("push-log").textContent = "";
  $("push-log").hidden = false;
  $("push-error").hidden = true;
  pushBusy(true, { background: !!request.wait });
  let result, failure;
  try {
    result = await api("push", request, (event) => logCommand("push", event));
  } catch (e) {
    failure = e;
  } finally {
    pushBusy(false);
    clearPushPlan();
  }
  // A failed batch may still have published earlier branches. Always refresh.
  await refresh();
  if (failure) {
    $("push-error").hidden = false;
    $("push-error").textContent = failure.message;
    $("push-result").hidden = false;
    $("push-result").textContent =
      "Push did not finish. Some branches may have been published; inspect the refreshed state before retrying.";
    return;
  }
  if (result.run) renderPushRun(result.run);
  $("push-result").replaceChildren(
    element(
      "p",
      result.run ? `Push run ${result.run.status}.` : "Push finished.",
    ),
  );
  for (const item of result.pushed) {
    const line = element("p", `${item.name}: PR #${item.pr}`);
    if (item.url && /^https?:\/\//.test(item.url)) {
      const link = element("a", "Open pull request ↗");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      line.append(link);
    }
    $("push-result").append(line);
  }
  for (const item of result.previews)
    $("push-result").append(
      element("p", `${item.name}: pushed preview ${item.branch}, no PR.`),
    );
  $("push-result").hidden = false;
});
$("metadata-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!selectedCommit) throw new Error("Select a commit first.");
    $("notice").textContent = "Saving commit metadata…";
    await api("metadata", {
      sha: selectedCommit,
      revision: graph.revision,
      overrides: {
        title: $("title-override").checked ? $("metadata-title").value : null,
        description: $("description-override").checked
          ? $("metadata-description").value
          : null,
      },
    });
    await refresh();
    $("notice").textContent =
      "Commit metadata saved to notes; existing GitHub PR metadata is unchanged.";
  } catch (e) {
    error(e);
  }
});
$("deps-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("deps", {
      name: selectedFeature,
      deps: [...$("deps-options").querySelectorAll("input:checked")].map(
        (i) => i.value,
      ),
      revision: graph.revision,
    });
    await refresh();
    $("notice").textContent = "Dependencies saved to commit notes.";
  } catch (e) {
    error(e);
  }
});
$("tag-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!selectedCommits.size) throw new Error("Select at least one commit.");
    await api("tag", {
      name: $("feature-name").value.trim(),
      commits: [...selectedCommits],
      revision: graph.revision,
    });
    selectedCommits.clear();
    await refresh();
    $("notice").textContent = "Feature assignments saved to commit notes.";
  } catch (e) {
    error(e);
  }
});
const divider = $("sidebar-divider");
let sidebarWidth = 380;
try {
  const saved =
    vscode?.getState?.()?.sidebarWidth ??
    sessionStorage.getItem("prm-sidebar-width");
  if (saved !== null && saved !== undefined && Number.isFinite(Number(saved)))
    sidebarWidth = Number(saved);
} catch {
  /* Storage can be unavailable in a restricted browser. */
}
function resizeSidebar(width, persist = false) {
  const maximum = Math.max(
    300,
    Math.min(720, (window.innerWidth || 1200) - 328),
  );
  sidebarWidth = Math.round(Math.max(300, Math.min(maximum, width)));
  document.documentElement.style.setProperty(
    "--inspector-width",
    `${sidebarWidth}px`,
  );
  divider.setAttribute("aria-valuemax", maximum);
  divider.setAttribute("aria-valuenow", sidebarWidth);
  if (persist) {
    try {
      if (vscode?.setState)
        vscode.setState({ ...vscode.getState?.(), sidebarWidth });
      else sessionStorage.setItem("prm-sidebar-width", String(sidebarWidth));
    } catch {
      /* Resizing still works without persistence. */
    }
  }
}
let dragging = null;
divider.addEventListener("pointerdown", (event) => {
  if (
    (window.innerWidth || 1200) <= 850 ||
    (event.button != null && event.button !== 0)
  )
    return;
  event.preventDefault();
  dragging = { id: event.pointerId, x: event.clientX, width: sidebarWidth };
  divider.setPointerCapture?.(event.pointerId);
  document.body.classList.add("resizing-sidebar");
});
divider.addEventListener("pointermove", (event) => {
  if (dragging && dragging.id === event.pointerId)
    resizeSidebar(dragging.width + dragging.x - event.clientX);
});
function finishResize(event) {
  if (!dragging || dragging.id !== event.pointerId) return;
  dragging = null;
  document.body.classList.remove("resizing-sidebar");
  resizeSidebar(sidebarWidth, true);
}
divider.addEventListener("pointerup", finishResize);
divider.addEventListener("pointercancel", finishResize);
divider.addEventListener("lostpointercapture", finishResize);
divider.addEventListener("keydown", (event) => {
  const width = {
    ArrowLeft: sidebarWidth + 24,
    ArrowRight: sidebarWidth - 24,
    Home: 300,
    End: 720,
  }[event.key];
  if (width === undefined) return;
  event.preventDefault();
  resizeSidebar(width, true);
});
window.addEventListener("resize", () => resizeSidebar(sidebarWidth));
resizeSidebar(sidebarWidth);
refresh();

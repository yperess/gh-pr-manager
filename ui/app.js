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
const selectedCommits = new Set();
const pending = new Map();
let requestId = 0;

window.addEventListener("message", (event) => {
  if (!vscode || !event.data?.id) return;
  const p = pending.get(event.data.id);
  if (!p) return;
  clearTimeout(p.timeout);
  pending.delete(event.data.id);
  if (event.data.error) p.reject(new Error(event.data.error));
  else p.resolve(event.data.result);
});
async function api(route, data) {
  if (vscode)
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Extension request timed out."));
      }, 30000);
      pending.set(id, { resolve, reject, timeout });
      vscode.postMessage({ id, route, data });
    });
  const result = await fetch(`/api/${route}`, {
    method: data ? "POST" : "GET",
    headers: { "X-PRM-Token": token || "", "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
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
function status(g) {
  return g.status === "MERGED"
    ? "Merged"
    : g.blockedBy.length
      ? `Waiting for ${g.blockedBy.join(", ")}`
      : g.pr
        ? `In review · #${g.pr}`
        : "Ready to publish";
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
    positions.set(name, { x: 30 + d * 270, y: 25 + n * 110 });
    lanes.set(d, n + 1);
  }
  const width = Math.max(600, (Math.max(0, ...lanes.keys()) + 1) * 270 + 40);
  const height = Math.max(210, Math.max(0, ...lanes.values()) * 110 + 30);
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
        class: `feature-card ${selectedFeature === g.name ? "selected" : ""}`,
        tabindex: 0,
        role: "button",
        "aria-label": `${g.name}: ${status(g)}`,
      });
    card.append(svg("rect", { width: 220, height: 76, rx: 9 }));
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
              : g.pr
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
          : `${g.commits.length} commits · ${g.pr ? `PR #${g.pr}` : g.blockedBy.length ? "Waiting" : "Ready"}`,
      ),
    );
    card.addEventListener("click", () => selectFeature(g.name));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectFeature(g.name);
      }
    });
    root.append(card);
  }
  $("empty").hidden = nodes.size > 0;
}
function renderCommits() {
  $("commits").replaceChildren();
  for (const c of graph.commits) {
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
    row.append(checkCell);
    row.append(element("td", c.sha.slice(0, 7)));
    const messageCell = element("td"),
      button = element("button", c.subject, "commit-message");
    button.addEventListener("click", async () => {
      try {
        selectCommit(c.sha);
        $("diff-title").textContent = `${c.sha.slice(0, 7)} · ${c.subject}`;
        $("diff").textContent = (await api(`diff?sha=${c.sha}`)).diff;
      } catch (e) {
        error(e);
      }
    });
    messageCell.append(button);
    row.append(messageCell);
    const featureCell = element("td"),
      dot = element("span", undefined, "group-dot");
    dot.style.background = c.name ? color(c.name) : "#647086";
    featureCell.append(dot);
    if (c.name) {
      const b = element("button", c.name, "feature-label");
      b.addEventListener("click", () => selectFeature(c.name));
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
function selectFeature(name) {
  selectedFeature = name;
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
  $("feature-title").textContent = group.title ?? group.name;
  $("feature-title-source").textContent = metadataSource(
    group.titleSource,
    "title",
  );
  $("feature-description").textContent =
    group.description === ""
      ? "(Explicitly empty)"
      : (group.description ?? "Generated when the PR is created.");
  $("feature-description-source").textContent = metadataSource(
    group.descriptionSource,
    "description",
  );
  const link = $("pr-link");
  link.hidden = !group.url;
  if (group.url && /^https?:\/\//.test(group.url)) link.href = group.url;
  else link.removeAttribute("href");
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
}
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
  selectedCommit = sha;
  const commit = graph.commits.find((c) => c.sha === sha);
  $("metadata-panel").hidden = !commit;
  if (!commit) return;
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
  try {
    graph = await api("graph");
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
    if (selectedFeature) selectFeature(selectedFeature);
    if (selectedCommit) selectCommit(selectedCommit);
    $("notice").textContent = graph.paused
      ? "Sync is paused. Resolve or abort in the terminal."
      : `${graph.commits.length} commits · ${graph.groups.length} active features · refreshed ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    error(e);
  }
}
$("refresh").addEventListener("click", refresh);
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
refresh();

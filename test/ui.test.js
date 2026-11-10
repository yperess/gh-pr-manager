import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("UI did not reach the expected state.");
}

async function editor(
  vscodeMode = false,
  pushResponse,
  storage = new Map(),
  statusResponse,
  diffResponse,
  featureDiffResponse,
) {
  const html = fs.readFileSync(
    new URL("../ui/index.html", import.meta.url),
    "utf8",
  );
  const { window } = parseHTML(html),
    document = window.document;
  window.innerWidth = 1400;
  const commits = ["A", "B", "C", "D", "E", "F"].map((subject, i) => ({
    sha: String(i + 1).repeat(40),
    subject: i === 0 ? "<img src=x onerror=alert(1)>" : subject,
    name: i === 0 || i === 4 ? "feature1" : i === 1 ? "feature2" : "feature3",
    deps: [],
  }));
  commits[2].title = "Initial feature title";
  commits[2].description = "Initial feature body";
  commits[5].title = "Latest feature title";
  let graph = {
    branch: "work",
    base: "main",
    repo: "https://github.test/user/repo",
    head: commits[5].sha,
    revision: "v1",
    commits,
    groups: [
      {
        name: "feature1",
        commits: [commits[0].sha, commits[4].sha],
        deps: [],
        blockedBy: [],
        ready: true,
        status: "READY",
      },
      {
        name: "feature2",
        commits: [commits[1].sha],
        deps: [],
        blockedBy: [],
        ready: true,
        status: "READY",
      },
      {
        name: "feature3",
        title: "Latest feature title",
        titleSource: commits[5].sha,
        description: "Initial feature body",
        descriptionSource: commits[2].sha,
        commits: [commits[2].sha, commits[3].sha, commits[5].sha],
        deps: ["feature1", "feature2"],
        blockedBy: ["feature1", "feature2"],
        ready: false,
        status: "BLOCKED",
      },
    ],
    merged: {},
    paused: false,
  };
  const calls = [];
  let progressListener;
  const fetch = async (url, options) => {
    const route = url.slice("/api/".length),
      body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, body, headers: options.headers });
    if (
      ["sync", "adopt", "feature-diff"].includes(route) ||
      (route === "push" && body?.dryRun === false)
    )
      progressListener?.({
        type: "progress",
        command:
          route === "sync" ? "git fetch origin develop" : "git push origin",
      });
    let result = graph;
    if (route === "pr-status") {
      const response = statusResponse
        ? await statusResponse(graph)
        : {
            revision: graph.revision,
            checkedAt: "2026-11-09T12:00:00Z",
            features: graph.groups.map((g) => ({ name: g.name, pr: null })),
          };
      if (response?.error) return { ok: false, json: async () => response };
      result = response;
    } else if (route === "adopt") {
      assert.equal(body.revision, graph.revision);
      assert.match(body.head, /^[a-f0-9]{40}$/);
      const response = pushResponse ? await pushResponse() : undefined;
      if (response?.error) return { ok: false, json: async () => response };
      const group = graph.groups.find((g) => g.name === body.name);
      Object.assign(group, {
        pr: body.pr,
        url: `https://github.test/pr/${body.pr}`,
        status: "OPEN",
      });
      graph.revision += "adopted";
      result = { name: body.name, pr: body.pr, adopted: true, graph };
    } else if (route === "sync") {
      const response = pushResponse ? await pushResponse() : undefined;
      if (response?.error) return { ok: false, json: async () => response };
      graph.revision += "sync";
      result = {
        merged: [],
        remaining: graph.commits.map((c) => c.sha),
        unchanged: true,
      };
    } else if (route === "push-stop") {
      graph.pushRun.cancelRequested = true;
      result = graph.pushRun;
    } else if (route === "push" && body.wait) {
      const selected = body.names.length
        ? graph.groups.filter((g) => body.names.includes(g.name))
        : graph.groups;
      if (body.dryRun)
        result = {
          continuous: true,
          features: selected.map((g) => ({ ...g, branch: `prm/${g.name}` })),
          revision: graph.revision,
        };
      else {
        const response = pushResponse
          ? await pushResponse({ body, graph, emit: progressListener })
          : undefined;
        graph.pushRun = response?.run || {
          id: "run1",
          status: "completed",
          features: selected.map((g) => ({
            name: g.name,
            status: "published",
          })),
        };
        result = response || { run: graph.pushRun, pushed: [], previews: [] };
      }
    } else if (route === "push") {
      assert.equal(body.revision, graph.revision);
      const selected = body.names.length
        ? graph.groups.filter((g) => body.names.includes(g.name))
        : graph.groups.filter((g) => g.ready);
      if (body.dryRun) {
        const groups = selected.map((g) => ({
          ...g,
          branch: g.branch ?? `prm/${g.name}`,
        }));
        result = {
          ready: groups.filter((g) => g.ready),
          previews: groups.filter((g) => !g.ready),
          revision: graph.revision,
        };
      } else {
        if (pushResponse) {
          const response = await pushResponse();
          if (response?.error) return { ok: false, json: async () => response };
        }
        graph.revision += "pushed";
        result = {
          pushed: selected
            .filter((g) => g.ready)
            .map((g, i) => ({
              name: g.name,
              pr: i + 1,
              url: `https://github.test/pr/${i + 1}`,
            })),
          previews: selected
            .filter((g) => !g.ready)
            .map((g) => ({ name: g.name, branch: `prm/${g.name}` })),
        };
      }
    } else if (route === "deps") {
      assert.equal(body.revision, graph.revision);
      const group = graph.groups.find((g) => g.name === body.name);
      group.deps = body.deps;
      group.blockedBy = body.deps;
      group.ready = !body.deps.length;
      graph.revision += "x";
    } else if (route === "tag") {
      assert.equal(body.revision, graph.revision);
      for (const c of graph.commits)
        if (body.commits.includes(c.sha)) c.name = body.name;
      graph.groups.push({
        name: body.name,
        commits: body.commits,
        deps: [],
        blockedBy: [],
        ready: true,
        status: "READY",
      });
      graph.revision += "x";
    } else if (route === "branch") {
      assert.equal(body.revision, graph.revision);
      const group = graph.groups.find((g) => g.name === body.name);
      group.branchName = body.branchName;
      group.branch = body.branchName ?? `prm/${group.name}`;
      graph.revision += "x";
    } else if (route === "metadata") {
      assert.equal(body.revision, graph.revision);
      Object.assign(
        graph.commits.find((c) => c.sha === body.sha),
        body.overrides,
      );
      for (const group of graph.groups) {
        Object.assign(group, {
          title: group.name,
          description: null,
          titleSource: null,
          descriptionSource: null,
        });
        for (const c of graph.commits.filter((c) => c.name === group.name)) {
          for (const field of ["title", "description"])
            if (c[field] != null) {
              group[field] = c[field];
              group[`${field}Source`] = c.sha;
            }
        }
      }
      graph.revision += "x";
    } else if (route === "feature-diff") {
      result = featureDiffResponse
        ? await featureDiffResponse(body)
        : {
            diff: `Feature net diff for ${body.name}`,
            revision: graph.revision,
          };
      if (result.error) return { ok: false, json: async () => result };
    } else if (route.startsWith("diff?")) {
      result = diffResponse
        ? await diffResponse(route)
        : { diff: "<script>never execute this</script>\n+ changed line" };
      if (result.error) return { ok: false, json: async () => result };
    }
    return { ok: true, json: async () => structuredClone(result) };
  };
  const transport = async (url, options) => {
    const route = url.slice("/api/".length),
      body = options.body ? JSON.parse(options.body) : null;
    if (
      !["sync", "adopt", "feature-diff"].includes(route) &&
      !(route === "push" && body?.dryRun === false)
    )
      return fetch(url, options);
    const frames = [];
    let notify,
      done = false;
    const put = (event) => {
      frames.push(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      notify?.();
    };
    progressListener = put;
    const task = fetch(url, options).then(async (response) => {
      const value = await response.json();
      put(
        response.ok
          ? { type: "result", result: value }
          : { type: "error", error: value.error },
      );
      done = true;
      notify?.();
    });
    return {
      headers: { get: () => "application/x-ndjson" },
      body: {
        getReader: () => ({
          read: async () => {
            while (!frames.length && !done)
              await new Promise((resolve) => {
                notify = resolve;
              });
            return frames.length
              ? { done: false, value: frames.shift() }
              : { done: true };
          },
          releaseLock() {},
        }),
      },
    };
  };
  const context = vm.createContext({
    window,
    document,
    location: { hash: "#token=test-token", pathname: "/" },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    fetch: transport,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    ...(vscodeMode
      ? {
          acquireVsCodeApi: () => ({
            getState: () => structuredClone(storage.get("vscode-state") ?? {}),
            setState: (state) =>
              storage.set("vscode-state", structuredClone(state)),
            postMessage: async (message) => {
              progressListener = (progress) => {
                const event = new window.Event("message");
                event.data = { id: message.id, progress };
                window.dispatchEvent(event);
              };
              const result = await fetch(`/api/${message.route}`, {
                headers: {},
                ...(message.data ? { body: JSON.stringify(message.data) } : {}),
              });
              const event = new window.Event("message");
              const body = await result.json();
              event.data = result.ok
                ? { id: message.id, result: body }
                : { id: message.id, error: body.error };
              window.dispatchEvent(event);
            },
          }),
        }
      : {}),
  });
  vm.runInContext(
    fs.readFileSync(new URL("../ui/diff.js", import.meta.url), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8"),
    context,
  );
  await until(() => document.querySelectorAll("#commits tr").length === 6);
  return { window, document, calls };
}

test("renderer displays the parallel DAG, groups interleaved commits, and safely inspects a patch", async () => {
  const { window, document, calls } = await editor();
  assert.equal(document.querySelectorAll(".feature-card").length, 3);
  assert.equal(document.querySelectorAll(".dependency-edge").length, 2);
  assert.match(
    document.getElementById("counts").textContent,
    /2 ready · 1 waiting/,
  );
  assert.equal(document.querySelectorAll("#commits img").length, 0);
  document
    .querySelector(".commit-message")
    .dispatchEvent(new window.Event("click"));
  await until(() =>
    document.getElementById("diff").textContent.includes("never execute"),
  );
  assert.equal(document.querySelectorAll("#diff script").length, 0);
  assert.equal(calls[0].headers["X-PRM-Token"], "test-token");
});

test("graph editor saves changed prerequisites and feature assignments through the API", async () => {
  const { window, document, calls } = await editor();
  document
    .querySelectorAll(".feature-card")[2]
    .dispatchEvent(new window.Event("click"));
  assert.equal(
    document.getElementById("inspector-title").textContent,
    "feature3",
  );
  const options = document.querySelectorAll("#deps-options input");
  options[0].checked = false;
  options[0].removeAttribute("checked");
  options[1].checked = true;
  options[1].setAttribute("checked", "");
  document
    .getElementById("deps-form")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await until(() => calls.some((c) => c.route === "deps"));
  assert.deepEqual(calls.find((c) => c.route === "deps").body.deps, [
    "feature2",
  ]);
  await until(
    () =>
      document.getElementById("notice").textContent ===
      "Dependencies saved to commit notes.",
  );
  const check = document.querySelector("#commits input");
  check.checked = true;
  check.dispatchEvent(new window.Event("change"));
  document.getElementById("feature-name").value = "followup";
  document
    .getElementById("tag-form")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await until(() => calls.some((c) => c.route === "tag"));
  assert.equal(calls.find((c) => c.route === "tag").body.name, "followup");
  assert.equal(calls.find((c) => c.route === "tag").body.commits.length, 1);
  await until(() => document.querySelectorAll(".feature-card").length === 4);
  assert.equal(document.getElementById("error").hidden, true);
});

for (const vscodeMode of [false, true]) {
  test(`${vscodeMode ? "VS Code" : "Browser"} exposes toolbar actions and streams sync progress in a dialog`, async () => {
    let finish;
    const waiting = new Promise((resolve) => {
      finish = resolve;
    });
    const { window, document, calls } = await editor(vscodeMode, () => waiting);
    const click = (id) =>
      document.getElementById(id).dispatchEvent(new window.Event("click"));
    for (const id of ["open-push", "open-sync", "refresh"])
      assert.equal(
        document.getElementById(id).closest("header").tagName,
        "HEADER",
      );
    assert.equal(document.querySelectorAll(".toolbar-action svg").length, 3);
    assert.equal(
      document.getElementById("push-features").closest("dialog").id,
      "push-dialog",
    );
    click("open-push");
    assert.equal(
      document.getElementById("push-ready").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(document.getElementById("push-choice").hidden, true);
    click("push-choose");
    assert.equal(document.getElementById("preview-push").disabled, true);
    click("close-push");
    assert.equal(
      document.getElementById("push-dialog").hasAttribute("open"),
      false,
    );
    click("open-sync");
    click("open-sync");
    await until(() =>
      document.getElementById("sync-log").textContent.includes("git fetch"),
    );
    assert.equal(
      document.getElementById("sync-dialog").hasAttribute("open"),
      true,
    );
    assert.equal(document.getElementById("close-sync").disabled, true);
    assert.equal(calls.filter((c) => c.route === "sync").length, 1);
    const cancel = new window.Event("cancel", { cancelable: true });
    document.getElementById("sync-dialog").dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    finish();
    await until(
      () =>
        document.getElementById("sync-progress").textContent ===
        "Sync finished.",
    );
    assert.match(
      document.getElementById("sync-result").textContent,
      /up to date/,
    );
    assert.equal(document.getElementById("close-sync").disabled, false);
    click("close-sync");
    assert.equal(
      document.getElementById("sync-dialog").hasAttribute("open"),
      false,
    );
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} keeps sync recovery instructions in the dialog on failure`, async () => {
    const { window, document } = await editor(vscodeMode, async () => ({
      error: "Sync paused. Resolve conflicts, then run gh prm sync --continue.",
    }));
    document
      .getElementById("open-sync")
      .dispatchEvent(new window.Event("click"));
    await until(() => !document.getElementById("sync-error").hidden);
    assert.match(
      document.getElementById("sync-error").textContent,
      /sync --continue/,
    );
    assert.equal(document.getElementById("close-sync").disabled, false);
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} switches the sidebar from feature to commit editing and back`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    const click = (node) =>
      node.dispatchEvent(new window.Event("click", { bubbles: true }));
    click(document.querySelectorAll(".feature-card")[0]);
    assert.equal(document.getElementById("inspector").hidden, false);
    assert.equal(document.getElementById("metadata-panel").hidden, true);
    click(document.querySelectorAll(".commit-message")[0]);
    await until(() =>
      document.getElementById("diff").textContent.includes("never execute"),
    );
    assert.equal(document.getElementById("inspector").hidden, true);
    assert.equal(document.getElementById("metadata-panel").hidden, false);
    assert.equal(
      document.getElementById("metadata-panel").closest("aside").id,
      "inspector-sidebar",
    );
    assert.match(
      document.getElementById("inspector-title").textContent,
      /Commit 1111111/,
    );
    assert.equal(document.getElementById("metadata-title").value, "feature1");
    document.getElementById("title-override").checked = true;
    document
      .getElementById("title-override")
      .dispatchEvent(new window.Event("change"));
    document.getElementById("metadata-title").value = "Commit-specific title";
    document
      .getElementById("metadata-form")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await until(() =>
      document
        .getElementById("notice")
        .textContent.startsWith("Commit metadata saved"),
    );
    assert.equal(
      calls.filter((c) => c.route === "metadata").at(-1).body.sha,
      "1".repeat(40),
    );
    assert.equal(document.getElementById("metadata-panel").hidden, false);
    click(document.getElementById("show-feature"));
    assert.equal(
      document.getElementById("inspector-title").textContent,
      "feature1",
    );
    assert.equal(document.getElementById("metadata-panel").hidden, true);
    assert.equal(
      document.getElementById("feature-title").value,
      "Commit-specific title",
    );
    click(document.getElementById("graph")); // Restore all commits before opening D.
    // Clicking the SHA cell also opens the commit, without changing assignment checkboxes.
    click(document.querySelectorAll("#commits tr")[3].children[1]);
    assert.match(
      document.getElementById("inspector-title").textContent,
      /Commit 4444444/,
    );
    assert.equal(
      document.getElementById("metadata-title").value,
      "Initial feature title",
    );
    assert.equal(document.querySelectorAll("#commits tr.selected").length, 1);
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} edits feature metadata on its latest commit while preserving earlier overrides`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    document
      .querySelectorAll(".feature-card")[0]
      .dispatchEvent(new window.Event("click"));
    assert.match(
      document.getElementById("feature-metadata-target").textContent,
      /5555555/,
    );
    const save = async () => {
      const count = calls.filter((c) => c.route === "metadata").length;
      document
        .getElementById("feature-metadata-form")
        .dispatchEvent(new window.Event("submit", { cancelable: true }));
      await until(
        () => calls.filter((c) => c.route === "metadata").length > count,
      );
      await until(() =>
        document
          .getElementById("notice")
          .textContent.startsWith("Feature metadata saved"),
      );
      return calls.filter((c) => c.route === "metadata").at(-1).body;
    };
    document.getElementById("feature-title").value = "Feature-wide title";
    const title = await save();
    assert.equal(title.sha, "5".repeat(40)); // E, not integration HEAD F.
    assert.deepEqual(title.overrides, { title: "Feature-wide title" });
    assert.equal(document.getElementById("inspector").hidden, false);
    assert.equal(document.getElementById("metadata-panel").hidden, true);
    document
      .getElementById("feature-description")
      .dispatchEvent(new window.Event("input"));
    assert.deepEqual((await save()).overrides, { description: "" });
    document.getElementById("feature-description").value =
      "Paragraph\n\n<script>plain text</script>";
    const description = await save();
    assert.deepEqual(description.overrides, {
      description: "Paragraph\n\n<script>plain text</script>",
    });
    assert.equal(
      document.querySelectorAll("#feature-description script").length,
      0,
    );
    document.getElementById("feature-description").value = "";
    assert.deepEqual((await save()).overrides, { description: "" });
    document
      .querySelectorAll(".commit-message")[0]
      .dispatchEvent(new window.Event("click"));
    assert.equal(document.getElementById("metadata-title").value, "feature1");
    document
      .querySelector(
        '#commits tr[data-sha="5555555555555555555555555555555555555555"] .commit-message',
      )
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("metadata-title").value,
      "Feature-wide title",
    );
    assert.equal(document.getElementById("title-override").checked, true);
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} resizes the inspector with pointer and keyboard controls`, async () => {
    const storage = new Map();
    const { window, document } = await editor(vscodeMode, undefined, storage);
    const divider = document.getElementById("sidebar-divider");
    const pointer = (type, x) => {
      const event = new window.Event(type, { cancelable: true });
      Object.assign(event, { pointerId: 1, clientX: x, button: 0 });
      divider.dispatchEvent(event);
    };
    pointer("pointerdown", 1000);
    pointer("pointermove", 800);
    pointer("pointerup", 800);
    assert.equal(divider.getAttribute("aria-valuenow"), "580");
    assert.equal(
      vscodeMode
        ? storage.get("vscode-state").sidebarWidth
        : Number(storage.get("prm-sidebar-width")),
      580,
    );
    assert.equal(document.body.classList.contains("resizing-sidebar"), false);
    for (const [key, expected] of [
      ["ArrowLeft", 604],
      ["Home", 300],
      ["ArrowRight", 300],
      ["End", 720],
    ]) {
      const event = new window.Event("keydown", { cancelable: true });
      event.key = key;
      divider.dispatchEvent(event);
      assert.equal(divider.getAttribute("aria-valuenow"), String(expected));
    }
    window.innerWidth = 900;
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(divider.getAttribute("aria-valuenow"), "572");
    const reopened = await editor(vscodeMode, undefined, storage);
    assert.equal(
      reopened.document
        .getElementById("sidebar-divider")
        .getAttribute("aria-valuenow"),
      "720",
    );
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} previews default and selected pushes, and prevents duplicate publication`, async () => {
    let finish;
    const waiting = new Promise((resolve) => {
      finish = resolve;
    });
    const { window, document, calls } = await editor(vscodeMode, () => waiting);
    const click = (id) =>
      document.getElementById(id).dispatchEvent(new window.Event("click"));
    click("open-push");
    click("preview-push");
    await until(() => !document.getElementById("push-plan").hidden);
    assert.match(
      document.getElementById("push-actions").textContent,
      /feature1.*create or adopt PR/,
    );
    assert.match(
      document.getElementById("push-actions").textContent,
      /feature2/,
    );
    assert.doesNotMatch(
      document.getElementById("push-actions").textContent,
      /feature3/,
    );
    assert.equal(
      calls.filter((c) => c.route === "push" && !c.body.dryRun).length,
      0,
    );
    click("push-choose");
    const check = document.querySelectorAll("#push-features input")[2];
    check.checked = true;
    check.dispatchEvent(new window.Event("change"));
    assert.equal(document.getElementById("push-plan").hidden, true);
    click("preview-push");
    await until(() => !document.getElementById("push-plan").hidden);
    assert.match(
      document.getElementById("push-actions").textContent,
      /feature3.*full-history preview branch, no PR/,
    );
    assert.doesNotMatch(
      document.getElementById("push-actions").textContent,
      /feature1 →/,
    );
    click("execute-push");
    click("execute-push");
    assert.equal(
      calls.filter((c) => c.route === "push" && !c.body.dryRun).length,
      1,
    );
    assert.equal(document.getElementById("execute-push").disabled, true);
    assert.equal(document.getElementById("push-progress").hidden, false);
    finish();
    await until(() => !document.getElementById("push-result").hidden);
    assert.match(
      document.getElementById("push-result").textContent,
      /pushed preview prm\/feature3, no PR/,
    );
    assert.equal(document.getElementById("execute-push").disabled, true);
    assert.equal(document.getElementById("push-plan").hidden, true);
    assert.equal(document.getElementById("push-progress").hidden, true);
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} shows PR links, invalidates refreshed previews, and recovers from push errors`, async () => {
    let fail = false;
    const { window, document, calls } = await editor(vscodeMode, async () =>
      fail ? { error: "Remote changed" } : undefined,
    );
    const click = (id) =>
      document.getElementById(id).dispatchEvent(new window.Event("click"));
    click("open-push");
    const preview = async () => {
      click("preview-push");
      await until(() => !document.getElementById("push-plan").hidden);
    };
    await preview();
    click("refresh");
    await until(() => document.getElementById("push-plan").hidden);
    click("execute-push");
    assert.equal(
      calls.filter((c) => c.route === "push" && !c.body.dryRun).length,
      0,
    );
    await preview();
    click("execute-push");
    await until(() => !document.getElementById("push-result").hidden);
    assert.match(
      document.getElementById("push-result").textContent,
      /feature1: PR #1/,
    );
    assert.equal(document.querySelectorAll("#push-result a").length, 2);
    assert.equal(document.getElementById("error").hidden, true);
    fail = true;
    await preview();
    click("execute-push");
    await until(() => !document.getElementById("push-error").hidden);
    assert.match(
      document.getElementById("push-error").textContent,
      /Remote changed/,
    );
    assert.match(
      document.getElementById("push-result").textContent,
      /Some branches may have been published/,
    );
    assert.equal(document.getElementById("push-plan").hidden, true);
    assert.equal(document.getElementById("push-progress").hidden, true);
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} feature inspector displays and edits branch names`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    document
      .querySelectorAll(".feature-card")[0]
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("feature-branch").textContent,
      "prm/feature1",
    );
    for (const value of ["yperess/migrate-struct-fixture", ""]) {
      document.getElementById("branch-name").value = value;
      document
        .getElementById("branch-form")
        .dispatchEvent(new window.Event("submit", { cancelable: true }));
      await until(
        () =>
          document.getElementById("notice").textContent ===
          "Branch name saved to notes.",
      );
      assert.equal(
        calls.filter((c) => c.route === "branch").at(-1).body.branchName,
        value || null,
      );
      assert.equal(
        document.getElementById("feature-branch").textContent,
        value || "prm/feature1",
      );
    }
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} editor displays metadata as of a commit and saves, removes, and clears overrides`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    const click = (node) => node.dispatchEvent(new window.Event("click"));
    const change = (id, checked) => {
      const node = document.getElementById(id);
      node.checked = checked;
      node.dispatchEvent(new window.Event("change"));
    };
    const save = async () => {
      const count = calls.filter((c) => c.route === "metadata").length;
      document
        .getElementById("metadata-form")
        .dispatchEvent(new window.Event("submit", { cancelable: true }));
      await until(
        () => calls.filter((c) => c.route === "metadata").length > count,
      );
      await until(() =>
        document
          .getElementById("notice")
          .textContent.startsWith("Commit metadata saved"),
      );
      return calls.filter((c) => c.route === "metadata").at(-1).body;
    };
    click(document.querySelectorAll(".feature-card")[2]);
    assert.equal(
      document.getElementById("feature-title").value,
      "Latest feature title",
    );
    click(
      document.querySelector(
        '#commits tr[data-sha="4444444444444444444444444444444444444444"] .commit-message',
      ),
    ); // D has no overrides of its own.
    assert.equal(
      document.getElementById("metadata-title").value,
      "Initial feature title",
    );
    assert.equal(
      document.getElementById("metadata-description").value,
      "Initial feature body",
    );
    assert.equal(document.getElementById("title-override").checked, false);
    assert.match(
      document.getElementById("title-source").textContent,
      /3333333/,
    );
    change("title-override", true);
    document.getElementById("metadata-title").value = "Middle title";
    const saved = await save();
    assert.deepEqual(saved.overrides, {
      title: "Middle title",
      description: null,
    });
    assert.equal(
      document.getElementById("metadata-title").value,
      "Middle title",
    );
    assert.equal(
      document.getElementById("feature-title").value,
      "Latest feature title",
    );
    change("title-override", false);
    assert.equal(
      document.getElementById("metadata-title").value,
      "Initial feature title",
    );
    assert.equal(document.getElementById("metadata-title").disabled, true);
    change("description-override", true);
    document.getElementById("metadata-description").value = "";
    const cleared = await save();
    assert.deepEqual(cleared.overrides, { title: null, description: "" });
    click(
      document.querySelector(
        '#commits tr[data-sha="6666666666666666666666666666666666666666"] .commit-message',
      ),
    ); // F inherits D's explicit empty body.
    assert.equal(
      document.getElementById("metadata-title").value,
      "Latest feature title",
    );
    assert.equal(document.getElementById("metadata-description").value, "");
    assert.equal(
      document.getElementById("description-override").checked,
      false,
    );
    assert.match(
      document.getElementById("description-source").textContent,
      /4444444/,
    );
    change("description-override", true);
    document.getElementById("metadata-description").value =
      "<script>plain text</script>\n\nMarkdown paragraph";
    await save();
    assert.match(
      document.getElementById("feature-description").value,
      /<script>plain text/,
    );
    assert.equal(
      document.querySelectorAll("#feature-description script").length,
      0,
    );
  });
}

for (const vscodeMode of [false, true]) {
  test(`${vscodeMode ? "VS Code" : "Browser"} discovers PR links and actionable status without publishing or resetting edits`, async () => {
    let release;
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const e = await editor(vscodeMode, undefined, new Map(), () => response);
    const card = e.document.querySelector(".feature-card");
    card.dispatchEvent(new e.window.Event("click"));
    const title = e.document.getElementById("feature-title");
    title.value = "Unsaved title";
    title.dispatchEvent(new e.window.Event("input"));
    assert.match(
      e.document.getElementById("pr-details").textContent,
      /Checking/,
    );
    release({
      revision: "v1",
      checkedAt: "2026-11-09T12:00:00Z",
      features: [
        {
          name: "feature1",
          pr: 42,
          url: "https://github.test/user/repo/pull/42",
          state: "OPEN",
          ci: "FAILING",
          reviewDecision: "CHANGES_REQUESTED",
          unresolvedThreads: 2,
          actionable: true,
        },
        {
          name: "feature2",
          pr: 43,
          url: "https://github.test/user/repo/pull/43",
          state: "OPEN",
          ci: "PENDING",
          reviewDecision: "REVIEW_REQUIRED",
          unresolvedThreads: 0,
          actionable: false,
        },
        { name: "feature3", pr: null },
      ],
    });
    await until(() =>
      e.document
        .getElementById("pr-link")
        .getAttribute("href")
        ?.endsWith("/42"),
    );
    assert.equal(title.value, "Unsaved title");
    const link = e.document.getElementById("pr-link");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.hidden, false);
    assert.match(
      e.document.getElementById("pr-details").textContent,
      /CI: failing/,
    );
    assert.match(
      e.document.getElementById("pr-details").textContent,
      /2 unresolved review threads/,
    );
    assert.match(
      e.document.querySelector(".needs-attention").getAttribute("aria-label"),
      /CI failing.*Changes requested.*2 open threads/,
    );
    assert.match(e.document.getElementById("graph").textContent, /CI pending/);
    assert.equal(
      e.document.querySelectorAll(".feature-card.needs-attention").length,
      1,
    );
    assert.equal(
      e.calls.some((c) => ["push", "sync"].includes(c.route)),
      false,
    );
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} clears old PR highlights when status refresh fails`, async () => {
    let fail = false;
    const e = await editor(vscodeMode, undefined, new Map(), (graph) =>
      fail
        ? { error: "Offline" }
        : {
            revision: graph.revision,
            checkedAt: "2026-11-09T12:00:00Z",
            features: [
              {
                name: "feature1",
                pr: 42,
                url: "javascript:alert(1)",
                state: "OPEN",
                ci: "FAILING",
                unresolvedThreads: 0,
                actionable: true,
              },
            ],
          },
    );
    await until(
      () =>
        e.document.querySelectorAll(".feature-card.needs-attention").length ===
        1,
    );
    e.document
      .querySelector(".feature-card")
      .dispatchEvent(new e.window.Event("click"));
    assert.equal(e.document.getElementById("pr-link").hidden, true);
    fail = true;
    e.document.getElementById("refresh").click();
    await until(() =>
      e.document
        .getElementById("pr-status-summary")
        .textContent.includes("Offline"),
    );
    assert.equal(
      e.document.querySelectorAll(".feature-card.needs-attention").length,
      0,
    );
    assert.match(
      e.document.getElementById("pr-details").textContent,
      /unavailable/,
    );
  });
}

test("ignores PR status responses for an older graph revision", async () => {
  let release,
    request = 0;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  const e = await editor(false, undefined, new Map(), (graph) =>
    ++request === 1
      ? delayed
      : {
          revision: graph.revision,
          checkedAt: "2026-11-09T12:00:00Z",
          features: [],
        },
  );
  e.document.getElementById("refresh").click();
  await until(() => request === 2);
  release({
    revision: "v1",
    checkedAt: "2026-11-09T12:00:00Z",
    features: [
      {
        name: "feature1",
        pr: 1,
        state: "OPEN",
        ci: "FAILING",
        actionable: true,
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    e.document.querySelectorAll(".feature-card.needs-attention").length,
    0,
  );
});

for (const vscodeMode of [false, true]) {
  const mode = vscodeMode ? "VS Code" : "Browser";
  const discovery = (graph) => ({
    revision: graph.revision,
    checkedAt: "2026-11-10T12:00:00Z",
    features: [
      {
        name: "feature1",
        pr: 42,
        url: "https://github.test/pr/42",
        state: "OPEN",
        head: "a".repeat(40),
        ci: "PENDING",
        reviewDecision: "APPROVED",
        unresolvedThreads: 0,
        actionable: false,
      },
      {
        name: "feature3",
        pr: 43,
        url: "https://github.test/pr/43",
        state: "OPEN",
        head: "b".repeat(40),
        ci: "PASSING",
        unresolvedThreads: 0,
        actionable: false,
      },
    ],
  });
  test(`${mode} adopts a discovered PR in the sidebar, preserves drafts, and prevents duplicate operations`, async () => {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const e = await editor(vscodeMode, () => wait, new Map(), discovery);
    e.document
      .querySelector(".feature-card")
      .dispatchEvent(new e.window.Event("click"));
    await until(() => !e.document.getElementById("adopt-pr").hidden);
    assert.match(
      e.document.getElementById("pr-tracking").textContent,
      /PR #42 found · Not tracked/,
    );
    assert.equal(e.document.querySelector(".tools #adopt-pr"), null);
    // An old push preview must become unusable after adopting changes publication state.
    e.document.getElementById("open-push").click();
    e.document.getElementById("preview-push").click();
    await until(() => !e.document.getElementById("execute-push").disabled);
    e.document.getElementById("close-push").click();
    const title = e.document.getElementById("feature-title");
    title.value = "Unsaved draft";
    title.dispatchEvent(new e.window.Event("input"));
    const button = e.document.getElementById("adopt-pr");
    button.click();
    button.click();
    await until(() => e.calls.some((c) => c.route === "adopt"));
    assert.equal(e.calls.filter((c) => c.route === "adopt").length, 1);
    assert.equal(button.disabled, true);
    assert.equal(e.document.getElementById("open-push").disabled, true);
    assert.equal(e.document.getElementById("adopt-progress").hidden, false);
    const request = e.calls.find((c) => c.route === "adopt").body;
    assert.equal(request.name, "feature1");
    assert.equal(request.pr, 42);
    assert.equal(request.head, "a".repeat(40));
    assert.equal(request.revision, "v1");
    release();
    await until(
      () =>
        e.document.getElementById("pr-tracking").textContent ===
        "Tracking PR #42",
    );
    assert.equal(title.value, "Unsaved draft");
    assert.equal(button.hidden, true);
    assert.equal(e.document.getElementById("execute-push").disabled, true);
    assert.equal(e.document.getElementById("refresh").disabled, false);
    assert.equal(
      e.calls.some((c) => c.route === "push" && c.body?.dryRun === false),
      false,
    );
    assert.match(e.document.getElementById("graph").textContent, /PR #42/);
  });
  test(`${mode} shows adoption failures in the feature sidebar and permits retry`, async () => {
    let fail = true;
    const e = await editor(
      vscodeMode,
      () =>
        fail ? { error: "PR changed. Refresh before adopting." } : undefined,
      new Map(),
      discovery,
    );
    e.document
      .querySelector(".feature-card")
      .dispatchEvent(new e.window.Event("click"));
    const button = e.document.getElementById("adopt-pr");
    await until(() => !button.hidden);
    button.click();
    await until(() => !e.document.getElementById("adopt-error").hidden);
    assert.match(
      e.document.getElementById("adopt-error").textContent,
      /PR changed/,
    );
    assert.match(
      e.document.getElementById("pr-tracking").textContent,
      /Not tracked/,
    );
    assert.equal(button.disabled, false);
    fail = false;
    button.click();
    await until(
      () =>
        e.document.getElementById("pr-tracking").textContent ===
        "Tracking PR #42",
    );
    assert.equal(e.document.getElementById("adopt-error").hidden, true);
  });
  test(`${mode} disables adoption for features with unmet prerequisites`, async () => {
    const e = await editor(vscodeMode, undefined, new Map(), discovery);
    e.document
      .querySelectorAll(".feature-card")[2]
      .dispatchEvent(new e.window.Event("click"));
    const button = e.document.getElementById("adopt-pr");
    await until(() => !button.hidden);
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(
      e.calls.some((c) => c.route === "adopt"),
      false,
    );
    assert.match(button.title, /prerequisites/);
  });
}

for (const vscodeMode of [false, true]) {
  test(`${vscodeMode ? "VS Code" : "Browser"} continuous push previews blocked features and streams pending status with cancellation`, async () => {
    let finish;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    const { window, document, calls } = await editor(
      vscodeMode,
      async ({ body, graph, emit }) => {
        assert.equal(body.wait, true);
        graph.uiWorktree = {
          path: "/tmp/gh-prm-test",
          originalRoot: "/work/repo",
          branch: "work",
        };
        graph.pushRun = {
          worktree: graph.uiWorktree.path,
          id: "run1",
          status: "running",
          features: graph.groups.map((g) => ({
            name: g.name,
            status: g.ready ? "published" : "pending",
          })),
        };
        emit({
          type: "progress",
          command: "Waiting for PR merges",
          run: structuredClone(graph.pushRun),
          graph: structuredClone(graph),
        });
        await completed;
        graph.pushRun.status = "cancelled";
        return { run: graph.pushRun, pushed: [], previews: [] };
      },
    );
    const click = (id) =>
      document.getElementById(id).dispatchEvent(new window.Event("click"));
    click("open-push");
    const wait = document.getElementById("push-wait");
    wait.checked = true;
    wait.dispatchEvent(new window.Event("change"));
    assert.match(
      document.getElementById("push-wait-help").textContent,
      /isolated temporary checkout/,
    );
    assert.match(
      document.getElementById("push-wait-help").textContent,
      /becomes detached/,
    );
    click("preview-push");
    await until(() => !document.getElementById("push-plan").hidden);
    assert.equal(document.querySelectorAll("#push-actions li").length, 3);
    assert.match(
      document.getElementById("push-actions").textContent,
      /feature3.*wait for feature1, feature2/,
    );
    assert.equal(
      document.getElementById("execute-push").textContent,
      "Start push run (3 features)",
    );
    click("execute-push");
    await until(() => !document.getElementById("stop-push").hidden);
    assert.equal(document.getElementById("workspace-info").hidden, false);
    assert.match(
      document.getElementById("workspace-info").textContent,
      /\/tmp\/gh-prm-test/,
    );
    assert.match(
      document.getElementById("push-run-summary").textContent,
      /1 pending/,
    );
    assert.equal(
      document.querySelectorAll(".feature-card.push-pending").length,
      1,
    );
    assert.equal(document.querySelectorAll("#push-run-features li").length, 3);
    assert.equal(document.getElementById("push-wait").disabled, true);
    assert.equal(document.getElementById("close-push").disabled, false);
    assert.equal(document.getElementById("refresh").disabled, false);
    assert.equal(document.getElementById("open-push").disabled, true);
    assert.equal(document.getElementById("open-sync").disabled, true);
    const cancel = new window.Event("cancel", { cancelable: true });
    document.getElementById("push-dialog").dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, false);
    click("close-push");
    assert.equal(
      document.getElementById("push-dialog").hasAttribute("open"),
      false,
    );
    assert.equal(
      calls.some((c) => c.route === "push-stop"),
      false,
    );
    const reads = calls.filter((c) => c.route === "graph").length;
    click("refresh");
    await until(() => calls.filter((c) => c.route === "graph").length > reads);
    document
      .querySelector(".feature-card")
      .dispatchEvent(new window.Event("click"));
    document
      .getElementById("deps-form")
      .dispatchEvent(new window.Event("submit", { cancelable: true }));
    await until(() => calls.some((c) => c.route === "deps"));
    assert.equal(document.getElementById("error").hidden, true);
    click("view-push-run");
    assert.equal(
      document.getElementById("push-dialog").hasAttribute("open"),
      true,
    );
    assert.equal(
      calls.filter((c) => c.route === "push" && c.body?.dryRun === false)
        .length,
      1,
    );
    click("stop-push");
    await until(() => calls.some((c) => c.route === "push-stop"));
    assert.deepEqual(calls.find((c) => c.route === "push-stop").body, {
      id: "run1",
    });
    finish();
    await until(() =>
      document.getElementById("push-result").textContent.includes("cancelled"),
    );
    assert.equal(document.getElementById("stop-push").hidden, true);
    assert.equal(document.getElementById("push-wait").disabled, false);
  });

  test(`${vscodeMode ? "VS Code" : "Browser"} selected continuous pushes freeze only the chosen features and invalidate changed previews`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    const click = (id) =>
      document.getElementById(id).dispatchEvent(new window.Event("click"));
    click("open-push");
    click("push-choose");
    const choice = document.querySelectorAll("#push-features input")[2];
    choice.checked = true;
    choice.dispatchEvent(new window.Event("change"));
    click("preview-push");
    await until(() => !document.getElementById("push-plan").hidden);
    const wait = document.getElementById("push-wait");
    wait.checked = true;
    wait.dispatchEvent(new window.Event("change"));
    assert.equal(document.getElementById("push-plan").hidden, true);
    assert.match(
      document.getElementById("push-features").textContent,
      /waiting for prerequisites/,
    );
    click("preview-push");
    await until(() => !document.getElementById("push-plan").hidden);
    assert.deepEqual(
      calls.filter((c) => c.route === "push").at(-1).body.names,
      ["feature3"],
    );
    assert.equal(
      calls.filter((c) => c.route === "push").at(-1).body.wait,
      true,
    );
    assert.equal(document.querySelectorAll("#push-actions li").length, 1);
    click("execute-push");
    await until(() => !document.getElementById("push-result").hidden);
    assert.deepEqual(
      calls.filter((c) => c.route === "push" && !c.body.dryRun).at(-1).body
        .names,
      ["feature3"],
    );
  });
}

const coloredPatch = `commit abc
Author: Example

    Patch as text

diff --git a/demo.rs b/demo.rs
--- a/demo.rs
+++ b/demo.rs
@@ -1,2 +1,3 @@ fn demo()
-old
+<img src=x onerror=bad>
+extra
 context
@@ -20 +21 @@
-old tail
+new tail
diff --git a/image.bin b/image.bin
Binary files a/image.bin and b/image.bin differ
`;

for (const vscodeMode of [false, true]) {
  test(`${vscodeMode ? "VS Code" : "Browser"} colors diffs, toggles layouts without fetching again, remembers the choice, and collapses files/hunks`, async () => {
    const storage = new Map();
    if (vscodeMode) storage.set("vscode-state", { sidebarWidth: 410 });
    else storage.set("prm-sidebar-width", "410");
    const { window, document, calls } = await editor(
      vscodeMode,
      undefined,
      storage,
      undefined,
      async () => ({ diff: coloredPatch }),
    );
    const click = (id) =>
      document.getElementById(id).dispatchEvent(new window.Event("click"));
    assert.equal(document.getElementById("diff-collapse").disabled, true);
    document
      .querySelector(".commit-message")
      .dispatchEvent(new window.Event("click"));
    await until(() => document.querySelectorAll(".diff-file").length === 2);
    assert.equal(document.querySelectorAll(".diff-addition").length, 3);
    assert.equal(document.querySelectorAll(".diff-deletion").length, 2);
    assert.equal(document.querySelectorAll("#diff img").length, 0);
    assert.equal(
      document.getElementById("diff-unified").getAttribute("aria-pressed"),
      "true",
    );
    const file = document.querySelector(".diff-file");
    file.removeAttribute("open");
    document.querySelector(".diff-hunk").removeAttribute("open");
    click("diff-split");
    assert.equal(document.getElementById("diff").dataset.mode, "split");
    assert.equal(document.querySelectorAll(".diff-pane").length, 4);
    assert.equal(
      document.querySelector(".diff-file").hasAttribute("open"),
      false,
    );
    assert.equal(
      document.querySelector(".diff-hunk").hasAttribute("open"),
      false,
    );
    assert.equal(calls.filter((c) => c.route.startsWith("diff?")).length, 1);
    click("diff-expand");
    assert.ok(
      [...document.querySelectorAll("#diff details")].every((el) =>
        el.hasAttribute("open"),
      ),
    );
    click("diff-collapse");
    click("diff-unified");
    assert.ok(
      [...document.querySelectorAll("#diff details")].every(
        (el) => !el.hasAttribute("open"),
      ),
    );
    click("diff-split");
    const restored = await editor(vscodeMode, undefined, storage);
    assert.equal(
      restored.document
        .getElementById("diff-split")
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      restored.document.getElementById("diff-expand").disabled,
      true,
    );
    assert.equal(
      vscodeMode
        ? storage.get("vscode-state").sidebarWidth
        : storage.get("prm-sidebar-width"),
      vscodeMode ? 410 : "410",
    );
  });

  test(`${vscodeMode ? "VS Code" : "Browser"} keeps the newest diff request and clears stale content when a new request fails`, async () => {
    let resolveOld,
      requests = 0;
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const { window, document, calls } = await editor(
      vscodeMode,
      undefined,
      new Map(),
      undefined,
      async () => {
        requests++;
        if (requests === 1) return old;
        if (requests === 2)
          return { diff: coloredPatch.replaceAll("demo.rs", "current.rs") };
        return { error: "Patch unavailable" };
      },
    );
    const message = document.querySelector(".commit-message");
    message.dispatchEvent(new window.Event("click"));
    await until(
      () => calls.filter((c) => c.route.startsWith("diff?")).length === 1,
    );
    message.dispatchEvent(new window.Event("click"));
    await until(() =>
      document.querySelector(".diff-file")?.textContent.includes("current.rs"),
    );
    resolveOld({ diff: coloredPatch.replaceAll("demo.rs", "stale.rs") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      !document.getElementById("diff").textContent.includes("stale.rs"),
    );
    document
      .querySelectorAll(".commit-message")[1]
      .dispatchEvent(new window.Event("click"));
    await until(() =>
      document.getElementById("diff").textContent.includes("Patch unavailable"),
    );
    assert.equal(document.querySelectorAll(".diff-file").length, 0);
    assert.equal(document.getElementById("diff-expand").disabled, true);
  });
}

for (const vscodeMode of [false, true]) {
  test(`${vscodeMode ? "VS Code" : "Browser"} filters interleaved commit history by graph feature and clears from empty canvas or dependency edges`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    const click = (node) =>
      node.dispatchEvent(new window.Event("click", { bubbles: true }));
    const rows = () =>
      [...document.querySelectorAll("#commits tr")].map(
        (row) => row.dataset.sha[0],
      );
    const card = (name) =>
      [...document.querySelectorAll(".feature-card")].find((node) =>
        node.getAttribute("aria-label").startsWith(`${name}:`),
      );
    assert.deepEqual(rows(), ["1", "2", "3", "4", "5", "6"]);
    // Bubbling from a card child must not be mistaken for a canvas click after the SVG redraws.
    click(card("feature1").querySelector("text"));
    assert.deepEqual(rows(), ["1", "5"]);
    assert.match(
      document.getElementById("history-context").textContent,
      /feature1.*2 of 6/,
    );
    click(card("feature3"));
    assert.deepEqual(rows(), ["3", "4", "6"]);
    click(document.querySelector(".dependency-edge"));
    assert.deepEqual(rows(), ["1", "2", "3", "4", "5", "6"]);
    assert.equal(document.querySelectorAll(".feature-card.selected").length, 0);
    click(card("feature2"));
    assert.deepEqual(rows(), ["2"]);
    click(document.getElementById("graph"));
    assert.equal(rows().length, 6);
    click(card("feature1"));
    click(document.getElementById("graph-wrap"));
    assert.equal(rows().length, 6);
    assert.ok(
      !calls.some((call) =>
        ["tag", "deps", "metadata", "push"].includes(call.route),
      ),
    );
  });

  test(`${vscodeMode ? "VS Code" : "Browser"} switches between feature net diffs and commit patches and ignores late commit responses`, async () => {
    let resolvePending,
      requests = 0;
    const pendingPatch = new Promise((resolve) => {
      resolvePending = resolve;
    });
    const { window, document, calls } = await editor(
      vscodeMode,
      undefined,
      new Map(),
      undefined,
      async () => (++requests === 1 ? { diff: coloredPatch } : pendingPatch),
    );
    const click = (node) =>
      node.dispatchEvent(new window.Event("click", { bubbles: true }));
    const feature = (name) =>
      [...document.querySelectorAll(".feature-card")].find((node) =>
        node.getAttribute("aria-label").startsWith(`${name}:`),
      );
    click(feature("feature1"));
    await until(
      () =>
        document.getElementById("diff").textContent ===
        "Feature net diff for feature1",
    );
    assert.equal(
      document.getElementById("diff-title").textContent,
      "Feature: feature1 · 2 commits",
    );
    click(document.querySelector(".commit-message"));
    await until(() => document.querySelector(".diff-file"));
    click(feature("feature1"));
    await until(
      () =>
        document.getElementById("diff").textContent ===
        "Feature net diff for feature1",
    );
    assert.equal(document.querySelectorAll("#commits tr.selected").length, 0);
    click(feature("feature3"));
    await until(
      () =>
        document.getElementById("diff").textContent ===
        "Feature net diff for feature3",
    );
    assert.equal(
      document.getElementById("diff-title").textContent,
      "Feature: feature3 · 3 commits",
    );
    assert.equal(document.getElementById("metadata-panel").hidden, true);
    assert.equal(
      document.getElementById("inspector-title").textContent,
      "feature3",
    );
    click(feature("feature1"));
    click(document.querySelector(".commit-message"));
    await until(
      () => calls.filter((call) => call.route.startsWith("diff?")).length === 2,
    );
    click(feature("feature3"));
    await until(
      () =>
        document.getElementById("diff").textContent ===
        "Feature net diff for feature3",
    );
    resolvePending({ diff: coloredPatch });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      document.getElementById("diff").textContent,
      "Feature net diff for feature3",
    );
    click(document.getElementById("graph-wrap"));
    assert.equal(
      document.getElementById("diff").textContent,
      "Select a feature or commit to see its diff.",
    );
  });

  test(`${vscodeMode ? "VS Code" : "Browser"} ignores late feature diffs, refreshes net patches, and displays empty/error states`, async () => {
    let finish,
      response = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
    const { window, document, calls } = await editor(
      vscodeMode,
      undefined,
      new Map(),
      undefined,
      undefined,
      async (body) => response(body),
    );
    const click = (node) =>
      node.dispatchEvent(new window.Event("click", { bubbles: true }));
    const feature = (name) =>
      [...document.querySelectorAll(".feature-card")].find((node) =>
        node.getAttribute("aria-label").startsWith(`${name}:`),
      );
    click(feature("feature1"));
    await until(() => finish);
    click(document.querySelector(".commit-message"));
    await until(() =>
      document.getElementById("diff").textContent.includes("never execute"),
    );
    finish({ diff: "stale feature patch" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      !document.getElementById("diff").textContent.includes("stale feature"),
    );
    response = () => ({ diff: "" });
    click(feature("feature1"));
    await until(
      () =>
        document.getElementById("diff").textContent ===
        "No net changes in this feature.",
    );
    const count = calls.filter((call) => call.route === "feature-diff").length;
    response = () => ({ error: "Missing dependency" });
    click(document.getElementById("refresh"));
    await until(() =>
      document
        .getElementById("diff")
        .textContent.includes("Missing dependency"),
    );
    assert.ok(
      calls.filter((call) => call.route === "feature-diff").length > count,
    );
    finish = undefined;
    response = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    click(feature("feature3"));
    await until(() => finish);
    click(document.getElementById("graph-wrap"));
    finish({ diff: "late cleared patch" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      document.getElementById("diff").textContent,
      "Select a feature or commit to see its diff.",
    );
    assert.equal(document.getElementById("diff-expand").disabled, true);
  });

  test(`${vscodeMode ? "VS Code" : "Browser"} keeps filtering through commit inspection and refresh, supports keyboard selection, and restores edits and selections`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    const click = (node) =>
      node.dispatchEvent(new window.Event("click", { bubbles: true }));
    const check = document.querySelector("#commits input");
    check.checked = true;
    check.dispatchEvent(new window.Event("change"));
    // Opening a commit alone must not unexpectedly narrow the history.
    click(document.querySelector(".commit-message"));
    assert.equal(document.querySelectorAll("#commits tr").length, 6);
    const card = [...document.querySelectorAll(".feature-card")].find((node) =>
      node.getAttribute("aria-label").startsWith("feature3:"),
    );
    const enter = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    enter.key = "Enter";
    card.dispatchEvent(enter);
    assert.equal(document.querySelectorAll("#commits tr").length, 3);
    click(document.querySelectorAll(".commit-message")[1]);
    await until(() =>
      document.getElementById("diff").textContent.includes("never execute"),
    );
    assert.match(
      document.getElementById("inspector-title").textContent,
      /4444444/,
    );
    assert.equal(document.querySelectorAll("#commits tr").length, 3);
    const count = calls.filter((call) => call.route === "graph").length;
    click(document.getElementById("refresh"));
    await until(
      () => calls.filter((call) => call.route === "graph").length > count,
    );
    await until(() =>
      document.getElementById("notice").textContent.includes("refreshed"),
    );
    assert.equal(document.querySelectorAll("#commits tr").length, 3);
    document.getElementById("metadata-title").value = "Unsaved commit title";
    const escape = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    escape.key = "Escape";
    document.getElementById("graph-wrap").dispatchEvent(escape);
    assert.equal(document.querySelectorAll("#commits tr").length, 6);
    assert.equal(
      document.getElementById("metadata-title").value,
      "Unsaved commit title",
    );
    assert.equal(document.getElementById("metadata-panel").hidden, true);
    assert.equal(document.querySelector("#commits input").checked, true);
  });

  test(`${vscodeMode ? "VS Code" : "Browser"} shows an empty history for merged features and restores unassigned commits on canvas clear`, async () => {
    const { window, document } = await editor(
      vscodeMode,
      undefined,
      new Map(),
      (graph) => {
        graph.merged.finished = { pr: 42 };
        graph.commits[1].name = null;
        graph.groups = graph.groups.filter((g) => g.name !== "feature2");
        return {
          revision: graph.revision,
          checkedAt: new Date().toISOString(),
          features: [],
        };
      },
    );
    const click = (node) =>
      node.dispatchEvent(new window.Event("click", { bubbles: true }));
    click(document.getElementById("refresh"));
    await until(() =>
      [...document.querySelectorAll(".feature-card")].some((node) =>
        node.getAttribute("aria-label").startsWith("finished:"),
      ),
    );
    const card = [...document.querySelectorAll(".feature-card")].find((node) =>
      node.getAttribute("aria-label").startsWith("finished:"),
    );
    const space = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    space.key = " ";
    card.dispatchEvent(space);
    assert.equal(document.querySelectorAll("#commits tr").length, 0);
    assert.equal(document.getElementById("history-empty").hidden, false);
    assert.match(
      document.getElementById("history-empty").textContent,
      /No active commits in finished/,
    );
    click(document.getElementById("graph-wrap"));
    assert.equal(document.querySelectorAll("#commits tr").length, 6);
    assert.match(document.getElementById("commits").textContent, /Unassigned/);
    assert.equal(document.getElementById("history-empty").hidden, true);
  });
}

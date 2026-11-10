/* Shared, dependency-free Git patch renderer. Repository content is always text. */
globalThis.PrmDiff = (() => {
  function pathName(value, stripPrefix = true) {
    let name = value.split("\t")[0];
    if (name.startsWith('"') && name.endsWith('"')) {
      // Git quotes non-ASCII filename bytes as C-style octal escapes.
      const bytes = [];
      for (let i = 1; i < name.length - 1; i++) {
        if (name[i] !== "\\") {
          const code = name.codePointAt(i);
          bytes.push(...new TextEncoder().encode(String.fromCodePoint(code)));
          if (code > 0xffff) i++;
        } else {
          const octal = name.slice(i + 1).match(/^[0-7]{1,3}/);
          if (octal) {
            bytes.push(parseInt(octal[0], 8));
            i += octal[0].length;
          } else {
            const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
            const escaped = name[++i];
            bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
          }
        }
      }
      name = new TextDecoder().decode(new Uint8Array(bytes));
    }
    return stripPrefix ? name.replace(/^[ab]\//, "") : name;
  }

  function parseFile(lines) {
    const file = {
      title: lines[0].replace(/^diff --(?:git|cc|combined) /, ""),
      raw: lines.join("\n"),
      metadata: [],
      hunks: [],
      added: 0,
      deleted: 0,
      unsupported: !lines[0].startsWith("diff --git "),
    };
    let hunk = null,
      oldLine,
      newLine,
      oldSeen = 0,
      newSeen = 0;
    const validate = () => {
      if (hunk && (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount))
        file.unsupported = true;
    };
    for (const line of lines.slice(1)) {
      const header = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/,
      );
      if (header) {
        validate();
        hunk = {
          header: line,
          oldStart: Number(header[1]),
          oldCount: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newCount: header[4] === undefined ? 1 : Number(header[4]),
          rows: [],
        };
        if (
          ![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(
            Number.isSafeInteger,
          )
        )
          file.unsupported = true;
        file.hunks.push(hunk);
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
        oldSeen = newSeen = 0;
      } else if (hunk) {
        const kind = { " ": "context", "+": "addition", "-": "deletion" }[
          line[0]
        ];
        if (kind) {
          const row = {
            kind,
            text: line.slice(1),
            oldLine: null,
            newLine: null,
            notes: [],
          };
          if (kind !== "addition") {
            row.oldLine = oldLine++;
            oldSeen++;
          }
          if (kind !== "deletion") {
            row.newLine = newLine++;
            newSeen++;
          }
          if (kind === "addition") file.added++;
          if (kind === "deletion") file.deleted++;
          hunk.rows.push(row);
        } else if (
          line === "\\ No newline at end of file" &&
          hunk.rows.length
        ) {
          hunk.rows.at(-1).notes.push(line);
        } else file.unsupported = true;
      } else {
        file.metadata.push(line);
        if (line.startsWith("--- ")) file.oldPath = pathName(line.slice(4));
        if (line.startsWith("+++ ")) file.newPath = pathName(line.slice(4));
        if (/^(rename|copy) from /.test(line))
          file.oldPath = pathName(
            line.replace(/^(rename|copy) from /, ""),
            false,
          );
        if (/^(rename|copy) to /.test(line))
          file.newPath = pathName(
            line.replace(/^(rename|copy) to /, ""),
            false,
          );
        if (line.startsWith("@@")) file.unsupported = true;
        if (line.startsWith("Binary files ") || line === "GIT binary patch")
          file.binary = true;
      }
    }
    validate();
    const oldPath = file.oldPath === "/dev/null" ? null : file.oldPath;
    const newPath = file.newPath === "/dev/null" ? null : file.newPath;
    if (oldPath && newPath && oldPath !== newPath)
      file.title = `${oldPath} → ${newPath}`;
    else file.title = newPath || oldPath || file.title;
    return file;
  }

  function parsePatch(text) {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const preamble = [],
      sections = [];
    let current = preamble;
    for (const line of lines) {
      if (/^diff --(?:git|cc|combined) /.test(line)) {
        current = [];
        sections.push(current);
      }
      current.push(line);
    }
    return { preamble: preamble.join("\n"), files: sections.map(parseFile) };
  }

  // Pair consecutive removed/added blocks by position. Blank cells keep
  // insertions/deletions and their no-newline annotations aligned on both sides.
  function alignRows(rows) {
    const result = [];
    for (let i = 0; i < rows.length; ) {
      if (rows[i].kind === "context") {
        result.push([rows[i], rows[i]]);
        i++;
        continue;
      }
      const deleted = [],
        added = [];
      while (i < rows.length && rows[i].kind !== "context") {
        (rows[i].kind === "deletion" ? deleted : added).push(rows[i++]);
      }
      for (let n = 0; n < Math.max(deleted.length, added.length); n++)
        result.push([deleted[n] || null, added[n] || null]);
    }
    return result;
  }

  function createViewer(document, container, { mode = "unified" } = {}) {
    let model = null,
      layout = mode === "split" ? "split" : "unified";
    const collapsed = new Map();
    // Wrapped paths can change height as the inspector or window is resized.
    // Measure file headers so sticky hunk headers sit immediately beneath them.
    const ResizeObserver = document.defaultView?.ResizeObserver;
    const headerObserver = ResizeObserver
      ? new ResizeObserver((entries) => {
          for (const { target } of entries)
            target.parentElement.style.setProperty(
              "--diff-file-header-height",
              `${target.getBoundingClientRect().height}px`,
            );
        })
      : null;
    const node = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
    function disclosure(key, title, cls) {
      const el = node("details", undefined, cls);
      el.dataset.collapseKey = key;
      if (!collapsed.get(key)) el.setAttribute("open", "");
      el.addEventListener("toggle", () =>
        collapsed.set(key, !el.hasAttribute("open")),
      );
      el.append(node("summary", title));
      return el;
    }
    const number = (value) => {
      const cell = node(
        "td",
        value === null ? "" : String(value),
        "diff-number",
      );
      cell.setAttribute("aria-hidden", "true");
      return cell;
    };
    function code(row) {
      const cell = node(
        "td",
        undefined,
        `diff-code${row ? "" : " diff-blank"}`,
      );
      if (row) {
        const prefix = node(
          "span",
          { addition: "+", deletion: "-", context: " " }[row.kind],
          "diff-prefix",
        );
        prefix.setAttribute("aria-hidden", "true");
        const source = node(
          "span",
          row.text.replace(/\r/g, "␍"),
          "diff-source",
        );
        if (row.text.includes("\r")) source.title = "␍ marks a carriage return";
        cell.append(prefix, source);
      }
      return cell;
    }
    function table(label) {
      const el = node("table", undefined, "diff-lines");
      el.setAttribute("aria-label", label);
      return el;
    }
    function unified(hunk) {
      const wrap = node("div", undefined, "diff-unified-scroll"),
        grid = table("Unified patch");
      const body = node("tbody");
      for (const row of hunk.rows) {
        const tr = node("tr", undefined, `diff-${row.kind}`);
        tr.setAttribute(
          "aria-label",
          `${row.kind}, old line ${row.oldLine ?? "none"}, new line ${row.newLine ?? "none"}`,
        );
        tr.append(number(row.oldLine), number(row.newLine), code(row));
        body.append(tr);
        for (const note of row.notes) {
          const tr = node("tr", undefined, "diff-note");
          tr.append(number(null), number(null), node("td", note, "diff-code"));
          body.append(tr);
        }
      }
      grid.append(body);
      wrap.append(grid);
      return wrap;
    }
    function split(hunk) {
      const wrap = node("div", undefined, "diff-split");
      const panes = ["Old", "New"].map((label) => {
        const pane = node("div", undefined, "diff-pane");
        pane.tabIndex = 0;
        pane.setAttribute("role", "region");
        pane.setAttribute("aria-label", `${label} version`);
        const grid = table(`${label} version patch`),
          body = node("tbody");
        grid.append(body);
        pane.append(grid);
        wrap.append(pane);
        return { pane, body };
      });
      for (const pair of alignRows(hunk.rows)) {
        for (let side = 0; side < 2; side++) {
          const row = pair[side],
            tr = node("tr", undefined, row ? `diff-${row.kind}` : "diff-empty");
          tr.append(
            number(row ? (side === 0 ? row.oldLine : row.newLine) : null),
            code(row),
          );
          panes[side].body.append(tr);
        }
        const notes = Math.max(...pair.map((row) => row?.notes.length || 0));
        for (let n = 0; n < notes; n++)
          for (let side = 0; side < 2; side++) {
            const tr = node("tr", undefined, "diff-note");
            tr.append(
              number(null),
              node("td", pair[side]?.notes[n] || "", "diff-code"),
            );
            panes[side].body.append(tr);
          }
      }
      const synchronized = new Map();
      for (let side = 0; side < 2; side++)
        panes[side].pane.addEventListener("scroll", () => {
          const source = panes[side].pane,
            target = panes[1 - side].pane;
          if (synchronized.get(source) === source.scrollLeft) {
            synchronized.delete(source);
            return;
          }
          synchronized.delete(source);
          if (target.scrollLeft !== source.scrollLeft) {
            target.scrollLeft = source.scrollLeft;
            // A shorter pane can clamp this offset. Its resulting scroll event
            // must not pull the longer pane back and hide the end of a long line.
            synchronized.set(target, target.scrollLeft);
          }
        });
      return wrap;
    }
    function render() {
      if (!model) return;
      for (const el of container.querySelectorAll("details"))
        collapsed.set(el.dataset.collapseKey, !el.hasAttribute("open"));
      headerObserver?.disconnect();
      const content = document.createDocumentFragment();
      container.dataset.mode = layout;
      if (model.preamble)
        content.append(node("pre", model.preamble, "diff-preamble"));
      for (const [i, file] of model.files.entries()) {
        const section = disclosure(`file:${i}`, file.title, "diff-file");
        const summary = section.querySelector("summary");
        summary.title = file.title;
        const stats = node("span", undefined, "diff-stats");
        if (!file.binary && file.hunks.length) {
          stats.append(
            node("span", `+${file.added}`, "diff-stat-added"),
            document.createTextNode(" "),
            node("span", `−${file.deleted}`, "diff-stat-deleted"),
          );
          stats.setAttribute(
            "aria-label",
            `${file.added} added, ${file.deleted} removed`,
          );
        } else
          stats.textContent = file.binary ? "Binary file" : "Metadata only";
        summary.append(stats);
        if (file.unsupported) {
          section.append(
            node(
              "p",
              "This patch format is shown as text.",
              "diff-format-note",
            ),
            node("pre", file.raw, "diff-fallback"),
          );
        } else {
          if (file.metadata.length)
            section.append(
              node("pre", file.metadata.join("\n"), "diff-file-meta"),
            );
          for (const [j, hunk] of file.hunks.entries()) {
            const group = disclosure(
              `hunk:${i}:${j}`,
              hunk.header,
              "diff-hunk",
            );
            group.append(layout === "split" ? split(hunk) : unified(hunk));
            section.append(group);
          }
        }
        content.append(section);
      }
      container.replaceChildren(content);
      for (const summary of container.querySelectorAll(".diff-file > summary"))
        headerObserver?.observe(summary);
    }
    return {
      get mode() {
        return layout;
      },
      get hasFiles() {
        return !!model?.files.length;
      },
      setPatch(text) {
        container.replaceChildren();
        collapsed.clear();
        model = parsePatch(text);
        render();
      },
      setMessage(text) {
        headerObserver?.disconnect();
        model = null;
        collapsed.clear();
        container.replaceChildren(node("p", text, "diff-message"));
      },
      setMode(value) {
        layout = value === "split" ? "split" : "unified";
        render();
      },
      setExpanded(expanded) {
        for (const el of container.querySelectorAll("details")) {
          if (expanded) el.setAttribute("open", "");
          else el.removeAttribute("open");
          collapsed.set(el.dataset.collapseKey, !expanded);
        }
      },
    };
  }
  return Object.freeze({ parsePatch, alignRows, createViewer });
})();

import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { run } from "./core.js";
import { pushRequest, operationRequest } from "./requests.js";
import { requestBridge } from "./operations.js";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/diff.js": ["diff.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
};

export function createServer(
  manager,
  token = randomBytes(32).toString("hex"),
  { operation } = {},
) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (
        req.headers.host !== expectedHost ||
        (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)
      )
        return reply(403, { error: "Local requests only." });
      const url = new URL(req.url, `http://${expectedHost}`);
      if (url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(req.headers["x-prm-token"] || "");
        const secret = Buffer.from(token);
        if (
          supplied.length !== secret.length ||
          !timingSafeEqual(supplied, secret)
        )
          return reply(403, { error: "Invalid session token." });
        if (req.method === "GET" && url.pathname === "/api/graph")
          return reply(200, manager.graph());
        if (req.method === "GET" && url.pathname === "/api/pr-status") {
          const result = operation
            ? await operation("pr-status", undefined)
            : await requestBridge(
                manager.root,
                fileURLToPath(new URL("./bridge.js", import.meta.url)),
                { route: "pr-status" },
              );
          return reply(200, result);
        }
        if (req.method === "GET" && url.pathname === "/api/diff") {
          const sha = url.searchParams.get("sha");
          if (!manager.graph().commits.some((c) => c.sha === sha))
            throw new Error("Unknown commit.");
          return reply(200, {
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
          });
        }
        if (req.method !== "POST")
          return reply(405, { error: "Method not allowed." });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 64 * 1024)
            return reply(413, { error: "Request too large." });
        }
        const data = JSON.parse(body);
        if (url.pathname === "/api/push-stop")
          return reply(200, operationRequest(manager, "push-stop", data));
        if (data.revision !== manager.graph().revision)
          return reply(409, {
            error: "The repository changed. Refresh before editing.",
          });
        if (
          ["/api/sync", "/api/adopt"].includes(url.pathname) ||
          (url.pathname === "/api/push" && data.dryRun === false)
        ) {
          const route = url.pathname.slice(5);
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          const emit = (event) => {
            if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
          };
          const controller = new AbortController();
          const disconnect = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.on("close", disconnect);
          try {
            const result = operation
              ? await operation(route, data, emit)
              : await requestBridge(
                  manager.root,
                  fileURLToPath(new URL("./bridge.js", import.meta.url)),
                  { route, data },
                  emit,
                  { signal: controller.signal },
                );
            emit({ type: "result", result });
          } catch (error) {
            emit({ type: "error", error: error.message });
          }
          res.off("close", disconnect);
          res.end();
          return;
        }
        if (url.pathname === "/api/push")
          return reply(200, pushRequest(manager, data));
        if (url.pathname === "/api/metadata")
          return reply(
            200,
            manager.metadata(data.sha, data.overrides, data.revision),
          );
        if (url.pathname === "/api/branch")
          return reply(
            200,
            manager.branchName(data.name, data.branchName, data.revision),
          );
        if (
          url.pathname === "/api/deps" &&
          Array.isArray(data.deps) &&
          data.deps.every((x) => typeof x === "string")
        )
          return reply(200, manager.dependencies(data.name, data.deps));
        if (
          url.pathname === "/api/tag" &&
          Array.isArray(data.commits) &&
          data.commits.length &&
          data.commits.every((x) => typeof x === "string")
        )
          return reply(200, manager.tag(data.name, data.commits));
        return reply(400, { error: "Unknown operation or invalid request." });
      }
      if (req.method !== "GET" || !assets[url.pathname])
        return reply(404, { error: "Not found." });
      const [file, type] = assets[url.pathname];
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      res.end(fs.readFileSync(`${ui}/${file}`));
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  return { server, token };
}

export async function serve(manager, { port = 0, open = true } = {}) {
  manager.graph(); // Fail before launching if uninitialized or on the wrong branch.
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port.");
  const { server, token } = createServer(manager);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/#token=${token}`;
  console.log(url);
  console.log("PR Manager is running locally. Press Ctrl+C to stop.");
  if (open) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () =>
      console.error("Open the URL above in your browser."),
    );
    child.unref();
  }
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { server, url };
}

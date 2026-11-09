import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
};

export function createServer(manager, token = randomBytes(32).toString("hex")) {
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
        if (req.method === "GET" && url.pathname === "/api/diff") {
          const sha = url.searchParams.get("sha");
          if (!manager.graph().commits.some((c) => c.sha === sha))
            throw new Error("Unknown commit.");
          return reply(200, {
            diff: manager.git(
              "show",
              "--format=fuller",
              "--no-ext-diff",
              "--no-textconv",
              sha,
              "--",
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
        if (data.revision !== manager.graph().revision)
          return reply(409, {
            error: "The repository changed. Refresh before editing.",
          });
        if (url.pathname === "/api/metadata")
          return reply(
            200,
            manager.metadata(data.sha, data.overrides, data.revision),
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

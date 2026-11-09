import { parseArgs } from "node:util";
import { Manager } from "./core.js";
import { serve } from "./server.js";

const help = `gh prm — parallel PRs from a single working branch

  init --base BRANCH [--remote origin] [--repo https://HOST/OWNER/REPO]
  tag FEATURE [COMMIT ...]         Assign commits (defaults to HEAD)
  deps FEATURE [DEPENDENCY ...]    Replace dependencies; --clear removes all
  status [--json]                  Show groups and readiness (local snapshot)
  push [FEATURE ...] [--dry-run]   Publish ready groups; named blocked groups get
                                  full-history preview branches, without PRs
  sync [--dry-run]                 Fetch base; remove merged groups; replay work
  sync --continue | --abort       Resolve/abort a paused sync
  view [--port 0] [--no-open]      Open the interactive local graph editor
  view --json | --dot              Export the graph without a server
  notes push | pull                Explicitly share refs/notes/prm (fast-forward)

Requires Git, gh authentication, and Node.js 22+. Dependencies must MERGE before
a group is published. Mutations never auto-stash. push publishes; sync is local.
`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      base: { type: "string" },
      remote: { type: "string" },
      repo: { type: "string" },
      json: { type: "boolean" },
      dot: { type: "boolean" },
      clear: { type: "boolean" },
      "dry-run": { type: "boolean" },
      continue: { type: "boolean" },
      abort: { type: "boolean" },
      "no-open": { type: "boolean" },
      port: { type: "string" },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) {
    console.log("0.1.0");
    return;
  }
  if (!command || values.help) {
    console.log(help);
    return;
  }
  const manager = new Manager();
  let result;
  switch (command) {
    case "init":
      result = manager.init(values);
      break;
    case "tag": {
      const [name, ...revs] = args;
      result = manager.tag(name, revs.length ? revs : ["HEAD"]);
      break;
    }
    case "deps": {
      if (!args.length || (args.length === 1 && !values.clear))
        throw new Error(
          "Use deps FEATURE DEPENDENCY ... or deps FEATURE --clear.",
        );
      if (values.clear && args.length > 1)
        throw new Error("--clear cannot be combined with dependencies.");
      result = manager.dependencies(args[0], args.slice(1));
      break;
    }
    case "status":
      result = manager.graph();
      break;
    case "push":
      result = manager.push({ dryRun: values["dry-run"], names: args });
      break;
    case "sync": {
      if (
        [values.continue, values.abort, values["dry-run"]].filter(Boolean)
          .length > 1
      )
        throw new Error("Use only one of --continue, --abort or --dry-run.");
      result = manager.sync({
        dryRun: values["dry-run"],
        continue: values.continue,
        abort: values.abort,
      });
      break;
    }
    case "view":
      if (values.dot) {
        console.log(manager.dot());
        return;
      }
      if (values.json) {
        result = manager.graph();
        break;
      }
      await serve(manager, {
        port: Number(values.port || 0),
        open: !values["no-open"],
      });
      return;
    case "notes":
      result = manager.shareNotes(args[0]);
      break;
    default:
      throw new Error(`Unknown command ${command}.\n${help}`);
  }
  if (values.json || !result?.groups)
    console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.branch} → ${result.base}\n`);
    for (const g of result.groups)
      console.log(
        `${g.ready ? "●" : "○"} ${g.name}  ${g.commits.length} commit(s)  ${g.pr ? `PR #${g.pr}` : g.status}${g.blockedBy.length ? `  waits for ${g.blockedBy.join(", ")}` : ""}`,
      );
    const unassigned = result.commits.filter((c) => !c.name);
    if (unassigned.length)
      console.log(
        `\n${unassigned.length} unassigned commit(s); use gh prm tag.`,
      );
    if (result.paused)
      console.log("\nSync paused; use gh prm sync --continue or --abort.");
  }
}

main().catch((error) => {
  console.error(`prm: ${error.message}`);
  process.exitCode = 1;
});

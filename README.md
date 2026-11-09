# PR Manager

Manage parallel pull requests from one linear working branch. Git notes assign
commits to features and declare dependencies. Ready features get isolated PR
branches; dependent features wait until their prerequisites **merge**.

The source branch can contain interleaved work. For example, `A C D E F` can
contain feature1's `A E` and feature3's `C D F`. PR Manager extracts each ready
feature rather than including every earlier commit in its PR.

## Install

Requires **Node.js 22+**, Git 2.36+, and an authenticated GitHub CLI. No npm
dependencies or compilation are required for the CLI or browser UI.

```sh
git clone git@github.com:yperess/gh-pr-manager.git
cd gh-pr-manager
gh extension install .
gh alias set prm pr-manager
gh prm --help
```

The repository's extension name is `pr-manager`; the alias makes the command
`gh prm`. Both launchers are included. The normal `gh pr` commands are unaffected.

For local development, run `/path/to/gh-pr-manager/gh-prm` directly from a target
repository. A locally installed gh extension points at this checkout.

## Start a workflow

```sh
git switch -c work/ontology-migration origin/develop
gh prm init --base develop
# Optional overrides:
# gh prm init --base main --remote origin --repo https://HOST/OWNER/REPO

# Make normal git commits on this one working branch.
gh prm tag feature1 <A>
gh prm tag feature2 <B>
gh prm tag feature3 <C> <D>
gh prm deps feature3 feature1 feature2
gh prm status
gh prm view
```

`init` records the current branch and remote base. It refuses to manage the
trunk itself. This first version manages one integration branch per clone;
linked worktrees share its configuration and lock. It works with standard PR
APIs through `gh`, including authenticated GitHub Enterprise hosts, without
requiring GitHub's native stacked-PR APIs.

## Notes are the feature model

Assignments live in **`refs/notes/prm`**, separate from normal Git notes:

```text
prm-name: feature3
prm-deps: feature1, feature2
```

Each commit has at most one feature. A dependency list may appear on any commit
in a group; the group's dependencies are the union of these lists. `deps`
replaces that union with a canonical list on the first commit, preserving
unrelated note text. It rejects cycles, unknown features, and self-dependencies.

```sh
gh prm tag feature1             # HEAD by default
gh prm tag feature3 HEAD~2 HEAD # individual revisions, not ranges
gh prm deps feature3 feature1 feature2
gh prm deps feature3 --clear
git notes --ref=prm show HEAD
```

`init` adds this namespace to `notes.rewriteRef`, so ordinary Git amend/rebase
operations can carry the notes forward. PR Manager explicitly copies notes
during its own history rewrites. Notes on original commits are retained.

Notes aren't transferred by normal branch pushes. Share them explicitly:

```sh
gh prm notes push
gh prm notes pull
```

These are fast-forward operations. Divergent note histories require a manual
`git notes --ref=prm merge`; the tool does not overwrite someone else's notes.
PR numbers and published source-commit mappings are currently local metadata in
the Git common directory's `prm/state.json`; notes alone do not restore an
existing workflow on another clone.

## Publish ready work, or push a named preview

### PR metadata at each commit

Select a commit in the browser graph editor or VS Code view to see its PR title
and description **as of that commit**. Each field inherits the last explicit
value on an earlier commit in the same feature. Later commits and commits from
other features do not affect this historical view. The feature inspector shows
the latest effective values. Both views identify the source commit for each field.

Enable **Override title/description at this commit** to set a value. Uncheck it
to remove that commit's override and inherit again. An enabled, empty description
explicitly clears the description; it is different from an absent override.
Without any title override, the title defaults to the feature name. Without any
description override, PR creation uses the generated description.

Overrides are ordinary note fields:

```text
prm-name: feature3
prm-title: Migrate struct fixtures to ontology builder
prm-description: "Replace manual setup.\n\nAddresses PR3 of #1475"
```

The editor encodes descriptions as JSON strings to preserve multiline Markdown,
trailing newlines, and literal `prm-*` lines. Manual indented blocks are also
supported using `prm-description: |` followed by two-space-indented lines.
Duplicate title/description fields within one commit are rejected; overrides
across commits follow commit order, independently for each field.

Saving edits changes notes only and does not rewrite commit IDs. **New PRs use
the effective title and description.** Subsequent pushes don't overwrite titles
or descriptions already edited on GitHub; use `gh pr edit` for remote updates.

```sh
gh prm push --dry-run
gh prm push
gh prm push feature2 feature3 --dry-run
gh prm push feature2 feature3
```

Without names, `push` publishes **all ready groups**, independently, and reports
blocked groups. Untagged commits must be assigned before a default push.

With names, only those features are selected:

* A **ready** feature is replayed onto the remote base in a temporary worktree.
  Only its own commits go on `prm/FEATURE`. A PR is created against the base, or
  the existing PR branch is updated with an explicit force-with-lease.
* A **blocked** feature gets a **preview branch** at the working branch's full
  current HEAD. This intentionally includes all current linear history,
  including unrelated groups and any unassigned commits. **No PR is created.**
  Once its prerequisites merge and `sync` records them, its next push replaces
  the preview with an isolated projection and creates the PR.

Independent PRs can therefore be reviewed and merged in either order. A group's
placement in the source log doesn't itself establish a dependency. If a ready
group cannot be extracted cleanly, add the actual prerequisite or make the
commits independent. All ready projections are built before publication starts.
Remote/API failures can still leave a partially published batch; successful
branch pushes are recorded before PR creation so rerunning can recover it.

PR titles default to feature names; use normal `gh pr edit` to edit the title
and description. The tool doesn't overwrite review descriptions on updates.
Closed PRs require manual reopening. It won't turn a published PR into a
full-history preview by adding unmet dependencies.

## Review updates and sync

```sh
# Commit E fixes feature1; F adds to feature3.
gh prm tag feature1 <E>
gh prm tag feature3 <F>
gh prm push feature1

# After feature2 merges:
gh prm sync --dry-run
gh prm sync
# A C D E F remain, rebased onto the base that contains B.
gh prm push
# Updates feature1 with A E. feature3 still waits.

# After feature1 merges:
gh prm sync
# C D F remain. Both prerequisites are satisfied.
gh prm push
# Creates feature3's PR with C D F.
```

`sync` fetches the base and reads the state of tracked PRs. It uses actual PR
merge status and the last published projection, rather than commit ancestry,
so **squash merges work**. Only published commits in merged groups are removed.
If a merged group has unpublished local commits, sync stops: reassign those
commits to a new follow-up feature before continuing.

Sync builds the replacement history in a separate worktree. Your working branch
stays untouched until replay finishes. A successful sync preserves the old tip
under `refs/prm/backups/...`, then advances the managed working branch. It does
**not** push anything, delete remote branches, or delete unrelated local branches.

If replay conflicts:

```sh
# The error prints the recovery worktree's path.
git -C /path/printed/by/prm status
# Resolve files there, then stage them there:
git -C /path/printed/by/prm add <resolved-files>
gh prm sync --continue
# Or discard the replay worktree, leaving the source branch unchanged:
gh prm sync --abort
```

Keep the managed source branch unchanged during recovery. The journal is stored
in the Git common directory's `prm/sync.json`. Backups can be inspected with
`git for-each-ref refs/prm/backups`; create a recovery branch at any backup ref
with `git branch recovery <backup-ref>`. Backups are retained until explicitly
deleted with Git.

## Graph editor

```sh
gh prm view                     # local browser app; Ctrl+C stops the server
gh prm view --no-open --port 8080
gh prm view --dot > graph.dot    # Graphviz DOT, including commits and groups
gh prm view --json               # full machine-readable graph
```

The editor shows the dependency DAG, grouped commit history, and commit patches.
Select a feature to add/remove prerequisites; select commits to assign a group.
Editing changes notes only. Refresh reads external Git changes. The viewer
doesn't publish or rewrite history. It binds to loopback, requires a random
session token for API calls, rejects foreign origins, and uses no external assets.

## VS Code

```sh
npm run package:vscode
code --install-extension dist/pr-manager-0.1.0.vsix
```

Packaging uses the pinned `@vscode/vsce` packager through `npx` (network needed
on first use). The installed extension bundles the core and graph editor; it
doesn't require the gh extension to be installed. Git and authenticated `gh`
must be available to the VS Code extension host.

Open a trusted local workspace, initialize it using the CLI, then run
**PR Manager: Open Dependency Graph** from the Command Palette. The webview has
the same assignment, dependency editing, and patch inspection controls as the
browser app. Git commands run in a separate process. Multi-root workspaces
prompt for the repository to view.

## Development and scope

```sh
npm test
npm run check
node scripts/demo.js            # creates a disposable A–F sample repo
```

Run `npm ci` once before development checks; the DOM renderer tests use a
development-only dependency. The installed CLI and viewer remain dependency-free.

Tests use real temporary Git repositories and local bare remotes, with a fake
GitHub API; they never create real PRs. They cover the A–F scenario, named
preview branches, isolation, squash-merge sync, note preservation, conflicts,
recovery, remote collisions, and editor HTTP authorization.

This initial version supports **linear source history** and one working branch
per clone. Merge commits are rejected by push/sync. Generated commits preserve
author and committer metadata, but are unsigned; repositories requiring signed
commits need signing support before using publication. Dependencies represent
merge gates, not automatic semantic dependency detection: a cherry-pick that
applies cleanly can still need code from another feature. Run the target
repository's own tests on PR projections as appropriate.

`push --dry-run` is local and publishes nothing; readiness reflects the last
sync. `sync --dry-run` fetches and reads PR status but does not rewrite the source
branch. Git notes, published mappings, backups, and journals are local Git
metadata, not files committed into the target repository. Managed commands use
a clone-wide lock; don't run external Git mutations concurrently with them.

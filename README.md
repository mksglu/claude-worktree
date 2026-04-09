# vibetree

Persistent named workspaces for Claude Code. Work on three branches simultaneously, close your terminal, come back tomorrow — everything is exactly where you left it.

## The Problem

Claude Code's worktree mode is destructive by design. Every session exit nukes the worktree:

```
$ claude --worktree
# ... 2 hours of work, building auth system ...
# exit session

$ ls .worktrees/
# nothing. gone. the worktree, the session, the environment — deleted.
```

Your session history, your carefully built context, your half-finished refactor — all destroyed the moment you close the terminal. There is no `--continue` for worktree mode. That flag is gated to Anthropic internal builds (KAIROS). External users get nothing.

Without worktrees, you're stuck doing the stash dance every time you context-switch:

```
# working on auth feature...
$ git stash
$ git checkout api-refactor
# work on API...
$ git stash
$ git checkout auth-feature
$ git stash pop
# pray nothing conflicts
```

Multiply this by 3-4 parallel tasks per day and you're spending more time managing git state than writing code.

And if you want true parallel isolation — auth + api + tests running in separate terminals on separate branches — you're managing worktrees by hand, wiring up sessions manually, and losing everything on exit anyway.

## The Fix

One install. Your worktrees persist. Your sessions resume. No configuration.

```
# before: worktree destroyed on exit, no resume
$ claude --worktree
# exit → gone forever

# after: named workspace, survives exit, resumes automatically
$ claude auth
# exit → come back tomorrow
$ claude auth
# picks up exactly where you left off
```

## Quick Start

```bash
npm i -g vibetree
claude auth --skip-permissions    # creates workspace "auth", launches claude
# ... work, exit, come back tomorrow ...
claude auth --skip-permissions    # resumes where you left off
```

That's it. No setup, no config files, no env vars.

## How It Works

vibetree installs a shim at `~/.vibetree/shims/claude` that intercepts the `claude` command transparently. Your shell doesn't know the difference.

**Inside a git repo:**
- Creates a real `git worktree` at `.vibetree/<name>/` with an isolated branch
- Session files persist at `~/.claude/projects/{path}/`
- Resume uses `claude --continue` (standard CLI feature, not KAIROS-gated)

**Outside a git repo:**
- Creates a standalone workspace directory with `git init`
- Same persistence, same resume behavior

**Shell integration:**
- Shim lives at `~/.vibetree/shims/` — prepended to `$PATH`
- Works in every shell without per-shell configuration
- Original `claude` binary remains untouched and accessible via `vibetree passthrough`

## Commands

| Command | What it does |
|---------|-------------|
| `claude auth` | Create or resume workspace "auth" |
| `claude ls` | List all workspaces |
| `claude rm auth` | Remove workspace and its worktree |
| `claude auth --new` | Force a fresh session (discard previous) |
| `vibetree install` | Set up the claude shim |
| `vibetree uninstall` | Remove shim, restore original claude |

## Parallel Worktrees

This is the killer feature. One repo, multiple isolated branches, multiple Claude sessions, zero conflicts:

```
~/myrepo/                          <- main branch (untouched)
~/myrepo/.vibetree/auth/           <- auth feature (isolated branch)
~/myrepo/.vibetree/api/            <- api work (isolated branch)
~/myrepo/.vibetree/tests/          <- test writing (isolated branch)
```

Run them simultaneously:

```bash
# terminal 1
$ claude auth --skip-permissions
# building auth system on feature/auth branch

# terminal 2
$ claude api --skip-permissions
# refactoring API routes on feature/api branch

# terminal 3
$ claude tests --skip-permissions
# writing integration tests on feature/tests branch
```

3 terminals, 3 branches, 3 Claude sessions, zero conflicts. Each workspace has its own branch, its own working directory, and its own persistent session. No stashing. No checkout juggling. No lost context.

## Cross-Platform

Works everywhere Claude Code runs:

- **macOS** — zsh, bash, fish
- **Linux** — bash, zsh, fish, nushell
- **Windows** — PowerShell, cmd, nushell

The shim mechanism is shell-agnostic. If your shell supports `$PATH` (they all do), vibetree works.

## Uninstall

```bash
vibetree uninstall && npm rm -g vibetree
```

Clean removal. The shim is deleted, your `$PATH` is restored, and the original `claude` command works as before. Your workspaces in `.vibetree/` directories are left intact — delete them manually if you want.

## License

MIT

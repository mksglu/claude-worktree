# X Post Options for claude-worktree

---

## OPTION 1 — The "Rage Discovery" angle

```
Claude Code deletes your worktree every time you exit.

Not a bug. By design.

You run `claude --worktree`. You spend 2 hours building an auth system. You build context. You iterate. You get deep into the codebase.

You close the terminal.

$ ls .worktrees/
# nothing. gone.

The worktree. The session. The environment. Deleted.

There IS a `--continue` flag for worktree mode. But it's gated to Anthropic internal builds (KAIROS). External users get nothing. The bridge function `removeAgentWorktree` nukes everything on exit. That's the code path. That's what ships.

So you're stuck doing this dance every day:

$ git stash
$ git checkout api-refactor
# work...
$ git stash
$ git checkout auth-feature
$ git stash pop
# pray nothing conflicts

Multiply by 3-4 parallel tasks. You spend more time managing git state than writing code.

I got tired of this. So I built claude-worktree.

One npm install. Named workspaces that persist. Sessions that resume. Parallel git worktree isolation that doesn't self-destruct.

npm i -g claude-worktree

How it works:

$ claude auth
# creates workspace "auth" on isolated branch
# launches Claude Code inside it
# ... work, exit, come back tomorrow ...

$ claude auth
# resumes exactly where you left off

The real power — parallel sessions:

# terminal 1
$ claude auth
# building auth on feature/auth branch

# terminal 2
$ claude api
# refactoring API on feature/api branch

# terminal 3
$ claude tests
# writing tests on feature/tests branch

3 terminals. 3 branches. 3 Claude sessions. Zero conflicts. No stashing. No checkout juggling.

Your main branch stays untouched:

~/myrepo/              <- main (untouched)
~/myrepo/.cw/auth/     <- isolated branch
~/myrepo/.cw/api/      <- isolated branch
~/myrepo/.cw/tests/    <- isolated branch

Works from anywhere. Inside a git repo — real worktrees. Outside — auto-inits one. Transparent shim, your shell doesn't know the difference.

$ claude ls          # list all workspaces
$ claude rm auth     # remove one
$ claude auth --new  # fresh start

npm i -g claude-worktree
github.com/mksglu/claude-worktree

Star it if you've lost a worktree session before. You know who you are.
```

---

## OPTION 2 — The "Senior Dev PSA" angle

```
PSA for Claude Code users: your worktree sessions are not being saved.

I know some of you have discovered this the hard way.

You use `claude --worktree` thinking you're getting isolation. And you are — until you exit. Then the worktree is destroyed. The session is gone. The 2 hours of context you built? Deleted. The branch, the working directory, the environment. All of it.

This is not a bug. This is the code path: `removeAgentWorktree` runs on exit. Every time.

"Just use --continue" — doesn't work for worktree mode. That feature is gated to internal Anthropic builds. They call it KAIROS. You don't have access to it. Neither do I.

So what do you do? You stop using worktrees. You go back to the stash dance:

git stash → git checkout → work → git stash → git checkout → git stash pop → pray

3-4 context switches per day. Half your time managing git state instead of shipping.

This is broken. So I fixed it.

claude-worktree — persistent named workspaces for Claude Code.

npm i -g claude-worktree

That's the entire setup. One command. The shim installs automatically.

Now instead of:

$ claude --worktree
# exit = destroyed forever

You do:

$ claude auth
# exit = workspace persists

$ claude auth
# picks up exactly where you left off

But here's the feature that changes everything — parallel worktrees:

$ claude auth    # terminal 1, feature/auth branch
$ claude api     # terminal 2, feature/api branch
$ claude tests   # terminal 3, feature/tests branch

3 isolated branches. 3 persistent sessions. 3 simultaneous Claude instances. Zero conflicts. Your main branch is never touched.

Each workspace lives in .cw/<name>/ with its own git branch. Real git worktrees, not copies. Lightweight. Fast.

Commands:

claude auth          # create or resume
claude ls            # list workspaces
claude rm auth       # delete workspace
claude auth --new    # fresh session

Works inside any git repo. Works outside git repos too (auto-inits). Every shell. macOS, Linux, WSL.

npm i -g claude-worktree
github.com/mksglu/claude-worktree

This shouldn't have been necessary to build. But here we are.
```

---

## OPTION 3 — The "Before/After" angle

```
The worst thing about Claude Code's worktree mode is that it works great — until you exit.

Then everything you built is gone.

I'm not exaggerating. Here's what happens:

$ claude --worktree
# 2 hours deep. Auth system half-built.
# Context is perfect. Claude knows the codebase.
# You close the terminal.

$ ls .worktrees/
# empty. everything destroyed.

The worktree, the branch, the session, the context window you spent 2 hours building — all deleted on exit. The internal function `removeAgentWorktree` fires every time. No option to persist. No resume.

"What about --continue?"

Doesn't exist for worktree mode. Well — it does. Internally. Anthropic's own engineers have it. It's called KAIROS. You don't get it. Neither does anyone outside Anthropic.

So every Claude Code user doing real multi-task work is stuck doing this:

$ git stash
$ git checkout other-branch
$ git stash
$ git checkout original-branch
$ git stash pop
# did that conflict? great.

I built the fix.

BEFORE claude-worktree:
- Worktrees destroyed on every exit
- No session resume for worktree mode
- Manual git stash/checkout dance
- One Claude session at a time per repo
- Context lost, work lost, time lost

AFTER claude-worktree:
- Named workspaces that persist across exits
- Sessions resume automatically
- Parallel isolated branches from one repo
- Multiple simultaneous Claude sessions
- Zero configuration

npm i -g claude-worktree

Setup done. Here's what your workflow looks like now:

$ claude auth
# creates workspace "auth", isolated branch, launches Claude
# work for 2 hours, exit

$ claude auth
# next day. picks up exactly where you left off.

Running 3 features in parallel:

$ claude auth    # terminal 1 → feature/auth
$ claude api     # terminal 2 → feature/api
$ claude tests   # terminal 3 → feature/tests

Your repo stays clean:

~/project/              <- main branch, untouched
~/project/.cw/auth/     <- isolated worktree
~/project/.cw/api/      <- isolated worktree
~/project/.cw/tests/    <- isolated worktree

Quick reference:

claude <name>         # create or resume workspace
claude ls             # list all workspaces
claude rm <name>      # remove workspace
claude <name> --new   # start fresh

Works everywhere. Any git repo. Outside git repos. macOS, Linux, WSL. Transparent shim — your shell doesn't know the difference.

npm i -g claude-worktree
github.com/mksglu/claude-worktree

One install. That's all it should have taken from the start.
```

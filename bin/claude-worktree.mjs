#!/usr/bin/env node

// claude-worktree v1.0.0 — Cross-platform persistent workspace manager for Claude Code
// PROXY MODE: when installed as a claude alias, intercepts workspace commands
// and passes everything else to the real claude binary.
// Works on macOS, Linux, Windows. Zero dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmSync, symlinkSync, readlinkSync, lstatSync, appendFileSync } from 'fs';
import { join, sep, resolve, basename, dirname } from 'path';
import { homedir, platform } from 'os';
import { spawnSync, spawn } from 'child_process';

const VERSION = '1.0.0';
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const REGISTRY = join(CLAUDE_DIR, 'claude-worktree-registry');
const WORKSPACES_DIR = join(CLAUDE_DIR, 'claude-worktree-workspaces');
const WORKTREE_DIR = '.cw';
const BRANCH_PREFIX = 'cw';
const IS_WIN = platform() === 'win32';

// Config — overridable for testing
const _config = {
  home: HOME,
  claudeDir: CLAUDE_DIR,
  registry: REGISTRY,
  workspacesDir: WORKSPACES_DIR,
  shimsDir: join(HOME, '.claude-worktree', 'shims'),
};

export function _setTestConfig(overrides) {
  Object.assign(_config, overrides);
}

export function _getConfig() {
  return { ..._config };
}

// -- Colors (ANSI — works on all modern terminals) ----------------------------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  red:    s => tty ? `\x1b[31m${s}\x1b[0m` : s,
  green:  s => tty ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: s => tty ? `\x1b[33m${s}\x1b[0m` : s,
  blue:   s => tty ? `\x1b[34m${s}\x1b[0m` : s,
  cyan:   s => tty ? `\x1b[36m${s}\x1b[0m` : s,
  bold:   s => tty ? `\x1b[1m${s}\x1b[0m` : s,
  dim:    s => tty ? `\x1b[2m${s}\x1b[0m` : s,
};

function die(msg)     { console.error(`${c.red('error:')} ${msg}`); process.exit(1); }
function info(msg)    { console.log(`${c.blue('>')} ${msg}`); }
function success(msg) { console.log(`${c.green('ok')} ${msg}`); }
function warn(msg)    { console.log(`${c.yellow('!')} ${msg}`); }

// -- Git helper ---------------------------------------------------------------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function gitRoot(cwd) {
  const r = git(cwd || process.cwd(), 'rev-parse', '--show-toplevel');
  return r.ok ? r.out : null;
}

function mainBranch(repo) {
  if (git(repo, 'show-ref', '--quiet', 'refs/heads/main').ok) return 'main';
  if (git(repo, 'show-ref', '--quiet', 'refs/heads/master').ok) return 'master';
  const r = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  return r.ok ? r.out : 'main';
}

// -- Path helpers -------------------------------------------------------------

function sanitizePath(p) {
  let s = resolve(p);
  if (IS_WIN && /^[A-Za-z]:/.test(s)) s = s.slice(2);
  return s.replace(/[^a-zA-Z0-9]/g, '-');
}

function sessionDir(wtPath) {
  return join(_config.claudeDir, 'projects', sanitizePath(wtPath));
}

function sessionInfo(wtPath) {
  const dir = sessionDir(wtPath);
  if (!existsSync(dir)) return 'no sessions';
  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return 'no sessions';
    const latest = files[0];
    const lines = readFileSync(latest.path, 'utf8').split('\n').filter(Boolean).length;
    const date = latest.mtime.toISOString().slice(0, 16).replace('T', ' ');
    return `${date} (${lines} msgs)`;
  } catch { return 'no sessions'; }
}

function repoShort(repo) {
  return `${basename(dirname(repo))}/${basename(repo)}`;
}

// -- Registry (TSV: name\tpath\trepo\tbranch\tcreated) ------------------------

function regEnsure() {
  mkdirSync(dirname(_config.registry), { recursive: true });
  if (!existsSync(_config.registry)) writeFileSync(_config.registry, '', 'utf8');
}

function regLoad() {
  regEnsure();
  return readFileSync(_config.registry, 'utf8').split('\n').filter(Boolean).map(line => {
    const [name, path, repo, branch, created] = line.split('\t');
    return { name, path, repo, branch, created };
  });
}

function regSave(entries) {
  const content = entries.map(e => [e.name, e.path, e.repo, e.branch, e.created].join('\t')).join('\n');
  writeFileSync(_config.registry, content ? content + '\n' : '', 'utf8');
}

function regAdd(name, path, repo, branch) {
  const entries = regLoad().filter(e => e.name !== name);
  entries.push({ name, path, repo, branch, created: new Date().toISOString().slice(0, 16).replace('T', ' ') });
  regSave(entries);
}

function regRemove(name) {
  regSave(regLoad().filter(e => e.name !== name));
}

function regLookup(name) {
  return regLoad().find(e => e.name === name) || null;
}

// -- Resolve workspace by name ------------------------------------------------

function resolve_ws(name) {
  // 1. Registry
  const entry = regLookup(name);
  if (entry) {
    if (existsSync(entry.path)) return entry;
    warn(`Stale registry entry '${name}' -> ${entry.path}`);
    regRemove(name);
    return null;
  }
  // 2. Local repo fallback
  const root = gitRoot(process.cwd());
  if (root) {
    const local = join(root, WORKTREE_DIR, name);
    if (existsSync(local)) {
      const branch = git(local, 'branch', '--show-current').out || 'unknown';
      regAdd(name, local, root, branch);
      return { name, path: local, repo: root, branch };
    }
  }
  return null;
}

function availableNames() {
  const entries = regLoad();
  return entries.length ? entries.map(e => e.name).join(', ') : '(none)';
}

// -- Ensure .gitignore has worktree dir ---------------------------------------

function ensureGitignore(root) {
  const gi = join(root, '.gitignore');
  if (existsSync(gi)) {
    const content = readFileSync(gi, 'utf8');
    if (!content.split('\n').some(l => l.trim() === `${WORKTREE_DIR}/`)) {
      writeFileSync(gi, content.trimEnd() + `\n${WORKTREE_DIR}/\n`, 'utf8');
      info(`Added ${c.dim(`${WORKTREE_DIR}/`)} to .gitignore`);
    }
  }
}

// -- Find real claude binary (not our alias) ----------------------------------

function findRealClaude() {
  const result = spawnSync(IS_WIN ? 'where' : 'which', ['-a', 'claude'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const paths = (result.stdout || '').trim().split('\n').filter(Boolean);

  // Our alias resolves to claude-worktree, so find the one that's NOT claude-worktree
  for (const p of paths) {
    try {
      const content = readFileSync(p, 'utf8');
      if (!content.includes('claude-worktree')) return p;
    } catch {
      // Binary file or unreadable — not us
      return p;
    }
  }

  // Fallback: common claude locations
  const fallbacks = IS_WIN
    ? [join(HOME, '.local', 'bin', 'claude.cmd'), join(HOME, 'AppData', 'npm', 'claude.cmd')]
    : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(HOME, '.local', 'bin', 'claude')];
  for (const f of fallbacks) {
    if (existsSync(f)) return f;
  }

  return null;
}

// -- Launch claude (always uses real claude, never our shim) ------------------

function launchClaude(cwd, args) {
  const claudePath = findRealClaude();
  if (!claudePath) die('claude not found in PATH. Install: npm i -g @anthropic-ai/claude-code');

  process.chdir(cwd);
  const child = spawn(claudePath, args, { stdio: 'inherit', shell: IS_WIN });
  const fwd = sig => { try { child.kill(sig); } catch {} };
  process.on('SIGINT', () => fwd('SIGINT'));
  process.on('SIGTERM', () => fwd('SIGTERM'));
  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', err => die(`Failed to launch claude: ${err.message}`));
}

// -- Launch real claude (proxy passthrough) ------------------------------------

function launchRealClaude(cwd, args) {
  const claudePath = findRealClaude();
  if (!claudePath) die('Real claude binary not found. Is Claude Code installed?');

  process.chdir(cwd);
  const child = spawn(claudePath, args, { stdio: 'inherit', shell: IS_WIN });
  const fwd = sig => { try { child.kill(sig); } catch {} };
  process.on('SIGINT', () => fwd('SIGINT'));
  process.on('SIGTERM', () => fwd('SIGTERM'));
  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', err => die(`Failed to launch claude: ${err.message}`));
}

// -- Commands -----------------------------------------------------------------

function cmdCreate(name, opts) {
  if (regLookup(name)) {
    die(`'${name}' already exists.\n  Just run: claude-worktree ${name}`);
  }

  let root = opts.repo ? resolve(opts.repo.replace(/^~/, HOME)) : gitRoot(process.cwd());
  let wtPath, branch;

  if (root) {
    // Git repo -> real worktree
    wtPath = join(root, WORKTREE_DIR, name);
    branch = `${BRANCH_PREFIX}/${name}`;
    if (existsSync(wtPath)) die(`Directory exists: ${wtPath}`);

    mkdirSync(join(root, WORKTREE_DIR), { recursive: true });
    ensureGitignore(root);

    console.log();
    info(`Creating worktree ${c.bold(name)} in ${c.dim(root)}`);
    info(`Branch: ${c.cyan(branch)}`);
    const r = git(root, 'worktree', 'add', wtPath, '-b', branch, 'HEAD');
    if (!r.ok) die(`git worktree add failed: ${r.err}`);

    regAdd(name, wtPath, root, branch);
    success(`Worktree: ${c.dim(wtPath)}`);
  } else {
    // No git -> standalone workspace
    wtPath = join(_config.workspacesDir, name);
    branch = 'main';
    if (existsSync(wtPath)) die(`Workspace exists: ${wtPath}`);

    console.log();
    info(`Creating workspace ${c.bold(name)}`);
    mkdirSync(wtPath, { recursive: true });
    git(wtPath, 'init', '--quiet');
    git(wtPath, 'commit', '--allow-empty', '-m', `init: workspace ${name}`, '--quiet');

    regAdd(name, wtPath, wtPath, branch);
    success(`Workspace: ${c.dim(wtPath)}`);
  }

  success(`Registered as ${c.bold(name)}`);
  console.log();

  if (opts.noStart) {
    console.log(`  Start: claude-worktree ${name} --skip-permissions`);
    console.log(`  Enter: cd ${wtPath}`);
    return;
  }

  info('Launching Claude Code...');
  console.log(`  ${c.dim(`Resume later -> claude-worktree ${name}`)}`);
  console.log();

  const args = [];
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.extra.length) args.push(...opts.extra);
  launchClaude(wtPath, args);
}

function cmdResume(name, entry, opts) {
  const sess = sessionInfo(entry.path);
  console.log();
  info(`Resuming ${c.bold(name)} -> ${c.dim(entry.path)}`);
  console.log(`  ${c.dim(`Last session: ${sess}`)}`);
  console.log();

  const args = [];
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--continue');
  }
  if (opts.extra.length) args.push(...opts.extra);
  launchClaude(entry.path, args);
}

function cmdOpen(name, entry, opts) {
  console.log();
  info(`New session in ${c.bold(name)} -> ${c.dim(entry.path)}`);
  console.log();

  const args = [];
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.extra.length) args.push(...opts.extra);
  launchClaude(entry.path, args);
}

function cmdList() {
  const entries = regLoad();
  console.log();
  console.log(c.bold('Claude Worktree Workspaces'));
  console.log();

  if (!entries.length) {
    console.log('  No workspaces. Create one:  claude-worktree <name>');
    console.log();
    return;
  }

  // Table header
  console.log(`  ${c.bold('NAME'.padEnd(16))}${c.bold('REPO'.padEnd(24))}${c.bold('STATUS'.padEnd(12))}${c.bold('LAST SESSION')}`);
  console.log(`  ${'----'.padEnd(16)}${'----'.padEnd(24)}${'------'.padEnd(12)}${'------------'}`);

  for (const e of entries) {
    const repo = repoShort(e.repo);
    let status;
    if (!existsSync(e.path)) {
      status = c.red('missing');
    } else {
      const r = git(e.path, 'status', '--porcelain');
      const changes = r.ok ? r.out.split('\n').filter(Boolean).length : 0;
      status = changes === 0 ? c.dim('clean') : c.yellow(`${changes} files`);
    }
    const sess = existsSync(e.path) ? sessionInfo(e.path) : '-';

    console.log(`  ${e.name.padEnd(16)}${repo.padEnd(24)}${status.padEnd(12 + (tty ? 9 : 0))}${sess}`);
  }

  console.log();
  console.log(`  ${c.dim('claude-worktree <name>        enter workspace')}`);
  console.log(`  ${c.dim('claude-worktree rm <name>     remove')}`);
  console.log();
}

function cmdRemove(name, force) {
  const entry = regLookup(name);
  if (!entry) die(`'${name}' not found.\n  Available: ${availableNames()}`);

  const { path: wtPath, repo, branch } = entry;

  if (!existsSync(wtPath)) {
    warn(`Directory gone: ${wtPath}`);
    regRemove(name);
    success(`Cleaned stale entry '${name}'`);
    return;
  }

  // Safety: uncommitted changes
  if (!force) {
    const r = git(wtPath, 'status', '--porcelain');
    const changes = r.ok ? r.out.split('\n').filter(Boolean).length : 0;
    if (changes > 0) die(`'${name}' has ${changes} uncommitted change(s). Use --force.`);
  }

  const isStandalone = repo === wtPath || wtPath.startsWith(_config.workspacesDir);

  console.log();

  if (isStandalone) {
    info(`Removing workspace ${c.bold(name)}...`);
    rmSync(wtPath, { recursive: true, force: true });
  } else {
    // Safety: unmerged commits
    if (!force && repo && existsSync(repo)) {
      const mb = mainBranch(repo);
      const r = git(repo, 'log', `${mb}..${branch}`, '--oneline');
      const unmerged = r.ok ? r.out.split('\n').filter(Boolean).length : 0;
      if (unmerged > 0) die(`Branch '${branch}' has ${unmerged} unmerged commit(s). Use --force.`);
    }

    info(`Removing worktree ${c.bold(name)}...`);
    const r = git(repo, 'worktree', 'remove', wtPath, '--force');
    if (!r.ok) {
      warn(`git worktree remove failed: ${r.err}`);
      rmSync(wtPath, { recursive: true, force: true });
    }

    // Delete branch
    if (repo && existsSync(repo)) {
      const br = git(repo, 'branch', '-D', branch);
      if (br.ok) success(`Deleted branch ${c.cyan(branch)}`);
    }
  }

  regRemove(name);

  // Note session files
  const sd = sessionDir(wtPath);
  if (existsSync(sd)) {
    warn(`Session files preserved at ${c.dim(sd)}`);
  }

  success(`Workspace '${name}' removed`);
  console.log();
}

function cmdPath(name) {
  const entry = resolve_ws(name);
  if (!entry) die(`'${name}' not found.`);
  console.log(entry.path);
}

// ── Shim-based install (works in ALL shells) ────────────────────────────────
// Instead of shell-specific aliases, we create a real `claude` shim file
// in ~/.claude-worktree/shims/ and add it to PATH. This works in zsh, bash, fish,
// PowerShell, cmd.exe, nushell, and any other shell.

const SHIMS_DIR = join(HOME, '.claude-worktree', 'shims');

function resolveClaudeWorktreeBin() {
  // Find the claude-worktree binary path (could be npm global, local, etc.)
  let p = resolve(process.argv[1]);
  try {
    while (lstatSync(p).isSymbolicLink()) {
      const target = readlinkSync(p);
      p = resolve(dirname(p), target);
    }
  } catch {}
  return p;
}

function cmdInstall() {
  // 1. Create shims directory
  mkdirSync(_config.shimsDir, { recursive: true });

  // 2. Find claude-worktree binary
  const cwBin = resolveClaudeWorktreeBin();

  // 3. Write claude shim
  if (IS_WIN) {
    // Windows: .cmd shim
    const shimPath = join(_config.shimsDir, 'claude.cmd');
    writeFileSync(shimPath, `@echo off\r\nnode "${cwBin}" proxy %*\r\n`, 'utf8');
    success(`Created shim: ${shimPath}`);
  } else {
    // Unix: executable script
    const shimPath = join(_config.shimsDir, 'claude');
    writeFileSync(shimPath, `#!/usr/bin/env node\nimport { spawn } from 'child_process';\nconst child = spawn(process.argv[0], ['${cwBin}', 'proxy', ...process.argv.slice(2)], { stdio: 'inherit' });\nchild.on('exit', c => process.exit(c ?? 0));\n`, { mode: 0o755 });
    success(`Created shim: ${shimPath}`);
  }

  // 4. Add shims dir to PATH in shell rc
  const pathLine = `export PATH="${_config.shimsDir}:$PATH"`;
  const comment = '# claude-worktree shims — persistent workspaces for Claude Code';

  // Detect shell and rc files
  const shell = process.env.SHELL || '';
  const rcFiles = [];

  if (IS_WIN) {
    info('Add to PATH manually or run:');
    console.log(`\n  setx PATH "${_config.shimsDir};%PATH%"\n`);
  } else {
    // Add to ALL common rc files that exist (user might switch shells)
    const candidates = [
      { file: join(HOME, '.zshrc'), line: pathLine },
      { file: join(HOME, '.bashrc'), line: pathLine },
      { file: join(HOME, '.bash_profile'), line: pathLine },
      { file: join(HOME, '.config', 'fish', 'config.fish'), line: `set -gx PATH "${_config.shimsDir}" $PATH` },
      { file: join(HOME, '.config', 'nushell', 'env.nu'), line: `$env.PATH = ["${_config.shimsDir}" ...$env.PATH]` },
    ];

    for (const { file, line } of candidates) {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, 'utf8');
      if (content.includes('.claude-worktree/shims')) {
        rcFiles.push({ file, status: 'already' });
        continue;
      }
      appendFileSync(file, `\n${comment}\n${line}\n`);
      rcFiles.push({ file, status: 'added' });
    }

    if (rcFiles.length === 0) {
      // No rc file found, create .zshrc or .bashrc
      const fallback = shell.includes('zsh') ? join(HOME, '.zshrc') : join(HOME, '.bashrc');
      appendFileSync(fallback, `\n${comment}\n${pathLine}\n`);
      rcFiles.push({ file: fallback, status: 'created' });
    }

    for (const { file, status } of rcFiles) {
      if (status === 'already') {
        console.log(`  ${c.dim('skip')} ${file} (already configured)`);
      } else {
        success(`${file}`);
      }
    }
  }

  // 5. Check if it works now
  const inPath = (process.env.PATH || '').split(IS_WIN ? ';' : ':').some(p => {
    try { return resolve(p) === resolve(_config.shimsDir); } catch { return false; }
  });

  // Welcome banner — use stderr so npm shows it even without --foreground-scripts
  const log = s => process.stderr.write(s + '\n');
  log('');
  log('  ┌─────────────────────────────────────────────────┐');
  log('  │                                                 │');
  log('  │   claude-worktree installed successfully        │');
  log('  │                                                 │');
  log('  │   Restart your terminal, then:                  │');
  log('  │                                                 │');
  log('  │   claude auth        create/resume workspace    │');
  log('  │   claude ls          list workspaces            │');
  log('  │   claude rm auth     remove workspace           │');
  log('  │                                                 │');
  log('  │   Works everywhere claude works.                │');
  log('  │   Your existing claude commands are unchanged.  │');
  log('  │                                                 │');
  log('  └─────────────────────────────────────────────────┘');
  log('');
}

function cmdUninstall() {
  // 1. Remove shim
  const shimUnix = join(_config.shimsDir, 'claude');
  const shimWin = join(_config.shimsDir, 'claude.cmd');
  if (existsSync(shimUnix)) { unlinkSync(shimUnix); success(`Removed ${shimUnix}`); }
  if (existsSync(shimWin)) { unlinkSync(shimWin); success(`Removed ${shimWin}`); }

  // 2. Remove PATH lines from rc files
  const rcCandidates = [
    join(HOME, '.zshrc'),
    join(HOME, '.bashrc'),
    join(HOME, '.bash_profile'),
    join(HOME, '.config', 'fish', 'config.fish'),
    join(HOME, '.config', 'nushell', 'env.nu'),
  ];

  for (const rcFile of rcCandidates) {
    if (!existsSync(rcFile)) continue;
    const content = readFileSync(rcFile, 'utf8');
    if (!content.includes('.claude-worktree/shims')) continue;

    const lines = content.split('\n');
    const filtered = lines.filter(l =>
      !l.includes('.claude-worktree/shims') &&
      l.trim() !== '# claude-worktree shims — persistent workspaces for Claude Code'
    );
    writeFileSync(rcFile, filtered.join('\n'), 'utf8');
    success(`Cleaned ${rcFile}`);
  }

  console.log();
  success('claude-worktree uninstalled. Restart your shell.');
  console.log();
}

// -- Proxy mode ---------------------------------------------------------------

const OUR_COMMANDS = new Set(['list', 'ls', 'remove', 'rm', 'path', 'install', 'uninstall', 'help', 'version']);

function isOurCommand(arg) {
  return OUR_COMMANDS.has(arg);
}

function cmdProxy(args) {
  // args = everything after 'proxy'
  if (args.length === 0) {
    // No args -> launch real claude (interactive REPL)
    launchRealClaude(process.cwd(), []);
    return;
  }

  const first = args[0];

  // Check if it's our subcommand
  if (isOurCommand(first)) {
    // Re-parse as claude-worktree command
    process.argv = ['node', 'claude-worktree', ...args];
    main();
    return;
  }

  // Check if it's a registered workspace name
  const entry = resolve_ws(first);
  if (entry) {
    // Workspace exists -> resume
    process.argv = ['node', 'claude-worktree', ...args];
    main();
    return;
  }

  // Check if it looks like a workspace name (alphanumeric, no spaces, no dashes at start)
  // AND is not a claude flag (doesn't start with -)
  // AND is not a quoted prompt string
  // If it passes workspace name validation AND isn't too long (max 30 chars), treat as new workspace
  if (!first.startsWith('-') && !first.startsWith('"') && !first.startsWith("'")
      && first.length <= 30 && /^[a-zA-Z0-9._-]+$/.test(first)) {
    // Could be a new workspace name -> create it
    process.argv = ['node', 'claude-worktree', ...args];
    main();
    return;
  }

  // Everything else -> pass through to real claude
  launchRealClaude(process.cwd(), args);
}

// -- Help ---------------------------------------------------------------------

function cmdHelp() {
  console.log(`
${c.bold('claude-worktree')} ${c.dim(`v${VERSION}`)} — Cross-platform persistent workspaces for Claude Code

${c.bold('USAGE')}
  claude-worktree <name>                Resume or create workspace
  claude-worktree <name> --new          Force new session
  claude-worktree ls                    List all workspaces
  claude-worktree rm <name>             Remove workspace
  claude-worktree path <name>           Print workspace path
  claude-worktree install               Set up claude shim (works in ALL shells)
  claude-worktree uninstall             Remove claude shim

${c.bold('HOW IT WORKS')}
  ${c.cyan('claude-worktree install')} creates a ${c.bold('claude')} shim at ~/.claude-worktree/shims/
  and adds it to PATH. Works in zsh, bash, fish, PowerShell, nushell, cmd.

  After install, ${c.cyan('claude')} becomes a smart proxy:

  claude auth                    ${c.dim('# workspace: create or resume "auth"')}
  claude ls                      ${c.dim('# workspace: list all')}
  claude "fix this bug"          ${c.dim('# passthrough → real claude')}
  claude --help                  ${c.dim('# passthrough → real claude')}

  Workspace name? → claude-worktree handles it.
  Everything else? → passes through to the real claude binary.

${c.bold('OPTIONS')}
  --skip-permissions   Pass --dangerously-skip-permissions to Claude
  --repo <path>        Target repo (default: cwd or standalone)
  --new                Force new session (don't resume)
  --force              Force removal
  -- <args>            Pass remaining args to Claude

${c.bold('EXAMPLES')}
  claude-worktree auth --skip-permissions         ${c.dim('# create or resume')}
  claude-worktree auth --new --skip-permissions   ${c.dim('# force new session')}
  claude-worktree ls                              ${c.dim('# list all')}
  claude-worktree rm auth                         ${c.dim('# remove')}
  cd $(claude-worktree path auth)                 ${c.dim('# cd into it')}

${c.bold('PLATFORMS')}
  macOS, Linux, Windows (Git Bash / PowerShell / cmd)
`);
}

// -- Arg parser ---------------------------------------------------------------

const SUBCOMMANDS = new Set(['list', 'ls', 'remove', 'rm', 'path', 'install', 'uninstall', 'proxy', 'help', 'version']);

function parseArgs() {
  const raw = process.argv.slice(2);
  const opts = {
    cmd: null, name: null, skipPermissions: false, forceNew: false,
    noStart: false, force: false, repo: null, sessionId: null,
    extra: [],
  };

  let i = 0;
  let dashDash = false;

  while (i < raw.length) {
    const a = raw[i];

    if (dashDash) { opts.extra.push(a); i++; continue; }
    if (a === '--') { dashDash = true; i++; continue; }

    // First arg: subcommand or workspace name
    if (i === 0 || (!opts.cmd && !opts.name)) {
      if (SUBCOMMANDS.has(a)) {
        if (a === 'list' || a === 'ls') opts.cmd = 'ls';
        else if (a === 'remove' || a === 'rm') opts.cmd = 'rm';
        else opts.cmd = a;
        i++; continue;
      }
      if (a === '-h' || a === '--help') { opts.cmd = 'help'; i++; continue; }
      if (a === '-v' || a === '--version') { opts.cmd = 'version'; i++; continue; }
    }

    // Flags
    if (a === '--skip-permissions') { opts.skipPermissions = true; }
    else if (a === '--new') { opts.forceNew = true; }
    else if (a === '--no-start') { opts.noStart = true; }
    else if (a === '--force' || a === '-f') { opts.force = true; }
    else if (a === '--repo' && raw[i+1]) { opts.repo = raw[++i]; }
    else if (a === '--session' && raw[i+1]) { opts.sessionId = raw[++i]; }
    else if (a.startsWith('-')) { opts.extra.push(a); }
    else if (!opts.name) { opts.name = a; }
    else { opts.extra.push(a); }

    i++;
  }

  // Default: if name set and no cmd -> auto
  if (opts.name && !opts.cmd) opts.cmd = 'auto';
  // rm/path need name from next positional
  if (!opts.name && !opts.cmd) opts.cmd = 'help';

  return opts;
}

// -- Main ---------------------------------------------------------------------

function main() {
  const opts = parseArgs();

  switch (opts.cmd) {
    case 'help': cmdHelp(); break;
    case 'version': console.log(`claude-worktree v${VERSION}`); break;
    case 'ls': cmdList(); break;
    case 'install': cmdInstall(); break;
    case 'uninstall': cmdUninstall(); break;

    case 'proxy':
      cmdProxy(process.argv.slice(3));
      break;

    case 'rm':
      if (!opts.name) die('Usage: claude-worktree rm <name> [--force]');
      cmdRemove(opts.name, opts.force);
      break;

    case 'path':
      if (!opts.name) die('Usage: claude-worktree path <name>');
      cmdPath(opts.name);
      break;

    case 'auto': {
      if (!opts.name) { cmdHelp(); break; }
      if (/[^a-zA-Z0-9._-]/.test(opts.name)) {
        die('Name must be alphanumeric (with . _ - allowed).');
      }

      const entry = resolve_ws(opts.name);

      if (entry) {
        // EXISTS
        if (opts.noStart) {
          info(`Workspace ${c.bold(opts.name)} at ${c.dim(entry.path)}`);
          break;
        }
        if (opts.forceNew) {
          cmdOpen(opts.name, entry, opts);
        } else {
          cmdResume(opts.name, entry, opts);
        }
      } else {
        // CREATE
        cmdCreate(opts.name, opts);
      }
      break;
    }

    default: cmdHelp();
  }
}

// -- Exports for testing + CLI entry point ------------------------------------

export {
  VERSION, CLAUDE_DIR, REGISTRY, WORKSPACES_DIR, WORKTREE_DIR, BRANCH_PREFIX, SHIMS_DIR,
  sanitizePath, sessionDir, sessionInfo, repoShort,
  regEnsure, regLoad, regSave, regAdd, regRemove, regLookup,
  resolve_ws, availableNames, ensureGitignore,
  git, gitRoot, mainBranch,
  findRealClaude, isOurCommand,
  parseArgs,
  cmdCreate, cmdResume, cmdOpen, cmdList, cmdRemove, cmdPath,
  cmdInstall, cmdUninstall, cmdProxy,
  main,
};

// Run main() only when executed directly (not imported as module)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('claude-worktree.mjs') ||
  process.argv[1].endsWith('claude-worktree') ||
  process.argv[1].includes('/claude-worktree/')
);
if (isDirectRun) main();

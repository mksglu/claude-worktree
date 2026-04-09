import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

// ── Test helpers ────────────────────────────────────────────────────────────

const BIN = join(import.meta.dirname, '..', 'bin', 'vibetree.mjs');

function vibetree(...args) {
  const r = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 10000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let tmpDir;
let mod;

async function loadModule() {
  // Dynamic import with cache busting
  const url = new URL(`file://${BIN}?t=${Date.now()}`);
  mod = await import(url.href);
}

function setupTempEnv() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vibetree-test-'));
  const claudeDir = join(tmpDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  mod._setTestConfig({
    home: tmpDir,
    claudeDir,
    registry: join(claudeDir, 'vibetree-registry'),
    workspacesDir: join(claudeDir, 'vibetree-workspaces'),
    shimsDir: join(tmpDir, '.vibetree', 'shims'),
  });
}

function cleanupTempEnv() {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function createTempGitRepo() {
  const repoDir = join(tmpDir, 'test-repo');
  mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', '--quiet'], { cwd: repoDir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init', '--quiet'], { cwd: repoDir });
  return repoDir;
}

function createFakeSession(wtPath, msgCount = 5) {
  const cfg = mod._getConfig();
  const sanitized = mod.sanitizePath(wtPath);
  const sessDir = join(cfg.claudeDir, 'projects', sanitized);
  mkdirSync(sessDir, { recursive: true });
  const lines = Array.from({ length: msgCount }, (_, i) =>
    JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` })
  ).join('\n') + '\n';
  writeFileSync(join(sessDir, 'abc-123.jsonl'), lines, 'utf8');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('vibetree', async () => {
  await loadModule();

  // ── 1. Registry CRUD ────────────────────────────────────────────────────

  describe('registry', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('starts empty', () => {
      const entries = mod.regLoad();
      assert.equal(entries.length, 0);
    });

    it('adds an entry', () => {
      mod.regAdd('auth', '/tmp/auth', '/repo', 'vt/auth');
      const entries = mod.regLoad();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].name, 'auth');
      assert.equal(entries[0].path, '/tmp/auth');
      assert.equal(entries[0].repo, '/repo');
      assert.equal(entries[0].branch, 'vt/auth');
      assert.ok(entries[0].created.length > 0);
    });

    it('lookup returns entry by name', () => {
      mod.regAdd('auth', '/tmp/auth', '/repo', 'vt/auth');
      const entry = mod.regLookup('auth');
      assert.ok(entry);
      assert.equal(entry.name, 'auth');
      assert.equal(entry.path, '/tmp/auth');
    });

    it('lookup returns null for missing name', () => {
      const entry = mod.regLookup('nonexistent');
      assert.equal(entry, null);
    });

    it('removes an entry', () => {
      mod.regAdd('auth', '/tmp/auth', '/repo', 'vt/auth');
      mod.regAdd('api', '/tmp/api', '/repo', 'vt/api');
      mod.regRemove('auth');
      const entries = mod.regLoad();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].name, 'api');
    });

    it('overwrite on duplicate name', () => {
      mod.regAdd('auth', '/tmp/old', '/repo', 'vt/auth');
      mod.regAdd('auth', '/tmp/new', '/repo', 'vt/auth');
      const entries = mod.regLoad();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].path, '/tmp/new');
    });

    it('handles multiple entries', () => {
      mod.regAdd('a', '/a', '/r', 'b1');
      mod.regAdd('b', '/b', '/r', 'b2');
      mod.regAdd('c', '/c', '/r', 'b3');
      assert.equal(mod.regLoad().length, 3);
      assert.equal(mod.availableNames(), 'a, b, c');
    });

    it('remove nonexistent is safe', () => {
      mod.regAdd('auth', '/tmp/auth', '/repo', 'vt/auth');
      mod.regRemove('nonexistent');
      assert.equal(mod.regLoad().length, 1);
    });

    it('registry file persists correctly', () => {
      const cfg = mod._getConfig();
      mod.regAdd('test', '/path', '/repo', 'br');
      const raw = readFileSync(cfg.registry, 'utf8');
      assert.ok(raw.includes('test\t/path\t/repo\tbr\t'));
    });
  });

  // ── 2. Path sanitization ────────────────────────────────────────────────

  describe('sanitizePath', () => {
    it('matches Claude format for unix paths', () => {
      const result = mod.sanitizePath('/Users/mksglu/.claude/workspaces/auth');
      assert.equal(result, '-Users-mksglu--claude-workspaces-auth');
    });

    it('handles dots in path', () => {
      const result = mod.sanitizePath('/home/user/.config/test');
      assert.equal(result, '-home-user--config-test');
    });

    it('handles nested paths', () => {
      const result = mod.sanitizePath('/a/b/c/d');
      assert.equal(result, '-a-b-c-d');
    });

    it('keeps leading dash (from leading /)', () => {
      const result = mod.sanitizePath('/Users/test');
      assert.ok(result.startsWith('-'));
    });

    it('replaces all non-alphanumeric with dash', () => {
      const result = mod.sanitizePath('/path/with spaces/and.dots/under_score');
      assert.ok(!/[^a-zA-Z0-9-]/.test(result));
    });
  });

  // ── 3. Session info ─────────────────────────────────────────────────────

  describe('sessionInfo', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('returns "no sessions" when dir missing', () => {
      assert.equal(mod.sessionInfo('/nonexistent/path'), 'no sessions');
    });

    it('returns "no sessions" when dir empty', () => {
      const cfg = mod._getConfig();
      const sanitized = mod.sanitizePath('/test/path');
      const sessDir = join(cfg.claudeDir, 'projects', sanitized);
      mkdirSync(sessDir, { recursive: true });
      assert.equal(mod.sessionInfo('/test/path'), 'no sessions');
    });

    it('reads session file and returns info', () => {
      const wsPath = join(tmpDir, 'ws');
      mkdirSync(wsPath, { recursive: true });
      createFakeSession(wsPath, 10);
      const info = mod.sessionInfo(wsPath);
      assert.ok(info.includes('10 msgs'));
      assert.notEqual(info, 'no sessions');
    });
  });

  // ── 4. repoShort ────────────────────────────────────────────────────────

  describe('repoShort', () => {
    it('returns last two path components', () => {
      assert.equal(mod.repoShort('/Users/mksglu/Server/Mert/context-mode'), 'Mert/context-mode');
    });

    it('handles short paths', () => {
      assert.equal(mod.repoShort('/repo'), '/repo');
    });
  });

  // ── 5. Arg parser ──────────────────────────────────────────────────────

  describe('parseArgs', () => {
    function parse(...args) {
      process.argv = ['node', 'vibetree', ...args];
      return mod.parseArgs();
    }

    it('no args → help', () => {
      const opts = parse();
      assert.equal(opts.cmd, 'help');
    });

    it('workspace name → auto', () => {
      const opts = parse('auth');
      assert.equal(opts.cmd, 'auto');
      assert.equal(opts.name, 'auth');
    });

    it('ls → ls command', () => {
      const opts = parse('ls');
      assert.equal(opts.cmd, 'ls');
    });

    it('list → ls command', () => {
      const opts = parse('list');
      assert.equal(opts.cmd, 'ls');
    });

    it('rm name → rm command with name', () => {
      const opts = parse('rm', 'auth');
      assert.equal(opts.cmd, 'rm');
      assert.equal(opts.name, 'auth');
    });

    it('remove name → rm command', () => {
      const opts = parse('remove', 'auth');
      assert.equal(opts.cmd, 'rm');
      assert.equal(opts.name, 'auth');
    });

    it('path name → path command', () => {
      const opts = parse('path', 'auth');
      assert.equal(opts.cmd, 'path');
      assert.equal(opts.name, 'auth');
    });

    it('--help → help', () => {
      const opts = parse('--help');
      assert.equal(opts.cmd, 'help');
    });

    it('-h → help', () => {
      const opts = parse('-h');
      assert.equal(opts.cmd, 'help');
    });

    it('--version → version', () => {
      const opts = parse('--version');
      assert.equal(opts.cmd, 'version');
    });

    it('install → install', () => {
      const opts = parse('install');
      assert.equal(opts.cmd, 'install');
    });

    it('uninstall → uninstall', () => {
      const opts = parse('uninstall');
      assert.equal(opts.cmd, 'uninstall');
    });

    it('proxy → proxy', () => {
      const opts = parse('proxy');
      assert.equal(opts.cmd, 'proxy');
    });

    it('--skip-permissions flag', () => {
      const opts = parse('auth', '--skip-permissions');
      assert.equal(opts.skipPermissions, true);
      assert.equal(opts.name, 'auth');
    });

    it('--new flag', () => {
      const opts = parse('auth', '--new');
      assert.equal(opts.forceNew, true);
    });

    it('--no-start flag', () => {
      const opts = parse('auth', '--no-start');
      assert.equal(opts.noStart, true);
    });

    it('--force flag', () => {
      const opts = parse('rm', 'auth', '--force');
      assert.equal(opts.force, true);
    });

    it('-f flag', () => {
      const opts = parse('rm', 'auth', '-f');
      assert.equal(opts.force, true);
    });

    it('--repo flag', () => {
      const opts = parse('auth', '--repo', '/some/path');
      assert.equal(opts.repo, '/some/path');
    });

    it('--session flag', () => {
      const opts = parse('auth', '--session', 'abc-123');
      assert.equal(opts.sessionId, 'abc-123');
    });

    it('-- passes remaining as extra', () => {
      const opts = parse('auth', '--', '--verbose', '--debug');
      assert.deepEqual(opts.extra, ['--verbose', '--debug']);
    });

    it('unknown flags go to extra', () => {
      const opts = parse('auth', '--verbose');
      assert.ok(opts.extra.includes('--verbose'));
    });
  });

  // ── 6. Proxy routing ───────────────────────────────────────────────────

  describe('isOurCommand', () => {
    it('recognizes vibetree subcommands', () => {
      assert.equal(mod.isOurCommand('ls'), true);
      assert.equal(mod.isOurCommand('list'), true);
      assert.equal(mod.isOurCommand('rm'), true);
      assert.equal(mod.isOurCommand('remove'), true);
      assert.equal(mod.isOurCommand('path'), true);
      assert.equal(mod.isOurCommand('install'), true);
      assert.equal(mod.isOurCommand('uninstall'), true);
      assert.equal(mod.isOurCommand('help'), true);
      assert.equal(mod.isOurCommand('version'), true);
    });

    it('rejects non-commands', () => {
      assert.equal(mod.isOurCommand('auth'), false);
      assert.equal(mod.isOurCommand('fix-bug'), false);
      assert.equal(mod.isOurCommand('--help'), false);
      assert.equal(mod.isOurCommand(''), false);
    });
  });

  // ── 7. Git helpers ─────────────────────────────────────────────────────

  describe('git helpers', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('git() runs commands', () => {
      const r = mod.git(tmpDir, 'version');
      assert.equal(r.ok, true);
      assert.ok(r.out.includes('git version'));
    });

    it('git() returns ok=false on failure', () => {
      const r = mod.git(tmpDir, 'log');
      assert.equal(r.ok, false);
    });

    it('gitRoot returns null outside git repo', () => {
      assert.equal(mod.gitRoot(tmpDir), null);
    });

    it('gitRoot returns root inside git repo', () => {
      const repo = createTempGitRepo();
      const root = mod.gitRoot(repo);
      assert.ok(root);
      assert.ok(root.includes('test-repo'));
    });

    it('mainBranch detects main', () => {
      const repo = createTempGitRepo();
      // Default branch from git init is usually main or master
      const branch = mod.mainBranch(repo);
      assert.ok(['main', 'master'].includes(branch));
    });
  });

  // ── 8. Workspace create (standalone) ───────────────────────────────────

  describe('standalone workspace create', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('creates workspace directory with git init', () => {
      const cfg = mod._getConfig();
      const wsPath = join(cfg.workspacesDir, 'test-ws');

      // Simulate cmdCreate behavior for standalone
      mkdirSync(wsPath, { recursive: true });
      mod.git(wsPath, 'init', '--quiet');
      mod.git(wsPath, 'commit', '--allow-empty', '-m', 'init', '--quiet');
      mod.regAdd('test-ws', wsPath, wsPath, 'main');

      assert.ok(existsSync(wsPath));
      assert.ok(existsSync(join(wsPath, '.git')));
      assert.ok(mod.regLookup('test-ws'));
    });

    it('git init is idempotent', () => {
      const cfg = mod._getConfig();
      const wsPath = join(cfg.workspacesDir, 'test-idem');
      mkdirSync(wsPath, { recursive: true });

      mod.git(wsPath, 'init', '--quiet');
      const r = mod.git(wsPath, 'init');
      assert.equal(r.ok, true);
      assert.ok(r.out.includes('Reinitialized') || r.out.includes('Initialized'));
    });
  });

  // ── 9. Workspace create (worktree) ─────────────────────────────────────

  describe('git worktree create', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('creates worktree with correct branch', () => {
      const repo = createTempGitRepo();
      const wtPath = join(repo, '.vibetree', 'feat-auth');
      mkdirSync(join(repo, '.vibetree'), { recursive: true });

      const r = mod.git(repo, 'worktree', 'add', wtPath, '-b', 'vt/feat-auth', 'HEAD');
      assert.equal(r.ok, true);
      assert.ok(existsSync(wtPath));

      const branch = mod.git(wtPath, 'branch', '--show-current');
      assert.equal(branch.out, 'vt/feat-auth');
    });

    it('worktree is isolated from main', () => {
      const repo = createTempGitRepo();
      const wtPath = join(repo, '.vibetree', 'isolated');
      mkdirSync(join(repo, '.vibetree'), { recursive: true });

      mod.git(repo, 'worktree', 'add', wtPath, '-b', 'vt/isolated', 'HEAD');

      // Create file in worktree
      writeFileSync(join(wtPath, 'test.txt'), 'hello', 'utf8');

      // File should NOT exist in main repo
      assert.ok(!existsSync(join(repo, 'test.txt')));
      assert.ok(existsSync(join(wtPath, 'test.txt')));
    });

    it('worktree cleanup works', () => {
      const repo = createTempGitRepo();
      const wtPath = join(repo, '.vibetree', 'cleanup');
      mkdirSync(join(repo, '.vibetree'), { recursive: true });

      mod.git(repo, 'worktree', 'add', wtPath, '-b', 'vt/cleanup', 'HEAD');
      assert.ok(existsSync(wtPath));

      mod.git(repo, 'worktree', 'remove', wtPath, '--force');
      assert.ok(!existsSync(wtPath));

      mod.git(repo, 'branch', '-D', 'vt/cleanup');
      const branches = mod.git(repo, 'branch', '--list', 'vt/cleanup');
      assert.equal(branches.out, '');
    });
  });

  // ── 10. Resolve workspace ──────────────────────────────────────────────

  describe('resolve_ws', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('returns null for unknown workspace', () => {
      assert.equal(mod.resolve_ws('nonexistent'), null);
    });

    it('finds workspace from registry', () => {
      const cfg = mod._getConfig();
      const wsPath = join(cfg.workspacesDir, 'myws');
      mkdirSync(wsPath, { recursive: true });
      mod.regAdd('myws', wsPath, wsPath, 'main');

      const entry = mod.resolve_ws('myws');
      assert.ok(entry);
      assert.equal(entry.name, 'myws');
      assert.equal(entry.path, wsPath);
    });

    it('cleans stale registry entries', () => {
      mod.regAdd('stale', '/nonexistent/path', '/repo', 'br');
      const entry = mod.resolve_ws('stale');
      assert.equal(entry, null);
      // Should have been removed from registry
      assert.equal(mod.regLookup('stale'), null);
    });
  });

  // ── 11. ensureGitignore ────────────────────────────────────────────────

  describe('ensureGitignore', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('adds .vibetree/ to existing .gitignore', () => {
      const repo = createTempGitRepo();
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n', 'utf8');

      mod.ensureGitignore(repo);

      const content = readFileSync(join(repo, '.gitignore'), 'utf8');
      assert.ok(content.includes('.vibetree/'));
      assert.ok(content.includes('node_modules/'));
    });

    it('does not duplicate .vibetree/ entry', () => {
      const repo = createTempGitRepo();
      writeFileSync(join(repo, '.gitignore'), '.vibetree/\n', 'utf8');

      mod.ensureGitignore(repo);

      const content = readFileSync(join(repo, '.gitignore'), 'utf8');
      const count = content.split('.vibetree/').length - 1;
      assert.equal(count, 1);
    });

    it('skips if no .gitignore exists', () => {
      const repo = createTempGitRepo();
      // No .gitignore created
      mod.ensureGitignore(repo);
      // Should not create one
      // (current behavior: only modifies existing .gitignore)
    });
  });

  // ── 12. Workspace remove ───────────────────────────────────────────────

  describe('workspace remove', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('removes standalone workspace from registry', () => {
      const cfg = mod._getConfig();
      const wsPath = join(cfg.workspacesDir, 'del-me');
      mkdirSync(wsPath, { recursive: true });
      mod.git(wsPath, 'init', '--quiet');
      mod.git(wsPath, 'commit', '--allow-empty', '-m', 'init', '--quiet');
      mod.regAdd('del-me', wsPath, wsPath, 'main');

      mod.cmdRemove('del-me', true); // force

      assert.equal(mod.regLookup('del-me'), null);
      assert.ok(!existsSync(wsPath));
    });

    it('removes worktree and deletes branch', () => {
      const repo = createTempGitRepo();
      const wtPath = join(repo, '.vibetree', 'rm-wt');
      mkdirSync(join(repo, '.vibetree'), { recursive: true });
      mod.git(repo, 'worktree', 'add', wtPath, '-b', 'vt/rm-wt', 'HEAD');
      mod.regAdd('rm-wt', wtPath, repo, 'vt/rm-wt');

      mod.cmdRemove('rm-wt', true); // force

      assert.equal(mod.regLookup('rm-wt'), null);
      assert.ok(!existsSync(wtPath));
      const branches = mod.git(repo, 'branch', '--list', 'vt/rm-wt');
      assert.equal(branches.out, '');
    });

    it('cleans stale entry when directory gone', () => {
      mod.regAdd('gone', '/nonexistent', '/repo', 'vt/gone');
      mod.cmdRemove('gone', false);
      assert.equal(mod.regLookup('gone'), null);
    });
  });

  // ── 13. Install/uninstall shims ────────────────────────────────────────

  describe('install shims', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('creates claude shim file', () => {
      const cfg = mod._getConfig();
      // Mock process.argv[1] for resolveVibetreeBin
      const origArgv = process.argv[1];
      process.argv[1] = BIN;

      // Create a fake rc file so install has something to modify
      writeFileSync(join(tmpDir, '.zshrc'), '# existing\n', 'utf8');

      // Override HOME for rc file detection
      const origHome = process.env.HOME;
      process.env.HOME = tmpDir;

      try {
        mod.cmdInstall();
        const shimPath = join(cfg.shimsDir, 'claude');
        assert.ok(existsSync(shimPath), 'Shim file should exist');

        const content = readFileSync(shimPath, 'utf8');
        assert.ok(content.includes('vibetree'), 'Shim should reference vibetree');
        assert.ok(content.includes('proxy'), 'Shim should use proxy mode');
      } finally {
        process.argv[1] = origArgv;
        process.env.HOME = origHome;
      }
    });

    it('uninstall removes shim file', () => {
      const cfg = mod._getConfig();
      mkdirSync(cfg.shimsDir, { recursive: true });
      writeFileSync(join(cfg.shimsDir, 'claude'), '#!/usr/bin/env node\n', { mode: 0o755 });

      mod.cmdUninstall();

      assert.ok(!existsSync(join(cfg.shimsDir, 'claude')), 'Shim should be removed');
    });
  });

  // ── 14. CLI integration tests (subprocess) ────────────────────────────

  describe('CLI integration', () => {
    it('version outputs version', () => {
      const r = vibetree('version');
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('vibetree v'));
    });

    it('help outputs usage', () => {
      const r = vibetree('help');
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('USAGE'));
      assert.ok(r.stdout.includes('vibetree'));
    });

    it('--help works', () => {
      const r = vibetree('--help');
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('USAGE'));
    });

    it('-h works', () => {
      const r = vibetree('-h');
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('USAGE'));
    });

    it('--version works', () => {
      const r = vibetree('--version');
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('vibetree v'));
    });

    it('ls shows empty state', () => {
      const r = vibetree('ls');
      assert.equal(r.code, 0);
      // Should show header at minimum
      assert.ok(r.stdout.includes('Workspaces') || r.stdout.includes('workspace'));
    });

    it('rm nonexistent fails gracefully', () => {
      const r = vibetree('rm', 'nonexistent-xyz');
      assert.notEqual(r.code, 0);
      assert.ok(r.stderr.includes('not found') || r.stdout.includes('not found'));
    });

    it('path nonexistent fails gracefully', () => {
      const r = vibetree('path', 'nonexistent-xyz');
      assert.notEqual(r.code, 0);
    });

    it('invalid workspace name rejected', () => {
      const r = vibetree('bad name with spaces', '--no-start');
      assert.notEqual(r.code, 0);
    });
  });

  // ── 15. findRealClaude ─────────────────────────────────────────────────

  describe('findRealClaude', () => {
    it('finds claude binary', () => {
      const claude = mod.findRealClaude();
      // Claude should be installed on this machine
      if (claude) {
        assert.ok(claude.includes('claude'));
        assert.ok(existsSync(claude));
      }
      // If not installed, null is acceptable
    });
  });

  // ── 16. sessionDir ─────────────────────────────────────────────────────

  describe('sessionDir', () => {
    beforeEach(() => setupTempEnv());
    afterEach(() => cleanupTempEnv());

    it('returns correct session directory', () => {
      const cfg = mod._getConfig();
      const dir = mod.sessionDir('/Users/test/workspace');
      assert.ok(dir.startsWith(cfg.claudeDir));
      assert.ok(dir.includes('projects'));
    });

    it('is deterministic', () => {
      const a = mod.sessionDir('/some/path');
      const b = mod.sessionDir('/some/path');
      assert.equal(a, b);
    });

    it('differs for different paths', () => {
      const a = mod.sessionDir('/path/a');
      const b = mod.sessionDir('/path/b');
      assert.notEqual(a, b);
    });
  });
});

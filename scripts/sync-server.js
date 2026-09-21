#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const os = require('node:os');

const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_SERVER_DIR = path.join(ROOT_DIR, 'vendor', 'rustdesk-server');
const UPSTREAM_REV_FILE = path.join(VENDOR_SERVER_DIR, '.upstream-rev');
const PATCHES_DIR = path.join(ROOT_DIR, 'patches', 'rustdesk-server');
const MAIN_PATCH_FILE = path.join(PATCHES_DIR, '0001-control-plane-policy.patch');

function readUpstreamRev() {
  if (!fs.existsSync(UPSTREAM_REV_FILE)) {
    throw new Error(`.upstream-rev 未找到: ${UPSTREAM_REV_FILE}`);
  }
  return JSON.parse(fs.readFileSync(UPSTREAM_REV_FILE, 'utf8'));
}

function run(cmd, args = [], options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd || ROOT_DIR,
    env: { ...process.env, ...options.env },
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !options.allowFailure) {
    const errorMsg = res.stderr ? res.stderr.trim() : `Command exited with status ${res.status}`;
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${errorMsg}`);
  }
  return res;
}

function getRemoteUpstreamInfo(repoUrl) {
  // Use git ls-remote to avoid GitHub API unauthenticated rate limits
  const headRes = run('git', ['ls-remote', repoUrl, 'HEAD']);
  const headCommit = (headRes.stdout.trim().split(/\s+/)[0] || '').trim();

  const tagsRes = run('git', ['ls-remote', '--tags', repoUrl]);
  const lines = tagsRes.stdout.split('\n').filter(Boolean);
  const tags = [];
  for (const line of lines) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (!ref) continue;
    const tagName = ref.replace('refs/tags/', '').replace(/\^{}$/, '');
    if (tagName && !tags.some((t) => t.name === tagName)) {
      tags.push({ name: tagName, commit });
    }
  }

  // Sort tags descending
  tags.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));

  return { headCommit, tags };
}

function setGithubOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, 'utf8');
  }
}

function appendStepSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n', 'utf8');
  }
}

async function checkCmd() {
  console.log('[sync-server] 正在读取本地上游基线元数据...');
  const rev = readUpstreamRev();
  console.log(`- 本地基线版本: Tag ${rev.baseTag || 'N/A'}, Commit ${rev.baseCommit.slice(0, 10)}`);
  console.log(`- 上游代码仓库: ${rev.upstreamRepository}`);

  console.log('[sync-server] 正在查询上游远程版本信息...');
  const remote = getRemoteUpstreamInfo(rev.upstreamRepository);

  console.log(`- 远程 master HEAD Commit: ${remote.headCommit.slice(0, 10)}`);
  const latestTag = remote.tags[0];
  if (latestTag) {
    console.log(`- 远程最新 Release Tag: ${latestTag.name} (${latestTag.commit.slice(0, 10)})`);
  }

  const isCommitEqual = rev.baseCommit.toLowerCase() === remote.headCommit.toLowerCase();
  const hasUpdate = !isCommitEqual;

  setGithubOutput('has_update', hasUpdate ? 'true' : 'false');
  setGithubOutput('current_commit', rev.baseCommit);
  setGithubOutput('current_tag', rev.baseTag || '');
  setGithubOutput('target_commit', remote.headCommit);
  setGithubOutput('target_tag', latestTag ? latestTag.name : '');

  appendStepSummary(`### 🛰️ Upstream Version Check
| 属性 | 本地基准 | 远程上游 |
| :--- | :--- | :--- |
| **Commit** | \`${rev.baseCommit.slice(0, 10)}\` | \`${remote.headCommit.slice(0, 10)}\` |
| **Tag** | \`${rev.baseTag || 'N/A'}\` | \`${latestTag ? latestTag.name : 'N/A'}\` |
| **状态** | \`${hasUpdate ? '⚠️ Update Available' : '✅ Up to Date'}\` | - |
`);

  console.log('\n--- 状态报告 ---');
  if (isCommitEqual) {
    console.log('✅ 本地基线与上游 master HEAD 一致，无需同步。');
  } else {
    console.log(`⚠️ 上游有新提交！当前基线落后于上游 master HEAD:`);
    console.log(`   本地: ${rev.baseCommit.slice(0, 10)}`);
    console.log(`   上游: ${remote.headCommit.slice(0, 10)}`);
    console.log(`建议执行 'npm run sync:server:apply -- --dry-run' 预演新版本补丁合并。`);
  }
}

function exportPatchCmd() {
  console.log('[sync-server] 正在导出补丁...');
  const rev = readUpstreamRev();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-server-upstream-'));

  try {
    console.log(`[sync-server] 临时克隆上游基准版本 (${rev.baseCommit.slice(0, 10)})...`);
    run('git', ['clone', '--depth', '1', rev.upstreamRepository, tempDir]);

    // Copy modified files from vendor/rustdesk-server
    for (const relPath of rev.touchedFiles) {
      const src = path.join(VENDOR_SERVER_DIR, relPath);
      const dst = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }

    if (!fs.existsSync(PATCHES_DIR)) {
      fs.mkdirSync(PATCHES_DIR, { recursive: true });
    }

    // Add untracked files in tempDir so git diff captures them
    run('git', ['add', '-N', '.'], { cwd: tempDir });
    run('git', ['diff', `--output=${MAIN_PATCH_FILE}`], { cwd: tempDir });

    console.log(`✅ 补丁成功导出至: ${path.relative(ROOT_DIR, MAIN_PATCH_FILE)}`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function applyCmd(targetRef, options = {}) {
  const rev = readUpstreamRev();
  const target = targetRef || rev.baseCommit;
  const isDryRun = Boolean(options.dryRun);

  console.log(`[sync-server] 准备针对目标版本 ${target} 执行同步与补丁重放...`);
  if (isDryRun) {
    console.log('[sync-server] [DRY RUN 预演模式 - 不会修改代码仓库]');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-server-sync-'));
  try {
    console.log(`[sync-server] 正在拉取目标版本代码: ${target}...`);
    run('git', ['clone', rev.upstreamRepository, tempDir]);
    run('git', ['checkout', target], { cwd: tempDir });

    const currentCommitRes = run('git', ['rev-parse', 'HEAD'], { cwd: tempDir });
    const currentCommit = currentCommitRes.stdout.trim();
    console.log(`[sync-server] 目标完整 Commit: ${currentCommit}`);

    console.log('[sync-server] 正在测试补丁应用 (git apply --check)...');
    const checkRes = run('git', ['apply', '--check', MAIN_PATCH_FILE], {
      cwd: tempDir,
      allowFailure: true,
    });

    if (checkRes.status !== 0) {
      console.error('\n❌ 补丁应用失败！存在合并冲突：');
      const conflictMsg = checkRes.stderr || checkRes.stdout;
      console.error(conflictMsg);
      console.error('\n请按照 docs/OPERATIONS-RUNBOOK.md 第9节 SOP 进行人工冲突消解。');

      setGithubOutput('sync_status', 'conflict');
      setGithubOutput('conflict_error', conflictMsg.slice(0, 500).replace(/\r?\n/g, ' '));
      appendStepSummary(`### ❌ 补丁应用失败 (存在冲突)
目标版本 \`${target}\` 与当前策略补丁发生冲突，无法自动合入。
\`\`\`text
${conflictMsg}
\`\`\`
请参考 [OPERATIONS-RUNBOOK.md](docs/OPERATIONS-RUNBOOK.md) 第 9 节进行人工消解。
`);
      process.exit(1);
    }

    console.log('✅ 补丁检查通过，无合并冲突！');
    setGithubOutput('sync_status', 'success');
    setGithubOutput('target_commit', currentCommit);

    if (isDryRun) {
      console.log('[sync-server] 预演测试通过，无需进一步操作。');
      appendStepSummary(`### 🧪 补丁预演通过 (Dry-Run)
针对目标版本 \`${target}\` (\`${currentCommit.slice(0, 10)}\`) 的补丁兼容性测试成功，无任何冲突。
`);
      return;
    }

    console.log('[sync-server] 正在应用补丁至目标代码...');
    run('git', ['apply', MAIN_PATCH_FILE], { cwd: tempDir });

    console.log('[sync-server] 正在更新 vendor/rustdesk-server 目录...');
    // Clean target files in vendor and copy from tempDir
    const tempSrcDir = path.join(tempDir, 'src');
    const vendorSrcDir = path.join(VENDOR_SERVER_DIR, 'src');
    fs.cpSync(tempSrcDir, vendorSrcDir, { recursive: true });

    // Update .upstream-rev
    rev.baseCommit = currentCommit;
    rev.patchedAt = new Date().toISOString();
    fs.writeFileSync(UPSTREAM_REV_FILE, JSON.stringify(rev, null, 2) + '\n', 'utf8');

    console.log('✅ 同步完成！已更新 vendor/rustdesk-server 及 .upstream-rev。');
    console.log('请记得执行 npm test 以及相关门禁测试！');

    appendStepSummary(`### 🚀 服务端代码同步成功
- 目标版本: \`${target}\`
- Commit: \`${currentCommit}\`
- 更新范围: \`vendor/rustdesk-server\` 及 \`.upstream-rev\`
`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';

  switch (command) {
    case 'check':
      checkCmd().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
      break;

    case 'export-patch':
      try {
        exportPatchCmd();
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
      break;

    case 'apply': {
      let targetRef = null;
      let dryRun = false;
      for (const arg of args.slice(1)) {
        if (arg === '--dry-run') dryRun = true;
        else if (arg.startsWith('--target=')) targetRef = arg.split('=')[1];
        else if (!arg.startsWith('-')) targetRef = arg;
      }
      try {
        applyCmd(targetRef, { dryRun });
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`用法: node scripts/sync-server.js <check|export-patch|apply> [options]
  check              检查本地基线与上游远程版本差异
  export-patch       根据当前 vendor/rustdesk-server 导出标准化 patch 文件
  apply [target]     拉取目标版本并应用补丁 (--dry-run 仅测试不落地)
`);
      process.exit(1);
  }
}

main();


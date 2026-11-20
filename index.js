/**
 * dsh-memory-tree — Host half.
 *
 * Registers the dual-tree engine as Agent tools plus one same-origin read/write
 * route the visualization panel consumes. All arithmetic lives in lib/engine.js;
 * this file only wires that engine to Harness services.
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import {
  DEFAULTS, TYPES,
  grow, runSearch, buildBrief, readPointer, readPointer as readPtr,
  gcDelete, gcRestore, gcPurge, gcOrphans, gcRebuild,
  mergeStaging, diagnose, treeView, editNode, importTree, exportTree,
  loadConfig, loadTree, listTaskTrees, habitHostDir, touchRegistry,
  GrowError, treeRoot, treeFile, setDataRoot, dataLayout, saveGroups,
} from './lib/engine.js'

import { groupBranch, groupTree, groupSummary, nameBucket } from './lib/group-run.js'
import { renameGroup, dissolveGroup, mergeGroups, groupsOf } from './lib/groups.js'

import {
  scanWorkspaces, readWorkspaceMessages,
} from './lib/session-log.js'

import { buildTreeFromMessages } from './lib/import.js'

import {
  deleteWholeTree, listTreeRecycle, restoreWholeTree, mergeTrees, purgeTreeRecycle,
  purgeTreeEntry, removeDeletedShell,
} from './lib/tree-recycle.js'

import {
  shouldSearch, isHabitStatement, proposeRecall, findDuplicate,
  canWriteTree, habitWriteAllowed, habitSnapshot,
} from './lib/gate.js'

import {
  RETENTION_DEFAULTS, readLocks, writeLocks, setBatchLock, setTreeLock,
  expiredBatches, expireBatches, quotaStatus, quotaCandidates,
  compactToQuota, batchReport, pruneEmptyMonths,
} from './lib/retention.js'

import {
  resolveRoot, workspaceRoot, workspaceTreeFile, habitTreeFile,
  monthKey, batchKey, listBatches, workspaceBytes, workspaceSlug,
} from './lib/storage.js'

import {
  migrationStatus, migrateWorkspace, migrateHabit, verifyMigration,
  legacyWorkspaceDir, legacyHabitDir,
} from './lib/migrate.js'

export const name = 'dsh-memory-tree'
export const inject = ['tools', 'webServer']

const ROUTE = '/dsh-memory-tree'

/* ------------------------------------------------------------------ helpers */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Machine-wide grouping preference.
 *
 * Loaded from `habitDir/config.json` at startup and rewritten by
 * `/api/settings`, so toggling AI grouping in the panel covers every workspace
 * rather than one at a time.
 */
let groupsConfig = null

/**
 * Last route seen on an Agent call.
 *
 * The panel triggers grouping over HTTP, where there is no agent in scope, so the
 * tool path records what the session is using and the route reads it back. Null
 * means "never seen one yet", which makes grouping fall back to a generic pick.
 */
let lastSessionRoute = null

/**
 * The model this session is talking to, as `{ provider, model }`.
 *
 * DSH does not document a flat field for this, so a few shapes are tried in
 * turn: an explicit call config, the session header, and the agent's own
 * defaults. Anything missing returns null, which makes `pickModel` fall through
 * to its generic choice instead of failing.
 */
function sessionRoute(agent) {
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object') return null
    const provider = obj.provider || obj.providerId
    const model = obj.model || obj.modelId
    if (provider && model) return { provider: String(provider), model: String(model) }
    return null
  }
  const tries = [
    agent?.session?.callConfig,
    agent?.session?.header?.model && agent.session.header,
    agent?.callConfig,
    agent?.model && agent,
  ]
  for (const candidate of tries) {
    const route = pick(candidate)
    if (route) {
      lastSessionRoute = route
      return route
    }
  }
  return null
}

function configFor(dir) {
  // A per-tree `config.json` may still override this, which lets one project opt
  // out without touching the others.
  const merged = { ...DEFAULTS, ...loadConfig(dir) }
  if (merged.groups === undefined && groupsConfig) Object.assign(merged, groupsConfig)
  return merged
}

/** The session's working directory is the task-tree host; the habit tree is global. */
function resolveDirs(agent, ctx) {
  let dir = ''
  try {
    const session = agent?.session
    dir = ctx.workingDirectory?.get?.(session) || ''
  } catch { /* fall through to the header */ }
  if (!dir) {
    try { dir = agent?.session?.header?.cwd || '' } catch { /* none */ }
  }
  if (!dir) dir = ctx.workingDirectory?.defaultDirectory || process.cwd()
  return { taskDir: dir, habitDir: habitHostDir(dshHome()) }
}

function ok(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

function fail(message, code = 'memory_tree_error') {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: code, message }) }],
    isError: true,
  }
}

/** Compact JSON is the whole point of the token budget: no pretty printing. */
const json = (value) => JSON.stringify(value)

/* -------------------------------------------------------------- the engine */

export function apply(ctx, config) {
  // Mutable on purpose: the settings endpoint can rewrite storage and retention
  // preferences at runtime, and every helper below reads through this binding.
  let cfg = { ...DEFAULTS, ...(config || {}) }

  const habitDir = habitHostDir(dshHome())
  const ready = (dir) => {
    try { fs.mkdirSync(treeRoot(dir), { recursive: true }) } catch { /* read-only is fine */ }
    return dir
  }

  /* ------------------------------------------------------------- tools */

  ctx.tools.register({
    name: 'memory_grow',
    description:
      '把本次任务里值得记住的里程碑写进双树记忆：决策、纠错、可复用结论、未完成事项。' +
      '只在任务边界调用（阶段完成 / 决策拍板 / 上下文将满 / 用户明确要求记下来），单批 1-8 条。' +
      '寒暄、纯确认语、工具噪声不要写。正文写进日志文件，树里只留摘要+关键词+指针。',
    parameters: {
      type: 'object',
      properties: {
        tree: {
          type: 'string',
          enum: ['task', 'habit'],
          description: 'task = 当前工作目录的任务记忆；habit = 全机共享的用户习惯/偏好。默认 task。',
        },
        trunk: { type: 'string', description: '树干（领域名）。省略则复用已有干或「默认领域」；习惯树固定「用户习惯」。' },
        branch: { type: 'string', description: '枝（任务线名）。同名枝自动复用——这就是跨会话续接点。' },
        branch_id: { type: 'string', description: '已知枝 id 时直接续挂，优先级高于 branch 名。' },
        nodes: {
          type: 'array',
          description: '本批要写的记忆条目，1-8 条。',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: TYPES, description: 'decision/deadend/fact/task/issue/constraint 最有价值。' },
              title: { type: 'string', description: '≤20 字导航短标题，不写句子。' },
              summary: { type: 'string', description: '≤60 字自足摘要：脱离上下文也能读懂，禁止「参见上文」。' },
              keywords: { type: 'array', items: { type: 'string' }, description: '1-5 个检索关键词；习惯节点建议 ≥4 含同义词。' },
              content: { type: 'string', description: '正文全文，写进日志文件。决策要含理由与舍弃的备选。' },
              importance: { type: 'number', description: '0-1 基线重要度，省略按类型给默认值。' },
              status: { type: 'string', description: 'task/issue 用 open/done/blocked/closed/dropped。' },
              next_hint: { type: 'string', description: 'task/issue 必填：可执行的一步，禁止「继续推进」这类空话。' },
              update_of: { type: 'string', description: '替换旧结论时填旧节点 id，自动生成 supersedes 演进链。' },
              related_to: { type: 'array', items: { type: 'string' }, description: '跨枝软链目标 id，最多 3 个。' },
            },
            required: ['type', 'title', 'summary', 'keywords', 'content'],
          },
        },
      },
      required: ['nodes'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const { taskDir, habitDir: hDir } = resolveDirs(exec.agent, ctx)
      const tree = args?.tree === 'habit' ? 'habit' : 'task'
      const dir = tree === 'habit' ? ready(hDir) : ready(taskDir)

      // A task tree may only be written from inside its own workspace. Writing
      // into someone else's tree is how a memory system becomes untrustworthy.
      const policy = canWriteTree({ treeType: tree, agentDir: taskDir, targetDir: dir })
      if (!policy.allowed) return fail(policy.message || policy.error, policy.error)

      // The habit tree changes only on a stated preference, never on task chatter.
      if (tree === 'habit') {
        const verdict = habitWriteAllowed(args?.utterance || '', args?.explicit === true)
        if (!verdict.allowed) {
          return ok({
            ok: false,
            error: 'habit_not_warranted',
            message: '用户没有明确表达习惯或偏好。习惯树只在这种时候更新。',
            verdict,
          })
        }
      }

      try {
        // Update in place when a node already says the same thing, instead of
        // appending a second copy of it.
        const updates = []
        const fresh = []
        const existing = loadTree(dir, tree)
        for (const node of args?.nodes || []) {
          const duplicate = existing ? findDuplicate(existing, node) : null
          if (!duplicate) { fresh.push(node); continue }
          updates.push({ id: duplicate.id, title: duplicate.title, incoming: node.title })
        }

        const result = fresh.length
          ? grow(dir, tree, { ...args, nodes: fresh }, configFor(dir))
          : { ok: true, created: [], message: '全部为重复内容，未新增节点' }

        // Apply the updates to the nodes that were already there.
        for (const item of updates) {
          try {
            editNode(dir, tree, item.id, {
              summary: String(args.nodes.find((n) => n.title === item.incoming)?.summary || '').slice(0, 200) || undefined,
              keywords: args.nodes.find((n) => n.title === item.incoming)?.keywords,
              importance: args.nodes.find((n) => n.title === item.incoming)?.importance,
            })
          } catch { /* a failed in-place update must not lose the batch */ }
        }

        // Group the branch we just wrote into, so a batch of six memories does not
        // land as six siblings. Best effort by design: grouping is cosmetic, and a
        // model that is missing or slow must not turn a successful write into a
        // failure — the tree stays correct, just unsorted.
        let grouping = null
        if (fresh.length && configFor(dir).groups !== false) {
          try {
            const view = treeView(dir, tree, configFor(dir))
            const parentId = result?.branch?.id && view.nodes?.[result.branch.id] ? result.branch.id : null
            if (parentId) {
              const done = await groupBranch(view, parentId, {
                llm: ctx.get('llm'),
                preferred: configFor(dir).groups_model,
                session: sessionRoute(exec.agent),
              })
              if (done.grouped) {
                saveGroups(dir, tree, done.tree.groups)
                grouping = { grouped: done.grouped, provider: done.provider, model: done.model }
              } else {
                grouping = { grouped: 0, reason: done.reason }
              }
            }
          } catch { /* grouping failure is never a write failure */ }
        }

        return ok({
          ...result,
          dir,
          updated: updates,
          ...(grouping ? { grouping } : {}),
          ...(updates.length ? { note: `${updates.length} 条已存在，就地更新而非重复添加` } : {}),
        })
      } catch (error) {
        if (error instanceof GrowError) return fail(error.message, 'invalid_batch')
        return fail(String(error?.message || error))
      }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description:
      '沿双树三跳找回已遗忘的背景。**默认不要调用**：正常工作只靠当前上下文和日志。' +
      '仅当用户明确回溯（「之前那个」「上次说的」「前几天提到的」）时才用。' +
      '本工具只返回摘要与指针，不读正文；确认是用户要找的之后再用 memory_open。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格/逗号分隔，2-4 个效果最好。' },
        tree: { type: 'string', enum: ['task', 'habit', 'all'], description: '默认 task；跨工作区检索会被拒绝。' },
        topn: { type: 'number', description: '每棵树返回条数，默认 3；别贪大，会超 token 预算。' },
        utterance: {
          type: 'string',
          description: '用户原话。用于判断是否真的在回溯；不带上下文时会被门禁拒绝。',
        },
        confirmed: {
          type: 'boolean',
          description: '用户已确认这些候选就是他要找的。未确认时只返回候选，不展开。',
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const { taskDir, habitDir: hDir } = resolveDirs(exec.agent, ctx)
      const topn = Math.min(8, Math.max(1, Number(args?.topn) || 3))
      const which = args?.tree || 'task'

      // The gate: without a referential utterance there is nothing to recall.
      // `confirmed` bypasses it because the user already said yes to candidates.
      if (!args?.confirmed) {
        const gate = shouldSearch(args?.utterance || args?.query || '')
        if (!gate.allowed) {
          return ok({
            ok: false,
            error: 'recall_not_requested',
            message: '用户没有在回溯过去的内容，不要检索记忆。正常工作用当前上下文即可。',
            gate,
          })
        }
      }

      const out = []
      if (which === 'task' || which === 'all') {
        const tree = loadTree(taskDir, 'task')
        if (tree) {
          // Candidates only: titles and summaries, never a document body.
          const proposed = proposeRecall(tree, args.query, configFor(taskDir), { topn })
          out.push({ tree: 'task', dir: taskDir, mode: 'propose', ...proposed })
        } else {
          out.push({ tree: 'task', dir: taskDir, mode: 'empty', candidates: [] })
        }
      }
      if (which === 'habit' && loadTree(hDir, 'habit')) {
        const proposed = proposeRecall(loadTree(hDir, 'habit'), args.query, configFor(hDir), { topn })
        out.push({ tree: 'habit', dir: hDir, mode: 'propose', ...proposed })
      }

      const total = out.reduce((sum, r) => sum + (r.candidates?.length || 0), 0)
      return ok({
        ok: true,
        dirs: { task: taskDir, habit: hDir },
        results: out,
        next: total
          ? '把候选念给用户确认；用户说是，再带 confirmed:true 复调本工具，或用 memory_open 取原文。'
          : '没有命中。不要扩大到其它工作区的记忆树。',
      })
    },
  })

  ctx.tools.register({
    name: 'memory_open',
    description:
      '顺着指针读回原文（±10 行）。只有确认需要逐字细节时才用；定位本身用 memory_search。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '节点 id（n_/b_/t_ 开头）。' },
        tree: { type: 'string', enum: ['task', 'habit'], description: '默认 task，找不到自动查习惯树。' },
        window: { type: 'number', description: '上下各带多少行，默认 10。' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const { taskDir, habitDir: hDir } = resolveDirs(exec.agent, ctx)
      const id = String(args?.id || '')
      const order = args?.tree === 'habit' ? [hDir, taskDir] : [taskDir, hDir]
      for (const dir of order) {
        const tree = loadTree(dir, 'task') || loadTree(dir, 'habit')
        const node = tree?.nodes?.[id]
        if (!node) continue
        const segment = readPtr(dir, node.pointer, Math.min(40, Number(args?.window) || 10))
        return ok({
          ok: true,
          id,
          title: node.title,
          type: node.type,
          summary: node.summary,
          pointer: node.pointer,
          segment: segment?.segment ?? null,
          note: segment ? null : '该节点没有可读的日志原文',
        })
      }
      return fail(`找不到节点 ${id}`, 'not_found')
    },
  })

  ctx.tools.register({
    name: 'memory_brief',
    description:
      '中断缝合：生成 ≤200 字 resume brief（目标/已定/未决/下一步/冲突），新会话只读它就能接着干。' +
      '会话将满、要换新会话、或接手别人的任务时调用。同时返回上一条 next_action 是否已完成。',
    parameters: {
      type: 'object',
      properties: {
        include_habit: { type: 'boolean', description: '同时附上习惯树热层偏好，让新会话先懂用户。默认 true。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const { taskDir, habitDir: hDir } = resolveDirs(exec.agent, ctx)
      const brief = buildBrief(taskDir, configFor(taskDir), dshHome())
      let preferences = null
      if (args?.include_habit !== false) {
        const habit = loadTree(hDir, 'habit')
        if (habit) {
          const hot = Object.values(habit.nodes)
            .filter((n) => n.state === 'active' && n.layer === 'leaf')
            .sort((a, b) => (b.access_count || 0) - (a.access_count || 0))
            .slice(0, 5)
            .map((n) => ({ id: n.id, title: n.title, summary: n.summary }))
          if (hot.length) preferences = hot
        }
      }
      return ok({ ...brief, ...(preferences ? { preferences } : {}), dir: taskDir })
    },
  })

  /* ------------------------------------------------- retention / habit tools */

  /** Where the storage root actually is, honouring the user's choice. */
  const rootDir = () => resolveRoot(cfg.root, dshHome())

  // Point the engine at the chosen layout as soon as the plugin starts, so every
  // read and write after this line lands in memory-data instead of the old
  // per-workspace `.memory-tree`. An empty root keeps the legacy layout, which
  // is what an install that has not migrated yet still needs.
  const applyLayout = () => {
    try { setDataRoot(rootDir()) } catch { /* an unset root falls back to legacy */ }
  }
  applyLayout()

  // Pick up the machine-wide grouping choice written by an earlier session, so the
  // panel's switch survives a restart instead of silently reverting.
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(habitDir, 'config.json'), 'utf8'))
    if (saved && typeof saved.groups === 'object' && saved.groups) groupsConfig = saved.groups
  } catch { /* no settings yet, or unreadable: keep the defaults */ }

  /** Retention settings for one workspace, falling back to the defaults. */
  const retentionFor = () => ({
    ...RETENTION_DEFAULTS,
    ...(config?.retention || cfg.retention || {}),
  })

  ctx.tools.register({
    name: 'memory_habit',
    description:
      '读取用户习惯快照。**每个新会话开始时调用一次**：返回偏好与约束的标题，' +
      '用来按用户习惯工作。只返回标题不返回正文，体积很小。' +
      '注意：这只含习惯，不含任何任务树内容。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回几条，默认 8。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args) {
      const root = rootDir()
      const snapshot = habitSnapshot(root, Math.min(20, Math.max(1, Number(args?.limit) || 8)))
      return ok({
        ...snapshot,
        hint: snapshot.empty
          ? '习惯树还是空的。用户明确提出偏好时再用 memory_grow(tree:habit) 写入。'
          : '按这些偏好工作。不要把任务树内容也带进来。',
      })
    },
  })

  ctx.tools.register({
    name: 'memory_retention',
    description:
      '查看与调整记忆保留策略。查看当前占用、每个记忆批次的锁状态与到期时间；' +
      '锁定某些批次使其永不被清理；按空间上限精简（锁定树豁免）。' +
      '批次是 monthly/YYYYMMDD-HHmm 目录，一次对话一批。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'lock', 'unlock', 'lock_tree', 'unlock_tree', 'expire', 'compact'],
          description: 'status 看状态；lock/unlock 单个批次；lock_tree/unlock_tree 整棵树；expire/compact 执行清理。',
        },
        batch: { type: 'string', description: 'lock/unlock 时必填：批次名，如 20261117-1903。' },
        dry_run: { type: 'boolean', description: 'expire/compact 时只报告将要删除什么，不实际删除。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const { taskDir } = resolveDirs(exec.agent, ctx)
      const root = rootDir()
      const retention = retentionFor()
      const action = String(args?.action || 'status')

      if (action === 'status') {
        const quota = quotaStatus(root, taskDir, retention)
        const plan = quotaCandidates(root, taskDir, retention)
        return ok({
          ok: true,
          dir: taskDir,
          root,
          expire_days: retention.expire_days,
          quota: {
            bytes: quota.bytes,
            limit: quota.limit,
            used_ratio: Number(quota.ratio.toFixed(3)),
            over: quota.over,
          },
          locks: readLocks(root, taskDir),
          batches: batchReport(root, taskDir, retention),
          compact_preview: plan.over
            ? { candidates: plan.candidates.map((b) => b.name), escalated: plan.escalated, sufficient: plan.sufficient }
            : null,
        })
      }

      if (action === 'lock' || action === 'unlock') {
        const batch = String(args?.batch || '')
        if (!batch) return fail('missing_batch', 'missing_batch')
        return ok({ ok: true, locks: setBatchLock(root, taskDir, batch, action === 'lock') })
      }

      if (action === 'lock_tree' || action === 'unlock_tree') {
        return ok({ ok: true, locks: setTreeLock(root, taskDir, action === 'lock_tree') })
      }

      if (action === 'expire') {
        return ok(expireBatches(root, taskDir, retention, { dry: args?.dry_run === true }))
      }

      if (action === 'compact') {
        return ok(compactToQuota(root, taskDir, retention, { dry: args?.dry_run === true }))
      }

      return fail('unknown_action', `unknown action: ${action}`)
    },
  })

  ctx.tools.register({
    name: 'memory_migrate',
    description:
      '把旧布局（工作区里的 .memory-tree/）迁移到新的 memory-data 结构。' +
      '只复制不删除：旧目录原样保留，可随时回退。已经迁过的不重复覆盖。' +
      'action=status 先看有什么待迁；action=run 真正执行并校验节点数一致。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'run'], description: '默认 status：只报告，不动磁盘。' },
        include_habit: { type: 'boolean', description: 'run 时是否一并迁移习惯树，默认 true。' },
        force: { type: 'boolean', description: '目标已存在时覆盖。默认 false，宁可拒绝。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const root = rootDir()
      const home = dshHome()
      const { taskDir } = resolveDirs(exec.agent, ctx)

      // Every workspace the registry knows about, plus the one in use right now.
      const known = new Set(listTaskTrees(home).map((t) => t.dir))
      known.add(taskDir)

      const status = migrationStatus({ root, dshHome: home, workspaces: [...known] })

      if ((args?.action || 'status') === 'status') {
        return ok({ ok: true, root, ...status, hint: status.pending ? '确认后 action=run 执行迁移。旧数据会保留。' : '没有待迁移的数据。' })
      }

      const results = []
      for (const entry of status.entries) {
        if (entry.state !== 'pending' && !args?.force) {
          results.push({ dir: entry.dir, kind: entry.kind, skipped: 'already' })
          continue
        }
        if (entry.kind === 'habit') {
          if (args?.include_habit === false) { results.push({ kind: 'habit', skipped: 'excluded' }); continue }
          results.push({ kind: 'habit', ...migrateHabit({ root, dshHome: home, force: args?.force }) })
        } else {
          const moved = migrateWorkspace({ root, dir: entry.dir, force: args?.force })
          const check = moved.ok ? verifyMigration({ root, dir: entry.dir }) : null
          results.push({ kind: 'task', ...moved, verify: check })
        }
      }

      const failed = results.filter((r) => r.ok === false && !r.skipped)
      return ok({
        ok: failed.length === 0,
        root,
        results,
        legacy_kept: '旧 .memory-tree 目录未删除，回退时直接删掉 memory-data 即可。',
      })
    },
  })

  ctx.tools.register({
    name: 'memory_maintain',
    description:
      '记忆树的维护与自测诊断。action=diagnose 看哪些节点该复习/疑似重复/卡住；' +
      'delete/restore 是软删与还原（30 天内可逐字段复原，日志原文从不删）；' +
      'purge 清理过期回收站；orphans 报告无引用的日志（只报告不删）；rebuild 从备份或日志重建损坏的树；' +
      'merge 合并锁冲突时暂存的批次；status 看总览。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['diagnose', 'delete', 'restore', 'purge', 'orphans', 'rebuild', 'merge', 'status', 'export'],
        },
        tree: { type: 'string', enum: ['task', 'habit'], description: '默认 task。' },
        id: { type: 'string', description: 'delete 时必填：要删的节点 id。' },
        mode: { type: 'string', enum: ['subtree', 'self'], description: 'delete：连子树一起删，或仅删本节点子节点上移。' },
        note: { type: 'string', description: 'delete 备注：为什么删，用于改进判定规则。' },
        entry_id: { type: 'string', description: 'restore 时必填：回收条目 id（r_ 开头）。' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: json(value) }],
    },
    async execute(args, exec) {
      const { taskDir, habitDir: hDir } = resolveDirs(exec.agent, ctx)
      const tree = args?.tree === 'habit' ? 'habit' : 'task'
      const dir = tree === 'habit' ? hDir : taskDir
      const cfg = configFor(dir)
      const action = args?.action
      try {
        switch (action) {
          case 'diagnose':
            return ok({ ...diagnose(dir, cfg), tree, dir })
          case 'delete':
            if (!args?.id) return fail('delete 需要 id', 'missing_id')
            return ok(gcDelete(dir, tree, args.id, args.mode || 'subtree', args.note || ''))
          case 'restore':
            if (!args?.entry_id) return fail('restore 需要 entry_id', 'missing_entry')
            return ok(gcRestore(dir, tree, args.entry_id))
          case 'purge':
            return ok(gcPurge(dir, cfg))
          case 'orphans':
            return ok(gcOrphans(dir))
          case 'rebuild':
            return ok(gcRebuild(dir, tree))
          case 'merge':
            return ok(mergeStaging(dir, tree, cfg))
          case 'export':
            return ok({ ok: true, tree: exportTree(dir, tree) })
          case 'status':
          default: {
            const view = treeView(dir, tree, cfg)
            return ok({
              ok: true, tree, dir,
              exists: view.exists,
              stats: view.stats,
              recycle: view.recycle,
              updated_at: view.updated_at,
            })
          }
        }
      } catch (error) {
        return fail(String(error?.message || error))
      }
    },
  })

  /* -------------------------------------------------------- HTTP surface */

  /** Same-origin guard: refuse cross-site writes from a page in another origin. */
  const sameOrigin = (req) => {
    const origin = req.headers?.origin
    if (!origin) return true
    try {
      const host = req.headers?.host
      return new URL(origin).host === host
    } catch { return false }
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 1_000_000) { reject(new Error('body_too_large')); req.destroy(); return }
      raw += chunk
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('invalid_json')) }
    })
    req.on('error', reject)
  })

  const send = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /** Only paths that already look like a memory host may be addressed. */
  const safeDir = (candidate) => {
    if (!candidate || typeof candidate !== 'string') return null
    const resolved = path.resolve(candidate)
    if (resolved === path.resolve(habitDir)) return resolved
    if (!path.isAbsolute(resolved)) return null
    return resolved
  }

  /** When a workspace's tree was moved to the trash, from its registry mark. */
  const deletedAtFor = (dir) => {
    try {
      const registry = JSON.parse(
        fs.readFileSync(path.join(habitDir, 'registry.json'), 'utf8').replace(/^\uFEFF/, ''),
      )
      const found = (registry.trees || []).find((t) => path.resolve(t.dir) === path.resolve(dir))
      return found?.deleted_at || null
    } catch { return null }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    async handler(req, res) {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const tail = url.pathname.slice(ROUTE.length) || '/'

        if (req.method === 'GET' && (tail === '/api/state' || tail === '/')) {
          const requested = safeDir(url.searchParams.get('dir'))

          // A workspace whose tree was deleted on purpose keeps its shell so it can
          // be restored; only an entry with no tree AND no deletion mark is stale
          // (its directory moved away), and that one must drop out of the picker.
          const workspaces = listTaskTrees(dshHome())
            .filter((entry) => {
              if (entry.deleted_at) return true
              try { return fs.existsSync(treeFile(entry.dir)) } catch { return false }
            })
            .map((entry) => {
              let nodes = 0
              let hot = 0
              try {
                const view = treeView(entry.dir, 'task', configFor(entry.dir))
                nodes = view.stats?.nodes ?? 0
                hot = view.stats?.tiers?.hot ?? 0
              } catch { /* an unreadable tree simply reports zero */ }
              return {
                dir: entry.dir,
                title: entry.title || path.basename(entry.dir),
                updated_at: entry.updated_at || null,
                deleted_at: entry.deleted_at || null,
                // Whether the recycle bin still holds a copy. A workspace keeps its
                // `deleted_at` mark after the payload is gone, so without this the
                // panel kept offering "recoverable" for a tree nothing could restore.
                recoverable: !!entry.trash_entry,
                // Locking is shown per row in the rail, so the list must carry it.
                locked: (() => {
                  try { return readLocks(rootDir(), entry.dir).tree === true } catch { return false }
                })(),
                nodes,
                hot,
              }
            })

          // Which tree to render. `requested` wins; otherwise fall back to the
          // first workspace ONLY when the caller did not name one at all. The
          // panel always names it, so a background refresh can no longer switch
          // the view to whichever tree was written most recently.
          const dir = requested || workspaces[0]?.dir || null
          const task = dir ? treeView(dir, 'task', configFor(dir)) : null
          const habit = fs.existsSync(treeFile(habitDir))
            ? treeView(habitDir, 'habit', configFor(habitDir))
            : { exists: false, nodes: {}, edges: [], recycle: [], stats: null }
          send(res, 200, {
            ok: true,
            current: dir,
            trees: workspaces.map((w) => w.dir),
            workspaces,
            task,
            habit,
            config: dir ? configFor(dir) : DEFAULTS,
            diagnose: dir ? diagnose(dir, configFor(dir)) : null,
          })
          return
        }

        if (req.method === 'GET' && tail === '/api/log') {
          const dir = safeDir(url.searchParams.get('dir'))
          const pointer = url.searchParams.get('pointer')
          if (!dir || !pointer) { send(res, 400, { ok: false, error: 'missing_params' }); return }
          const window = Math.min(40, Number(url.searchParams.get('window')) || 6)
          const segment = readPointer(dir, pointer, window)
          send(res, segment ? 200 : 404, segment ? { ok: true, ...segment } : { ok: false, error: 'not_found' })
          return
        }

        /** Which archived workspaces could still get a tree. */
        if (req.method === 'GET' && tail === '/api/scan') {
          const existing = new Set(listTaskTrees(dshHome(), { includeDeleted: false }).map((t) => t.dir))
          const workspaces = scanWorkspaces(dshHome()).map((ws) => ({
            dir: ws.dir,
            title: ws.title,
            messageCount: ws.messageCount,
            sessions: ws.sessions.length,
            hasTree: existing.has(path.resolve(ws.dir)),
            deletedAt: deletedAtFor(ws.dir),
          }))

          // Whether AI mode can run at all, so the panel can disable that card
          // instead of letting the user pick a path that is bound to fail.
          let aiReady = false
          let aiProvider = ''
          let aiModel = ''
          const llm = ctx.get?.('llm')
          if (llm) {
            try {
              const providers = await llm.listProviders?.() || []
              for (const entry of providers) {
                const id = String(entry?.id || '')
                if (!id) continue
                const models = await llm.listModels?.(id) || []
                const first = models.find((m) => m?.id)
                if (!first) continue
                aiReady = true
                aiProvider = id
                aiModel = String(first.id)
                break
              }
            } catch { /* an adapter that throws simply means no AI mode */ }
          }

          send(res, 200, { ok: true, workspaces, aiReady, aiProvider, aiModel })
          return
        }

        /** Trees waiting in the whole-tree recycle bin. */
        if (req.method === 'GET' && tail === '/api/trash') {
          send(res, 200, { ok: true, entries: listTreeRecycle(dshHome()) })
          return
        }

        /** Storage, retention and lock state for the current workspace. */
        if (req.method === 'GET' && tail === '/api/settings') {
          const dir = safeDir(url.searchParams.get('dir')) || listTaskTrees(dshHome())[0]?.dir || null
          const root = rootDir()
          const retention = retentionFor()
          if (!dir) {
            send(res, 200, { ok: true, root, retention, dir: null, migration: { entries: [], pending: 0, already: 0 } })
            return
          }
          const known = new Set(listTaskTrees(dshHome()).map((t) => t.dir))
          known.add(dir)

          // Every "provider/model" route the panel can pin for grouping. Listing
          // them here keeps the settings picker honest: a stale choice would
          // otherwise stay in the dropdown forever.
          const routes = []
          try {
            const llm = ctx.get?.('llm')
            const providers = await llm?.listProviders?.() || []
            for (const entry of providers) {
              const id = String(entry?.id || '')
              if (!id) continue
              const list = await llm.listModels?.(id) || []
              for (const m of list) if (m?.id) routes.push(`${id}/${m.id}`)
            }
          } catch { /* no llm service simply means an empty picker */ }

          send(res, 200, {
            ok: true,
            dir,
            root,
            retention,
            groups: groupsConfig || {},
            groupModels: routes,
            quota: quotaStatus(root, dir, retention),
            locks: readLocks(root, dir),
            batches: batchReport(root, dir, retention),
            migration: migrationStatus({ root, dshHome: dshHome(), workspaces: [...known] }),
          })
          return
        }

        if (req.method === 'POST') {
          if (!sameOrigin(req)) { send(res, 403, { ok: false, error: 'cross_origin' }); return }
          const body = await readBody(req)
          const tree = body.tree === 'habit' ? 'habit' : 'task'

          // The tree recycle bin is machine-wide, not per workspace: every action
          // on it is keyed by entry id or by age. Requiring a workspace here only
          // rejected the request, which is why restore and the age sweep failed
          // for any caller that did not already happen to include one.
          if (tail === '/api/tree-purge') {
            // An entry id removes that one tree whatever its age, which is the
            // only way to clear a freshly deleted tree before it expires.
            if (body.entry_id) {
              send(res, 200, purgeTreeEntry(dshHome(), String(body.entry_id)))
              return
            }
            const days = Number(body.days ?? retentionFor().recycle_days) || 0
            send(res, 200, purgeTreeRecycle(dshHome(), days))
            return
          }

          /** Put a trashed tree back, replacing or merging with what is there. */
          if (tail === '/api/tree-restore') {
            const entryId = String(body.entry_id || '')
            if (!entryId) { send(res, 400, { ok: false, error: 'missing_entry' }); return }

            const entry = listTreeRecycle(dshHome()).find((e) => e.entry_id === entryId)
            if (!entry) { send(res, 404, { ok: false, error: 'entry_not_found' }); return }

            // Without an explicit mode the caller is only asking what would happen:
            // report the live tree so the panel can offer overwrite or merge.
            const mode = body.mode === 'merge' ? 'merge' : (body.mode === 'overwrite' ? 'overwrite' : null)
            if (!mode) {
              const live = fs.existsSync(treeFile(entry.dir))
              let liveNodes = 0
              if (live) {
                try {
                  const view = treeView(entry.dir, 'task', configFor(entry.dir))
                  liveNodes = view.stats?.nodes ?? Object.keys(view.nodes || {}).length
                } catch { /* an unreadable tree still counts as present */ }
              }
              // `ok` follows whether anything blocks the restore. Reporting false
              // for a workspace with no live tree made a plain restore look like a
              // failure the caller could never resolve.
              send(res, 200, {
                ok: !live,
                error: live ? 'tree_exists' : null,
                needsConfirm: live,
                liveNodes,
                entry: { entry_id: entry.entry_id, title: entry.title, dir: entry.dir, nodes: entry.nodes },
              })
              return
            }

            send(res, 200, restoreWholeTree(entryId, dshHome(), mode))
            return
          }

          /**
           * Drop a deleted workspace's shell from the panel.
           *
           * Keyed by the workspace directory, and it never touches that directory —
           * it only removes the registry entry so an empty shell stops cluttering
           * the list. Refused while a live tree exists.
           */
          if (tail === '/api/shell-remove') {
            const target = safeDir(body.dir)
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
            send(res, 200, removeDeletedShell(dshHome(), target))
            return
          }

          /**
           * Name one index bucket, letting the model redraw its membership.
           *
           * POST /api/bucket-name { dir, tree, parent, bucket }
           *
           * A bucket is a blind size-slice, so its members often tell two stories.
           * The model may split them; see `nameBucket`.
           */
          if (tail === '/api/bucket-name') {
            const target = tree === 'habit' ? habitDir : safeDir(body.dir)
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
            const cfg = configFor(target)
            if (cfg.groups === false) {
              send(res, 200, { ok: false, error: 'groups_disabled' })
              return
            }
            const parentId = String(body.parent || '')
            const bucketId = String(body.bucket || '')
            if (!parentId || !bucketId) { send(res, 400, { ok: false, error: 'missing_parent_or_bucket' }); return }

            const view = treeView(target, tree, cfg)
            if (!view.exists) { send(res, 404, { ok: false, error: 'no_tree' }); return }

            const done = await nameBucket(view, parentId, bucketId, {
              llm: ctx.get('llm'),
              preferred: cfg.groups_model,
              session: lastSessionRoute,
            })
            if (done.grouped > 0) saveGroups(target, tree, done.tree.groups)
            send(res, 200, {
              ok: done.grouped > 0,
              grouped: done.grouped,
              reason: done.reason,
              provider: done.provider,
              model: done.model,
              ...(done.titles ? { titles: done.titles } : {}),
              ...(done.sample ? { sample: done.sample } : {}),
              summary: groupSummary(done.tree),
            })
            return
          }

          /**
           * Semantic grouping of a branch's children.
           *
           * POST /api/group       { dir, tree, parent?, force? } run the model
           * POST /api/group-edit  { dir, tree, action, group_id, ... } rename/merge/dissolve
           *
           * Grouping is the one feature that costs a model call, so it is always
           * explicit: the user asks for it, or `memory_grow` runs it for the branch
           * it just wrote. Nothing re-groups on load.
           */
          if (tail === '/api/group') {
            const target = tree === 'habit' ? habitDir : safeDir(body.dir)
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
            const cfg = configFor(target)
            if (cfg.groups === false) {
              send(res, 200, { ok: false, error: 'groups_disabled' })
              return
            }
            const view = treeView(target, tree, cfg)
            if (!view.exists) { send(res, 404, { ok: false, error: 'no_tree' }); return }

            const preferred = cfg.groups_model
            const parentId = body.parent ? String(body.parent) : null
            const done = parentId
              ? await groupBranch(view, parentId, { llm: ctx.get('llm'), preferred, session: lastSessionRoute })
              : await groupTree(view, { llm: ctx.get('llm'), preferred, session: lastSessionRoute })

            if (done.tree !== view) saveGroups(target, tree, done.tree.groups)
            send(res, 200, {
              ok: done.grouped > 0,
              grouped: done.grouped,
              skipped: done.skipped,
              reason: done.reason,
              provider: done.provider,
              model: done.model,
              // The raw reply is the only way to fix a prompt the model ignores;
              // without it "unusable" tells nobody what to change.
              ...(done.sample ? { sample: done.sample } : {}),
              summary: groupSummary(done.tree),
            })
            return
          }

          if (tail === '/api/group-edit') {
            const target = tree === 'habit' ? habitDir : safeDir(body.dir)
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
            const view = treeView(target, tree, configFor(target))
            if (!view.exists) { send(res, 404, { ok: false, error: 'no_tree' }); return }

            const action = String(body.action || '')
            const groupId = String(body.group_id || '')
            let outcome
            if (action === 'rename') outcome = renameGroup(view, groupId, body.title)
            else if (action === 'dissolve') outcome = dissolveGroup(view, groupId)
            else if (action === 'merge') outcome = mergeGroups(view, groupId, String(body.target_id || ''))
            else { send(res, 400, { ok: false, error: 'bad_action' }); return }

            if (!outcome.ok) { send(res, 200, outcome); return }
            saveGroups(target, tree, outcome.tree.groups)
            send(res, 200, { ok: true, summary: groupSummary(outcome.tree) })
            return
          }

          const dir = tree === 'habit' ? habitDir : safeDir(body.dir)
          if (!dir) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
          const cfg = configFor(dir)

          if (tail === '/api/delete') {
            send(res, 200, gcDelete(dir, tree, body.id, body.mode || 'subtree', body.note || ''))
            return
          }
          if (tail === '/api/restore') {
            send(res, 200, gcRestore(dir, tree, body.entry_id))
            return
          }
          if (tail === '/api/purge') {
            send(res, 200, gcPurge(dir, cfg))
            return
          }
          if (tail === '/api/edit') {
            send(res, 200, editNode(dir, tree, body.id, body.patch || {}))
            return
          }
          if (tail === '/api/import') {
            send(res, 200, importTree(dir, tree, body.tree_data, dshHome()))
            return
          }

          /** Persist storage / retention / grouping preferences. */
          if (tail === '/api/settings') {
            const next = { ...cfg }
            if (typeof body.root === 'string') next.root = body.root.trim()
            if (body.retention && typeof body.retention === 'object') {
              next.retention = { ...(cfg.retention || {}), ...body.retention }
            }
            // Grouping: `groups:false` turns every automatic pass off; a model
            // pins which route does the work so a user can pick a cheap one.
            if (body.groups && typeof body.groups === 'object') {
              const g = {}
              if (typeof body.groups.enabled === 'boolean') g.groups = body.groups.enabled
              if (typeof body.groups.model === 'string') {
                const picked = body.groups.model.trim()
                // "provider/model" is the one form the picker emits.
                if (picked.includes('/')) {
                  const at = picked.indexOf('/')
                  g.groups_model = { provider: picked.slice(0, at), model: picked.slice(at + 1) }
                } else if (!picked) {
                  g.groups_model = null
                }
              }
              groupsConfig = { ...(groupsConfig || {}), ...g }
            }
            cfg = next
            // Persist next to the habit tree so the choice survives a restart.
            try {
              const file = path.join(habitDir, 'config.json')
              fs.mkdirSync(path.dirname(file), { recursive: true })
              fs.writeFileSync(file, JSON.stringify({
                root: cfg.root || '',
                retention: cfg.retention || {},
                ...(groupsConfig ? { groups: groupsConfig } : {}),
              }, null, 2), 'utf8')
            } catch { /* a read-only home still keeps the in-memory choice */ }
            send(res, 200, { ok: true, root: rootDir(), retention: retentionFor(), groups: groupsConfig || {} })
            return
          }

          /** Lock or unlock one memory batch. */
          if (tail === '/api/lock') {
            const target = safeDir(body.dir)
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
            const root = rootDir()
            if (body.batch) {
              send(res, 200, { ok: true, locks: setBatchLock(root, target, String(body.batch), body.locked !== false) })
              return
            }
            send(res, 200, { ok: true, locks: setTreeLock(root, target, body.locked !== false) })
            return
          }

          /** Run an expiry sweep or a quota compaction for one workspace. */
          if (tail === '/api/retention') {
            const target = safeDir(body.dir)
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }
            const root = rootDir()
            const retention = retentionFor()
            const dry = body.dry_run === true
            if (body.action === 'compact') {
              send(res, 200, compactToQuota(root, target, retention, { dry }))
              return
            }
            send(res, 200, expireBatches(root, target, retention, { dry }))
            return
          }

          /** Migrate legacy .memory-tree data into memory-data. */
          if (tail === '/api/migrate') {
            const root = rootDir()
            const home = dshHome()
            const known = new Set(listTaskTrees(home).map((t) => t.dir))
            if (dir) known.add(dir)
            const status = migrationStatus({ root, dshHome: home, workspaces: [...known] })

            if (body.action !== 'run') {
              send(res, 200, { ok: true, root, ...status })
              return
            }

            const results = []
            for (const entry of status.entries) {
              if (entry.state !== 'pending' && !body.force) {
                results.push({ kind: entry.kind, dir: entry.dir, skipped: 'already' })
                continue
              }
              if (entry.kind === 'habit') {
                results.push({ kind: 'habit', ...migrateHabit({ root, dshHome: home, force: body.force }) })
              } else {
                const moved = migrateWorkspace({ root, dir: entry.dir, force: body.force })
                results.push({
                  kind: 'task', ...moved,
                  verify: moved.ok ? verifyMigration({ root, dir: entry.dir }) : null,
                })
              }
            }
            send(res, 200, { ok: results.every((r) => r.ok !== false || r.skipped), root, results })
            return
          }

          /** Throw an entire workspace tree into the trash, recoverable. */
          if (tail === '/api/tree-delete') {
            if (tree === 'habit') { send(res, 400, { ok: false, error: 'habit_not_deletable' }); return }
            send(res, 200, deleteWholeTree(dir, dshHome(), 'task', body.note || ''))
            return
          }

          /**

           * Build a tree from a workspace's archived conversations.
           *
           * `mode` is `rules` (offline) or `ai` (model). An `ai` request needs the
           * Host `llm` service and the provider/model the caller wants billed.
           */
          if (tail === '/api/import-from-log') {
            const target = body.dir ? safeDir(body.dir) : null
            if (!target) { send(res, 400, { ok: false, error: 'missing_dir' }); return }

            const scope = body.scope === 'habit' ? 'habit' : 'task'
            const mode = body.mode === 'ai' ? 'ai' : 'rules'
            const hostDir = scope === 'habit' ? habitDir : target

            // A live tree is only replaceable on explicit confirmation.
            if (!body.confirm && fs.existsSync(treeFile(hostDir))) {
              send(res, 200, { ok: false, error: 'tree_exists', needsConfirm: true })
              return
            }

            const workspace = body.dir
              ? scanWorkspaces(dshHome()).find((w) => path.resolve(w.dir) === path.resolve(body.dir))
              : null
            if (body.dir && !workspace) {
              send(res, 404, { ok: false, error: 'workspace_not_found' }); return
            }

            const messages = workspace ? readWorkspaceMessages(workspace) : []
            if (!messages.length) {
              send(res, 200, { ok: false, error: 'no_messages' }); return
            }

            const llm = ctx.get?.('llm')
            let provider = String(body.provider || '')
            let model = String(body.model || '')

            // The panel has no way to know which route the current session uses,
            // so the Host picks one: the caller's if it named one, otherwise the
            // first registered provider that actually advertises a model. Asking
            // the caller for a value it cannot know was why AI mode always failed.
            if (mode === 'ai' && llm && (!provider || !model)) {
              try {
                const providers = await llm.listProviders?.() || []
                for (const entry of providers) {
                  const id = String(entry?.id || '')
                  if (!id) continue
                  const models = await llm.listModels?.(id) || []
                  const first = models.find((m) => m?.id)
                  if (!first) continue
                  provider = id
                  model = String(first.id)
                  break
                }
              } catch { /* fall through to the explicit error below */ }
            }

            // Asked for AI but no usable route exists: say so instead of
            // silently degrading, because the user chose that mode on purpose.
            if (mode === 'ai' && (!llm || !provider || !model)) {
              send(res, 200, {
                ok: false,
                error: 'llm_unavailable',
                detail: !llm ? 'Host 没有 llm 服务' : '没有可用的 provider/model',
              })
              return
            }

            const built = await buildTreeFromMessages({
              messages,
              scope,
              mode,
              llm: mode === 'ai' ? llm : null,
              provider,
              model,
              title: scope === 'habit' ? '用户习惯' : (workspace?.title || '任务记录'),
            })

            // A tree whose only node is the trunk carries no memory. Writing it
            // would replace a real tree with an empty one and show the user
            // nothing, so this is reported as "nothing extracted" instead.
            // `stats.total` counts extracted entries, so it is the honest test.
            const extracted = (built.stats?.total || 0)
            if (!extracted) {
              send(res, 200, {
                ok: false,
                error: 'nothing_extracted',
                detail: scope === 'habit'
                  ? `这 ${messages.length} 条消息里没有找到表述偏好的话（如「我更喜欢…」「以后都用…」）。`
                  : `这 ${messages.length} 条消息里没有找到决策或规则。`,
                stats: built.stats,
              })
              return
            }

            const saved = importTree(hostDir, scope, built.tree, dshHome())
            if (!saved?.ok) { send(res, 200, saved || { ok: false, error: 'save_failed' }); return }

            send(res, 200, {
              ok: true,
              scope,
              mode,
              stats: built.stats,
              nodes: Object.keys(built.tree.nodes).length,
            })
            return
          }

          send(res, 404, { ok: false, error: 'unknown_endpoint' })
          return
        }

        send(res, 405, { ok: false, error: 'method_not_allowed' })
      } catch (error) {
        try { send(res, 500, { ok: false, error: String(error?.message || error) }) } catch { /* socket gone */ }
      }
    },
  }), 'dsh-memory-tree.routes')

  /* ------------------------------------------------------------ registry */

  // Register the two trees the panel lists before anyone opens it.
  try {
    touchRegistry(habitDir, 'habit')
  } catch { /* registry is a convenience */ }
}

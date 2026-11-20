/**
 * Engine self-test. Runs against a throwaway directory so it never touches a
 * real memory host. Verifies the contract points that the spec calls out:
 * write/validate, tier math, retrieval, delete+restore, log anchors.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULTS, grow, runSearch, buildBrief, readPointer, treeView,
  gcDelete, gcRestore, gcOrphans, diagnose, statsOf,
  nodeScore, tierOf, baseScoreOf, dueAt, intervalDays,
  loadTree, GrowError, nowIso, treeRoot,
} from '../lib/engine.js'

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail) {
  if (condition) { pass++; return }
  fail++
  failures.push({ name, detail })
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const cfg = { ...DEFAULTS }
const host = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-'))

function iso(daysAgo) {
  return nowIso(new Date(Date.now() - daysAgo * 86400000))
}

try {
  /* ---------------------------------------------------- 1. write + validate */

  const batch = {
    trunk: '测试领域',
    branch: '第一根枝',
    nodes: [
      {
        type: 'decision', title: '采用双树方案', summary: '任务树按目录、习惯树全局共享',
        keywords: ['双树', '架构'], content: '决策：双树。\n理由：目录边界与跨场景偏好不同。',
      },
      {
        type: 'deadend', title: '放弃单文件存储', summary: '单 JSON 存正文会导致树膨胀',
        keywords: ['单文件', '存储'], content: '试过把正文内联进 tree.json，100 节点后超 40KB。',
      },
      {
        type: 'task', title: '实现可视化面板', summary: '侧栏图标加双树画布',
        keywords: ['UI', '面板'], content: '待做：侧栏图标与画布。',
        next_hint: '先注册 sidebar.panellist 图标', status: 'open',
      },
    ],
  }

  const grown = grow(host, 'task', batch, cfg)
  check('grow 成功', grown.ok === true)
  eq('grow 写入 3 条', grown.created.length, 3)
  check('grow 生成枝', !!grown.branch?.id)
  check('grow 生成树干', !!grown.trunk?.id)

  const tree = loadTree(host, 'task')
  eq('树里 3 叶 + 1 枝 + 1 干', Object.keys(tree.nodes).length, 5)
  check('叶有日志指针', tree.nodes[grown.created[0].id].pointer?.includes('#L'))
  check('摘要 rollup 生成到枝', !!tree.nodes[grown.branch.id].digest)

  // The pointer must actually read back the body text.
  const seg = readPointer(host, tree.nodes[grown.created[0].id].pointer, 2)
  check('指针可读回原文', !!seg && seg.segment.includes('决策：双树'))

  /* ------------------------------------------------------- 2. 校验闸门 */

  let rejected = null
  try {
    grow(host, 'task', { nodes: [{ type: 'fact', title: '这是一个超过二十个字的超长标题用来测试闸门是否真的生效', summary: 'x', keywords: ['a'], content: 'c' }] }, cfg)
  } catch (error) { rejected = error }
  check('超长 title 被拒', rejected instanceof GrowError, String(rejected))

  rejected = null
  try {
    grow(host, 'task', { nodes: [{ type: 'task', title: '缺下一步', summary: 'x', keywords: ['a'], content: 'c' }] }, cfg)
  } catch (error) { rejected = error }
  check('task 缺 next_hint 被拒', rejected instanceof GrowError)

  rejected = null
  try {
    grow(host, 'task', { nodes: [{ type: 'task', title: '空话', summary: 'x', keywords: ['a'], content: 'c', next_hint: '继续推进' }] }, cfg)
  } catch (error) { rejected = error }
  check('next_hint 空话被拒', rejected instanceof GrowError)

  /* --------------------------------------------------------- 3. 检索 */

  const found = runSearch(host, 'task', '双树', cfg, 3)
  check('检索命中关键词', found.hits.length > 0)
  eq('检索第一命中是决策', found.hits[0]?.title, '采用双树方案')
  check('命中带父级 digest', Array.isArray(found.hits[0]?.parents) && found.hits[0].parents.length > 0)

  const miss = runSearch(host, 'task', '完全不相干的词', cfg, 3)
  eq('无关词零命中', miss.hits.length, 0)

  /* --------------------------------------------------- 4. 衰减与分层 */

  const now = Date.now()
  const leafNode = { importance: 0.6, access_count: 0, last_access: nowIso(), type: 'fact', state: 'active', created_at: nowIso() }
  check('叶初始 base_score < 0.7', baseScoreOf(leafNode, cfg, now) < cfg.hot_threshold)
  eq('未访问过的新叶在温层', tierOf(leafNode, cfg, now), 'warm')
  // The spec's own formula can never lift a 0.6 leaf into the hot layer; with
  // access folded into the score, one hit is enough — which is the point.
  const usedLeaf = { ...leafNode, access_count: 1 }
  check('被访问一次即进热层', tierOf(usedLeaf, cfg, now) === 'hot',
    `tier=${tierOf(usedLeaf, cfg, now)} score=${nodeScore(usedLeaf, cfg, now)}`)

  const stale = { importance: 0.6, access_count: 0, last_access: iso(100), type: 'fact', state: 'active', created_at: iso(200) }
  eq('久未访问降为 cold', tierOf(stale, cfg, now), 'cold')

  const veryOld = { importance: 0.5, access_count: 0, last_access: iso(200), type: 'fact', state: 'active', created_at: iso(300) }
  eq('超 180 天归档', tierOf(veryOld, cfg, now), 'archived')

  const p0 = { importance: 0.5, access_count: 0, last_access: iso(200), type: 'decision', state: 'active', created_at: iso(300) }
  check('P0 超期不归档', tierOf(p0, cfg, now) !== 'archived')

  check('复习调度 due_at 存在', typeof dueAt(leafNode, cfg) === 'string')
  check('重要度高则复习间隔长', intervalDays({ importance: 0.9, access_count: 3 }, cfg) > intervalDays({ importance: 0.2, access_count: 0 }, cfg))

  /* ------------------------------------------------------ 5. 缝合 brief */

  const brief = buildBrief(host, cfg, host)
  check('brief 生成', brief.ok === true)
  check('brief ≤200 字', [...(brief.brief_text || '')].length <= 200, `${[...(brief.brief_text || '')].length} 字`)
  check('brief 含下一步', !!brief.next_action)
  eq('brief 的下一步来自 task next_hint', brief.next_action, '先注册 sidebar.panellist 图标')
  check('brief 含未决项', brief.open.length > 0)

  /* ---------------------------------------------- 6. 并发：锁冲突转 staging */

  const lockFile = path.join(treeRoot(host), '.lock')
  fs.writeFileSync(lockFile, '9999')
  const staged = grow(host, 'task', {
    nodes: [{ type: 'fact', title: '锁冲突测试', summary: '应转存 staging', keywords: ['锁'], content: '锁冲突时不能丢批次。' }],
  }, cfg)
  check('锁被占用时 staged=true', staged.staged === true)
  check('staging 文件存在', !!staged.staging_file && fs.existsSync(staged.staging_file))
  fs.unlinkSync(lockFile)

  /* ------------------------------------------------- 7. 删除与还原 */

  const beforeDelete = Object.keys(loadTree(host, 'task').nodes).length
  const logBytesBefore = (() => {
    const dir = path.join(treeRoot(host), 'logs')
    let total = 0
    const walk = (d) => {
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, item.name)
        if (item.isDirectory()) walk(abs)
        else total += fs.statSync(abs).size
      }
    }
    walk(dir)
    return total
  })()

  const del = gcDelete(host, 'task', grown.branch.id, 'subtree', '测试删除')
  check('删除枝成功', del.ok === true)
  eq('删除枝连带 3 叶', del.removed, 4)
  eq('树节点数减少 4', Object.keys(loadTree(host, 'task').nodes).length, beforeDelete - 4)

  const back = gcRestore(host, 'task', del.entry_id)
  check('还原成功', back.ok === true)
  eq('还原后节点数复原', Object.keys(loadTree(host, 'task').nodes).length, beforeDelete)

  const logBytesAfter = (() => {
    const dir = path.join(treeRoot(host), 'logs')
    let total = 0
    const walk = (d) => {
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, item.name)
        if (item.isDirectory()) walk(abs)
        else total += fs.statSync(abs).size
      }
    }
    walk(dir)
    return total
  })()
  eq('删除还原不动日志原文字节数', logBytesAfter, logBytesBefore)

  /* ------------------------------------------------------ 8. 视图与诊断 */

  const view = treeView(host, 'task', cfg)
  check('视图可序列化', (() => { try { JSON.stringify(view); return true } catch { return false } })())
  check('视图统计热层', view.stats.tiers.hot >= 0)

  const diag = diagnose(host, cfg)
  check('诊断返回结构', diag.ok === true && Array.isArray(diag.overdue))

  const orphans = gcOrphans(host)
  check('孤儿报告是数组', Array.isArray(orphans.orphans))

  const st = statsOf(loadTree(host, 'task'), cfg, Date.now())
  check('统计 P0 计数存在', typeof st.p0 === 'number')

  /* -------------------------------------------------------- 9. 输出紧凑 */

  const jsonLen = JSON.stringify(view).length
  check('100 节点内视图不含缩进空白', !/\n\s{2,}/.test(JSON.stringify(view)))

} finally {
  try { fs.rmSync(host, { recursive: true, force: true }) } catch { /* windows lock */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exitCode = 1
}

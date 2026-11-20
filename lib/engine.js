/**
 * dsh-memory-tree — engine.
 *
 * Deterministic code only: the model decides *what* is worth remembering and
 * *where* it hangs; this module does every calculation, index, lock and write.
 *
 * Two trees share one implementation. A task tree lives in the working
 * directory it belongs to; the habit tree lives in one host directory on the
 * whole machine. The only difference is the host path, which is why the dual
 * tree costs almost nothing over a single tree.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const VERSION = '1.0'
const DIRNAME = '.memory-tree'

/* ------------------------------------------------------------------ config */

export const DEFAULTS = {
  half_life_days: 45,
  hot_threshold: 0.7,
  warm_threshold: 0.4,
  hot_recent_days: 7,
  archive_days: 180,
  recycle_days: 30,
  max_batch: 8,
  related_max: 3,
  summary_leaf_max: 50,
  summary_branch_max: 80,
  summary_trunk_max: 30,
  retention_days: 0,
}

export const TYPES = [
  'goal', 'decision', 'constraint', 'task', 'issue',
  'fact', 'artifact', 'deadend', 'question', 'preference',
]

/** Types that are never archived or pruned, whatever their score. */
export const P0_TYPES = new Set(['constraint', 'decision', 'preference'])
/** Types whose open state alone earns P0 protection. */
export const P0_OPEN_TYPES = new Set(['issue'])

/* --------------------------------------------------------------- file i/o */

function readJson(file, fallback) {
  try {
    // utf-8-sig: tolerate a BOM written by another tool (PowerShell 5.1 does).
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
  fs.renameSync(tmp, file)
}

function writeTextAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/* -------------------------------------------------------------------- time */

const pad = (n) => String(n).padStart(2, '0')

export function nowIso(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

const monthDir = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

export function parseIso(value) {
  if (!value) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

function daysSince(iso, now) {
  const t = parseIso(iso)
  if (!t) return 1e6
  return Math.max(0, (now - t) / 86400000)
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0))

/* ------------------------------------------------------------------- paths */

/**
 * The storage layout this build reads and writes.
 *
 * Two layouts exist on disk and the plugin must not break a user who has not
 * migrated yet, so `DATA_ROOT` decides at call time:
 *
 *   legacy  <workspace>/.memory-tree/          what every earlier build used
 *   v2      <root>/<slug>/tree.json            the flat index
 *           <root>/<slug>/<YYYYMM>/<batch>/    one folder per memory batch
 *
 * `setDataRoot` is called once by the Host with the user's chosen root and the
 * absolute workspace path, so the 50+ call sites that pass `hostDir` keep working
 * unchanged: every path helper below translates a workspace path into whichever
 * layout is active.
 */
let DATA_ROOT = ''
let LAYOUT = 'legacy'

/**
 * Switch the engine to the v2 layout.
 *
 * Called once at startup with the resolved root. When `root` is empty the engine
 * stays on the legacy layout, which keeps an unmigrated install fully working.
 */
export function setDataRoot(root) {
  DATA_ROOT = String(root || '')
  LAYOUT = DATA_ROOT ? 'v2' : 'legacy'
}

export function dataLayout() {
  return { layout: LAYOUT, root: DATA_ROOT }
}

/** A filesystem-safe slug for a workspace path; must match lib/storage.js. */
function slugOf(dir) {
  const abs = path.resolve(String(dir || ''))
  const folded = abs.toLowerCase()
  const stem = path.basename(folded).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const digest = crypto.createHash('sha1').update(folded).digest('hex').slice(0, 8)
  return `${stem}-${digest}`
}

/**
 * Which layout a single tree actually uses.
 *
 * A user who upgrades and has not migrated yet must keep seeing their data, so
 * the choice is made per tree rather than globally:
 *
 *   new tree exists      -> v2      (migrated, or written since the upgrade)
 *   legacy tree exists   -> legacy  (not migrated yet; stay readable)
 *   neither exists       -> v2      (a fresh write goes to the new layout)
 *
 * That ordering is what makes the switch safe: nothing is hidden and nothing is
 * rewritten behind the user's back.
 */
function layoutFor(hostDir) {
  if (LAYOUT === 'legacy') return 'legacy'
  const abs = path.resolve(String(hostDir || ''))
  const legacyFile = path.join(abs, DIRNAME, 'tree.json')
  const isHabit = path.basename(abs) === 'memory-tree' && !fs.existsSync(path.join(abs, DIRNAME))
  const newFile = isHabit
    ? path.join(DATA_ROOT, 'habits', 'tree.json')
    : path.join(DATA_ROOT, slugOf(abs), 'tree.json')

  if (fs.existsSync(newFile)) return 'v2'
  if (fs.existsSync(legacyFile)) return 'legacy'
  return 'v2'
}

/** Where a workspace's tree data lives, honouring the per-tree decision above. */
export function treeRoot(hostDir) {
  if (layoutFor(hostDir) === 'legacy') return path.join(hostDir, DIRNAME)
  const abs = path.resolve(String(hostDir || ''))
  // The habit host is a synthetic directory (`$DSH_HOME/memory-tree`); give it a
  // fixed slot so it is shared by every workspace rather than slugged per caller.
  if (path.basename(abs) === 'memory-tree' && !fs.existsSync(path.join(abs, DIRNAME))) {
    return path.join(DATA_ROOT, 'habits')
  }
  return path.join(DATA_ROOT, slugOf(abs))
}

export function treeFile(hostDir) {
  return path.join(treeRoot(hostDir), 'tree.json')
}

/**
 * Where the markdown bodies of new memory writes go.
 *
 * Under v2 this has to be the batch folder the retention module scans, otherwise
 * a write would land outside every `YYYYMMDD-HHmm` directory and no expiry sweep
 * would ever see it. The batch name is fixed per calendar minute, so several
 * writes inside one minute share a batch and one write per minute starts a new
 * one — which is the granularity the user asked for.
 */
function logsDir(hostDir) {
  if (layoutFor(hostDir) === 'legacy') return path.join(treeRoot(hostDir), 'logs')
  const root = treeRoot(hostDir)
  // The habit tree is a single shared file with no expiry, so its logs stay flat.
  if (path.basename(root) === 'habits') return path.join(root, 'logs')
  return path.join(root, monthKeyOf(new Date()), batchKeyOf(new Date()), 'logs')
}

/** `<YYYYMM>`; kept local so the engine does not depend on lib/storage.js. */
function monthKeyOf(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** `<YYYYMMDD-HHmm>` — no colon, which Windows forbids in a path. */
function batchKeyOf(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function indexDir(hostDir) {
  return path.join(treeRoot(hostDir), 'index')
}

function stagingDir(hostDir) {
  return path.join(treeRoot(hostDir), 'staging')
}

function briefsDir(hostDir) {
  return path.join(treeRoot(hostDir), 'briefs')
}

/**
 * The habit tree is machine-wide, so it must not sit inside a working
 * directory. Callers pass the resolved host directory in.
 */
export function habitHostDir(dshHome) {
  return path.join(dshHome, 'memory-tree')
}

function registryFile(dshHome) {
  return path.join(habitHostDir(dshHome), 'registry.json')
}

/* -------------------------------------------------------------------- lock */

const LOCK_WAIT_MS = 1600
const LOCK_POLL_MS = 200

function sleepSync(ms) {
  // Deterministic, bounded wait: the caller gives up and stages instead.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
  }
}

function acquireLock(hostDir) {
  const dir = treeRoot(hostDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return () => { try { fs.unlinkSync(file) } catch { /* already gone */ } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // A crashed writer must not wedge the tree forever.
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs
        if (age > 30000) { fs.unlinkSync(file); continue }
      } catch { /* raced away */ }
      if (Date.now() >= deadline) return null
      sleepSync(LOCK_POLL_MS)
    }
  }
}

/* -------------------------------------------------------------------- tree */

export function emptyTree(type, title) {
  const d = new Date()
  return {
    version: VERSION,
    tree_type: type,
    tree_id: `mt_${stamp(d)}_${crypto.randomBytes(3).toString('hex')}`,
    updated_at: nowIso(d),
    nodes: {},
    edges: [],
    ...(type === 'habit' ? { root_title: title || '用户习惯' } : {}),
  }
}

export function loadConfig(hostDir) {
  return { ...DEFAULTS, ...readJson(path.join(treeRoot(hostDir), 'config.json'), {}) }
}

export function loadTree(hostDir, type = 'task') {
  const tree = readJson(treeFile(hostDir), null)
  if (!tree || typeof tree !== 'object' || !tree.nodes) return null
  if (!tree.tree_type) tree.tree_type = type
  return tree
}

function saveTree(hostDir, tree) {
  const file = treeFile(hostDir)
  const root = treeRoot(hostDir)
  fs.mkdirSync(root, { recursive: true })
  // Backup before overwrite: the first rung of the rebuild ladder.
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  } catch { /* backup is best-effort, never blocks the write */ }
  tree.updated_at = nowIso()
  writeJsonAtomic(file, tree)
}

/**
 * A tree shell holds no nodes. The trunk is created on demand by resolveTrunk,
 * so the first batch decides the real domain name instead of leaving an
 * orphaned placeholder trunk beside it.
 */
export function ensureTree(hostDir, type = 'task', title) {
  let tree = loadTree(hostDir, type)
  if (tree) return tree
  tree = emptyTree(type, title)
  saveTree(hostDir, tree)
  touchRegistry(hostDir, type)
  return tree
}

function newId(prefix, d = new Date()) {
  return `${prefix}_${stamp(d)}_${crypto.randomBytes(3).toString('hex')}`
}

/* ------------------------------------------------------------- node fields */

/** Deterministic rollup digest: code joins titles, the model never writes it. */
export function rollup(tree, cfg, now = Date.now(), limit = 80) {
  const children = new Map()
  for (const edge of tree.edges) {
    if (edge.rel !== 'part_of') continue
    if (!children.has(edge.to)) children.set(edge.to, [])
    children.get(edge.to).push(edge.from)
  }
  let changed = 0
  for (const node of Object.values(tree.nodes)) {
    if (node.layer === 'leaf') continue
    const ids = children.get(node.id) || []
    const items = ids
      .map((id) => tree.nodes[id])
      .filter((n) => n && n.state === 'active')
      .map((n) => ({ title: n.title, s: nodeScore(n, cfg, now) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
    const cap = node.layer === 'trunk' ? cfg.summary_trunk_max : limit
    const digest = items.length
      ? truncate(`${items.length}件事：${items.map((i) => i.title).join('；')}`, cap)
      : ''
    if (node.digest !== digest) { node.digest = digest; changed++ }
  }
  return changed
}

function truncate(text, max) {
  const s = String(text || '')
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/* ----------------------------------------------------------------- scoring */

/**
 * A pinned node never fades.
 *
 * The user asked that the habit tree not be diluted at all — it is a statement of
 * how they want work done, not a recollection that earns its keep by being
 * recalled. `pinned` is the flag that says so, and it must survive a restart,
 * which is why it lives on the node rather than in config.
 */
export function isPinned(node) {
  return node?.pinned === true
}

export function baseScoreOf(node, cfg, now) {
  // A pinned node keeps its full weight no matter how old it is.
  if (isPinned(node)) return clamp01(node.importance)
  const days = daysSince(node.last_access || node.created_at, now)
  return clamp01(node.importance) * Math.pow(0.5, days / cfg.half_life_days)
}

/**
 * The spec's tier test reads base_score only, so a leaf (importance .6) can
 * never reach the hot threshold even the moment it is used. Access has to be
 * part of the score, otherwise "used often" never keeps anything warm.
 */
export function nodeScore(node, cfg, now = Date.now()) {
  const base = baseScoreOf(node, cfg, now)
  const boost = 1 + Math.log(1 + Math.max(0, node.access_count || 0))
  return base * Math.min(3, boost)
}

export function tierOf(node, cfg, now) {
  if (node.state !== 'active') return 'archived'
  // A pinned node is never archived and never demoted: it does not fade at all.
  if (isPinned(node)) {
    const score = clamp01(node.importance)
    return score >= cfg.hot_threshold ? 'hot' : 'warm'
  }
  const days = daysSince(node.last_access || node.created_at, now)
  const protectedNode = isP0(node)
  if (!protectedNode && days >= cfg.archive_days) return 'archived'
  const score = nodeScore(node, cfg, now)
  if (score >= cfg.hot_threshold && days <= cfg.hot_recent_days) return 'hot'
  if (score >= cfg.warm_threshold) return 'warm'
  return 'cold'
}

export function isP0(node) {
  if (P0_TYPES.has(node.type)) return true
  if (P0_OPEN_TYPES.has(node.type)) return node.status === 'open' || node.status === 'blocked'
  return false
}

/**
 * Review scheduling — the half of a forgetting curve the spec leaves out.
 * Decay answers "how heavy is this now"; due_at answers "when should this be
 * looked at again", and it is what the diagnosis panel reports.
 */
export function intervalDays(node, cfg) {
  const stability = Math.min(4, 1 + Math.log(1 + Math.max(0, node.access_count || 0)))
  return cfg.half_life_days * (0.5 + 0.5 * clamp01(node.importance)) * stability
}

export function dueAt(node, cfg) {
  const t = parseIso(node.last_access || node.created_at)
  return nowIso(new Date(t + intervalDays(node, cfg) * 86400000))
}

export function decorate(node, cfg, now) {
  return {
    ...node,
    score: Number(nodeScore(node, cfg, now).toFixed(3)),
    base_score: Number(baseScoreOf(node, cfg, now).toFixed(3)),
    tier: tierOf(node, cfg, now),
    due_at: dueAt(node, cfg),
    overdue: !isP0(node) && parseIso(dueAt(node, cfg)) <= now,
  }
}

/* ------------------------------------------------------------------- index */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s,，、;；/|\-—_:：()（）[\]{}"'`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '')
}

export function buildIndex(tree) {
  const keywords = {}
  const tokens = {}
  for (const node of Object.values(tree.nodes)) {
    if (node.state !== 'active') continue
    for (const kw of node.keywords || []) {
      const key = norm(kw)
      if (!key) continue
      ;(keywords[key] ||= []).push(node.id)
    }
    for (const token of tokenize(`${node.title || ''} ${node.summary || ''} ${node.digest || ''}`)) {
      ;(tokens[token] ||= []).push(node.id)
    }
  }
  return { version: 1, built_at: nowIso(), keywords, tokens }
}

export function saveIndex(hostDir, tree) {
  try {
    writeJsonAtomic(path.join(indexDir(hostDir), 'keywords.json'), buildIndex(tree))
  } catch { /* index is a cache: a failure only costs speed, never truth */ }
}

function loadIndex(hostDir) {
  const index = readJson(path.join(indexDir(hostDir), 'keywords.json'), null)
  if (!index || !index.keywords) return null
  return index
}

/* --------------------------------------------------------------- hit trail */

/**
 * Every hit would otherwise be a locked tree write, which fights the rule that
 * readers never take the write lock. Hits append here instead and fold in on
 * the next real write.
 */
export function recordHits(hostDir, ids) {
  if (!ids.length) return
  try {
    const dir = indexDir(hostDir)
    fs.mkdirSync(dir, { recursive: true })
    const lines = ids.map((id) => `${nowIso()}\t${id}`).join('\n')
    fs.appendFileSync(path.join(dir, 'touch.log'), `${lines}\n`, 'utf8')
  } catch { /* a lost hit costs one weight tick, never correctness */ }
}

function foldHits(hostDir, tree) {
  const file = path.join(indexDir(hostDir), 'touch.log')
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return 0 }
  if (!raw) return 0
  const byId = new Map()
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const [time, id] = line.split('\t')
    if (!id || !tree.nodes[id]) continue
    const prev = byId.get(id)
    if (!prev || parseIso(time) > parseIso(prev)) byId.set(id, time)
  }
  let folded = 0
  for (const [id, time] of byId) {
    const node = tree.nodes[id]
    node.access_count = (node.access_count || 0) + 1
    if (parseIso(time) > parseIso(node.last_access)) node.last_access = time
    folded++
  }
  try { fs.unlinkSync(file) } catch { /* another writer folded first */ }
  return folded
}

/* ------------------------------------------------------------------ search */

export function search(tree, cfg, query, opts = {}) {
  const now = Date.now()
  const topn = Math.max(1, Math.min(20, opts.topn || 3))
  const tokens = tokenize(query)
  if (!tokens.length) return { hits: [], tokens }
  const index = opts.index
  const candidates = new Map()
  const addCandidate = (id) => { if (tree.nodes[id]?.state === 'active') candidates.set(id, true) }

  if (index) {
    for (const token of tokens) {
      const key = norm(token)
      for (const id of index.keywords[key] || []) addCandidate(id)
      for (const id of index.tokens[key] || []) addCandidate(id)
      for (const [kw, ids] of Object.entries(index.keywords)) {
        if (kw.includes(key) || key.includes(kw)) for (const id of ids) addCandidate(id)
      }
    }
  }
  // Any node may still match through a keyword the index has not seen yet.
  if (!candidates.size) for (const id of Object.keys(tree.nodes)) addCandidate(id)

  const hits = []
  for (const id of candidates.keys()) {
    const node = tree.nodes[id]
    if (!node || node.state !== 'active') continue
    let match = 0
    const haystack = norm(`${node.title || ''} ${node.summary || ''} ${node.digest || ''}`)
    for (const token of tokens) {
      const key = norm(token)
      const kwHit = (node.keywords || []).some((kw) => {
        const k = norm(kw)
        return k.includes(key) || key.includes(k)
      })
      if (kwHit) match += 2
      else if (haystack.includes(key)) match += 0.5
    }
    if (match <= 0) continue
    hits.push({ node, match, rank: match + nodeScore(node, cfg, now) })
  }
  hits.sort((a, b) => b.rank - a.rank)
  const top = hits.slice(0, topn)
  return { hits: top, tokens }
}

export function presentHit(tree, node, cfg, now) {
  const parents = (node.parents || [])
    .map((pid) => tree.nodes[pid])
    .filter(Boolean)
    .map((p) => ({ id: p.id, title: p.title, layer: p.layer, digest: p.digest || '' }))
  const decorated = decorate(node, cfg, now)
  return {
    id: node.id,
    layer: node.layer,
    type: node.type,
    title: node.title,
    summary: node.summary,
    keywords: node.keywords,
    tier: decorated.tier,
    score: decorated.score,
    pointer: node.pointer,
    parents,
  }
}

/* -------------------------------------------------------------------- grow */

export class GrowError extends Error {
  constructor(message) { super(message); this.name = 'GrowError' }
}

function requireText(value, field) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) throw new GrowError(`${field} 不能为空`)
  return s
}

export function validateBatch(batch, cfg) {
  const nodes = Array.isArray(batch?.nodes) ? batch.nodes : []
  if (!nodes.length) throw new GrowError('nodes 为空')
  if (nodes.length > cfg.max_batch) throw new GrowError(`单批最多 ${cfg.max_batch} 条，收到 ${nodes.length}`)
  return nodes.map((raw, i) => {
    const at = `nodes[${i}]`
    const type = requireText(raw.type, `${at}.type`)
    if (!TYPES.includes(type)) throw new GrowError(`${at}.type 非法：${type}`)
    const title = requireText(raw.title, `${at}.title`)
    if ([...title].length > 20) throw new GrowError(`${at}.title 超过 20 字`)
    const summary = requireText(raw.summary, `${at}.summary`)
    if ([...summary].length > 60) throw new GrowError(`${at}.summary 超过 60 字`)
    const content = requireText(raw.content, `${at}.content`)
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords.map((k) => String(k).trim()).filter(Boolean)
      : []
    if (!keywords.length) throw new GrowError(`${at}.keywords 为空`)
    if (keywords.length > 5) throw new GrowError(`${at}.keywords 超过 5 个`)
    const related = Array.isArray(raw.related_to) ? raw.related_to.filter(Boolean) : []
    if (related.length > cfg.related_max) throw new GrowError(`${at}.related_to 超过 ${cfg.related_max} 个`)
    const needsHint = type === 'task' || type === 'issue'
    const nextHint = raw.next_hint ? String(raw.next_hint).trim() : null
    if (needsHint && !nextHint) throw new GrowError(`${at}（${type}）必须给 next_hint：可执行的一步`)
    if (nextHint && /^(继续推进|继续|推进|加油|看情况)$/.test(nextHint)) {
      throw new GrowError(`${at}.next_hint 是空话，要写成可执行的一步`)
    }
    return {
      type, title, summary, content, keywords,
      importance: clamp01(raw.importance ?? defaultImportance(type)),
      status: raw.status || (needsHint ? 'open' : 'done'),
      next_hint: nextHint,
      update_of: raw.update_of || null,
      related_to: related,
    }
  })
}

function defaultImportance(type) {
  if (type === 'decision' || type === 'constraint' || type === 'preference') return 0.9
  if (type === 'issue' || type === 'goal') return 0.8
  if (type === 'deadend') return 0.7
  return 0.6
}

function appendLog(hostDir, batch, entries, d) {
  // v2 puts the body inside the batch folder so an expiry sweep can find it;
  // legacy keeps the old `<root>/logs/<YYYY-MM>/file.md` shape.
  const rel = layoutFor(hostDir) === 'legacy'
    ? path.join('logs', monthDir(d), `${stamp(d)}.md`)
    : path.join(monthKeyOf(d), batchKeyOf(d), 'logs', monthDir(d), `${stamp(d)}.md`)
  const abs = path.join(treeRoot(hostDir), rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  let text = `# 记忆日志 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}\n`
  const pointers = []
  for (const entry of entries) {
    text += `\n## ${entry.title}\n`
    const marker = `node:${entry.id} type:${entry.type} keywords:${entry.keywords.join(',')}`
    text += `<!-- ${marker} -->\n`
    const start = text.split('\n').length
    const body = String(entry.content).replace(/\r\n/g, '\n')
    text += `${body}\n`
    const end = start + body.split('\n').length - 1
    pointers.push(`${rel.split(path.sep).join('/')}#L${start}-L${end}`)
  }
  writeTextAtomic(abs, text)
  return pointers
}

function resolveTrunk(tree, name, type) {
  const trunks = Object.values(tree.nodes).filter((n) => n.layer === 'trunk')
  const wanted = name || (type === 'habit' ? '用户习惯' : null)
  const found = wanted ? trunks.find((n) => n.title === truncate(wanted, 20)) : null
  if (found) return found
  // An unnamed batch joins the strongest existing trunk; a named one creates its
  // own. Only an actually empty tree falls back to a default domain name.
  if (!wanted && trunks.length) {
    return trunks.sort((a, b) => (b.access_count || 0) - (a.access_count || 0))[0]
  }
  const d = new Date()
  const node = {
    id: newId('t', d), type: type === 'habit' ? 'preference' : 'goal', layer: 'trunk',
    title: truncate(wanted || (type === 'habit' ? '用户习惯' : '默认领域'), 20),
    summary: '', digest: '', parents: [], keywords: [],
    pointer: null, importance: 0.9, access_count: 0, last_access: nowIso(d),
    state: 'active', status: 'open', next_hint: null,
    created_at: nowIso(d), updated_at: nowIso(d),
  }
  tree.nodes[node.id] = node
  return node
}

function resolveBranch(tree, trunk, branchName, branchId) {
  if (branchId && tree.nodes[branchId]?.layer === 'branch') return tree.nodes[branchId]
  const branches = Object.values(tree.nodes).filter(
    (n) => n.layer === 'branch' && (n.parents || [])[0] === trunk.id,
  )
  if (branchName) {
    const found = branches.find((n) => n.title === branchName)
    if (found) return found
    const d = new Date()
    const node = {
      id: newId('b', d), type: 'task', layer: 'branch', title: truncate(branchName, 20),
      summary: '', digest: '', parents: [trunk.id], keywords: [], pointer: null,
      importance: 0.8, access_count: 0, last_access: nowIso(d), state: 'active',
      status: 'open', next_hint: null, created_at: nowIso(d), updated_at: nowIso(d),
    }
    tree.nodes[node.id] = node
    tree.edges.push({ from: node.id, to: trunk.id, rel: 'part_of', weight: 1.0 })
    return node
  }
  if (branches.length) return branches[0]
  return resolveBranch(tree, trunk, '当前任务', null)
}

/** Duplicate pressure: same type + same title, or keyword Jaccard >= 0.5. */
function suspectOf(tree, node) {
  for (const other of Object.values(tree.nodes)) {
    if (other.id === node.id || other.state !== 'active' || other.layer !== 'leaf') continue
    if (other.type !== node.type) continue
    if (norm(other.title) === norm(node.title)) return other.id
    const a = new Set((other.keywords || []).map(norm))
    const b = new Set((node.keywords || []).map(norm))
    if (!a.size || !b.size) continue
    let inter = 0
    for (const k of b) if (a.has(k)) inter++
    const union = a.size + b.size - inter
    if (union && inter / union >= 0.5) return other.id
  }
  return null
}

export function grow(hostDir, treeType, batch, cfg) {
  const entries = validateBatch(batch, cfg)
  const release = acquireLock(hostDir)
  const d = new Date()

  if (!release) {
    // Lock busy: keep the batch in staging rather than losing it.
    const sid = newId('s', d)
    const file = path.join(stagingDir(hostDir), `${sid}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeJsonAtomic(file, { batch, tree: treeType, created_at: nowIso(d) })
    return { ok: true, staged: true, staging_file: file, message: '写锁被占用，批次已暂存，稍后 merge' }
  }

  try {
    const tree = ensureTree(hostDir, treeType)
    foldHits(hostDir, tree)
    const trunk = resolveTrunk(tree, batch.trunk, treeType)
    const branch = resolveBranch(tree, trunk, batch.branch, batch.branch_id)

    const created = []
    for (const entry of entries) {
      const id = newId('n', d)
      const node = {
        id, type: entry.type, layer: 'leaf', title: entry.title,
        summary: entry.summary, digest: '', keywords: entry.keywords,
        parents: [branch.id], pointer: null, importance: entry.importance,
        access_count: 0, last_access: nowIso(d), state: 'active',
        status: entry.status, next_hint: entry.next_hint,
        created_at: nowIso(d), updated_at: nowIso(d),
        // A habit is a standing instruction, not a recollection: it must not fade.
        // Task-tree nodes keep decaying as before.
        ...(treeType === 'habit' ? { pinned: true } : {}),
      }
      tree.nodes[id] = node
      tree.edges.push({ from: id, to: branch.id, rel: 'part_of', weight: 1.0 })

      if (entry.update_of && tree.nodes[entry.update_of]) {
        tree.nodes[entry.update_of].state = 'superseded'
        tree.nodes[entry.update_of].updated_at = nowIso(d)
        tree.edges.push({ from: id, to: entry.update_of, rel: 'supersedes', weight: 1.0 })
      }
      for (const target of entry.related_to) {
        if (tree.nodes[target] && !node.parents.includes(target)) {
          node.parents.push(target)
          tree.edges.push({ from: id, to: target, rel: 'related', weight: 0.6 })
        }
      }
      const earlier = entry.update_of ? null : suspectOf(tree, node)
      if (earlier) node.suspected = earlier
      created.push({ node, entry })
    }

    const pointers = appendLog(hostDir, batch, created.map((c) => ({ ...c.node, content: c.entry.content })), d)
    created.forEach((c, i) => { c.node.pointer = pointers[i] })

    for (const node of Object.values(tree.nodes)) {
      if (node.layer === 'leaf') continue
      node.updated_at = nowIso(d)
    }
    rollup(tree, cfg, d.getTime())
    saveTree(hostDir, tree)
    saveIndex(hostDir, tree)
    touchRegistry(hostDir, treeType)

    return {
      ok: true,
      staged: false,
      tree: treeType,
      trunk: { id: trunk.id, title: trunk.title },
      branch: { id: branch.id, title: branch.title },
      created: created.map((c) => ({
        id: c.node.id, title: c.node.title, pointer: c.node.pointer,
        ...(c.node.suspected ? { suspected: c.node.suspected } : {}),
      })),
      message: `已记 ${created.length} 条到「${branch.title}」`,
    }
  } finally {
    release()
  }
}

/* ------------------------------------------------------------------ search */

export function runSearch(hostDir, treeType, query, cfg, topn) {
  const tree = loadTree(hostDir, treeType)
  if (!tree) return { ok: true, tree: treeType, mode: 'locate', hits: [] }
  const index = loadIndex(hostDir) || buildIndex(tree)
  const { hits } = search(tree, cfg, query, { topn, index })
  const now = Date.now()
  recordHits(hostDir, hits.slice(0, 5).map((h) => h.node.id))
  return {
    ok: true, tree: treeType, mode: 'locate',
    hits: hits.map((h) => ({ ...presentHit(tree, h.node, cfg, now), match: h.match })),
  }
}

/* ----------------------------------------------------------------- reading */

/** Read the original text behind a pointer, ±window lines (fact layer). */
export function readPointer(hostDir, pointer, window = 10) {
  if (!pointer) return null
  const [rel, anchor] = String(pointer).split('#')
  const abs = path.join(treeRoot(hostDir), rel)
  let text
  try { text = fs.readFileSync(abs, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/)
  let start = 1
  let end = lines.length
  const m = /^L(\d+)(?:-L(\d+))?$/.exec(anchor || '')
  if (m) { start = Number(m[1]); end = Number(m[2] || m[1]) }
  const from = Math.max(1, start - window)
  const to = Math.min(lines.length, end + window)
  return {
    pointer,
    segment: lines.slice(from - 1, to).join('\n'),
    from, to,
    before: from > 1,
    after: to < lines.length,
    total: lines.length,
  }
}

/* ------------------------------------------------------------------- brief */

export function buildBrief(hostDir, cfg, dshHome) {
  const tree = loadTree(hostDir, 'task')
  if (!tree) return { ok: false, error: 'empty_tree', message: '任务树还没有内容' }
  const now = Date.now()
  const active = Object.values(tree.nodes).filter((n) => n.state === 'active')
  const trunks = active.filter((n) => n.layer === 'trunk')
    .sort((a, b) => nodeScore(b, cfg, now) - nodeScore(a, cfg, now))
  const goal = trunks[0] || null

  const decided = active.filter((n) => n.type === 'decision')
    .sort((a, b) => nodeScore(b, cfg, now) - nodeScore(a, cfg, now)).slice(0, 3)
  const open = active.filter(
    (n) => (n.type === 'task' || n.type === 'issue') &&
      (n.status === 'open' || n.status === 'blocked'),
  ).sort((a, b) => nodeScore(b, cfg, now) - nodeScore(a, cfg, now))

  const conflicts = tree.edges.filter((e) => e.rel === 'contradicts')
    .map((e) => ({ from: tree.nodes[e.from]?.title, to: tree.nodes[e.to]?.title }))
    .filter((c) => c.from && c.to)

  const nextNode = open.find((n) => n.next_hint) || null
  const nextAction = nextNode?.next_hint || null

  // Which task tree is this? The brief has to say where it came from.
  const prev = latestBrief(hostDir)
  const prevCheck = prev?.next_action
    ? {
        previous_next_action: prev.next_action,
        previous_node: prev.next_node_id,
        completed: prev.next_node_id
          ? tree.nodes[prev.next_node_id]?.status === 'done'
          : undefined,
      }
    : null

  const lines = []
  lines.push(`【目标】${goal ? truncate(goal.title, 30) : '（未定）'}`)
  if (goal?.digest) lines.push(`【领域】${truncate(goal.digest, 60)}`)
  if (decided.length) lines.push(`【已定】${decided.map((n) => truncate(n.title, 18)).join('；')}`)
  if (open.length) lines.push(`【未决】${open.slice(0, 3).map((n) => truncate(n.title, 18)).join('；')}`)
  if (nextAction) lines.push(`【下一步】${truncate(nextAction, 40)}`)
  if (conflicts.length) lines.push(`【冲突待裁决】${conflicts.map((c) => `${c.from}≠${c.to}`).join('；')}`)
  if (prevCheck) {
    lines.push(`【上次】${truncate(prevCheck.previous_next_action, 30)}` +
      (prevCheck.completed === true ? '（已完成）' : prevCheck.completed === false ? '（未完成）' : ''))
  }

  let briefText = lines.join('\n')
  if ([...briefText].length > 200) briefText = `${[...briefText].slice(0, 198).join('')}…`

  const result = {
    ok: true,
    brief_text: briefText,
    next_action: nextAction,
    goal: goal ? { id: goal.id, title: goal.title, digest: goal.digest } : null,
    decided: decided.map((n) => ({ id: n.id, title: n.title, summary: n.summary })),
    open: open.slice(0, 5).map((n) => ({
      id: n.id, type: n.type, title: n.title, status: n.status, next_hint: n.next_hint,
    })),
    conflicts,
    ...(prevCheck ? { previous: prevCheck } : {}),
  }
  if (!nextAction) {
    result.error = 'next_action_missing'
    result.hint = '树里没有可执行的下一步：补一条带 next_hint 的 task/issue'
  }
  saveBrief(hostDir, result, nextNode?.id || null)
  return result
}

function saveBrief(hostDir, result, nextNodeId) {
  const d = new Date()
  const file = path.join(briefsDir(hostDir), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`)
  const history = readJson(file, { entries: [] })
  history.entries.push({
    at: nowIso(d),
    brief_text: result.brief_text,
    next_action: result.next_action,
    next_node_id: nextNodeId,
    goal: result.goal?.title || null,
  })
  if (history.entries.length > 50) history.entries = history.entries.slice(-50)
  writeJsonAtomic(file, history)
}

export function latestBrief(hostDir) {
  const dir = briefsDir(hostDir)
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() } catch { return null }
  if (!files.length) return null
  const history = readJson(path.join(dir, files[files.length - 1]), { entries: [] })
  return history.entries?.[history.entries.length - 1] || null
}

/* --------------------------------------------------------------- gc / merge */

function loadRecycle(hostDir) {
  return readJson(path.join(treeRoot(hostDir), 'recycle.json'), { entries: [] })
}

function saveRecycle(hostDir, recycle) {
  writeJsonAtomic(path.join(treeRoot(hostDir), 'recycle.json'), recycle)
}

function descendants(tree, rootId) {
  const children = new Map()
  for (const edge of tree.edges) {
    if (edge.rel !== 'part_of') continue
    if (!children.has(edge.to)) children.set(edge.to, [])
    children.get(edge.to).push(edge.from)
  }
  const out = []
  const stack = [...(children.get(rootId) || [])]
  while (stack.length) {
    const id = stack.pop()
    if (out.includes(id)) continue
    out.push(id)
    stack.push(...(children.get(id) || []))
  }
  return out
}

export function gcDelete(hostDir, treeType, id, mode, note) {
  const release = acquireLock(hostDir)
  if (!release) return { ok: false, error: 'lock_busy' }
  try {
    const tree = loadTree(hostDir, treeType)
    if (!tree?.nodes[id]) return { ok: false, error: 'not_found' }
    const subtree = mode === 'subtree' ? descendants(tree, id) : []
    const ids = [id, ...subtree]
    const node = tree.nodes[id]
    const recycle = loadRecycle(hostDir)
    const entryId = newId('r')
    recycle.entries.push({
      entry_id: entryId,
      root_id: id,
      mode: mode === 'subtree' ? 'subtree' : 'self',
      note: note || '',
      deleted_at: nowIso(),
      children_count: subtree.length,
      title: node.title,
      nodes: Object.fromEntries(ids.map((k) => [k, tree.nodes[k]])),
      edges: tree.edges.filter((e) => ids.includes(e.from) || ids.includes(e.to)),
      parent_of_root: (node.parents || [])[0] || null,
    })
    for (const k of ids) delete tree.nodes[k]
    tree.edges = tree.edges.filter((e) => !ids.includes(e.from) && !ids.includes(e.to))

    if (mode !== 'subtree') {
      // Self mode: children move up to the deleted node's own parent.
      const grandparent = (node.parents || [])[0]
      if (grandparent) {
        for (const child of descendants_in(tree, id)) {
          if (!tree.nodes[child]) continue
          tree.nodes[child].parents = [grandparent]
          tree.edges.push({ from: child, to: grandparent, rel: 'part_of', weight: 1.0 })
        }
      }
    }
    rollup(tree, loadConfig(hostDir))
    saveTree(hostDir, tree)
    saveRecycle(hostDir, recycle)
    saveIndex(hostDir, tree)
    return { ok: true, entry_id: entryId, removed: ids.length }
  } finally {
    release()
  }
}

function descendants_in(tree, rootId) {
  return tree.edges.filter((e) => e.rel === 'part_of' && e.to === rootId).map((e) => e.from)
}

export function gcRestore(hostDir, treeType, entryId) {
  const release = acquireLock(hostDir)
  if (!release) return { ok: false, error: 'lock_busy' }
  try {
    const tree = ensureTree(hostDir, treeType)
    const recycle = loadRecycle(hostDir)
    const idx = recycle.entries.findIndex((e) => e.entry_id === entryId)
    if (idx < 0) return { ok: false, error: 'not_found' }
    const entry = recycle.entries[idx]
    for (const [id, node] of Object.entries(entry.nodes)) tree.nodes[id] = node

    const known = new Set(Object.keys(tree.nodes))
    const fallback = Object.values(tree.nodes).find((n) => n.layer === 'trunk')?.id
    const repaired = []
    for (const edge of entry.edges) {
      if (!known.has(edge.from) || !known.has(edge.to)) continue
      tree.edges.push(edge)
    }
    // A missing parent must not orphan the restored subtree.
    const root = tree.nodes[entry.root_id]
    if (root && (!root.parents?.length || !root.parents.some((p) => tree.nodes[p]))) {
      if (fallback) {
        root.parents = [fallback]
        tree.edges.push({ from: root.id, to: fallback, rel: 'part_of', weight: 1.0 })
        repaired.push(root.id)
      }
    }
    recycle.entries.splice(idx, 1)
    rollup(tree, loadConfig(hostDir))
    saveTree(hostDir, tree)
    saveRecycle(hostDir, recycle)
    saveIndex(hostDir, tree)
    return { ok: true, restored: Object.keys(entry.nodes).length, repaired }
  } finally {
    release()
  }
}

export function gcPurge(hostDir, cfg) {
  const recycle = loadRecycle(hostDir)
  const now = Date.now()
  const keep = []
  let purged = 0
  for (const entry of recycle.entries) {
    if ((now - parseIso(entry.deleted_at)) / 86400000 >= cfg.recycle_days) purged++
    else keep.push(entry)
  }
  saveRecycle(hostDir, { entries: keep })
  return { ok: true, purged, kept: keep.length }
}

export function gcOrphans(hostDir) {
  const tree = loadTree(hostDir, 'task')
  const referenced = new Set()
  if (tree) for (const node of Object.values(tree.nodes)) if (node.pointer) referenced.add(node.pointer)
  for (const entry of loadRecycle(hostDir).entries) {
    for (const node of Object.values(entry.nodes)) if (node.pointer) referenced.add(node.pointer)
  }
  const root = logsDir(hostDir)
  const orphans = []
  const walk = (dir) => {
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) { walk(abs); continue }
      if (!item.name.endsWith('.md')) continue
      const rel = path.relative(treeRoot(hostDir), abs).split(path.sep).join('/')
      if (![...referenced].some((p) => p.startsWith(`${rel}#`))) orphans.push(rel)
    }
  }
  walk(root)
  return { ok: true, orphans, count: orphans.length, note: '只报告，不删' }
}

export function gcRebuild(hostDir, treeType) {
  const bak = readJson(`${treeFile(hostDir)}.bak`, null)
  if (bak?.nodes) {
    saveTree(hostDir, bak)
    return { ok: true, source: 'tree.json.bak', nodes: Object.keys(bak.nodes).length }
  }
  // Second rung: rebuild the skeleton from the comment markers in the logs.
  const tree = emptyTree(treeType)
  const root = logsDir(hostDir)
  const files = []
  const walk = (dir) => {
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) walk(abs)
      else if (item.name.endsWith('.md')) files.push(abs)
    }
  }
  walk(root)
  let restored = 0
  for (const abs of files.sort()) {
    const rel = path.relative(treeRoot(hostDir), abs).split(path.sep).join('/')
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = /^<!--\s*node:(\S+)\s+type:(\S+)\s+keywords:(.*?)\s*-->$/.exec(lines[i])
      if (!m) continue
      const titleLine = lines[i - 1] || ''
      const title = titleLine.replace(/^##\s*/, '').slice(0, 20) || '（重建）'
      let end = i + 1
      while (end < lines.length && !/^##\s/.test(lines[end]) && lines[end] !== '') end++
      tree.nodes[m[1]] = {
        id: m[1], type: m[2], layer: 'leaf', title, summary: '（重建）摘要丢失',
        digest: '', keywords: m[3] ? m[3].split(',') : [], parents: [],
        pointer: `${rel}#L${i + 2}-L${Math.max(i + 2, end)}`,
        importance: defaultImportance(m[2]), access_count: 0, last_access: nowIso(),
        state: 'active', status: 'done', next_hint: null,
        created_at: nowIso(), updated_at: nowIso(), rebuilt: true,
      }
      restored++
    }
  }
  saveTree(hostDir, tree)
  return { ok: restored > 0, source: 'logs', nodes: restored, warning: '摘要与权重已丢失，需人工复核' }
}

/* ------------------------------------------------------------------ merge */

export function mergeStaging(hostDir, treeType, cfg) {
  const dir = stagingDir(hostDir)
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() } catch { return { ok: true, merged: 0, results: [] } }
  const results = []
  let merged = 0
  for (const file of files) {
    const payload = readJson(path.join(dir, file), null)
    if (!payload?.batch) { try { fs.unlinkSync(path.join(dir, file)) } catch { /* ignore */ } continue }
    try {
      const out = grow(hostDir, payload.tree || treeType, payload.batch, cfg)
      if (out.staged) continue
      merged++
      results.push({ file, created: out.created?.length || 0 })
      fs.unlinkSync(path.join(dir, file))
    } catch (error) {
      results.push({ file, error: String(error.message || error) })
    }
  }
  return { ok: true, merged, results }
}

/* ------------------------------------------------------------------ stats */

export function statsOf(tree, cfg, now = Date.now()) {
  const tiers = { hot: 0, warm: 0, cold: 0, archived: 0 }
  const byType = {}
  const due = []
  let p0 = 0
  if (tree) {
    for (const node of Object.values(tree.nodes)) {
      const tier = tierOf(node, cfg, now)
      tiers[tier] = (tiers[tier] || 0) + 1
      byType[node.type] = (byType[node.type] || 0) + 1
      if (isP0(node) && node.state === 'active') p0++
      if (node.state === 'active' && !isP0(node) && parseIso(dueAt(node, cfg)) <= now) {
        due.push({ id: node.id, title: node.title, type: node.type, due_at: dueAt(node, cfg) })
      }
    }
  }
  return {
    nodes: tree ? Object.keys(tree.nodes).length : 0,
    edges: tree ? tree.edges.length : 0,
    tiers, byType, p0, due: due.slice(0, 50), due_count: due.length,
  }
}

/** Overdue, suspected duplicates and drifting P0 — the "diagnosis" view. */
export function diagnose(hostDir, cfg) {
  const tree = loadTree(hostDir, 'task')
  const now = Date.now()
  if (!tree) return { ok: true, tree: 'task', empty: true }
  const active = Object.values(tree.nodes).filter((n) => n.state === 'active')
  const overdue = active.filter((n) => !isP0(n) && parseIso(dueAt(n, cfg)) <= now)
    .sort((a, b) => parseIso(dueAt(a, cfg)) - parseIso(dueAt(b, cfg)))
    .slice(0, 10)
    .map((n) => ({ id: n.id, title: n.title, type: n.type, due_at: dueAt(n, cfg), tier: tierOf(n, cfg, now) }))
  const suspected = active.filter((n) => n.suspected).map((n) => ({ id: n.id, title: n.title, like: n.suspected }))
  const drifting = active.filter((n) => {
    if (!isP0(n)) return false
    const days = daysSince(n.last_access || n.created_at, now)
    return daysSince(n.created_at, now) > 7 && tierOf(n, cfg, now) !== 'hot'
  }).map((n) => ({ id: n.id, title: n.title, type: n.type, tier: tierOf(n, cfg, now) }))
  const stuck = active.filter(
    (n) => (n.type === 'task' || n.type === 'issue') && n.status === 'blocked',
  ).map((n) => ({ id: n.id, title: n.title, next_hint: n.next_hint }))
  return {
    ok: true,
    tree: 'task',
    overdue,
    overdue_count: overdue.length,
    suspected,
    drifting,
    stuck,
    summary: statsOf(tree, cfg, now),
  }
}

/* ------------------------------------------------------------- tree export */

export function treeView(hostDir, treeType, cfg) {
  const tree = loadTree(hostDir, treeType)
  const now = Date.now()
  if (!tree) {
    // A workspace that has never been written still has to answer with the same
    // shape: the panel reads `groups` unconditionally, and an absent key crashed
    // the first render for every fresh install.
    return {
      exists: false, tree_type: treeType, dir: hostDir,
      nodes: {}, edges: [], groups: {}, recycle: [], stats: null,
    }
  }
  const nodes = {}
  for (const [id, node] of Object.entries(tree.nodes)) nodes[id] = decorate(node, cfg, now)
  return {
    exists: true,
    tree_id: tree.tree_id,
    tree_type: tree.tree_type || treeType,
    dir: hostDir,
    updated_at: tree.updated_at,
    nodes,
    edges: tree.edges,
    // Absent on every tree written before grouping existed; the panel treats a
    // missing map as "nothing is grouped" and draws children directly.
    groups: tree.groups || {},
    recycle: loadRecycle(hostDir).entries.map((e) => ({
      entry_id: e.entry_id, root_id: e.root_id, title: e.title,
      mode: e.mode, note: e.note, deleted_at: e.deleted_at,
      children_count: e.children_count,
    })),
    stats: statsOf(tree, cfg, now),
    brief: latestBrief(hostDir),
  }
}

export function editNode(hostDir, treeType, id, patch) {
  const release = acquireLock(hostDir)
  if (!release) return { ok: false, error: 'lock_busy' }
  try {
    const tree = loadTree(hostDir, treeType)
    const node = tree?.nodes[id]
    if (!node) return { ok: false, error: 'not_found' }
    if (patch.title) node.title = truncate(String(patch.title), 20)
    if (patch.summary) node.summary = truncate(String(patch.summary), 60)
    if (Array.isArray(patch.keywords)) node.keywords = patch.keywords.slice(0, 5)
    if (patch.status) node.status = String(patch.status)
    if (typeof patch.importance === 'number') node.importance = clamp01(patch.importance)
    node.updated_at = nowIso()
    rollup(tree, loadConfig(hostDir))
    saveTree(hostDir, tree)
    saveIndex(hostDir, tree)
    return { ok: true, node }
  } finally {
    release()
  }
}

/**
 * Replace one workspace's tree with an imported one.
 *
 * The registry write is part of the import, not an afterthought: the panel lists
 * workspaces from the registry, so a tree written without registering it existed
 * on disk but was invisible in the UI. That is exactly the "built a tree and
 * nothing appeared" report.
 */
export function importTree(hostDir, treeType, incoming, dshHome) {
  if (!incoming || typeof incoming !== 'object' || !incoming.nodes || typeof incoming.nodes !== 'object') {
    return { ok: false, error: 'invalid_tree' }
  }
  const file = treeFile(hostDir)
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.imported.bak`) } catch { /* best effort */ }
  }
  const tree = { ...emptyTree(treeType), ...incoming, version: VERSION }
  saveTree(hostDir, tree)
  saveIndex(hostDir, tree)
  touchRegistry(hostDir, treeType, dshHome)
  return { ok: true, nodes: Object.keys(tree.nodes).length }
}

export function exportTree(hostDir, treeType) {
  return loadTree(hostDir, treeType) || emptyTree(treeType)
}

/* --------------------------------------------------------------- registry */

/**
 * Which task trees exist on this machine, so the panel can list them.
 *
 * `dshHome` is passed explicitly by callers that already know it. Falling back to
 * `process.env.DSH_HOME` alone was fragile: a tool call or an HTTP route that ran
 * before the env var was visible would silently skip registration, and the tree
 * then existed on disk but never appeared in the panel.
 */
export function touchRegistry(hostDir, treeType, dshHome) {
  if (treeType !== 'task') return
  const home = dshHome || process.env.DSH_HOME || ''
  if (!home) return
  try {
    const file = registryFile(home)
    const registry = readJson(file, { trees: [] })
    const found = registry.trees.find((t) => t.dir === hostDir)
    if (found) {
      found.updated_at = nowIso()
      // A tree that is being written again is live, not deleted.
      delete found.deleted_at
    } else {
      registry.trees.push({ dir: hostDir, title: path.basename(hostDir), updated_at: nowIso() })
    }
    registry.trees.sort((a, b) => parseIso(b.updated_at) - parseIso(a.updated_at))
    registry.trees = registry.trees.slice(0, 100)
    writeJsonAtomic(file, registry)
  } catch { /* the registry is a convenience, never a requirement */ }
}

/**
 * Workspaces the panel may show.
 *
 * A workspace whose tree was deleted on purpose keeps an empty shell: the entry
 * stays in the registry with `deleted_at` set, and it must stay listed so the
 * user can restore it from the recycle bin. Only an entry that has neither a tree
 * file nor a deletion mark is stale — that means the directory was moved away
 * behind the plugin's back, and listing it would fail the view.
 *
 * `includeDeleted: false` is for callers that need a live tree (scanning for
 * import), where an empty shell is not a candidate.
 */
export function listTaskTrees(dshHome, { includeDeleted = true } = {}) {
  const registry = readJson(registryFile(dshHome), { trees: [] })
  return (registry.trees || []).filter((t) => {
    if (t.deleted_at) return includeDeleted
    try { return fs.existsSync(treeFile(t.dir)) } catch { return false }
  })
}

/**
 * Persist a group map onto a tree that is already on disk.
 *
 * Grouping happens after a write, from a view that was read a moment earlier.
 * Rather than round-tripping through `grow`, this re-reads the file, swaps in
 * only the `groups` field, and writes it back atomically with the same `.bak`
 * safety net — so a grouping pass can never resurrect a stale node.
 */
export function saveGroups(hostDir, treeType, groups) {
  const tree = loadTree(hostDir, treeType)
  if (!tree) return { ok: false, error: 'no_tree' }
  tree.groups = groups || {}
  saveTree(hostDir, tree)
  return { ok: true, groups: Object.keys(tree.groups).length }
}

export function readTreeFor(dir, cfg) {
  return treeView(dir, 'task', cfg)
}

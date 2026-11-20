/**
 * dsh-memory-tree — Log-to-tree import pipeline.
 *
 * Two ways to turn archived conversations into tree nodes:
 *
 *   rules  — offline, instant, free; promotes lines that already read like a
 *            rule. Coarse but predictable.
 *   ai     — asks the session's own model to summarise. Better prose, costs
 *            tokens, needs the network, and is chunked so a huge log cannot
 *            blow the context window.
 *
 * Both produce the same node shape, so the caller does not care which ran.
 */

import path from 'node:path'

import { treeFile, emptyTree, nowIso, treeRoot } from './engine.js'
import { extractByRules, tidy, keywordsOf } from './session-log.js'
import { completeText } from './llm-text.js'

/** Messages fed to the model per request. More than this truncates detail. */
const CHUNK_SIZE = 40
/** Hard ceiling per workspace, so one enormous log cannot run away. */
const MAX_CHUNKS = 8
/** Characters of one message the model is allowed to see. */
const MAX_MESSAGE_CHARS = 700

const VALID_TYPES = new Set([
  'goal', 'decision', 'constraint', 'task', 'issue',
  'fact', 'artifact', 'deadend', 'question', 'preference',
])

/* ------------------------------------------------------------- transcript */

/**
 * Flatten messages into a numbered transcript for the model.
 *
 * Long messages are clipped rather than dropped: a decision usually leads with
 * its conclusion, so the head carries most of the signal.
 */
function buildTranscript(messages) {
  const lines = []
  messages.forEach((message, index) => {
    const role = message.role === 'user' ? '用户' : '助手'
    const text = String(message.text || '').replace(/\s+/g, ' ').trim()
    if (!text) return
    const clipped = text.length <= MAX_MESSAGE_CHARS
      ? text
      : `${text.slice(0, MAX_MESSAGE_CHARS)}…`
    lines.push(`[${index}] ${role}: ${clipped}`)
  })
  return lines.join('\n')
}

/** Split a transcript into chunks that each fit one request. */
export function chunkMessages(messages) {
  const usable = messages.filter((message) => String(message.text || '').trim())
  const chunks = []
  for (let i = 0; i < usable.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
    chunks.push(usable.slice(i, i + CHUNK_SIZE))
  }
  // Anything past the ceiling is folded into the rule pass by the caller.
  const covered = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  return { chunks, covered, total: usable.length }
}

/* ------------------------------------------------------------------ prompts */

const SYSTEM_TASK = [
  '你是记忆树的提炼器。给你一段开发者与 AI 的对话记录，请提炼出值得长期记住的节点。',
  '只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。',
  '每个节点字段：',
  '- type: goal|decision|constraint|task|issue|fact|artifact|deadend|question 之一',
  '- title: 不超过 20 字的短标题，不要标点开头，不要 Markdown 符号',
  '- summary: 一句话说明，不超过 160 字',
  '- keywords: 1-5 个检索关键词的字符串数组',
  '- importance: 0 到 1 的小数，越关键越高',
  '- status: open 或 done（未完成的事情用 open）',
  '规则：',
  '- 只提炼对话中真实出现的内容，绝不编造。',
  '- 优先：拍板的决策、明确的约束、走不通的死路、未完成的事项。',
  '- 忽略：寒暄、工具调用的过程细节、重复的中间步骤。',
  '- 最多 12 个节点，宁少勿滥。',
].join('\n')

const SYSTEM_HABIT = [
  '你从开发者与 AI 的对话里提炼「这位用户的长期协作偏好」。',
  '只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。',
  '每个节点字段：',
  '- type: preference 或 constraint',
  '- title: 不超过 20 字',
  '- summary: 一句话说明这个偏好',
  '- keywords: 1-5 个关键词',
  '- importance: 0 到 1',
  '- status: done',
  '规则：',
  '- 只要跨任务长期成立的偏好：工作方式、沟通习惯、技术选型倾向、明确的禁止项。',
  '- 不要把某个具体项目的技术细节当成偏好。',
  '- 一句话都没有的偏好就不要输出；宁缺毋滥，最多 6 个。',
].join('\n')

/* ------------------------------------------------------------------- model */

/**
 * Ask the model for one chunk of nodes.
 *
 * Returns `[]` rather than throwing: a single failed chunk must not discard the
 * work already done, and the caller falls back to rules for what was missed.
 */
async function askModel(llm, provider, model, system, transcript, signal) {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: `对话记录：\n\n${transcript}` }],
  }]

  let text = ''
  try {
    const prepared = await llm.prepareCall({ provider, model })
    for await (const chunk of prepared.stream({ provider, model, messages, system, signal })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
  } catch (error) {
    return { nodes: [], error: String(error?.message || error) }
  }

  const nodes = parseNodeArray(text)
  return { nodes, error: nodes.length ? null : 'unparsable_response' }
}

/**
 * Pull a JSON node array out of a model reply.
 *
 * Models wrap JSON in prose or fences even when told not to, so the array is
 * located by bracket, then each member is validated individually — one bad node
 * must not discard its siblings.
 */
export function parseNodeArray(text) {
  const raw = String(text || '').trim()
  if (!raw) return []

  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []

  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    // Trailing commas are the usual syntax failure; repair once, then give up.
    const repaired = raw.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1')
    try { parsed = JSON.parse(repaired) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []

  const out = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const type = VALID_TYPES.has(item.type) ? item.type : 'fact'
    const title = tidy(item.title, 20)
    if (!title || title.replace(/[…\s]/g, '').length < 3) continue
    const summary = String(item.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!summary) continue

    const importance = Number(item.importance)
    out.push({
      type,
      title,
      summary,
      keywords: Array.isArray(item.keywords)
        ? item.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 5)
        : keywordsOf(summary),
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0.1, importance)) : 0.7,
      status: item.status === 'open' ? 'open' : 'done',
      next_hint: item.status === 'open' ? summary.slice(0, 60) : null,
    })
  }
  return out
}

/* --------------------------------------------------------------- assembling */

/** Normalise one candidate node, from either source, into the engine's shape. */
function normalise(candidate, scope) {
  const type = VALID_TYPES.has(candidate.type) ? candidate.type : 'fact'
  const title = tidy(candidate.title, 20)
  if (!title) return null
  const summary = String(candidate.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!summary) return null
  const importance = Number(candidate.importance)
  return {
    type: scope === 'habit' ? (type === 'constraint' ? 'constraint' : 'preference') : type,
    title,
    summary,
    keywords: Array.isArray(candidate.keywords) && candidate.keywords.length
      ? candidate.keywords.slice(0, 5)
      : keywordsOf(summary),
    importance: Number.isFinite(importance) ? Math.min(1, Math.max(0.1, importance)) : 0.7,
    status: candidate.status === 'open' ? 'open' : 'done',
    next_hint: candidate.next_hint || null,
  }
}

/** Drop duplicates by title, keeping the highest importance. */
function dedupe(nodes) {
  const byTitle = new Map()
  for (const node of nodes) {
    const key = node.title.replace(/[…\s]/g, '')
    const existing = byTitle.get(key)
    if (!existing || node.importance > existing.importance) byTitle.set(key, node)
  }
  return [...byTitle.values()]
}

/**
 * Build a complete tree document from messages.
 *
 * `mode` is `rules` (offline) or `ai` (model). In `ai` mode the rule pass still
 * runs first and its results are merged in, so chunks past MAX_CHUNKS and any
 * failed request still contribute nodes rather than silently vanishing.
 */
/**
 * Rewrite weak titles in one model call.
 *
 * The rule pass builds titles by truncating a clause, so a tree imported offline
 * ends up with labels like "现在能不能删" or "这几处都没有" — half a sentence that
 * cannot be scanned. This sends the whole list at once and asks only for better
 * labels, keeping summaries untouched.
 *
 * Returns a `Map<oldTitle, newTitle>` or `null`. A failure is silent: bad titles
 * are a quality problem, not an error worth failing an import over.
 */
async function rewriteTitles(llm, provider, model, nodes, signal) {
  // Only nodes whose title looks truncated or vague are worth the tokens.
  const weak = nodes.filter((n) => {
    const t = String(n.title || '')
    if (t.length < 6) return true
    if (t.endsWith('…')) return true
    // A title that is mostly a question is usually a heading, not a claim.
    return /[？?]$/.test(t) || /^(现在|要不要|能不能|是否|这里|这几处|下面)/.test(t)
  })
  if (!weak.length) return null

  const list = weak
    .slice(0, 40)
    .map((n, i) => `${i + 1}. [${n.type}] ${n.title} — ${String(n.summary || '').replace(/\s+/g, ' ').slice(0, 50)}`)
    .join('\n')

  const prompt = [
    '下面是一批记忆节点的现有标题和摘要。现有标题是从正文截断的碎片，不可读。',
    '请为每一条重新起一个标题：不超过 12 个汉字，说清这条在讲什么，',
    '不要用 Markdown 符号，不要以「现在/要不要/能不能」开头，不要是问句。',
    '',
    list,
    '',
    '只输出 JSON，不要解释：',
    '{"titles":[{"i":1,"title":"新标题"}]}',
  ].join('\n')

  try {
    const text = await completeText(llm, {
      provider, model,
      system: '你负责把记忆节点的碎片标题改写成可读的短标签。只输出 JSON。',
      prompt,
      maxTokens: 900,
      signal,
    })
    if (!text) return null

    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(text.slice(start, end + 1))
    const list2 = Array.isArray(parsed?.titles) ? parsed.titles : null
    if (!list2) return null

    const out = new Map()
    for (const item of list2) {
      const idx = Number(item?.i)
      const title = tidy(String(item?.title || ''), 20)
      if (!Number.isInteger(idx) || idx < 1 || idx > weak.length) continue
      if (!title || title.length < 2) continue
      out.set(weak[idx - 1].title, title)
    }
    return out.size ? out : null
  } catch {
    return null
  }
}

export async function buildTreeFromMessages({
  messages, scope, mode, llm, provider, model, title, signal, onProgress,
}) {
  const ruleNodes = extractByRules(messages, scope)
    .map((node) => normalise(node, scope))
    .filter(Boolean)

  let aiNodes = []
  let chunks = 0
  let failed = 0
  let error = null

  if (mode === 'ai' && llm && provider && model) {
    const plan = chunkMessages(messages)
    chunks = plan.chunks.length
    const system = scope === 'habit' ? SYSTEM_HABIT : SYSTEM_TASK

    for (let i = 0; i < plan.chunks.length; i++) {
      if (signal?.aborted) break
      onProgress?.({ phase: 'ai', done: i, total: plan.chunks.length })
      const result = await askModel(
        llm, provider, model, system, buildTranscript(plan.chunks[i]), signal,
      )
      if (result.error) { failed += 1; error = error || result.error }
      for (const node of result.nodes) {
        const normalised = normalise(node, scope)
        if (normalised) aiNodes.push(normalised)
      }
    }
    onProgress?.({ phase: 'ai', done: chunks, total: chunks })
  }

  // AI nodes come first so they win ties on importance during dedupe.
  let merged = dedupe([...aiNodes, ...ruleNodes])

  // Rule-only titles are truncated clauses, not labels ("现在能不能删"). When a
  // model is reachable, rewrite them in one cheap batch — the transcripts are
  // already summarised by then, so this is a title pass, not another extraction.
  if (merged.length && llm && provider && model) {
    const retitled = await rewriteTitles(llm, provider, model, merged, signal)
    if (retitled) {
      merged = merged.map((node) => {
        const better = retitled.get(node.title)
        return better ? { ...node, title: better } : node
      })
    }
  }

  const tree = emptyTree(scope === 'habit' ? 'habit' : 'task', title)
  const trunkId = `t_${Date.now().toString(36)}_root`
  const trunkTitle = scope === 'habit' ? (title || '用户习惯') : (title || '任务记录')

  tree.nodes[trunkId] = {
    id: trunkId,
    type: scope === 'habit' ? 'preference' : 'goal',
    layer: 'trunk',
    title: tidy(trunkTitle, 20) || '默认领域',
    summary: '',
    digest: '',
    parents: [],
    keywords: [],
    pointer: null,
    importance: 0.9,
    access_count: 0,
    last_access: nowIso(),
    state: 'active',
    status: 'open',
    next_hint: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    source: 'log-import',
  }

  // Group by type so the tree reads as branches of one kind rather than noise.
  const groups = new Map()
  for (const node of merged) {
    if (!groups.has(node.type)) groups.set(node.type, [])
    groups.get(node.type).push(node)
  }

  let seq = 0
  for (const [type, items] of groups) {
    const branchId = `b_${Date.now().toString(36)}_${seq++}`
    tree.nodes[branchId] = {
      id: branchId,
      type: scope === 'habit' ? 'preference' : 'task',
      layer: 'branch',
      title: BRANCH_LABEL[type] || type,
      summary: '',
      digest: '',
      parents: [trunkId],
      keywords: [],
      pointer: null,
      importance: 0.8,
      access_count: 0,
      last_access: nowIso(),
      state: 'active',
      status: 'open',
      next_hint: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      source: 'log-import',
    }
    tree.edges.push({ from: branchId, to: trunkId, rel: 'part_of', weight: 1.0 })

    for (const item of items) {
      const leafId = `n_${Date.now().toString(36)}_${seq++}`
      tree.nodes[leafId] = {
        id: leafId,
        type: item.type,
        layer: 'leaf',
        title: item.title,
        summary: item.summary,
        digest: '',
        keywords: item.keywords,
        parents: [branchId],
        pointer: null,
        importance: item.importance,
        access_count: 0,
        last_access: nowIso(),
        state: 'active',
        status: item.status,
        next_hint: item.next_hint,
        created_at: nowIso(),
        updated_at: nowIso(),
        source: 'log-import',
      }
      tree.edges.push({ from: leafId, to: branchId, rel: 'part_of', weight: 1.0 })
    }
  }

  return {
    tree,
    stats: {
      total: merged.length,
      fromRules: ruleNodes.length,
      fromAi: aiNodes.length,
      chunks,
      failed,
      error,
    },
  }
}

/** Branch names by node type; keeps the visual tree legible. */
const BRANCH_LABEL = {
  goal: '目标',
  decision: '决策',
  constraint: '约束',
  task: '待办',
  issue: '问题',
  fact: '事实',
  artifact: '产出',
  deadend: '死路',
  question: '疑问',
  preference: '偏好',
}

/**
 * dsh-memory-tree — Retrieval gate and write policy.
 *
 * The user's rule is asymmetric on purpose: the agent works from the live
 * conversation by default, and only reaches into memory when the user clearly
 * refers back to something. Two guards enforce that:
 *
 *   shouldSearch   — decide from the utterance whether recall is even allowed
 *   proposeRecall  — return candidates WITHOUT reading any document, so the user
 *                    can confirm before a long transcript enters the context
 *
 * Write policy is the mirror image: a tree may only grow inside its own
 * workspace, duplicates are updated rather than appended, and the habit tree
 * accepts a node only when the user stated a preference outright.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  readJson, writeJson, workspaceTreeFile, habitTreeFile, workspaceRoot,
} from './storage.js'

/* ------------------------------------------------------------------- gate */

/**
 * Phrases that mean "you and I discussed this before".
 *
 * Deliberately conservative: a false positive drags the agent into an unasked-for
 * memory search, which is exactly the confusion the user wants to avoid. A bare
 * "那个" is not included — it is far too common in ordinary speech.
 */
const RECALL_PATTERNS = [
  /之前(那个|那件|说过|提过|聊过|的|我们|讨论)/,
  /上次(那个|那件|说过|提过|我们|聊)/,
  /上回/,
  /前几天(说|提|聊|讨论|那个)/,
  /上次说/,
  /(前面|刚才)(说过|提过|那个|聊过)/,
  /(我们|咱们)(之前|以前|上次)/,
  /还记得/,
  /(你|我)(之前|以前)(说|提|记录|存)/,
  /(那个|那件)(事|任务|项目|方案|问题)/,
  /(早先|先前)/,
  /(接着|继续)(上次|之前|那个)/,
  /翻一下(记忆|记录)/,
  /查(一下)?(记忆|以前|之前)/,
]

/** Words that make an utterance a habit statement rather than a task remark. */
const HABIT_PATTERNS = [
  /我(更)?(喜欢|偏好|习惯|倾向)/,
  /以后(都)?(用|按|走|这样)/,
  /(一律|统一)(用|按|先|不)/,
  /(每次|以后)都(要|请|先|得)/,
  /我(不)?(希望|想要)你(以后|每次)/,
  /记住我/,
  /我的习惯/,
  // An imperative that reads as a standing instruction rather than one task,
  // e.g. "不要用 sed" or "总是先跑测试".
  /^(以后|今后|从现在起|please)?\s*(不要|别|务必|一定要|总是|始终|先)/,
]

/**
 * Whether this utterance asks for recall, and why.
 *
 * Returns `{ allowed, reason, matched }`. `allowed` false means the agent must
 * not search at all, which is the default for ordinary work.
 */
export function shouldSearch(utterance) {
  const text = String(utterance || '')
  if (!text.trim()) return { allowed: false, reason: 'empty', matched: null }

  for (const pattern of RECALL_PATTERNS) {
    const match = pattern.exec(text)
    if (match) {
      return { allowed: true, reason: 'referential', matched: match[0] }
    }
  }
  return { allowed: false, reason: 'no_reference', matched: null }
}

/** Whether this utterance states a durable preference about how to work. */
export function isHabitStatement(utterance) {
  const text = String(utterance || '')
  if (!text.trim()) return false
  return HABIT_PATTERNS.some((pattern) => pattern.test(text))
}

/* ------------------------------------------------------------------ recall */

/**
 * Find candidates for a referential question WITHOUT opening any document.
 *
 * This is the whole point of the gate: titles and summaries are cheap, a full
 * transcript is not. The caller must show these to the user and wait for a yes
 * before calling `readPointer`.
 */
export function proposeRecall(tree, query, cfg, opts = {}) {
  const topn = Math.max(1, Math.min(10, opts.topn || 3))
  const tokens = tokenize(query)
  if (!tokens.length || !tree?.nodes) return { candidates: [], tokens }

  const nodes = Object.values(tree.nodes).filter((n) => n.state === 'active' && n.layer !== 'trunk')
  if (!nodes.length) return { candidates: [], tokens }

  const scored = []
  for (const node of nodes) {
    const haystack = `${node.title || ''} ${node.summary || ''} ${(node.keywords || []).join(' ')}`.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (haystack.includes(token)) score += 1
      if ((node.title || '').toLowerCase().includes(token)) score += 1.5
    }
    if (!score) continue
    scored.push({ node, score })
  }

  scored.sort((a, b) => b.score - a.score)

  return {
    tokens,
    candidates: scored.slice(0, topn).map(({ node, score }) => ({
      id: node.id,
      title: node.title,
      summary: node.summary,
      type: node.type,
      keywords: node.keywords || [],
      // A pointer is a location, not content: naming it costs nothing.
      has_document: Boolean(node.pointer),
      score,
    })),
  }
}

/** Crude tokenizer shared with the gate; CJK is split into 2-grams. */
function tokenize(query) {
  const text = String(query || '').toLowerCase()
  const out = new Set()
  for (const word of text.match(/[a-z0-9_]{2,}/g) || []) out.add(word)
  const cjk = text.match(/[\u4e00-\u9fa5]+/g) || []
  for (const run of cjk) {
    if (run.length <= 2) { out.add(run); continue }
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/* ------------------------------------------------------------ write policy */

/** Normalise a title for duplicate detection: case and punctuation folded. */
function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * Decide, for one proposed node, whether it duplicates something already stored.
 *
 * A hit means UPDATE that node instead of appending a second copy — the user
 * asked explicitly for no mechanical duplicates.
 */
export function findDuplicate(tree, candidate) {
  if (!tree?.nodes) return null
  const key = titleKey(candidate.title)
  if (!key) return null

  for (const node of Object.values(tree.nodes)) {
    if (node.layer === 'trunk') continue
    if (titleKey(node.title) === key) return node
  }
  // A title may differ while meaning the same thing; fall back to keyword overlap
  // when both sides carry keywords.
  const wanted = new Set((candidate.keywords || []).map((k) => String(k).toLowerCase()))
  if (wanted.size < 2) return null

  for (const node of Object.values(tree.nodes)) {
    if (node.layer === 'trunk') continue
    const have = (node.keywords || []).map((k) => String(k).toLowerCase())
    if (!have.length) continue
    const shared = have.filter((k) => wanted.has(k)).length
    if (shared >= 2 && shared / Math.min(have.length, wanted.size) >= 0.5) return node
  }
  return null
}

/**
 * Whether a workspace may write to the tree at `targetDir`.
 *
 * Task trees never cross workspaces: writing into someone else's tree is how a
 * memory system becomes untrustworthy. The habit tree is exempt because it is
 * deliberately shared.
 */
export function canWriteTree({ treeType, agentDir, targetDir }) {
  if (treeType === 'habit') return { allowed: true }
  const a = path.resolve(String(agentDir || ''))
  const b = path.resolve(String(targetDir || ''))
  if (!a || !b) return { allowed: false, error: 'missing_dir' }
  if (a.toLowerCase() !== b.toLowerCase()) {
    return { allowed: false, error: 'cross_workspace', message: '任务树只能在所属工作区内写入' }
  }
  return { allowed: true }
}

/* ------------------------------------------------------------- habit tree */

/**
 * The habit snapshot injected at session start.
 *
 * Only preferences and constraints, only titles — this is a nudge, not a
 * document load, and it must stay small enough to sit in every prompt.
 */
export function habitSnapshot(root, limit = 8) {
  // Read through the engine's own resolver, not a hand-built path. This function
  // used to look under `root/habits/tree.json` while `grow` wrote to
  // `root/.memory-tree/tree.json`, so every preference written by the habit tool
  // was invisible here and the snapshot always came back empty.
  const tree = readJson(habitTreeFile(root), null)
  if (!tree?.nodes) return { ok: true, empty: true, items: [] }

  const nodes = Object.values(tree.nodes)
    .filter((n) => n.state === 'active' && n.layer !== 'trunk')
    .filter((n) => n.type === 'preference' || n.type === 'constraint')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, limit)

  return {
    ok: true,
    empty: nodes.length === 0,
    items: nodes.map((n) => ({
      title: n.title,
      type: n.type,
      summary: String(n.summary || '').slice(0, 80),
    })),
  }
}

/**
 * Whether a habit write is warranted.
 *
 * The user asked that the habit tree only change when they state a preference
 * outright, so a task-tree observation never leaks into it.
 */
export function habitWriteAllowed(utterance, explicit = false) {
  if (explicit) return { allowed: true, reason: 'explicit_request' }
  if (isHabitStatement(utterance)) return { allowed: true, reason: 'stated_preference' }
  return { allowed: false, reason: 'not_a_preference' }
}

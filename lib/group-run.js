/**
 * dsh-memory-tree — run grouping for the branches that need it.
 *
 * `groups.js` owns the pure decisions; this file owns the side effects: pick a
 * model, ask once per branch, and write the result back through the engine.
 *
 * Failure policy: grouping is cosmetic. If the model is missing, errors, or
 * answers in a shape we cannot use, the tree keeps whatever groups it had and
 * the call reports `skipped`. A write that succeeded must never be reported as
 * a failure because tidying failed afterwards.
 */

import {
  branchesToGroup, buildGroupPrompt, materialiseGroups, parseGroupReply,
  replaceGroupsFor, groupsOf, GROUP_THRESHOLD,
  buildBucketPrompt, materialiseBucket, applyBucketGroups, bucketsOf,
} from './groups.js'
import { completeText, pickModel, GROUP_PURPOSE } from './llm-text.js'

const SYSTEM = [
  '你在给一棵"记忆树"做语义分组。',
  '输入是一个父节点和它的子节点列表，每个子节点有类型、标题和摘要。',
  '你的任务是把这些子节点按"在讲同一件事"归组，并给每组起一个准确的中文短名。',
  '只输出 JSON，不要解释。',
].join('\n')

/**
 * Group every branch in `tree` that exceeds the threshold.
 *
 * Mutates nothing: returns `{ tree, grouped, skipped, reason }` where `tree` is
 * the input when nothing could be done. Callers decide whether to persist.
 */
export async function groupTree(tree, { llm, preferred, session, limit = 4, threshold = GROUP_THRESHOLD } = {}) {
  const targets = branchesToGroup(tree, { limit, threshold })
  if (!targets.length) {
    return { tree, grouped: 0, skipped: 0, reason: 'nothing_to_group' }
  }

  const route = await pickModel(llm, preferred, session)
  if (!route) {
    return { tree, grouped: 0, skipped: targets.length, reason: 'no_model' }
  }

  let next = tree
  let grouped = 0
  let skipped = 0
  let sample = null

  for (const target of targets) {
    // Re-read from `next`: an earlier branch's grouping must not be clobbered.
    const prompt = buildGroupPrompt(target.parent, target.children, next.nodes)
    const trace = {}
    const reply = await completeText(llm, {
      provider: route.provider,
      model: route.model,
      system: SYSTEM,
      prompt,
      maxTokens: 700,
      trace,
    })

    const parsed = parseGroupReply(reply)
    if (!parsed) {
      skipped += 1
      // Keep the first unusable reply so the panel can show what came back —
      // "the model did not answer in the expected shape" is not actionable on
      // its own, and without the raw text the only way to debug is to guess.
      if (!sample) sample = { reply: String(reply || '').slice(0, 400), chars: String(reply || '').length, trace }
      continue
    }

    const groups = materialiseGroups(target.parentId, target.children, parsed, 'ai')
    if (!groups.length) {
      skipped += 1
      if (!sample) sample = { reply: String(reply || '').slice(0, 400), chars: String(reply || '').length, trace, note: 'parsed but empty' }
      continue
    }

    next = replaceGroupsFor(next, target.parentId, groups)
    grouped += 1
  }

  return {
    tree: next,
    grouped,
    skipped,
    reason: grouped ? 'ok' : 'model_unusable',
    provider: route.provider,
    model: route.model,
    ...(sample ? { sample } : {}),
  }
}

/**
 * Group one explicit parent, ignoring the threshold.
 *
 * The panel's "重新分组" action uses this: after the user edits nodes by hand,
 * they may want the branch re-clustered even when it is small.
 */
export async function groupBranch(tree, parentId, { llm, preferred, session } = {}) {
  const nodes = tree?.nodes || {}
  const parent = nodes[parentId]
  if (!parent) return { tree, grouped: 0, skipped: 0, reason: 'parent_not_found' }

  const children = []
  for (const edge of tree?.edges || []) {
    if (edge.rel === 'part_of' && edge.to === parentId && nodes[edge.from]) {
      children.push(edge.from)
    }
  }
  if (children.length < 2) {
    return { tree, grouped: 0, skipped: 0, reason: 'too_few_children' }
  }

  const route = await pickModel(llm, preferred, session)
  if (!route) return { tree, grouped: 0, skipped: 1, reason: 'no_model' }

  const reply = await completeText(llm, {
    provider: route.provider,
    model: route.model,
    system: SYSTEM,
    prompt: buildGroupPrompt(parent, children, nodes),
    maxTokens: 700,
  })

  const parsed = parseGroupReply(reply)
  if (!parsed) return { tree, grouped: 0, skipped: 1, reason: 'model_unusable' }

  const groups = materialiseGroups(parentId, children, parsed, 'ai')
  if (!groups.length) return { tree, grouped: 0, skipped: 1, reason: 'model_unusable' }

  return {
    tree: replaceGroupsFor(tree, parentId, groups),
    grouped: 1,
    skipped: 0,
    reason: 'ok',
    provider: route.provider,
    model: route.model,
  }
}

/**
 * Name one index bucket, and let the model redraw its membership.
 *
 * `bucketId` is the id the canvas synthesised (`__grp__<parent>__<n>`). This
 * re-reads the parent's children to find that bucket, then asks the model to
 * split and name them. Returns the same shape as `groupBranch` so the route can
 * treat both the same way.
 */
export async function nameBucket(tree, parentId, bucketId, { llm, preferred, session } = {}) {
  const nodes = tree?.nodes || {}
  const parent = nodes[parentId]
  if (!parent) return { tree, grouped: 0, skipped: 0, reason: 'parent_not_found' }

  // The children in canvas order — the same order the bucket indices use.
  const kids = new Map()
  for (const edge of tree?.edges || []) {
    if (edge.rel !== 'part_of') continue
    if (!nodes[edge.from] || !nodes[edge.to]) continue
    if (!kids.has(edge.to)) kids.set(edge.to, [])
    kids.get(edge.to).push(edge.from)
  }
  const children = (kids.get(parentId) || []).filter((id) => nodes[id])
  const siblings = bucketsOf(tree, kids, parentId)
  const target = siblings.find((b) => b.id === bucketId)
  if (!target) return { tree, grouped: 0, skipped: 0, reason: 'bucket_not_found' }

  const route = await pickModel(llm, preferred, session)
  if (!route) return { tree, grouped: 0, skipped: 1, reason: 'no_model' }

  const trace = {}
  const reply = await completeText(llm, {
    provider: route.provider,
    model: route.model,
    system: SYSTEM,
    prompt: buildBucketPrompt(parent.title, target.members, nodes),
    maxTokens: 700,
    trace,
  })

  const parsed = parseGroupReply(reply)
  if (!parsed) {
    return {
      tree, grouped: 0, skipped: 1, reason: 'model_unusable',
      provider: route.provider, model: route.model,
      sample: { reply: String(reply || '').slice(0, 400), chars: String(reply || '').length, trace },
    }
  }

  const groups = materialiseBucket(parentId, bucketId, target.members, parsed)
  if (!groups.length) {
    return {
      tree, grouped: 0, skipped: 1, reason: 'model_unusable',
      provider: route.provider, model: route.model,
      sample: { reply: String(reply || '').slice(0, 400), chars: String(reply || '').length, trace, note: 'parsed but empty' },
    }
  }

  return {
    tree: applyBucketGroups(tree, parentId, bucketId, siblings, groups),
    grouped: groups.length,
    skipped: 0,
    reason: 'ok',
    provider: route.provider,
    model: route.model,
    titles: groups.map((g) => g.title),
  }
}

/** Whether the tree already carries usable groups, for the panel's hint. */
export function groupSummary(tree) {
  const all = Object.values(tree?.groups || {}).filter((g) => Array.isArray(g?.members) && g.members.length)
  const parents = new Set(all.map((g) => g.parent))
  return {
    groups: all.length,
    parents: parents.size,
    byParent: [...parents].map((parent) => ({
      parent,
      title: tree?.nodes?.[parent]?.title || parent,
      groups: groupsOf(tree, parent).map((g) => ({ id: g.id, title: g.title, size: g.members.length })),
    })),
  }
}

export { GROUP_PURPOSE }

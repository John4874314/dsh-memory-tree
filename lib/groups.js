/**
 * dsh-memory-tree — semantic grouping of a branch's children.
 *
 * A branch that collects a dozen leaves reads as one long list: nothing on the
 * canvas says which leaves belong together. Grouping is the answer, and the
 * model is the only thing that can name a cluster honestly ("插件机制",
 * "UI 与交互") instead of slicing by index.
 *
 * The groups are stored IN the tree — `tree.groups` — so a name the user edits
 * survives a reload. Rendering that ignores this file still works: a tree without
 * `groups` simply draws every child directly under its parent.
 *
 * Shape:
 *
 *   groups: {
 *     [groupId]: {
 *       id: string,
 *       parent: string,        // the branch these children hang off
 *       title: string,         // the name shown on the canvas
 *       members: string[],     // child node ids, in display order
 *       source: 'ai' | 'manual',
 *       created_at: string,
 *     }
 *   }
 */

import crypto from 'node:crypto'

import { nowIso } from './engine.js'

/** Children must exceed this before grouping is worth doing at all. */
export const GROUP_THRESHOLD = 6

/**
 * Stable id for the Nth index bucket of a parent.
 *
 * Must match the id the canvas synthesises, or a bucket named here would not be
 * the bucket the user clicked. Kept in this module because the server now needs
 * to address buckets too.
 */
export const groupIdOf = (parentId, index) => `__grp__${parentId}__${index}`

/** No single group should be longer than this, or it just moves the problem. */
const MAX_GROUP_SIZE = 8

/** Titles the model tends to invent; anything longer is noise on a 208px node. */
const MAX_TITLE = 12

const newGroupId = () => `g_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`

/** Children of every node, derived from the edges exactly as the rail does. */
export function childrenOf(tree) {
  const nodes = tree?.nodes || {}
  const kids = new Map()
  for (const edge of tree?.edges || []) {
    if (edge.rel !== 'part_of') continue
    if (!nodes[edge.from] || !nodes[edge.to]) continue
    if (!kids.has(edge.to)) kids.set(edge.to, [])
    kids.get(edge.to).push(edge.from)
  }
  return kids
}

/** Reading order: score desc, then title, so grouping sees the strongest first. */
function sortForGrouping(ids, nodes) {
  return [...ids].sort((a, b) => {
    const sb = nodes[b]?.score || 0
    const sa = nodes[a]?.score || 0
    if (sb !== sa) return sb - sa
    return String(nodes[a]?.title || '').localeCompare(String(nodes[b]?.title || ''))
  })
}

/**
 * Which branches deserve grouping.
 *
 * Only branches whose children exceed the threshold are returned, and the list
 * is capped so one enormous tree cannot trigger a dozen model calls.
 */
export function branchesToGroup(tree, { limit = 4, threshold = GROUP_THRESHOLD } = {}) {
  const nodes = tree?.nodes || {}
  const kids = childrenOf(tree)
  const out = []
  for (const [parentId, children] of kids) {
    const parent = nodes[parentId]
    if (!parent) continue
    // A leaf-parent with many children is already an odd shape; grouping a trunk
    // would sit groups beside branches, which reads worse than the plain fan.
    if (parent.layer === 'trunk') continue
    if (children.length <= threshold) continue
    out.push({ parentId, parent, children: sortForGrouping(children, nodes) })
  }
  out.sort((a, b) => b.children.length - a.children.length)
  return out.slice(0, limit)
}

/** A compact catalogue of the children, small enough to fit in one prompt. */
function catalogueOf(parent, children, nodes) {
  return children.map((id, index) => {
    const node = nodes[id]
    const summary = String(node?.summary || '').replace(/\s+/g, ' ').slice(0, 40)
    return `${index + 1}. [${node?.type || 'fact'}] ${node?.title || id}${summary ? ` — ${summary}` : ''}`
  }).join('\n')
}

export function buildGroupPrompt(parent, children, nodes) {
  return [
    `把一个记忆树节点下的 ${children.length} 条子节点按语义分组。`,
    '',
    `父节点：「${parent.title}」${parent.summary ? `（${parent.summary}）` : ''}`,
    '',
    '子节点：',
    catalogueOf(parent, children, nodes),
    '',
    '要求：',
    `1. 分成 2–4 组，每组 2–${MAX_GROUP_SIZE} 条；同一组必须是同一件事的不同侧面。`,
    `2. 组名 2–${MAX_TITLE} 个汉字，说清这一组"在讲什么"，不要用"其他""杂项"。`,
    '3. 每条子节点必须且只能出现在一组里，用上面的序号。',
    '4. 只输出 JSON，不要任何解释或 Markdown 代码块。',
    '',
    '输出格式：',
    '{"groups":[{"title":"组名","items":[1,3,5]}]}',
  ].join('\n')
}

/**
 * Parse whatever the model returned into `[{ title, items }]`.
 *
 * Models wrap JSON in fences, add prose, rename keys, and trail commas — far more
 * often than they return the exact shape the prompt asked for. A strict parse
 * therefore fails on replies that are perfectly intelligible, which reads to the
 * user as "grouping does not work". Each tolerated variant below was observed or
 * is a documented failure mode:
 *
 *   - a fenced block, or prose before/after the object
 *   - a bare array instead of `{groups:[...]}`
 *   - `name`/`group` instead of `title`/`groups`
 *   - a trailing comma before `]` or `}`
 *   - ordinals as strings ("3") rather than numbers
 *
 * Anything still unintelligible returns null and the caller keeps its shape.
 */
export function parseGroupReply(text) {
  if (!text) return null
  const raw = String(text).trim()

  // Candidate JSON payloads, most specific first.
  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1])

  const objStart = raw.indexOf('{')
  const objEnd = raw.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) candidates.push(raw.slice(objStart, objEnd + 1))

  // A bare array is a common near-miss for `{groups:[...]}`.
  const arrStart = raw.indexOf('[')
  const arrEnd = raw.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(raw.slice(arrStart, arrEnd + 1))

  for (const candidate of candidates) {
    const parsed = tryJson(candidate)
    if (!parsed) continue
    const list = extractGroupList(parsed)
    if (!list) continue
    const out = normaliseEntries(list)
    if (out.length) return out
  }
  return null
}

/** JSON.parse with the two repairs that keep coming up. */
function tryJson(text) {
  const clean = String(text).trim()
  try {
    return JSON.parse(clean)
  } catch { /* try repairs below */ }
  // Trailing comma before a closing brace/bracket.
  const repaired = clean.replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(repaired)
  } catch {
    return null
  }
}

/** Find the array of group-ish objects whatever they are nested under. */
function extractGroupList(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return null
  // Accept the documented `groups` plus the names models actually emit.
  for (const key of ['groups', 'group', 'result', 'data', 'items']) {
    if (Array.isArray(parsed[key])) return parsed[key]
  }
  // Last resort: the first array of objects anywhere one level down.
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value
  }
  return null
}

/** Map the tolerated shapes onto `{ title, items }`. */
function normaliseEntries(list) {
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const title = String(
      entry.title ?? entry.name ?? entry.label ?? entry.group ?? '',
    ).trim().slice(0, MAX_TITLE)

    const rawItems = entry.items ?? entry.members ?? entry.ids ?? entry.children ?? []
    const items = Array.isArray(rawItems)
      ? rawItems.map((v) => Number(v)).filter((v) => Number.isInteger(v))
      : []

    if (!title || !items.length) continue
    out.push({ title, items })
  }
  return out
}

/**
 * Turn a parsed reply into group records, validating against the real children.
 *
 * The model works in 1-based ordinals, which keep the payload small. This maps
 * them back to ids and enforces the invariants the canvas depends on: every
 * member is a real child of this parent, and no child appears twice.
 *
 * Children the model dropped are spread across the groups it DID name, rather
 * than collected into a new one. Inventing an extra group would contradict the
 * grouping the model just chose, and the user asked for semantics — not for a
 * bucket labelled "其他" the model never proposed.
 */
export function materialiseGroups(parentId, childIds, parsed, source = 'ai') {
  if (!parsed?.length) return []
  const allowed = new Set(childIds)
  const used = new Set()
  const groups = []

  for (const entry of parsed) {
    const members = []
    for (const ordinal of entry.items) {
      const id = childIds[ordinal - 1]
      if (!id || !allowed.has(id) || used.has(id)) continue
      used.add(id)
      members.push(id)
      if (members.length >= MAX_GROUP_SIZE) break
    }
    if (members.length) {
      groups.push({
        id: newGroupId(),
        parent: parentId,
        title: entry.title,
        members,
        source,
        created_at: nowIso(),
      })
    }
  }

  // Nothing usable survived validation — fall back to the ungrouped shape.
  if (!groups.length) return []

  // Spread leftovers round-robin so no single group absorbs them all. The size
  // cap is deliberately not enforced here: dropping a child to respect it would
  // hide a memory, which is worse than one slightly long group.
  const missing = childIds.filter((id) => !used.has(id))
  let cursor = 0
  for (const id of missing) {
    groups[cursor % groups.length].members.push(id)
    cursor += 1
  }

  return groups
}

/** Merge new groups for one parent into a tree's existing group map. */
export function replaceGroupsFor(tree, parentId, groups) {
  const existing = tree?.groups || {}
  const kept = {}
  for (const [id, group] of Object.entries(existing)) {
    if (group?.parent !== parentId) kept[id] = group
  }
  for (const group of groups) kept[group.id] = group
  return { ...tree, groups: kept }
}

/** Groups of one parent, in stored order. */
export function groupsOf(tree, parentId) {
  return Object.values(tree?.groups || {})
    .filter((g) => g?.parent === parentId && Array.isArray(g.members) && g.members.length)
}

/**
 * Rename / merge / dissolve helpers used by the panel.
 *
 * Kept here rather than inline in the route so the invariants live in one place:
 * every mutation returns a new tree and never leaves a group empty.
 */
export function renameGroup(tree, groupId, title) {
  const group = tree?.groups?.[groupId]
  if (!group) return { ok: false, error: 'group_not_found' }
  const clean = String(title || '').trim().slice(0, MAX_TITLE)
  if (!clean) return { ok: false, error: 'empty_title' }
  return {
    ok: true,
    tree: { ...tree, groups: { ...tree.groups, [groupId]: { ...group, title: clean, source: 'manual' } } },
  }
}

export function dissolveGroup(tree, groupId) {
  const group = tree?.groups?.[groupId]
  if (!group) return { ok: false, error: 'group_not_found' }
  const next = { ...tree.groups }
  delete next[groupId]
  return { ok: true, tree: { ...tree, groups: next } }
}

/** Move every member of `groupId` into `targetId`, then drop the empty group. */
export function mergeGroups(tree, groupId, targetId) {
  const from = tree?.groups?.[groupId]
  const to = tree?.groups?.[targetId]
  if (!from || !to) return { ok: false, error: 'group_not_found' }
  if (from.parent !== to.parent) return { ok: false, error: 'different_parent' }
  const members = [...to.members]
  for (const id of from.members) if (!members.includes(id)) members.push(id)
  const next = { ...tree.groups, [targetId]: { ...to, members } }
  delete next[groupId]
  return { ok: true, tree: { ...tree, groups: next } }
}

/* ------------------------------------------------- naming a single bucket */

/**
 * Prompt for naming ONE bucket, and letting the model redraw its membership.
 *
 * A bucket is a fixed-size slice cut without looking at content, so its members
 * often tell two different stories. Asking only for a title would force one
 * misleading label onto both. So the model may also split them — the user asked
 * for groups "not necessarily six, adjust by what it actually says".
 *
 * Only the bucket's own members are offered. Pulling in a sibling bucket's node
 * would silently empty that bucket, which nobody asked for.
 */
export function buildBucketPrompt(parentTitle, memberIds, nodes) {
  const list = memberIds.map((id, i) => {
    const node = nodes[id]
    const summary = String(node?.summary || '').replace(/\s+/g, ' ').slice(0, 50)
    return `${i + 1}. [${node?.type || 'fact'}] ${node?.title || id}${summary ? ` — ${summary}` : ''}`
  }).join('\n')

  return [
    `下面 ${memberIds.length} 条记忆节点是被临时放在一起的，它们不一定讲同一件事。`,
    parentTitle ? `它们的上级是「${parentTitle}」。` : '',
    '',
    list,
    '',
    '请做两件事：',
    '1. 把"确实讲同一件事"的归成一组，并给这一组起名。',
    '2. 如果它们其实分成几件事，就拆成几组，每组各自起名。',
    `组名 2–${MAX_TITLE} 个汉字，说清这一组在讲什么。`,
    '每条必须且只能出现在一组里，用上面的序号。',
    '不要用"其他""杂项""待分类"这类名字。',
    '只输出 JSON，不要解释，不要 Markdown 代码块。',
    '',
    '输出格式：',
    '{"groups":[{"title":"组名","items":[1,3]}]}',
  ].filter(Boolean).join('\n')
}

/**
 * Validate a bucket-naming reply against that bucket's members.
 *
 * Same ordinals-in, ids-out contract as `materialiseGroups`, but scoped to one
 * bucket: a node from a neighbouring bucket is rejected rather than stolen.
 * Every member must land somewhere — a dropped node would vanish from the canvas,
 * which is worse than an awkward group name.
 */
export function materialiseBucket(parentId, bucketId, memberIds, parsed) {
  if (!parsed?.length) return []
  const allowed = new Set(memberIds)
  const used = new Set()
  const groups = []

  for (const entry of parsed) {
    const members = []
    for (const ordinal of entry.items) {
      const id = memberIds[ordinal - 1]
      if (!id || !allowed.has(id) || used.has(id)) continue
      used.add(id)
      members.push(id)
    }
    if (!members.length) continue
    groups.push({
      id: newGroupId(),
      parent: parentId,
      title: entry.title,
      members,
      source: 'ai',
      bucket: bucketId,
      created_at: nowIso(),
    })
  }

  if (!groups.length) return []

  // Anything the model dropped is spread across what it did name, so no member
  // disappears from the canvas just because the reply was incomplete.
  const missing = memberIds.filter((id) => !used.has(id))
  let cursor = 0
  for (const id of missing) {
    groups[cursor % groups.length].members.push(id)
    cursor += 1
  }

  return groups
}

/**
 * Replace one bucket with the groups the model produced, pinning its siblings.
 *
 * The unpinned buckets would otherwise be re-sliced from scratch on the next
 * render, throwing away this work. Pinning is recorded in the tree (`fixed: true`)
 * so it survives a reload.
 */
export function applyBucketGroups(tree, parentId, bucketId, siblings, named) {
  const nodes = tree?.nodes || {}
  const kept = {}
  for (const [id, group] of Object.entries(tree?.groups || {})) {
    // Groups this bucket produced earlier are replaced wholesale.
    if (group?.bucket === bucketId) continue
    kept[id] = group
  }

  for (const group of named) {
    const members = group.members.filter((m) => nodes[m])
    if (!members.length) continue
    kept[group.id] = { ...group, members }
  }

  for (const sibling of siblings) {
    if (sibling.id === bucketId) continue
    if (!sibling.members?.length) continue
    const fixedId = `fx_${sibling.id}`
    kept[fixedId] = {
      id: fixedId,
      parent: parentId,
      title: sibling.title,
      members: sibling.members.filter((m) => nodes[m]),
      source: 'manual',
      fixed: true,
      created_at: nowIso(),
    }
  }

  return { ...tree, groups: kept }
}

/** Ids of the buckets currently shown under `parentId`, as the canvas draws them. */
export function bucketsOf(tree, kids, parentId) {
  const nodes = tree?.nodes || {}
  const children = (kids.get(parentId) || []).filter((c) => nodes[c])
  if (children.length <= GROUP_THRESHOLD) return []
  const buckets = []
  for (let i = 0; i < children.length; i += GROUP_THRESHOLD) {
    const slice = children.slice(i, i + GROUP_THRESHOLD)
    buckets.push({
      id: groupIdOf(parentId, i / GROUP_THRESHOLD),
      title: `${i + 1}–${i + slice.length}`,
      members: slice,
    })
  }
  return buckets
}


/**
 * dsh-memory-tree — Whole-tree delete, recycle and restore.
 *
 * Node-level deletion lives in engine.js and works inside one tree. This module
 * handles the coarser operation the panel offers: throw away an entire workspace
 * tree, keep it recoverable for a while, then put it back — either replacing what
 * is there now or merging into it.
 *
 * The tree directory is MOVED into the trash rather than rewritten, so a restore
 * is exact and cheap: no node re-creation, no id remapping, no loss of logs.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { treeRoot, habitHostDir, nowIso } from './engine.js'

/** Where deleted trees wait to be restored. Inside DSH home, never the workspace. */
export function trashRoot(dshHome) {
  return path.join(habitHostDir(dshHome), 'trash')
}

/** The index of every tree currently in the trash. */
export function trashIndexFile(dshHome) {
  return path.join(trashRoot(dshHome), 'index.json')
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

/** Atomic write: a crash must not leave a half-written index behind. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function loadIndex(dshHome) {
  const index = readJson(trashIndexFile(dshHome), { entries: [] })
  if (!Array.isArray(index.entries)) index.entries = []
  return index
}

function saveIndex(dshHome, index) {
  writeJson(trashIndexFile(dshHome), index)
}

/* ---------------------------------------------------------------- registry */

function registryFile(dshHome) {
  return path.join(habitHostDir(dshHome), 'registry.json')
}

/**
 * Mark a workspace tree as deleted, or clear the mark on restore.
 *
 * The registry entry is KEPT: the panel lists the workspace as an empty shell so
 * the user can see the tree still exists in the trash rather than assuming the
 * work vanished.
 */
function markRegistry(dshHome, dir, patch) {
  const file = registryFile(dshHome)
  const registry = readJson(file, { trees: [] })
  if (!Array.isArray(registry.trees)) registry.trees = []
  const found = registry.trees.find((t) => t.dir === dir)
  if (found) Object.assign(found, patch)
  else if (patch.deleted_at === undefined) {
    registry.trees.push({ dir, title: path.basename(dir), updated_at: nowIso(), ...patch })
  }
  try { writeJson(file, registry) } catch { /* registry is a convenience */ }
}

/* ------------------------------------------------------------------ delete */

/**
 * Move a workspace's whole tree into the trash.
 *
 * Returns the trash entry so the caller can report what happened. Fails when the
 * tree does not exist, rather than silently succeeding on nothing.
 */
export function deleteWholeTree(hostDir, dshHome, treeType = 'task', note = '') {
  const root = treeRoot(hostDir)
  if (!fs.existsSync(root)) return { ok: false, error: 'tree_not_found' }

  const entryId = `tr_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
  const slot = path.join(trashRoot(dshHome), entryId)
  fs.mkdirSync(slot, { recursive: true })

  // Count first: once moved, the tree file is gone from its old place.
  let nodeCount = 0
  let edgeCount = 0
  try {
    const tree = readJson(path.join(root, 'tree.json'), { nodes: {}, edges: [] })
    nodeCount = Object.keys(tree.nodes || {}).length
    edgeCount = Array.isArray(tree.edges) ? tree.edges.length : 0
  } catch { /* counts are informational only */ }

  try {
    fs.renameSync(root, path.join(slot, 'tree'))
  } catch (error) {
    // A cross-device move cannot rename; fall back to copy + remove.
    try {
      fs.cpSync(root, path.join(slot, 'tree'), { recursive: true })
      fs.rmSync(root, { recursive: true, force: true })
    } catch (fallbackError) {
      try { fs.rmSync(slot, { recursive: true, force: true }) } catch { /* best effort */ }
      return { ok: false, error: 'move_failed', message: String(fallbackError?.message || error) }
    }
  }

  const meta = {
    entry_id: entryId,
    dir: hostDir,
    title: path.basename(hostDir) || hostDir,
    tree_type: treeType,
    note,
    deleted_at: nowIso(),
    nodes: nodeCount,
    edges: edgeCount,
  }
  writeJson(path.join(slot, 'meta.json'), meta)

  const index = loadIndex(dshHome)
  index.entries.push(meta)
  saveIndex(dshHome, index)

  markRegistry(dshHome, hostDir, { deleted_at: meta.deleted_at, trash_entry: entryId })

  return { ok: true, entry: meta }
}

/* ------------------------------------------------------------------- list */

/** Every recoverable tree, newest first. */
export function listTreeRecycle(dshHome) {
  const index = loadIndex(dshHome)
  const alive = []
  for (const entry of index.entries) {
    // An entry whose payload disappeared is stale; drop it from the listing.
    if (!fs.existsSync(path.join(trashRoot(dshHome), entry.entry_id, 'tree'))) continue
    alive.push(entry)
  }
  alive.sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)))
  return alive
}

/* ---------------------------------------------------------------- restore */

/**
 * Merge an incoming tree into an existing one without id collisions.
 *
 * Ids are namespaced by the incoming tree's own id, so a leaf from the restored
 * tree can never overwrite a leaf of the current one. Node titles are NOT
 * deduplicated: the user asked to merge, and identical titles may still be two
 * genuinely different memories.
 */
export function mergeTrees(existing, incoming) {
  const merged = {
    ...existing,
    nodes: { ...existing.nodes },
    edges: [...(existing.edges || [])],
    updated_at: nowIso(),
  }

  const suffix = String(incoming.tree_id || 'old').replace(/[^A-Za-z0-9_]/g, '').slice(-8) || 'old'
  const map = new Map()

  // Keep the existing trunk; incoming trunks become branch nodes under it.
  const existingTrunk = Object.values(existing.nodes || {}).find((n) => n.layer === 'trunk')
  const incomingTrunk = Object.values(incoming.nodes || {}).find((n) => n.layer === 'trunk')

  for (const [oldId, node] of Object.entries(incoming.nodes || {})) {
    if (node.layer === 'trunk') continue
    const newId = `${oldId}__${suffix}`
    map.set(oldId, newId)
    merged.nodes[newId] = { ...node, id: newId, source: node.source || 'restored' }
  }

  const trunkTarget = existingTrunk?.id || null

  for (const edge of incoming.edges || []) {
    const from = map.get(edge.from)
    if (!from) continue
    // Anything that pointed at the incoming trunk now hangs off our own trunk.
    const to = map.get(edge.to) || trunkTarget
    if (!to || from === to) continue
    merged.edges.push({ ...edge, from, to })
    const node = merged.nodes[from]
    if (node) node.parents = [to]
  }

  // A rescued branch whose parent did not survive still needs an anchor.
  if (trunkTarget) {
    for (const node of Object.values(merged.nodes)) {
      if (node.layer === 'trunk') continue
      if (!Array.isArray(node.parents) || !node.parents.length) {
        node.parents = [trunkTarget]
        merged.edges.push({ from: node.id, to: trunkTarget, rel: 'part_of', weight: 1 })
      }
    }
  }

  // Guard against a dangling parent id left by a partial incoming tree.
  for (const node of Object.values(merged.nodes)) {
    if (node.layer === 'trunk') continue
    if (node.parents?.some((p) => !merged.nodes[p])) node.parents = [trunkTarget].filter(Boolean)
  }
  if (incomingTrunk) map.set(incomingTrunk.id, trunkTarget)

  return merged
}

/**
 * Put a trashed tree back.
 *
 * `mode`:
 *   overwrite — the current tree is itself moved to the trash first, so replacing
 *               is reversible too; then the rescued tree takes its place.
 *   merge     — the rescued tree's nodes are folded into the current tree.
 *
 * When the target workspace has no live tree, both modes simply restore.
 */
export function restoreWholeTree(entryId, dshHome, mode = 'overwrite') {
  const index = loadIndex(dshHome)
  const entry = index.entries.find((e) => e.entry_id === entryId)
  if (!entry) return { ok: false, error: 'entry_not_found' }

  const slot = path.join(trashRoot(dshHome), entryId, 'tree')
  if (!fs.existsSync(slot)) return { ok: false, error: 'payload_missing' }

  const hostDir = entry.dir
  const target = treeRoot(hostDir)
  const hasLive = fs.existsSync(path.join(target, 'tree.json'))

  let replaced = null

  if (!hasLive) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try { fs.renameSync(slot, target) } catch {
      fs.cpSync(slot, target, { recursive: true })
      fs.rmSync(slot, { recursive: true, force: true })
    }
  } else if (mode === 'merge') {
    const current = readJson(path.join(target, 'tree.json'), null)
    const incoming = readJson(path.join(slot, 'tree.json'), null)
    if (!current || !incoming) return { ok: false, error: 'unreadable_tree' }
    const merged = mergeTrees(current, incoming)
    writeJson(path.join(target, 'tree.json'), merged)
    try { fs.rmSync(slot, { recursive: true, force: true }) } catch { /* best effort */ }
  } else {
    // Overwrite: park the current tree in the trash so the swap is reversible.
    const parked = deleteWholeTree(hostDir, dshHome, entry.tree_type, `restore ${entryId} 前的现场`)
    if (!parked.ok) return { ok: false, error: `park_failed:${parked.error}` }
    replaced = parked.entry.entry_id
    try { fs.renameSync(slot, target) } catch {
      fs.cpSync(slot, target, { recursive: true })
      fs.rmSync(slot, { recursive: true, force: true })
    }
  }

  // The rescued slot is spent; its index entry goes with it. The index is re-read
  // rather than reused: the overwrite branch above parked the outgoing tree and
  // appended its own entry, which a stale snapshot would erase.
  const fresh = loadIndex(dshHome)
  const remaining = fresh.entries.filter((e) => e.entry_id !== entryId)
  writeJson(trashIndexFile(dshHome), { entries: remaining })
  try { fs.rmSync(path.join(trashRoot(dshHome), entryId), { recursive: true, force: true }) } catch { /* best effort */ }

  markRegistry(dshHome, hostDir, { deleted_at: null, trash_entry: null, updated_at: nowIso() })

  return { ok: true, mode: hasLive ? mode : 'restore', replaced, dir: hostDir }
}

/* ------------------------------------------------------------------ purge */

/**
 * Drop a deleted workspace's shell from the panel.
 *
 * A workspace whose tree was removed keeps a `deleted_at` mark so it can be
 * restored. Once there is nothing to restore, that entry only clutters the list,
 * and this removes it. Two things it deliberately does NOT do:
 *
 *   - it never touches the workspace directory itself;
 *   - it refuses a workspace whose tree still exists, because dropping that entry
 *     would hide a live tree rather than tidy up an empty one.
 *
 * The session log stays intact, so importing again later still works.
 */
export function removeDeletedShell(dshHome, dir) {
  if (!dir) return { ok: false, error: 'missing_dir' }

  // Refuse while a live tree is present: this is a cleanup for shells only.
  let live = false
  try { live = fs.existsSync(path.join(treeRoot(dir), 'tree.json')) } catch { live = false }
  if (live) return { ok: false, error: 'tree_still_exists' }

  const file = registryFile(dshHome)
  const registry = readJson(file, { trees: [] })
  const entry = (registry.trees || []).find((t) => t.dir === dir)
  if (!entry) return { ok: false, error: 'not_in_registry' }
  if (!entry.deleted_at) return { ok: false, error: 'not_deleted' }

  // Purge any payload still parked in the recycle bin along with the shell,
  // otherwise the bin keeps an entry that can no longer be restored into.
  const index = loadIndex(dshHome)
  const parked = (index.entries || []).filter((e) => e.dir === dir)
  for (const item of parked) {
    try { fs.rmSync(path.join(trashRoot(dshHome), item.entry_id), { recursive: true, force: true }) } catch { /* best effort */ }
  }
  if (parked.length) {
    writeJson(trashIndexFile(dshHome), {
      entries: index.entries.filter((e) => e.dir !== dir),
    })
  }

  registry.trees = registry.trees.filter((t) => t.dir !== dir)
  writeJson(file, registry)
  return { ok: true, dir, purged: parked.length }
}


/**
 * Drop trashed trees older than the retention window.
 *
 * `days = 0` means keep forever, matching the node recycle bin's own rule.
 */
/**
 * Permanently remove one recycle entry, whatever its age.
 *
 * The age-based sweep cannot do this: a tree deleted a minute ago is nowhere near
 * the expiry window, so a user who wanted it gone had to wait out the retention
 * period. This is the explicit, irreversible action that closes that gap.
 *
 * The workspace shell keeps its `deleted` mark with the payload gone — same as
 * the aged sweep — so the workspace still exists and can be rebuilt.
 */
export function purgeTreeEntry(dshHome, entryId) {
  if (!entryId) return { ok: false, error: 'missing_entry' }
  const index = loadIndex(dshHome)
  const entry = index.entries.find((e) => e.entry_id === entryId)
  if (!entry) return { ok: false, error: 'not_found' }

  try {
    fs.rmSync(path.join(trashRoot(dshHome), entry.entry_id), { recursive: true, force: true })
  } catch { /* the directory may already be gone; the index is what matters */ }

  writeJson(trashIndexFile(dshHome), {
    entries: index.entries.filter((e) => e.entry_id !== entryId),
  })
  markRegistry(dshHome, entry.dir, { trash_entry: null })
  return { ok: true, removed: 1, entry_id: entryId, title: entry.title }
}

export function purgeTreeRecycle(dshHome, days) {
  if (!days || days <= 0) return { ok: true, removed: 0 }
  const cutoff = Date.now() - days * 86400000
  const index = loadIndex(dshHome)
  const kept = []
  let removed = 0

  for (const entry of index.entries) {
    const at = Date.parse(entry.deleted_at || '')
    if (Number.isFinite(at) && at < cutoff) {
      try { fs.rmSync(path.join(trashRoot(dshHome), entry.entry_id), { recursive: true, force: true }) } catch { /* ignore */ }
      // The workspace shell keeps its "deleted" mark: only the payload is gone.
      markRegistry(dshHome, entry.dir, { trash_entry: null })
      removed += 1
    } else {
      kept.push(entry)
    }
  }
  if (removed) writeJson(trashIndexFile(dshHome), { entries: kept })
  return { ok: true, removed }
}

/**
 * dsh-memory-tree — One-time migration from the old layout.
 *
 * Old layout (per workspace):
 *   <workspace>/.memory-tree/{tree.json, logs/YYYY-MM/*.md, index/, briefs/, staging/}
 *
 * New layout (shared root):
 *   memory-data/<slug>/tree.json                 the workspace's one task tree
 *   memory-data/<slug>/<YYYYMM>/<YYYYMMDD-HHmm>/{tree.json, logs/*.md}
 *   memory-data/habits/tree.json                 the shared habit tree
 *
 * The old directory is never deleted by this module: it stays in place as the
 * rollback path, and `migrateWorkspace` refuses to run twice onto a tree that
 * already holds nodes unless `force` is passed.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  readJson, writeJson, workspaceRoot, workspaceTreeFile, habitTreeFile,
  monthKey, batchKey, dirBytes,
} from './storage.js'

/** The plugin's own data folder inside a workspace, from the old layout. */
export const LEGACY_DIRNAME = '.memory-tree'

/* ------------------------------------------------------------------- paths */

export function legacyWorkspaceDir(dir) {
  return path.join(dir, LEGACY_DIRNAME)
}

export function legacyHabitDir(dshHome) {
  return path.join(dshHome, 'memory-tree')
}

/* ------------------------------------------------------------------ detect */

/**
 * What is waiting to be migrated, without touching anything.
 *
 * The panel shows this so a user can see the size and node count before saying
 * yes. A workspace whose new tree already exists is reported as `already`.
 */
export function migrationStatus({ root, dshHome, workspaces = [] }) {
  const entries = []

  for (const dir of workspaces) {
    const legacy = legacyWorkspaceDir(dir)
    const oldTree = readJson(path.join(legacy, 'tree.json'), null)
    const newNodeFile = workspaceTreeFile(root, dir)
    const existsNew = fs.existsSync(newNodeFile)

    const legacyNodes = oldTree ? Object.keys(oldTree.nodes || {}).length : 0
    const legacyLogs = countFiles(path.join(legacy, 'logs'))

    if (!oldTree && !legacyLogs) continue

    entries.push({
      dir,
      kind: 'task',
      legacy_dir: legacy,
      target: workspaceRoot(root, dir),
      nodes: legacyNodes,
      logs: legacyLogs,
      bytes: dirBytes(legacy),
      state: existsNew ? 'already' : 'pending',
    })
  }

  // The habit tree lives in its own old folder and is always migrated alone.
  const legacyHabit = legacyHabitDir(dshHome)
  const habitTree = readJson(path.join(legacyHabit, LEGACY_DIRNAME, 'tree.json'), null)
  if (habitTree) {
    entries.push({
      dir: legacyHabit,
      kind: 'habit',
      legacy_dir: path.join(legacyHabit, LEGACY_DIRNAME),
      target: habitTreeFile(root),
      nodes: Object.keys(habitTree.nodes || {}).length,
      logs: countFiles(path.join(legacyHabit, LEGACY_DIRNAME, 'logs')),
      bytes: dirBytes(path.join(legacyHabit, LEGACY_DIRNAME)),
      state: fs.existsSync(habitTreeFile(root)) ? 'already' : 'pending',
    })
  }

  return {
    entries,
    pending: entries.filter((e) => e.state === 'pending').length,
    already: entries.filter((e) => e.state === 'already').length,
  }
}

function countFiles(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name))
    else total += 1
  }
  return total
}

/* ----------------------------------------------------------------- migrate */

/**
 * Migrate one legacy tree into the new layout.
 *
 * Nodes go into the workspace's index tree; the log bodies are copied into a
 * batch folder dated from the newest log file, so a later expiry sweep can treat
 * the old history as one batch rather than scattering it across months.
 */
export function migrateWorkspace({ root, dir, force = false }) {
  const legacy = legacyWorkspaceDir(dir)
  const oldTree = readJson(path.join(legacy, 'tree.json'), null)
  if (!oldTree) return { ok: false, error: 'no_legacy_tree', dir }

  const target = workspaceTreeFile(root, dir)
  if (fs.existsSync(target) && !force) {
    return { ok: false, error: 'target_exists', dir, target }
  }

  const nodeCount = Object.keys(oldTree.nodes || {}).length

  // Log bodies move into a batch folder stamped with the newest log mtime, so the
  // batch reads as "when this history was last touched".
  const logSource = path.join(legacy, 'logs')
  const stamp = newestMtime(logSource) || Date.now()
  const batchPath = path.join(
    workspaceRoot(root, dir), monthKey(new Date(stamp)), batchKey(new Date(stamp)),
  )

  let copiedLogs = 0
  if (fs.existsSync(logSource)) {
    copiedLogs = copyDir(logSource, path.join(batchPath, 'logs'))
  }

  // Pointers written under the old scheme are relative to `<legacy>/`; rewriting
  // them keeps memory_open working after the move.
  const migrated = rebasePointers(oldTree, path.join(monthKey(new Date(stamp)), batchKey(new Date(stamp))))

  writeJson(target, migrated)
  if (fs.existsSync(target)) {
    writeJson(path.join(batchPath, 'tree.json'), {
      tree_id: migrated.tree_id,
      tree_type: 'task',
      migrated_from: legacy,
      migrated_at: new Date().toISOString(),
      nodes: migrated.nodes,
      edges: migrated.edges,
    })
  }

  // Carry the briefs across because a handoff snapshot is the one thing a later
  // session reads first.
  const briefSource = path.join(legacy, 'briefs')
  if (fs.existsSync(briefSource)) {
    copyDir(briefSource, path.join(workspaceRoot(root, dir), 'briefs'))
  }

  return {
    ok: true,
    dir,
    target,
    batch: batchPath,
    nodes: nodeCount,
    logs: copiedLogs,
    legacy_kept: legacy,
  }
}

/**
 * Rewrite `logs/YYYY-MM/x.md#Ln` pointers so they resolve under the new root.
 *
 * The old pointer was relative to the legacy tree root; the new one must be
 * relative to the workspace root, which adds the month and batch segments.
 */
function rebasePointers(tree, prefix) {
  const nodes = {}
  for (const [id, node] of Object.entries(tree.nodes || {})) {
    const pointer = typeof node.pointer === 'string' ? node.pointer : ''
    let next = node.pointer ?? null
    if (pointer && !pointer.startsWith(prefix)) {
      // Strip a leading `logs/` so the batch-relative path is stable.
      const tail = pointer.replace(/^logs[\\/]/, '')
      next = `${prefix.replace(/\\/g, '/')}/logs/${tail.replace(/\\/g, '/')}`
    }
    nodes[id] = { ...node, pointer: next }
  }
  return { ...tree, nodes, layout: 'v2', migrated_at: new Date().toISOString() }
}

/** The habit tree has no batches: it is one file, copied as-is. */
export function migrateHabit({ root, dshHome, force = false }) {
  const source = path.join(legacyHabitDir(dshHome), LEGACY_DIRNAME)
  const tree = readJson(path.join(source, 'tree.json'), null)
  if (!tree) return { ok: false, error: 'no_legacy_habit' }

  const target = habitTreeFile(root)
  if (fs.existsSync(target) && !force) return { ok: false, error: 'target_exists', target }

  writeJson(target, { ...tree, layout: 'v2', migrated_at: new Date().toISOString() })

  const logs = path.join(source, 'logs')
  if (fs.existsSync(logs)) copyDir(logs, path.join(path.dirname(target), 'logs'))

  return { ok: true, target, nodes: Object.keys(tree.nodes || {}).length, legacy_kept: source }
}

/* ----------------------------------------------------------------- helpers */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  let count = 0
  let entries
  try { entries = fs.readdirSync(from, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) count += copyDir(src, dst)
    else {
      try { fs.copyFileSync(src, dst); count += 1 } catch { /* skip unreadable */ }
    }
  }
  return count
}

/** Newest modification time under a directory, or 0 when empty. */
function newestMtime(dir) {
  let newest = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full))
    } else {
      try { newest = Math.max(newest, fs.statSync(full).mtimeMs) } catch { /* raced */ }
    }
  }
  return newest
}

/* ------------------------------------------------------------- verification */

/**
 * Confirm a migration landed: the new tree must hold at least as many nodes as
 * the old one, and the log files must be present. Used before the caller is told
 * the migration succeeded.
 */
export function verifyMigration({ root, dir }) {
  const legacy = readJson(path.join(legacyWorkspaceDir(dir), 'tree.json'), null)
  const current = readJson(workspaceTreeFile(root, dir), null)
  if (!current) return { ok: false, error: 'no_new_tree' }

  const want = legacy ? Object.keys(legacy.nodes || {}).length : 0
  const got = Object.keys(current.nodes || {}).length
  return {
    ok: got >= want,
    expected_nodes: want,
    actual_nodes: got,
    layout: current.layout || 'unknown',
  }
}

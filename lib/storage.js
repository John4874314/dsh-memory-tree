/**
 * dsh-memory-tree — Storage layout.
 *
 * One root holds every tree this plugin owns:
 *
 *   memory-data/
 *     <workspace-slug>/
 *       tree.json                 this workspace's single task tree (index)
 *       202611/                   one folder per month, named YYYYMM
 *         20261117-1903/          one folder per memory batch, named YYYYMMDD-HHmm
 *           tree.json             the nodes captured in that batch
 *           logs/*.md             the source text behind those nodes
 *     habits/
 *       tree.json                 the one habit tree shared by every workspace
 *
 * The month folder and the batch folder both exist because they answer different
 * questions: the month is how a human browses, the batch is what a forgetting
 * curve expires or what a lock protects.
 *
 * A directory name cannot contain `:` on Windows, so a batch is `1903`, not
 * `19:03`. The wall-clock minute is implied by the position.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** The default root when the user has not chosen one. */
export const DEFAULT_ROOT_NAME = 'memory-data'

/** Separator that makes a batch folder sortable and human readable. */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** `20261117-1903` — a batch folder name. */
export function batchKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}${m}${day}-${hh}${mm}`
}

/** Parse a batch folder name back into a Date, or null when it is not one. */
export function parseBatchKey(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(name || ''))
  if (!m) return null
  const [, y, mo, d, hh, mi] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * A filesystem-safe slug for a workspace path.
 *
 * Two different directories must never collide, so the readable stem is paired
 * with a short hash of the absolute path. Case is folded in BOTH parts: Windows
 * treats `Foo` and `foo` as the same directory, and a slug that differed only by
 * case would silently become a second tree for one workspace.
 */
export function workspaceSlug(dir) {
  const abs = path.resolve(String(dir || ''))
  const folded = abs.toLowerCase()
  const stem = path.basename(folded).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const digest = crypto.createHash('sha1').update(folded).digest('hex').slice(0, 8)
  return `${stem}-${digest}`
}

/* --------------------------------------------------------------------- root */

/**
 * Resolve the storage root.
 *
 * `configured` comes from the tree config; when it is empty the default sits
 * beside the plugin's own data inside DSH home, so a user who never chooses a
 * location still has one predictable place.
 */
export function resolveRoot(configured, dshHome) {
  const value = String(configured || '').trim()
  if (value) return path.resolve(value)
  return path.join(dshHome, DEFAULT_ROOT_NAME)
}

/** `memory-data/<slug>/` */
export function workspaceRoot(root, dir) {
  return path.join(root, workspaceSlug(dir))
}

/** `memory-data/<slug>/tree.json` */
export function workspaceTreeFile(root, dir) {
  return path.join(workspaceRoot(root, dir), 'tree.json')
}

/** `memory-data/<slug>/<YYYYMM>/` */
export function monthDir(root, dir, d = new Date()) {
  return path.join(workspaceRoot(root, dir), monthKey(d))
}

/** `memory-data/<slug>/<YYYYMM>/<YYYYMMDD-HHmm>/` */
export function batchDir(root, dir, d = new Date()) {
  return path.join(monthDir(root, dir, d), batchKey(d))
}

/**
 * The shared habit tree lives outside any workspace folder.
 *
 * This has to agree with `engine.treeRoot(habitHostDir)`:
 *
 *   legacy layout -> `<habitHostDir>/.memory-tree`
 *   v2 layout     -> `<root>/habits`
 *
 * It used to hard-code only the v2 answer, so on a legacy install every preference
 * written through `grow` was stored in `.memory-tree` while `habitSnapshot` looked
 * under `habits` — the habit tree read back empty no matter what was in it.
 *
 * `root` here is the habit host directory (`$DSH_HOME/memory-tree`), same argument
 * the engine takes, so the two produce the same path.
 */
export function habitRoot(root) {
  // Match the engine: a v2 root has `habits` inside the data root; a host that is
  // itself named `memory-tree` keeps the legacy `.memory-tree` beside it.
  const v2 = path.join(root, 'habits')
  const legacy = path.join(root, '.memory-tree')
  if (fs.existsSync(v2)) return v2
  if (fs.existsSync(legacy)) return legacy
  return v2
}

export function habitTreeFile(root) {
  return path.join(habitRoot(root), 'tree.json')
}

/* ------------------------------------------------------------ json helpers */

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/** Write through a temp file so an interrupted save cannot truncate the tree. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/* ------------------------------------------------------------------ listing */

/**
 * Every batch folder for one workspace, newest first.
 *
 * The returned names are what a forgetting curve expires and what a lock
 * protects, so a caller never has to scan directories itself.
 */
export function listBatches(root, dir) {
  const base = workspaceRoot(root, dir)
  let months
  try { months = fs.readdirSync(base, { withFileTypes: true }) } catch { return [] }

  const out = []
  for (const month of months) {
    if (!month.isDirectory() || !/^\d{6}$/.test(month.name)) continue
    const monthPath = path.join(base, month.name)
    let batches
    try { batches = fs.readdirSync(monthPath, { withFileTypes: true }) } catch { continue }
    for (const batch of batches) {
      if (!batch.isDirectory()) continue
      const when = parseBatchKey(batch.name)
      if (!when) continue
      const full = path.join(monthPath, batch.name)
      out.push({
        name: batch.name,
        month: month.name,
        path: full,
        at: when.getTime(),
        bytes: dirBytes(full),
      })
    }
  }
  out.sort((a, b) => b.at - a.at)
  return out
}

/** Total bytes of a directory tree, tolerating a vanished entry. */
export function dirBytes(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(full)
    else {
      try { total += fs.statSync(full).size } catch { /* raced away */ }
    }
  }
  return total
}

/** Bytes a whole workspace tree occupies on disk. */
export function workspaceBytes(root, dir) {
  return dirBytes(workspaceRoot(root, dir))
}

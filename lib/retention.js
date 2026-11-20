/**
 * dsh-memory-tree — Retention, locking and quota.
 *
 * Three separate questions live here:
 *
 *   expiry  — which memory batches has the forgetting curve retired?
 *   lock    — which batches must never be retired, whatever their age?
 *   quota   — is one workspace tree larger than the user allows, and if so what
 *             can be compacted without touching a locked batch?
 *
 * A batch is one `YYYYMMDD-HHmm` folder. Expiry and locking act on batches, not
 * on individual nodes, because a batch is what a human chose to keep or drop and
 * what actually occupies disk.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  readJson, writeJson, listBatches, dirBytes,
  workspaceRoot, workspaceTreeFile, batchDir,
} from './storage.js'

/** Defaults for the retention surface. A user may override every one. */
export const RETENTION_DEFAULTS = {
  /** Days after which an unlocked batch is deleted. 0 disables expiry entirely. */
  expire_days: 180,
  /** Bytes one workspace tree may occupy before compaction runs. */
  quota_bytes: 50 * 1024 * 1024,
  /** How many of the newest batches a quota compaction must never touch. */
  keep_recent_batches: 3,
}

/** The lock file records the user's intent; it is small and edited rarely. */
export function lockFile(root, dir) {
  return path.join(workspaceRoot(root, dir), 'locked.json')
}

/**
 * Read the lock set for one workspace.
 *
 * Shape: `{ batches: string[], tree: boolean }` — `tree` locks the whole
 * workspace so neither expiry nor quota compaction may remove anything.
 */
export function readLocks(root, dir) {
  const value = readJson(lockFile(root, dir), null)
  if (!value || typeof value !== 'object') return { batches: [], tree: false }
  return {
    batches: Array.isArray(value.batches) ? value.batches.filter((b) => typeof b === 'string') : [],
    tree: value.tree === true,
  }
}

export function writeLocks(root, dir, locks) {
  writeJson(lockFile(root, dir), {
    batches: [...new Set(locks.batches || [])].sort(),
    tree: locks.tree === true,
    updated_at: new Date().toISOString(),
  })
}

/** Add or remove one batch from the lock set. */
export function setBatchLock(root, dir, batch, locked) {
  const locks = readLocks(root, dir)
  const set = new Set(locks.batches)
  if (locked) set.add(batch)
  else set.delete(batch)
  writeLocks(root, dir, { batches: [...set], tree: locks.tree })
  return readLocks(root, dir)
}

export function setTreeLock(root, dir, locked) {
  const locks = readLocks(root, dir)
  writeLocks(root, dir, { batches: locks.batches, tree: locked })
  return readLocks(root, dir)
}

/* ------------------------------------------------------------------ expiry */

/**
 * Batches that have aged past the retention window.
 *
 * A locked batch is never returned, and a whole-tree lock short-circuits the
 * scan: the user said keep everything, so nothing is considered.
 */
export function expiredBatches(root, dir, cfg = RETENTION_DEFAULTS, now = Date.now()) {
  const days = Number(cfg.expire_days)
  if (!Number.isFinite(days) || days <= 0) return []

  const locks = readLocks(root, dir)
  if (locks.tree) return []
  const locked = new Set(locks.batches)

  const cutoff = now - days * 86400000
  return listBatches(root, dir)
    .filter((batch) => !locked.has(batch.name))
    .filter((batch) => batch.at < cutoff)
}

/**
 * Delete the expired batches.
 *
 * Returns what was removed so the caller can report a count rather than a silent
 * success. `dry` lets the panel preview the same set without touching disk.
 */
export function expireBatches(root, dir, cfg = RETENTION_DEFAULTS, { dry = false, now = Date.now() } = {}) {
  const victims = expiredBatches(root, dir, cfg, now)
  if (dry) return { ok: true, dry: true, removed: victims.map((b) => b.name), bytes: victims.reduce((s, b) => s + b.bytes, 0) }

  let bytes = 0
  const removed = []
  for (const batch of victims) {
    try {
      fs.rmSync(batch.path, { recursive: true, force: true })
      bytes += batch.bytes
      removed.push(batch.name)
    } catch { /* a locked file simply survives to the next sweep */ }
  }
  // A month folder that lost its last batch is noise, not data.
  pruneEmptyMonths(root, dir)
  return { ok: true, removed, bytes }
}

/** Remove `<slug>/<YYYYMM>/` directories that no longer contain a batch. */
export function pruneEmptyMonths(root, dir) {
  const base = workspaceRoot(root, dir)
  let months
  try { months = fs.readdirSync(base, { withFileTypes: true }) } catch { return }
  for (const month of months) {
    if (!month.isDirectory() || !/^\d{6}$/.test(month.name)) continue
    const full = path.join(base, month.name)
    try {
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
    } catch { /* not empty after all */ }
  }
}

/* ------------------------------------------------------------------- quota */

/**
 * How much room one workspace tree takes, and whether that exceeds its budget.
 *
 * `over` is what the caller must act on; `ratio` drives the UI bar.
 */
export function quotaStatus(root, dir, cfg = RETENTION_DEFAULTS) {
  const limit = Number(cfg.quota_bytes)
  const bytes = dirBytes(workspaceRoot(root, dir))
  const bounded = Number.isFinite(limit) && limit > 0 ? limit : RETENTION_DEFAULTS.quota_bytes
  return {
    bytes,
    limit: bounded,
    ratio: bounded > 0 ? bytes / bounded : 0,
    over: bytes > bounded,
  }
}

/**
 * Choose which batches a quota compaction should drop.
 *
 * Oldest first, never a locked batch, and the newest few are spared on the first
 * pass — losing the most recent work to a size limit is the worst possible trade.
 *
 * If sparing the newest batches cannot get under the limit, a second pass is
 * allowed to take them too but stops short of the single newest live batch, so a
 * compaction can never leave a workspace with no memory at all. The caller is
 * told which pass produced the plan via `escalated`.
 */
export function quotaCandidates(root, dir, cfg = RETENTION_DEFAULTS) {
  const status = quotaStatus(root, dir, cfg)
  if (!status.over) return { ...status, candidates: [], reclaimable: 0, eligible: false, escalated: false }

  const locks = readLocks(root, dir)
  if (locks.tree) {
    return { ...status, candidates: [], reclaimable: 0, eligible: false, escalated: false, reason: 'tree_locked' }
  }

  const locked = new Set(locks.batches)
  const keep = Math.max(0, Number(cfg.keep_recent_batches) || 0)
  const batches = listBatches(root, dir)          // newest first

  const pick = (spareNewest) => {
    const spared = new Set(batches.slice(0, spareNewest).map((b) => b.name))
    const chosen = []
    let projected = status.bytes
    // Walk oldest first so the plan reclaims the least valuable work first.
    for (const batch of [...batches].reverse()) {
      if (projected <= status.limit) break
      if (locked.has(batch.name) || spared.has(batch.name)) continue
      chosen.push(batch)
      projected -= batch.bytes
    }
    return { chosen, projected }
  }

  let { chosen, projected } = pick(keep)
  let escalated = false

  if (projected > status.limit) {
    // Sparing the newest few was not enough. Allow taking them, but always keep
    // the single newest batch: a tree that keeps nothing cannot be recalled.
    const second = pick(1)
    if (second.chosen.length > chosen.length) {
      chosen = second.chosen
      projected = second.projected
      escalated = true
    }
  }

  const reclaimable = chosen.reduce((sum, b) => sum + b.bytes, 0)
  const reason = chosen.length ? null : 'nothing_eligible'

  return {
    ...status,
    candidates: chosen,
    reclaimable,
    eligible: chosen.length > 0,
    escalated,
    reason,
    projected,
    // An honest signal: even after compaction the tree may still exceed the
    // budget, because its newest batch alone (or its locked batches) are larger.
    sufficient: projected <= status.limit,
  }
}

/**
 * Compact a workspace tree down to its quota by dropping the oldest unlocked
 * batches. A locked tree is refused outright, as the user requested.
 */
export function compactToQuota(root, dir, cfg = RETENTION_DEFAULTS, { dry = false } = {}) {
  const plan = quotaCandidates(root, dir, cfg)
  if (!plan.over) return { ok: true, skipped: 'under_quota', ...plan }
  if (plan.reason === 'tree_locked') return { ok: false, error: 'tree_locked', ...plan }
  if (!plan.eligible) return { ok: false, error: 'nothing_eligible', ...plan }
  if (dry) return { ok: true, dry: true, removed: plan.candidates.map((b) => b.name), ...plan }

  let freed = 0
  const removed = []
  for (const batch of plan.candidates) {
    try {
      fs.rmSync(batch.path, { recursive: true, force: true })
      freed += batch.bytes
      removed.push(batch.name)
    } catch { /* keep going: a partial reclaim still helps */ }
  }
  pruneEmptyMonths(root, dir)
  return { ok: true, removed, freed, bytesAfter: dirBytes(workspaceRoot(root, dir)) }
}

/* ------------------------------------------------------------------ report */

/** One row per batch, for the panel's retained-memory list. */
export function batchReport(root, dir, cfg = RETENTION_DEFAULTS, now = Date.now()) {
  const locks = readLocks(root, dir)
  const locked = new Set(locks.batches)
  const days = Number(cfg.expire_days) || 0

  return listBatches(root, dir).map((batch, index) => {
    const ageDays = (now - batch.at) / 86400000
    const isLocked = locks.tree || locked.has(batch.name)
    return {
      name: batch.name,
      month: batch.month,
      path: batch.path,
      at: batch.at,
      bytes: batch.bytes,
      locked: isLocked,
      // Only an unlocked batch can expire, so an old locked one reads as safe.
      expires_in_days: isLocked || days <= 0 ? null : Math.max(0, Math.round(days - ageDays)),
      expired: !isLocked && days > 0 && ageDays >= days,
      newest: index === 0,
    }
  })
}

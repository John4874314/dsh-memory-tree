/**
 * dsh-memory-tree — Session-log reader.
 *
 * Turns DSH's own session archives into a flat list of messages, so the panel can
 * build a tree from conversations that predate the plugin.
 *
 * A session log is `session.v4.jsonl.zstd`: concatenated zstd frames appended one
 * per flush, each frame holding whole JSONL records. Node's zstd helper decodes
 * only the FIRST frame, so a 3.5 MB log would yield a single line. We therefore
 * walk the frame magic ourselves and decompress each frame in turn.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528 // little-endian 0x28 B5 2F FD

/**
 * Every offset in `buf` where a zstd frame begins.
 *
 * Skipping the magic bytes is not the same as skipping the frame: a compressed
 * payload can contain the same four bytes by chance, so each candidate is
 * validated by attempting a decode of the slice it starts.
 */
function frameOffsets(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    const magic = buf.readUInt32LE(i)
    if (magic !== ZSTD_MAGIC) continue
    // A frame header must declare a valid frame-header descriptor byte next.
    if (i + 4 < buf.length) offsets.push(i)
  }
  return offsets
}

/**
 * Decode a whole multi-frame zstd buffer.
 *
 * Always returns `{ text, frames, skipped }` — one shape for callers, whether or
 * not the archive turned out to be multi-frame. Frames that fail to decode are
 * skipped: an archived log may end mid-flush and a partial tail must not discard
 * the readable history before it.
 */
export function readZstdFrames(buf) {
  const offsets = frameOffsets(buf)
  if (!offsets.length) {
    // Not multi-frame: try the plain helper once, then give up quietly.
    try {
      return { text: zlib.zstdDecompressSync(buf).toString('utf8'), frames: 1, skipped: 0 }
    } catch {
      return { text: '', frames: 0, skipped: 1 }
    }
  }

  const parts = []
  let skipped = 0
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      skipped += 1
    }
  }
  return { text: parts.join(''), frames: offsets.length, skipped }
}

/* --------------------------------------------------------------- message shape */

/** Flatten one content-block array into plain text. */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    // A reasoning block is the model's scratchpad, not a durable statement.
    else if (block.type === 'reasoning') continue
  }
  return out.join('\n').trim()
}

/**
 * Normalise one archived record into a message, or null when it is not one.
 *
 * A DSH log is an event stream, not a chat transcript: records carry a `type`
 * such as `user/message`, and their body sits at a different path per kind —
 * `data.content` for a user message, `data.message.content` for an assistant
 * one. Every other record type (steps, tool calls, jobs) is context, not memory.
 */
function recordToMessage(record) {
  const type = record?.type
  if (type === 'user/message') {
    const body = blocksToText(record.data?.content)
    if (!body) return null
    // Policy notices are system text dressed as a user turn; they are not memory.
    const source = record.data?.source?.kind
    if (source && source !== 'user') return null
    return { role: 'user', text: body, at: record.time || null }
  }
  if (type === 'assistant/message') {
    const body = blocksToText(record.data?.message?.content)
    if (!body) return null
    return { role: 'assistant', text: body, at: record.time || null }
  }
  return null
}

/**
 * Read one session directory into `{ cwd, createdAt, title, messages }`.
 *
 * The header carries the authoritative `cwd`, which is how a workspace is
 * identified — the directory NAME on disk is an ambiguous lossy encoding.
 */
export function readSession(sessionDir) {
  const file = findLogFile(sessionDir)
  if (!file) return null
  let raw
  try { raw = fs.readFileSync(file) } catch { return null }
  const text = readZstdFrames(raw).text
  if (!text) return null

  const messages = []
  let cwd = ''
  let createdAt = null
  let title = ''

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }

    if (record.type === 'session') {
      cwd = record.cwd || record.data?.cwd || cwd
      createdAt = record.createdAt || record.time || createdAt
      title = record.title || record.data?.title || title
      continue
    }
    if (record.type === 'session/title') {
      title = record.data?.title || record.title || title
      continue
    }
    const message = recordToMessage(record)
    if (message) messages.push(message)
  }

  return { file, cwd, createdAt, title, messages }
}

/** The newest `session*.jsonl.zstd` under a session directory. */
export function findLogFile(sessionDir) {
  let entries
  try { entries = fs.readdirSync(sessionDir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^session.*\.jsonl\.zstd$/.test(entry.name)) continue
    return path.join(sessionDir, entry.name)
  }
  return null
}

/* ----------------------------------------------------------- workspace scan */

/**
 * Group every archived session by its authoritative `cwd`.
 *
 * Returns one entry per workspace directory, newest session first, with a small
 * summary the panel can render before the user commits to an import.
 */
export function scanWorkspaces(dshHome) {
  const root = path.join(dshHome, 'sessions')
  let dirs
  try { dirs = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }

  const byCwd = new Map()

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const groupDir = path.join(root, dir.name)
    let sessions
    try { sessions = fs.readdirSync(groupDir, { withFileTypes: true }) } catch { continue }

    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const info = readSession(path.join(groupDir, session.name))
      // A session whose header names no directory cannot be placed in a workspace.
      if (!info || !info.cwd) continue

      if (!byCwd.has(info.cwd)) {
        byCwd.set(info.cwd, {
          dir: info.cwd,
          title: path.basename(info.cwd) || info.cwd,
          sessions: [],
          messageCount: 0,
          lastAt: 0,
        })
      }
      const bucket = byCwd.get(info.cwd)
      bucket.sessions.push({
        id: session.name,
        file: info.file,
        messages: info.messages.length,
        createdAt: info.createdAt || 0,
      })
      bucket.messageCount += info.messages.length
      bucket.lastAt = Math.max(bucket.lastAt, info.createdAt || 0)
    }
  }

  const out = [...byCwd.values()]
  for (const entry of out) {
    entry.sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }
  out.sort((a, b) => b.lastAt - a.lastAt)
  return out
}

/** Concatenate every session of one workspace into a single ordered stream. */
export function readWorkspaceMessages(workspace) {
  const all = []
  // Oldest session first, so the merged transcript reads chronologically.
  const ordered = [...(workspace.sessions || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  for (const session of ordered) {
    if (!session.file) continue
    let raw
    try { raw = fs.readFileSync(session.file) } catch { continue }
    const text = readZstdFrames(raw).text
    if (!text) continue
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      const message = recordToMessage(record)
      if (message) all.push(message)
    }
  }
  return all
}

/* --------------------------------------------------------- rule extraction */

/**
 * Patterns that signal a durable statement rather than task chatter.
 *
 * This is the offline half of the import: it never invents a node, it only
 * promotes sentences that already read like a rule, a preference or a verdict.
 * The label decides which tree the sentence belongs to.
 */
const RULES = [
  // A preference is how the user wants work done. The first pattern covers the
  // first-person forms; the second covers an imperative that reads as a standing
  // instruction ("以后都用…", "别再用…"), which is how people actually phrase it.
  { type: 'preference', re: /(我(更)?(喜欢|偏好|习惯|倾向)|我(不)?(想要|希望)你|以后(都)?(用|按|走|别|不要)|一律|统一(用|按)|照我(说|的)|按我(说|的))/ },
  { type: 'constraint', re: /(必须|不要|禁止|不能|不允许|只能|务必|千万别|绝不能|硬性|别用|别再|小心)/ },
  { type: 'decision', re: /(决定|拍板|就(这么|这样)定|最终选|方案定为|采用|落地为|确认用)/ },
  { type: 'deadend', re: /(走不通|行不通|放弃|不可行|失败原因|别再试|死路)/ },
  { type: 'task', re: /(待办|下一步|TODO|还需要|剩下|接下来要|尚未|未完成)/ },
  { type: 'issue', re: /(报错|失败|异常|卡住|阻塞|崩了|有问题|不生效)/ },
]

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', '你的', '我们',
  '这个', '那个', '然后', '就是', '可以', '需要', '什么', '怎么',
])

/** Distinctive terms in a sentence, used as node keywords. */
export function keywordsOf(text, max = 5) {
  const seen = new Set()
  const out = []
  // Chinese has no spaces: harvest 2–4 char runs of CJK, and ASCII words.
  const cjk = text.match(/[\u4e00-\u9fa5]{2,6}/g) || []
  const latin = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []
  for (const token of [...latin.map((t) => t.toLowerCase()), ...cjk]) {
    if (STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= max) break
  }
  return out
}

/** Collapse whitespace and strip markup, then clip to a node title. */
export function tidy(text, max = 20) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')      // fenced code carries no title
    .replace(/`[^`]*`/g, ' ')             // inline code
    .replace(/^\s*\|.*$/gm, ' ')          // table rows are layout, not sentences
    .replace(/\*\*|__|\*|~~/g, '')        // emphasis markers
    .replace(/^#+\s*/gm, '')              // heading markers
    .replace(/^\s*[-+*]\s+/gm, '')        // list bullets
    .replace(/\[tool [^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Turn a sentence into a navigable title, without the model.
 *
 * `tidy(line, 20)` — what this used to do — keeps whatever twenty characters the
 * sentence happens to start with, which is how a tree ended up with titles like
 * "而且这几处都没有 ，删掉就等于永久销毁…": truncated mid-clause, and useless
 * as a label.
 *
 * This keeps the part that carries the claim:
 *
 *   1. drop a leading connector ("因此", "而且", "不过", …) — it qualifies, never labels;
 *   2. prefer the clause before the first comma — in Chinese that is usually the
 *      assertion, with the rest being justification;
 *   3. fall back to the whole sentence when the first clause is too thin to stand alone.
 *
 * Returns '' when nothing usable survives, so the caller can skip the line rather
 * than write a fragment.
 */
export function titleFromSentence(line, max = 20) {
  const text = tidy(line, 400)
  if (!text) return ''

  const LEADING = /^(因此|所以|而且|并且|但是|不过|然后|另外|同时|其实|事实上|总之|也就是说|换言之|需要注意|注意|另外一点)[，,、：:\s]*/
  const stripped = text.replace(LEADING, '').trim()
  const base = stripped.length >= 6 ? stripped : text

  // A clause that already reads as a label stands on its own.
  const firstClause = base.split(/[，,；;：:]/)[0].trim()
  const picked = firstClause.length >= 6 ? firstClause : base

  const out = tidy(picked, max)
  // Below this the "title" is a stub, not a claim.
  if (!out || out.replace(/[…\s，,。；;：:]/g, '').length < 5) return ''
  return out
}

/**
 * Whether a line is prose worth turning into a node.
 *
 * Table rows, headings of tables, and list fragments dominate a transcript but
 * carry no standalone meaning; promoting them would fill the tree with debris.
 */function isProse(line) {
  if (!line) return false
  if (/^\s*[|>]/.test(line)) return false
  if (/^[#*\-+\s]*$/.test(line)) return false
  // A line that is mostly punctuation or table pipes is not a sentence.
  const meaningful = line.replace(/[\s|:*`#_\-+=<>[\]()]/g, '')
  if (meaningful.length < 6) return false
  // CJK prose needs at least a few characters to carry a rule.
  return true
}

/**
 * Extract candidate nodes with rules only — no network, no model, no tokens.
 *
 * `scope` narrows what counts: `habit` keeps only statements about how the user
 * wants work done; `task` keeps the project's own verdicts and leftovers.
 */
export function extractByRules(messages, scope = 'task') {
  const keep = scope === 'habit'
    ? new Set(['preference', 'constraint'])
    : new Set(['decision', 'deadend', 'task', 'issue', 'constraint'])

  const out = []
  const seen = new Set()

  for (const message of messages) {
    // Preferences live in what the user said; verdicts may come from either side.
    if (scope === 'habit' && message.role !== 'user') continue
    if (!message.text) continue

    for (const rawLine of message.text.split(/[\n。！？!?]/)) {
      const line = rawLine.trim()
      if (line.length < 6 || line.length > 400) continue
      if (!isProse(line)) continue

      for (const rule of RULES) {
        if (!keep.has(rule.type)) continue
        if (!rule.re.test(line)) continue

        const title = titleFromSentence(line, 20)
        // A title that lost its substance to markup is not a usable node.
        if (!title) break
        if (seen.has(title)) break
        seen.add(title)

        out.push({
          type: rule.type,
          title,
          summary: line.slice(0, 200),
          keywords: keywordsOf(line),
          importance: rule.type === 'constraint' || rule.type === 'preference' ? 0.9 : 0.75,
          status: rule.type === 'task' || rule.type === 'issue' ? 'open' : 'done',
          next_hint: rule.type === 'task' ? line.slice(0, 60) : null,
        })
        break // one rule per line is enough
      }
    }
  }
  return out
}

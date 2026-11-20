/**
 * dsh-memory-tree — the one place that talks to a model.
 *
 * Grouping a branch is the first feature that needs text generation, so the
 * plumbing lives here instead of being inlined in the route: resolve a call
 * under the current adapter registration, stream it, join the text blocks, and
 * degrade to `null` on any failure.
 *
 * Every caller treats `null` as "no answer" and keeps its existing shape. A
 * model that is missing, unreachable, or slow must never block a tree write —
 * an ungrouped tree is correct, just less tidy.
 */

/**
 * A cheap, small model is the right choice here: the task is "read twelve titles
 * and emit one JSON object". Selection is delegated to the caller so a user can
 * override it from settings without touching this file.
 */
export const GROUP_PURPOSE = 'memory-tree/group'

/**
 * Run one completion and return its text.
 *
 * Returns `null` rather than throwing: every caller has a correct behaviour
 * without a model, and an exception here would abort a grow that already
 * succeeded.
 */
export async function completeText(llm, {
  provider,
  model,
  system,
  prompt,
  maxTokens = 700,
  temperature = 0.2,
  timeoutMs = 25000,
  signal: external,
  trace = {},
} = {}) {
  if (!llm || !provider || !model) return null

  try {
    const prepared = await llm.prepareCall({ provider, model })

    // `prepareCall` returns a one-shot handle, and DSH refuses to dispatch it
    // unless the options passed here compare EQUAL to the config it resolved:
    //
    //   if (!callConfigEquals(options, resolvedConfig)) throw INVALID_PREPARED_CALL
    //
    // `callConfigEquals` looks at provider/model/reasoningEffort/temperature/
    // maxTokens/stop. The adapter may have materialised defaults for any of those
    // (maxTokens is the common one), so hand-writing `{provider, model}` here
    // fails the equality check with "config changed before adapter dispatch".
    // Spreading `prepared.config` guarantees the two objects agree.
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    }]

    const chunks = prepared.stream({
      ...prepared.config,
      messages,
      system,
    })

    let text = ''
    let finishKind = null
    let chunkKinds = []

    for await (const chunk of chunks) {
      // Keep a short trace of what the stream actually delivered — an empty reply
      // is otherwise indistinguishable from a stream that never produced a block.
      if (chunkKinds.length < 8) chunkKinds.push(chunk?.type || '?')
      if (chunk?.type === 'text-delta') {
        text += chunk.text
        // Guard against a model that ignores the format and rambles: the JSON
        // answer fits comfortably, and past this we are paying for nothing.
        if (text.length > 8000) break
      } else if (chunk?.type === 'finish') {
        finishKind = chunk.reason?.kind || 'unknown'
        break
      }
    }

    const trimmed = text.trim()
    if (!trimmed) {
      // Surface why there was nothing, so the panel can say "the model replied
      // with nothing" instead of blaming the format.
      trace.emptyReply = { finish: finishKind, chunks: chunkKinds }
      return null
    }
    return trimmed
  } catch (error) {
    trace.error = String(error?.message || error)
    return null
  }
}

/**
 * Pick the provider/model to use for background work.
 *
 * `preferred` wins when it names a route that actually exists. Otherwise the
 * first provider with any model is taken — grouping is a nicety, so any working
 * route beats failing the feature.
 */
/**
 * Resolve which route does the work.
 *
 * Order of preference:
 *
 *   1. An explicit `preferred` route the user pinned in settings.
 *   2. The route the current session is already using (`session`), so "automatic"
 *      means "the model I am talking to" rather than a stranger picked from
 *      whatever the provider list happened to return first.
 *   3. The first provider that has any model — the old behaviour, kept only as a
 *      last resort for callers with no session context.
 *
 * `session` is `{ provider, model }` or null. A stale value (provider gone, model
 * removed) falls through to the next step instead of failing the whole call.
 */
export async function pickModel(llm, preferred = {}, session = null) {
  if (!llm) return null
  try {
    const providers = llm.listProviders?.() || []
    if (!providers.length) return null

    const byId = new Map(providers.map((p) => [p.id, p]))

    // (1) The user's pinned route, if it still exists.
    if (preferred.provider && byId.has(preferred.provider)) {
      const models = await llm.listModels(preferred.provider)
      const wanted = models.find((m) => m.id === preferred.model)
      if (wanted) return { provider: preferred.provider, model: wanted.id }
      // A stale model id with a live provider: use that provider's first model
      // rather than discarding the user's provider choice.
      if (models.length) return { provider: preferred.provider, model: models[0].id }
    }

    // (2) Follow the session.
    if (session?.provider && session?.model && byId.has(session.provider)) {
      try {
        const models = await llm.listModels(session.provider)
        if (models.some((m) => m.id === session.model)) {
          return { provider: session.provider, model: session.model }
        }
      } catch { /* fall through to the generic pick */ }
    }

    // (3) Last resort: first provider that answers with a model.
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        if (models.length) return { provider: provider.id, model: models[0].id }
      } catch { /* try the next provider */ }
    }
    return null
  } catch {
    return null
  }
}

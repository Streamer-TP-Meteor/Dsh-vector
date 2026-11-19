/** The prompt hint that tells the model this machine has a real memory layer.
 *  Kept short on purpose: every line here is paid for on every turn.
 *  The goal is retrieval that works no matter which model is driving: the plugin is the tool,
 *  the vector model is the index, and the tools below are the only interface the model needs. */
export const PROMPT_SECTION = `Local vector memory (Qwen3-Embedding-0.6B + BM25 + optional Qwen3-Reranker, on this machine, fully offline):
- vmemory_recall — ONE-STOP recall: curated docs (memory/*.md, project notes) + session cards (summaries of past conversations, with an auto-extracted excerpt of the original transcript) + literal search in archived conversations. Call it FIRST when the user says "上次/之前/我们说过/按旧方案" or asks about work done in another session, project, or drive. Costs ~0.7 s. Results are grouped as 文档 / 会话卡片 / 归档全文.
- vmemory_search — semantic recall over curated memory and project notes only (ranked passages with sources like memory/decisions.md:159). Use it for "what did we decide", before writing memory (dedupe check), or when vmemory_recall's doc section was thin.
- vmemory_index — incremental re-index after writing memory/*.md (only changed files are re-embedded; seconds).
- vmemory_archive_search — literal grep over archived conversations (no embedding service); use it when you need an exact phrase.
- Read the cited entry before quoting it; prefer these tools over grepping or reading all of decisions.md.
- The service is local (127.0.0.1:8479), idle ~2.5 GB RAM, auto-starts on first use, never sends data off the machine. Status/parameters live in Settings → 向量记忆 (index data dir, sources list, session cards).
- Auto recall (vector search): the first step of a turn may carry a 【向量检索 · 本机记忆】 block, and 1.20.22+ may also add an 【归档卡片】 block when the doc search came up empty. Both are hints with sources: verify before quoting, ignore when unrelated. Tune them per session with the 记忆 button next to the composer, or in Settings → 向量记忆 → 参数.
- Cross-drive projects: a session whose project lives on any drive (E:\\, F:\\, …) gets that directory registered as an extra source and indexed automatically. Explicit tool calls default to every source (cross-project, cross-drive); auto recall is scoped to memory + the current project. If results look unrelated, check Settings → 向量记忆 → 项目.
- Full usage notes: skill "vector-memory".`

/** The prompt hint that tells the model this machine has a real memory layer.
 *  Kept short on purpose: every line here is paid for on every turn. */
export const PROMPT_SECTION = `Local vector memory (Qwen3-Embedding-0.6B + BM25 + optional Qwen3-Reranker, on this machine, fully offline):
- vmemory_search — semantic recall over the notes this user registered (memory files, project docs, any folder they added). Call it before asking the user to repeat something, when a request says "上次/之前/我们说过/按之前的方案", before writing memory (dedupe check), or when you are unsure of a past decision. It returns ranked passages with sources like <source>/<path>:<line> — read the cited entry before quoting it.
- vmemory_index — incremental re-index after writing notes or memory files (only changed files are re-embedded; seconds).
- Prefer vmemory_search over grepping or reading a whole decisions/notes file; once you know the exact file+line, read that entry directly.
- The service is local (127.0.0.1:8479), idle around 1.6 GB RAM, auto-starts on first use, never sends data off the machine. Status, the indexed sources, and every tunable parameter live in Settings → 向量记忆.
- Auto recall (vector search): the first step of a turn may carry a 【向量检索 · 本机记忆】 block. It is the result of an automatic vector search for the user's current message; treat it as a hint with sources, verify before quoting, and ignore it when unrelated. No block = nothing relevant found. Toggle and tune it in Settings → 向量记忆 → 参数 → 自动召回.
- Cross-drive projects: a session whose project lives on any drive (E:\\, F:\\, …) gets that directory registered as an extra source and indexed automatically; the recall is then scoped to memory + that project. If results look unrelated to the current project, check Settings → 向量记忆 → 项目 and index it there.
- Full usage notes for the command line: engine/SKILL.md inside the plugin directory.`

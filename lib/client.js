/**
 * Vector memory — browser half.
 *
 * Contributes one settings section (`settings.section` id `vector-memory`,
 * order 25: right after the Agent presets and before the cost meter, because
 * this is a base layer and not an optional add-on).
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Every value is read from and written to
 * the plugin's own same-origin routes (/api/dsh-vector-memory/*), which are
 * backed by the same config.json the Python engine reads.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vector-memory',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useRef, useCallback } = React

    const API = '/api/dsh-vector-memory'
    const inject = ['slots']
    const VERSION_FALLBACK = '2.1.0'

    const C = {
      border: 'rgba(128,128,128,0.28)',
      soft: 'rgba(128,128,128,0.10)',
      softer: 'rgba(128,128,128,0.06)',
      muted: 'rgba(128,128,128,0.95)',
      accent: '#4f7cff',
      good: '#2ea36b',
      warn: '#c9822a',
      bad: '#c0504d',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 940, padding: '4px 2px 36px', fontSize: 13, lineHeight: 1.55 },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, border: `1px solid ${C.border}`, fontSize: 11, color: C.muted, whiteSpace: 'nowrap' },
      chipDot: color => ({ width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' }),
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' },
      tab: active => ({
        padding: '6px 12px',
        borderRadius: '6px 6px 0 0',
        border: `1px solid ${active ? C.border : 'transparent'}`,
        borderBottom: 'none',
        background: active ? C.soft : 'transparent',
        cursor: 'pointer',
        color: 'inherit',
        fontSize: 13,
      }),
      card: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
      cardTitle: { fontWeight: 600, fontSize: 14 },
      desc: { color: C.muted, fontSize: 12, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 },
      grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 170, flex: '1 1 170px' },
      label: { fontSize: 12, color: C.muted },
      input: { border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', background: 'transparent', color: 'inherit', fontSize: 13, width: '100%', boxSizing: 'border-box' },
      btn: (kind = 'normal', disabled = false) => ({
        border: `1px solid ${kind === 'primary' ? C.accent : kind === 'danger' ? C.bad : C.border}`,
        background: kind === 'primary' ? C.accent : 'transparent',
        color: kind === 'primary' ? '#fff' : kind === 'danger' ? C.bad : 'inherit',
        borderRadius: 6,
        padding: '4px 10px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12,
        opacity: disabled ? 0.5 : 1,
      }),
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      kv: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, borderBottom: `1px dashed ${C.border}`, padding: '3px 0' },
      kvLabel: { color: C.muted, fontSize: 12, whiteSpace: 'nowrap' },
      kvValue: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, wordBreak: 'break-all', textAlign: 'right' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11, color: C.muted, wordBreak: 'break-all' },
      item: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
      itemHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      snippet: { fontSize: 12, color: C.muted, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      notice: tone => ({
        border: `1px solid ${tone === 'error' ? C.bad : tone === 'warn' ? C.warn : C.border}`,
        background: C.softer,
        borderRadius: 8,
        padding: '7px 10px',
        fontSize: 12,
        color: tone === 'error' ? C.bad : 'inherit',
      }),
      badge: tone => ({
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 999,
        border: `1px solid ${tone === 'good' ? C.good : tone === 'warn' ? C.warn : C.border}`,
        color: tone === 'good' ? C.good : tone === 'warn' ? C.warn : C.muted,
      }),
      featureGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 },
      feature: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', background: C.softer },
      featureTitle: { fontSize: 12.5, fontWeight: 600, marginBottom: 2 },
      featureDesc: { fontSize: 11.5, color: C.muted, margin: 0 },
      footer: { color: C.muted, fontSize: 11.5, margin: 0 },
      jobLog: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11, color: C.muted, background: C.softer, borderRadius: 6, padding: '6px 8px', maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' },
    }

    let legacyMode = false

    async function apiOnce(base, path, { method, body }) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'x-vector-memory-client': 'vector-memory/1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let data = {}
      try {
        data = await response.json()
      } catch {
        data = {}
      }
      if (!response.ok || data.ok === false) {
        const error = new Error(data.error || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return data
    }

    async function api(path, { method = 'GET', body } = {}) {
      if (legacyMode) return apiOnce(`${API}-legacy`, path, { method, body })
      try {
        return await apiOnce(API, path, { method, body })
      } catch (error) {
        // 403/404 说明宿主没有放行认证通道路由；换兼容前缀再试一次，之后记住这个选择。
        const status = error && error.status
        if (status !== 403 && status !== 404 && status !== 405) throw error
        const data = await apiOnce(`${API}-legacy`, path, { method, body })
        legacyMode = true
        return data
      }
    }

    function fmtBytes(value) {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      if (value >= 1024) return `${Math.round(value / 1024)} KB`
      return `${value} B`
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const diff = Date.now() - date.getTime()
      if (diff >= 0 && diff < 60 * 1000) return '刚刚'
      if (diff >= 0 && diff < 60 * 60 * 1000) return `${Math.round(diff / 60000)} 分钟前`
      if (diff >= 0 && diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} 小时前`
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    function fmtMs(value) {
      if (!Number.isFinite(value)) return '—'
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
    }

    function Btn({ children, onClick, kind, disabled, style, title }) {
      return h('button', { type: 'button', title, onClick, disabled, style: { ...S.btn(kind, disabled), ...style } }, children)
    }

    function Chip({ children, tone, dot }) {
      return h('span', { style: S.chip },
        dot ? h('i', { style: S.chipDot(tone === 'good' ? C.good : tone === 'bad' ? C.bad : C.muted) }) : null,
        children,
      )
    }

    function Field({ label, hint, children }) {
      return h('div', { style: S.field },
        h('span', { style: S.label }, label),
        children,
        hint ? h('span', { style: { ...S.desc, fontSize: 11 } }, hint) : null,
      )
    }

    function TextInput({ value, onChange, placeholder }) {
      return h('input', { type: 'text', value: value ?? '', placeholder, spellCheck: false, onChange: event => onChange(event.target.value), style: S.input })
    }

    function NumberInput({ value, onChange, min, max, step }) {
      return h('input', {
        type: 'number',
        value: value ?? '',
        min,
        max,
        step: step || 1,
        onChange: event => onChange(event.target.value === '' ? '' : Number(event.target.value)),
        style: S.input,
      })
    }

    function Select({ value, onChange, options }) {
      return h('select', { value, onChange: event => onChange(event.target.value), style: S.input },
        options.map(option => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function Switch({ checked, onChange, label }) {
      return h('label', { style: { ...S.row, gap: 6, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange(event.target.checked) }),
        h('span', { style: { fontSize: 12 } }, label),
      )
    }

    function Notice({ children, tone }) {
      if (!children) return null
      return h('div', { style: S.notice(tone) }, children)
    }

    function Card({ title, desc, right, children }) {
      return h('section', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', null,
            h('div', { style: S.cardTitle }, title),
            desc ? h('p', { style: S.desc }, desc) : null),
          right || null),
        children,
      )
    }

    function KV({ label, value, tone }) {
      return h('div', { style: S.kv },
        h('span', { style: S.kvLabel }, label),
        h('span', { style: { ...S.kvValue, ...(tone === 'bad' ? { color: C.bad } : tone === 'good' ? { color: C.good } : {}) } }, value),
      )
    }

    const FEATURES = [
      { title: '语义检索', desc: '按意思找，不按关键词。中文问句直接命中历史决策。' },
      { title: '混合检索', desc: 'BM25（字+双字）与向量余弦各出一份结果，RRF 融合排序。' },
      { title: '可选重排', desc: 'Qwen3-Reranker 精排，默认关闭（CPU 上 6–15s/次）。' },
      { title: '增量索引', desc: '按文件 mtime + 内容哈希增量，向量缓存跨索引复用。' },
      { title: '向量检索', desc: '每回合第一步按当前提问自动取 top-3 记忆，作为向量检索提示放进本次请求，模型不用主动调工具。' },
      { title: '自动守护', desc: '启动预热量、定时增量索引、服务崩溃自动拉起。' },
      { title: '跨盘项目', desc: '会话开在哪个盘，就把那个目录登记为项目源，和记忆一起检索。' },
      { title: '离线私有', desc: '模型与索引全在本机，127.0.0.1 回环，不出网。' },
    ]

    function FeatureGrid() {
      return h('div', { style: S.featureGrid },
        FEATURES.map(item => h('div', { key: item.title, style: S.feature },
          h('div', { style: S.featureTitle }, item.title),
          h('p', { style: S.featureDesc }, item.desc))),
      )
    }

    function OverviewTab({ state }) {
      if (!state) return null
      const service = state.service || {}
      const index = state.index || {}
      const models = state.models || {}
      const disk = state.disk || {}
      const sup = state.supervisor || {}
      const rc = state.recall || {}
      const sources = Array.isArray(index.sources) ? index.sources : []
      const missing = []
      if (!state.capability?.engine) missing.push(`引擎脚本缺失：${state.plugin?.engine?.cli || ''}`)
      if (!state.capability?.embedModel) missing.push(`向量模型缺失：${models.embed?.path || ''}`)
      if (!state.capability?.python) missing.push(`Python 解释器不存在：${state.config?.python || ''}`)
      if (state.plugin?.configError) missing.push(`配置文件读取失败：${state.plugin.configError}`)

      return h(Fragment, null,
        missing.length ? h(Notice, { tone: 'error' }, h('div', { style: S.list }, missing.map(text => h('div', { key: text }, text)))) : null,
        h(Card, { title: '这是什么' },
          h('p', { style: S.desc },
            '本机的语义记忆底座：把 ', h('b', null, 'memory/'), '（用户画像、决策、知识、项目）和 ', h('b', null, 'harness-project/'),
            ' 的笔记向量化，AI 在回答前做精确检索，用真实历史减少幻觉和重复提问。全部模型与索引都在本机，不联网。'),
          h(FeatureGrid),
        ),
        h(Card, { title: '运行状态', desc: '服务是常驻的 Python 进程（127.0.0.1 回环），索引是本地文件。' },
          h('div', { style: S.grid2 },
            h('div', null,
              h(KV, { label: '服务', value: service.running ? `运行中 · ${service.url}` : `未运行 · ${service.url}`, tone: service.running ? 'good' : 'bad' }),
              h(KV, { label: 'embed 就绪', value: service.embed ? '是' : '否' }),
              h(KV, { label: '重排模型', value: service.rerank ? '已加载' : '未加载（按需）' }),
              h(KV, { label: '内存 RSS', value: service.rssMb == null ? '—' : `${Number(service.rssMb).toFixed(0)} MB` }),
              h(KV, { label: '累计调用', value: service.calls == null ? '—' : String(service.calls) }),
              h(KV, { label: '最近耗时', value: fmtMs(service.lastMs) }),
            ),
            h('div', null,
              h(KV, { label: '索引构建', value: fmtTime(index.builtAt) }),
              h(KV, { label: '文件 / 块', value: `${index.files ?? '?'} 个 / ${index.chunks ?? '?'} 块` }),
              h(KV, { label: '向量维度', value: index.dim == null ? '—' : String(index.dim) }),
              h(KV, { label: '构建耗时', value: index.seconds == null ? '—' : `${Number(index.seconds).toFixed(1)} s` }),
              h(KV, { label: '索引体积', value: fmtBytes(index.bytes) }),
              h(KV, { label: '数据目录剩余', value: disk.free?.free == null ? '—' : fmtBytes(disk.free.free) }),
            ),
          ),
          h('div', { style: { ...S.row, gap: 6 } },
            sources.map(source => h(Chip, { key: source.name, tone: source.exists ? 'good' : 'bad', dot: true },
              `${source.name} · ${source.files} 个 .md`)),
          ),
          index.builtAt ? null : h(Notice, { tone: 'warn' }, '还没有索引：去「维护」页点一次「立即增量索引」。'),
        ),
        h(Card, { title: '向量检索（自动召回）', desc: '每个回合开头，按当前提问自动检索相关记忆，以【向量检索 · 本机记忆】块作为运行时上下文随请求发送（会记进会话的运行时上下文，但不是普通对话消息；内容与上一步相同时不重复）。' },
          h('div', { style: S.grid2 },
            h('div', null,
              h(KV, { label: '状态', value: state.config?.recall?.enabled === false ? '关闭' : '开启', tone: state.config?.recall?.enabled === false ? 'bad' : 'good' }),
              h(KV, { label: '已注入', value: rc.injections == null ? '—' : `${rc.injections} 次` }),
              h(KV, { label: '最近命中', value: rc.lastHits == null ? '—' : `${rc.lastHits} 条 · ${rc.lastChars || 0} 字符` }),
            ),
            h('div', null,
              h(KV, { label: '最近耗时', value: fmtMs(rc.lastMs) }),
              h(KV, { label: '最近提问', value: rc.lastQuery || '—' }),
              h(KV, { label: '失败/跳过', value: `${rc.errors ?? 0} / ${rc.skipped ?? 0}`, tone: rc.errors ? 'warn' : undefined }),
            ),
          ),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h(KV, { label: '检索到', value: `${rc.found ?? 0} 轮`, tone: 'good' }),
            h(KV, { label: '未检索到', value: `${rc.notFound ?? 0} 轮`, tone: rc.notFound ? 'warn' : undefined }),
            h(KV, { label: '只有弱相关', value: `${rc.weakOnly ?? 0} 轮` }),
            h(KV, { label: '最近最高相似度', value: rc.lastBestCos == null ? '—' : Number(rc.lastBestCos).toFixed(3) }),
          ),
          rc.lastError ? h(Notice, { tone: 'warn' }, `最近一次召回失败（已自动跳过）：${rc.lastError}`) : null,
        ),
        h(Card, { title: '跨盘项目', desc: '会话所在的项目目录会自动登记成索引源；项目和 memory/ 一起参与检索。' },
          (() => {
            const list = Array.isArray(state.projects?.list) ? state.projects.list : []
            if (!list.length) {
              return h(Notice, { tone: 'warn' },
                '还没有登记任何项目。在别的盘（如 E:\\ 或 F:\\）开会话会自动登记；也可以去「项目」页手动添加目录。')
            }
            return h('div', { style: S.list },
              list.map(item => h('div', { key: item.name, style: { ...S.row, justifyContent: 'space-between', alignItems: 'baseline' } },
                h('span', { style: { ...S.desc, fontSize: 12 } },
                  h('b', null, item.label || item.name), ' · ', h('span', { style: S.mono }, item.root)),
                h('span', { style: { ...S.mono, color: item.exists ? C.good : C.bad } },
                  item.exists ? `${item.files} 文件 · ${item.chunks} 块` : '目录不存在'))))
          })(),
          h('p', { style: S.footer }, '只索引 .md/.mdx/.txt/.rst；跳过 node_modules、.git、dist 等目录；单项目最多 200 个文件。自动登记/自动索引可在「参数 → 跨盘项目」关掉。'),
        ),
        h(Card, { title: '模型', desc: '模型权重与索引都在本机数据目录里，可随时重建。' },
          h('div', { style: S.grid2 },
            h('div', null,
              h(KV, { label: '嵌入模型', value: `Qwen3-Embedding-0.6B · ${fmtBytes(models.embed?.bytes)}`, tone: models.embed?.exists ? 'good' : 'bad' }),
              h('div', { style: S.mono }, models.embed?.path || '—'),
            ),
            h('div', null,
              h(KV, { label: '重排模型', value: `Qwen3-Reranker-0.6B · ${fmtBytes(models.rerank?.bytes)}`, tone: models.rerank?.exists ? 'good' : 'bad' }),
              h('div', { style: S.mono }, models.rerank?.path || '—'),
            ),
          ),
        ),
        h(Card, { title: '自动维护', desc: '这是基础层，默认自动；关掉也不影响手动使用。' },
          h('div', { style: S.grid2 },
            h('div', null,
              h(KV, { label: '自动预热', value: state.config?.service?.prewarm === false ? '关闭' : '开启' }),
              h(KV, { label: '最近预热', value: fmtTime(sup.lastWarmAt) }),
              h(KV, { label: '预热错误', value: sup.lastWarmError || '—', tone: sup.lastWarmError ? 'bad' : undefined }),
            ),
            h('div', null,
              h(KV, { label: '自动索引', value: state.config?.index?.auto === false ? '关闭' : (state.config?.index?.on_startup === false ? '仅定时' : '启动 + 定时') }),
              h(KV, { label: '最近索引', value: fmtTime(sup.lastIndexAt) }),
              h(KV, { label: '下次定时', value: sup.nextIndexAt ? fmtTime(sup.nextIndexAt) : '—' }),
            ),
          ),
        ),
        state.events?.length
          ? h(Card, { title: '最近事件' },
              h('div', { style: S.list },
                state.events.map(event => h('div', { key: `${event.at}-${event.message}`, style: { ...S.row, justifyContent: 'space-between', alignItems: 'baseline' } },
                  h('span', { style: { ...S.desc, fontSize: 12 } }, event.message),
                  h('span', { style: S.mono }, fmtTime(event.at))),
                )))
          : null,
      )
    }

    function SearchTab({ state, notify }) {
      const [query, setQuery] = useState('')
      const [k, setK] = useState(5)
      const [src, setSrc] = useState('')
      const [rerank, setRerank] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const samples = ['删除文件为什么必须走回收站', '向量化方案最后选了哪个模型', '用户喜欢什么样的回复风格']

      async function run(text) {
        const value = (text ?? query).trim()
        if (!value) return
        setQuery(value)
        setBusy(true)
        setError('')
        try {
          const data = await api('/search', { method: 'POST', body: { query: value, k, rerank, ...(src ? { src } : {}) } })
          setResult(data)
        } catch (caught) {
          setError(caught.message || String(caught))
          setResult(null)
        } finally {
          setBusy(false)
        }
      }

      const hits = result?.hits || []
      return h(Card, { title: '检索测试', desc: '就是 vmemory_search 工具走的那条链路，用来验证索引是否好用。' },
        h('div', { style: S.row, alignItems: 'flex-end' },
          h('div', { style: { ...S.field, flex: '3 1 320px' } }, h('span', { style: S.label }, '查询'), h(TextInput, {
            value: query,
            onChange: setQuery,
            placeholder: '例：删除文件为什么必须走回收站',
          })),
          h('div', { style: { ...S.field, flex: '0 1 90px', minWidth: 80 } }, h('span', { style: S.label }, '返回条数'), h(NumberInput, { value: k, min: 1, max: 20, onChange: value => setK(value === '' ? 5 : value) })),
          h('div', { style: { ...S.field, flex: '0 1 150px', minWidth: 130 } }, h('span', { style: S.label }, '范围'), h(Select, {
            value: src,
            onChange: setSrc,
            options: [{ value: '', label: '全部' }, { value: 'memory', label: 'memory' }, { value: 'harness-project', label: 'harness-project' }],
          })),
          h('div', { style: { ...S.row, paddingBottom: 2 } }, h(Switch, { checked: rerank, onChange: setRerank, label: '重排' })),
          h(Btn, { kind: 'primary', disabled: busy || !query.trim(), onClick: () => void run() }, busy ? '检索中…' : '检索'),
        ),
        h('div', { style: { ...S.row, gap: 6 } },
          h('span', { style: S.label }, '试试：'),
          samples.map(sample => h(Btn, { key: sample, onClick: () => void run(sample), disabled: busy }, sample))),
        error ? h(Notice, { tone: 'error' }, error) : null,
        result
          ? h(Fragment, null,
              h('div', { style: { ...S.row, gap: 8 } },
                h(Chip, { tone: 'good', dot: true }, `${hits.length} 条结果`),
                h(Chip, null, `总耗时 ${fmtMs(result.ms)}`),
                h(Chip, null, result.reranked ? '已重排' : 'RRF 融合')),
              hits.length
                ? h('div', { style: S.list }, hits.map((hit, index) => h('div', { key: `${hit.path}-${hit.line}-${index}`, style: S.item },
                    h('div', { style: S.itemHead },
                      h('span', { style: S.badge('good') }, `${index + 1}`),
                      h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, `${hit.path || '?'}${hit.line ? `:${hit.line}` : ''}`),
                      hit.heading ? h('span', { style: S.desc }, `· ${hit.heading}`) : null,
                      h('span', { style: { ...S.mono, marginLeft: 'auto' } }, Number(hit.score ?? 0).toFixed(3))),
                    hit.snippet ? h('p', { style: S.snippet }, hit.snippet) : null,
                  )))
                : h(Notice, { tone: 'warn' }, '没有命中。检查索引是否已构建，或换个说法。'),
            )
          : h('p', { style: S.desc }, state?.index?.chunks ? `索引里有 ${state.index.chunks} 块，平均一次检索 0.3–0.5 秒。` : '索引还没建，先去「维护」页建索引。'),
      )
    }

    function pick(object, keys) {
      const out = {}
      for (const key of keys) if (object && object[key] !== undefined) out[key] = object[key]
      return out
    }

    function editableFrom(config) {
      return {
        search: pick(config.search, ['k', 'candidates', 'rerank', 'rerank_top', 'max_snippet', 'rrf_k']),
        chunk: pick(config.chunk, ['max_chars', 'min_chars']),
        index: pick(config.index, ['auto', 'on_startup', 'interval_min', 'startup_delay_sec']),
        service: pick(config.service, ['threads', 'port', 'start_timeout_sec', 'prewarm', 'restart_on_crash', 'exit_with_dsh']),
        recall: pick(config.recall, ['enabled', 'k', 'min_cos', 'weak_cos', 'max_chars', 'timeout_ms', 'rerank', 'min_query_chars', 'require_context']),
        outline: pick(config.outline, ['enabled', 'per_src']),
        project_index: pick(config.project_index, ['auto_register', 'auto_index', 'recall_scoped', 'max_files', 'max_file_kb']),
      }
    }

    function ParamsTab({ state, reload, notify }) {
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      const [warnings, setWarnings] = useState([])
      useEffect(() => {
        if (!form && state?.config) setForm(editableFrom(state.config))
      }, [state, form])

      if (!form) return null
      const set = (group, key, value) => setForm(current => {
        const next = JSON.parse(JSON.stringify(current))
        next[group][key] = value
        return next
      })
      const saved = editableFrom(state.config)
      const dirty = JSON.stringify(form) !== JSON.stringify(saved)
      const needsRestart = form.service.port !== saved.service.port || form.service.threads !== saved.service.threads

      async function save() {
        setBusy('save')
        setWarnings([])
        try {
          const data = await api('/config', { method: 'POST', body: { patch: form, previous: saved } })
          setWarnings(Array.isArray(data.warnings) ? data.warnings : [])
          notify('参数已保存' + (needsRestart ? '；端口或线程数改了，需要重启服务才生效' : ''))
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function reset() {
        if (!window.confirm('把所有可调参数恢复为默认值？（模型路径、数据目录、数据源保持不变）')) return
        setBusy('reset')
        try {
          await api('/config/reset', { method: 'POST', body: {} })
          notify('已恢复默认参数')
          setForm(null)
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      function restartService() {
        return api('/service', { method: 'POST', body: { action: 'restart' } })
          .then(() => notify('服务正在重启，几秒后刷新状态'))
          .catch(error => notify(error.message, 'error'))
      }

      return h(Fragment, null,
        h(Card, {
          title: '检索参数',
          desc: '影响 vmemory_search 的质量与速度。改完点最下面的保存。',
        },
          h('div', { style: S.grid2 },
            h(Field, { label: '每次返回条数 k', hint: '1–30，默认 5；给模型的上下文越长越贵' }, h(NumberInput, { value: form.search.k, min: 1, max: 30, onChange: value => set('search', 'k', value) })),
            h(Field, { label: '候选池大小', hint: '5–200；BM25 与向量各取这么多，再融合' }, h(NumberInput, { value: form.search.candidates, min: 5, max: 200, onChange: value => set('search', 'candidates', value) })),
            h(Field, { label: 'RRF 平滑常数', hint: '1–1000，默认 60；越大越偏向两路都靠前的' }, h(NumberInput, { value: form.search.rrf_k, min: 1, max: 1000, onChange: value => set('search', 'rrf_k', value) })),
            h(Field, { label: '摘要长度', hint: '60–2000 字符；只影响返回的 snippet' }, h(NumberInput, { value: form.search.max_snippet, min: 60, max: 2000, step: 20, onChange: value => set('search', 'max_snippet', value) })),
            h(Field, { label: '默认启用重排', hint: '打开后每次检索多 6–15 秒（CPU），但更准' },
              h(Switch, { checked: form.search.rerank, onChange: value => set('search', 'rerank', value), label: form.search.rerank ? '已启用' : '已关闭' })),
            h(Field, { label: '重排候选数', hint: '1–50，默认 8；只对前 N 条做交叉编码' }, h(NumberInput, { value: form.search.rerank_top, min: 1, max: 50, onChange: value => set('search', 'rerank_top', value) })),
          ),
        ),
        h(Card, { title: '向量检索（自动召回）', desc: '每回合第一步自动检索，把【向量检索 · 本机记忆】块作为运行时上下文随请求发送（会记进会话的运行时上下文，不是普通对话消息）。关掉后模型仍可手动调 vmemory_search；这里改的是“主动”检索的规模。' },
          h('div', { style: S.grid2 },
            h(Field, { label: '启用向量检索（自动召回）', hint: '失败或超时会自动跳过，不影响对话' },
              h(Switch, { checked: form.recall.enabled, onChange: value => set('recall', 'enabled', value), label: form.recall.enabled ? '开启' : '关闭' })),
            h(Field, { label: '注入条数 k', hint: '1–10，默认 3；每条含出处与摘要' }, h(NumberInput, { value: form.recall.k, min: 1, max: 10, onChange: value => set('recall', 'k', value) })),
            h(Field, { label: '相关度阈值', hint: '0–1，默认 0.45；低于它的命中一律丢弃（实测无答案问题最高 0.47）' }, h(NumberInput, { value: form.recall.min_cos, min: 0, max: 1, step: 0.05, onChange: value => set('recall', 'min_cos', value) })),
            h(Field, { label: '弱相关标注', hint: '0–1，默认 0.55；低于它的命中会标注「弱相关，仅供参考」' }, h(NumberInput, { value: form.recall.weak_cos === undefined ? 0.55 : form.recall.weak_cos, min: 0, max: 1, step: 0.05, onChange: value => set('recall', 'weak_cos', value) })),
            h(Field, { label: '字符上限', hint: '200–4000，默认 1000；控制每回合多花的上下文' }, h(NumberInput, { value: form.recall.max_chars, min: 200, max: 4000, step: 50, onChange: value => set('recall', 'max_chars', value) })),
            h(Field, { label: '超时（毫秒）', hint: '200–6000，默认 1500；超时就跳过本轮，不拖慢对话' }, h(NumberInput, { value: form.recall.timeout_ms, min: 200, max: 6000, step: 100, onChange: value => set('recall', 'timeout_ms', value) })),
            h(Field, { label: '最小提问长度', hint: '0–50，默认 6；太短的话不检索' }, h(NumberInput, { value: form.recall.min_query_chars, min: 0, max: 50, onChange: value => set('recall', 'min_query_chars', value) })),
            h(Field, { label: '召回使用重排', hint: '更准但每回合多 6–15 秒（CPU），默认关闭' },
              h(Switch, { checked: form.recall.rerank, onChange: value => set('recall', 'rerank', value), label: form.recall.rerank ? '开启' : '关闭' })),
            h(Field, { label: '强制注入', hint: '默认关。宿主若关闭「运行时上下文」，本插件这块会被静默丢弃；打开后要求宿主必须保留它' },
              h(Switch, { checked: form.recall.require_context === true, onChange: value => set('recall', 'require_context', value), label: form.recall.require_context === true ? '强制' : '跟随宿主' })),
          ),
        ),
        h(Card, { title: '知识地图（结构派生）', desc: '把「知识库里有什么、在哪个目录」压成一小段随请求发送，模型不用主动调工具也能知道该往哪查。内容由标题与目录派生，不是模型总结，可回原文核对。' },
          h('div', { style: S.grid2 },
            h(Field, { label: '启用知识地图', hint: '默认开；关掉后模型只能靠检索，不知道整体结构' },
              h(Switch, { checked: form.outline.enabled !== false, onChange: value => set('outline', 'enabled', value), label: form.outline.enabled !== false ? '开启' : '关闭' })),
            h(Field, { label: '每个源列几个主题', hint: '2–12，默认 4；越大信息越全，但占的上下文越多（整块上限约 700 字符）' },
              h(NumberInput, { value: form.outline.per_src, min: 2, max: 12, onChange: value => set('outline', 'per_src', value) })),
          ),
          h('p', { style: S.footer }, '想看完整地图：在「检索测试」页问「各项目都有哪些主题」，或直接调 vmemory_outline 工具。'),
        ),
        h(Card, { title: '跨盘项目', desc: '会话开在别的盘时，插件会把该目录登记为项目源并索引，让检索跟着项目走。' },
          h('div', { style: S.grid2 },
            h(Field, { label: '自动登记会话目录', hint: '默认开：新会话在 E:\\/F:\\ 等目录时自动加为源' },
              h(Switch, { checked: form.project_index.auto_register !== false, onChange: value => set('project_index', 'auto_register', value), label: form.project_index.auto_register !== false ? '开启' : '关闭' })),
            h(Field, { label: '自动索引新项目', hint: '默认开：登记后 5 秒在后台增量索引（不阻塞对话）' },
              h(Switch, { checked: form.project_index.auto_index !== false, onChange: value => set('project_index', 'auto_index', value), label: form.project_index.auto_index !== false ? '开启' : '关闭' })),
            h(Field, { label: '按项目隔离检索', hint: '默认开：在项目里只搜 memory + 该项目，避免串味；关=全库检索' },
              h(Switch, { checked: form.project_index.recall_scoped !== false, onChange: value => set('project_index', 'recall_scoped', value), label: form.project_index.recall_scoped !== false ? '开启' : '关闭' })),
            h(Field, { label: '单项目文件上限', hint: '10–2000，默认 200；防止大仓库把索引撑爆' },
              h(NumberInput, { value: form.project_index.max_files, min: 10, max: 2000, step: 10, onChange: value => set('project_index', 'max_files', value) })),
            h(Field, { label: '单文件大小上限（KB）', hint: '16–4096，默认 512；超大的文档跳过' },
              h(NumberInput, { value: form.project_index.max_file_kb, min: 16, max: 4096, step: 16, onChange: value => set('project_index', 'max_file_kb', value) })),
          ),
        ),
        h(Card, { title: '索引参数', desc: '改切块大小需要重建索引（全量，约 3–4 分钟）才生效。' },
          h('div', { style: S.grid2 },
            h(Field, { label: '单块最大字数', hint: '200–8000；memory/decisions.md 按条目切，不受此限' }, h(NumberInput, { value: form.chunk.max_chars, min: 200, max: 8000, step: 50, onChange: value => set('chunk', 'max_chars', value) })),
            h(Field, { label: '单块最小字数', hint: '0–1000；太碎的段落会被并进上一块' }, h(NumberInput, { value: form.chunk.min_chars, min: 0, max: 1000, step: 10, onChange: value => set('chunk', 'min_chars', value) })),
            h(Field, { label: '自动索引', hint: '写入记忆后由 AI 手动调 vmemory_index 之外，是否也自动做' },
              h(Switch, { checked: form.index.auto, onChange: value => set('index', 'auto', value), label: form.index.auto ? '开启' : '关闭' })),
            h(Field, { label: '启动时索引一次', hint: 'DSH 启动后自动增量索引（延迟 = 启动延迟）' },
              h(Switch, { checked: form.index.on_startup, onChange: value => set('index', 'on_startup', value), label: form.index.on_startup ? '开启' : '关闭' })),
            h(Field, { label: '定时索引间隔（分钟）', hint: '0 = 不开启定时；建议 30–120' }, h(NumberInput, { value: form.index.interval_min, min: 0, max: 1440, step: 10, onChange: value => set('index', 'interval_min', value) })),
            h(Field, { label: '启动延迟（秒）', hint: '2–600；等 DSH 完全启动后再预热和索引' }, h(NumberInput, { value: form.index.startup_delay_sec, min: 2, max: 600, onChange: value => set('index', 'startup_delay_sec', value) })),
          ),
        ),
        h(Card, { title: '服务参数', desc: '这台机器上只有一个常驻服务；端口/线程改动需要重启服务。' },
          h('div', { style: S.grid2 },
            h(Field, { label: '端口', hint: '1024–65535，默认 8479；只监听 127.0.0.1' }, h(NumberInput, { value: form.service.port, min: 1024, max: 65535, onChange: value => set('service', 'port', value) })),
            h(Field, { label: '推理线程数', hint: '1–32，默认 12；CPU 上跑，等于物理核数附近最稳' }, h(NumberInput, { value: form.service.threads, min: 1, max: 32, onChange: value => set('service', 'threads', value) })),
            h(Field, { label: '启动超时（秒）', hint: '10–600，默认 90' }, h(NumberInput, { value: form.service.start_timeout_sec, min: 10, max: 600, onChange: value => set('service', 'start_timeout_sec', value) })),
            h(Field, { label: '自动预热', hint: 'DSH 启动后先把模型加载进内存，首次检索不用等 10 秒' },
              h(Switch, { checked: form.service.prewarm, onChange: value => set('service', 'prewarm', value), label: form.service.prewarm ? '开启' : '关闭' })),
            h(Field, { label: '崩溃自动拉起', hint: '服务意外退出后由守护进程重新启动' },
              h(Switch, { checked: form.service.restart_on_crash, onChange: value => set('service', 'restart_on_crash', value), label: form.service.restart_on_crash ? '开启' : '关闭' })),
            h(Field, { label: 'DSH 退出时关闭服务', hint: '关掉 DSH 后约 3 秒 Python 进程自动退出；关=保持常驻' },
              h(Switch, { checked: form.service.exit_with_dsh !== false, onChange: value => set('service', 'exit_with_dsh', value), label: form.service.exit_with_dsh !== false ? '开启' : '关闭' })),
            h(Field, { label: '空闲内存', hint: '只有 embed 约 0.9–1.6 GB；重排按需加载 +4–5 GB，空闲 5 分钟自动卸载' }, h('span', { style: S.desc }, '—')),
          ),
        ),
        warnings.length ? h(Notice, { tone: 'warn' }, warnings.join('；')) : null,
        h('div', { style: { ...S.row, justifyContent: 'space-between', alignItems: 'center' } },
          h('div', { style: S.row },
            h(Btn, { kind: 'primary', disabled: busy !== '' || !dirty, onClick: () => void save() }, busy === 'save' ? '保存中…' : (dirty ? '保存参数' : '没有改动')),
            h(Btn, { disabled: busy !== '' || !dirty, onClick: () => setForm(editableFrom(state.config)) }, '放弃改动'),
            needsRestart ? h(Chip, { tone: 'warn' }, Math.round(0) === 0 ? '端口/线程已改动，需重启服务' : '') : null,
          ),
          h('div', { style: S.row },
            needsRestart ? h(Btn, { onClick: () => void restartService() }, '重启服务') : null,
            h(Btn, { kind: 'danger', disabled: busy !== '', onClick: () => void reset() }, busy === 'reset' ? '恢复中…' : '恢复默认')),
        ),
        h('p', { style: S.footer }, '只读项（路径、数据源、模型位置）不在此页修改：直接编辑配置文件更安全。文件位置见「维护」页。'),
      )
    }

    /**
     * 跨盘项目：列表来自 /state（和 5 秒轮询同步），增删走 POST /projects。
     * 这里不做长任务轮询——索引走单飞队列，日志去「维护」页看。
     */
    function ProjectsTab({ state, reload, notify }) {
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState('')
      const list = Array.isArray(state?.projects?.list) ? state.projects.list : []
      const settings = state?.projects?.settings || {}

      async function act(body, message) {
        setBusy(body.action + (body.name || body.root || ''))
        try {
          const data = await api('/projects', { method: 'POST', body })
          if (data.ok === false) {
            notify(data.error || data.reason || '操作失败', 'error')
          } else if (data.covered) {
            notify('这个目录已经包含在现有数据源里了，不需要重复登记')
          } else if (data.job) {
            notify('已开始索引（进度见「维护」页）')
          } else {
            notify(message)
          }
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
          setDraft('')
        }
      }

      async function add() {
        const root = draft.trim()
        if (!root) return notify('请填写项目目录，例如 E:\\myproject', 'error')
        await act({ action: 'add', root }, `已登记项目：${root}`)
      }

      async function remove(name) {
        if (!window.confirm(`移除项目源「${name}」？只删登记与索引条目，磁盘上的文件不动。`)) return
        await act({ action: 'remove', name }, `已移除项目：${name}`)
      }

      return h(Fragment, null,
        h(Card, {
          title: '跨盘项目',
          desc: '向量能力是基础层：会话开在哪个盘，就把那个目录当项目源来索引，和 memory/ 一起参与检索。',
        },
          h('div', { style: S.row },
            h('div', { style: { flex: 1 } }, h(TextInput, { value: draft, placeholder: 'E:\\myproject  （或点右侧按钮自动带出当前目录）', onChange: setDraft })),
            h(Btn, { kind: 'primary', disabled: busy !== '' || draft.trim() === '', onClick: () => void add() }, busy.startsWith('add') ? '登记中…' : '添加目录'),
            h(Btn, { onClick: () => setDraft(state?.plugin?.cwd || '') }, '用当前目录'),
          ),
          h(Notice, null,
            '自动登记：', settings.auto_register === false ? '已关闭' : '开启',
            '　自动索引：', settings.auto_index === false ? '已关闭' : '开启',
            '　按项目隔离检索：', settings.recall_scoped === false ? '已关闭（全库）' : '开启',
            '　—— 这些开关在「参数 → 跨盘项目」里调。'),
        ),
        h(Card, { title: `已登记项目（${list.length}）`, desc: '只索引文档类文件（.md/.mdx/.txt/.rst），跳过依赖与构建目录。' },
          list.length
            ? h('div', { style: S.list },
                list.map(item => h('div', { key: item.name, style: { ...S.item, alignItems: 'center' } },
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: 13, fontWeight: 600 } }, `${item.label || item.name}`),
                    h('div', { style: { ...S.mono, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.root),
                    h('div', { style: { ...S.desc, fontSize: 11 } },
                      item.exists ? `${item.files} 个文件 · ${item.chunks} 块` : '目录不存在（可能已改名或换盘）',
                      item.addedAt ? ` · 登记于 ${fmtTime(item.addedAt)}` : ''),
                  ),
                  h('div', { style: S.row },
                    h(Btn, { disabled: busy !== '' || !item.exists, onClick: () => void act({ action: 'index', name: item.name }, `已开始索引：${item.label}`) }, '索引'),
                    h(Btn, { kind: 'danger', disabled: busy !== '', onClick: () => void remove(item.name) }, '移除'),
                  ),
                )),
              )
            : h('p', { style: S.desc }, '暂无。在别的盘开会话会自动出现在这里，也可以在上面手动添加。'),
        ),
        h(Card, { title: '它怎么工作' },
          h('div', { style: S.list },
            h('div', { style: S.desc }, '1. 新会话创建时，插件向宿主问出会话目录（workingDirectory），把这个目录登记为项目源。'),
            h('div', { style: S.desc }, '2. 5 秒后后台增量索引（走单飞队列，不阻塞对话；失败只记日志）。'),
            h('div', { style: S.desc }, '3. 每回合的向量检索只搜 memory + 当前项目，避免跨项目串味；没有登记的项目则退回全库。'),
            h('div', { style: S.desc }, '4. 同一个目录不会重复索引（与 memory/、harness-project/ 重叠时自动跳过）。'),
          ),
        ),
        h('p', { style: S.footer }, '移除只删登记与索引条目，不动磁盘文件；想彻底清掉某项目的向量，移除后在「维护」页做一次增量索引。'),
      )
    }

    function MaintenanceTab({ state, reload, notify }) {
      const [job, setJob] = useState(null)
      const [busy, setBusy] = useState('')
      const [copied, setCopied] = useState('')

      useEffect(() => {
        let cancelled = false
        api('/jobs')
          .then((data) => {
            if (cancelled) return
            if (data.active) setJob(data.active)
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [])

      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        let cancelled = false
        const timer = setInterval(async () => {
          try {
            const data = await api(`/job?id=${encodeURIComponent(job.id)}`)
            if (!cancelled && data.job) {
              setJob(data.job)
              if (data.job.status !== 'running') {
                await reload()
                notify(data.job.status === 'done' ? `${data.job.label} 完成` : `${data.job.label} ${data.job.status === 'failed' ? '失败' : '已取消'}`,
                  data.job.status === 'done' ? undefined : 'error')
              }
            }
          } catch {
            // polling is best effort
          }
        }, 1500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [job, reload, notify])

      async function act(kind) {
        if (kind === 'rebuild-all' && !window.confirm('全量重建会重新编码所有块（约 3–4 分钟），期间检索仍可用。继续？')) return
        setBusy(kind)
        try {
          const body = kind === 'index' ? { force: false } : kind === 'rebuild-all' ? { force: true } : { action: kind === 'warm' ? 'start' : kind === 'restart' ? 'restart' : 'stop' }
          const path = kind === 'index' || kind === 'rebuild-all' ? '/index' : '/service'
          const data = await api(path, { method: 'POST', body })
          if (data.job) setJob(data.job)
          if (kind === 'stop') {
            notify('服务已停止（首次检索会自动重启）')
            await reload()
          } else {
            notify('任务已开始')
          }
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      async function copy(label, text) {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(label)
          setTimeout(() => setCopied(''), 2000)
        } catch {
          notify('复制失败，请手动选择路径', 'error')
        }
      }

      async function openFolder(target) {
        try {
          const data = await api('/open', { method: 'POST', body: { target } })
          if (data.ok === false) notify(data.error, 'error')
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      async function archiveNow(force) {
        if (force && !window.confirm('强制重归档会重新解压并重写全部会话文本（约 1 分钟），期间检索仍可用。继续？')) return
        setBusy('archive')
        try {
          const data = await api('/archive/run', { method: 'POST', body: { force: !!force } })
          const digest = data.digest || {}
          notify(`归档完成：${digest.written ?? 0} 个会话更新 · ${digest.skipped ?? 0} 个未变 · ${digest.failed ?? 0} 个失败（${((digest.durationMs || 0) / 1000).toFixed(1)}s）`)
          await reload()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy('')
        }
      }

      const running = job && job.status === 'running'
      const paths = [
        ['配置文件', state?.plugin?.configPath],
        ['引擎脚本', state?.plugin?.engine?.cli],
        ['数据目录', state?.plugin?.dataDir],
        ['索引目录', state?.plugin?.indexDir],
      ]

      return h(Fragment, null,
        h(Card, { title: '维护操作', desc: '索引是增量安全的：只重算变化的文件；全量重建也不会删除记忆。' },
          h('div', { style: S.row },
            h(Btn, { kind: 'primary', disabled: busy !== '' || running, onClick: () => void act('index') }, '立即增量索引'),
            h(Btn, { disabled: busy !== '' || running, onClick: () => void act('rebuild-all') }, '全量重建'),
            h(Btn, { disabled: busy !== '' || running, onClick: () => void act('warm') }, '预热服务'),
            h(Btn, { disabled: busy !== '' || running, onClick: () => void act('restart') }, '重启服务'),
            h(Btn, { kind: 'danger', disabled: busy !== '' || running, onClick: () => void act('stop') }, '停止服务'),
          ),
          running ? h(Notice, { tone: 'info' }, `${job.label} 进行中…（${fmtMs(job.ms)}）`) : null,
          job
            ? h('div', { style: S.list },
                h('div', { style: { ...S.row, gap: 8 } },
                  h(Chip, { tone: job.status === 'done' ? 'good' : job.status === 'failed' ? 'bad' : 'warn', dot: true }, job.label),
                  h(Chip, null, job.status === 'running' ? '进行中' : job.status === 'done' ? '完成' : job.status === 'failed' ? '失败' : '已取消'),
                  h(Chip, null, fmtMs(job.ms))),
                job.error ? h(Notice, { tone: 'error' }, job.error) : null,
                job.log?.length ? h('div', { style: S.jobLog }, job.log.slice(-14).join('\n')) : null,
                job.result && job.status === 'done'
                  ? h('div', { style: S.desc }, `文件 ${job.result.files ?? '?'} · 块 ${job.result.chunks ?? '?'} · 新增 ${job.result.new ?? '?'} · 复用 ${job.result.reused ?? '?'} · ${Number(job.result.seconds ?? 0).toFixed(1)}s`)
                  : null,
              )
            : h('p', { style: S.desc }, '还没有运行过任务。'),
        ),
        h(Card, { title: '会话归档', desc: '把 DSH 的会话存档（.jsonl.zstd）物化成可读文本，开场简报与跨会话检索都靠它。' },
          (() => {
            const info = state?.archive
            if (!info || info.available === false) {
              return h('p', { style: S.desc }, info?.reason || '归档层未启用（插件没有加载归档器）。')
            }
            const last = info.last || null
            return h(Fragment, null,
              h('div', { style: S.row },
                h(Chip, { tone: info.running ? 'warn' : info.enabled ? 'good' : 'muted', dot: true }, info.running ? '归档中' : info.enabled ? `自动 · 每 ${info.intervalMin} 分钟` : '自动已关'),
                last ? h(Chip, null, `${last.written ?? 0} 更新 / ${last.skipped ?? 0} 未变`) : null,
                last?.at ? h(Chip, null, fmtTime(last.at)) : null),
              h('div', { style: S.list },
                h('div', { style: S.kv }, h('span', { style: S.kvLabel }, '会话存档'), h('span', { style: S.mono }, info.sessionsDir || '—')),
                h('div', { style: S.kv }, h('span', { style: S.kvLabel }, '归档输出'), h('span', { style: S.mono }, info.transcriptsDir || '—')),
                last?.error ? h(Notice, { tone: 'error' }, last.error) : null,
                last?.errors?.length ? h('div', { style: S.jobLog }, last.errors.join('\n')) : null),
              h('div', { style: S.row },
                h(Btn, { kind: 'primary', disabled: busy !== '' || running || info.running, onClick: () => void archiveNow(false) }, '立即归档'),
                h(Btn, { disabled: busy !== '' || running || info.running, onClick: () => void archiveNow(true) }, '强制重归档'),
                h(Btn, { onClick: () => void openFolder('data') }, '打开数据目录')),
              h('p', { style: S.desc }, '增量判定用「文件大小 + 修改时间 + 解析器版本」，不变的文件直接跳过、不解压；启动 60 秒后自动跑一次。'),
              (() => {
                const cardsInfo = state?.cards
                if (!cardsInfo || cardsInfo.available === false) {
                  return h('p', { style: S.desc }, cardsInfo?.reason || '归档卡片未启用。')
                }
                return h('div', { style: S.list },
                  h('div', { style: S.kv }, h('span', { style: S.kvLabel }, '归档卡片'),
                    h('span', { style: S.mono }, `${cardsInfo.cards ?? 0} 张 · 已注入 ${cardsInfo.injected ?? 0} 次 · 门槛 ${cardsInfo.min_score ?? '—'}`)),
                  h('p', { style: S.desc }, '卡片是归档里「模型自己写的压缩摘要」按日期切出来的；只有当本轮向量检索没有强相关命中时，才补一条最像的旧会话线索（跟着会话的「自动检索」开关走）。'),
                )
              })(),
            )
          })(),
        ),
        h(Card, { title: '文件位置', desc: '长期维护从这里找。' },
          h('div', { style: S.list },
            paths.map(([label, value]) => h('div', { key: label, style: { ...S.row, justifyContent: 'space-between', alignItems: 'baseline' } },
              h('span', { style: S.kvLabel }, label),
              h('div', { style: { ...S.row, gap: 6, flex: 1, justifyContent: 'flex-end' } },
                h('span', { style: S.mono }, value || '—'),
                h(Btn, { onClick: () => void copy(label, value || '') }, copied === label ? '已复制' : '复制'),
                label === '配置文件' || label === '数据目录' ? h(Btn, { onClick: () => void openFolder(label === '配置文件' ? 'config' : 'data') }, '打开') : null),
            )),
          ),
        ),
        h(Card, { title: '备份与卸载', desc: '先备份，再动手。' },
          h('p', { style: S.desc },
            '每次保存参数都会把上一版写成 config.json.bak。索引与服务都可随时重建；真正不可再生的是 ', h('b', null, 'memory/*.md'), ' 里的正文。'),
          h('p', { style: S.desc },
            '卸载：在 DSH 里执行 ', h('code', null, 'dsh plugin --profile desktop remove dsh-vector-memory'),
            '，然后把 profile 的 dsh.profile.bundles 里这一项删掉并重启。数据目录（设置页可见）与引擎目录可保留，随时装回来。'),
          h('p', { style: S.footer }, `插件版本 v${state?.plugin?.version || VERSION_FALLBACK}${state?.plugin?.releaseDate ? `（${state.plugin.releaseDate}）` : ''} · 索引与服务都是本机进程，数据都在设置页所示的数据目录里。`),
        ),
      )
    }

    function Page() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [tab, setTab] = useState('status')
      const [toast, setToast] = useState(null)
      const timer = useRef(null)

      const reload = useCallback(async () => {
        try {
          const data = await api('/state')
          setState(data)
          setError('')
        } catch (caught) {
          setError(caught.message || String(caught))
        }
      }, [])

      const notify = useCallback((message, tone) => {
        setToast({ message, tone: tone === 'error' ? 'error' : 'info' })
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setToast(null), 4500)
      }, [])

      useEffect(() => {
        void reload()
        const poll = setInterval(() => void reload(), 5000)
        return () => {
          clearInterval(poll)
          if (timer.current) clearTimeout(timer.current)
        }
      }, [reload])

      const tabs = [
        { id: 'status', label: '状态', render: () => h(OverviewTab, { state }) },
        { id: 'search', label: '检索测试', render: () => h(SearchTab, { state, notify }) },
        { id: 'params', label: '参数', render: () => h(ParamsTab, { state, reload, notify }) },
        { id: 'projects', label: '项目', render: () => h(ProjectsTab, { state, reload, notify }) },
        { id: 'maintenance', label: '维护', render: () => h(MaintenanceTab, { state, reload, notify }) },
      ]
      const active = tabs.find(item => item.id === tab) || tabs[0]
      // Strict semver carries the plugin's own ordering; the DSH compatibility
      // range and the release date live in their own fields and are shown here.
      const pluginVersion = state?.plugin?.version || VERSION_FALLBACK
      const compatText = [
        state?.plugin?.dshRange ? `DSH ${state.plugin.dshRange}` : '',
        state?.plugin?.verifiedOn ? `验证于 ${state.plugin.verifiedOn}` : '',
        state?.plugin?.releaseDate ? state.plugin.releaseDate : '',
      ].filter(Boolean).join(' · ')

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('h2', { style: S.title }, '向量记忆'),
          h('span', { style: S.badge('good') }, `v${pluginVersion}`),
          state
            ? h(Fragment, null,
                h(Chip, { tone: state.service?.running ? 'good' : 'bad', dot: true }, state.service?.running ? '服务运行中' : '服务未运行'),
                h(Chip, null, `${state.index?.chunks ?? '?'} 块 · ${state.index?.files ?? '?'} 文件`),
                h(Chip, null, 'Qwen3-Embedding-0.6B'),
                state.service?.rssMb != null ? h(Chip, null, `RSS ${Number(state.service.rssMb).toFixed(0)} MB`) : null,
                state.job ? h(Chip, { tone: 'warn', dot: true }, `任务：${state.job.label}`) : null,
              )
            : h(Chip, null, '正在读取…'),
          h('span', { style: { flex: 1 } }),
          h(Btn, { onClick: () => void reload() }, '刷新'),
        ),
        h('p', { style: S.desc },
          '本机语义记忆底座 · 检索增强上下文 · 减少幻觉 · 全部离线。设置持久化在 ', state?.plugin?.configPath || 'config.json', '。'),
        compatText ? h('p', { style: S.desc }, compatText) : null,
        error ? h(Notice, { tone: 'error' }, `读取设置失败：${error}。确认插件已启用，并重启一次 DSH。`) : null,
        h('div', { style: S.tabs }, tabs.map(item => h('button', {
          key: item.id,
          type: 'button',
          onClick: () => setTab(item.id),
          style: S.tab(item.id === tab),
        }, item.label))),
        state ? active.render() : h('p', { style: S.desc }, '正在读取向量记忆状态…'),
        toast ? h('div', { style: { position: 'sticky', bottom: 8, zIndex: 5 } }, h(Notice, { tone: toast.tone }, toast.message)) : null,
      )
    }

    /**
     * 会话输入区左侧的「记忆」按钮（插槽 conversation.input.left）。
     *
     * 这是用户要的「每会话界面里的快捷开关」，不是设置页：按钮常驻在输入框工具行，
     * 一个点表示状态，点开就是本会话的三件事——要不要自动检索、检索哪些来源、
     * 要不要知识块。改动写进 session-prefs.json（会话级），也可以一键存成本项目默认。
     *
     * 面板用原生 popover（顶层渲染）：composer 有 overflow 裁剪，普通绝对定位会被切掉；
     * 自绘 React 面板 + showPopover 才能稳定浮在输入框上方。浏览器不支持时退化成固定定位。
     */
    const DOCK_BUTTON = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 24,
      padding: '0 8px',
      borderRadius: 999,
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.32))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 11.5,
      lineHeight: 1,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const DOCK_POPOVER = {
      position: 'fixed',
      inset: 'auto',
      margin: 0,
      padding: 0,
      border: 'none',
      background: 'transparent',
      overflow: 'visible',
      zIndex: 2147483000,
    }

    const DOCK_PANEL = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: 334,
      maxWidth: 'calc(100vw - 16px)',
      maxHeight: '72vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: 12,
      borderRadius: 12,
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.3))',
      background: 'var(--dsh-color-surface, Canvas)',
      color: 'var(--dsh-color-text, inherit)',
      boxShadow: '0 16px 48px rgba(0,0,0,0.32)',
      fontSize: 12.5,
      lineHeight: 1.5,
    }

    function DockRow({ children, style }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...style } }, children)
    }

    function MemoryDock(props) {
      const sessionId = String(props?.sessionId || '')
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [pos, setPos] = useState({ left: 12, bottom: 12 })
      const [nativePopover, setNativePopover] = useState(true)
      const anchorRef = useRef(null)
      const panelRef = useRef(null)

      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const data = await api(`/session?sessionId=${encodeURIComponent(sessionId)}`)
          setState(data)
          setError('')
        } catch (caught) {
          setError(caught?.message || String(caught))
        }
      }, [sessionId])

      const write = useCallback(async (path, body) => {
        setBusy(true)
        try {
          const data = await api(path, { method: 'POST', body })
          setState(data)
          setError('')
        } catch (caught) {
          setError(caught?.message || String(caught))
        } finally {
          setBusy(false)
        }
      }, [])

      const setSession = useCallback((patch) => write('/session/set', {
        sessionId,
        root: state?.root || undefined,
        patch,
      }), [sessionId, state, write])

      const place = useCallback(() => {
        const node = anchorRef.current
        if (!node || typeof window === 'undefined') return
        const rect = node.getBoundingClientRect()
        const width = 334
        const left = Math.max(8, Math.min(Math.round(rect.left), Math.max(8, window.innerWidth - width - 8)))
        setPos({ left, bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)) })
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        const node = panelRef.current
        setNativePopover(Boolean(node && typeof node.showPopover === 'function' && typeof node.hidePopover === 'function'))
      }, [])

      useEffect(() => {
        const node = panelRef.current
        if (!node) return
        const supported = typeof node.showPopover === 'function' && typeof node.hidePopover === 'function'
        if (open) {
          place()
          if (supported) {
            try {
              if (!node.matches(':popover-open')) node.showPopover()
            } catch (caught) {
              console.error('[vector-memory] popover 打开失败', caught)
            }
          }
        } else if (supported) {
          try {
            if (node.matches(':popover-open')) node.hidePopover()
          } catch {
            // ignore
          }
        }
      }, [open, place])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onDown = (event) => {
          const panel = panelRef.current
          const anchor = anchorRef.current
          const target = event.target
          if (panel && panel.contains(target)) return
          if (anchor && anchor.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown, true)
        window.addEventListener('resize', place)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown, true)
          window.removeEventListener('resize', place)
        }
      }, [open, place])

      const effective = state?.effective || {}
      const modes = state?.modes || []
      const currentMode = modes.find(item => item.value === effective.scopeMode)
      const recallOn = state ? Boolean(effective.recall) : true
      const awarenessOn = state ? Boolean(effective.awareness) : true
      const handoffOn = state ? effective.handoff !== false : true
      const originLabel = (key) => ({ session: '本会话', project: '本项目', global: '全局参数' })[state?.origin?.[key]] || '全局参数'
      const dotColor = !state ? C.muted : !recallOn ? C.bad : (!awarenessOn || !handoffOn) ? C.warn : C.good

      const sourceText = (() => {
        if (!state) return '—'
        const scope = effective.scope
        if (effective.scopeMode === 'all') return '全部来源（不过滤）'
        if (!Array.isArray(scope) || !scope.length) {
          return effective.scopeMode === 'project' ? '本项目暂无已索引文档（本轮跳过检索）' : '（不限制）'
        }
        return scope.join(' + ')
      })()

      const sessionValues = () => ({
        recall: recallOn ? 'on' : 'off',
        scope: effective.scopeMode || 'auto',
        awareness: awarenessOn ? 'on' : 'off',
        handoff: handoffOn ? 'on' : 'off',
      })

      const panelStyle = nativePopover
        ? { ...DOCK_POPOVER, left: pos.left, bottom: pos.bottom }
        : { ...DOCK_POPOVER, left: pos.left, bottom: pos.bottom, display: open ? 'block' : 'none' }

      const body = []
      body.push(h(DockRow, { key: 'head' },
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, '本会话 · 向量记忆'),
        h('span', { style: { flex: 1 } }),
        state?.project?.label ? h(Chip, null, state.project.label) : null,
      ))

      if (state && state.available === false) {
        body.push(h(Notice, { tone: 'warn', key: 'na' }, state.reason || '会话级开关未启用'))
      } else if (!state) {
        body.push(h('p', { key: 'loading', style: { ...S.desc, margin: 0 } }, error ? `读取失败：${error}` : '读取中…'))
      } else {
        body.push(h(DockRow, { key: 'recall' },
          h(Switch, {
            checked: recallOn,
            label: '自动检索并注入记忆块',
            onChange: checked => void setSession({ recall: checked ? 'on' : 'off' }),
          }),
        ))
        body.push(h('div', { key: 'scope', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: S.label }, '检索范围'),
          h(Select, {
            value: effective.scopeMode || 'auto',
            options: modes.map(item => ({ value: item.value, label: item.label })),
            onChange: value => void setSession({ scope: value }),
          }),
          h('span', { style: { ...S.desc, fontSize: 11 } }, currentMode?.hint || ''),
        ))
        body.push(h(DockRow, { key: 'awareness' },
          h(Switch, {
            checked: awarenessOn,
            label: '注入知识源清单 / 知识地图',
            onChange: checked => void setSession({ awareness: checked ? 'on' : 'off' }),
          }),
        ))
        const brief = state.brief || {}
        const briefHint = !brief.enabled
          ? '全局已关闭（设置 → 向量记忆 → 参数）'
          : brief.sessions
            ? `本项目 ${brief.sessions} 个旧会话可摘要 · ${brief.chars} 字`
            : '本项目还没有归档会话（跑一次归档脚本后可用）'
        body.push(h('div', { key: 'handoff', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h(Switch, {
            checked: handoffOn,
            label: '开场简报（上一轮聊到哪儿）',
            onChange: checked => void setSession({ handoff: checked ? 'on' : 'off' }),
          }),
          h('span', { style: { ...S.desc, fontSize: 11 } }, briefHint),
        ))
        body.push(h('div', { key: 'effective', style: { ...S.item, gap: 3 } },
          h('span', { style: { ...S.desc, fontSize: 11 } }, '实际检索来源'),
          h('span', { style: S.mono }, sourceText),
          h('span', { style: { ...S.desc, fontSize: 11 } },
            `开关来源：检索 ${originLabel('recall')} · 范围 ${originLabel('scope')} · 知识块 ${originLabel('awareness')} · 简报 ${originLabel('handoff')}`),
        ))

        if (state.root) {
          const source = state.project?.source
          body.push(h('div', { key: 'project', style: { ...S.item, gap: 6 } },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, `本项目：${state.project?.label || state.root}`),
            h('span', { style: { ...S.desc, fontSize: 11, wordBreak: 'break-all' } }, state.root),
            source
              ? h(Switch, {
                  checked: source.enabled !== false,
                  label: source.enabled !== false ? '本项目参与索引与检索' : '本项目已暂停索引',
                  onChange: checked => void write('/project/index-set', { sessionId, root: state.root, enabled: checked }),
                })
              : h('span', { style: { ...S.desc, fontSize: 11 } }, '这个目录没有独立项目源（由固定源覆盖）'),
          ))
        }

        body.push(h(DockRow, { key: 'actions' },
          h(Btn, {
            disabled: busy || !state.root,
            title: '把当前三个开关写成本项目（该目录下所有会话）的默认值',
            onClick: () => void write('/project/set', { sessionId, root: state.root, patch: sessionValues() }),
          }, '保存为项目默认'),
          h(Btn, {
            disabled: busy,
            title: '清掉本会话的单独设置，跟随本项目/全局参数',
            onClick: () => void setSession({ recall: null, scope: null, awareness: null, handoff: null }),
          }, '跟随项目默认'),
        ))
      }

      if (error) body.push(h(Notice, { tone: 'error', key: 'error' }, error))
      body.push(h('span', { key: 'hint', style: { ...S.desc, fontSize: 11 } },
        '关掉后本会话下一轮就不再注入检索块与知识块；更多参数在 设置 → 向量记忆。'))

      return h(Fragment, null,
        h('button', {
          ref: anchorRef,
          type: 'button',
          title: `本会话向量记忆：${state ? (recallOn ? '开' : '关') : '读取中'}${state?.project?.label ? ` · ${state.project.label}` : ''}（点击调整）`,
          'aria-label': '向量记忆开关',
          onClick: () => setOpen(value => !value),
          style: { ...DOCK_BUTTON, ...(state && !recallOn ? { borderColor: C.bad, color: C.bad } : null) },
        },
          h('i', { style: { width: 6, height: 6, borderRadius: 999, background: dotColor, display: 'inline-block' } }),
          state ? (recallOn ? '记忆' : '记忆 · 关') : '记忆',
        ),
        h('div', { ref: panelRef, popover: 'manual', style: panelStyle },
          h('div', { style: DOCK_PANEL }, body),
        ),
      )
    }

    function apply(ctx) {
      const registerSection = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'vector-memory',
        order: 25,
        label: () => '向量记忆',
      }, () => h(Page)))
      // 会话页里的快捷开关：输入框工具行最左，常驻、一眼能看出本会话开没开。
      const registerDock = () => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'vector-memory-dock',
        order: 12,
        label: () => '记忆',
      }, props => h(MemoryDock, props)))
      try {
        registerSection()
      } catch (error) {
        console.error('[vector-memory] settings section failed', error)
      }
      try {
        registerDock()
      } catch (error) {
        console.error('[vector-memory] session dock failed', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'vector-memory'
    return module.exports
  },
})




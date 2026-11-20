/**
 * dsh-memory-tree — Client half.
 *
 * One sidebar rail icon plus a full dual-tree panel:
 *   - a resizable left rail listing every workspace that owns a task tree
 *   - a canvas where each tree grows upward, drawn as SVG branches
 *   - a resizable right column with node detail, diagnosis, brief, recycle bin
 *
 * The canvas supports zoom, "show only this tree" focus, and fullscreen.
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-tree',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // The browser module table exposes only a React subset: guard every hook so a
    // missing one degrades to a plain call instead of blanking the slot.
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo || ((fn) => fn())
    const useCallback = React.useCallback || ((fn) => fn)
    // `useRef` is absent from some React subsets; without it the wheel handler
    // simply never binds, which is a degradation, not a crash.
    const useRef = React.useRef || ((init) => ({ current: init }))

    const API = '/dsh-memory-tree'
    const PANEL_KEY = 'memory-tree'

    /**
     * The Desktop shell serves its page from a custom protocol, so a relative
     * request resolves against that scheme instead of the local HTTP carrier.
     * Resolve every call against the Host's advertised origin explicitly.
     */
    const apiUrl = (tail) => {
      const origin = globalThis.__DSH_BOOT__?.origin || globalThis.__DSH_ORIGIN__ || ''
      if (origin) return `${origin}${API}${tail}`
      return `${API}${tail}`
    }

    /* ------------------------------------------------------------ locale */

    const ZH = {
      title: '记忆树',
      subtitle: '双树长期记忆',
      task: '任务树',
      habit: '习惯树',
      search: '搜索双树关键词…',
      hot: '热', warm: '温', cold: '冷', archived: '归档',
      nodes: '节点', hotLayer: '热层',
      workspaces: '工作区',
      noWorkspace: '还没有工作区记忆树',
      noWorkspaceHint: '在某个工作区里让 Agent 用 memory_grow 记一条，这里就会出现。',
      detail: '详情',
      type: '类型', status: '状态',
      score: '权重', importance: '重要度', access: '访问', lastAccess: '最近访问',
      openLog: '打开日志原文 ↗', nextHint: '下一步',
    edit: '编辑', editTitle: '标题（≤20 字）', editSummary: '摘要（≤60 字）',
    editKeywords: '关键词（逗号分隔，最多 5 个）', editImportance: '重要度 0–1',
    editSave: '保存修改', editDone: '已保存',
    dataTitle: '数据', exportJson: '导出 JSON', importJson: '导入 JSON',
    exportDone: '已复制到剪贴板', exportFail: '复制失败，已展开到下方文本域',
    importHint: '粘贴整棵树的 JSON，确认后覆盖当前树。', importApply: '覆盖导入',
    importBadJson: '不是合法的 JSON', importBadTree: '缺少 nodes 字段',
    importDone: '导入完成',
      keywords: '关键词', summary: '摘要', digest: '聚合摘要',
      del: '删除…', close: '关闭',
      deleteTitle: '删除节点',
      deleteSubtree: '连子树一起删',
      deleteSubtreeWarn: '共 {n} 个子节点将一并进入回收站（可还原）',
      deleteSelf: '仅删本节点，子节点上移',
      deleteSelfWarn: '子节点挂到本节点的父级下',
      deleteNote: '为什么删（可选，用于改进判定规则）',
      cancel: '取消', confirm: '确认删除',
      recycle: '回收站', restore: '还原', purge: '清理过期',
      empty: '这棵树还是空的',
      emptyHint: '让 Agent 在任务边界调用 memory_grow。',
      diagnose: '自测诊断',
      overdue: '待复习', suspected: '疑似重复', drifting: 'P0 掉出热层', stuck: '阻塞中',
      allClear: '暂无待处理项',
      brief: '交接快照', noBrief: '还没有生成过 brief',
      loading: '载入中…',
      loadFail: '读不到记忆树：{msg}',
      selectHint: '点任意节点看详情',
      noLog: '该节点没有原文',
      deleteDone: '已移入回收站',
      restoreDone: '已还原',
      lockedDone: '已锁定 · 不再自动清理',
      unlockedDone: '已解锁',
      editDone: '已保存修改',
      importedDone: '已导入',
      purgedDone: '已清理',
      removeShell: '移除记忆树',
      groupHint: '让 AI 按语义给这一级分组',
      groupedDone: '已分成 {n} 组',
      bucketNamed: '已命名：{names}',
      aiGrouping: 'AI 分组',
      aiGroupingOn: '允许 AI 按语义分组（关闭后只用序号分桶）',
      aiGroupingHint: '点树工具栏的 ✧ 给整棵树分组；分桶上的「起名」只处理那一组。每次约 0.2 分钱。',
      aiGroupingModel: '分组用哪个模型',
      aiGroupingAuto: '跟随当前会话（推荐）',
      aiGroupingModelHint: '默认用你正在对话的那个模型；也可以指定一个更小的模型省钱。',
      groupNoModel: '没有可用的模型，分组已跳过',
      groupUnusable: '模型没有按格式回答，分组已跳过',
      groupNothing: '这一级没有需要分组的子节点',
      groupDisabled: '分组已在设置里关闭',
      removeShellTitle: '从列表移除这棵记忆树',
      removeShellBody: '「{name}」的记忆树已被删除，这里只剩一个空壳。移除后它不再出现在工作区列表里。',
      removeShellHint: '不会删除工作区目录，也不会删除会话记录 — 之后仍可重新建树。',
      shellRemoved: '已从列表移除',
      zoomIn: '放大', zoomOut: '缩小', zoomReset: '实际大小', zoomFit: '适应窗口',
      fullscreen: '全屏', exitFullscreen: '退出全屏',
      showTaskTree: '显示任务树',
      showHabitTree: '显示习惯树',
      showPanel: '显示详情面板', hidePanel: '隐藏详情面板',
    }

    const EN = {
      title: 'Memory tree',
      subtitle: 'Dual-tree long-term memory',
      task: 'Task tree',
      habit: 'Habit tree',
      search: 'Search both trees…',
      hot: 'hot', warm: 'warm', cold: 'cold', archived: 'archived',
      nodes: 'nodes', hotLayer: 'hot',
      workspaces: 'Workspaces',
      noWorkspace: 'No workspace trees yet',
      noWorkspaceHint: 'Ask the agent to call memory_grow in a workspace and it appears here.',
      detail: 'Details',
      type: 'Type', status: 'Status',
      score: 'Score', importance: 'Importance', access: 'Access', lastAccess: 'Last access',
      openLog: 'Open log source ↗', nextHint: 'Next step',
    edit: 'Edit', editTitle: 'Title (≤20 chars)', editSummary: 'Summary (≤60 chars)',
    editKeywords: 'Keywords (comma separated, max 5)', editImportance: 'Importance 0–1',
    editSave: 'Save changes', editDone: 'Saved',
    dataTitle: 'Data', exportJson: 'Export JSON', importJson: 'Import JSON',
    exportDone: 'Copied to clipboard', exportFail: 'Copy failed; the JSON is shown below',
    importHint: 'Paste a whole tree as JSON; it replaces the current tree once confirmed.',
    importApply: 'Replace and import',
    importBadJson: 'Not valid JSON', importBadTree: 'Missing the nodes field',
    importDone: 'Imported',
      keywords: 'Keywords', summary: 'Summary', digest: 'Rollup digest',
      del: 'Delete…', close: 'Close',
      deleteTitle: 'Delete node',
      deleteSubtree: 'Delete the subtree',
      deleteSubtreeWarn: '{n} child nodes move to the recycle bin (restorable)',
      deleteSelf: 'Delete this node, move children up',
      deleteSelfWarn: 'Children attach to this node\u2019s parent',
      deleteNote: 'Why (optional, improves the retention rules)',
      cancel: 'Cancel', confirm: 'Delete',
      recycle: 'Recycle bin', restore: 'Restore', purge: 'Purge expired',
      empty: 'This tree is empty',
      emptyHint: 'Ask the agent to call memory_grow at a milestone.',
      diagnose: 'Diagnosis',
      overdue: 'Due', suspected: 'Suspected duplicates', drifting: 'P0 drifting', stuck: 'Blocked',
      allClear: 'Nothing to review',
      brief: 'Handoff snapshot', noBrief: 'No brief generated yet',
      loading: 'Loading…',
      loadFail: 'Cannot read the memory tree: {msg}',
      selectHint: 'Select any node for details',
      noLog: 'No source text for this node',
      deleteDone: 'Moved to the recycle bin',
      restoreDone: 'Restored',
      lockedDone: 'Locked · no longer auto-cleaned',
      unlockedDone: 'Unlocked',
      editDone: 'Changes saved',
      importedDone: 'Imported',
      purgedDone: 'Purged',
      removeShell: 'Remove tree',
      groupHint: 'Let the model group this level by meaning',
      groupedDone: 'Grouped into {n}',
      bucketNamed: 'Named: {names}',
      aiGrouping: 'AI grouping',
      aiGroupingOn: 'Let AI group by meaning (off keeps plain number buckets)',
      aiGroupingHint: 'Click ✧ in the toolbar to group the whole tree; "起名" on a bucket names just that group. About 0.2 fen per run.',
      aiGroupingModel: 'Grouping model',
      aiGroupingAuto: 'Follow this session (recommended)',
      aiGroupingModelHint: 'Uses the model you are talking to; pin a smaller one to save credit.',
      groupNoModel: 'No model available — grouping skipped',
      groupUnusable: 'The model did not answer in the expected shape — skipped',
      groupNothing: 'Nothing on this level needs grouping',
      groupDisabled: 'Grouping is turned off in settings',
      removeShellTitle: 'Remove this tree from the list',
      removeShellBody: 'The tree for "{name}" is already deleted; only an empty shell is left here. Removing it drops that entry from the workspace list.',
      removeShellHint: 'The workspace directory and the session log are untouched — a tree can still be rebuilt later.',
      shellRemoved: 'Removed from the list',
      zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomReset: 'Actual size', zoomFit: 'Fit to window',
      fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen',
      showTaskTree: 'Show the task tree',
      showHabitTree: 'Show the habit tree',
      showPanel: 'Show details panel', hidePanel: 'Hide details panel',
    }

    const TYPE_ICON = {
      goal: '🎯', decision: '✅', constraint: '🔒', task: '📋', issue: '⚠️',
      fact: '📌', artifact: '📦', deadend: '⛔', question: '❓', preference: '⚙️',
    }

    /**
     * A render error inside a slot blanks the whole panel with no clue why.
     * This boundary turns that into a readable message plus a retry.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[dsh-memory-tree] panel render failed', error, info)
        } catch { /* logging must never throw */ }
      }

      render() {
        if (this.state.error) {
          const message = String(this.state.error?.message || this.state.error)
          return h('div', { style: { padding: 24, fontFamily: 'inherit' } },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } },
              '记忆树面板渲染失败'),
            h('pre', {
              style: {
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12,
                padding: 10, borderRadius: 6, maxHeight: 320, overflow: 'auto',
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            }, `${message}\n\n${String(this.state.error?.stack || '')}`),
            h('button', {
              type: 'button',
              style: {
                marginTop: 12, font: 'inherit', fontSize: 12, padding: '5px 12px',
                borderRadius: 6, cursor: 'pointer',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
              onClick: () => this.setState({ error: null }),
            }, '重试'))
        }
        return this.props.children
      }
    }

    /** Tier → glow colour. The tree reads as heat: green busiest, slate coldest. */
    const TIER = { hot: '#34d399', warm: '#fbbf24', cold: '#64748b', archived: '#475569' }
    const tierColor = (tier) => TIER[tier] || TIER.cold

    const HABIT_ACCENT = '#34d399'
    const TASK_ACCENT = '#60a5fa'

    /**
     * Success toast per action.
     *
     * The same panel posts to seven endpoints, and one shared message meant a lock
     * announced "moved to the recycle bin". Each action names its own outcome;
     * `body` is available because locking reads differently in each direction.
     */
    const TOAST_FOR = {
      delete: (t) => t.deleteDone,
      restore: (t) => t.restoreDone,
      edit: (t) => t.editDone,
      import: (t) => t.importedDone,
      lock: (t, body) => (body?.locked ? t.lockedDone : t.unlockedDone),
      purge: (t) => t.purgedDone,
      'tree-purge': (t) => t.purgedDone,
      'tree-delete': (t) => t.deleteDone,
      'tree-restore': (t) => t.restoreDone,
      'shell-remove': (t) => t.shellRemoved,
    }

    /* ------------------------------------------------------------ styles */

    const S = {
      page: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        // Anchors the drawers: without it they resolve against the host shell and
        // ride over the Harness menu bar and toolbar at the top of the window.
        position: 'relative',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      bar: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0, flexWrap: 'wrap',
      },
      h1: { fontSize: 14.5, fontWeight: 600, margin: 0, letterSpacing: 0.3 },
      sub: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        flex: '1 1 160px', minWidth: 120, padding: '5px 9px', fontSize: 12.5,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, outline: 'none',
      },
      stat: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      toolGroup: {
        display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 7,
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
      },
      tool: {
        font: 'inherit', fontSize: 12, lineHeight: 1, padding: '5px 8px', borderRadius: 5,
        cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
        background: 'transparent', border: 'none',
      },
      toolOn: {
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      zoomLabel: {
        fontSize: 11, minWidth: 38, textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)', userSelect: 'none',
      },
      // `relative` anchors the detail overlay; the tree keeps the full width.
      body: { flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', position: 'relative' },

      rail: {
        flex: '0 0 208px', minWidth: 140, overflow: 'auto', padding: '12px 10px',
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      railTitle: {
        fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)', padding: '2px 4px 8px',
      },
      wsRow: {
        display: 'flex', alignItems: 'center', gap: 6, width: '100%',
        padding: '6px 8px 6px 9px', marginBottom: 4, borderRadius: 7, font: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'transparent',
        border: '1px solid transparent', cursor: 'pointer', textAlign: 'left',
      },
      wsRowOn: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: 'inset 2px 0 0 var(--dsw-alias-brand-primary)',
      },
      /** The clickable half of a workspace row; the lock sits beside it. */
      wsMain: { flex: '1 1 auto', minWidth: 0 },
      /** A quiet icon button that only comes alive on hover or when engaged. */
      wsLock: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, padding: 0, borderRadius: 6, fontSize: 12, lineHeight: 1,
        cursor: 'pointer', background: 'transparent', border: '1px solid transparent',
        color: 'var(--dsw-alias-label-secondary)', opacity: 0.55,
      },
      wsLockOn: {
        color: 'var(--dsw-alias-brand-primary)', opacity: 1,
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      wsName: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      wsMeta: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 },

      /** Drag handle between two panes. */
      grip: {
        flex: '0 0 5px', cursor: 'col-resize', position: 'relative',
        background: 'transparent', touchAction: 'none',
      },
      gripLine: {
        position: 'absolute', top: 0, bottom: 0, left: 2, width: 1,
        background: 'var(--dsw-alias-border-l1)',
      },

      canvasArea: {
        flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'hidden',
        padding: '12px 14px 20px',
        display: 'flex', flexDirection: 'column',
      },
      treeCard: {
        display: 'flex', flexDirection: 'column', minHeight: 0,
        borderRadius: 10, overflow: 'hidden',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      treeHead: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2)', border: 'none', width: '100%',
        font: 'inherit', color: 'var(--dsw-alias-label-primary)', textAlign: 'left', flexShrink: 0,
      },
      treeHeadName: { fontSize: 13, fontWeight: 600, letterSpacing: 0.2 },
      treeHeadMeta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginLeft: 'auto' },
      treeBody: {
        // The canvas positions itself absolutely inside this box and pans
        // internally, so this must be a plain positioned frame — not a scroller.
        flex: '1 1 auto', minHeight: 180, padding: 0,
        position: 'relative', overflow: 'hidden',
      },
      emptyBox: {
        padding: '30px 12px', textAlign: 'center', fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },

      side: {
        flex: '0 0 336px', minWidth: 240, borderLeft: '1px solid var(--dsw-alias-border-l1)',
        overflow: 'auto', padding: 12,
      },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8, padding: 12, marginBottom: 12,
      },
      row: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '3px 0' },
      k: { color: 'var(--dsw-alias-label-secondary)' },
      v: { textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' },
      btn: {
        font: 'inherit', fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      btnDanger: {
        font: 'inherit', fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
        color: 'var(--dsw-alias-state-error-primary)', background: 'transparent',
        border: '1px solid var(--dsw-alias-state-error-primary)',
      },
      link: {
        color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer', fontSize: 12,
        textDecoration: 'none', background: 'none', border: 'none', padding: 0, font: 'inherit',
      },
      /* --- button variants ---------------------------------------------------
         Real buttons, not bare words: a text-only action inside a list row is easy
         to mistake for a label, and the recycle bin's two actions are destructive
         enough that they should look pressable. */
      chip: {
        font: 'inherit', fontSize: 11.5, lineHeight: 1.25, padding: '4px 11px',
        borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        transition: 'background .12s, border-color .12s',
      },
      chipOn: {
        color: 'var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-brand-primary)',
      },
      chipDanger: {
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent)',
      },
      chipDisabled: { opacity: 0.4, cursor: 'not-allowed' },
      /** Divider-titled section head used by every panel. */
      habitBtn: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '8px 9px', marginBottom: 10, borderRadius: 8, font: 'inherit',
        fontSize: 12.5, fontWeight: 500, cursor: 'pointer', textAlign: 'left',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        transition: 'border-color .12s, background .12s',
      },
      habitBtnOn: {
        color: HABIT_ACCENT,
        background: 'var(--dsw-alias-bg-overlay)',
        border: `1px solid ${HABIT_ACCENT}`,
        boxShadow: `inset 2px 0 0 ${HABIT_ACCENT}`,
      },
      /** Floating menu anchored at the pointer. */
      menu: {
        position: 'fixed', zIndex: 60, minWidth: 150, padding: 4,
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.4)',
      },
      menuItem: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '6px 10px', borderRadius: 5, font: 'inherit', fontSize: 12,
        textAlign: 'left', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent', border: 'none',
      },
      menuItemDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      panelTitle: {
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        padding: '0 0 8px',
      },
      panelTitleRule: {
        flex: '1 1 auto', height: 1,
        background: 'var(--dsw-alias-border-l1)',
      },
      pre: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.55,
        margin: 0, padding: 10, borderRadius: 6, maxHeight: 240, overflow: 'auto',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      },
      pill: {
        display: 'inline-block', fontSize: 10.5, padding: '1px 7px', borderRadius: 99,
        border: '1px solid var(--dsw-alias-border-l1)', marginRight: 6, marginBottom: 4,
      },
      modalBg: {
        position: 'fixed', inset: 0, zIndex: 40, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent)',
      },
      modal: {
        width: 'min(440px, 92vw)', background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
        padding: 18, color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 18px 48px rgba(0,0,0,.35)',
      },
      label: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, padding: '6px 0', cursor: 'pointer' },
      ta: {
        width: '100%', boxSizing: 'border-box', minHeight: 54, resize: 'vertical', padding: 8,
        fontSize: 12, fontFamily: 'inherit', borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 },
    }

    /* ----------------------------------------------------------- helpers */

    function indexTree(tree) {
      const nodes = tree?.nodes || {}
      const kids = new Map()
      const hasParent = new Set()
      for (const edge of tree?.edges || []) {
        if (edge.rel !== 'part_of') continue
        if (!nodes[edge.from] || !nodes[edge.to]) continue
        if (!kids.has(edge.to)) kids.set(edge.to, [])
        kids.get(edge.to).push(edge.from)
        hasParent.add(edge.from)
      }
      for (const list of kids.values()) {
        list.sort((a, b) => (nodes[b]?.score || 0) - (nodes[a]?.score || 0))
      }
      const roots = Object.keys(nodes)
        .filter((id) => nodes[id].layer === 'trunk' || !hasParent.has(id))
        .sort((a, b) => (nodes[b]?.score || 0) - (nodes[a]?.score || 0))
      return { nodes, kids, roots }
    }

    function descendantsOf(tree, id) {
      const kids = new Map()
      for (const edge of tree?.edges || []) {
        if (edge.rel !== 'part_of') continue
        if (!kids.has(edge.to)) kids.set(edge.to, [])
        kids.get(edge.to).push(edge.from)
      }
      const out = []
      const stack = [...(kids.get(id) || [])]
      while (stack.length) {
        const next = stack.pop()
        if (out.includes(next)) continue
        out.push(next)
        stack.push(...(kids.get(next) || []))
      }
      return out
    }

    const NODE_W = 208
    const NODE_H = 30
    // Horizontal spacing between depth columns; generous enough that the curved
    // branch reads as a connector rather than a squiggle.
    const STEP_X = 262
    // Vertical spacing between sibling rows. This is the axis a memory tree
    // spends: two dozen leaves under four branches. Rows are kept tight so the
    // whole tree stays near one screen at a legible scale.
    const STEP_Y = 34
    const PAD_X = 40
    const PAD_Y = 24

    /**
     * Above this many children, a branch is folded into its stored groups.
     *
     * A branch that collects a dozen leaves turns into one tall column that
     * scrolls off screen and says nothing about how its children relate. When the
     * tree carries semantic groups — produced by the model at write time and named
     * by it — those are drawn instead. A tree without groups still falls back to
     * the index buckets below, so old data keeps working.
     */
    const FANOUT_LIMIT = 6

    /** Stable synthetic id for a bucket, so collapse state survives re-renders. */
    const groupIdOf = (parentId, index) => `__grp__${parentId}__${index}`

    /**
     * Insert group nodes between a parent and its children.
     *
     * Two sources, in order of preference:
     *
     *   1. `tree.groups` — the semantic map the model wrote and the user can rename.
     *   2. index buckets — a deterministic fallback for trees that predate grouping,
     *      or whose grouping failed.
     *
     * `closed` holds the group ids the user has collapsed. It is deliberately the
     * closed set rather than the open one: bucket ids are created here, so an open
     * set built from the tree could never reference them and clicking a bucket
     * would do nothing.
     *
     * `indexTree` builds the parent→child map from `edges` (rel `part_of`), not
     * from `node.parents`, so the edges are what has to be rewritten. Everything
     * else — real ids, titles, unrelated edges — is preserved, so selection,
     * search and the detail panel keep working against real ids.
     */
    function foldWideBranches(tree, closed) {
      const nodes = tree?.nodes || {}
      const edges = tree?.edges || []

      const kidMap = new Map()
      for (const edge of edges) {
        if (edge.rel !== 'part_of') continue
        if (!nodes[edge.from] || !nodes[edge.to]) continue
        if (!kidMap.has(edge.to)) kidMap.set(edge.to, [])
        kidMap.get(edge.to).push(edge.from)
      }

      // Blocks per parent: either the stored semantic groups, or index buckets.
      const blocks = new Map()
      let usedSemantic = false

      for (const [parentId, kids] of kidMap) {
        const parent = nodes[parentId]
        if (!parent) continue

        const stored = Object.values(tree?.groups || {})
          .filter((g) => g?.parent === parentId && Array.isArray(g.members))
          .map((g) => ({ id: g.id, title: g.title, members: g.members.filter((m) => nodes[m]) }))
          .filter((g) => g.members.length)

        if (stored.length >= 2) {
          blocks.set(parentId, stored)
          usedSemantic = true
          continue
        }

        if (kids.length > FANOUT_LIMIT) {
          const buckets = []
          for (let i = 0; i < kids.length; i += FANOUT_LIMIT) {
            const slice = kids.slice(i, i + FANOUT_LIMIT)
            buckets.push({
              id: groupIdOf(parentId, i / FANOUT_LIMIT),
              title: `${i + 1}–${i + slice.length}`,
              members: slice,
              // A size-slice has no meaning of its own, so it offers "起名".
              unnamed: true,
            })
          }
          blocks.set(parentId, buckets)
        }
      }

      if (!blocks.size) return tree

      const outNodes = { ...nodes }
      const dropEdges = new Set()   // `${child}>${parent}` links a block replaces
      const addEdges = []
      const synthetic = new Map()   // blockId -> member ids

      for (const [parentId, list] of blocks) {
        for (const block of list) {
          const gid = block.id
          // A semantic group id comes from the tree; mark it synthetic for rendering.
          synthetic.set(gid, block.members)
          outNodes[gid] = {
            id: gid,
            type: 'group',
            layer: 'group',
            title: block.title || '组',
            state: closed.has(gid) ? 'collapsed' : 'expanded',
            synthetic: true,
            // Only an index bucket is nameable; a semantic group already has one.
            unnamed: block.unnamed === true,
            parents: [parentId],
          }
          addEdges.push({ from: gid, to: parentId, rel: 'part_of', weight: 1 })
          for (const childId of block.members) {
            dropEdges.add(`${childId}\u0000${parentId}`)
            addEdges.push({ from: childId, to: gid, rel: 'part_of', weight: 1 })
          }
        }
      }

      const keptEdges = edges.filter((edge) => {
        if (edge.rel !== 'part_of') return true
        return !dropEdges.has(`${edge.from}\u0000${edge.to}`)
      })

      return {
        ...tree,
        nodes: outNodes,
        edges: [...keptEdges, ...addEdges],
        syntheticIds: new Set(synthetic.keys()),
        semantic: usedSemantic,
      }
    }

    /**
     * Bottom-up tree layout: leaves claim horizontal slots left to right, each
     * parent centres over its children, and depth maps to a row counted from the
     * bottom so the trunk sits at the base and branches fan upward.
     */
    /**
     * Layout the tree left-to-right.
     *
     * A memory tree is shallow and wide — one trunk, a handful of branches, and
     * dozens of leaves under them. A bottom-up layout therefore has to squeeze
     * every leaf onto one enormous row, which is what made the titles unreadable.
     * Depth now grows to the right and siblings stack downwards, so width is
     * proportional to depth (3 columns) and height to the leaf count.
     */
    function layoutTree(tree, collapsed) {
      const { nodes, kids: childMap, roots } = indexTree(tree)
      const placed = new Map()
      let row = 0

      const walk = (id, depth) => {
        const node = nodes[id]
        if (!node) return null
        const children = (childMap.get(id) || []).filter((c) => nodes[c])
        const hidden = collapsed.has(id)
        const visibleKids = hidden ? [] : children

        let y
        if (!visibleKids.length) {
          // A leaf owns one row of its own.
          y = PAD_Y + row * STEP_Y + NODE_H / 2
          row += 1
        } else {
          // A parent sits at the middle of its children so the branches fan out
          // evenly above and below it.
          const ys = visibleKids.map((c) => walk(c, depth + 1)).filter((v) => v !== null)
          y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : PAD_Y + (row++) * STEP_Y + NODE_H / 2
        }
        placed.set(id, { id, node, y, depth, hasKids: children.length, hidden })
        return y
      }

      for (const root of roots) walk(root, 0)

      const entries = [...placed.values()]
      const maxDepth = entries.reduce((m, e) => Math.max(m, e.depth), 0)
      const width = PAD_X * 2 + (maxDepth + 1) * STEP_X
      const height = Math.max(NODE_H * 2, PAD_Y * 2 + Math.max(1, row) * STEP_Y)

      const xOf = (depth) => PAD_X + depth * STEP_X + NODE_W / 2

      const positions = new Map()
      for (const entry of entries) positions.set(entry.id, { x: xOf(entry.depth), y: entry.y })

      const links = []
      for (const entry of entries) {
        if (entry.hidden) continue
        const from = positions.get(entry.id)
        for (const childId of childMap.get(entry.id) || []) {
          if (!positions.has(childId)) continue
          const child = positions.get(childId)
          links.push({
            id: `${entry.id}->${childId}`,
            // Parent edge on the right, child edge on the left.
            d: branchPath(from.x + NODE_W / 2, from.y, child.x - NODE_W / 2, child.y),
            depth: entry.depth,
          })
        }
      }

      return { width, height, entries, positions, links, roots, nodes }
    }

    /**
     * One smooth branch between two horizontal columns.
     *
     * The control points sit at the horizontal midpoint, which makes the curve
     * leave the parent and enter the child horizontally — the shape a reader
     * follows left to right.
     */
    function branchPath(x1, y1, x2, y2) {
      const mx = (x1 + x2) / 2
      return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
    }

    function truncate(text, max) {
      const value = String(text || '')
      return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
    }

    /* ------------------------------------------------------- tree canvas */

    function TreeCanvas({
      tree, uid, accent, onSelect, selectedId, matchedIds, collapsed, onToggle, zoom, onZoom,
      onNameBucket, naming,
    }) {
      // Groups start open: the name is the point, and hiding every member behind
      // a click just moves the scrolling. A click collapses one when it gets in
      // the way. Semantic groups carry real names, so they earn the space.
      //
      // State tracks what the user CLOSED, not what is open. Bucket ids only come
      // into existence during folding, so an "open" set built from the tree could
      // never contain them — which is why clicking a bucket used to do nothing.
      // Deciding from the closed set breaks that circular dependency.
      const [closedGroups, setClosedGroups] = useState(() => new Set())
      const folded = useMemo(
        () => foldWideBranches(tree, closedGroups),
        [tree, closedGroups],
      )

      // A group is expanded unless the user closed it; layoutTree wants the
      // inverse — the ids whose members are hidden.
      const openGroups = useMemo(() => {
        const open = new Set()
        for (const id of folded?.syntheticIds || []) {
          if (!closedGroups.has(id)) open.add(id)
        }
        return open
      }, [folded, closedGroups])

      const hiddenGroups = useMemo(() => {
        const ids = folded?.syntheticIds
        if (!ids) return collapsed
        const out = new Set(collapsed)
        for (const gid of ids) {
          if (!openGroups.has(gid)) out.add(gid)
        }
        return out
      }, [folded, collapsed, openGroups])

      const layout = useMemo(() => layoutTree(folded, hiddenGroups), [folded, hiddenGroups])
      const boxRef = useRef(null)

      // How many members a bucket holds, so the marker can show its size.
      const kidCountOf = useCallback((id) => {
        if (!id) return 0
        let n = 0
        for (const edge of folded?.edges || []) {
          if (edge.rel === 'part_of' && edge.to === id) n += 1
        }
        return n
      }, [folded])
      const glowId = `mt-glow-${uid}`
      const branchId = `mt-branch-${uid}`
      const baseId = `mt-base-${uid}`

      // Size of the visible box, so a freshly opened tree can be scaled to fit
      // instead of landing at an arbitrary zoom. Without this the first view is
      // whatever percentage the toolbar happened to hold.
      const [viewport, setViewport] = useState({ w: 0, h: 0 })
      useEffect(() => {
        const box = boxRef.current
        if (!box || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((records) => {
          const rect = records[0]?.contentRect
          if (rect) setViewport({ w: rect.width, h: rect.height })
        })
        observer.observe(box)
        return () => observer.disconnect()
      }, [])

      // Viewport offset in CSS pixels. The tree is anchored at the centre of its
      // box and moved by this offset, so oversized content can be dragged into
      // view — a scroll container that centres it makes the far edge unreachable.
      const [pan, setPan] = useState({ x: 0, y: 0 })
      const panRef = useRef(pan)
      panRef.current = pan

      // A different tree or a re-layout starts centred.
      useEffect(() => { setPan({ x: 0, y: 0 }) }, [uid, tree])

      // Ctrl/⌘ + wheel is the browser-wide zoom gesture, so leave it alone.
      // A bare wheel zooms the tree and swallows the page scroll it would cause.
      useEffect(() => {
        const box = boxRef.current
        if (!box || !onZoom) return undefined

        const onWheel = (event) => {
          if (event.ctrlKey || event.metaKey) return
          event.preventDefault()
          onZoom(event.deltaY < 0 ? 0.1 : -0.1)
        }
        box.addEventListener('wheel', onWheel, { passive: false })
        return () => box.removeEventListener('wheel', onWheel)
      }, [onZoom])

      // Pan with a left-button drag (or middle button, which is the usual
      // pan gesture). Bound to the window so the pointer may leave the box.
      useEffect(() => {
        const box = boxRef.current
        if (!box) return undefined

        let start = null

        const onDown = (event) => {
          // Only this canvas starts a pan; nodes keep their own click behaviour.
          if (event.button !== 0 && event.button !== 1) return
          if (event.target.closest && event.target.closest('[data-mt-node]')) return
          event.preventDefault()
          start = {
            x: event.clientX,
            y: event.clientY,
            originX: panRef.current.x,
            originY: panRef.current.y,
          }
          box.style.cursor = 'grabbing'
        }

        const onMove = (event) => {
          if (!start) return
          setPan({
            x: start.originX + (event.clientX - start.x),
            y: start.originY + (event.clientY - start.y),
          })
        }

        const onUp = () => {
          if (!start) return
          start = null
          box.style.cursor = 'grab'
        }

        box.addEventListener('mousedown', onDown)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          box.removeEventListener('mousedown', onDown)
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [])

      if (!layout.entries.length) return null

      const trunkEntry = layout.roots.length ? layout.positions.get(layout.roots[0]) : null

      // Scale the whole tree into the box, never enlarging past 100% so a small
      // tree reads at its natural size. Once the user touches the zoom buttons
      // their number takes over and this value is ignored.
      const fit = viewport.w > 0 && viewport.h > 0
        ? Math.min(
            (viewport.w - 24) / layout.width,
            (viewport.h - 24) / layout.height,
            1,
          )
        : 1
      const effectiveZoom = Math.max(0.2, Math.min(2, zoom === 'fit' ? fit : zoom))
      const scaledW = layout.width * effectiveZoom
      const scaledH = layout.height * effectiveZoom

      return h('div', {
        ref: boxRef,
        style: {
          position: 'absolute', inset: 0, overflow: 'hidden',
          cursor: 'grab', userSelect: 'none', touchAction: 'none',
        },
        title: onZoom ? '左键拖拽平移 · 滚轮缩放 · 双击归位' : undefined,
        onDoubleClick: () => setPan({ x: 0, y: 0 }),
      },
        h('div', {
          style: {
            position: 'absolute', left: '50%', top: '50%',
            width: scaledW, height: scaledH,
            // Centre first, then apply the drag offset.
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
            willChange: 'transform',
          },
        },
          h('svg', {
            viewBox: `0 0 ${layout.width} ${layout.height}`,
            width: scaledW,
            height: scaledH,
            role: 'img',
            style: { display: 'block' },
          },
            h('defs', null,
              h('linearGradient', { id: branchId, x1: '0', y1: '1', x2: '0', y2: '0' },
                h('stop', { offset: '0%', stopColor: accent, stopOpacity: 0.95 }),
                h('stop', { offset: '65%', stopColor: accent, stopOpacity: 0.5 }),
                h('stop', { offset: '100%', stopColor: accent, stopOpacity: 0.22 }),
              ),
              h('radialGradient', { id: baseId, cx: '50%', cy: '50%', r: '50%' },
                h('stop', { offset: '0%', stopColor: accent, stopOpacity: 0.32 }),
                h('stop', { offset: '70%', stopColor: accent, stopOpacity: 0.08 }),
                h('stop', { offset: '100%', stopColor: accent, stopOpacity: 0 }),
              ),
              h('filter', { id: glowId, x: '-60%', y: '-60%', width: '220%', height: '220%' },
                h('feGaussianBlur', { stdDeviation: '3', result: 'blur' }),
                h('feMerge', null,
                  h('feMergeNode', { in: 'blur' }),
                  h('feMergeNode', { in: 'SourceGraphic' })),
              ),
            ),

            // Soft halo behind the trunk column: the tree reads as rooted at the
            // left edge rather than floating in the middle of the canvas.
            trunkEntry
              ? h('ellipse', {
                  cx: trunkEntry.x + NODE_W / 2,
                  cy: trunkEntry.y,
                  rx: 130,
                  ry: Math.max(70, layout.height * 0.34),
                  fill: `url(#${baseId})`,
                  opacity: 0.5,
                })
              : null,

            // Branches first, so nodes always sit on top of their own lines.
            h('g', { fill: 'none', stroke: `url(#${branchId})`, strokeLinecap: 'round' },
              layout.links.map((link) => h('path', {
                key: link.id,
                d: link.d,
                strokeWidth: Math.max(1.5, 4 - link.depth * 0.5),
                opacity: 0.9,
              }))),

            layout.entries.map((entry) => {
              const point = layout.positions.get(entry.id)
              const node = entry.node
              const selected = selectedId === entry.id
              const matched = matchedIds?.has(entry.id)
              const color = tierColor(node.tier)
              const dashed = !!node.suspected
              const isTrunk = node.layer === 'trunk'
              const isBranch = node.layer === 'branch'
              // A bucket is a fold marker, not a memory — it must not select.
              const isGroup = node.synthetic === true
              const groupOpen = isGroup && openGroups.has(entry.id)

              return h('g', {
                key: entry.id,
                'data-mt-node': '1',
                transform: `translate(${point.x - NODE_W / 2}, ${point.y - NODE_H / 2})`,
                style: { cursor: 'pointer' },
                onClick: () => {
                  if (isGroup) {
                    setClosedGroups((prev) => {
                      const next = new Set(prev)
                      if (next.has(entry.id)) next.delete(entry.id)
                      else next.add(entry.id)
                      return next
                    })
                    return
                  }
                  onSelect(entry.id)
                },
              },
                h('rect', {
                  x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 7,
                  fill: selected ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                  stroke: selected ? accent : matched ? '#fbbf24' : color,
                  strokeWidth: selected ? 1.8 : 1.1,
                  strokeDasharray: dashed ? '4 3' : isGroup ? '3 2' : undefined,
                  opacity: isGroup ? 0.72 : selected || matched ? 1 : 0.94,
                  filter: selected || isTrunk ? `url(#${glowId})` : undefined,
                }),
                // The coloured bar carries the tier; a trunk gets a thicker one so
                // the eye finds the root without reading any text.
                h('rect', {
                  x: 0, y: 0, width: isTrunk ? 4 : 3, height: NODE_H,
                  rx: isTrunk ? 2 : 1.5,
                  fill: color, opacity: selected ? 1 : 0.75,
                }),
                h('text', { x: 10, y: NODE_H / 2 + 4, fontSize: 11, style: { userSelect: 'none' } },
                  isGroup ? (groupOpen ? '▾' : '▸') : (TYPE_ICON[node.type] || '•')),
                h('text', {
                  x: 28, y: NODE_H / 2 + 4,
                  fontSize: isTrunk ? 12.5 : isBranch ? 12 : 11.5,
                  fontWeight: isTrunk || isBranch ? 600 : 400,
                  fill: 'var(--dsw-alias-label-primary)',
                  style: { userSelect: 'none' },
                }, isGroup
                  ? `${node.title} 组`
                  : truncate(node.title, isTrunk ? 14 : isBranch ? 13 : 12)),
                // The status dot is only meaningful on a leaf; a branch already
                // shows its colour through the left bar. A bucket shows its size.
                isGroup
                  ? h('text', {
                      x: NODE_W - 11, y: NODE_H / 2 + 4, fontSize: 10, textAnchor: 'end',
                      fill: 'var(--dsw-alias-label-secondary)',
                      style: { userSelect: 'none' },
                    }, `${(kidCountOf(entry.id) || 0)}`)
                  : entry.hasKids
                    ? null
                    : h('circle', { cx: NODE_W - 11, cy: NODE_H / 2, r: 3, fill: color }),
                entry.hasKids && !isGroup
                  ? h('g', {
                      'data-mt-node': '1',
                      onClick: (event) => { event.stopPropagation(); onToggle(entry.id) },
                      style: { cursor: 'pointer' },
                    },
                      h('rect', {
                        x: NODE_W - 24, y: NODE_H / 2 - 8, width: 18, height: 16, rx: 4,
                        fill: 'var(--dsw-alias-bg-overlay)', stroke: color, strokeWidth: 0.8, opacity: 0.92,
                      }),
                      h('text', {
                        x: NODE_W - 15, y: NODE_H / 2 + 4, fontSize: 11, textAnchor: 'middle',
                        fill: color, style: { userSelect: 'none' },
                      }, entry.hidden ? '+' : '−'))
                  : null,
                // Only an unnamed bucket earns the button: a bucket that already
                // carries a real name is not a bucket any more.
                isGroup && node.unnamed
                  ? h('g', {
                      'data-mt-node': '1',
                      onClick: (event) => {
                        event.stopPropagation()
                        onNameBucket?.(entry.id, node.parents?.[0])
                      },
                      style: { cursor: 'pointer' },
                    },
                      h('rect', {
                        x: NODE_W - 46, y: NODE_H / 2 - 8, width: 40, height: 16, rx: 4,
                        fill: 'var(--dsw-alias-bg-overlay)', stroke: accent, strokeWidth: 0.8, opacity: 0.92,
                      }),
                      h('text', {
                        x: NODE_W - 26, y: NODE_H / 2 + 3.5, fontSize: 9, textAnchor: 'middle',
                        fill: accent, style: { userSelect: 'none' },
                      }, naming === entry.id ? '…' : '起名'))
                  : null,
              )
            }),
          ),
        ),
      )
    }

    /* -------------------------------------------------- import and recycle */

  /* Import and recycle copy. Merged into the page dictionary by the caller. */
  /**
   * Host error codes turned into something a user can act on.
   *
   * Each entry takes the dictionary so the message follows the UI language; the
   * Host only ever returns the code, never a translated sentence.
   */
  const ERROR_TEXT = {
    llm_unavailable: (t) => t.errLlmUnavailable,
    no_messages: (t) => t.errNoMessages,
    workspace_not_found: (t) => t.errWorkspaceMissing,
    nothing_extracted: (t) => t.errNothingExtracted,
    missing_dir: (t) => t.errMissingDir,
    tree_exists: (t) => t.errTreeExists,
    save_failed: (t) => t.errSaveFailed,
    scan_failed: (t) => t.errScanFailed,
  }
  const IMPORT_ZH = {
    importWorkspace: '导入工作区',
    importHabit: '导入习惯树',
    importTitle: '从历史会话建树',
    importHabitTitle: '从历史会话提炼习惯',
    importSub: '扫描本机已归档的会话，为还没有记忆树的工作区建一棵。',
    importHabitSub: '所有工作区共享同一棵习惯树。选中的会话只用来提炼长期偏好。',
    method: '提炼方式',
    methodRules: '规则提取',
    methodRulesHint: '离线、瞬时、不花钱。只捞取明确写下的决策与规则，颗粒较粗。',
    methodAi: 'AI 总结',
    methodAiHint: '逐段交给模型概括，文字更通顺，但会消耗额度，且结果不保证更好。',
    needModel: 'AI 方式需要当前会话的模型信息，若不可用请改用规则提取。',
    pickWorkspace: '选择工作区',
    pickHabit: '选择用于提炼的会话',
    noCandidates: '没有可导入的工作区',
    noCandidatesHint: '本机还没有已归档的会话记录，或都已建过树。',
    willOverwrite: '已有任务树，继续将覆盖',
    scan: '重新扫描',
    scanning: '扫描中…',
    running: '提炼中…',
    runRules: '开始规则提取',
    runAi: '开始 AI 总结',
    done: '导入完成',
    doneStats: '共 {n} 个节点（规则 {r} / AI {a}）',
    failed: '导入失败：{msg}',
    nothing: '没有提炼出任何节点',
    errLlmUnavailable: 'AI 方式不可用：Host 没有可用的模型路由，请改用规则提取。',
    errNoMessages: '这个工作区没有可读的历史消息。',
    errWorkspaceMissing: '找不到这个工作区，可能已被移走。',
    errNothingExtracted: '没有从会话里提炼出任何节点。',
    errMissingDir: '没有指定工作区。',
    errTreeExists: '这个工作区已经有任务树了。',
    errSaveFailed: '保存失败，请查看 Host 日志。',
    errScanFailed: '扫描工作区失败。',
    closeAfter: '完成',
    treeDelete: '删除整棵树…',
    treeDeleteTitle: '删除整个任务树',
    treeDeleteBody: '这会把「{name}」的整棵树移入回收站，{n} 个节点。回收站保留 {days} 天，超期自动清空。',
    treeDeleteHint: '工作区本身不受影响，只是它不再有记忆树。',
    treeDeleteConfirm: '删除并放入回收站',
    treeDeleted: '整棵树已移入回收站',
    treeRecycle: '整树回收站',
    treeRecycleEmpty: '回收站是空的',
    treeRecycleHint: '删除的整棵树会在这里等待 {days} 天。',
    treeRestore: '还原',
    treePurgeOne: '彻底删除',
    treePurgeOneTitle: '彻底删除这棵树',
    treePurgeOneBody: '「{name}」将被永久删除，无法还原。',
    treePurgeOneHint: '这只删除回收站里的这份备份。工作区本身保留，之后仍可重新建树。',
    treePurgeOneDone: '已彻底删除',
    treeRestoreMerge: '合并',
    conflictTitle: '目标工作区已有任务树',
    conflictBody: '「{name}」当前已有一棵树（{n} 个节点）。请选择如何处理。',
    conflictOverwrite: '覆盖当前任务树',
    conflictOverwriteHint: '现有树会先移入回收站，可以再还原。',
    conflictMerge: '与当前任务树合并',
    conflictMergeHint: '把回收站的节点并入现有树，编号不会冲突。',
    confirmTitle: '确认操作',
    confirmBody: '即将对「{name}」执行：{action}。此操作会修改磁盘上的记忆树文件。',
    confirmYes: '确认执行',
    back: '上一步',
    cancel: '取消',
    restoreDone: '已还原',
    mergeDone: '已合并',
    purged: '已清理 {n} 条过期记录',
    deletedShell: '已删除',
    restoreFromTrash: '可恢复',
    rebuildHint: '可从会话重建',
    habitGlobalHint: '所有工作区共用一棵习惯树',
    nodesShort: '节点',
    messagesShort: '条消息',
  }

  const IMPORT_EN = {
    importWorkspace: 'Import workspace',
    importHabit: 'Import habits',
    importTitle: 'Build a tree from history',
    importHabitTitle: 'Distil habits from history',
    importSub: 'Scan archived sessions and build a tree for workspaces that have none.',
    importHabitSub: 'Every workspace shares one habit tree. The sessions you pick only feed long-term preferences.',
    method: 'Method',
    methodRules: 'Rule extraction',
    methodRulesHint: 'Offline, instant, free. Promotes explicit decisions and rules; coarse.',
    methodAi: 'AI summary',
    methodAiHint: 'Sends chunks to the model. Smoother prose, costs tokens, not guaranteed better.',
    needModel: 'AI mode needs the current session model; use rule extraction if unavailable.',
    pickWorkspace: 'Choose workspaces',
    pickHabit: 'Choose sessions to distil',
    noCandidates: 'Nothing to import',
    noCandidatesHint: 'No archived sessions on this machine, or all already have trees.',
    willOverwrite: 'Tree exists — importing overwrites it',
    scan: 'Rescan',
    scanning: 'Scanning…',
    running: 'Extracting…',
    runRules: 'Run rule extraction',
    runAi: 'Run AI summary',
    done: 'Import finished',
    doneStats: '{n} nodes (rules {r} / AI {a})',
    failed: 'Import failed: {msg}',
    nothing: 'No nodes extracted',
    errLlmUnavailable: 'AI mode is unavailable: the Host has no usable model route. Use rule extraction instead.',
    errNoMessages: 'This workspace has no readable history.',
    errWorkspaceMissing: 'That workspace could not be found; it may have been moved.',
    errNothingExtracted: 'Nothing could be extracted from the history.',
    errMissingDir: 'No workspace was selected.',
    errTreeExists: 'This workspace already has a task tree.',
    errSaveFailed: 'Saving failed; check the Host log.',
    errScanFailed: 'Scanning workspaces failed.',
    closeAfter: 'Done',
    treeDelete: 'Delete whole tree…',
    treeDeleteTitle: 'Delete the entire task tree',
    treeDeleteBody: 'This moves the whole tree of “{name}” ({n} nodes) to the recycle bin, kept {days} days.',
    treeDeleteHint: 'The workspace itself is untouched; it just no longer has a tree.',
    treeDeleteConfirm: 'Delete to recycle bin',
    treeDeleted: 'Whole tree moved to the recycle bin',
    treeRecycle: 'Tree recycle bin',
    treeRecycleEmpty: 'The recycle bin is empty',
    treeRecycleHint: 'Deleted trees wait here for {days} days.',
    treeRestore: 'Restore',
    treePurgeOne: 'Delete forever',
    treePurgeOneTitle: 'Delete this tree permanently',
    treePurgeOneBody: '"{name}" will be deleted for good and cannot be restored.',
    treePurgeOneHint: 'Only the copy in the recycle bin is removed. The workspace stays and can be rebuilt later.',
    treePurgeOneDone: 'Deleted permanently',
    treeRestoreMerge: 'Merge',
    conflictTitle: 'This workspace already has a tree',
    conflictBody: '“{name}” currently has a tree with {n} nodes. Choose how to proceed.',
    conflictOverwrite: 'Overwrite the current tree',
    conflictOverwriteHint: 'The current tree is moved to the recycle bin first, so it stays recoverable.',
    conflictMerge: 'Merge into the current tree',
    conflictMergeHint: 'Incoming nodes are folded in with collision-free ids.',
    confirmTitle: 'Confirm',
    confirmBody: 'About to run “{action}” on “{name}”. This writes memory-tree files to disk.',
    confirmYes: 'Confirm',
    back: 'Back',
    cancel: 'Cancel',
    restoreDone: 'Restored',
    mergeDone: 'Merged',
    purged: 'Purged {n} expired entries',
    deletedShell: 'deleted',
    restoreFromTrash: 'recoverable',
    rebuildHint: 'rebuildable from conversations',
    habitGlobalHint: 'One habit tree is shared by every workspace',
    nodesShort: 'nodes',
    messagesShort: 'messages',
  }

  /* ---------------------------------------------------------------- helpers */

  const fill = (template, values) => String(template || '')
    .replace(/\{(\w+)\}/g, (_, key) => (values?.[key] ?? ''))

  /**
   * Turn a grouping failure into something a user can act on.
   *
   * The route answers `ok:false` with a `reason` rather than an error string, so
   * the panel owns the wording — an enum leaking into a toast ("no_model") tells
   * nobody anything.
   */
  const groupErrorText = (data, t) => {
    switch (data?.reason) {
      case 'no_model': return t.groupNoModel
      case 'model_unusable': return t.groupUnusable
      case 'nothing_to_group': return t.groupNothing
      default:
        if (data?.error === 'groups_disabled') return t.groupDisabled
        return data?.error || t.failed
    }
  }

  /* Storage / retention settings copy. */
  const SET_ZH = {
    settings: '记忆设置',
    settingsTitle: '记忆存储与保留',
    storageRoot: '存储位置',
    storageRootHint: '留空则用默认：DSH home 下的 memory-data。改成别处会立即生效，但已有数据不会自动搬走。',
    storageDefault: '默认位置',
    retention: '保留策略',
    expireDays: '未锁定批次保留天数',
    expireDaysHint: '超过这个天数的记忆批次会被自动清理。0 表示永不清理。',
    quotaMb: '单树空间上限 (MB)',
    quotaHint: '超过上限时从最旧的未锁定批次开始精简。锁定的树不受影响。',
    keepRecent: '精简时至少保留最新批次',
    keepRecentHint: '永远不动最新的这几批，避免把最近的工作删掉。',
    usage: '当前占用',
    batches: '记忆批次',
    batch: '批次',
    locked: '已锁定',
    unlock: '解锁',
    lock: '锁定',
    lockTree: '锁定整棵树',
    unlockTree: '解锁整棵树',
    lockTreeHint: '锁定后该工作区永不被清理，也不参与精简。',
    expiresIn: '还剩 {n} 天',
    expiredNow: '已过期，下次清理会删除',
    neverExpires: '永不清理',
    runExpire: '立即清理过期',
    runCompact: '立即精简到上限',
    migration: '数据迁移',
    migrationHint: '把旧 .memory-tree 目录搬到 memory-data。旧目录保留，可回退。',
    migratePending: '{n} 项待迁移',
    migrateNone: '没有待迁移的数据',
    migrateRun: '开始迁移',
    migrateDone: '迁移完成',
    migrateSkip: '已存在，跳过',
    save: '保存',
    saved: '已保存',
    confirmExpire: '将删除 {n} 个过期批次，共 {size}。确认？',
    confirmCompact: '将从 {n} 个批次释放空间。确认？',
    areYouSure: '确认执行',
    noBatches: '还没有记忆批次',
  }

  const SET_EN = {
    settings: 'Settings',
    settingsTitle: 'Storage and retention',
    storageRoot: 'Storage location',
    storageRootHint: 'Empty uses the default: memory-data inside DSH home. Changing it takes effect immediately; existing data is not moved.',
    storageDefault: 'Default location',
    retention: 'Retention',
    expireDays: 'Keep unlocked batches for (days)',
    expireDaysHint: 'Batches older than this are deleted automatically. 0 means never.',
    quotaMb: 'Per-tree quota (MB)',
    quotaHint: 'Over the quota, the oldest unlocked batches are dropped. Locked trees are exempt.',
    keepRecent: 'Always keep at least this many recent batches',
    keepRecentHint: 'The newest batches are never dropped, so recent work survives a compaction.',
    usage: 'Usage',
    batches: 'Memory batches',
    batch: 'Batch',
    locked: 'Locked',
    unlock: 'Unlock',
    lock: 'Lock',
    lockTree: 'Lock the whole tree',
    unlockTree: 'Unlock the whole tree',
    lockTreeHint: 'A locked workspace is never expired and never compacted.',
    expiresIn: '{n} days left',
    expiredNow: 'Expired — removed on the next sweep',
    neverExpires: 'Never expires',
    runExpire: 'Expire now',
    runCompact: 'Compact to quota',
    migration: 'Migration',
    migrationHint: 'Move the legacy .memory-tree folder into memory-data. The old folder is kept.',
    migratePending: '{n} pending',
    migrateNone: 'Nothing to migrate',
    migrateRun: 'Run migration',
    migrateDone: 'Migration finished',
    migrateSkip: 'already present, skipped',
    save: 'Save',
    saved: 'Saved',
    confirmExpire: 'Delete {n} expired batches ({size}). Confirm?',
    confirmCompact: 'Free space from {n} batches. Confirm?',
    areYouSure: 'Confirm',
    noBatches: 'No batches yet',
  }

  const shortPath = (dir, max = 38) => {
    const value = String(dir || '')
    return value.length <= max ? value : `…${value.slice(-(max - 1))}`
  }

  /* ------------------------------------------------------------ import dialog */

  /**
   * The import flow: pick candidates, pick a method, run.
   *
   * The dialog owns only presentation; every step that touches disk or the model
   * goes through `onRun`, so the page keeps a single place where writes happen.
   */
    function ImportDialog({ h, React, S, t, api, scope, onClose, onDone }) {
      // Hooks come from the caller's guarded set: this file runs in the browser
      // module table, where `React` may expose only a subset of the API.
      const { useState, useEffect, useMemo, useCallback } = React

    const [phase, setPhase] = useState('scan')     // scan | pick | run | done
    const [scanning, setScanning] = useState(true)
    const [candidates, setCandidates] = useState([])
    const [picked, setPicked] = useState(() => new Set())
    const [method, setMethod] = useState('rules')
    const [aiReady, setAiReady] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [result, setResult] = useState(null)

    const habit = scope === 'habit'

    const load = useCallback(async () => {
      setScanning(true)
      setError(null)
      try {
        const response = await fetch(api('/api/scan'), { credentials: 'same-origin' })
        const data = await response.json()
        if (!data.ok) throw new Error(data.error || 'scan_failed')
        // Habit mode ignores whether a task tree exists: it feeds the one habit tree.
        const list = habit ? data.workspaces : data.workspaces.filter((w) => !w.hasTree)
        setCandidates(list)
        setAiReady(data.aiReady === true)
        // Never leave the dialog on a method the Host cannot run.
        if (data.aiReady !== true) setMethod('rules')
        setPhase('pick')
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setScanning(false)
      }
    }, [api, habit])

    useEffect(() => { load() }, [load])

    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onClose, busy])

    const toggle = (dir) => {
      setPicked((prev) => {
        const next = new Set(prev)
        if (next.has(dir)) next.delete(dir)
        else next.add(dir)
        return next
      })
    }

    const total = useMemo(
      () => candidates.filter((w) => picked.has(w.dir)).reduce((sum, w) => sum + w.messageCount, 0),
      [candidates, picked],
    )

    const run = async () => {
      setBusy(true)
      setError(null)
      setResult(null)
      try {
        const targets = [...picked]
        if (!targets.length) { setError(t('pickWorkspace')); return }

        const summaries = []
        for (const dir of targets) {
          // Habit mode writes the shared tree once, from the first picked workspace.
          const response = await fetch(api('/api/import-from-log'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              dir,
              scope: habit ? 'habit' : 'task',
              mode: method,
              confirm: true,
            }),
          })
          const data = await response.json()
          summaries.push({ dir, ...data })
          // The habit tree is global; a second pass would overwrite the first.
          if (habit) break
        }

        const failed = summaries.filter((s) => !s.ok)
        const good = summaries.filter((s) => s.ok)
        setResult({
          ok: good.length > 0,
          nodes: good.reduce((sum, s) => sum + (s.nodes || 0), 0),
          rules: good.reduce((sum, s) => sum + (s.stats?.fromRules || 0), 0),
          ai: good.reduce((sum, s) => sum + (s.stats?.fromAi || 0), 0),
          failed: failed.length,
          // Keep both the code and the human detail: a bare code like
          // `llm_unavailable` told the user nothing about what to do next.
          error: failed[0] ? (failed[0].detail || ERROR_TEXT[failed[0].error]?.(t) || failed[0].error) : null,
          errorCode: failed[0]?.error || null,
        })
        setPhase('done')
        // Even a full failure switches to the done view: the result block is where
        // the reason lives, and staying on the picker made the click look ignored.
        if (good.length) onDone?.()
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setBusy(false)
      }
    }

    const overlay = {
      ...S.modalBg, zIndex: 40,
    }
    const panel = {
      ...S.modal, width: 'min(580px, 94vw)', maxHeight: '82vh',
      display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
    }
    const head = {
      display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0,
      padding: '13px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const body = { overflow: 'auto', padding: '16px 18px 6px', flex: '1 1 auto' }
    const foot = {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '11px 18px', borderTop: '1px solid var(--dsw-alias-border-l1)',
      flexShrink: 0, background: 'var(--dsw-alias-bg-layer-1)',
    }
    const row = {
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px',
      borderRadius: 8, cursor: 'pointer', marginBottom: 5,
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid transparent',
      transition: 'border-color .12s, background .12s',
    }
    const rowOn = {
      border: '1px solid var(--dsw-alias-brand-primary)',
      background: 'var(--dsw-alias-bg-overlay)',
    }
    const sectionLabel = {
      fontSize: 11, fontWeight: 600, letterSpacing: 1.1, textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-secondary)', marginBottom: 8,
    }
    const methodCard = (on) => ({
      flex: '1 1 0', padding: '11px 12px', borderRadius: 9, cursor: 'pointer',
      border: `1px solid ${on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
      background: on ? 'var(--dsw-alias-bg-overlay)' : 'var(--dsw-alias-bg-layer-2)',
      transition: 'border-color .12s',
    })

    return h('div', {
      style: overlay,
      onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
    },
      h('div', { style: panel, role: 'dialog', 'aria-modal': true },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '13px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
            flexShrink: 0,
          },
        },
          h('span', { style: { fontSize: 14, fontWeight: 600 } },
            habit ? t.importHabitTitle : t.importTitle),
          h('button', {
            type: 'button',
            style: { ...S.btn, marginLeft: 'auto', padding: '2px 9px' },
            disabled: busy,
            onClick: onClose,
          }, '✕')),

        h('div', { style: body },
          h('div', { style: { ...S.hint, marginBottom: 12, marginTop: 0 } },
            habit ? t.importHabitSub : t.importSub),

          // method
          h('div', { style: sectionLabel }, t.method),
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 16 } },
            h('div', {
              style: methodCard(method === 'rules'),
              onClick: () => { if (!busy) setMethod('rules') },
            },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 3 } }, t.methodRules),
              h('div', { style: S.hint }, t.methodRulesHint)),
            h('div', {
              style: {
                ...methodCard(method === 'ai'),
                ...(aiReady ? {} : { opacity: 0.55, cursor: 'not-allowed' }),
              },
              onClick: () => { if (!busy && aiReady) setMethod('ai') },
            },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 3 } }, t.methodAi),
              h('div', { style: S.hint }, t.methodAiHint))),

          method === 'ai'
            ? h('div', {
                style: {
                  ...S.hint, marginTop: 0, marginBottom: 12, padding: '7px 10px',
                  borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)',
                },
              }, t.needModel)
            : null,

          // The Host resolves a route on its own, so the only hard requirement is
          // that a route exists at all. Saying so here is cheaper than letting the
          // user pick AI and then reading an error.
          method === 'ai' && !aiReady
            ? h('div', {
                style: {
                  fontSize: 12, marginBottom: 12, padding: '7px 10px', borderRadius: 6,
                  color: 'var(--dsw-alias-state-error-primary)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              }, t.errLlmUnavailable)
            : null,

          // candidates
          h('div', {
            style: { display: 'flex', alignItems: 'center', marginBottom: 8 },
          },
            h('span', { style: sectionLabel },
              habit ? t.pickHabit : t.pickWorkspace),
            h('button', {
              type: 'button',
              style: { ...S.chip, marginLeft: 'auto', ...(scanning || busy ? S.chipDisabled : {}) },
              disabled: scanning || busy,
              onClick: load,
            }, scanning ? t.scanning : `↻ ${t.scan}`)),

          scanning
            ? h('div', { style: S.hint }, t.scanning)
            : candidates.length === 0
              ? h('div', { style: { ...S.hint, padding: '14px 0' } },
                  h('div', null, t.noCandidates),
                  h('div', { style: { marginTop: 5, opacity: 0.8 } }, t.noCandidatesHint))
              : candidates.map((ws) =>
                  h('label', {
                    key: ws.dir,
                    style: { ...row, ...(picked.has(ws.dir) ? rowOn : {}) },
                  },
                    h('input', {
                      type: 'checkbox',
                      checked: picked.has(ws.dir),
                      disabled: busy || habit,
                      onChange: () => toggle(ws.dir),
                      style: { marginTop: 2 },
                    }),
                    h('span', { style: { minWidth: 0, flex: '1 1 auto' } },
                      h('div', { style: { fontSize: 12.5, fontWeight: 500 } }, ws.title),
                      h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } },
                        `${ws.messageCount} ${t.messagesShort} · ${ws.sessions} sessions`),
                      ws.hasTree && !habit
                        ? h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-state-warn-primary)', marginTop: 2 } },
                            t.willOverwrite)
                        : null,
                      habit
                        ? h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } },
                            shortPath(ws.dir))
                        : null),
                  )),

          picked.size
            ? h('div', { style: { ...S.hint, marginTop: 10 } },
                `${picked.size} · ${total} ${t.messagesShort}`)
            : null,

          error
            ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginTop: 10 } },
                error)
            : null),

        h('div', { style: foot },
          // The outcome belongs in the fixed footer, not the scrolling body:
          // a tall candidate list could push a failure notice out of sight, which
          // is exactly how "nothing happened" looked.
          h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, lineHeight: 1.5 } },
            busy
              ? h('span', { style: S.hint }, t.running)
              : result
                ? h('span', {
                    style: {
                      color: result.ok
                        ? 'var(--dsw-alias-brand-primary)'
                        : 'var(--dsw-alias-state-error-primary)',
                    },
                  }, result.ok
                    ? fill(t.doneStats, { n: result.nodes, r: result.rules, a: result.ai })
                    : fill(t.failed, { msg: result.error || t.nothing }))
                : null),
          h('button', {
            type: 'button',
            style: { ...S.chip, ...(busy ? S.chipDisabled : {}) },
            disabled: busy, onClick: onClose,
          }, phase === 'done' ? t.closeAfter : t.cancel),
          h('button', {
            type: 'button',
            style: {
              ...S.chip, ...S.chipOn,
              ...(busy || scanning || !picked.size || phase === 'done' ? S.chipDisabled : {}),
            },
            disabled: busy || scanning || !picked.size || phase === 'done',
            onClick: run,
          }, busy ? t.running : (method === 'ai' ? t.runAi : t.runRules)))),
    )
  }

  /* ------------------------------------------------------------- edit dialog */

  /**
   * Edit one node's title / summary / keywords / importance.
   *
   * Only the four fields the Host's `editNode` accepts are offered; showing a
   * control the backend would ignore is how a form starts lying to its user.
   */
  function EditNodeDialog({ h, React, S, t, node, busy, onCancel, onSave }) {
    const { useState, useEffect } = React

    const [title, setTitle] = useState(node?.title || '')
    const [summary, setSummary] = useState(node?.summary || '')
    const [keywords, setKeywords] = useState((node?.keywords || []).join(', '))
    const [importance, setImportance] = useState(Number(node?.importance ?? 0.6))

    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onCancel, busy])

    const label = { fontSize: 11.5, fontWeight: 600, display: 'block', marginBottom: 4 }
    const field = {
      width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 12.5,
      fontFamily: 'inherit', borderRadius: 6, marginBottom: 12,
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)',
    }

    const submit = () => {
      const patch = {}
      if (title.trim() && title.trim() !== node.title) patch.title = title.trim()
      if (summary.trim() !== String(node.summary || '')) patch.summary = summary.trim()
      const nextKeywords = keywords.split(/[,，]/).map((k) => k.trim()).filter(Boolean).slice(0, 5)
      if (nextKeywords.join('\u0000') !== (node.keywords || []).join('\u0000')) {
        patch.keywords = nextKeywords
      }
      if (Math.abs(Number(importance) - Number(node.importance ?? 0.6)) > 1e-9) {
        patch.importance = Number(importance)
      }
      onSave(patch)
    }

    return h('div', {
      style: { ...S.modalBg, zIndex: 40 },
      onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel() },
    },
      h('div', { style: { ...S.modal, width: 'min(460px, 94vw)' }, role: 'dialog', 'aria-modal': true },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 12 } }, t.edit),

        h('label', { style: label }, t.editTitle),
        h('input', {
          style: field, value: title, maxLength: 20,
          onChange: (event) => setTitle(event.target.value),
        }),

        h('label', { style: label }, t.editSummary),
        h('textarea', {
          style: { ...field, minHeight: 56, resize: 'vertical' }, value: summary, maxLength: 60,
          onChange: (event) => setSummary(event.target.value),
        }),

        h('label', { style: label }, t.editKeywords),
        h('input', {
          style: field, value: keywords,
          onChange: (event) => setKeywords(event.target.value),
        }),

        h('label', { style: label }, `${t.editImportance} — ${Number(importance).toFixed(2)}`),
        h('input', {
          type: 'range', min: 0, max: 1, step: 0.05, value: importance,
          style: { width: '100%', marginBottom: 16 },
          onChange: (event) => setImportance(event.target.value),
        }),

        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: onCancel }, t.cancel),
          h('button', {
            type: 'button',
            style: { ...S.btn, borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
            disabled: busy, onClick: submit,
          }, t.editSave))))
  }

  /* --------------------------------------------------------- data dialog */

  /**
   * Export the current tree as JSON, or paste one back in.
   *
   * Export uses the clipboard where available and falls back to a selectable
   * textarea, because a desktop shell can deny clipboard access and silently
   * failing to copy would look like the button did nothing.
   */
  function DataDialog({ h, React, S, t, tree, onClose, onImport, busy }) {
    const { useState, useEffect, useMemo } = React

    const text = useMemo(() => {
      try { return JSON.stringify(tree || {}, null, 2) } catch { return '{}' }
    }, [tree])

    const [mode, setMode] = useState('view')   // view | paste
    const [draft, setDraft] = useState('')
    const [notice, setNotice] = useState(null)
    const [showRaw, setShowRaw] = useState(false)

    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onClose, busy])

    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text)
        setNotice(t.exportDone)
      } catch {
        // Clipboard denied: reveal the textarea so the user can still copy.
        setShowRaw(true)
        setNotice(t.exportFail)
      }
    }

    const apply = () => {
      const raw = draft.trim()
      if (!raw) { setNotice(t.importBadJson); return }
      let parsed
      try { parsed = JSON.parse(raw) } catch { setNotice(t.importBadJson); return }
      if (!parsed || typeof parsed !== 'object' || !parsed.nodes || typeof parsed.nodes !== 'object') {
        setNotice(t.importBadTree)
        return
      }
      onImport(parsed)
    }

    const area = {
      width: '100%', boxSizing: 'border-box', minHeight: 260, padding: '8px 10px',
      fontSize: 11.5, fontFamily: 'monospace', lineHeight: 1.5, borderRadius: 6,
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)', resize: 'vertical',
    }

    return h('div', {
      style: { ...S.modalBg, zIndex: 40 },
      onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
    },
      h('div', {
        style: { ...S.modal, width: 'min(620px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' },
        role: 'dialog', 'aria-modal': true,
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, t.dataTitle),
          h('span', { style: { marginLeft: 'auto' } }),
          h('button', {
            type: 'button',
            style: { ...S.btn, ...(mode === 'view' ? S.toolOn : {}) },
            onClick: () => { setMode('view'); setNotice(null) },
          }, t.exportJson),
          h('button', {
            type: 'button',
            style: { ...S.btn, ...(mode === 'paste' ? S.toolOn : {}) },
            onClick: () => { setMode('paste'); setNotice(null) },
          }, t.importJson)),

        mode === 'view'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
              showRaw
                ? h('textarea', { style: area, readOnly: true, value: text })
                : h('pre', { style: { ...S.pre, maxHeight: '46vh', overflow: 'auto' } }, text))
          : h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
              h('div', { style: { ...S.hint, marginTop: 0, marginBottom: 8 } }, t.importHint),
              h('textarea', {
                style: area, value: draft, placeholder: '{ "nodes": { … } }',
                onChange: (event) => setDraft(event.target.value),
              })),

        notice
          ? h('div', {
              style: {
                fontSize: 12, marginTop: 8,
                color: mode === 'paste' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
              },
            }, notice)
          : null,

        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } },
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: onClose }, t.close),
          mode === 'view'
            ? h('button', { type: 'button', style: S.btn, onClick: copy }, t.exportJson)
            : h('button', {
                type: 'button',
                style: { ...S.btn, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
                disabled: busy || !draft.trim(),
                onClick: apply,
              }, t.importApply))))
  }

  /* ----------------------------------------------------------- delete dialog */

  /** Confirm throwing a whole workspace tree away. */
  function DeleteTreeDialog({ h, React, S, t, workspace, days, busy, onCancel, onConfirm }) {
    const { useEffect } = React
    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape') onCancel() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    return h('div', { style: S.modalBg, onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel() } },
      h('div', { style: S.modal, role: 'dialog', 'aria-modal': true },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, t.treeDeleteTitle),
        h('div', { style: { fontSize: 12.5, lineHeight: 1.6, marginBottom: 6 } },
          fill(t.treeDeleteBody, { name: workspace.title, n: workspace.nodes, days })),
        h('div', { style: S.hint }, t.treeDeleteHint),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: onCancel }, t.cancel),
          h('button', {
            type: 'button', style: S.btnDanger, disabled: busy, onClick: onConfirm,
          }, t.treeDeleteConfirm))))
  }

  /* ------------------------------------------------------ purge-one dialog */

  /**
   * Confirm permanently deleting one recycle entry.
   *
   * This is the only irreversible action on the recycle bin, so it is its own
   * dialog rather than an inline "are you sure" — the consequences differ from
   * the age-based sweep, which the user may have pressed without reading.
   */
  function PurgeOneDialog({ h, React, S, t, entry, busy, onCancel, onConfirm }) {
    const { useEffect } = React
    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onCancel, busy])

    return h('div', {
      style: { ...S.modalBg, zIndex: 46 },
      onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onCancel() },
    },
      h('div', { style: S.modal, role: 'dialog', 'aria-modal': true },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, t.treePurgeOneTitle),
        h('div', { style: { fontSize: 12.5, lineHeight: 1.6, marginBottom: 6 } },
          fill(t.treePurgeOneBody, { name: entry.title || entry.dir })),
        h('div', { style: S.hint }, t.treePurgeOneHint),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: onCancel }, t.cancel),
          h('button', {
            type: 'button', style: S.btnDanger, disabled: busy, onClick: onConfirm,
          }, t.treePurgeOne))))
  }

  /* --------------------------------------------------------- conflict dialog */  /**
   * Restore conflict: the target already has a tree.
   *
   * Deliberately two steps — pick overwrite/merge, then confirm — because both
   * outcomes rewrite the live tree and one of them discards it.
   */
  function ConflictDialog({ h, React, S, t, entry, liveNodes, busy, onCancel, onResolve }) {
    const { useState, useEffect } = React
    const [mode, setMode] = useState('merge')
    const [confirming, setConfirming] = useState(false)

    useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onCancel, busy])

    const option = (value) => ({
      display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px',
      borderRadius: 8, cursor: 'pointer', marginBottom: 8,
      border: `1px solid ${mode === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
      background: mode === value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
    })

    const actionLabel = mode === 'overwrite' ? t.conflictOverwrite : t.conflictMerge

    return h('div', { style: { ...S.modalBg, zIndex: 45 }, onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onCancel() } },
      h('div', { style: S.modal, role: 'dialog', 'aria-modal': true },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } },
          confirming ? t.confirmTitle : t.conflictTitle),
        h('div', { style: { fontSize: 12.5, lineHeight: 1.6, marginBottom: 12 } },
          confirming
            ? fill(t.confirmBody, { name: entry.title, action: actionLabel })
            : fill(t.conflictBody, { name: entry.title, n: liveNodes })),

        confirming
          ? null
          : h('div', null,
              h('div', {
                style: option('merge'),
                onClick: () => setMode('merge'),
              },
                h('input', { type: 'radio', checked: mode === 'merge', onChange: () => setMode('merge'), style: { marginTop: 2 } }),
                h('span', null,
                  h('div', { style: { fontSize: 12.5 } }, t.conflictMerge),
                  h('div', { style: S.hint }, t.conflictMergeHint))),
              h('div', {
                style: option('overwrite'),
                onClick: () => setMode('overwrite'),
              },
                h('input', { type: 'radio', checked: mode === 'overwrite', onChange: () => setMode('overwrite'), style: { marginTop: 2 } }),
                h('span', null,
                  h('div', { style: { fontSize: 12.5 } }, t.conflictOverwrite),
                  h('div', { style: S.hint }, t.conflictOverwriteHint)))),

        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: onCancel }, t.cancel),
          confirming
            ? h('button', {
                type: 'button', style: S.btn, disabled: busy,
                onClick: () => setConfirming(false),
              }, t.back)
            : null,
          confirming
            ? h('button', {
                type: 'button',
                style: mode === 'overwrite' ? S.btnDanger : S.btn,
                disabled: busy,
                onClick: () => onResolve(mode),
              }, t.confirmYes)
            : h('button', {
                type: 'button', style: S.btn, disabled: busy,
                onClick: () => setConfirming(true),
              }, t.back === 'Back' ? 'Next' : '下一步'))))
  }

  /* ------------------------------------------------ storage settings panel */

  /**
   * Storage location, retention window, quota, batch locks and migration.
   *
   * Everything here writes through the Host's `/api/settings`, `/api/lock`,
   * `/api/retention` and `/api/migrate` routes; the panel itself owns no rules.
   */
  function SettingsPanel({ h, React, S, t, api, dir, onClose, onChanged }) {
    const { useState, useEffect, useCallback } = React

    const [state, setState] = useState(null)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState(null)
    const [rootInput, setRootInput] = useState('')
    const [expireDays, setExpireDays] = useState(180)
    const [quotaMb, setQuotaMb] = useState(50)
    const [keepRecent, setKeepRecent] = useState(3)
    // Grouping preference. `groupModel` is "provider/model" or '' for automatic.
    const [groupEnabled, setGroupEnabled] = useState(true)
    const [groupModel, setGroupModel] = useState('')
    const [models, setModels] = useState([])
    const [confirming, setConfirming] = useState(null)

    const load = useCallback(async () => {
      try {
        const response = await fetch(api(`/api/settings?dir=${encodeURIComponent(dir || '')}`), { credentials: 'same-origin' })
        const data = await response.json()
        setState(data)
        setRootInput(data.root || '')
        const r = data.retention || {}
        setExpireDays(Number(r.expire_days ?? 180))
        setQuotaMb(Math.round(Number(r.quota_bytes ?? 52428800) / 1048576))
        setKeepRecent(Number(r.keep_recent_batches ?? 3))
        // `groups.groups === false` is the persisted "off"; anything else is on.
        const g = data.groups || {}
        setGroupEnabled(g.groups !== false)
        setGroupModel(g.groups_model?.provider
          ? `${g.groups_model.provider}/${g.groups_model.model}`
          : '')
        setModels(Array.isArray(data.groupModels) ? data.groupModels : [])
      } catch (err) {
        setNotice(String(err?.message || err))
      }
    }, [api, dir])

    useEffect(() => { load() }, [load])

    const post = async (tail, body) => {
      setBusy(true)
      try {
        const response = await fetch(api(`/api/${tail}`), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await response.json()
        await load()
        onChanged?.()
        return data
      } catch (err) {
        setNotice(String(err?.message || err))
        return null
      } finally {
        setBusy(false)
      }
    }

    const save = () => post('settings', {
      root: rootInput.trim(),
      retention: {
        expire_days: Number(expireDays) || 0,
        quota_bytes: Math.max(1, Number(quotaMb) || 50) * 1048576,
        keep_recent_batches: Math.max(0, Number(keepRecent) || 0),
      },
      groups: {
        enabled: !!groupEnabled,
        model: groupModel || '',
      },
    }).then((d) => { if (d?.ok) setNotice(t.saved) })

    const mb = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`

    const label = { fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }
    const input = {
      width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 12,
      fontFamily: 'inherit', borderRadius: 6, marginBottom: 4,
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)',
    }
    const block = { marginBottom: 16 }
    const dialog = {
      ...S.modal, width: 'min(560px, 94vw)', maxHeight: '84vh',
      display: 'flex', flexDirection: 'column', padding: 0,
    }
    const body = { overflow: 'auto', padding: '14px 18px', flex: '1 1 auto' }
    const foot = {
      display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center',
      padding: '12px 18px', borderTop: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0,
    }

    if (!state) {
      return h('div', { style: S.modalBg },
        h('div', { style: dialog }, h('div', { style: { ...body, ...S.hint } }, t.loading)))
    }

    const quota = state.quota || { bytes: 0, limit: 1, ratio: 0, over: false }
    const batches = state.batches || []
    const migration = state.migration || { entries: [], pending: 0 }

    return h('div', { style: { ...S.modalBg, zIndex: 40 }, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
      h('div', { style: dialog, role: 'dialog', 'aria-modal': true },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '13px 18px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0,
          },
        },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, t.settingsTitle),
          h('button', {
            type: 'button', style: { ...S.btn, marginLeft: 'auto', padding: '2px 9px' },
            onClick: onClose,
          }, '✕')),

        h('div', { style: body },
          /* storage root */
          h('div', { style: block },
            h('label', { style: label }, t.storageRoot),
            h('input', {
              style: input, value: rootInput, placeholder: t.storageDefault,
              onChange: (e) => setRootInput(e.target.value),
            }),
            h('div', { style: { ...S.hint, marginTop: 0 } }, t.storageRootHint),
            h('div', { style: { ...S.hint, marginTop: 2, fontFamily: 'monospace' } }, state.root || '')),

          /* AI grouping */
          h('div', { style: block },
            h('label', { style: label }, t.aiGrouping),
            h('label', {
              style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' },
            },
              h('input', {
                type: 'checkbox', checked: groupEnabled,
                onChange: (e) => setGroupEnabled(e.target.checked),
              }),
              h('span', null, t.aiGroupingOn)),
            h('div', { style: { ...S.hint, marginTop: 4 } }, t.aiGroupingHint),
            h('label', { style: { ...label, fontWeight: 400, marginTop: 8 } }, t.aiGroupingModel),
            h('select', {
              style: { ...input, cursor: 'pointer' },
              value: groupModel,
              onChange: (e) => setGroupModel(e.target.value),
            },
              h('option', { value: '' }, t.aiGroupingAuto),
              (models || []).map((m) => h('option', { key: m, value: m }, m))),
            h('div', { style: { ...S.hint, marginTop: 2 } }, t.aiGroupingModelHint)),

          /* retention */
          h('div', { style: block },
            h('div', { style: { ...label, marginBottom: 8 } }, t.retention),
            h('div', { style: { display: 'flex', gap: 10, marginBottom: 6 } },
              h('div', { style: { flex: '1 1 0' } },
                h('label', { style: { ...label, fontWeight: 400 } }, t.expireDays),
                h('input', {
                  style: input, type: 'number', min: 0, value: expireDays,
                  onChange: (e) => setExpireDays(e.target.value),
                })),
              h('div', { style: { flex: '1 1 0' } },
                h('label', { style: { ...label, fontWeight: 400 } }, t.quotaMb),
                h('input', {
                  style: input, type: 'number', min: 1, value: quotaMb,
                  onChange: (e) => setQuotaMb(e.target.value),
                })),
              h('div', { style: { flex: '1 1 0' } },
                h('label', { style: { ...label, fontWeight: 400 } }, t.keepRecent),
                h('input', {
                  style: input, type: 'number', min: 0, value: keepRecent,
                  onChange: (e) => setKeepRecent(e.target.value),
                }))),
            h('div', { style: { ...S.hint, marginTop: 0 } }, t.expireDaysHint),
            h('div', { style: { ...S.hint, marginTop: 2 } }, t.quotaHint)),

          /* usage */
          h('div', { style: block },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 } },
              h('span', { style: { fontWeight: 600 } }, t.usage),
              h('span', { style: S.k }, `${mb(quota.bytes)} / ${mb(quota.limit)}`)),
            h('div', {
              style: {
                height: 6, borderRadius: 3, overflow: 'hidden',
                background: 'var(--dsw-alias-bg-layer-2)',
              },
            },
              h('div', {
                style: {
                  height: '100%', width: `${Math.min(100, Math.round(quota.ratio * 100))}%`,
                  background: quota.over ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
                },
              })),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
              h('button', {
                type: 'button', style: S.btn, disabled: busy || !batches.length,
                onClick: () => setConfirming({ kind: 'expire', count: batches.filter((b) => b.expired).length }),
              }, t.runExpire),
              h('button', {
                type: 'button', style: S.btn, disabled: busy || !quota.over,
                onClick: () => setConfirming({ kind: 'compact', count: 0 }),
              }, t.runCompact))),

          /* tree lock */
          h('div', { style: block },
            h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: !!state.locks?.tree,
                onChange: (e) => post('lock', { dir, locked: e.target.checked }),
              }),
              h('span', null, t.lockTree)),
            h('div', { style: { ...S.hint, marginTop: 2 } }, t.lockTreeHint)),

          /* batches */
          h('div', { style: block },
            h('div', { style: { ...label, marginBottom: 6 } }, `${t.batches} (${batches.length})`),
            batches.length === 0
              ? h('div', { style: S.hint }, t.noBatches)
              : batches.map((b) =>
                  h('div', {
                    key: b.name,
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                      borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    },
                  },
                    h('span', { style: { fontSize: 12, fontFamily: 'monospace', flex: '0 0 auto' } }, b.name),
                    h('span', { style: { ...S.k, fontSize: 11, flex: '1 1 auto' } },
                      b.locked ? t.neverExpires
                        : b.expired ? t.expiredNow
                          : b.expires_in_days == null ? t.neverExpires
                            : fill(t.expiresIn, { n: b.expires_in_days })),
                    h('span', { style: { ...S.k, fontSize: 11, minWidth: 46, textAlign: 'right' } }, mb(b.bytes)),
                    h('button', {
                      type: 'button', style: { ...S.link, fontSize: 11.5, minWidth: 30 },
                      disabled: busy,
                      onClick: () => post('lock', { dir, batch: b.name, locked: !b.locked }),
                    }, b.locked ? t.unlock : t.lock)))),

          /* migration */
          migration.pending
            ? h('div', {
                style: {
                  ...block, padding: '9px 11px', borderRadius: 7,
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              },
                h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, t.migration),
                h('div', { style: S.hint }, fill(t.migratePending, { n: migration.pending })),
                h('div', { style: { ...S.hint, marginTop: 2 } }, t.migrationHint),
                h('div', { style: { marginTop: 8 } },
                  h('button', {
                    type: 'button', style: S.btn, disabled: busy,
                    onClick: async () => {
                      const data = await post('migrate', { dir, action: 'run' })
                      if (data?.ok) setNotice(t.migrateDone)
                    },
                  }, t.migrateRun)))
            : null,

          notice
            ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, notice)
            : null),

        h('div', { style: foot },
          h('button', { type: 'button', style: S.btn, onClick: onClose }, t.close),
          h('button', {
            type: 'button',
            style: { ...S.btn, borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
            disabled: busy, onClick: save,
          }, t.save))),

      /* second-step confirmation for a destructive retention action */
      confirming
        ? h('div', { style: { ...S.modalBg, zIndex: 45 } },
            h('div', { style: S.modal, role: 'dialog', 'aria-modal': true },
              h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, t.areYouSure),
              h('div', { style: { fontSize: 12.5, lineHeight: 1.6, marginBottom: 12 } },
                confirming.kind === 'expire'
                  ? fill(t.confirmExpire, { n: confirming.count, size: mb(quota.bytes) })
                  : fill(t.confirmCompact, { n: 0 })),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
                h('button', {
                  type: 'button', style: S.btn, disabled: busy,
                  onClick: () => setConfirming(null),
                }, t.cancel),
                h('button', {
                  type: 'button', style: S.btnDanger, disabled: busy,
                  onClick: async () => {
                    const action = confirming.kind === 'expire' ? 'expire' : 'compact'
                    await post('retention', { dir, action })
                    setConfirming(null)
                  },
                }, t.confirmYes))))
        : null)
  }

  /**
   * The whole-tree recycle bin, rendered inside the side drawer.
   *
   * Each entry is a card rather than a line: it carries two real buttons, and a
   * bare word next to a title reads as a label, not something you can press.
   */
  function TreeRecycleList({ h, S, t, entries, days, busy, onRestore, onPurge }) {
    if (!entries.length) {
      return h('div', { style: { ...S.hint, padding: '18px 4px', textAlign: 'center' } },
        h('div', { style: { fontSize: 12.5, marginBottom: 4 } }, t.treeRecycleEmpty),
        h('div', { style: { opacity: 0.8 } }, fill(t.treeRecycleHint, { days })))
    }

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      entries.map((entry) =>
        h('div', {
          key: entry.entry_id,
          style: {
            padding: '10px 11px', borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 } },
            h('span', {
              style: {
                fontSize: 12.5, fontWeight: 600, flex: '1 1 auto', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, entry.title),
            h('span', {
              style: {
                fontSize: 10.5, flex: '0 0 auto', padding: '1px 7px', borderRadius: 99,
                color: 'var(--dsw-alias-label-secondary)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            }, `${entry.nodes} ${t.nodesShort}`)),
          h('div', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
            String(entry.deleted_at || '').slice(0, 16).replace('T', ' ')),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              type: 'button',
              style: { ...S.chip, ...(busy ? S.chipDisabled : {}) },
              disabled: busy,
              onClick: () => onRestore(entry),
            }, `↩ ${t.treeRestore}`),
            h('button', {
              type: 'button',
              style: { ...S.chip, ...S.chipDanger, ...(busy ? S.chipDisabled : {}) },
              disabled: busy,
              // Permanently drops this one tree immediately, bypassing the
              // retention window. Irreversible, so the caller confirms first.
              onClick: () => onPurge(entry),
            }, `✕ ${t.treePurgeOne}`)))))
  }


    /* ------------------------------------------------------------ pieces */

    function Row({ label, value }) {
      return h('div', { style: S.row },
        h('span', { style: S.k }, label),
        h('span', { style: S.v, title: String(value ?? '') }, value ?? '—'))
    }

    /**
     * A draggable divider. It reports the pane size implied by the pointer, but
     * measured from where the drag actually started, so the pane never jumps to
     * the pointer's absolute screen position.
     *
     * `invert` is for a pane that grows leftward (the right-hand column): there
     * the same pointer delta must shrink the width rather than grow it.
     */
    function Grip({ size, min, max, onResize, title, invert }) {
      const [drag, setDrag] = useState(null)

      useEffect(() => {
        if (!drag) return undefined

        const move = (event) => {
          const delta = (event.clientX - drag.startX) * (invert ? -1 : 1)
          const next = drag.startSize + delta
          onResize(Math.min(max, Math.max(min, next)))
        }
        const up = () => setDrag(null)

        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        // A divider that steals text selection makes dragging feel broken.
        const prevSelect = document.body.style.userSelect
        const prevCursor = document.body.style.cursor
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'

        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.style.userSelect = prevSelect
          document.body.style.cursor = prevCursor
        }
      }, [drag, min, max, onResize, invert])

      return h('div', {
        style: { ...S.grip, background: drag ? 'var(--dsw-alias-brand-primary)' : 'transparent' },
        onMouseDown: (event) => {
          event.preventDefault()
          setDrag({ startX: event.clientX, startSize: size })
        },
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-valuenow': Math.round(size),
        title,
      },
        h('div', {
          style: {
            ...S.gripLine,
            background: drag ? 'var(--dsw-alias-brand-primary)' : undefined,
          },
        }))
    }

    /* ---------------------------------------------------------- main page */

    function MemoryTreePage({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(null)
      const [selectedTree, setSelectedTree] = useState('task')
      const [log, setLog] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const [editing, setEditing] = useState(null)      // { id, title } being edited
      const [dataOpen, setDataOpen] = useState(false)
      const [toast, setToast] = useState(null)
      const [busy, setBusy] = useState(false)

      // Layout: which tree the canvas shows, zoom, rail width, fullscreen.
      // `'task'` by default, `'habit'` when the shared habit tree is opened.
      const [focus, setFocus] = useState('task')
      // `'fit'` means "compute the scale from the box"; a number means the user
      // chose it. Starting in fit mode is what stops a wide tree from opening at
      // an unreadable percentage.
      const [zoom, setZoom] = useState('fit')
      const [railW, setRailW] = useState(208)
      const [full, setFull] = useState(false)

      // The detail panel is an overlay that starts hidden: the tree is the subject.
      const [drawerOpen, setDrawerOpen] = useState(false)

      // Import and whole-tree recycle state.
      const [importScope, setImportScope] = useState(null)   // null | 'task' | 'habit'
      const [trashOpen, setTrashOpen] = useState(false)
      const [trashEntries, setTrashEntries] = useState([])
      const [treeDeleting, setTreeDeleting] = useState(null) // workspace object
      const [treePurging, setTreePurging] = useState(null)    // recycle entry
      const [conflict, setConflict] = useState(null)         // { entry, liveNodes }
      const [settingsOpen, setSettingsOpen] = useState(false)

      // A grouping pass calls the model, so the tool shows it is busy.
      const [grouping, setGrouping] = useState(false)

      // Which bucket is currently being named; shows a spinner on that node.
      const [naming, setNaming] = useState(null)

      // Right-click menu on a workspace row: { ws, x, y } in screen pixels.
      const [rowMenu, setRowMenu] = useState(null)
      const [shellRemoving, setShellRemoving] = useState(null) // ws being dropped

      const [collapsedTask, setCollapsedTask] = useState(() => new Set())
      const [collapsedHabit, setCollapsedHabit] = useState(() => new Set())

      // The refresh timer needs the workspace currently on screen, but `current`
      // is derived later in this component. Reading it from a ref avoids a
      // temporal-dead-zone error and keeps the timer from being re-created.
      const currentRef = useRef(null)

      const load = useCallback(async (dir) => {
        try {
          // Always name the workspace. Without it the Host answers with whichever
          // tree was touched most recently, so a background refresh would silently
          // yank the view to another workspace while the user was panning.
          const target = dir || currentRef.current
          const url = target
            ? apiUrl(`/api/state?dir=${encodeURIComponent(target)}`)
            : apiUrl('/api/state')
          const response = await fetch(url, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState(data)
          // Remember what the Host settled on, so the next refresh asks for the
          // same tree instead of letting the default pick a different one.
          currentRef.current = data?.current || target || null
          setError(null)
        } catch (err) {
          setError(String(err?.message || err))
        }
      }, [])

      useEffect(() => {
        load()
        const onVisible = () => { if (!document.hidden) load() }
        document.addEventListener('visibilitychange', onVisible)
        const timer = setInterval(onVisible, 15000)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          clearInterval(timer)
        }
      }, [load])

      /** Whole trees parked in the trash, refreshed on demand. */
      const loadTrash = useCallback(async () => {
        try {
          const response = await fetch(apiUrl('/api/trash'), { credentials: 'same-origin' })
          const data = await response.json()
          if (data.ok) setTrashEntries(data.entries || [])
        } catch { /* an unreachable trash simply shows as empty */ }
      }, [])

      useEffect(() => {
        loadTrash()
        const timer = setInterval(loadTrash, 30000)
        return () => clearInterval(timer)
      }, [loadTrash])

      // Track fullscreen so the button can flip to "exit".
      useEffect(() => {
        const onChange = () => setFull(!!document.fullscreenElement)
        document.addEventListener('fullscreenchange', onChange)
        return () => document.removeEventListener('fullscreenchange', onChange)
      }, [])

      const toggleFullscreen = useCallback(() => {
        try {
          if (document.fullscreenElement) document.exitFullscreen?.()
          else document.documentElement.requestFullscreen?.()
        } catch { /* a host that forbids fullscreen simply ignores it */ }
      }, [])

      const current = state?.current
      const task = state?.task
      const habit = state?.habit
      const workspaces = state?.workspaces || []

      const matchedIds = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return null
        const out = new Set()
        for (const tree of [task, habit]) {
          for (const [id, node] of Object.entries(tree?.nodes || {})) {
            const hay = `${node.title || ''} ${node.summary || ''} ${(node.keywords || []).join(' ')}`.toLowerCase()
            if (hay.includes(q)) out.add(id)
          }
        }
        return out
      }, [query, task, habit])

      const pick = useCallback(async (tree, id) => {
        setSelectedTree(tree)
        setSelected(id)
        setLog(null)
        // Selecting a node is what summons the overlay.
        setDrawerOpen(true)
        const node = (tree === 'task' ? task : habit)?.nodes?.[id]
        if (!node?.pointer) return
        const dir = tree === 'task' ? current : habit?.dir
        try {
          const response = await fetch(
            apiUrl(`/api/log?dir=${encodeURIComponent(dir)}&pointer=${encodeURIComponent(node.pointer)}&window=6`),
            { credentials: 'same-origin' },
          )
          if (response.ok) setLog(await response.json())
        } catch { /* the detail card just omits the log */ }
      }, [task, habit, current])

      /**
       * POST one action and refresh.
       *
       * Every endpoint needs its own success message: the panel used to show
       * "moved to the recycle bin" for anything that was not `restore`, so
       * locking a tree reported a deletion that never happened.
       */
      const act = useCallback(async (endpoint, body) => {
        setBusy(true)
        try {
          const response = await fetch(apiUrl(`/api/${endpoint}`), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await response.json()
          if (!data.ok) setToast(data.error || 'failed')
          else setToast(TOAST_FOR[endpoint]?.(t, body) || t.deleteDone)
          await load(current)
          return data
        } catch (err) {
          setToast(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }, [current, load, t])

      useEffect(() => {
        if (!toast) return undefined
        const id = setTimeout(() => setToast(null), 2600)
        return () => clearTimeout(id)
      }, [toast])

      // Any press or Escape anywhere closes the row menu: a menu that survives a
      // click outside it makes the next click feel broken.
      useEffect(() => {
        if (!rowMenu) return undefined
        const close = () => setRowMenu(null)
        const onKey = (event) => { if (event.key === 'Escape') close() }
        window.addEventListener('mousedown', close)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [rowMenu])

      const toggleIn = useCallback((setter) => (id) => {
        setter((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      /** Move the current workspace's whole tree into the trash. */
      const deleteWhole = useCallback(async () => {
        if (!treeDeleting) return
        setBusy(true)
        try {
          const response = await fetch(apiUrl('/api/tree-delete'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: treeDeleting.dir, tree: 'task' }),
          })
          const data = await response.json()
          setToast(data.ok ? t.treeDeleted : (data.error || t.failed))
          if (data.ok) {
            setTreeDeleting(null)
            setSelected(null)
            setDrawerOpen(false)
            await load(treeDeleting.dir)
            await loadTrash()
          }
        } catch (err) {
          setToast(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }, [treeDeleting, load, loadTrash, t])

      /** Restore a trashed tree; a live tree in the target raises the conflict dialog. */
      const restoreTree = useCallback(async (entry, mode) => {
        setBusy(true)
        try {
          const response = await fetch(apiUrl('/api/tree-restore'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            // No `dir`: the recycle bin is keyed by entry id and the Host resolves
            // the workspace from the entry itself.
            body: JSON.stringify({ entry_id: entry.entry_id, mode: mode || 'overwrite' }),
          })
          const data = await response.json()

          if (data.ok) {
            setToast(mode === 'merge' ? t.mergeDone : t.restoreDone)
            setConflict(null)
            await load(entry.dir)
            await loadTrash()
            return
          }
          // The server reports the live tree instead of clobbering it.
          if (data.error === 'tree_exists' || data.needsConfirm) {
            setConflict({ entry, liveNodes: data.liveNodes ?? 0 })
            return
          }
          setToast(data.error || t.failed)
        } catch (err) {
          setToast(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }, [load, loadTrash, t])

      // Stable identity: the canvas re-binds its wheel listener on this callback.
      // A wheel event while in `fit` mode has to start from the fitted scale, so
      // the first notch nudges the real value instead of jumping from a marker.
      const zoomBy = useCallback((delta) => setZoom((z) => {
        const base = typeof z === 'number' ? z : 1
        const next = Math.round((base + delta) * 100) / 100
        return Math.min(2.5, Math.max(0.3, next))
      }), [])

      // Switch the canvas between the task tree and the shared habit tree.
      // Not a toggle-to-both: only one tree is ever on screen now, so clicking
      // the active one again would have nothing to fall back to.
      const focusTree = useCallback((which) => {
        setFocus(which === 'habit' ? 'habit' : 'task')
        setZoom('fit')
      }, [])

      /**
       * Ask the model to name one bucket, and let it split the members when they
       * turn out to be different stories. Reloads afterwards so the canvas shows
       * whatever grouping came back.
       *
       * Declared above the early returns with every other hook: putting it below
       * them made the hook count change between the loading render and the ready
       * one, which React reports as error #310 ("rendered more hooks than during
       * the previous render").
       */
      const nameBucketReq = useCallback(async (bucketId, parentId) => {
        if (!bucketId || !parentId) return
        setNaming(bucketId)
        try {
          const response = await fetch(apiUrl('/api/bucket-name'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: current, tree: 'task', parent: parentId, bucket: bucketId }),
          })
          const data = await response.json()
          if (data.ok) {
            const names = Array.isArray(data.titles) ? data.titles.join('、') : ''
            setToast(names ? fill(t.bucketNamed, { names }) : fill(t.groupedDone, { n: data.grouped }))
            await load(current)
          } else {
            setToast(groupErrorText(data, t))
          }
        } catch (err) {
          setToast(String(err?.message || err))
        } finally {
          setNaming(null)
        }
      }, [current, load, t])

      if (error) {
        return h('div', { style: { ...S.page, padding: 24 } },
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } },
            t.loadFail.replace('{msg}', error)))
      }

      if (!state) {
        return h('div', { style: { ...S.page, padding: 24 } }, h('div', { style: S.sub }, t.loading))
      }

      const selNode = selected ? (selectedTree === 'task' ? task : habit)?.nodes?.[selected] : null
      const recycle = [...(task?.recycle || []), ...(habit?.recycle || [])]
      const diag = state.diagnose
      const recycleDays = Number(state.config?.recycle_days ?? 30)
      /** The current workspace's display name, used by the delete dialog. */
      const wsTitle = workspaces.find((w) => w.dir === current)?.title
        || String(current || '').split(/[\\/]/).filter(Boolean).pop()
        || ''
      const taskCount = Object.keys(task?.nodes || {}).length
      const habitCount = Object.keys(habit?.nodes || {}).length

      // One tree at a time. The habit tree is shared by every workspace, so
      // painting it beside each task tree only repeated the same canvas; it now
      // has its own button above the workspace list.
      const showHabit = focus === 'habit'
      const showTask = focus !== 'habit'

      const cardStyle = () => ({
        ...S.treeCard,
        flex: '1 1 auto',
        minHeight: 0,
      })

      /** Detail, diagnosis, brief and recycle bin; rendered inside the overlay. */
      const renderSide = () => h('div', null,
        selNode
          ? h('div', { style: S.card },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } },
                `${TYPE_ICON[selNode.type] || ''} ${selNode.title}`),
              h('div', { style: { marginBottom: 8 } },
                h('span', { style: S.pill }, selectedTree === 'task' ? t.task : t.habit),
                h('span', { style: S.pill }, selNode.type),
                h('span', { style: { ...S.pill, color: tierColor(selNode.tier) } }, selNode.tier)),
              selNode.summary
                ? h('div', { style: { fontSize: 12, lineHeight: 1.55, marginBottom: 8 } }, selNode.summary)
                : null,
              selNode.digest
                ? h('div', { style: { ...S.hint, marginBottom: 8 } }, `${t.digest}: ${selNode.digest}`)
                : null,
              selNode.keywords?.length
                ? h('div', { style: { marginBottom: 8 } },
                    selNode.keywords.map((k) => h('span', { key: k, style: S.pill }, k)))
                : null,
              h(Row, { label: t.score, value: selNode.score }),
              h(Row, { label: t.importance, value: selNode.importance }),
              h(Row, { label: t.access, value: selNode.access_count }),
              h(Row, { label: t.lastAccess, value: selNode.last_access }),
              h(Row, { label: t.status, value: selNode.status }),
              selNode.next_hint
                ? h('div', { style: { ...S.hint, marginTop: 6 } }, `${t.nextHint}: ${selNode.next_hint}`)
                : null,
              selNode.pointer
                ? h('div', { style: { marginTop: 8 } },
                    h('button', {
                      type: 'button', style: S.link,
                      onClick: () => { if (!log) pick(selectedTree, selected) },
                    }, t.openLog),
                    log?.segment ? h('pre', { style: { ...S.pre, marginTop: 6 } }, log.segment) : null,
                  )
                : h('div', { style: S.hint }, t.noLog),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
                h('button', {
                  type: 'button', style: S.btn,
                  onClick: () => setEditing({ id: selNode.id, title: selNode.title }),
                }, t.edit),
                h('button', {
                  type: 'button', style: S.btnDanger,
                  onClick: () => setDeleting({ id: selNode.id, title: selNode.title }),
                }, t.del),
                h('button', {
                  type: 'button', style: S.btn,
                  onClick: () => { setSelected(null); setLog(null); setDrawerOpen(false) },
                }, t.close),
              ),
            )
          : h('div', { style: { ...S.card, ...S.hint } }, t.selectHint),

        diag
          ? h('div', { style: S.card },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 8 } }, t.diagnose),
              !diag.overdue_count && !diag.suspected?.length && !diag.drifting?.length && !diag.stuck?.length
                ? h('div', { style: S.hint }, t.allClear)
                : h('div', null,
                    diag.overdue?.length
                      ? h('div', { style: { marginBottom: 8 } },
                          h('div', { style: S.hint }, `${t.overdue} (${diag.overdue_count})`),
                          diag.overdue.slice(0, 5).map((n) =>
                            h('div', { key: n.id, style: { fontSize: 12, padding: '2px 0' } },
                              `${TYPE_ICON[n.type] || '•'} ${n.title}`)))
                      : null,
                    diag.drifting?.length
                      ? h('div', { style: { marginBottom: 8 } },
                          h('div', { style: S.hint }, t.drifting),
                          diag.drifting.slice(0, 4).map((n) =>
                            h('div', { key: n.id, style: { fontSize: 12, padding: '2px 0' } }, n.title)))
                      : null,
                    diag.suspected?.length
                      ? h('div', { style: { marginBottom: 8 } },
                          h('div', { style: S.hint }, t.suspected),
                          diag.suspected.slice(0, 4).map((n) =>
                            h('div', { key: n.id, style: { fontSize: 12, padding: '2px 0' } }, n.title)))
                      : null,
                    diag.stuck?.length
                      ? h('div', null,
                          h('div', { style: S.hint }, t.stuck),
                          diag.stuck.slice(0, 4).map((n) =>
                            h('div', { key: n.id, style: { fontSize: 12, padding: '2px 0' } }, n.title)))
                      : null,
                  ),
            )
          : null,

        h('div', { style: S.card },
          h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 8 } }, t.brief),
          task?.brief
            ? h('div', null,
                h('pre', { style: S.pre }, task.brief.brief_text),
                task.brief.next_action
                  ? h('div', { style: { ...S.hint, marginTop: 6 } },
                      `${t.nextHint}: ${task.brief.next_action}`)
                  : null)
            : h('div', { style: S.hint }, t.noBrief)),

        h('div', { style: S.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, `${t.recycle} (${recycle.length})`),
            h('button', {
              type: 'button', style: S.btn, disabled: busy,
              onClick: () => act('purge', { tree: 'task', dir: current }),
            }, t.purge)),
          recycle.length
            ? recycle.slice(0, 8).map((entry) =>
                h('div', {
                  key: entry.entry_id,
                  style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '3px 0' },
                },
                  h('span', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    `${entry.title || entry.root_id} (${entry.children_count || 0})`),
                  h('button', {
                    type: 'button', style: S.link, disabled: busy,
                    onClick: () => act('restore', { tree: 'task', dir: current, entry_id: entry.entry_id }),
                  }, t.restore)))
            : h('div', { style: S.hint }, '—')),
      )

      return h('div', { style: S.page },
        /* top bar */
        h('div', { style: S.bar },
          h('span', { style: { fontSize: 15 } }, '🌲'),
          h('div', { style: { minWidth: 0 } },
            h('h1', { style: S.h1 }, t.title),
            h('div', { style: S.sub },
              current ? current.split(/[\\/]/).filter(Boolean).pop() : t.subtitle)),
          h('input', {
            style: S.input,
            placeholder: t.search,
            value: query,
            onChange: (e) => setQuery(e.target.value),
            'aria-label': t.search,
          }),

          /* zoom + focus + detail toggle + fullscreen */
          h('div', { style: S.toolGroup },
            h('button', {
              type: 'button', style: S.tool, title: t.zoomOut,
              onClick: () => zoomBy(-0.1),
            }, '−'),            h('span', { style: S.zoomLabel },
              typeof zoom === 'number' ? `${Math.round(zoom * 100)}%` : t.zoomFit),
            h('button', {
              type: 'button', style: S.tool, title: t.zoomIn,
              onClick: () => zoomBy(0.1),
            }, '+'),
            h('button', {
              type: 'button', style: S.tool, title: t.zoomReset,
              onClick: () => setZoom('fit'),
            }, '⤢'),
          ),
          h('div', { style: S.toolGroup },
            h('button', {
              type: 'button',
              style: { ...S.tool, ...(grouping ? S.toolOn : {}) },
              title: t.groupHint,
              disabled: grouping || busy,
              onClick: async () => {
                setGrouping(true)
                try {
                  const response = await fetch(apiUrl('/api/group'), {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ dir: current, tree: 'task' }),
                  })
                  const data = await response.json()
                  if (data.ok) {
                    setToast(fill(t.groupedDone, { n: data.grouped }))
                    await load(current)
                  } else {
                    setToast(groupErrorText(data, t))
                  }
                } catch (err) {
                  setToast(String(err?.message || err))
                } finally {                  setGrouping(false)
                }
              },
            }, grouping ? '◌' : '✧'),
            h('button', {
              type: 'button',
              style: { ...S.tool, ...(drawerOpen ? S.toolOn : {}) },
              title: drawerOpen ? t.hidePanel : t.showPanel,
              onClick: () => setDrawerOpen((v) => !v),
            }, '☰'),
            h('button', {
              type: 'button', style: { ...S.tool, ...(full ? S.toolOn : {}) },
              title: full ? t.exitFullscreen : t.fullscreen,
              onClick: toggleFullscreen,
            }, full ? '⤡' : '⤢'),
          ),

          /* import + whole-tree recycle */
          h('div', { style: S.toolGroup },
            h('button', {
              type: 'button', style: S.tool, title: t.importWorkspace,
              onClick: () => setImportScope('task'),
            }, '📥'),
            h('button', {
              type: 'button', style: S.tool, title: t.importHabit,
              onClick: () => setImportScope('habit'),
            }, '🧠'),
            h('button', {
              type: 'button',
              style: { ...S.tool, ...(trashOpen ? S.toolOn : {}) },
              title: t.treeRecycle,
              onClick: () => setTrashOpen((v) => !v),
            }, trashEntries.length ? `♻${trashEntries.length}` : '♻'),
            h('button', {
              type: 'button',
              style: { ...S.tool, ...(settingsOpen ? S.toolOn : {}) },
              title: t.settings,
              onClick: () => setSettingsOpen(true),
            }, '⚙'),
            h('button', {
              type: 'button',
              style: { ...S.tool, ...(dataOpen ? S.toolOn : {}) },
              title: t.dataTitle,
              onClick: () => setDataOpen(true),
            }, '⇄'),
          ),
          h('span', { style: S.stat },
            `${t.task} ${taskCount} · ${t.habit} ${habitCount}` +
            (diag?.overdue_count ? ` · ${t.overdue} ${diag.overdue_count}` : '')),
        ),

        h('div', { style: S.body },
          /* workspace rail */
          h('div', { style: { ...S.rail, flex: `0 0 ${railW}px` } },
            /* The habit tree is shared by every workspace, so it lives above the
               list rather than inside each task tree. */
            h('button', {
              type: 'button',
              title: t.habitGlobalHint,
              style: {
                ...S.habitBtn,
                ...(focus === 'habit' ? S.habitBtnOn : {}),
              },
              onClick: () => focusTree('habit'),
            },
              h('span', { style: { fontSize: 13, lineHeight: 1 } }, '🌲'),
              h('span', { style: { flex: '1 1 auto', minWidth: 0, textAlign: 'left' } }, t.habit),
              h('span', { style: { fontSize: 10.5, opacity: 0.75 } }, `${habitCount} ${t.nodes}`)),

            h('div', { style: S.railTitle }, t.workspaces),
            workspaces.length
              ? workspaces.map((ws) =>
                  h('div', {
                    key: ws.dir,
                    style: { ...S.wsRow, ...(ws.dir === current ? S.wsRowOn : {}) },
                    title: ws.dir,
                    // A deleted shell can be dropped from the list; a live tree
                    // cannot, so the menu only offers what actually applies.
                    onContextMenu: (event) => {
                      if (!ws.deleted_at) return
                      event.preventDefault()
                      event.stopPropagation()
                      setRowMenu({ ws, x: event.clientX, y: event.clientY })
                    },
                  },
                    /* The row is a container, not a button: the lock lives beside
                       the label and must not trigger the workspace switch. */
                    h('div', {
                      style: { ...S.wsMain, cursor: 'pointer' },
                      onClick: () => { load(ws.dir); setFocus('task') },
                    },
                      h('div', { style: S.wsName }, ws.title),
                      h('div', { style: S.wsMeta },
                        // A deleted shell has two states worth telling apart: the copy
                        // is still in the recycle bin, or it was purged and the only
                        // way back is rebuilding from the workspace's conversations.
                        ws.deleted_at
                          ? (ws.recoverable
                              ? `${t.deletedShell} · ${t.restoreFromTrash}`
                              : `${t.deletedShell} · ${t.rebuildHint}`)
                          : `${ws.nodes} ${t.nodes} · ${t.hotLayer} ${ws.hot}`)),
                    h('button', {
                      type: 'button',
                      title: ws.locked ? t.unlockTree : t.lockTree,
                      'aria-pressed': !!ws.locked,
                      style: { ...S.wsLock, ...(ws.locked ? S.wsLockOn : {}) },
                      disabled: busy,
                      onMouseDown: (event) => event.stopPropagation(),
                      onClick: async (event) => {
                        event.stopPropagation()
                        // Locking is per workspace, so it must not require opening
                        // that workspace's settings first — the click that changes
                        // it should also switch to it so the state is visible.
                        await act('lock', { dir: ws.dir, locked: !ws.locked })
                        await load(ws.dir)
                      },
                    }, ws.locked ? '🔒' : '🔓'),
                  ))
              : h('div', { style: { ...S.hint, padding: '4px 4px' } },
                  h('div', null, t.noWorkspace),
                  h('div', { style: { marginTop: 6, opacity: 0.8 } }, t.noWorkspaceHint)),
          ),

          h(Grip, {
            size: railW,
            min: 140,
            max: 420,
            title: `${t.workspaces} — ${railW}px`,
            onResize: setRailW,
          }),

          /* tree canvas — clicking its background dismisses the overlay */
          h('div', {
            style: S.canvasArea,
            onMouseDown: (event) => {
              // A press on empty canvas (not on a node or its controls) hides the drawer.
              if (event.target === event.currentTarget) setDrawerOpen(false)
            },
          },
            showHabit
              ? h('div', { style: cardStyle() },
                  h('button', {
                    type: 'button',
                    style: { ...S.treeHead, borderLeft: `3px solid ${HABIT_ACCENT}` },
                    onClick: () => focusTree('habit'),
                    title: t.showHabitTree,
                  },
                    h('span', { style: { fontSize: 13 } }, '🌲'),
                    h('span', { style: { ...S.treeHeadName, color: HABIT_ACCENT } }, t.habit),
                    h('span', { style: S.treeHeadMeta }, `${habitCount} ${t.nodes}`)),
                  h('div', { style: S.treeBody },
                    habit?.exists && habitCount
                      ? h(TreeCanvas, {
                          tree: habit, uid: 'habit', accent: HABIT_ACCENT, zoom, onZoom: zoomBy,
                          onSelect: (id) => pick('habit', id),
                          selectedId: selectedTree === 'habit' ? selected : null,
                          matchedIds,
                          collapsed: collapsedHabit,
                          onToggle: toggleIn(setCollapsedHabit),
                        })
                      : h('div', { style: S.emptyBox },
                          h('div', null, t.empty),
                          h('div', { style: { marginTop: 6, opacity: 0.75 } }, t.emptyHint))),
                )
              : null,

            showTask
              ? h('div', { style: cardStyle() },
                  h('button', {
                    type: 'button',
                    style: { ...S.treeHead, borderLeft: `3px solid ${TASK_ACCENT}` },
                    onClick: () => focusTree('task'),
                    title: t.showTaskTree,
                  },
                    h('span', { style: { fontSize: 13 } }, '🌳'),
                    h('span', { style: { ...S.treeHeadName, color: TASK_ACCENT } }, t.task),
                    h('span', { style: S.treeHeadMeta }, `${taskCount} ${t.nodes}`),
                    taskCount
                      ? h('span', {
                          role: 'button',
                          title: t.treeDelete,
                          style: { fontSize: 12, opacity: 0.7, marginLeft: 6, padding: '0 4px' },
                          onClick: (event) => {
                            event.stopPropagation()
                            setTreeDeleting({ dir: current, title: wsTitle, nodes: taskCount })
                          },
                        }, '🗑')
                      : null),
                  h('div', { style: S.treeBody },
                    task?.exists && taskCount
                      ? h(TreeCanvas, {
                          tree: task, uid: 'task', accent: TASK_ACCENT, zoom, onZoom: zoomBy,
                          onSelect: (id) => pick('task', id),
                          selectedId: selectedTree === 'task' ? selected : null,
                          matchedIds,
                          collapsed: collapsedTask,
                          onToggle: toggleIn(setCollapsedTask),
                          onNameBucket: nameBucketReq,
                          naming,
                        })
                      : h('div', { style: S.emptyBox },
                          h('div', null, t.empty),
                          h('div', { style: { marginTop: 6, opacity: 0.75 } }, t.emptyHint))),
                )
              : null,
          ),

          /* detail overlay — closed by default, opened by selecting a node */
          drawerOpen
            ? h('div', {
                style: {
                  position: 'absolute', top: 0, right: 0, bottom: 0,
                  width: 'min(420px, 46%)', zIndex: 20,
                  display: 'flex', flexDirection: 'column',
                  background: 'var(--dsw-alias-bg-overlay)',
                  borderLeft: '1px solid var(--dsw-alias-border-l2)',
                  boxShadow: '-14px 0 36px rgba(0,0,0,.32)',
                },
              },
                h('div', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', flexShrink: 0,
                    borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  },
                },
                  h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, t.detail),
                  h('button', {
                    type: 'button',
                    style: { ...S.btn, marginLeft: 'auto', padding: '2px 9px' },
                    title: t.hidePanel,
                    // Same reason as the recycle drawer: close on press so a
                    // delegated click that never arrives cannot strand the panel.
                    onMouseDown: (event) => {
                      event.stopPropagation()
                      setDrawerOpen(false)
                    },
                    onClick: () => setDrawerOpen(false),
                  }, '✕')),
                h('div', { style: { overflow: 'auto', padding: 12, flex: '1 1 auto' } },
                  renderSide()),
              )
            : null,
        ),

        deleting
          ? h(DeleteModal, {
              t, node: deleting, tree: task, busy,
              onCancel: () => setDeleting(null),
              onConfirm: async (mode, note) => {
                await act('delete', { tree: 'task', dir: current, id: deleting.id, mode, note })
                setDeleting(null)
                setSelected(null)
                setLog(null)
              },
            })
          : null,

        /* edit one node's title/summary/keywords/importance */
        editing
          ? h(EditNodeDialog, {
              h, React: { useState, useEffect }, S, t,
              node: (selectedTree === 'task' ? task : habit)?.nodes?.[editing.id] || { title: editing.title },
              busy,
              onCancel: () => setEditing(null),
              onSave: async (patch) => {
                if (!Object.keys(patch).length) { setEditing(null); return }
                await act('edit', {
                  tree: selectedTree, dir: selectedTree === 'task' ? current : habit?.dir,
                  id: editing.id, patch,
                })
                setEditing(null)
              },
            })
          : null,

        /* export / import the whole tree as JSON */
        dataOpen
          ? h(DataDialog, {
              h, React: { useState, useEffect, useMemo }, S, t,
              tree: selectedTree === 'task' ? task : habit,
              busy,
              onClose: () => setDataOpen(false),
              onImport: async (incoming) => {
                await act('import', {
                  tree: selectedTree, dir: selectedTree === 'task' ? current : habit?.dir,
                  tree_data: incoming,
                })
                setDataOpen(false)
                setSelected(null)
                setLog(null)
              },
            })
          : null,

        /* whole-tree recycle: a left drawer so the tree keeps its space */
        trashOpen
          ? h('div', {
              style: {
                // Anchored to the body row (which starts below this panel's own
                // toolbar). `0` on both edges keeps the drawer inside the panel
                // instead of riding up over the host's menu strip.
                position: 'absolute', top: 0, left: `${railW}px`, bottom: 0,
                width: 'min(300px, 40%)', zIndex: 20,
                display: 'flex', flexDirection: 'column',
                pointerEvents: 'auto',
                background: 'var(--dsw-alias-bg-overlay)',
                borderRight: '1px solid var(--dsw-alias-border-l2)',
                boxShadow: '14px 0 36px rgba(0,0,0,.32)',
                overflow: 'hidden',
              },
              onMouseDown: (event) => event.stopPropagation(),
            },
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '11px 13px', flexShrink: 0,
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                },
              },
                h('span', { style: { fontSize: 13, fontWeight: 600, letterSpacing: 0.2 } }, `♻ ${t.treeRecycle}`),
                trashEntries.length
                  ? h('span', {
                      style: {
                        fontSize: 10.5, padding: '1px 7px', borderRadius: 99,
                        color: 'var(--dsw-alias-label-secondary)',
                        border: '1px solid var(--dsw-alias-border-l1)',
                      },
                    }, String(trashEntries.length))
                  : null,
                // Close on mousedown: the host React build delegates clicks, and an
                // ancestor that stops mousedown can leave onClick undispatched.
                h('button', {
                  type: 'button',
                  style: { ...S.chip, marginLeft: 'auto', padding: '3px 8px' },
                  onMouseDown: (event) => {
                    event.stopPropagation()
                    setTrashOpen(false)
                  },
                  onClick: () => setTrashOpen(false),
                }, '✕')),
              h('div', { style: { overflow: 'auto', padding: 12, flex: '1 1 auto' } },
                h(TreeRecycleList, {
                  h, S, t, entries: trashEntries, days: recycleDays, busy,
                  onRestore: (entry) => restoreTree(entry),
                  onPurge: (entry) => setTreePurging(entry),
                })),
              h('div', { style: { padding: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0 } },
                h('button', {
                  type: 'button',
                  style: { ...S.btn, width: '100%' },
                  disabled: busy || !trashEntries.length,
                  onClick: async () => {
                    const response = await fetch(apiUrl('/api/tree-purge'), {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ days: recycleDays }),
                    }).then((r) => r.json()).catch(() => null)
                    setToast(fill(t.purged, { n: response?.removed ?? 0 }))
                    await loadTrash()
                  },
                }, `${t.purge} (${recycleDays}d)`)))
          : null,

        /* whole-tree delete confirmation */
        treeDeleting
          ? h(DeleteTreeDialog, {
              h, React: { useEffect }, S, t,
              workspace: treeDeleting,
              days: recycleDays,
              busy,
              onCancel: () => setTreeDeleting(null),
              onConfirm: deleteWhole,
            })
          : null,

        /* permanent removal of one recycled tree, regardless of its age */
        treePurging
          ? h(PurgeOneDialog, {
              h, React: { useEffect }, S, t,
              entry: treePurging,
              busy,
              onCancel: () => setTreePurging(null),
              onConfirm: async () => {
                const target = treePurging
                setTreePurging(null)
                await act('tree-purge', { entry_id: target.entry_id })
                await loadTrash()
              },
            })
          : null,

        /* restore conflict: overwrite or merge, then a second confirmation */
        conflict
          ? h(ConflictDialog, {
              h, React: { useState, useEffect }, S, t,
              entry: conflict.entry,
              liveNodes: conflict.liveNodes,
              busy,
              onCancel: () => setConflict(null),
              onResolve: (mode) => restoreTree(conflict.entry, mode),
            })
          : null,

        /* settings dialog */
        settingsOpen
          ? h(SettingsPanel, {
              h, React: { useState, useEffect, useCallback }, S, t,
              api: apiUrl,
              dir: current,
              onClose: () => setSettingsOpen(false),
              onChanged: async () => { await load(current); await loadTrash() },
            })
          : null,

        /* import dialog */
        importScope
          ? h(ImportDialog, {
              h, React: { useState, useEffect, useMemo, useCallback }, S, t,
              api: apiUrl,
              scope: importScope,
              onClose: () => setImportScope(null),
              onDone: async () => {
                await load(current)
                await loadTrash()
              },
            })
          : null,

        /* right-click menu for a deleted workspace shell */
        rowMenu
          ? h('div', {
              style: { ...S.menu, top: rowMenu.y, left: rowMenu.x },
              onMouseDown: (event) => event.stopPropagation(),
            },
              h('div', {
                style: {
                  fontSize: 10.5, padding: '3px 10px 6px', opacity: 0.7,
                  color: 'var(--dsw-alias-label-secondary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: 240,
                },
              }, rowMenu.ws.title),
              h('button', {
                type: 'button',
                style: { ...S.menuItem, ...S.menuItemDanger },
                onClick: () => { setShellRemoving(rowMenu.ws); setRowMenu(null) },
              }, `✕ ${t.removeShell}`))
          : null,

        /* removing a shell is irreversible for the panel entry, so confirm once */
        shellRemoving
          ? h('div', {
              style: { ...S.modalBg, zIndex: 46 },
              onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) setShellRemoving(null) },
            },
              h('div', { style: S.modal, role: 'dialog', 'aria-modal': true },
                h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, t.removeShellTitle),
                h('div', { style: { fontSize: 12.5, lineHeight: 1.6, marginBottom: 6 } },
                  fill(t.removeShellBody, { name: shellRemoving.title })),
                h('div', { style: S.hint }, t.removeShellHint),
                h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
                  h('button', {
                    type: 'button', style: S.btn, disabled: busy,
                    onClick: () => setShellRemoving(null),
                  }, t.cancel),
                  h('button', {
                    type: 'button', style: S.btnDanger, disabled: busy,
                    onClick: async () => {
                      const target = shellRemoving
                      setShellRemoving(null)
                      await act('shell-remove', { dir: target.dir })
                      await loadTrash()
                    },
                  }, t.removeShell))))
          : null,

        toast
          ? h('div', {
              style: {
                position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
                padding: '8px 16px', borderRadius: 8, fontSize: 12.5, zIndex: 50,
                background: 'var(--dsw-alias-bg-overlay)',
                border: '1px solid var(--dsw-alias-border-l2)',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, toast)
          : null,
      )
    }

    function DeleteModal({ t, node, tree, busy, onCancel, onConfirm }) {
      const [mode, setMode] = useState('subtree')
      const [note, setNote] = useState('')
      const count = useMemo(() => descendantsOf(tree, node.id).length, [tree, node.id])

      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onCancel])

      return h('div', { style: S.modalBg, onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel() } },
        h('div', { style: S.modal, role: 'dialog', 'aria-modal': true, 'aria-label': t.deleteTitle },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, t.deleteTitle),
          h('div', { style: { ...S.hint, marginBottom: 12 } }, node.title),
          h('label', { style: S.label },
            h('input', { type: 'radio', checked: mode === 'subtree', onChange: () => setMode('subtree') }),
            h('span', null,
              h('div', null, t.deleteSubtree),
              h('div', { style: S.hint }, t.deleteSubtreeWarn.replace('{n}', String(count + 1))))),
          h('label', { style: S.label },
            h('input', { type: 'radio', checked: mode === 'self', onChange: () => setMode('self') }),
            h('span', null,
              h('div', null, t.deleteSelf),
              h('div', { style: S.hint }, t.deleteSelfWarn))),
          h('div', { style: { marginTop: 10 } },
            h('textarea', {
              style: S.ta, value: note, placeholder: t.deleteNote,
              onChange: (e) => setNote(e.target.value),
            })),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
            h('button', { type: 'button', style: S.btn, onClick: onCancel }, t.cancel),
            h('button', {
              type: 'button', style: S.btnDanger, disabled: busy,
              onClick: () => onConfirm(mode, note),
            }, t.confirm)),
        ))
    }

    /* ------------------------------------------------------- sidebar icon */

    /**
     * The sidebar owns the button and its navigation: this contribution is the
     * glyph only, so it must not register a click handler of its own.
     */
    function RailIcon({ size, active }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: {
          display: 'block',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        },
      },
        h('path', {
          d: 'M12 21V11M12 13 7 9M12 13l5-4M7 9V5M17 9V5',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none',
          opacity: 0.85,
        }),
        h('circle', { cx: 12, cy: 10.5, r: 2.1, fill: 'currentColor' }),
        h('circle', { cx: 7, cy: 4.4, r: 1.5, fill: 'currentColor', opacity: 0.8 }),
        h('circle', { cx: 17, cy: 4.4, r: 1.5, fill: 'currentColor', opacity: 0.8 }),
      )
    }

    /* --------------------------------------------------------------- apply */

    return {
      // `slots` is the only hard dependency: every other service is read through
      // `ctx.get`, which stays undefined here instead of failing the activation.
      inject: ['slots'],
      apply(ctx) {
        const readLocale = () => {
          try {
            const locale = ctx.get ? ctx.get('locale') : undefined
            const snapshot = locale?.getSnapshot?.() || locale?.getLocale?.()
            return typeof snapshot?.active === 'string' ? snapshot.active : ''
          } catch { return '' }
        }

        // The import/recycle copy lives with its own components; merging it here
        // keeps one dictionary for the whole panel.
        const dictionary = () => (readLocale().toLowerCase().startsWith('en')
          ? { ...EN, ...IMPORT_EN, ...SET_EN }
          : { ...ZH, ...IMPORT_ZH, ...SET_ZH })

        // The owner key names the slot, exactly as every shipped contributor does.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_KEY, order: 40,
          label: () => dictionary().title,
        }, (props) => h(RailIcon, {
          size: props.size || 20,
          active: !!props.active,
        })))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_KEY,
        }, () => h(PanelBoundary, null, h(MemoryTreePage, { t: dictionary() }))))
      },
    }
  },
})

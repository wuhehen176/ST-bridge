const React = require('react')
const h = React.createElement

function renderEndpoints(c) {
  const {
    Field, Check, status, form, endpointBase, setEndpointBase, setField,
    modelCatalog, workspaceOptions, agentPresetField, setNotice, setError, busy, save,
  } = c
  return h('div', { className: 'bbh' },
    h('h3', { className: 'bbh-card-title' }, '插件专属接入地址'),
    h('p', { className: 'bbh-note' }, '每个插件使用独立地址；扩展会带上当前酒馆聊天 ID。模型、预设、工作区和 max_tokens 按插件设置，留空跟随 DSH 默认；已有会话需重置或新建后才切换。开启持续会话时，聊天 ID 只用于快照隔离，不决定共用窗口。'),
    h(Field, { label: '复制地址时使用的电脑地址', hint: '手机请选择能访问的局域网地址，127.0.0.1 只用于电脑本机。' },
      h('select', { className: 'bbh-select', value: endpointBase || status.network?.urls?.[0] || `http://127.0.0.1:${status.service.port}/v1`, onChange: e => setEndpointBase(e.target.value) },
        [...new Set([...(status.network?.urls ?? []), `http://127.0.0.1:${status.service.port}/v1`])].map(value => h('option', { key: value, value }, value)))),
    ...form.clientEndpoints.map((entry, index) => {
      const update = patch => setField('clientEndpoints', form.clientEndpoints.map((item, i) => i === index ? { ...item, ...patch } : item))
      const origin = (endpointBase || status.network?.urls?.[0] || `http://127.0.0.1:${status.service.port}/v1`).replace(/\/v1\/?$/, '')
      const address = `${origin}/clients/${entry.id}/v1`
      const modelValue = entry.provider && entry.model ? JSON.stringify({ provider: entry.provider, model: entry.model }) : ''
      const knownModel = (modelCatalog?.providers ?? []).some(provider =>
        provider.id === entry.provider && provider.models?.some(model => model.id === entry.model))
      const modelOptions = [
        h('option', { key: 'empty', value: '' }, '跟随 DSH 默认'),
        ...(modelValue && !knownModel
          ? [h('option', { key: 'current', value: modelValue }, `${entry.provider} / ${entry.model}（当前）`)]
          : []),
        ...(modelCatalog?.providers ?? []).map(provider => h('optgroup', {
          key: provider.id,
          label: provider.name || provider.id,
        }, ...(provider.models ?? []).map(model => h('option', {
          key: `${provider.id}/${model.id}`,
          value: JSON.stringify({ provider: provider.id, model: model.id }),
          title: model.description || undefined,
        }, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)))),
      ]
      const modelHint = modelCatalog === null
        ? '正在读取 DSH 模型列表…'
        : modelCatalog.available === false
          ? `无法读取 DSH 模型列表：${modelCatalog.error || '未知错误'}`
          : modelCatalog.default
            ? `留空跟随 DSH 默认模型（${modelCatalog.default.provider} / ${modelCatalog.default.model}）。`
            : '留空跟随 DSH 当前默认模型。'
      const knownWorkspace = (workspaceOptions?.workspaces ?? []).some(workspace => workspace.path === entry.cwd)
      const workspaceHint = workspaceOptions === null
        ? '正在读取 DSH 工作区…'
        : workspaceOptions.available === false
          ? `无法读取 DSH 工作区：${workspaceOptions.error || '未知错误'}`
          : '留空使用 DSH 的首个工作区；新会话挂载到所选工作区。'
      return h('div', { className: 'bbh-card', key: index },
        h('div', { className: 'bbh-grid2' },
          h(Field, { label: '显示名称' }, h('input', { className: 'bbh-input', value: entry.label, onChange: e => update({ label: e.target.value }) })),
          h(Field, { label: '唯一插件 ID', hint: '小写字母、数字、下划线或短横线；修改 ID 会使用新的会话范围，旧历史保留。' }, h('input', { className: 'bbh-input', value: entry.id, onChange: e => update({ id: e.target.value }) })),
          h(Field, { label: '默认任务类型' }, h('input', { className: 'bbh-input', value: entry.taskId, onChange: e => update({ taskId: e.target.value }) })),
          h(Field, { label: '专属 Skill（可选）', hint: 'kebab-case 名称；修改后已有会话需重置才能切换。' },
            h('input', { className: 'bbh-input', value: entry.skillId ?? '', onChange: e => update({ skillId: e.target.value.trim() }) }))),
        h('div', { className: 'bbh-grid2' },
          h(Field, { label: '模型', hint: modelHint },
            h('select', {
              className: 'bbh-select',
              value: modelValue,
              onChange: e => {
                if (!e.target.value) return update({ provider: '', model: '' })
                try {
                  const selected = JSON.parse(e.target.value)
                  update({ provider: selected.provider, model: selected.model })
                } catch {
                  update({ provider: '', model: '' })
                }
              },
            }, ...modelOptions)),
          agentPresetField({
            value: entry.agentPreset ?? '',
            onChange: agentPreset => update({ agentPreset }),
          })),
        h('div', { className: 'bbh-grid2' },
          h(Field, { label: '工作区 cwd', hint: workspaceHint },
            h('select', {
              className: 'bbh-select',
              value: entry.cwd ?? '',
              onChange: e => update({ cwd: e.target.value }),
            },
            h('option', { value: '' }, '跟随 DSH 默认'),
            ...(entry.cwd && !knownWorkspace ? [h('option', { key: 'current', value: entry.cwd }, `${entry.cwd}（当前）`)] : []),
            ...(workspaceOptions?.workspaces ?? []).map(workspace => h('option', { key: workspace.path, value: workspace.path }, workspace.name || workspace.path)))),
          h(Field, { label: 'max_tokens', hint: '留空使用模型 / DSH 默认；单次请求携带的 max_tokens 优先。' },
            h('input', { className: 'bbh-input', type: 'number', min: 1, value: entry.maxTokens ?? '', onChange: e => update({ maxTokens: e.target.value }) }))),
        h('div', { className: 'bbh-check-row' },
          h(Check, { label: '启用此接入', checked: entry.enabled, onChange: enabled => update({ enabled }) }),
          h(Check, {
            label: '持续会话',
            checked: entry.persistentSession === true,
            onChange: persistentSession => update({ persistentSession }),
          })),
        h('p', { className: 'bbh-note' }, '持续会话开启后，该插件的所有聊天共用一个 DSH 窗口，固定规则以最后一次同步为准。切换开关会清掉该插件旧窗口；关闭后各聊天从新会话开始，不会恢复旧窗口。'),
        h('input', { className: 'bbh-input', value: address, readOnly: true, 'aria-label': '插件API地址' }),
        h('div', { className: 'bbh-actions' },
          h('button', { type: 'button', className: 'bbh-btn secondary', onClick: async () => {
            try { await navigator.clipboard.writeText(address); setNotice('地址已复制；新增或修改接入后请先保存，再用于插件。') }
            catch { setError('剪贴板不可用，请手动复制上方地址。') }
          } }, '复制 API 地址'),
          h('button', { type: 'button', className: 'bbh-btn secondary', onClick: () => setField('clientEndpoints', form.clientEndpoints.filter((_, i) => i !== index)) }, '删除接入')),
      )
    }),
    h('div', { className: 'bbh-actions' },
      h('button', { type: 'button', className: 'bbh-btn secondary', onClick: () => setField('clientEndpoints', [...form.clientEndpoints, { id: '', label: '', taskId: 'default', skillId: '', enabled: true, persistentSession: false }]) }, '新增插件接入'),
      h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存')),
    h('p', { className: 'bbh-note' }, '停用或删除只影响该地址的新请求，不删除 Agent 历史、不取消正在执行的任务。若设置了允许 client_id 列表，还需允许相应插件 ID。'),
  )
}

module.exports = { renderEndpoints }

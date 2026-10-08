import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse, compileScript } from 'vue/compiler-sfc'
import * as vue from 'vue'
import * as fields from '../../src/utils/familyArchives.js'

// 执行正式 SFC 的 setup 与 Vue watcher，API 延迟仅控制外部响应顺序。
function panel(name, initialProps, familyApi) {
  const source = readFileSync(
    new URL(`../../src/components/family/${name}.vue`, import.meta.url),
    'utf8'
  )
  const { descriptor } = parse(source)
  const script = compileScript(descriptor, { id: name })
    .content.replace(/^import[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace('export default', 'return')
  const cleanups = [],
    downloads = [],
    emitted = []
  const sandbox = {
    ...vue,
    ...fields,
    familyApi,
    Plus: null,
    FamilyChart: null,
    message: { success() {}, error() {}, info() {} },
    onBeforeUnmount: (callback) => cleanups.push(callback),
    downloadFamilyJson: (...args) => downloads.push(args)
  }
  const component = new Function(...Object.keys(sandbox), script)(...Object.values(sandbox))
  const props = vue.reactive(initialProps),
    scope = vue.effectScope()
  const state = scope.run(() =>
    component.setup(props, { expose() {}, emit: (...args) => emitted.push(args) })
  )
  return {
    props,
    state,
    downloads,
    emitted,
    close() {
      cleanups.forEach((callback) => callback())
      scope.stop()
    }
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function member(overrides = {}) {
  return {
    id: 'synthetic-member',
    name: '合成成员',
    version: 1,
    is_self: true,
    is_active: true,
    allowed_fields: ['goal', 'weight'],
    editable_fields: ['goal', 'weight'],
    profile: { goal: '旧目标' },
    ...overrides
  }
}
const emptyMeasurements = { items: [], trend: [], total: 0 }

test('正式档案面板：同成员刷新保留草稿和起始版本，冲突拒写，失权清理草稿', async () => {
  let writes = 0
  const p = panel(
    'FamilyProfilePanel',
    { familyId: 'f', member: member() },
    {
      updateProfile: async () => {
        writes++
      }
    }
  )
  try {
    p.state.openEditor()
    p.state.draft.goal = '未保存目标'
    p.props.member = member({ version: 2, profile: { goal: '远端新目标' } })
    await vue.nextTick()
    assert.equal(p.state.editing.value, true)
    assert.equal(p.state.draft.goal, '未保存目标')
    assert.equal(p.state.baseVersion.value, 1)
    await p.state.save()
    assert.equal(writes, 0)
    p.props.member = member({ allowed_fields: [], editable_fields: [], profile: {} })
    await vue.nextTick()
    assert.equal(p.state.editing.value, false)
    assert.equal('goal' in p.state.draft, false)
    assert.equal('goal' in p.state.original.value, false)
  } finally {
    p.close()
  }
})

test('正式历史面板：乱序分页只展示最后所选页，失权后的迟到响应不得回填', async () => {
  const pending = []
  const p = panel(
    'FamilyProfilePanel',
    { familyId: 'f', member: member() },
    {
      history: () => {
        const request = deferred()
        pending.push(request)
        return request.promise
      }
    }
  )
  try {
    const second = p.state.showHistory(2),
      third = p.state.showHistory(3)
    pending[1].resolve({ items: [{ version: 3 }], total: 80 })
    await third
    pending[0].resolve({ items: [{ version: 2 }], total: 80 })
    await second
    assert.equal(p.state.historyPage.value, 3)
    assert.deepEqual(p.state.history.value, [{ version: 3 }])
    const late = p.state.showHistory(4)
    p.props.member = member({ allowed_fields: [], editable_fields: [], profile: {} })
    await vue.nextTick()
    pending[2].resolve({ items: [{ profile: { goal: '撤权资料' } }], total: 80 })
    await late
    assert.equal(p.state.historyOpen.value, false)
    assert.deepEqual(p.state.history.value, [])
  } finally {
    p.close()
  }
})

test('正式指标面板：刷新保留录入草稿，失权取消在途导出并清理展示', async () => {
  const exported = deferred()
  const p = panel(
    'FamilyMetricsPanel',
    { familyId: 'f', member: member(), revision: 0 },
    {
      measurements: async () => emptyMeasurements,
      exportMeasurements: () => exported.promise
    }
  )
  try {
    await vue.nextTick()
    p.state.openNew()
    p.state.draft.values.weight = 61
    p.props.member = member({ version: 2 })
    p.props.revision++
    await vue.nextTick()
    assert.equal(p.state.dialogOpen.value, true)
    assert.equal(p.state.draft.values.weight, 61)
    const late = p.state.exportRecords()
    p.props.member = member({ allowed_fields: [], editable_fields: [], profile: {} })
    await vue.nextTick()
    exported.resolve({ items: [{ values: { weight: 61 } }], total: 1 })
    await late
    assert.equal(p.downloads.length, 0)
    assert.equal(p.state.dialogOpen.value, false)
    assert.deepEqual(p.state.draft.values, {})
    assert.deepEqual(p.state.records.value, [])
  } finally {
    p.close()
  }
})

test('正式指标面板：最后一个指标撤权，即使kind不变，迟到读取也不能回填', async () => {
  const read = deferred()
  const p = panel(
    'FamilyMetricsPanel',
    { familyId: 'f', member: member(), revision: 0 },
    { measurements: () => read.promise }
  )
  try {
    p.props.member = member({ allowed_fields: [], editable_fields: [], profile: {} })
    await vue.nextTick()
    read.resolve({ items: [{ values: { weight: 61 } }], trend: [], total: 1 })
    await vue.nextTick()
    assert.equal(p.state.kind.value, 'weight')
    assert.deepEqual(p.state.records.value, [])
    assert.equal(p.state.loading.value, false)
  } finally {
    p.close()
  }
})

test('正式授权面板：撤销邀请后迟到生成响应不重新展示失效代码', async () => {
  const invitation = deferred(),
    invited = member({ claimed: false, is_self: false })
  const p = panel(
    'FamilyAuthorizationPanel',
    { family: { id: 'f', members: [invited], is_owner: true } },
    {
      invite: () => invitation.promise,
      revokeInvitation: async () => ({ revoked: true })
    }
  )
  try {
    const pending = p.state.invite(invited)
    await p.state.revokeInvite(invited)
    invitation.resolve({ code: 'synthetic-revoked-code' })
    await pending
    assert.equal(p.state.inviteOpen.value, false)
    assert.equal(p.state.invitation.value, null)
  } finally {
    p.close()
  }
})

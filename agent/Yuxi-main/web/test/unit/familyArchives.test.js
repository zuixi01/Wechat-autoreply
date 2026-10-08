import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMetricSeries,
  profileChanges,
  profileStatus,
  listState,
  profileDraft,
  changedProfile,
  scrubProfileDraft,
  measurementCorrection,
  scrubFamilyAccess
} from '../../src/utils/familyArchives.js'

test('未授权字段不进入档案提交，空值保留为未知', () => {
  assert.deepEqual(profileChanges({ height_cm: null, medical_history: 'private' }, ['height_cm']), {
    height_cm: null
  })
})

test('只更正数值时不重新提交原时间，显式改变时间按北京时间转换', () => {
  const record = { version: 2, measured_at: '2026-10-01T04:12:53.123456Z' }
  const draft = {
    values: { weight: 61 },
    note: '修正',
    source: 'manual',
    condition: '',
    measured_at: '2026-10-01T12:12'
  }
  assert.equal('measured_at' in measurementCorrection(draft, record, draft.measured_at), false)
  assert.equal(
    measurementCorrection({ ...draft, measured_at: '2026-10-01T12:15' }, record, draft.measured_at)
      .measured_at,
    '2026-10-01T04:15:00.000Z'
  )
})

test('其他成员到期或暂时断线只清除其授权投影，保留本人上下文', () => {
  const own = {
    id: 'a',
    is_self: true,
    profile: { goal: '本人草稿依据' },
    allowed_fields: ['goal']
  }
  const other = {
    id: 'b',
    is_self: false,
    profile: { goal: '其他健康信息' },
    allowed_fields: ['goal'],
    editable_fields: ['goal'],
    authorization: { expires_at: '2026-10-01T00:00:00Z' }
  }
  const family = { members: [own, other] }
  const cleaned = scrubFamilyAccess(family, Date.parse('2026-10-02'))
  assert.equal(cleaned.members[0], own)
  assert.deepEqual(cleaned.members[1].profile, {})
  assert.deepEqual(cleaned.members[1].editable_fields, [])
  assert.deepEqual(other.profile, { goal: '其他健康信息' })
  const disconnected = scrubFamilyAccess(family, Date.parse('2026-09-01'), true)
  assert.equal(disconnected.members[0], own)
  assert.deepEqual(disconnected.members[1].allowed_fields, [])
})
test('个人指标按上海日期分组，缺失保留 null，保留每日最近实测', () => {
  const records = [
    { measured_at: '2026-10-01T23:50:00Z', values: { weight: 60 } },
    { measured_at: '2026-10-02T01:00:00Z', values: { weight: 61 } }
  ]
  const series = buildMetricSeries(records, 'weight', ['2026-10-01', '2026-10-02', '2026-10-03'])
  assert.deepEqual(series, [null, 61, null])
})
test('待授权、待补充、待确认和就绪是不同状态', () => {
  assert.equal(profileStatus({ allowed_fields: [], claimed: false }), '待本人认领')
  assert.equal(profileStatus({ allowed_fields: [], claimed: true }), '待授权')
  assert.equal(
    profileStatus({ claimed: true, allowed_fields: ['height_cm'], missing_fields: ['height_cm'] }),
    '待补充'
  )
  assert.equal(
    profileStatus({
      claimed: true,
      allowed_fields: ['height_cm'],
      missing_fields: [],
      confirmed: false
    }),
    '待本人确认'
  )
  assert.equal(
    profileStatus({
      claimed: true,
      allowed_fields: ['height_cm'],
      missing_fields: [],
      ready: true
    }),
    '基础档案已确认'
  )
})

test('未知、确认无与具体条目互不混淆', () => {
  assert.equal(listState(null), 'unknown')
  assert.equal(listState(undefined), 'unknown')
  assert.equal(listState([]), 'none')
  assert.equal(listState(['花生']), 'known')
  assert.deepEqual(changedProfile({ allergens: null }, { allergens: [] }, ['allergens']), {
    allergens: null
  })
})

test('刷新不改变编辑依据，撤权清除草稿和提交字段，无变化不提交', () => {
  const member = { version: 2, profile: { height_cm: 170, allergens: ['花生'], goal: '保持体重' } }
  const captured = profileDraft(member, ['height_cm', 'allergens', 'goal'])
  member.version = 3
  member.profile.allergens.push('牛奶')
  assert.equal(captured.version, 2)
  assert.deepEqual(captured.profile.allergens, ['花生'])
  const draft = { ...captured.profile, height_cm: 171 }
  scrubProfileDraft(draft, ['height_cm', 'goal'])
  assert.equal('allergens' in draft, false)
  assert.deepEqual(changedProfile(draft, captured.profile, ['height_cm', 'goal']), {
    height_cm: 171
  })
  assert.deepEqual(changedProfile(captured.profile, captured.profile, ['height_cm']), {})
})

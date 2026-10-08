/** 家庭档案的字段标签、缺失与统计展示。 */
export const profileLabels = {
  sex: '性别',
  birth_date: '出生日期',
  height_cm: '身高（cm）',
  activity_level: '活动水平',
  goal: '健康目标',
  medical_history: '已知病史',
  medications: '用药信息',
  doctor_instructions: '医嘱',
  allergens: '过敏原',
  avoidances: '忌口',
  preferences: '口味偏好'
}
export const metricDefinitions = {
  weight: { label: '体重', unit: 'kg', fields: { weight: '体重' } },
  blood_pressure: {
    label: '血压',
    unit: 'mmHg',
    fields: { systolic: '收缩压', diastolic: '舒张压' }
  },
  blood_glucose: { label: '血糖', unit: 'mmol/L', fields: { glucose: '血糖' } },
  blood_lipids: {
    label: '血脂四项',
    unit: 'mmol/L',
    fields: { tc: '总胆固醇', tg: '甘油三酯', hdl: '高密度脂蛋白', ldl: '低密度脂蛋白' }
  }
}
export const conditionLabels = { fasting: '空腹', after_meal_2h: '餐后2小时', random: '随机' }
export const sexLabels = { female: '女', male: '男', unspecified: '不填写' }
export const activityLabels = {
  sedentary: '久坐',
  light: '轻度活动',
  moderate: '中度活动',
  high: '高活动量'
}

export function profileChanges(draft, allowed) {
  return Object.fromEntries(Object.entries(draft).filter(([key]) => allowed.includes(key)))
}

export function profileStatus(member) {
  if (!member.claimed) return '待本人认领'
  if (!member.allowed_fields?.length) return '待授权'
  if (member.missing_fields?.length) return '待补充'
  if (member.ready) return '基础档案已确认'
  if (member.confirmed === false) return '待本人确认'
  return '部分字段可见'
}

export function shanghaiDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value))
}

export function formatTime(value) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(value))
    : '未记录'
}

export function buildMetricSeries(records, key, dates) {
  const byDate = new Map()
  for (const record of [...records].sort(
    (a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at)
  )) {
    byDate.set(shanghaiDate(record.measured_at), record.values[key] ?? null)
  }
  return dates.map((date) => byDate.get(date) ?? null)
}

/** 三态列表：空编辑框仍为未知，只有明确选择无才形成空数组。 */
export function listState(value) {
  return !Array.isArray(value) ? 'unknown' : value.length ? 'known' : 'none'
}

/** 捕获编辑时版本与原值，刷新不得悄悄替换写入依据。 */
export function profileDraft(member, keys) {
  return {
    version: member.version,
    profile: Object.fromEntries(
      keys.map((key) => [key, JSON.parse(JSON.stringify(member.profile[key] ?? null))])
    )
  }
}

/** 只提交仍有代维护权限的实际改动；未修改字段不覆盖并发更新。 */
export function changedProfile(draft, original, editable) {
  return Object.fromEntries(
    editable
      .map((key) => [key, draft[key] === '' || draft[key] === undefined ? null : draft[key]])
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key] ?? null))
  )
}

/** 权限缩减时立即移除草稿内失去授权的健康字段。 */
export function scrubProfileDraft(draft, editable) {
  for (const key of Object.keys(draft)) if (!editable.includes(key)) delete draft[key]
}

/** 未修改时间时保留原始秒与微秒，避免表单精度造成隐式更正。 */
export function measurementCorrection(draft, record, initialTime) {
  const payload = {
    expected_version: record.version,
    values: draft.values,
    note: draft.note,
    source: draft.source,
    condition: draft.condition
  }
  if (draft.measured_at !== initialTime)
    payload.measured_at = new Date(draft.measured_at + '+08:00').toISOString()
  return payload
}

/** 仅清理失效成员的授权投影，保留本人及其他成员的编辑上下文。 */
export function scrubFamilyAccess(family, now = Date.now(), unknownAccess = false) {
  if (!family) return family
  return {
    ...family,
    members: family.members.map((member) => {
      const expired = Date.parse(member.authorization?.expires_at) <= now
      if (member.is_self || (!unknownAccess && !expired) || !member.allowed_fields.length)
        return member
      return {
        ...member,
        profile: {},
        allowed_fields: [],
        editable_fields: [],
        missing_fields: [],
        unknown_fields: [],
        confirmed: null,
        confirmed_at: null,
        ready: false,
        authorization: member.authorization
          ? { ...member.authorization, fields: [], edit_fields: [] }
          : null
      }
    })
  }
}

/** 导出仅来自刚完成服务端授权校验的响应。 */
export function downloadFamilyJson(data, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

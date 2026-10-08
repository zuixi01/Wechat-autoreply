<template>
  <section>
    <div class="section-heading">
      <div>
        <h2>{{ member.name }}的健康指标</h2>
        <p class="muted">实测记录 · 单位与测量条件分别保留</p>
      </div>
      <a-button v-if="canWrite" type="primary" class="lucide-icon-btn" @click="openNew"
        ><Plus :size="16" />记录指标</a-button
      >
    </div>
    <a-empty v-if="!available.length" description="当前没有健康指标访问权限，请由成员本人授权。" />
    <template v-else>
      <div class="metric-toolbar">
        <a-select
          v-model:value="kind"
          aria-label="选择健康指标"
          :options="available"
          style="min-width: 145px"
        />
        <a-select
          v-model:value="days"
          aria-label="选择统计期间"
          :options="periods"
          style="width: 115px"
        />
        <a-select
          v-if="kind === 'blood_glucose'"
          v-model:value="condition"
          aria-label="选择血糖测量条件"
          :options="Object.entries(conditionLabels).map(([value, label]) => ({ value, label }))"
          style="width: 130px"
        />
        <span class="muted">时间均按北京时间显示</span>
        <a-input v-model:value="fromDate" type="date" aria-label="起始日期" style="width: 150px" />
        <a-input v-model:value="toDate" type="date" aria-label="结束日期" style="width: 150px" />
        <a-checkbox v-model:checked="includeVoided">包含作废记录</a-checkbox>
        <a-button :loading="exporting" @click="exportRecords">导出所选记录</a-button>
      </div>
      <a-alert v-if="error" type="error" :message="error" show-icon
        ><template #action><a-button @click="load">重试</a-button></template></a-alert
      >
      <a-spin :spinning="loading">
        <p v-if="loading" class="muted">正在加载指标记录…</p>
        <template v-if="!error && !loading">
          <div class="measurement-summary">
            <div>
              <span class="muted">期间记录</span><strong>{{ total }}<small> 条</small></strong>
            </div>
            <div>
              <span class="muted">最近实测</span><strong>{{ latestValue }}</strong>
            </div>
            <div>
              <span class="muted">测量时间</span>
              <p>{{ formatTime(trend.at(-1)?.measured_at) }}</p>
            </div>
          </div>
          <FamilyChart
            v-if="trend.length"
            :dates="dates"
            :series="series"
            :unit="definition.unit"
            :label="member.name + '的' + definition.label + '趋势，仅展示实测数据'"
          />
          <a-empty v-else description="所选期间尚无此类记录，可以手动记录实测值。" />
          <p class="muted chart-note">
            趋势从所选范围的全部有效记录选取每日最近一次实测；缺失日期保留空白，作废记录不参与趋势。
          </p>
          <div class="table-scroll">
            <table class="family-table">
              <thead>
                <tr>
                  <th>测量时间</th>
                  <th>实测值</th>
                  <th>测量条件</th>
                  <th>来源</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in filtered" :key="record.id">
                  <td>{{ formatTime(record.measured_at) }}</td>
                  <td>{{ recordValue(record) }}</td>
                  <td>{{ conditionLabels[record.condition] || '—' }}</td>
                  <td>{{ sourceLabels[record.source] || record.source }}</td>
                  <td>v{{ record.version }}<a-tag v-if="record.voided_at">已作废</a-tag></td>
                  <td>
                    <template v-if="canWrite && !record.voided_at">
                      <a-button type="link" @click="openCorrection(record)">更正</a-button>
                      <a-button type="link" danger @click="openVoid(record)">作废</a-button>
                    </template>
                    <span v-else class="muted">{{
                      record.voided_at ? record.void_reason : '仅查看'
                    }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <a-pagination
            v-if="total > pageSize"
            :current="page"
            :total="total"
            :page-size="pageSize"
            :show-size-changer="false"
            @change="changePage"
          />
        </template>
      </a-spin>
    </template>
    <a-modal
      v-model:open="dialogOpen"
      :title="correcting ? '更正测量记录' : '记录健康指标'"
      :confirm-loading="saving"
      @ok="save"
    >
      <a-form layout="vertical" :model="draft" name="family-measurement">
        <a-form-item label="健康指标">{{ definition.label }} · {{ definition.unit }}</a-form-item>
        <a-form-item
          v-for="(label, key) in definition.fields"
          :name="['values', key]"
          :key="key"
          :label="label + '（' + definition.unit + '）'"
          required
        >
          <a-input-number
            v-model:value="draft.values[key]"
            :min="0.01"
            :step="kind === 'blood_pressure' ? 1 : 0.1"
            style="width: 100%"
          />
        </a-form-item>
        <a-form-item name="measured_at" label="测量时间（北京时间）" required
          ><a-input v-model:value="draft.measured_at" type="datetime-local"
        /></a-form-item>
        <a-form-item v-if="kind === 'blood_glucose'" name="condition" label="测量条件" required>
          <a-select
            v-model:value="draft.condition"
            :options="Object.entries(conditionLabels).map(([value, label]) => ({ value, label }))"
          />
        </a-form-item>
        <a-form-item name="source" label="数据来源"
          ><a-select
            v-model:value="draft.source"
            :options="Object.entries(sourceLabels).map(([value, label]) => ({ value, label }))"
        /></a-form-item>
        <a-form-item name="note" :label="correcting ? '更正说明（必填）' : '备注'"
          ><a-textarea v-model:value="draft.note" :rows="2" :maxlength="1000"
        /></a-form-item>
      </a-form>
      <p v-if="correcting" class="muted">
        更正保留原值、测量时间、来源、条件和操作者，可追溯全部版本。
      </p>
      <a-alert v-if="saveError" type="error" :message="saveError" show-icon />
    </a-modal>
    <a-modal
      v-model:open="voidOpen"
      title="作废测量记录"
      :confirm-loading="saving"
      @ok="voidRecord"
    >
      <p>作废后保留原记录和版本，并从有效记录、趋势及统计中排除。</p>
      <a-form layout="vertical" name="family-measurement-void" :model="{ reason: voidReason }"
        ><a-form-item name="reason" label="作废原因" required
          ><a-textarea v-model:value="voidReason" :maxlength="1000" /></a-form-item
      ></a-form>
      <a-alert v-if="saveError" type="error" :message="saveError" show-icon />
    </a-modal>
    <details
      v-for="record in filtered.filter((row) => row.previous.length)"
      :key="record.id"
      class="correction-history"
    >
      <summary>{{ formatTime(record.measured_at) }}的更正历史</summary>
      <p v-for="old in record.previous" :key="old.version">
        v{{ old.version }}：{{ recordValue({ values: old.values }) }} ·
        {{ formatTime(old.corrected_at) }}
        · {{ old.actor || '家庭成员' }} · {{ formatTime(old.measured_at) }} ·
        {{ sourceLabels[old.source] || old.source }} · {{ conditionLabels[old.condition] || '—' }} ·
        {{ old.note || '无备注' }}
      </p>
    </details>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Plus } from '@lucide/vue'
import { message } from 'ant-design-vue'
import { familyApi } from '@/apis/family_api'
import FamilyChart from './FamilyChart.vue'
import {
  metricDefinitions,
  conditionLabels,
  buildMetricSeries,
  shanghaiDate,
  formatTime,
  downloadFamilyJson,
  measurementCorrection
} from '@/utils/familyArchives'

const props = defineProps({
  familyId: { type: String, required: true },
  member: { type: Object, required: true },
  revision: { type: Number, default: 0 }
})
const emit = defineEmits(['changed'])
const available = computed(() =>
  Object.entries(metricDefinitions)
    .filter(([key]) => props.member.allowed_fields.includes(key))
    .map(([value, item]) => ({ value, label: item.label }))
)
const kind = ref(available.value[0]?.value || 'weight'),
  days = ref(30),
  condition = ref('fasting')
const periods = [
  { value: 7, label: '近7天' },
  { value: 30, label: '近30天' },
  { value: 90, label: '近90天' }
]
const definition = computed(() => metricDefinitions[kind.value])
const canWrite = computed(() => props.member.editable_fields.includes(kind.value))
const initialCorrectionTime = ref('')
const pageSize = 20,
  page = ref(1),
  total = ref(0),
  trend = ref([])
const fromDate = ref(''),
  toDate = ref(''),
  includeVoided = ref(false),
  exporting = ref(false)
const voidOpen = ref(false),
  voidReason = ref(''),
  voidTarget = ref(null)
const records = ref([]),
  loading = ref(false),
  error = ref('')
const dialogOpen = ref(false),
  saving = ref(false),
  saveError = ref(''),
  correcting = ref(null)
const draft = reactive({
  values: {},
  measured_at: '',
  source: 'manual',
  condition: '',
  note: '',
  id: ''
})
defineExpose({
  hasDraft: computed(() => dialogOpen.value || (voidOpen.value && !!voidReason.value))
})
const sourceLabels = {
  manual: '本人/照护人手动录入',
  device: '设备实测后录入',
  report: '检验报告录入'
}
let generation = 0
const filtered = computed(() => records.value)
const dates = computed(() => {
  const end = new Date((toDate.value || shanghaiDate(Date.now())) + 'T00:00:00Z')
  const start = fromDate.value
    ? new Date(fromDate.value + 'T00:00:00Z')
    : new Date(end.getTime() - (days.value - 1) * 86400000)
  const length = Math.min(366, Math.max(0, Math.round((end - start) / 86400000) + 1))
  return Array.from({ length }, (_, index) =>
    new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10)
  )
})
const series = computed(() =>
  Object.entries(definition.value.fields).map(([key, name]) => ({
    name,
    data: buildMetricSeries(trend.value, key, dates.value)
  }))
)
const latestValue = computed(() =>
  trend.value.length ? recordValue(trend.value.at(-1)) : '未记录'
)
function recordValue(record) {
  return (
    Object.entries(definition.value.fields)
      .map(([key, label]) =>
        Object.keys(definition.value.fields).length > 1
          ? label + ' ' + record.values[key]
          : record.values[key]
      )
      .join(' / ') +
    ' ' +
    definition.value.unit
  )
}
async function load() {
  const current = ++generation
  records.value = []
  trend.value = []
  total.value = 0
  error.value = ''
  if (!available.value.some((option) => option.value === kind.value)) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await familyApi.measurements(props.familyId, props.member.id, {
      ...filters(),
      limit: pageSize,
      offset: (page.value - 1) * pageSize
    })
    if (current === generation) {
      records.value = result.items
      total.value = result.total
      trend.value = result.trend
    }
  } catch (cause) {
    if (current === generation) error.value = cause.message
  } finally {
    if (current === generation) loading.value = false
  }
}
watch(
  () => [
    props.familyId,
    kind.value,
    days.value,
    condition.value,
    fromDate.value,
    toDate.value,
    includeVoided.value
  ],
  () => {
    if (!available.value.some((item) => item.value === kind.value))
      kind.value = available.value[0]?.value || 'weight'
    dialogOpen.value = false
    voidOpen.value = false
    draft.values = {}
    draft.note = ''
    correcting.value = null
    page.value = 1
    load()
  },
  { immediate: true }
)
watch(() => props.revision, load)
watch(
  () => props.member,
  (next, previous) => {
    if (previous?.allowed_fields.some((key) => !next.allowed_fields.includes(key))) {
      generation++
      records.value = []
      trend.value = []
      total.value = 0
      loading.value = false
    }
    if (!available.value.some((item) => item.value === kind.value)) {
      kind.value = available.value[0]?.value || 'weight'
      records.value = []
      trend.value = []
      total.value = 0
    }
    if (!canWrite.value) {
      dialogOpen.value = false
      voidOpen.value = false
      draft.values = {}
      draft.note = ''
      draft.measured_at = ''
      correcting.value = null
      voidTarget.value = null
      voidReason.value = ''
    }
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  generation++
  records.value = []
  draft.values = {}
  draft.note = ''
  correcting.value = null
})
function openNew() {
  correcting.value = null
  draft.id = crypto.randomUUID()
  draft.values = Object.fromEntries(Object.keys(definition.value.fields).map((key) => [key, null]))
  draft.measured_at = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date())
    .replace(' ', 'T')
  draft.source = 'manual'
  draft.condition = condition.value
  draft.note = ''
  saveError.value = ''
  dialogOpen.value = true
}
function openCorrection(record) {
  correcting.value = record
  draft.values = { ...record.values }
  draft.measured_at = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(record.measured_at))
    .replace(' ', 'T')
  initialCorrectionTime.value = draft.measured_at
  draft.source = record.source
  draft.condition = record.condition
  draft.note = ''
  saveError.value = ''
  dialogOpen.value = true
}
async function save() {
  if (!canWrite.value) return
  if (Object.values(draft.values).some((value) => !Number.isFinite(value) || value <= 0)) {
    saveError.value = '请填写完整的实测正数'
    return
  }
  if (!draft.measured_at || (correcting.value && !draft.note.trim())) {
    saveError.value = '请填写测量时间或更正说明'
    return
  }
  saving.value = true
  try {
    if (correcting.value)
      await familyApi.correctMeasurement(
        props.familyId,
        props.member.id,
        correcting.value.id,
        measurementCorrection(
          { ...draft, condition: kind.value === 'blood_glucose' ? draft.condition : '' },
          correcting.value,
          initialCorrectionTime.value
        )
      )
    else
      await familyApi.addMeasurement(props.familyId, props.member.id, {
        id: draft.id,
        kind: kind.value,
        values: draft.values,
        measured_at: new Date(draft.measured_at + '+08:00').toISOString(),
        source: draft.source,
        condition: kind.value === 'blood_glucose' ? draft.condition : '',
        note: draft.note
      })
    dialogOpen.value = false
    message.success('记录已保存')
    await load()
    emit('changed')
  } catch (cause) {
    saveError.value =
      cause.status === 409
        ? '记录已有新版本，草稿已保留。请关闭后核对最新记录，再进行更正'
        : cause.message
    if ([403, 409].includes(cause.status)) emit('changed')
  } finally {
    saving.value = false
  }
}
function filters() {
  return {
    kind: kind.value,
    days: days.value,
    condition: kind.value === 'blood_glucose' ? condition.value : undefined,
    from_date: fromDate.value || undefined,
    to_date: toDate.value || undefined,
    include_voided: includeVoided.value
  }
}
function changePage(value) {
  page.value = value
  load()
}
function openVoid(record) {
  voidTarget.value = record
  voidReason.value = ''
  saveError.value = ''
  voidOpen.value = true
}
async function voidRecord() {
  if (!canWrite.value || !voidReason.value.trim()) {
    saveError.value = '请填写作废原因'
    return
  }
  saving.value = true
  try {
    await familyApi.voidMeasurement(props.familyId, props.member.id, voidTarget.value.id, {
      expected_version: voidTarget.value.version,
      reason: voidReason.value.trim()
    })
    voidOpen.value = false
    emit('changed')
    await load()
    message.success('记录已作废，历史仍保留')
  } catch (cause) {
    saveError.value = cause.message
    if ([403, 409].includes(cause.status)) emit('changed')
  } finally {
    saving.value = false
  }
}
async function exportRecords() {
  const current = generation
  exporting.value = true
  try {
    const result = await familyApi.exportMeasurements(props.familyId, props.member.id, filters())
    if (current === generation) downloadFamilyJson(result, '健康指标.json')
  } catch (cause) {
    message.error(cause.message)
    if (cause.status === 403) emit('changed')
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped lang="less">
.metric-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 20px 0;
}
.measurement-summary {
  display: flex;
  gap: 48px;
  margin: 24px 0;
  > div {
    min-width: 100px;
  }
  strong {
    display: block;
    font-size: 22px;
    margin-top: 4px;
    font-weight: 600;
  }
  small {
    font-size: 14px;
  }
}
.chart-note {
  margin: 12px 0;
}
.correction-history {
  border-top: 1px solid var(--gray-150);
  margin-top: 16px;
  padding: 12px 0;
  summary {
    cursor: pointer;
  }
}
@media (max-width: 600px) {
  .measurement-summary {
    flex-wrap: wrap;
    gap: 20px;
  }
}
</style>

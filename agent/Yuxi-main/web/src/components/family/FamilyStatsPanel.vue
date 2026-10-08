<template>
  <section>
    <div class="section-heading">
      <div>
        <h2>家庭统计概览</h2>
        <p class="muted">只统计当前授权可见数据</p>
      </div>
      <a-select
        v-model:value="days"
        aria-label="统计概览期间"
        :options="[
          { value: 7, label: '近7天' },
          { value: 30, label: '近30天' },
          { value: 90, label: '近90天' }
        ]"
        style="width: 115px"
      />
    </div>
    <a-alert v-if="error" type="error" :message="error" show-icon
      ><template #action><a-button @click="load">重试</a-button></template></a-alert
    >
    <a-spin :spinning="loading">
      <template v-if="stats">
        <div class="statistics-strip">
          <div>
            <span>家庭成员</span><strong>{{ stats.member_count }}<small> 人</small></strong>
          </div>
          <div>
            <span>基础档案已确认</span
            ><strong>{{ stats.ready_member_count }}<small> 人</small></strong>
          </div>
          <div>
            <span>期间指标记录</span><strong>{{ stats.record_count }}<small> 条</small></strong>
          </div>
          <div>
            <span>期间记录人数</span
            ><strong>{{ stats.record_member_count }}<small> 人</small></strong>
          </div>
        </div>
        <h3>每日健康指标记录量</h3>
        <FamilyChart
          :dates="stats.daily_counts.map((row) => row.date)"
          :series="[{ name: '记录条数', data: stats.daily_counts.map((row) => row.count) }]"
          label="每天新增的健康指标记录条数，仅代表记录行为"
        />
        <p class="muted">
          记录条数表示有效实测记录。基础档案已确认指基础字段齐全、当前版本经本人确认，并在当前访问范围内；不代表个体化营养任务已就绪。
        </p>
        <div class="metric-counts">
          <span v-for="(count, key) in stats.metric_counts" :key="key"
            >{{ metricDefinitions[key].label }}：{{ count }} 条</span
          >
        </div>
        <p class="muted">
          统计期间 {{ stats.from }} 至 {{ stats.to }}（北京时间） · 截至
          {{ formatTime(stats.as_of) }}
        </p>
      </template>
    </a-spin>
  </section>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { familyApi } from '@/apis/family_api'
import { metricDefinitions, formatTime } from '@/utils/familyArchives'
import FamilyChart from './FamilyChart.vue'
const props = defineProps({
  familyId: { type: String, required: true },
  revision: { type: Number, default: 0 }
})
const days = ref(30),
  stats = ref(null),
  loading = ref(false),
  error = ref('')
let generation = 0
async function load() {
  const current = ++generation
  stats.value = null
  error.value = ''
  loading.value = true
  try {
    const result = await familyApi.statistics(props.familyId, days.value)
    if (current === generation) stats.value = result
  } catch (cause) {
    if (current === generation) error.value = cause.message
  } finally {
    if (current === generation) loading.value = false
  }
}
watch(() => [props.familyId, props.revision, days.value], load, { immediate: true })
onBeforeUnmount(() => {
  generation++
  stats.value = null
})
</script>

<style scoped lang="less">
.statistics-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 24px 0 32px;
  padding: 20px 0;
  border-top: 1px solid var(--gray-150);
  border-bottom: 1px solid var(--gray-150);
  > div {
    padding: 0 24px;
    border-right: 1px solid var(--gray-150);
    &:last-child {
      border: 0;
    }
  }
  span {
    color: var(--gray-600);
  }
  strong {
    display: block;
    font-size: 28px;
    font-weight: 600;
    color: var(--main-color);
  }
  small {
    font-size: 14px;
  }
}
.metric-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin: 20px 0;
}
h3 {
  font-size: 16px;
  font-weight: 600;
}
@media (max-width: 768px) {
  .statistics-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
  }
}
</style>

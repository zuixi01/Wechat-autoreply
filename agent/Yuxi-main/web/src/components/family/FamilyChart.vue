<template>
  <div ref="container" class="family-chart" role="img" :aria-label="label"></div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useThemeStore } from '@/stores/theme'
echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  dates: { type: Array, required: true },
  series: { type: Array, required: true },
  label: { type: String, required: true },
  unit: { type: String, default: '条' }
})
const theme = useThemeStore()
const container = ref(null)
let chart
let observer
function render() {
  if (!chart) return
  const css = getComputedStyle(container.value)
  const text = css.getPropertyValue('--gray-600').trim()
  const border = css.getPropertyValue('--gray-150').trim()
  chart.setOption(
    {
      color: [
        css.getPropertyValue('--chart-palette-1').trim(),
        css.getPropertyValue('--chart-palette-2').trim(),
        css.getPropertyValue('--chart-palette-5').trim(),
        css.getPropertyValue('--chart-palette-6').trim()
      ],
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      legend: { bottom: 0, textStyle: { color: text } },
      grid: { left: 52, right: 20, top: 28, bottom: 55 },
      xAxis: {
        type: 'category',
        data: props.dates,
        axisLabel: { color: text },
        axisLine: { lineStyle: { color: border } }
      },
      yAxis: {
        type: 'value',
        name: props.unit,
        scale: true,
        minInterval: props.unit === '条' ? 1 : undefined,
        axisLabel: { color: text },
        nameTextStyle: { color: text },
        splitLine: { lineStyle: { color: border } }
      },
      series: props.series.map((series) => ({
        ...series,
        type: 'line',
        connectNulls: false,
        smooth: false,
        symbolSize: 6
      }))
    },
    true
  )
}
onMounted(() => {
  chart = echarts.init(container.value)
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(container.value)
  render()
})
watch(
  () => [props.dates, props.series, theme.isDark],
  async () => {
    await nextTick()
    render()
  },
  { deep: true }
)
onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
})
</script>

<style scoped>
.family-chart {
  width: 100%;
  height: 280px;
}
</style>

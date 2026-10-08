<template>
  <section class="profile-panel">
    <div class="section-heading">
      <div>
        <h2>
          {{ member.name }}<span class="muted"> · {{ member.relationship }}</span>
        </h2>
        <p class="muted">档案 v{{ member.version }} · {{ profileStatus(member) }}</p>
      </div>
      <div class="button-group">
        <a-button v-if="editableKeys.length" @click="openEditor">编辑档案</a-button>
        <a-button v-if="member.is_self && !member.confirmed" :loading="saving" @click="confirm"
          >确认当前档案</a-button
        >
      </div>
    </div>
    <a-alert
      v-if="member.missing_fields.length"
      type="warning"
      show-icon
      :message="'待补充：' + member.missing_fields.map((key) => profileLabels[key]).join('、')"
      description="此处仅表示基础资料完整度；个体化营养建议还需核对适用范围、指标与专业规则。"
    />
    <a-empty
      v-if="!visibleKeys.length"
      description="健康档案尚未授权。成员本人认领并授权后才可查看。"
    />
    <dl v-else class="profile-grid">
      <div v-for="key in visibleKeys" :key="key">
        <dt>{{ profileLabels[key] }}</dt>
        <dd>{{ display(key, member.profile[key]) }}</dd>
      </div>
    </dl>
    <div v-if="visibleKeys.length" class="section-footer">
      <a-button type="link" @click="showHistory">查看变更记录</a-button>
      <a-button type="link" @click="exportProfile">导出当前可见档案</a-button>
      <span class="muted">未填写与明确“无”分别保留</span>
    </div>
    <a-modal
      v-model:open="editing"
      title="编辑成员健康档案"
      :confirm-loading="saving"
      @ok="save"
      :width="680"
    >
      <a-alert
        class="form-note"
        type="info"
        show-icon
        message="仅维护当前授权字段。保存后形成新版本，由本人重新确认。"
      />
      <a-form layout="vertical" :model="draft" name="family-profile">
        <a-alert
          v-if="member.version !== baseVersion"
          type="warning"
          show-icon
          message="档案已有新版本，草稿已保留。请核对后重新载入最新档案再编辑。"
        >
          <template #action><a-button @click="openEditor">放弃草稿并载入最新</a-button></template>
        </a-alert>
        <div class="form-grid">
          <a-form-item
            v-for="key in editableKeys"
            :key="key"
            :name="key"
            :label="profileLabels[key]"
          >
            <a-select
              v-if="key === 'sex'"
              v-model:value="draft[key]"
              allow-clear
              :options="Object.entries(sexLabels).map(([value, label]) => ({ value, label }))"
            />
            <a-select
              v-else-if="key === 'activity_level'"
              v-model:value="draft[key]"
              allow-clear
              :options="Object.entries(activityLabels).map(([value, label]) => ({ value, label }))"
            />
            <a-input v-else-if="key === 'birth_date'" v-model:value="draft[key]" type="date" />
            <a-input-number
              v-else-if="key === 'height_cm'"
              v-model:value="draft[key]"
              :min="1"
              :max="300"
            />
            <template v-else-if="['allergens', 'avoidances'].includes(key)">
              <a-select
                :value="listEditing[key] ? 'known' : listState(draft[key])"
                :options="listStates"
                @change="setListState(key, $event)"
              />
              <a-select
                v-if="listState(draft[key]) === 'known' || listEditing[key]"
                :value="draft[key] || []"
                mode="tags"
                placeholder="逐项输入；清空后恢复未知"
                @change="setListItems(key, $event)"
              />
            </template>
            <a-textarea
              v-else
              v-model:value="draft[key]"
              :rows="2"
              :maxlength="key === 'goal' ? 200 : key === 'preferences' ? 500 : 2000"
              placeholder="未填写表示未知；确认没有时请写“无”"
            />
          </a-form-item>
        </div>
      </a-form>
      <a-alert v-if="editError" type="error" :message="editError" show-icon />
    </a-modal>
    <a-drawer v-model:open="historyOpen" title="档案变更记录" width="min(480px, 100vw)">
      <a-spin :spinning="historyLoading">
        <a-alert v-if="historyError" type="error" :message="historyError" />
        <a-empty v-else-if="!historyLoading && !history.length" description="尚无档案变更记录" />
        <section v-for="revision in history" :key="revision.version" class="revision">
          <h3>v{{ revision.version }} · {{ formatTime(revision.created_at) }}</h3>
          <p class="muted">
            {{ revision.actor }} · 本人确认：{{ formatTime(revision.confirmed_at) }}
          </p>
          <p v-for="(change, key) in revision.changes" :key="key">
            {{ profileLabels[key] }}：{{ display(key, change.before) }} →
            {{ display(key, change.after) }}
          </p>
        </section>
        <a-pagination
          v-if="historyTotal > 20"
          :current="historyPage"
          :total="historyTotal"
          :page-size="20"
          :show-size-changer="false"
          @change="showHistory"
        />
      </a-spin>
    </a-drawer>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { familyApi } from '@/apis/family_api'
import {
  profileLabels,
  sexLabels,
  activityLabels,
  profileDraft,
  changedProfile,
  scrubProfileDraft,
  listState,
  downloadFamilyJson,
  profileStatus,
  formatTime
} from '@/utils/familyArchives'

const props = defineProps({
  familyId: { type: String, required: true },
  member: { type: Object, required: true }
})
const emit = defineEmits(['changed'])
const visibleKeys = computed(() =>
  Object.keys(profileLabels).filter((key) => props.member.allowed_fields.includes(key))
)
const editableKeys = computed(() =>
  Object.keys(profileLabels).filter((key) => props.member.editable_fields.includes(key))
)
const baseVersion = ref(0),
  original = ref({}),
  listEditing = reactive({})
const listStates = [
  { value: 'unknown', label: '未知 / 未填写' },
  { value: 'none', label: '本人确认无' },
  { value: 'known', label: '有，逐项填写' }
]
const editing = ref(false),
  saving = ref(false),
  editError = ref('')
const draft = reactive({})
defineExpose({
  hasDraft: computed(
    () =>
      editing.value &&
      Object.keys(changedProfile(draft, original.value, editableKeys.value)).length > 0
  )
})
const historyOpen = ref(false),
  historyLoading = ref(false),
  historyError = ref(''),
  history = ref([]),
  historyTotal = ref(0),
  historyPage = ref(1)
let generation = 0,
  historyRequest = 0
watch(
  () => props.member,
  (next, previous) => {
    const lost = previous?.allowed_fields.some((key) => !next.allowed_fields.includes(key))
    const lostEdit = previous?.editable_fields.some((key) => !next.editable_fields.includes(key))
    if (!lost && !lostEdit) return
    generation++
    scrubProfileDraft(draft, next.editable_fields)
    scrubProfileDraft(original.value, next.editable_fields)
    if (!editableKeys.value.length) editing.value = false
    editError.value = '授权范围已缩减，相关草稿已清除'
    historyOpen.value = false
    history.value = []
  }
)
onBeforeUnmount(() => {
  generation++
  history.value = []
  for (const key of Object.keys(draft)) delete draft[key]
})
function display(key, value) {
  if (value === null || value === undefined || value === '') return '未填写'
  if (Array.isArray(value)) return value.length ? value.join('、') : '已确认无'
  return { sex: sexLabels, activity_level: activityLabels }[key]?.[value] ?? value
}
function openEditor() {
  for (const key of Object.keys(draft)) delete draft[key]
  const captured = profileDraft(props.member, editableKeys.value)
  baseVersion.value = captured.version
  original.value = captured.profile
  Object.assign(draft, structuredClone(captured.profile))
  for (const key of ['allergens', 'avoidances'])
    listEditing[key] = listState(draft[key]) === 'known'
  editError.value = ''
  editing.value = true
}
async function save() {
  if (baseVersion.value !== props.member.version) {
    editError.value = '档案已更新，草稿保留，请核对最新版本'
    return
  }
  saving.value = true
  try {
    const payload = changedProfile(draft, original.value, editableKeys.value)
    if (!Object.keys(payload).length) {
      editing.value = false
      message.info('档案没有变化')
      return
    }
    const result = await familyApi.updateProfile(props.familyId, props.member.id, {
      expected_version: baseVersion.value,
      profile: payload
    })
    editing.value = false
    message.success(
      result.version === baseVersion.value ? '档案没有变化' : '已保存新版本，请由本人核对确认'
    )
    emit('changed')
  } catch (error) {
    editError.value =
      error.status === 409 ? '档案已更新，草稿已保留。请载入最新版本后重新核对' : error.message
    if ([403, 409].includes(error.status)) emit('changed')
  } finally {
    saving.value = false
  }
}
async function confirm() {
  saving.value = true
  try {
    await familyApi.confirm(props.familyId, props.member.id, props.member.version)
    emit('changed')
    message.success('档案已确认')
  } catch (error) {
    message.error(error.message)
  } finally {
    saving.value = false
  }
}
async function showHistory(page = 1) {
  if (typeof page !== 'number') page = 1
  historyPage.value = page
  const current = generation
  const request = ++historyRequest
  historyOpen.value = true
  historyLoading.value = true
  historyError.value = ''
  try {
    const result = await familyApi.history(props.familyId, props.member.id, {
      limit: 20,
      offset: (page - 1) * 20
    })
    if (current === generation && request === historyRequest) {
      history.value = result.items
      historyTotal.value = result.total
    }
  } catch (error) {
    if (current === generation && request === historyRequest) historyError.value = error.message
  } finally {
    if (current === generation && request === historyRequest) historyLoading.value = false
  }
}
async function exportProfile() {
  const current = generation
  try {
    const family = await familyApi.get(props.familyId)
    if (current !== generation) return
    const member = family.members.find((row) => row.id === props.member.id)
    if (!member || !Object.keys(member.profile).length) {
      message.info('当前没有可导出的档案字段')
      emit('changed')
      return
    }
    downloadFamilyJson(
      {
        member: member.name,
        version: member.version,
        confirmed_at: member.confirmed_at,
        profile: member.profile
      },
      '家庭档案.json'
    )
  } catch (error) {
    if (current === generation) message.error(error.message)
  }
}
function setListState(key, state) {
  listEditing[key] = state === 'known'
  draft[key] = state === 'none' ? [] : state === 'known' && draft[key]?.length ? draft[key] : null
}
function setListItems(key, values) {
  draft[key] = values.length ? values : null
}
</script>

<style scoped lang="less">
.profile-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px 32px;
  margin: 24px 0;
  dt {
    color: var(--gray-600);
    font-size: 13px;
  }
  dd {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
}
.section-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  border-top: 1px solid var(--gray-150);
  padding-top: 12px;
}
.revision {
  padding: 16px 0;
  border-bottom: 1px solid var(--gray-150);
  h3 {
    font-size: 14px;
  }
}
.form-note {
  margin-bottom: 20px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 20px;
  :deep(.ant-input-number) {
    width: 100%;
  }
}
@media (max-width: 600px) {
  .profile-grid,
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>

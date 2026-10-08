<template>
  <div class="family-page">
    <PageHeader
      v-model:active-key="activeTab"
      title="家庭档案"
      :tabs="tabs"
      :loading="loading"
      :show-border="true"
      aria-label="家庭档案功能切换"
      @change="changeTab"
    />
    <div class="family-content">
      <div class="family-toolbar">
        <div class="family-context">
          <Users :size="22" />
          <a-select
            v-if="families.length"
            v-model:value="familyId"
            aria-label="选择家庭"
            :options="families.map((row) => ({ value: row.id, label: row.name }))"
            style="min-width: 170px"
            @change="selectFamily"
          />
          <span v-else>管理家人的档案与健康记录</span>
          <a-tag v-if="family">{{ family.is_owner ? '家庭管理员' : '家庭成员' }}</a-tag>
        </div>
        <div class="button-group">
          <a-button @click="joinOpen = true">加入家庭</a-button>
          <a-button v-if="!families.some((row) => row.is_owner)" @click="createOpen = true"
            >创建家庭</a-button
          >
          <a-button
            v-if="family?.is_owner"
            type="primary"
            class="lucide-icon-btn"
            @click="memberOpen = true"
            ><Plus :size="16" />添加成员</a-button
          >
          <a-button v-if="family" aria-label="刷新家庭档案" @click="loadFamily"
            ><RefreshCw :size="16"
          /></a-button>
        </div>
      </div>
      <a-alert v-if="error" type="error" show-icon :message="error" class="page-error">
        <template #action><a-button @click="load">重试</a-button></template>
      </a-alert>
      <a-spin :spinning="loading">
        <a-empty
          v-if="!loading && !error && !families.length"
          description="还没有家庭档案。创建家庭建立本人档案，或使用成员邀请代码加入。"
          class="initial-empty"
        >
          <a-button type="primary" @click="createOpen = true">创建家庭</a-button>
        </a-empty>
        <template v-if="family">
          <p class="scope-note">
            <ShieldCheck :size="15" />仅显示当前授权字段；健康资料不保存在浏览器本地存储。
          </p>
          <FamilyStatsPanel
            v-if="activeTab === 'statistics'"
            :family-id="family.id"
            :revision="revision"
          />
          <FamilyAuthorizationPanel
            ref="authorizationPanel"
            v-else-if="activeTab === 'authorization'"
            :family="family"
            @changed="loadFamily"
          />
          <div v-else class="archive-workspace">
            <aside class="member-sidebar" aria-label="家庭成员">
              <label class="muted" for="member-search"
                >家庭成员 · {{ family.members.length }} 人</label
              >
              <a-input
                id="member-search"
                v-model:value="search"
                placeholder="搜索成员昵称"
                allow-clear
                class="member-search"
              />
              <button
                v-for="item in searchedMembers"
                :key="item.id"
                class="member-row"
                :class="{ selected: memberId === item.id }"
                :aria-pressed="memberId === item.id"
                @click="selectMember(item.id)"
              >
                <span class="member-name"
                  >{{ item.name }}<span v-if="item.is_self" class="self-label">本人</span></span
                >
                <span class="muted">{{ item.relationship }}</span>
                <span class="member-status" :class="{ pending: !item.ready }">{{
                  profileStatus(item)
                }}</span>
              </button>
              <a-empty
                v-if="!searchedMembers.length"
                description="未找到匹配成员"
                :image="Empty.PRESENTED_IMAGE_SIMPLE"
              />
            </aside>
            <div class="member-detail">
              <FamilyProfilePanel
                ref="profilePanel"
                v-if="member && activeTab === 'profiles'"
                :key="member.id"
                :family-id="family.id"
                :member="member"
                @changed="loadFamily"
              />
              <FamilyMetricsPanel
                ref="metricsPanel"
                v-else-if="member"
                :key="member.id"
                :family-id="family.id"
                :member="member"
                :revision="revision"
                @changed="loadFamily"
              />
              <a-empty v-else description="请选择成员查看当前授权内容" />
            </div>
          </div>
        </template>
      </a-spin>
    </div>
    <a-modal v-model:open="createOpen" title="创建家庭" :confirm-loading="saving" @ok="create">
      <a-form layout="vertical"
        ><a-form-item label="家庭名称" required
          ><a-input
            v-model:value="familyName"
            :maxlength="80"
            placeholder="例如：我的家庭" /></a-form-item
      ></a-form>
      <p class="muted">系统会为当前登录账户建立本人档案，其他成员需本人认领和授权。</p>
      <a-alert v-if="formError" type="error" :message="formError" show-icon />
    </a-modal>
    <a-modal
      v-model:open="memberOpen"
      title="添加家庭成员"
      :confirm-loading="saving"
      @ok="addMember"
    >
      <a-form layout="vertical">
        <a-form-item label="成员昵称" required
          ><a-input v-model:value="memberName" :maxlength="80"
        /></a-form-item>
        <a-form-item label="家庭关系" required
          ><a-select
            v-model:value="relationship"
            :options="
              ['配偶', '父亲', '母亲', '其他成年成员'].map((value) => ({
                value,
                label: value
              }))
            "
        /></a-form-item>
      </a-form>
      <p class="muted">
        先添加成员关系，再前往“授权管理”生成邀请，由成员本人登录认领。认领前不能代录健康信息。
      </p>
      <a-alert v-if="formError" type="error" :message="formError" show-icon />
    </a-modal>
    <a-modal v-model:open="joinOpen" title="加入家庭" :confirm-loading="saving" @ok="join">
      <a-form layout="vertical"
        ><a-form-item label="成员邀请代码" required
          ><a-input
            v-model:value="joinCode"
            placeholder="输入家庭管理员发给你的代码" /></a-form-item
      ></a-form>
      <p class="muted">
        此操作将当前账号关联为被邀请的成员。认领后，你可以填写本人档案，并决定向家庭管理员开放哪些字段。
      </p>
      <a-alert v-if="formError" type="error" :message="formError" show-icon />
    </a-modal>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { Empty, Modal, message } from 'ant-design-vue'
import { Plus, RefreshCw, ShieldCheck, Users } from '@lucide/vue'
import { useUserStore } from '@/stores/user'
import { familyApi } from '@/apis/family_api'
import { profileStatus, scrubFamilyAccess } from '@/utils/familyArchives'
import PageHeader from '@/components/shared/PageHeader.vue'
import FamilyProfilePanel from '@/components/family/FamilyProfilePanel.vue'
import FamilyMetricsPanel from '@/components/family/FamilyMetricsPanel.vue'
import FamilyStatsPanel from '@/components/family/FamilyStatsPanel.vue'
import FamilyAuthorizationPanel from '@/components/family/FamilyAuthorizationPanel.vue'

const route = useRoute(),
  router = useRouter(),
  user = useUserStore()
const tabs = [
  { key: 'profiles', label: '成员档案' },
  { key: 'metrics', label: '健康指标' },
  { key: 'statistics', label: '统计概览' },
  { key: 'authorization', label: '授权管理' }
]
const tabFromRoute = () =>
  tabs.some((item) => item.key === route.query.tab) ? route.query.tab : 'profiles'
const activeTab = ref(tabFromRoute())
const families = ref([]),
  family = ref(null),
  familyId = ref(''),
  memberId = ref(''),
  search = ref('')
const loading = ref(false),
  error = ref(''),
  revision = ref(0),
  saving = ref(false),
  formError = ref('')
const createOpen = ref(false),
  memberOpen = ref(false),
  joinOpen = ref(false)
const familyName = ref(''),
  memberName = ref(''),
  relationship = ref('配偶'),
  joinCode = ref('')
const member = computed(() => family.value?.members.find((row) => row.id === memberId.value))
const profilePanel = ref(null),
  metricsPanel = ref(null),
  authorizationPanel = ref(null)
const hasDraft = computed(
  () =>
    profilePanel.value?.hasDraft ||
    metricsPanel.value?.hasDraft ||
    authorizationPanel.value?.hasDraft
)
const searchedMembers = computed(
  () => family.value?.members.filter((row) => row.name.includes(search.value.trim())) || []
)
let generation = 0,
  refreshTimer,
  expiryTimer
watch(
  () => route.query.tab,
  () => {
    activeTab.value = tabFromRoute()
  }
)
watch([createOpen, memberOpen, joinOpen], () => {
  formError.value = ''
})
watch(
  () => user.uid,
  () => {
    generation++
    family.value = null
    families.value = []
    familyId.value = ''
    memberId.value = ''
    clearTimeout(expiryTimer)
    if (user.isLoggedIn) load()
  }
)
function changeTab(item) {
  activeTab.value = tabFromRoute()
  router.replace({ path: '/family', query: { tab: item.key } })
}
function allowDiscard() {
  if (!hasDraft.value) return true
  return new Promise((resolve) =>
    Modal.confirm({
      title: '有未保存的草稿',
      content: '离开当前内容会丢弃草稿，是否继续？',
      okText: '丢弃并继续',
      cancelText: '继续编辑',
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  )
}
async function selectMember(id) {
  if (id !== memberId.value && (await allowDiscard())) memberId.value = id
}
async function selectFamily(id) {
  const previous = family.value?.id || ''
  familyId.value = previous
  if (id !== previous && (await allowDiscard())) {
    familyId.value = id
    await loadFamily()
  }
}
onBeforeRouteLeave(allowDiscard)
onBeforeRouteUpdate((to, from) => (to.query.tab !== from.query.tab ? allowDiscard() : true))
function beforeUnload(event) {
  if (hasDraft.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
async function load() {
  const current = ++generation
  loading.value = true
  error.value = ''
  family.value = null
  try {
    const result = await familyApi.list()
    if (current !== generation) return
    families.value = result
    if (!result.some((row) => row.id === familyId.value)) familyId.value = result[0]?.id || ''
    if (familyId.value) await loadFamily()
  } catch (cause) {
    if (current === generation) error.value = cause.message
  } finally {
    if (current === generation) loading.value = false
  }
}
async function loadFamily() {
  const current = ++generation,
    fid = familyId.value
  if (!fid) return
  if (family.value?.id !== fid) {
    family.value = null
    memberId.value = ''
    search.value = ''
  }
  error.value = ''
  loading.value = true
  try {
    const result = await familyApi.get(fid)
    if (current !== generation || familyId.value !== fid) return
    if (JSON.stringify(result) !== JSON.stringify(family.value)) {
      family.value = result
    }
    revision.value++
    if (!result.members.some((row) => row.id === memberId.value))
      memberId.value = result.members.find((row) => row.is_self)?.id || result.members[0]?.id || ''
    clearTimeout(expiryTimer)
    const expiration = result.members
      .filter((row) => !row.is_self && row.allowed_fields.length)
      .map((row) => Date.parse(row.authorization?.expires_at))
      .filter((time) => time > Date.now())
    if (expiration.length)
      expiryTimer = setTimeout(
        () => {
          family.value = scrubFamilyAccess(family.value)
          revision.value++
          loadFamily()
        },
        Math.min(2147483647, Math.min(...expiration) - Date.now() + 50)
      )
  } catch (cause) {
    if (current === generation) {
      if ([403, 404].includes(cause.status)) {
        family.value = null
        await load()
        return
      }
      family.value = scrubFamilyAccess(family.value, Date.now(), true)
      revision.value++
      error.value = cause.message
    }
  } finally {
    if (current === generation) loading.value = false
  }
}
async function create() {
  if (!familyName.value.trim()) {
    formError.value = '请填写家庭名称'
    return
  }
  saving.value = true
  try {
    const result = await familyApi.create(familyName.value.trim())
    familyId.value = result.id
    createOpen.value = false
    await load()
    message.success('家庭已创建')
  } catch (cause) {
    formError.value = cause.message
  } finally {
    saving.value = false
  }
}
async function addMember() {
  if (!memberName.value.trim()) {
    formError.value = '请填写成员昵称'
    return
  }
  saving.value = true
  try {
    const result = await familyApi.addMember(familyId.value, {
      name: memberName.value.trim(),
      relationship: relationship.value
    })
    memberOpen.value = false
    memberName.value = ''
    await loadFamily()
    memberId.value = result.id
    message.success('已添加成员，请邀请本人认领')
  } catch (cause) {
    formError.value = cause.message
  } finally {
    saving.value = false
  }
}
async function join() {
  if (!joinCode.value.trim()) {
    formError.value = '请填写成员邀请代码'
    return
  }
  saving.value = true
  try {
    const result = await familyApi.join(joinCode.value.trim())
    familyId.value = result.id
    joinOpen.value = false
    joinCode.value = ''
    await load()
    activeTab.value = 'profiles'
    router.replace({ path: '/family', query: { tab: 'profiles' } })
    message.success('已加入家庭，请先补充本人档案，再设置授权')
  } catch (cause) {
    formError.value = cause.message
  } finally {
    saving.value = false
  }
}
function refreshVisible() {
  if (!document.hidden && !loading.value && familyId.value) loadFamily()
}
onMounted(() => {
  load()
  refreshTimer = setInterval(refreshVisible, 30000)
  window.addEventListener('focus', refreshVisible)
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  generation++
  family.value = null
  clearInterval(refreshTimer)
  clearTimeout(expiryTimer)
  window.removeEventListener('focus', refreshVisible)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<style scoped lang="less">
.family-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--gray-900);
  background: var(--gray-0);
}
.family-content {
  flex: 1;
  overflow: auto;
  padding: 24px var(--page-padding);
}
.family-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.family-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.scope-note {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gray-600);
  font-size: 13px;
  margin-bottom: 24px;
}
.page-error {
  margin-bottom: 20px;
}
.initial-empty {
  margin: 100px auto;
  max-width: 450px;
}
.archive-workspace {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 28px;
}
.member-sidebar {
  border-right: 1px solid var(--gray-150);
  padding-right: 24px;
}
.member-search {
  margin: 12px 0;
}
.member-row {
  display: flex;
  width: 100%;
  flex-direction: column;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--gray-900);
  padding: 14px 12px;
  gap: 4px;
  cursor: pointer;
  border-radius: 6px;
  margin-bottom: 4px;
  &:hover {
    background: var(--gray-25);
  }
  &.selected {
    background: var(--main-50);
  }
  &:focus-visible {
    outline: 2px solid var(--main-color);
    outline-offset: 2px;
  }
}
.member-name {
  font-size: 15px;
  font-weight: 600;
  display: flex;
  gap: 8px;
  align-items: center;
}
.self-label {
  font-size: 12px;
  color: var(--main-color);
}
.member-status {
  color: var(--main-color);
  font-size: 12px;
  &.pending {
    color: var(--color-warning-900);
  }
}
.member-detail {
  min-width: 0;
}
:deep(.muted) {
  color: var(--gray-600);
  font-size: 13px;
}
:deep(.button-group) {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
:deep(.section-heading) {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }
  p {
    margin-top: 6px;
  }
}
:deep(.table-scroll) {
  overflow-x: auto;
  margin-top: 24px;
}
:deep(.family-table) {
  width: 100%;
  border-collapse: collapse;
  min-width: 550px;
  text-align: left;
  th {
    color: var(--gray-600);
    background: var(--gray-25);
    font-size: 13px;
  }
  th,
  td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--gray-150);
  }
  td {
    font-size: 14px;
  }
}
@media (max-width: 900px) {
  .archive-workspace {
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 20px;
  }
  .member-sidebar {
    padding-right: 16px;
  }
}
@media (max-width: 650px) {
  .archive-workspace {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .member-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--gray-150);
    padding: 0 0 16px;
  }
  .member-row {
    display: inline-flex;
    width: calc(50% - 4px);
    vertical-align: top;
  }
  .scope-note {
    align-items: flex-start;
  }
  :deep(.page-header) {
    height: auto;
    min-height: 48px;
    padding: 10px var(--page-padding);
  }
  :deep(.page-header-left) {
    flex-wrap: wrap;
    gap: 10px;
  }
  :deep(.page-header-tabs) {
    padding-left: 0;
    margin-left: 0;
    border-left: 0;
    height: auto;
    flex-wrap: wrap;
    flex-shrink: 1;
    max-width: 100%;
  }
}
</style>

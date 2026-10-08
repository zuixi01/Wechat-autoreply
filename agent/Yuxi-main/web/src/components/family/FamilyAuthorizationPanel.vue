<template>
  <section>
    <div class="section-heading">
      <div>
        <h2>成员授权管理</h2>
        <p class="muted">家庭营养管理用途 · 分别控制查看和代维护权限</p>
      </div>
    </div>
    <a-alert
      type="info"
      show-icon
      message="成员本人认领后决定开放范围，家庭管理员身份不自动授予健康详情权限。"
    />
    <div class="table-scroll">
      <table class="family-table">
        <thead>
          <tr>
            <th>成员</th>
            <th>状态与访问范围</th>
            <th>有效期</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="member in [...family.members, ...(family.inactive_members || [])]"
            :key="member.id"
          >
            <td>
              {{ member.name }}<span class="muted"> · {{ member.relationship }}</span>
            </td>
            <td>
              <a-tag v-if="!member.is_active">已退出 / 停用</a-tag
              >{{
                member.is_self
                  ? '本人数据'
                  : !member.claimed
                    ? '等待本人认领'
                    : member.allowed_fields.length
                      ? member.allowed_fields.map(label).join('、')
                      : '待授权或已失效'
              }}
              <p v-if="!member.is_self && member.editable_fields.length" class="muted">
                可代维护：{{ member.editable_fields.map(label).join('、') }}
              </p>
            </td>
            <td>
              {{
                member.authorization?.expires_at ? formatTime(member.authorization.expires_at) : '—'
              }}
            </td>
            <td>
              <a-button
                v-if="member.is_self && !family.is_owner && member.is_active"
                type="link"
                @click="edit(member)"
                >管理我的授权</a-button
              >
              <span v-else-if="member.is_self" class="muted">本人可管理自身数据</span>
              <a-button
                v-else-if="family.is_owner && !member.claimed && member.is_active"
                type="link"
                :loading="inviting"
                :disabled="inviting"
                @click="invite(member)"
                >生成邀请</a-button
              >
              <span v-else class="muted">由成员本人管理</span>
              <div v-if="family.is_owner || member.is_self" class="button-group">
                <a-button v-if="member.is_active" type="link" @click="editRelationship(member)"
                  >编辑关系</a-button
                >
                <a-button
                  v-if="family.is_owner && !member.claimed && member.is_active"
                  type="link"
                  @click="revokeInvite(member)"
                  >撤销邀请</a-button
                >
                <a-popconfirm
                  v-if="!(member.is_self && family.is_owner)"
                  :title="
                    member.is_active
                      ? '退出或停用后将撤销授权与邀请，历史仍保留。确认？'
                      : '恢复关系后需要重新授权，确认恢复？'
                  "
                  @confirm="changeStatus(member)"
                >
                  <a-button type="link" :danger="member.is_active">{{
                    member.is_active ? (member.is_self ? '退出家庭' : '停用成员') : '恢复关系'
                  }}</a-button>
                </a-popconfirm>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <a-modal
      v-model:open="editing"
      title="管理向家庭管理员开放的字段"
      :confirm-loading="saving"
      @ok="save"
    >
      <p class="form-note">
        用途：家庭营养管理。请先填写本人出生日期；一期仅支持成年成员授权。查看权限不会自动授予代维护权限，授权可随时撤回。
      </p>
      <p>允许查看</p>
      <a-checkbox-group
        v-model:value="fields"
        class="permission-fields"
        :options="allFields"
        aria-label="允许查看的字段"
      />
      <p>允许代维护（可选，须先允许查看）</p>
      <a-checkbox-group
        aria-label="允许代维护的字段"
        v-model:value="editFields"
        class="permission-fields"
        :options="allFields.filter((item) => fields.includes(item.value))"
      />
      <a-form layout="vertical"
        ><a-form-item label="有效期至（北京时间，最长一年）"
          ><a-input v-model:value="expires" type="date" /></a-form-item
      ></a-form>
      <a-button danger :loading="saving" @click="revoke">撤回全部授权</a-button>
      <a-alert v-if="error" type="error" :message="error" show-icon class="form-note" />
    </a-modal>
    <a-modal
      v-model:open="relationshipOpen"
      title="编辑成员关系"
      :confirm-loading="saving"
      @ok="saveRelationship"
    >
      <a-form
        layout="vertical"
        name="family-relationship"
        :model="{ name: relationName, relationship: relationType }"
      >
        <a-form-item name="name" label="成员昵称" required
          ><a-input v-model:value="relationName" :maxlength="80"
        /></a-form-item>
        <a-form-item name="relationship" label="家庭关系" required
          ><a-input v-model:value="relationType" :maxlength="30"
        /></a-form-item>
      </a-form>
      <a-alert v-if="error" type="error" :message="error" show-icon />
    </a-modal>
    <a-modal v-model:open="inviteOpen" title="邀请成员本人认领" :footer="null">
      <p>
        请将代码通过你选择的渠道发给成员，由成员登录平台后在“家庭档案 →
        加入家庭”输入。认领后仍需本人设置授权。
      </p>
      <a-input :value="invitation?.code" readonly aria-label="家庭邀请代码" />
      <p class="muted form-note">
        有效期至
        {{
          formatTime(invitation?.expires_at)
        }}；有效期内重复获取返回同一代码，认领后其他账户不能使用。
      </p>
    </a-modal>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { familyApi } from '@/apis/family_api'
import { profileLabels, metricDefinitions, formatTime } from '@/utils/familyArchives'
const props = defineProps({ family: { type: Object, required: true } })
const emit = defineEmits(['changed'])
const editing = ref(false),
  saving = ref(false),
  fields = ref([]),
  editFields = ref([]),
  expires = ref(''),
  error = ref(''),
  selected = ref(null)
const inviteOpen = ref(false),
  invitation = ref(null)
const inviteMemberId = ref('')
const inviting = ref(false)
const relationshipOpen = ref(false),
  relationName = ref(''),
  relationType = ref(''),
  relationMember = ref(null)
defineExpose({ hasDraft: computed(() => editing.value || relationshipOpen.value) })
const allFields = computed(() =>
  Object.entries(profileLabels)
    .map(([value, label]) => ({ value, label }))
    .concat(
      Object.entries(metricDefinitions).map(([value, item]) => ({ value, label: item.label }))
    )
)
const label = (key) => profileLabels[key] || metricDefinitions[key]?.label || key
let generation = 0
watch(
  () => props.family,
  (next, previous) => {
    if (next.id === previous?.id) {
      const invited = next.members.find((member) => member.id === inviteMemberId.value)
      if (inviteMemberId.value && (!invited || invited.claimed)) {
        generation++
        invitation.value = null
        inviteOpen.value = false
        inviteMemberId.value = ''
      }
      if (
        relationMember.value &&
        !next.members.some((member) => member.id === relationMember.value.id)
      )
        relationshipOpen.value = false
      return
    }
    generation++
    editing.value = false
    inviteOpen.value = false
    invitation.value = null
    fields.value = []
    selected.value = null
    editFields.value = []
    relationshipOpen.value = false
  }
)
watch(
  fields,
  () => {
    editFields.value = editFields.value.filter((key) => fields.value.includes(key))
  },
  { deep: true }
)
onBeforeUnmount(() => {
  generation++
  fields.value = []
  selected.value = null
  invitation.value = null
})
function edit(member) {
  selected.value = member
  fields.value = [...(member.authorization?.fields || [])]
  editFields.value = [...(member.authorization?.edit_fields || [])]
  expires.value =
    member.authorization?.expires_at && Date.parse(member.authorization.expires_at) > Date.now()
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
          new Date(member.authorization.expires_at)
        )
      : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  error.value = ''
  editing.value = true
}
async function save() {
  if (fields.value.length) {
    const born = selected.value?.profile.birth_date
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const cutoff = String(Number(today.slice(0, 4)) - 18) + today.slice(4)
    if (!born || born > cutoff) {
      error.value = '请先在成员档案填写本人出生日期；一期仅支持成年成员授权'
      return
    }
  }
  if (!expires.value) {
    error.value = '请选择有效期'
    return
  }
  saving.value = true
  try {
    await familyApi.authorize(props.family.id, selected.value.id, {
      fields: fields.value,
      edit_fields: editFields.value,
      purpose: 'family_nutrition',
      expires_at: new Date(expires.value + 'T23:59:00+08:00').toISOString()
    })
    editing.value = false
    emit('changed')
    message.success(fields.value.length ? '授权已保存' : '授权已撤回')
  } catch (cause) {
    error.value = cause.message
  } finally {
    saving.value = false
  }
}
async function revoke() {
  fields.value = []
  editFields.value = []
  expires.value = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  await save()
}
function editRelationship(member) {
  relationMember.value = { id: member.id, version: member.relationship_version }
  relationName.value = member.name
  relationType.value = member.relationship
  error.value = ''
  relationshipOpen.value = true
}
async function saveRelationship() {
  if (!relationName.value.trim() || !relationType.value.trim()) {
    error.value = '请填写昵称与关系'
    return
  }
  saving.value = true
  try {
    await familyApi.updateMember(props.family.id, relationMember.value.id, {
      expected_version: relationMember.value.version,
      name: relationName.value.trim(),
      relationship: relationType.value.trim()
    })
    relationshipOpen.value = false
    emit('changed')
    message.success('成员关系已保存')
  } catch (cause) {
    error.value = cause.message
  } finally {
    saving.value = false
  }
}
async function changeStatus(member) {
  try {
    await familyApi.memberStatus(props.family.id, member.id, {
      expected_version: member.relationship_version,
      is_active: !member.is_active
    })
    if (inviteMemberId.value === member.id) {
      generation++
      invitation.value = null
      inviteOpen.value = false
      inviteMemberId.value = ''
    }
    emit('changed')
    message.success(member.is_active ? '关系已停用，授权和邀请已撤销' : '已恢复关系，请重新授权')
  } catch (cause) {
    message.error(cause.message)
  }
}
async function revokeInvite(member) {
  generation++
  try {
    await familyApi.revokeInvitation(props.family.id, member.id)
    invitation.value = null
    inviteOpen.value = false
    message.success('邀请已撤销')
  } catch (cause) {
    message.error(cause.message)
  }
}
async function invite(member) {
  if (inviting.value) return
  inviting.value = true
  inviteMemberId.value = member.id
  const current = ++generation
  try {
    const result = await familyApi.invite(props.family.id, member.id)
    if (current === generation) {
      invitation.value = result
      inviteOpen.value = true
    }
  } catch (cause) {
    if (current === generation) message.error(cause.message)
  } finally {
    inviting.value = false
  }
}
</script>

<style scoped lang="less">
.permission-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 24px 0;
}
.form-note {
  margin: 16px 0;
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import Tag from 'primevue/tag'
import { useImpositionStore } from '../stores/imposition'
import { bindIssue } from '../services/issueFingerprint'
import { fingerprintText } from '../services/reviewLedger'
import { useReviewSubmit } from '../composables/useReviewSubmit'
import ConflictPanel from './ConflictPanel.vue'

const props = defineProps<{ issueId: string | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const store = useImpositionStore()
const reason = ref('')
const submit = useReviewSubmit()

const issue = computed(() => store.validations.find((item) => item.id === props.issueId) ?? null)
const binding = computed(() => (props.issueId ? bindIssue(props.issueId, { positions: store.positions, pages: store.pages, binding: store.binding, grain: store.grain, sheetBleed: store.sheetDefaults.bleed }) : null))
const existing = computed(() => (props.issueId ? store.exemptionByIssue.get(props.issueId) : undefined))

watch(
  () => props.issueId,
  () => {
    if (!submit.recordNo) reason.value = ''
    submit.reset()
  },
)

async function save() {
  if (!props.issueId) return
  const issueId = props.issueId
  const ok = await submit.run((recordNo) => store.saveExemption(issueId, reason.value.trim() || '未填写放行理由', recordNo))
  if (ok) {
    reason.value = ''
    emit('saved')
    emit('close')
  }
}
</script>

<template>
  <div v-if="issue && binding" class="dlg-mask" @click.self="emit('close')">
    <div class="dlg">
      <div class="dlg-head">
        <div>
          <p class="eyebrow">REVIEW EXEMPTION / 放行豁免</p>
          <h3>{{ issue.title }}</h3>
        </div>
        <Button icon="pi pi-times" text severity="contrast" @click="emit('close')" />
      </div>

      <div class="dlg-body">
        <p class="detail">{{ issue.detail }}</p>

        <div v-if="existing" class="already">
          <i class="pi pi-check-circle" />
          <div>
            <strong>该问题已有有效豁免 {{ existing.id }}</strong>
            <small>{{ existing.operator }} 在 {{ existing.revision }} 放行 · {{ existing.createdAt }}</small>
          </div>
        </div>

        <div class="binding-card">
          <h4>放行依据（写入同一份复核记录）</h4>
          <dl>
            <div><dt>问题指纹</dt><dd><code>{{ fingerprintText(binding.fingerprint) }}</code></dd></div>
            <div><dt>绑定范围</dt><dd>{{ binding.scope === 'sheet' ? '全张' : binding.scope === 'page' ? '页面' : '版位' }} · {{ binding.scopeRef }}</dd></div>
            <div><dt>当次版位摘要</dt><dd><code>{{ store.layoutDigest }}</code></dd></div>
            <div><dt>工位 / 版本</dt><dd>{{ store.station }} · {{ store.revision }} · 打开版本 V{{ store.sessionDocVersion }}</dd></div>
          </dl>
          <p class="rule-hint"><i class="pi pi-bolt" /> 版位坐标、页面出血或装订方向一旦变化，该豁免立即失效并自动重新校验；审批锁定只认当前版位摘要。</p>
        </div>

        <label class="reason-label">
          放行理由（口头放过将不再被接受，必须留痕）
          <Textarea v-model="reason" rows="3" placeholder="例如：P7 暗部无图文，已与车间确认 1mm 出血不影响裁切，下版换文件。" />
        </label>

        <ConflictPanel
          :conflict="submit.conflict.value"
          :network-error="submit.networkError.value"
          :retried="submit.retried.value"
          @retry="submit.retrySameRecord"
          @rebase-retry="submit.rebaseAndRetry().then((ok) => ok && (emit('saved'), emit('close')))"
          @cancel="emit('close')"
        />
      </div>

      <div class="dlg-foot">
        <span class="record-no">记录号 <code>{{ submit.recordNo.value || '保存时生成' }}</code></span>
        <div class="spacer" />
        <Button label="取消" text @click="emit('close')" />
        <Button label="登记放行并写审计" icon="pi pi-save" :loading="submit.phase.value === 'submitting'" @click="save" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.dlg-mask { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: rgba(28,44,50,.45); }
.dlg { width: min(620px, 100%); max-height: 90vh; overflow: auto; border-radius: 12px; background: white; box-shadow: 0 24px 60px rgba(20,40,46,.3); }
.dlg-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 20px 8px; }
.dlg-head h3 { margin: 4px 0 0; font-size: 18px; }
.dlg-body { padding: 8px 20px 16px; }
.detail { margin: 8px 0 14px; color: #66757c; font-size: 12px; line-height: 1.6; }
.already { display: flex; gap: 10px; align-items: center; padding: 11px 13px; margin-bottom: 14px; border-radius: 8px; background: #eef7f2; color: #2d6b54; }
.already i { font-size: 17px; }
.already strong, .already small { display: block; }
.already small { margin-top: 3px; color: #5a8a7c; font-size: 10px; }
.binding-card { border: 1px solid #dde6e7; border-radius: 9px; background: #f8fafa; padding: 13px 15px; }
.binding-card h4 { margin: 0 0 10px; font-size: 12px; }
.binding-card dl { display: grid; gap: 7px; margin: 0; }
.binding-card dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 8px; font-size: 11px; }
.binding-card dt { color: #78878d; }
.binding-card dd { margin: 0; color: #32494f; word-break: break-all; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 10px; background: #eef2f2; padding: 2px 5px; border-radius: 4px; }
.rule-hint { display: flex; align-items: flex-start; gap: 6px; margin: 11px 0 0; padding-top: 10px; border-top: 1px dashed #d4dddd; color: #9a6a2f; font-size: 10px; line-height: 1.55; }
.reason-label { display: grid; gap: 7px; margin-top: 14px; color: #56686e; font-size: 11px; font-weight: 700; }
.dlg-foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid #ecf0f0; }
.record-no { color: #84929a; font-size: 10px; }
.spacer { flex: 1; }
</style>

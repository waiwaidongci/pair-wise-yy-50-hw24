<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useImpositionStore } from '../stores/imposition'
import { useReviewSubmit } from '../composables/useReviewSubmit'
import ConflictPanel from './ConflictPanel.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; locked: [] }>()

const store = useImpositionStore()
const submit = useReviewSubmit()

const remainingErrors = computed(() => store.blockingErrors.length)
const pending = computed(() => store.pendingReviewCount)
const activeGrants = computed(() => store.activeExemptions.length)

async function lock() {
  const ok = await submit.run((recordNo) => store.lockBaseline(recordNo))
  if (ok) {
    emit('locked')
    emit('close')
  }
}
</script>

<template>
  <div v-if="props.open" class="dlg-mask" @click.self="emit('close')">
    <div class="dlg">
      <div class="dlg-head">
        <div><p class="eyebrow">APPROVAL LOCK / 审批锁定</p><h3>锁定 {{ store.revision }} 为生产基线</h3></div>
        <Button icon="pi pi-times" text severity="contrast" @click="emit('close')" />
      </div>
      <div class="dlg-body">
        <div class="basis-card">
          <h4>锁定依据（之后可随时核对版本）</h4>
          <dl>
            <div><dt>版位摘要</dt><dd><code>{{ store.layoutDigest }}</code></dd></div>
            <div><dt>文档版本</dt><dd>V{{ store.sessionDocVersion }}（{{ store.station }} 打开时的版本）</dd></div>
            <div><dt>有效豁免</dt><dd>{{ activeGrants }} 条，逐条绑定指纹与摘要</dd></div>
            <div><dt>未放行错误</dt><dd :class="{ bad: remainingErrors > 0 }">{{ remainingErrors }} 条</dd></div>
            <div><dt>待复核豁免</dt><dd :class="{ bad: pending > 0 }">{{ pending }} 条</dd></div>
          </dl>
        </div>
        <p v-if="remainingErrors > 0" class="warn-line"><i class="pi pi-times-circle" /> 仍有 {{ remainingErrors }} 条阻断错误未放行或修复，不能锁定。</p>
        <p v-else-if="pending > 0" class="warn-line"><i class="pi pi-exclamation-triangle" /> 有 {{ pending }} 条旧豁免待复核，建议先到复核记录处理。</p>
        <p v-else class="ok-line"><i class="pi pi-check-circle" /> 版位一变，已绑定的豁免会立即失效；锁定只认上面的版位摘要。</p>

        <ConflictPanel
          :conflict="submit.conflict.value"
          :network-error="submit.networkError.value"
          :retried="submit.retried.value"
          @retry="submit.retrySameRecord"
          @rebase-retry="submit.rebaseAndRetry().then((ok) => ok && (emit('locked'), emit('close')))"
          @cancel="emit('close')"
        />
      </div>
      <div class="dlg-foot">
        <span class="record-no">记录号 <code>{{ submit.recordNo.value || '保存时生成' }}</code></span>
        <div class="spacer" />
        <Button label="取消" text @click="emit('close')" />
        <Button label="确认依据并锁定" icon="pi pi-lock" :disabled="remainingErrors > 0" :loading="submit.phase.value === 'submitting'" @click="lock" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.dlg-mask { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: rgba(28,44,50,.45); }
.dlg { width: min(560px, 100%); border-radius: 12px; background: white; box-shadow: 0 24px 60px rgba(20,40,46,.3); }
.dlg-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 20px 8px; }
.dlg-head h3 { margin: 4px 0 0; font-size: 17px; }
.dlg-body { padding: 8px 20px 16px; }
.basis-card { border: 1px solid #dde6e7; border-radius: 9px; background: #f8fafa; padding: 13px 15px; }
.basis-card h4 { margin: 0 0 10px; font-size: 12px; }
.basis-card dl { display: grid; gap: 7px; margin: 0; }
.basis-card dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 8px; font-size: 11px; }
.basis-card dt { color: #78878d; }
.basis-card dd { margin: 0; color: #32494f; word-break: break-all; }
.basis-card dd.bad { color: #b8492f; font-weight: 700; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 10px; background: #eef2f2; padding: 2px 5px; border-radius: 4px; }
.warn-line { display: flex; align-items: center; gap: 7px; margin: 12px 0 0; color: #a36a27; font-size: 11px; }
.ok-line { display: flex; align-items: center; gap: 7px; margin: 12px 0 0; color: #2d6b54; font-size: 11px; }
.dlg-foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid #ecf0f0; }
.record-no { color: #84929a; font-size: 10px; }
.spacer { flex: 1; }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import Tag from 'primevue/tag'
import { useImpositionStore } from '../stores/imposition'
import { bindIssue } from '../services/issueFingerprint'
import { fingerprintText } from '../services/reviewLedger'
import { useReviewSubmit } from '../composables/useReviewSubmit'
import ConflictPanel from '../components/ConflictPanel.vue'

const store = useImpositionStore()
const tab = ref<'pending' | 'all' | 'audit'>('pending')
const openId = ref<string | null>(null)
const reason = ref('')
const submit = useReviewSubmit()

const pending = computed(() => store.ledger.exemptions.filter((item) => item.status === 'pending_review'))
const all = computed(() => store.ledger.exemptions.slice().reverse())
const audits = computed(() => store.ledger.audits.slice().reverse())

const current = computed(() => store.ledger.exemptions.find((item) => item.id === openId.value) ?? null)
const matchedIssue = computed(() => (current.value ? store.matchingIssueForLegacy(current.value) : null))
const matchedBinding = computed(() => {
  const issueId = matchedIssue.value
  return issueId ? bindIssue(issueId, { positions: store.positions, pages: store.pages, binding: store.binding, grain: store.grain, sheetBleed: store.sheetDefaults.bleed }) : null
})

function openReview(id: string) {
  openId.value = id
  reason.value = ''
  submit.reset()
}

async function decide(approve: boolean) {
  if (!current.value) return
  const id = current.value.id
  const text = reason.value
  const issueId = matchedIssue.value ?? undefined
  const ok = await submit.run((recordNo) => store.reviewLegacy(id, approve, text.trim() || (approve ? '复核确认旧版放行依据' : '依据不足，驳回'), recordNo, issueId))
  if (ok) {
    openId.value = null
    reason.value = ''
  }
}

function actionTag(action: string) {
  return { grant: ['放行', 'success'], invalidate: ['失效', 'danger'], confirm_legacy: ['复核确认', 'success'], reject_legacy: ['复核驳回', 'warn'], lock: ['锁定', 'info'], unlock: ['解锁', 'secondary'], save: ['保存', 'info'], migration: ['升级', 'warn'] }[action] ?? ['记录', 'info']
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">REVIEW LEDGER / 复核记录</p>
        <h1>放行豁免 · 待复核 · 审计留痕</h1>
        <p class="muted">拼版版位、预检条目与放行豁免同属一份记录；豁免绑定问题指纹与当次版位摘要，总览、拼版预检与版本对比显示相同的待复核数量。</p>
      </div>
      <div class="actions">
        <Tag value="打开版本 V{{ store.sessionDocVersion }}" severity="info" />
        <Tag :value="`${store.pendingReviewCount} 条待复核`" :severity="store.pendingReviewCount ? 'warn' : 'success'" />
      </div>
    </div>

    <div class="tabs panel">
      <button :class="{ active: tab === 'pending' }" @click="tab = 'pending'">待复核（{{ pending.length }}）</button>
      <button :class="{ active: tab === 'all' }" @click="tab = 'all'">全部豁免（{{ all.length }}）</button>
      <button :class="{ active: tab === 'audit' }" @click="tab = 'audit'">审计记录（{{ audits.length }}）</button>
    </div>

    <section v-if="tab === 'pending'" class="panel list-panel">
      <div v-if="!pending.length" class="empty-banner"><i class="pi pi-check-circle" /><div><strong>没有待复核豁免</strong><p>旧数据升级产生的无指纹豁免均已处理，历史记录仍可在“全部豁免”与“审计记录”中查看。</p></div></div>
      <article v-for="item in pending" :key="item.id" class="row pending-row">
        <div class="row-main">
          <div class="row-title"><Tag value="待复核" severity="warn" /><strong>{{ item.id }} · {{ item.scopeLabel }}</strong></div>
          <p>{{ item.reason }}</p>
          <small>历史放行：{{ item.operator }} · {{ item.station }} · {{ item.revision }} · {{ item.createdAt }} ｜ 旧数据缺少问题指纹与版位摘要</small>
        </div>
        <div class="row-side">
          <Tag v-if="store.matchingIssueForLegacy(item)" value="当前预检仍存在" severity="danger" />
          <Tag v-else value="当前预检已无此问题" severity="secondary" />
          <Button label="去复核" icon="pi pi-search" size="small" @click="openReview(item.id)" />
        </div>
      </article>
    </section>

    <section v-else-if="tab === 'all'" class="panel list-panel">
      <article v-for="item in all" :key="item.id" class="row">
        <div class="row-main">
          <div class="row-title">
            <Tag :value="item.status === 'active' ? '有效' : item.status === 'invalid' ? '已失效' : '待复核'" :severity="item.status === 'active' ? 'success' : item.status === 'invalid' ? 'danger' : 'warn'" />
            <strong>{{ item.id }} · {{ item.scopeLabel }}</strong>
          </div>
          <p>{{ item.reason }}</p>
          <small>
            {{ item.operator }} · {{ item.station }} · {{ item.revision }} · {{ item.createdAt }}
            <template v-if="item.fingerprint">｜ 指纹 <code>{{ fingerprintText(item.fingerprint) }}</code> ｜ 摘要 <code>{{ item.layoutDigest }}</code></template>
            <template v-else>｜ 历史记录无指纹</template>
          </small>
          <small v-if="item.invalidReason" class="invalid-reason"><i class="pi pi-bolt" /> {{ item.invalidReason }}（{{ item.invalidAt }}）</small>
        </div>
        <div class="row-side">
          <Button v-if="item.status === 'pending_review'" label="去复核" icon="pi pi-search" size="small" @click="openReview(item.id)" />
          <Button v-else label="查看审计" text size="small" @click="tab = 'audit'" />
        </div>
      </article>
    </section>

    <section v-else class="panel list-panel">
      <article v-for="entry in audits" :key="entry.recordNo + entry.at" class="row audit-row">
        <div class="row-main">
          <div class="row-title"><Tag :value="actionTag(entry.action)[0]" :severity="actionTag(entry.action)[1] as any" /><strong>{{ entry.recordNo }}</strong><span class="batch-id">批次 {{ entry.batchId }}</span></div>
          <p>{{ entry.detail }}</p>
        </div>
        <div class="row-side audit-meta"><span>{{ entry.operator }} · {{ entry.station }}</span><small>{{ entry.revision }} · {{ entry.at }}</small></div>
      </article>
    </section>

    <div v-if="current" class="dlg-mask" @click.self="openId = null">
      <div class="dlg">
        <div class="dlg-head">
          <div><p class="eyebrow">LEGACY REVIEW / 历史豁免复核</p><h3>{{ current.id }} · {{ current.scopeLabel }}</h3></div>
          <Button icon="pi pi-times" text severity="contrast" @click="openId = null" />
        </div>
        <div class="dlg-body">
          <div class="legacy-box">
            <p><strong>历史放行理由：</strong>{{ current.reason }}</p>
            <small>{{ current.operator }} · {{ current.station }} · {{ current.revision }} · {{ current.createdAt }}</small>
          </div>

          <div v-if="matchedBinding && matchedIssue" class="binding-card">
            <h4>当前预检中的对应问题（复核确认即补绑指纹与摘要）</h4>
            <dl>
              <div><dt>问题指纹</dt><dd><code>{{ fingerprintText(matchedBinding.fingerprint) }}</code></dd></div>
              <div><dt>绑定范围</dt><dd>{{ matchedBinding.scopeRef }} · {{ matchedBinding.scopeLabel }}</dd></div>
              <div><dt>当次版位摘要</dt><dd><code>{{ store.layoutDigest }}</code></dd></div>
            </dl>
          </div>
          <div v-else class="binding-card no-match">
            <h4>当前预检中已无对应问题</h4>
            <p>无法为其补绑当前指纹；只能驳回该历史豁免。驳回后历史理由与审计仍保留可查。</p>
          </div>

          <label class="reason-label">复核意见<Textarea v-model="reason" rows="3" placeholder="填写本次复核结论与依据…" /></label>

          <ConflictPanel
            :conflict="submit.conflict.value"
            :network-error="submit.networkError.value"
            :retried="submit.retried.value"
            @retry="submit.retrySameRecord"
            @rebase-retry="submit.rebaseAndRetry().then((ok) => ok && (openId = null))"
            @cancel="openId = null"
          />
        </div>
        <div class="dlg-foot">
          <span class="record-no">记录号 <code>{{ submit.recordNo.value || '保存时生成' }}</code></span>
          <div class="spacer" />
          <Button label="驳回（历史保留）" severity="danger" outlined :loading="submit.phase.value === 'submitting'" @click="decide(false)" />
          <Button label="补绑指纹并确认" icon="pi pi-check" severity="success" :disabled="!matchedBinding" :loading="submit.phase.value === 'submitting'" @click="decide(true)" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.tabs { display: flex; gap: 4px; padding: 6px; margin-bottom: 14px; }
.tabs button { padding: 9px 16px; border: 0; border-radius: 7px; background: transparent; color: #5f7178; font-size: 12px; font-weight: 700; cursor: pointer; }
.tabs button.active { background: #e9f1f0; color: #24525a; }
.list-panel { padding: 6px 18px 12px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 4px; border-bottom: 1px solid #edf1f1; }
.row:last-child { border-bottom: 0; }
.row-title { display: flex; align-items: center; gap: 9px; }
.row-title strong { font-size: 13px; }
.row-main p { margin: 7px 0 5px; color: #4c5d63; font-size: 12px; line-height: 1.55; }
.row-main small { color: #85939a; font-size: 10px; word-break: break-all; }
.invalid-reason { display: block; margin-top: 4px; color: #b06a3c !important; }
.row-side { display: grid; justify-items: end; gap: 7px; flex-shrink: 0; }
.audit-meta { text-align: right; }
.audit-meta span { display: block; font-size: 11px; color: #4a5e64; }
.audit-meta small { display: block; margin-top: 4px; color: #93a0a6; }
.batch-id { color: #9aa8ad; font-size: 10px; }
.empty-banner { display: flex; gap: 12px; align-items: center; padding: 30px 14px; color: #2d6b54; }
.empty-banner i { font-size: 26px; }
.empty-banner p { margin: 5px 0 0; color: #6a807b; font-size: 12px; }
.pending-row { background: linear-gradient(90deg, rgba(225,176,84,.07), transparent 40%); }
.dlg-mask { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: rgba(28,44,50,.45); }
.dlg { width: min(620px, 100%); max-height: 90vh; overflow: auto; border-radius: 12px; background: white; box-shadow: 0 24px 60px rgba(20,40,46,.3); }
.dlg-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 18px 20px 8px; }
.dlg-head h3 { margin: 4px 0 0; font-size: 17px; }
.dlg-body { padding: 8px 20px 16px; }
.legacy-box { padding: 12px 14px; margin-bottom: 13px; border-radius: 8px; background: #f7f5ef; border: 1px solid #e8e1d0; }
.legacy-box p { margin: 0 0 6px; font-size: 12px; color: #5d5749; line-height: 1.6; }
.legacy-box small { color: #8f8776; font-size: 10px; }
.binding-card { border: 1px solid #dde6e7; border-radius: 9px; background: #f8fafa; padding: 13px 15px; }
.binding-card.no-match { background: #fdf3ef; border-color: #eed3c8; }
.binding-card h4 { margin: 0 0 10px; font-size: 12px; }
.binding-card p { margin: 0; color: #96604e; font-size: 11px; line-height: 1.6; }
.binding-card dl { display: grid; gap: 7px; margin: 0; }
.binding-card dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 8px; font-size: 11px; }
.binding-card dt { color: #78878d; }
.binding-card dd { margin: 0; color: #32494f; word-break: break-all; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 10px; background: #eef2f2; padding: 2px 5px; border-radius: 4px; }
.reason-label { display: grid; gap: 7px; margin-top: 14px; color: #56686e; font-size: 11px; font-weight: 700; }
.dlg-foot { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid #ecf0f0; }
.record-no { color: #84929a; font-size: 10px; }
.spacer { flex: 1; }
@media (max-width: 700px) { .row { flex-direction: column; align-items: flex-start; } .row-side { justify-items: start; } }
</style>

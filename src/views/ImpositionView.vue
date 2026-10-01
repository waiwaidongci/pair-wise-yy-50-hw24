<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import Slider from 'primevue/slider'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import Textarea from 'primevue/textarea'
import InputText from 'primevue/inputtext'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import { issueFingerprint, useImpositionStore, type Validation, type Waiver } from '../stores/imposition'

const store = useImpositionStore()
const sideOptions = [
  { label: '正面', value: 'front' },
  { label: '反面', value: 'back' },
]
const selected = computed(() => store.positions.find((item) => item.id === store.selectedPosition))
const activeValidations = computed(() => store.validations.filter((item) => !item.pageNo || item.pageNo === selected.value?.pageNo || sideContains(item.pageNo)))

const activeIssues = computed(() =>
  activeValidations.value.map((issue) => ({ issue, waiver: store.waivers.find((item) => item.issueId === issue.id && item.status !== '已失效') ?? null })),
)

function sideContains(pageNo?: number) {
  if (!pageNo) return true
  return store.positions.some((position) => position.pageNo === pageNo && position.front === (store.side === 'front'))
}

function locate(pageNo?: number) {
  const position = store.positions.find((item) => item.pageNo === pageNo)
  if (position) {
    store.selectedPosition = position.id
    store.side = position.front ? 'front' : 'back'
  }
}

const grantVisible = ref(false)
const grantFor = ref<Validation | null>(null)
const grantReason = ref('')
const grantOwner = ref('当前用户')
const grantFingerprint = computed(() => (grantFor.value ? issueFingerprint(grantFor.value, store.pages, store.positions, store.binding) : ''))

function openGrant(issue: Validation) {
  grantFor.value = issue
  grantReason.value = ''
  grantOwner.value = '当前用户'
  grantVisible.value = true
}

function submitGrant() {
  if (grantFor.value) store.grantWaiver(grantFor.value.id, grantReason.value.trim() || '现场复核后确认放行', grantOwner.value.trim() || '当前用户')
  grantVisible.value = false
}

const conflictVisible = computed({
  get: () => store.conflict !== null,
  set: (value: boolean) => { if (!value) store.conflict = null },
})

const saveLabel = computed(() => {
  if (store.saveState === 'saving') return '正在写入…'
  if (store.saveState === 'retrying') return '写入失败，按原记录号重试中…'
  if (store.saveState === 'conflict') return '保存冲突，待处理'
  if (store.saveState === 'error') return '写入失败，点击重试'
  return '保存复核记录'
})

const fieldLabels: Record<string, string> = { status: '状态', fingerprint: '问题指纹', layoutSummary: '版位摘要', reason: '豁免理由', owner: '负责人', issueId: '预检条目', 记录: '记录' }

const historyOpen = ref<string | null>(null)
function toggleHistory(id: string) {
  historyOpen.value = historyOpen.value === id ? null : id
}

function waiverSeverity(status: Waiver['status']) {
  return status === '有效' ? 'success' : status === '待复核' ? 'warn' : 'secondary'
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">IMPOSITION / 拼版工作区</p><h1>Canvas 版位编排与预检</h1><p class="muted">拖拽页面位置，系统实时检查出血、安全区、重叠和骑马订方向；每条豁免绑定问题指纹与当次版位摘要。</p></div>
      <div class="actions">
        <Button label="批量校验" icon="pi pi-check-circle" outlined />
        <Button :label="saveLabel" icon="pi pi-save" :loading="store.saveState === 'saving' || store.saveState === 'retrying'" @click="store.saveWaivers()" />
      </div>
    </div>

    <Message v-if="store.pendingReviewCount" severity="warn" :closable="false" class="mb-3">
      有 {{ store.pendingReviewCount }} 条放行豁免待复核：版位、页面出血或装订方向已变更，豁免已失效，请重新校验并绑定当前指纹。
    </Message>
    <Message v-else-if="store.validations.length" severity="info" :closable="false" class="mb-3">
      当前版本有 {{ store.validations.filter((item) => item.severity === '错误').length }} 个阻断错误和 {{ store.validations.filter((item) => item.severity === '警告').length }} 个警告，均已绑定复核记录。
    </Message>

    <div class="toolbar panel">
      <SelectButton v-model="store.side" :options="sideOptions" optionLabel="label" optionValue="value" />
      <span class="muted">缩放 {{ store.zoom }}%</span>
      <Slider v-model="store.zoom" :min="35" :max="100" :step="5" style="width:150px" />
      <span class="paper-spec">720 × 1020mm · 出血 3mm · 安全区 5mm · 装订 {{ store.binding }} · {{ store.locked ? '基线只读' : '编辑中' }}</span>
      <Button v-if="!store.locked" label="审批锁定" icon="pi pi-lock" size="small" :disabled="store.lockBlocked" :title="store.lockBlocked ? '有待复核豁免，不能锁定当前版本' : ''" @click="store.lockBaseline" />
      <Button v-else label="解锁修订" icon="pi pi-lock-open" size="small" severity="warn" outlined @click="store.unlock" />
    </div>

    <div class="imposition-grid">
      <aside class="panel pages-panel">
        <div class="panel-head"><h3>页面文件</h3><Tag :value="`${store.pages.length}P`" /></div>
        <div class="page-list">
          <button v-for="page in store.pages" :key="page.pageNo" :disabled="store.positions.some((item) => item.pageNo === page.pageNo && item.front === (store.side === 'front'))" @click="store.addPosition(page.pageNo)">
            <div class="thumb"><span>P{{ page.pageNo }}</span><i /></div>
            <div><strong>{{ page.name }}</strong><small>{{ page.width }}×{{ page.height }} · 出血 {{ page.bleed }}mm</small></div>
            <i class="pi pi-plus" />
          </button>
        </div>
      </aside>

      <section class="panel canvas-panel">
        <div class="panel-head"><h3>{{ store.side === 'front' ? '正面版式' : '反面版式' }}</h3><span class="muted">拖动页面 · 点击选择</span></div>
        <div class="canvas-scroll">
          <ImpositionCanvas
            :positions="store.positions"
            :side="store.side"
            :zoom="store.zoom"
            :selected="store.selectedPosition"
            :validations="store.validations"
            @select="store.selectedPosition = $event"
            @update="store.updatePosition"
          />
        </div>
      </section>

      <aside class="right-panel">
        <section class="panel">
          <div class="panel-head"><h3>版位属性</h3><Tag v-if="selected" :value="selected.id" /></div>
          <div v-if="selected" class="properties">
            <label>页面<select :value="selected.pageNo" @change="store.updatePosition(selected.id, { pageNo: Number(($event.target as HTMLSelectElement).value) })"><option v-for="page in store.pages" :key="page.pageNo" :value="page.pageNo">P{{ page.pageNo }} · {{ page.name }}</option></select></label>
            <div class="pair"><label>X<input type="number" :value="selected.x" @change="store.updatePosition(selected.id, { x: Number(($event.target as HTMLInputElement).value) })" /></label><label>Y<input type="number" :value="selected.y" @change="store.updatePosition(selected.id, { y: Number(($event.target as HTMLInputElement).value) })" /></label></div>
            <label>旋转方向<select :value="selected.rotation" @change="store.updatePosition(selected.id, { rotation: Number(($event.target as HTMLSelectElement).value) })"><option :value="0">0°</option><option :value="90">顺时针 90°</option><option :value="180">倒置 180°</option><option :value="270">顺时针 270°</option></select></label>
            <div class="binding-note"><i class="pi pi-info-circle" /><span>{{ store.pages.find((page) => page.pageNo === selected?.pageNo)?.content }}</span></div>
          </div>
          <div v-else class="empty">在画布中选择一个版位以编辑属性。</div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h3>预检结果</h3>
            <div class="head-tags">
              <Tag :value="`${activeValidations.length} 项`" :severity="activeValidations.some((item) => item.severity === '错误') ? 'danger' : 'warn'" />
              <Tag v-if="store.pendingReviewCount" :value="`待复核 ${store.pendingReviewCount}`" severity="warn" />
            </div>
          </div>
          <div class="validation-list">
            <article v-for="{ issue, waiver } in activeIssues" :key="issue.id" :class="['issue-row', issue.severity]">
              <button class="issue-main" @click="locate(issue.pageNo)">
                <i :class="issue.severity === '错误' ? 'pi pi-times-circle' : 'pi pi-exclamation-triangle'" />
                <div><strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p></div>
                <i class="pi pi-arrow-right" />
              </button>
              <div class="waiver-row" @click.stop>
                <template v-if="waiver">
                  <Tag :value="`${waiver.status} ${waiver.id}`" :severity="waiverSeverity(waiver.status)" />
                  <span class="fp">指纹 {{ waiver.fingerprint.slice(0, 8) || '未绑定' }}</span>
                  <Button v-if="waiver.status === '待复核'" label="重新校验" size="small" @click="store.reaffirmWaiver(waiver.id)" />
                  <Button v-if="waiver.status !== '已失效'" label="撤销" size="small" text severity="danger" @click="store.revokeWaiver(waiver.id)" />
                </template>
                <template v-else>
                  <span class="fp muted">未签发豁免</span>
                  <Button label="放行豁免" size="small" outlined @click="openGrant(issue)" />
                </template>
              </div>
            </article>
          </div>
        </section>
      </aside>
    </div>

    <section class="panel history-panel">
      <div class="panel-head">
        <h3>豁免复核记录（{{ store.waivers.length }} 条 · 审计可查）</h3>
        <Tag :value="`待复核 ${store.pendingReviewCount}`" severity="warn" />
      </div>
      <div v-if="!store.waivers.length" class="empty">暂无豁免记录。</div>
      <div v-else class="history-list">
        <article v-for="waiver in store.waivers" :key="waiver.id" :class="['history-row', waiver.status]">
          <header @click="toggleHistory(waiver.id)">
            <div class="history-id"><strong>{{ waiver.id }}</strong><Tag :value="waiver.status" :severity="waiverSeverity(waiver.status)" /><code>{{ waiver.issueId }}</code></div>
            <div class="history-reason">{{ waiver.reason || '—' }}</div>
            <div class="history-meta"><span>{{ waiver.owner }}</span><i class="pi" :class="historyOpen === waiver.id ? 'pi-chevron-up' : 'pi-chevron-down'" /></div>
          </header>
          <div v-if="historyOpen === waiver.id" class="audit-trail">
            <div class="binding-line">绑定指纹 <code>{{ waiver.fingerprint || '未绑定' }}</code> · 版位摘要 <code>{{ waiver.layoutSummary || '未绑定' }}</code></div>
            <div v-for="audit in waiver.audits" :key="audit.id" class="audit-entry">
              <span class="audit-at">{{ audit.at }}</span>
              <strong>{{ audit.action }}</strong>
              <p>{{ audit.detail }}</p>
            </div>
          </div>
        </article>
      </div>
    </section>

    <Dialog v-model:visible="grantVisible" header="放行豁免并绑定问题指纹" :modal="true" :style="{ width: '520px' }">
      <div v-if="grantFor" class="grant-body">
        <p><strong>{{ grantFor.title }}</strong></p>
        <p class="muted">{{ grantFor.detail }}</p>
        <p class="fp-line">问题指纹将绑定：<code>{{ grantFingerprint }}</code>，版位、出血或装订一变即失效。</p>
        <label>豁免理由<Textarea v-model="grantReason" rows="3" placeholder="现场复核后确认放行的理由" /></label>
        <label>负责人<InputText v-model="grantOwner" /></label>
      </div>
      <template #footer>
        <Button label="取消" text @click="grantVisible = false" />
        <Button label="放行并绑定指纹" icon="pi pi-check" @click="submitGrant" />
      </template>
    </Dialog>

    <Dialog v-model:visible="conflictVisible" header="保存冲突：其他工位已先保存" :modal="true" :style="{ width: '580px' }">
      <p class="muted">你打开页面时版本为 v{{ store.openedVersion }}，服务器当前为 v{{ store.conflict?.serverVersion }}。以下对象在你打开页面后被其他工位修改，你填写的豁免内容已保留在草稿中：</p>
      <ul class="conflict-list">
        <li v-for="change in store.conflict?.changed ?? []" :key="`${change.id}-${change.field}`">
          <strong>{{ change.id }}</strong> · {{ fieldLabels[change.field] ?? change.field }}
          <span class="diff">{{ String(change.before ?? '—') }} → {{ String(change.after ?? '—') }}</span>
        </li>
      </ul>
      <p class="muted">强制保存将以你的草稿覆盖服务器版本；稍后处理不会丢失已填写内容。</p>
      <template #footer>
        <Button label="强制保存我的版本" icon="pi pi-save" @click="store.saveWaivers(true)" />
        <Button label="稍后处理（保留草稿）" text @click="conflictVisible = false" />
      </template>
    </Dialog>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.mb-3 { margin-bottom: 12px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; padding: 12px; }
.paper-spec { margin-left: auto; color: #5d7077; font-size: 11px; }
.imposition-grid { display: grid; grid-template-columns: 220px minmax(0,1fr) 380px; gap: 12px; align-items: start; }
.pages-panel { max-height: 760px; overflow: auto; }
.page-list { padding: 8px; }
.page-list button { display: grid; width: 100%; grid-template-columns: 42px 1fr auto; gap: 8px; align-items: center; padding: 8px; border: 0; border-radius: 7px; text-align: left; background: transparent; cursor: pointer; }
.page-list button:hover:not(:disabled) { background: #eff5f4; }
.page-list button:disabled { opacity: .42; cursor: not-allowed; }
.thumb { display: grid; width: 38px; height: 50px; place-items: center; border: 1px solid #bdc7c9; background: #f4f3ef; font-size: 9px; font-weight: 800; }
.thumb i { width: 18px; height: 2px; background: #c36f42; }
.page-list strong, .page-list small { display: block; }
.page-list strong { font-size: 11px; }
.page-list small { margin-top: 4px; color: #7c898e; font-size: 9px; }
.canvas-panel { min-width: 0; }
.canvas-scroll { max-height: 760px; overflow: auto; padding: 18px; background: #34464c; }
.right-panel { display: grid; gap: 12px; }
.properties { display: grid; gap: 12px; padding: 14px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.properties label { display: grid; gap: 5px; color: #5f7076; font-size: 11px; font-weight: 700; }
.properties input, .properties select { width: 100%; padding: 8px; border: 1px solid #cbd5d7; border-radius: 6px; font: inherit; }
.binding-note { display: flex; gap: 7px; padding: 9px; color: #6a604f; background: #fff5e7; font-size: 11px; line-height: 1.5; }
.empty { padding: 28px; color: #7e8a8f; text-align: center; font-size: 12px; }
.head-tags { display: flex; gap: 6px; }
.validation-list { max-height: 420px; overflow: auto; padding: 7px; }
.issue-row { border-radius: 7px; }
.issue-row.error { background: #fdf3f1; }
.issue-row.warning { background: #fdf8ee; }
.issue-main { display: grid; width: 100%; grid-template-columns: 22px 1fr 16px; gap: 7px; padding: 10px; border: 0; border-radius: 7px; text-align: left; background: transparent; cursor: pointer; }
.issue-main:hover { background: rgba(0,0,0,.04); }
.issue-main.error > i:first-child { color: #bd4a34; }
.issue-main.warning > i:first-child { color: #bf7f2c; }
.issue-main strong { font-size: 11px; }
.issue-main p { margin: 4px 0 0; color: #738087; font-size: 10px; line-height: 1.45; }
.waiver-row { display: flex; align-items: center; gap: 7px; padding: 2px 10px 9px 39px; flex-wrap: wrap; }
.fp { color: #8a979c; font-family: monospace; font-size: 10px; }
.fp.muted { color: #a7b2b6; }
.history-panel { margin-top: 14px; }
.history-list { padding: 6px 14px 12px; }
.history-row { border-bottom: 1px solid #edf1f1; }
.history-row > header { display: grid; grid-template-columns: 260px 1fr 180px; gap: 12px; align-items: center; padding: 11px 4px; cursor: pointer; }
.history-id { display: flex; align-items: center; gap: 8px; }
.history-id strong { font-size: 12px; }
.history-id code { color: #7a878d; font-size: 10px; }
.history-reason { color: #5c6b71; font-size: 11px; }
.history-meta { display: flex; align-items: center; justify-content: flex-end; gap: 8px; color: #7a878d; font-size: 10px; }
.history-row.待复核 > header { background: #fdf6e7; }
.history-row.已失效 > header { opacity: .65; }
.audit-trail { padding: 2px 4px 12px; }
.binding-line { margin-bottom: 8px; color: #5c6b71; font-size: 10px; }
.binding-line code { background: #eef2f2; padding: 2px 5px; border-radius: 4px; }
.audit-entry { display: grid; grid-template-columns: 130px 1fr; gap: 2px 10px; padding: 6px 0; border-top: 1px dashed #e4e9e9; }
.audit-at { color: #8a979c; font-size: 10px; font-family: monospace; }
.audit-entry strong { font-size: 11px; }
.audit-entry p { grid-column: 2; margin: 0; color: #738087; font-size: 10px; line-height: 1.5; }
.grant-body { display: grid; gap: 10px; }
.grant-body p { margin: 0; font-size: 12px; }
.fp-line { font-size: 11px; color: #5c6b71; }
.fp-line code { background: #eef2f2; padding: 2px 5px; border-radius: 4px; }
.grant-body label { display: grid; gap: 5px; color: #5f7076; font-size: 11px; font-weight: 700; }
.conflict-list { margin: 8px 0; padding: 0; list-style: none; }
.conflict-list li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #edf1f1; font-size: 12px; }
.conflict-list .diff { margin-left: auto; color: #9f4c38; font-family: monospace; font-size: 10px; }
@media (max-width: 1200px) { .imposition-grid { grid-template-columns: 200px minmax(0,1fr); } .right-panel { grid-column: 1 / -1; } .history-row > header { grid-template-columns: 1fr; gap: 4px; } }
@media (max-width: 760px) { .imposition-grid { grid-template-columns: 1fr; } .right-panel { grid-template-columns: 1fr; } .pages-panel { max-height: 300px; } }
</style>

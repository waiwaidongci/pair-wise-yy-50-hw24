<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import Slider from 'primevue/slider'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import Select from 'primevue/select'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import ExemptionDialog from '../components/ExemptionDialog.vue'
import LockDialog from '../components/LockDialog.vue'
import { useImpositionStore, type Station } from '../stores/imposition'
import { ReviewConflictError } from '../services/reviewLedger'

const store = useImpositionStore()
const router = useRouter()
const sideOptions = [
  { label: '正面', value: 'front' },
  { label: '反面', value: 'back' },
]
const stationOptions: Station[] = ['拼版工位', '审批工位']
const selected = computed(() => store.positions.find((item) => item.id === store.selectedPosition))
const selectedPage = computed(() => store.pages.find((page) => page.pageNo === selected.value?.pageNo))
const activeValidations = computed(() => store.validations.filter((item) => !item.pageNo || item.pageNo === selected.value?.pageNo || sideContains(item.pageNo)))

const exemptionIssueId = ref<string | null>(null)
const lockOpen = ref(false)
const simMessage = ref('')

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

function exemptionOf(issueId: string) {
  return store.exemptionByIssue.get(issueId)
}

async function simulate(scenario: 'move' | 'bleed' | 'lock' | 'fail') {
  simMessage.value = ''
  if (scenario === 'fail') {
    store.armFailure()
    simMessage.value = '已注入一次写入失败：下一次放行/锁定会失败，可按原记录号重试。'
    return
  }
  await store.otherStationSaved(scenario)
  simMessage.value =
    scenario === 'lock'
      ? '另一工位（审批工位）已先锁定：你仍持有打开时的旧版本，执行放行或锁定时将收到冲突。'
      : '另一工位已先保存版位变更：你仍持有打开时的旧版本，执行放行或锁定时将收到冲突并列出被改对象。'
}

function bumpRevision() {
  store.revision = `R${Number(store.revision.slice(1)) + 1}`
}

async function unlockBaseline() {
  try {
    await store.unlock(store.beginRecord())
  } catch (error) {
    simMessage.value = error instanceof ReviewConflictError ? `解锁被拒：${error.message}` : '解锁写入失败，请重试。'
  }
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">IMPOSITION / 拼版工作区</p><h1>Canvas 版位编排与预检</h1><p class="muted">拖动版位或调整出血、装订方向，已放行豁免立即失效并重新校验；每条放行绑定问题指纹与当次版位摘要。</p></div>
      <div class="actions">
        <Button label="复核记录" icon="pi pi-shield" outlined @click="router.push('/review')">
          <template v-if="store.pendingReviewCount"><Tag :value="store.pendingReviewCount" severity="warn" /></template>
        </Button>
        <Button label="保存拼版版本" icon="pi pi-save" @click="bumpRevision" />
      </div>
    </div>

    <Message v-if="store.lockMismatch" severity="error" :closable="false" class="mb-3">
      审批锁定依据（{{ store.lockBasis?.layoutDigest.slice(0, 10) }}）与当前版位摘要（{{ store.layoutDigest.slice(0, 10) }}）不一致：版位已变化，相关豁免已自动失效，请重新校验并重新锁定。
    </Message>
    <Message v-else-if="store.blockingErrors.length" severity="warn" :closable="false" class="mb-3">
      当前版本有 {{ store.blockingErrors.length }} 个未放行阻断错误；另有 {{ store.exemptionByIssue.size }} 条已登记有效豁免。待复核 {{ store.pendingReviewCount }} 条。
    </Message>
    <Message v-else-if="store.validations.length" severity="success" :closable="false" class="mb-3">
      {{ store.validations.length }} 项预检均已有有效放行豁免绑定当前版位摘要；待复核 {{ store.pendingReviewCount }} 条。
    </Message>
    <Message v-if="store.revalidationError" severity="error" :closable="false" class="mb-3">{{ store.revalidationError }}</Message>
    <Message v-if="simMessage" severity="info" :closable="false" class="mb-3">{{ simMessage }}</Message>

    <div class="toolbar panel">
      <SelectButton v-model="store.side" :options="sideOptions" optionLabel="label" optionValue="value" />
      <span class="muted">缩放 {{ store.zoom }}%</span>
      <Slider v-model="store.zoom" :min="35" :max="100" :step="5" style="width:150px" />
      <label class="spec-edit">装订方向
        <Select v-model="store.binding" :options="['骑马订', '胶订', '锁线订']" :disabled="store.locked" style="width:110px" @change="simMessage = ''" />
      </label>
      <span class="paper-spec">摘要 <code>{{ store.layoutDigest }}</code> · V{{ store.sessionDocVersion }} · {{ store.locked ? `基线只读 · ${store.lockBasis?.revision}` : '编辑中' }}</span>
      <Select v-model="store.station" :options="stationOptions" size="small" style="width:128px" />
      <Button v-if="!store.locked" label="审批锁定" icon="pi pi-lock" size="small" @click="lockOpen = true" />
      <Button v-else label="解锁修订" icon="pi pi-lock-open" size="small" severity="warn" outlined @click="unlockBaseline" />
    </div>

    <div class="sim-bar panel">
      <span class="sim-title"><i class="pi pi-bolt" /> 并发 / 故障联调</span>
      <Button label="另一工位拖动版位" size="small" text @click="simulate('move')" />
      <Button label="另一工位换 P7 出血" size="small" text @click="simulate('bleed')" />
      <Button label="另一工位先锁定" size="small" text @click="simulate('lock')" />
      <Button label="注入一次写入失败" size="small" text severity="danger" @click="simulate('fail')" />
    </div>

    <div class="imposition-grid">
      <aside class="panel pages-panel">
        <div class="panel-head"><h3>页面文件</h3><Tag :value="`${store.pages.length}P`" /></div>
        <div class="page-list">
          <div v-for="page in store.pages" :key="page.pageNo" class="page-row" :class="{ placed: store.positions.some((item) => item.pageNo === page.pageNo && item.front === (store.side === 'front')) }">
            <div class="thumb"><span>P{{ page.pageNo }}</span><i /></div>
            <div>
              <strong>{{ page.name }}</strong>
              <small>{{ page.width }}×{{ page.height }} · 出血
                <input type="number" :value="page.bleed" :disabled="store.locked" min="0" max="9" @change="store.updatePage(page.pageNo, { bleed: Number(($event.target as HTMLInputElement).value) })" /> mm
              </small>
            </div>
            <button class="add-btn" :disabled="store.positions.some((item) => item.pageNo === page.pageNo && item.front === (store.side === 'front')) || store.locked" @click="store.addPosition(page.pageNo)"><i class="pi pi-plus" /></button>
          </div>
        </div>
      </aside>

      <section class="panel canvas-panel">
        <div class="panel-head"><h3>{{ store.side === 'front' ? '正面版式' : '反面版式' }}</h3><span class="muted">拖动页面 · 点击选择 · 摘要随拖动变化</span></div>
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
            <label>页面<select :value="selected.pageNo" :disabled="store.locked" @change="store.updatePosition(selected.id, { pageNo: Number(($event.target as HTMLSelectElement).value) })"><option v-for="page in store.pages" :key="page.pageNo" :value="page.pageNo">P{{ page.pageNo }} · {{ page.name }}</option></select></label>
            <div class="pair"><label>X<input type="number" :value="selected.x" :disabled="store.locked" @change="store.updatePosition(selected.id, { x: Number(($event.target as HTMLInputElement).value) })" /></label><label>Y<input type="number" :value="selected.y" :disabled="store.locked" @change="store.updatePosition(selected.id, { y: Number(($event.target as HTMLInputElement).value) })" /></label></div>
            <label>旋转方向<select :value="selected.rotation" :disabled="store.locked" @change="store.updatePosition(selected.id, { rotation: Number(($event.target as HTMLSelectElement).value) })"><option :value="0">0°</option><option :value="90">顺时针 90°</option><option :value="180">倒置 180°</option><option :value="270">顺时针 270°</option></select></label>
            <label v-if="selectedPage">该页出血
              <input type="number" :value="selectedPage.bleed" :disabled="store.locked" min="0" max="9" @change="store.updatePage(selectedPage.pageNo, { bleed: Number(($event.target as HTMLInputElement).value) })" />
            </label>
            <div class="binding-note"><i class="pi pi-info-circle" /><span>{{ store.pages.find((page) => page.pageNo === selected?.pageNo)?.content }}</span></div>
          </div>
          <div v-else class="empty">在画布中选择一个版位以编辑属性。</div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h3>预检结果与放行</h3>
            <Tag :value="`${activeValidations.length} 项 · 待复核 ${store.pendingReviewCount}`" :severity="store.blockingErrors.length ? 'danger' : 'success'" />
          </div>
          <div class="validation-list">
            <div v-for="issue in activeValidations" :key="issue.id" class="issue" :class="issue.severity">
              <button class="issue-main" @click="locate(issue.pageNo)">
                <i :class="issue.severity === '错误' ? 'pi pi-times-circle' : 'pi pi-exclamation-triangle'" />
                <div><strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p></div>
                <i class="pi pi-arrow-right" />
              </button>
              <div v-if="exemptionOf(issue.id)" class="exemption-line">
                <Tag value="已放行" severity="success" />
                <small>{{ exemptionOf(issue.id)?.id }} · 绑定当前摘要 · {{ exemptionOf(issue.id)?.operator }}</small>
              </div>
              <div v-else class="exemption-line">
                <Tag value="未放行" :severity="issue.severity === '错误' ? 'danger' : 'warn'" />
                <Button label="登记放行豁免" size="small" text icon="pi pi-shield" :disabled="store.locked" @click="exemptionIssueId = issue.id" />
              </div>
            </div>
            <div v-if="!activeValidations.length" class="empty">当前选择范围没有预检问题。</div>
          </div>
        </section>
      </aside>
    </div>

    <ExemptionDialog :issue-id="exemptionIssueId" @close="exemptionIssueId = null" />
    <LockDialog :open="lockOpen" @close="lockOpen = false" />
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.mb-3 { margin-bottom: 12px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; padding: 12px; }
.spec-edit { display: flex; align-items: center; gap: 6px; color: #5d7077; font-size: 11px; font-weight: 700; }
.paper-spec { margin-left: auto; color: #5d7077; font-size: 11px; }
.paper-spec code, .paper-spec { word-break: break-all; }
.sim-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; padding: 7px 12px; border-style: dashed; }
.sim-title { display: flex; align-items: center; gap: 6px; margin-right: 8px; color: #8a6a3b; font-size: 11px; font-weight: 700; }
.imposition-grid { display: grid; grid-template-columns: 220px minmax(0,1fr) 360px; gap: 12px; align-items: start; }
.pages-panel { max-height: 760px; overflow: auto; }
.page-list { padding: 8px; }
.page-row { display: grid; grid-template-columns: 42px 1fr auto; gap: 8px; align-items: center; padding: 8px; border-radius: 7px; }
.page-row.placed { opacity: .45; }
.thumb { display: grid; width: 38px; height: 50px; place-items: center; border: 1px solid #bdc7c9; background: #f4f3ef; font-size: 9px; font-weight: 800; }
.thumb i { width: 18px; height: 2px; background: #c36f42; }
.page-row strong, .page-row small { display: block; }
.page-row strong { font-size: 11px; }
.page-row small { margin-top: 4px; color: #7c898e; font-size: 9px; }
.page-row small input { width: 34px; padding: 2px 4px; border: 1px solid #cbd5d7; border-radius: 4px; font: inherit; font-size: 10px; }
.add-btn { border: 0; background: transparent; color: #3d8a7c; cursor: pointer; font-size: 14px; }
.add-btn:disabled { opacity: .35; cursor: not-allowed; }
.canvas-panel { min-width: 0; }
.canvas-scroll { max-height: 760px; overflow: auto; padding: 18px; background: #34464c; }
.right-panel { display: grid; gap: 12px; }
.properties { display: grid; gap: 12px; padding: 14px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.properties label { display: grid; gap: 5px; color: #5f7076; font-size: 11px; font-weight: 700; }
.properties input, .properties select { width: 100%; padding: 8px; border: 1px solid #cbd5d7; border-radius: 6px; font: inherit; }
.binding-note { display: flex; gap: 7px; padding: 9px; color: #6a604f; background: #fff5e7; font-size: 11px; line-height: 1.5; }
.empty { padding: 28px; color: #7e8a8f; text-align: center; font-size: 12px; }
.validation-list { max-height: 430px; overflow: auto; padding: 7px; }
.issue { border-radius: 7px; }
.issue:hover { background: #f5f7f7; }
.issue-main { display: grid; width: 100%; grid-template-columns: 22px 1fr 16px; gap: 7px; padding: 10px; border: 0; text-align: left; background: transparent; cursor: pointer; }
.issue.error > .issue-main > i:first-child { color: #bd4a34; }
.issue.warning > .issue-main > i:first-child { color: #bf7f2c; }
.issue-main strong { font-size: 11px; }
.issue-main p { margin: 4px 0 0; color: #738087; font-size: 10px; line-height: 1.45; }
.exemption-line { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 2px 10px 9px 38px; }
.exemption-line small { color: #4d816c; font-size: 9px; }
@media (max-width: 1200px) { .imposition-grid { grid-template-columns: 200px minmax(0,1fr); } .right-panel { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; } }
@media (max-width: 760px) { .imposition-grid { grid-template-columns: 1fr; } .right-panel { grid-template-columns: 1fr; } .pages-panel { max-height: 300px; } }
</style>

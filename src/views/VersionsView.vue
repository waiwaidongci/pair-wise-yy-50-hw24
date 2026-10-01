<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import LockDialog from '../components/LockDialog.vue'
import { useImpositionStore } from '../stores/imposition'
import type { Position } from '../stores/imposition'

const store = useImpositionStore()
const router = useRouter()
const lockOpen = ref(false)

// 基线 = 锁定依据所在版本（或最早可查历史）；候选 = 当前版位
const baselineLog = computed(() => {
  const logs = store.ledger.history
  if (!logs.length) return null
  return logs.find((log) => store.lockBasis && log.layoutDigest === store.lockBasis.layoutDigest) ?? logs[0]
})
const currentLog = computed(() => store.ledger.history.find((log) => log.version === store.sessionDocVersion) ?? null)

function restorePositions(log: NonNullable<typeof baselineLog.value>): Position[] {
  return Object.entries(log.positions).map(([id, p]) => ({ id, pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front }))
}

const baselinePositions = computed<Position[]>(() => (baselineLog.value ? restorePositions(baselineLog.value) : store.positions))

type ChangeRow = { id: string; title: string; before: string; after: string; risk: '低' | '中' | '高' }
const changes = computed<ChangeRow[]>(() => {
  if (!baselineLog.value) return []
  const rows: ChangeRow[] = []
  const base = baselineLog.value
  store.positions.forEach((pos) => {
    const before = base.positions[pos.id]
    if (!before) rows.push({ id: pos.id, title: `${pos.id}（P${pos.pageNo}）新增版位`, before: '不存在', after: `x${pos.x}/y${pos.y}/r${pos.rotation}`, risk: '中' })
    else if (before.x !== pos.x || before.y !== pos.y) rows.push({ id: pos.id, title: `${pos.id}（P${pos.pageNo}）版位移动`, before: `x${before.x} / y${before.y}`, after: `x${pos.x} / y${pos.y}`, risk: '低' })
    else if (before.rotation !== pos.rotation) rows.push({ id: pos.id, title: `${pos.id}（P${pos.pageNo}）旋转方向变化`, before: `${before.rotation}°`, after: `${pos.rotation}°`, risk: '中' })
    else if (before.front !== pos.front) rows.push({ id: pos.id, title: `${pos.id}（P${pos.pageNo}）正反面调整`, before: before.front ? '正面' : '反面', after: pos.front ? '正面' : '反面', risk: '高' })
  })
  Object.entries(base.positions).forEach(([id, before]) => {
    if (!store.positions.some((p) => p.id === id)) rows.push({ id, title: `${id}（P${before.pageNo}）版位删除`, before: `x${before.x}/y${before.y}`, after: '已删除', risk: '高' })
  })
  Object.entries(base.bleeds).forEach(([pageNo, bleed]) => {
    const now = store.pages.find((p) => p.pageNo === Number(pageNo))?.bleed
    if (now !== undefined && now !== bleed) rows.push({ id: `P${pageNo}`, title: `P${pageNo} 页面出血变化`, before: `${bleed}mm`, after: `${now}mm`, risk: Number(now) < (bleed as number) ? '高' : '中' })
  })
  if (base.binding !== store.binding || base.grain !== store.grain) rows.push({ id: 'sheet', title: '装订方向 / 纸纹变化', before: `${base.binding} · ${base.grain}`, after: `${store.binding} · ${store.grain}`, risk: '高' })
  return rows
})

const accepted = ref<string[]>([])
const versionLogs = computed(() => store.ledger.history.slice().reverse())
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">VERSION COMPARE / 版本对比</p>
        <h1>拼版版本并排审阅</h1>
        <p class="muted">基线与当前版位按复核记录中的版位摘要对比；审批锁定显示其依据的摘要与版本，待复核 {{ store.pendingReviewCount }} 条（与总览、拼版预检一致）。</p>
      </div>
      <div class="actions">
        <Button label="复核记录" icon="pi pi-shield" outlined @click="router.push('/review')">
          <Tag :value="`${store.pendingReviewCount} 待复核`" :severity="store.pendingReviewCount ? 'warn' : 'success'" />
        </Button>
        <Button :label="store.locked ? '已锁定' : '接受变更并锁定'" icon="pi pi-lock" :disabled="store.locked || store.blockingErrors.length > 0" @click="lockOpen = true" />
      </div>
    </div>

    <div class="basis-bar panel">
      <div class="basis-item"><span>锁定状态</span><Tag :value="store.locked ? '已锁定' : '未锁定'" :severity="store.locked ? 'success' : 'info'" /></div>
      <div class="basis-item"><span>锁定依据版本</span><strong>{{ store.lockBasis ? `V${store.lockBasis.docVersion} · ${store.lockBasis.revision}` : '—' }}</strong></div>
      <div class="basis-item"><span>锁定依据摘要</span><code>{{ store.lockBasis?.layoutDigest ?? '—' }}</code></div>
      <div class="basis-item"><span>当前版位摘要</span><code>{{ store.layoutDigest }}</code></div>
      <div class="basis-item"><span>依据一致性</span><Tag :value="store.lockMismatch ? '已变化，豁免失效' : '一致'" :severity="store.lockMismatch ? 'danger' : 'success'" /></div>
      <div class="basis-item"><span>待复核豁免</span><strong :class="{ warn: store.pendingReviewCount > 0 }">{{ store.pendingReviewCount }}</strong></div>
    </div>

    <div class="compare-grid">
      <section class="panel">
        <div class="panel-head"><h3>基线 V{{ baselineLog?.version ?? '?' }}（{{ baselineLog?.note ?? '打开时版本' }}）</h3><Tag :value="baselineLog?.layoutDigest.slice(0, 10) ?? '只读'" /></div>
        <div class="canvas-box"><ImpositionCanvas :positions="baselinePositions" side="front" :zoom="38" :selected="null" :validations="[]" @update="() => {}" @select="() => {}" /></div>
      </section>
      <section class="panel candidate">
        <div class="panel-head"><h3>当前 V{{ currentLog?.version ?? store.sessionDocVersion }}</h3><Tag :value="`${changes.length} 项变更`" :severity="changes.length ? 'warn' : 'success'" /></div>
        <div class="canvas-box"><ImpositionCanvas :positions="store.positions" side="front" :zoom="38" :selected="null" :validations="store.validations" @update="() => {}" @select="() => {}" /></div>
      </section>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>版式变更差异（来自复核记录版本历史）</h3><span class="muted">勾选 {{ accepted.length }}/{{ changes.length }} 项</span></div>
      <div class="change-list">
        <article v-if="!changes.length" class="no-change"><i class="pi pi-check-circle" /> 相对基线没有版位、出血或装订方向差异；已放行豁免仍然有效。</article>
        <article v-for="change in changes" :key="change.id">
          <Checkbox v-model="accepted" :inputId="change.id" :value="change.id" />
          <div><strong>{{ change.id }} · {{ change.title }}</strong><div class="diff"><span class="before">{{ change.before }}</span><i class="pi pi-arrow-right" /><span class="after">{{ change.after }}</span></div></div>
          <Tag :value="`${change.risk}风险`" :severity="change.risk === '高' ? 'danger' : change.risk === '中' ? 'warn' : 'success'" />
        </article>
      </div>
    </section>

    <section class="panel history-panel">
      <div class="panel-head"><h3>版本与审计时间线</h3><span class="muted">每个版本保存当时的版位快照与工位</span></div>
      <div class="history-list">
        <div v-for="log in versionLogs" :key="log.version" class="log-row" :class="{ lock: log.locked, current: log.version === store.sessionDocVersion }">
          <Tag :value="`V${log.version}`" :severity="log.locked ? 'success' : 'info'" />
          <div><strong>{{ log.note }}</strong><small>{{ log.station }} · {{ log.at }} · 摘要 <code>{{ log.layoutDigest.slice(0, 10) }}</code></small></div>
          <span v-for="text in log.granted" :key="text" class="granted">{{ text }}</span>
        </div>
      </div>
    </section>

    <LockDialog :open="lockOpen" @close="lockOpen = false" />
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.basis-bar { display: flex; flex-wrap: wrap; gap: 22px; padding: 14px 18px; margin-bottom: 14px; }
.basis-item span { display: block; margin-bottom: 6px; color: #82909a; font-size: 10px; }
.basis-item strong { font-size: 12px; color: #30464d; }
.basis-item .warn { color: #c4872f; }
.basis-item code { font-size: 10px; background: #eef2f2; padding: 3px 6px; border-radius: 4px; }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.candidate { border-color: #5d9693; }
.canvas-box { height: 440px; overflow: auto; padding: 12px; background: #35474d; }
.change-panel { overflow: hidden; margin-bottom: 14px; }
.change-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid #edf1f1; }
.change-list article.no-change { display: flex; gap: 9px; color: #3b8a67; font-size: 12px; }
.change-list strong { font-size: 12px; }
.diff { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-family: monospace; font-size: 10px; }
.diff span { padding: 4px 6px; border-radius: 4px; }
.before { color: #9f4c38; background: #fff0ec; }
.after { color: #2d735b; background: #e9f5ef; }
.diff i { color: #a08a68; }
.history-panel { overflow: hidden; }
.history-list { padding: 10px 16px 16px; display: grid; gap: 8px; }
.log-row { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border-radius: 8px; background: #f7f9f9; font-size: 11px; flex-wrap: wrap; }
.log-row.lock { background: #eef7f1; }
.log-row.current { box-shadow: inset 3px 0 #337b79; }
.log-row strong, .log-row small { display: block; }
.log-row small { margin-top: 3px; color: #7d8b91; }
.log-row code { font-size: 9px; background: #e7ecec; padding: 2px 4px; border-radius: 4px; }
.granted { padding: 4px 8px; border-radius: 5px; background: #fff4e4; color: #9a6a2f; font-size: 10px; }
@media (max-width: 1000px) { .compare-grid { grid-template-columns: 1fr; } }
</style>

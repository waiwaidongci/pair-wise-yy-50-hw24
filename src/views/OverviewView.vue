<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import { useImpositionStore } from '../stores/imposition'

const store = useImpositionStore()
const router = useRouter()
const errors = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const pendingProof = computed(() => store.proofs.find((proof) => proof.decision === '待决定'))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">PRINT PRODUCTION / 印刷生产</p><h1>拼版预检与打样总览</h1><p class="muted">在当前拼版版本进入生产前，集中处理页序、出血、色彩、装订风险与放行豁免复核。</p></div>
      <div class="actions"><Button label="运行完整预检" icon="pi pi-check-circle" outlined /><Button label="进入拼版工作区" icon="pi pi-th-large" @click="router.push('/imposition')" /></div>
    </div>

    <div class="metric-grid">
      <article class="metric"><span>页面文件</span><strong>{{ store.pages.length }}</strong><small>{{ store.positions.length }} 个已排版位</small></article>
      <article class="metric"><span>预检错误</span><strong class="error">{{ errors }}</strong><small>{{ store.exemptionByIssue.size }} 条已放行 · {{ store.blockingErrors.length }} 条阻断</small></article>
      <article class="metric clickable" @click="router.push('/review')"><span>豁免待复核</span><strong :class="{ warn: store.pendingReviewCount > 0 }">{{ store.pendingReviewCount }}</strong><small>与拼版预检、版本对比一致</small></article>
      <article class="metric"><span>打样轮次</span><strong>{{ store.proofs.length }}</strong><small>当前 ΔE {{ pendingProof?.deltaE ?? '—' }}</small></article>
    </div>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head"><h3>当前拼版任务</h3><Tag :value="store.revision" severity="info" /></div>
        <div class="project-card">
          <div>
            <strong>《潮汐来信》上海巡演节目册</strong>
            <p>成品 210 × 297mm · 8P · {{ store.binding }} · 720 × 1020mm 对开纸</p>
            <div class="specs"><span>CMYK + 专色</span><span>{{ store.grain }}纸纹</span><span>PDF/X-4</span><span>版位摘要 {{ store.layoutDigest.slice(0, 10) }}</span></div>
          </div>
          <Button label="打开拼版" icon="pi pi-arrow-right" @click="router.push('/imposition')" />
        </div>
        <div class="checklist">
          <div><i class="pi pi-check-circle" /><span>页面尺寸与成品规格</span><Tag value="通过" severity="success" /></div>
          <div :class="{ open: store.pendingReviewCount > 0 }" @click="router.push('/review')">
            <i :class="store.pendingReviewCount ? 'pi pi-exclamation-triangle warn' : 'pi pi-check-circle'" /><span>放行豁免复核（旧数据无指纹）</span>
            <Tag :value="`${store.pendingReviewCount} 条待复核`" :severity="store.pendingReviewCount ? 'warn' : 'success'" />
          </div>
          <div :class="{ open: store.lockMismatch }" @click="router.push('/versions')">
            <i :class="store.lockMismatch ? 'pi pi-times-circle error' : 'pi pi-check-circle'" /><span>审批锁定依据 = 当前版位摘要</span>
            <Tag :value="store.lockMismatch ? '依据已过期' : '一致'" :severity="store.lockMismatch ? 'danger' : 'success'" />
          </div>
          <div><i :class="store.blockingErrors.length ? 'pi pi-times-circle error' : 'pi pi-check-circle'" /><span>出血与版位安全区</span><Tag :value="store.blockingErrors.length ? `${store.blockingErrors.length} 项未放行` : '均已放行/通过'" :severity="store.blockingErrors.length ? 'danger' : 'success'" /></div>
          <div><i class="pi pi-check-circle" /><span>色彩控制条与纸张规格</span><Tag value="通过" severity="success" /></div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>放行豁免状态</h3><Button label="复核记录" text size="small" @click="router.push('/review')" /></div>
          <div class="exemption-summary">
            <div><i class="pi pi-check-circle" /><span>有效（绑定当前摘要）</span><strong>{{ store.activeExemptions.length }}</strong></div>
            <div class="clickable warn-row" @click="router.push('/review')"><i class="pi pi-hourglass" /><span>待复核（旧数据无指纹）</span><strong>{{ store.pendingReviewCount }}</strong></div>
            <div><i class="pi pi-bolt" /><span>已失效（版位/出血变化）</span><strong>{{ store.invalidExemptions.length }}</strong></div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>最近打样</h3><Button label="查看全部" text size="small" @click="router.push('/proofs')" /></div>
          <div class="proof-summary">
            <template v-for="proof in store.proofs.slice().reverse()" :key="proof.id">
              <div class="proof-row">
                <div><strong>第 {{ proof.round }} 轮 · {{ proof.sample }}</strong><small>{{ proof.date }} · ΔE {{ proof.deltaE }}</small></div>
                <Tag :value="proof.decision" :severity="proof.decision === '通过' ? 'success' : proof.decision === '退回' ? 'danger' : 'warn'" />
              </div>
            </template>
          </div>
        </section>
        <section class="panel export-mini">
          <div class="panel-head"><h3>导出任务</h3></div>
          <div v-for="task in store.tasks" :key="task.id">
            <div><span>{{ task.name }}</span><strong>{{ task.progress }}%</strong></div>
            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '7px' }" />
            <small>{{ task.status }} · {{ task.updatedAt }}</small>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric .error { color: #b84e35; }
.metric .warn { color: #c4872f; }
.metric.clickable { cursor: pointer; }
.metric.clickable:hover { border-color: #b9cdcf; }
.overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; align-items: start; }
.project-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px; }
.project-card strong { font-size: 17px; }
.project-card p { margin: 7px 0 14px; color: #66757c; }
.specs { display: flex; flex-wrap: wrap; gap: 7px; }
.specs span { padding: 5px 8px; border-radius: 5px; color: #45676d; background: #eef4f4; font-size: 10px; }
.checklist { padding: 0 18px 16px; }
.checklist > div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 9px; padding: 11px 0; border-top: 1px solid #ecf0f0; font-size: 12px; }
.checklist > div.open { cursor: pointer; }
.checklist i { color: #3b8a67; }
.checklist i.warn { color: #c4872f; }
.checklist i.error { color: #bb4c35; }
aside { display: grid; gap: 14px; }
.exemption-summary { padding: 8px 16px 14px; }
.exemption-summary > div { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #f0f3f3; font-size: 12px; }
.exemption-summary i { color: #3b8a67; }
.exemption-summary .warn-row { cursor: pointer; }
.exemption-summary .warn-row i { color: #c4872f; }
.exemption-summary strong { font-size: 16px; color: #2e4a51; }
.proof-summary { padding: 8px 16px 14px; }
.proof-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid #edf1f1; }
.proof-row strong, .proof-row small { display: block; }
.proof-row small { margin-top: 4px; color: #7a878d; font-size: 10px; }
.export-mini > div:not(.panel-head) { padding: 11px 16px 4px; }
.export-mini > div > div { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 11px; }
.export-mini small { display: block; margin-top: 5px; color: #7d898e; }
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr; } }
</style>

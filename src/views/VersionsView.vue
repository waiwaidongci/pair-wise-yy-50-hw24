<script setup lang="ts">
import { ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import ImpositionCanvas from '../components/ImpositionCanvas.vue'
import { useImpositionStore } from '../stores/imposition'

const store = useImpositionStore()
const accepted = ref(['CH-02', 'CH-03'])
const changes = [
  { id: 'CH-01', title: 'P7 右移 18mm 并增加 2mm 出血', before: 'x 34 / bleed 1mm', after: 'x 52 / bleed 3mm', risk: '低' },
  { id: 'CH-02', title: 'P1 封面旋转 180° 以匹配骑马订折手', before: 'rotation 0°', after: 'rotation 180°', risk: '中' },
  { id: 'CH-03', title: 'P4 与 P5 跨页间距缩短 4mm', before: 'gutter 10mm', after: 'gutter 6mm', risk: '中' },
  { id: 'CH-04', title: 'P2 版权页采用低出血文件', before: 'bleed 2mm', after: 'bleed 1mm', risk: '高' },
]
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">VERSION COMPARE / 版本对比</p><h1>拼版版本并排审阅</h1><p class="muted">基线 R5 与候选 R6 对比，变更可逐项接受；锁定后生成只读生产版本。</p></div>
      <div class="actions">
        <Button label="导出对比报告" icon="pi pi-file-export" outlined />
        <Button :label="store.locked ? '已锁定' : '接受变更并锁定'" icon="pi pi-lock" :disabled="store.locked || accepted.length === 0 || store.lockBlocked" :title="store.lockBlocked ? '有待复核豁免，不能锁定当前版本' : ''" @click="store.lockBaseline" />
      </div>
    </div>

    <Message v-if="store.pendingReviewCount" severity="warn" :closable="false" class="mb-3">
      待复核豁免 {{ store.pendingReviewCount }} 条（与总览、拼版预检同一数量）：版位、出血或装订变更后须重新校验并绑定当前指纹，否则不能锁定版本。
    </Message>

    <div class="compare-grid">
      <section class="panel">
        <div class="panel-head"><h3>基线 R5</h3><Tag value="只读" /></div>
        <div class="canvas-box"><ImpositionCanvas :positions="store.positions" side="front" :zoom="38" :selected="null" :validations="store.validations" @update="() => {}" @select="() => {}" /></div>
      </section>
      <section class="panel candidate">
        <div class="panel-head"><h3>候选 R6</h3><Tag value="4 项变更" severity="warn" /></div>
        <div class="canvas-box"><ImpositionCanvas :positions="store.positions" side="front" :zoom="38" :selected="null" :validations="store.validations" @update="() => {}" @select="() => {}" /></div>
      </section>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>版式变更差异</h3><span class="muted">接受 {{ accepted.length }}/{{ changes.length }} 项</span></div>
      <div class="change-list">
        <article v-for="change in changes" :key="change.id">
          <Checkbox v-model="accepted" :inputId="change.id" :value="change.id" />
          <div><strong>{{ change.id }} · {{ change.title }}</strong><div class="diff"><span class="before">{{ change.before }}</span><i class="pi pi-arrow-right" /><span class="after">{{ change.after }}</span></div></div>
          <Tag :value="`${change.risk}风险`" :severity="change.risk === '高' ? 'danger' : change.risk === '中' ? 'warn' : 'success'" />
        </article>
      </div>
    </section>

    <section class="panel change-panel">
      <div class="panel-head"><h3>待复核豁免（{{ store.pendingReviewCount }}）</h3><Button label="前往拼版预检重新校验" text size="small" @click="$router.push('/imposition')" /></div>
      <div v-if="!store.pendingReviewCount" class="review-empty"><i class="pi pi-check-circle" /><span>无待复核豁免，所有放行均绑定当前版位指纹。</span></div>
      <div v-else class="change-list">
        <article v-for="waiver in store.waivers.filter((item) => item.status === '待复核')" :key="waiver.id">
          <div><strong>{{ waiver.id }} · {{ waiver.issueId }}</strong><div class="diff"><span class="before">{{ waiver.fingerprint || '未绑定指纹' }}</span><i class="pi pi-arrow-right" /><span class="after">{{ waiver.layoutSummary || '待绑定当前版位摘要' }}</span></div></div>
          <Tag value="待复核" severity="warn" />
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.mb-3 { margin-bottom: 12px; }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.candidate { border-color: #5d9693; }
.canvas-box { height: 440px; overflow: auto; padding: 12px; background: #35474d; }
.change-panel { overflow: hidden; margin-bottom: 14px; }
.change-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid #edf1f1; }
.change-list strong { font-size: 12px; }
.diff { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-family: monospace; font-size: 10px; }
.diff span { padding: 4px 6px; border-radius: 4px; }
.before { color: #9f4c38; background: #fff0ec; }
.after { color: #2d735b; background: #e9f5ef; }
.review-empty { display: flex; align-items: center; gap: 8px; padding: 16px; color: #3b8a67; font-size: 12px; }
@media (max-width: 1000px) { .compare-grid { grid-template-columns: 1fr; } }
</style>

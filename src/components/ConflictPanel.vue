<script setup lang="ts">
import Button from 'primevue/button'
import type { ReviewConflictError } from '../services/reviewLedger'

const props = defineProps<{
  conflict?: ReviewConflictError | null
  networkError?: string
  retried?: boolean
}>()

const emit = defineEmits<{
  retry: []
  rebaseRetry: []
  cancel: []
}>()
</script>

<template>
  <div class="conflict-box">
    <template v-if="props.conflict">
      <div class="conflict-head"><i class="pi pi-users" /><strong>检测到另一工位已保存</strong></div>
      <p>你打开的是 V{{ props.conflict.expectedVersion }}，服务器当前为 V{{ props.conflict.actualVersion }}。以下对象已被改动：</p>
      <ul class="changed-list">
        <li v-for="(item, index) in props.conflict.changedObjects" :key="index">
          <span class="obj-label">{{ item.scopeLabel }}</span>
          <div class="diff-line"><span class="before">{{ item.before }}</span><i class="pi pi-arrow-right" /><span class="after">{{ item.after }}</span></div>
        </li>
      </ul>
      <p class="keep-hint"><i class="pi pi-inbox" /> 已按最新版本重开，你填写的理由仍保留，确认后按原记录号提交。</p>
      <div class="conflict-actions">
        <Button label="放弃保存" text size="small" @click="emit('cancel')" />
        <Button label="以最新版本重开并重试" icon="pi pi-refresh" size="small" severity="warn" @click="emit('rebaseRetry')" />
      </div>
    </template>
    <template v-else>
      <div class="conflict-head error"><i class="pi pi-times-circle" /><strong>写入失败，记录未提交</strong></div>
      <p>{{ props.networkError }}</p>
      <p class="keep-hint"><i class="pi pi-database" /> 豁免与审计在同一事务中，失败不会产生半批结果。请按原记录号重试：<code>{{ props.retried ? '（已成功回放）' : '' }}</code></p>
      <div class="conflict-actions">
        <Button label="放弃" text size="small" @click="emit('cancel')" />
        <Button label="按原记录号重试" icon="pi pi-replay" size="small" @click="emit('retry')" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.conflict-box { border: 1px solid #e3c08c; border-radius: 8px; background: #fffaef; padding: 12px; margin-top: 10px; }
.conflict-head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.conflict-head i { color: #c0842f; font-size: 14px; }
.conflict-head.error i { color: #b8492f; }
.conflict-box p { margin: 8px 0; color: #6f6253; font-size: 11px; line-height: 1.55; }
.changed-list { display: grid; gap: 7px; margin: 8px 0; padding: 0; list-style: none; }
.changed-list li { padding: 8px; border-radius: 6px; background: white; border: 1px solid #efe2cc; }
.obj-label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; color: #40525a; }
.diff-line { display: flex; align-items: center; gap: 6px; font-family: monospace; font-size: 10px; flex-wrap: wrap; }
.diff-line .before { padding: 3px 6px; border-radius: 4px; color: #9f4c38; background: #fff0ec; }
.diff-line .after { padding: 3px 6px; border-radius: 4px; color: #2d735b; background: #e9f5ef; }
.diff-line i { color: #a08a68; }
.keep-hint { display: flex; align-items: center; gap: 6px; }
.conflict-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

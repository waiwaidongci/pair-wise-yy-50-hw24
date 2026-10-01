import { ref, shallowRef } from 'vue'
import { useImpositionStore } from '../stores/imposition'
import { ReviewConflictError, type CommitResult } from '../services/reviewLedger'

// 统一处理复核记录提交：
// - 保存只接受打开页面时的版本（乐观并发）
// - 网络失败时按原记录号重试（幂等，不产生重复豁免/审计）
// - 版本冲突时列出被改对象，用户以最新版本重开后重试，填写内容由调用方自行保留
export function useReviewSubmit() {
  const store = useImpositionStore()
  const phase = ref<'idle' | 'submitting' | 'network' | 'conflict'>('idle')
  const recordNo = ref('')
  const networkError = ref('')
  const retried = ref(false)
  const conflict = shallowRef<ReviewConflictError | null>(null)
  let pendingOp: ((recordNo: string) => Promise<CommitResult>) | null = null

  async function run(op: (recordNo: string) => Promise<CommitResult>, existingRecord?: string): Promise<boolean> {
    pendingOp = op
    // 每次新的提交生成新记录号；只有显式传入 existingRecord（写入失败重试）才沿用原记录号
    recordNo.value = existingRecord ?? store.beginRecord()
    phase.value = 'submitting'
    networkError.value = ''
    conflict.value = null
    try {
      const result = await op(recordNo.value)
      retried.value = result.retried
      phase.value = 'idle'
      return true
    } catch (error) {
      if (error instanceof ReviewConflictError) {
        conflict.value = error
        phase.value = 'conflict'
      } else {
        networkError.value = error instanceof Error ? error.message : '写入失败'
        phase.value = 'network'
      }
      return false
    }
  }

  // 写入失败后按原记录号重试：服务端按记录号幂等回放
  async function retrySameRecord(): Promise<boolean> {
    if (!pendingOp) return false
    return run(pendingOp, recordNo.value)
  }

  // 冲突后：先以服务器最新版本重开（不丢填写内容），再按原记录号提交
  async function rebaseAndRetry(): Promise<boolean> {
    if (!pendingOp) return false
    store.rebaseSession()
    return run(pendingOp, recordNo.value)
  }

  function reset() {
    phase.value = 'idle'
    conflict.value = null
    networkError.value = ''
    retried.value = false
    recordNo.value = ''
    pendingOp = null
  }

  return { phase, recordNo, networkError, retried, conflict, run, retrySameRecord, rebaseAndRetry, reset }
}

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  armWriteFailure,
  commitBatch,
  commitInvalidations,
  detectInvalidations,
  detectResolved,
  loadLedger,
  nextRecordNo,
  stampOpenVersion,
  type CommitResult,
  type Exemption,
  type LedgerState,
  type ReviewConflictError,
} from '../services/reviewLedger'
import { bindIssue, computeLayoutDigest, fingerprintMatchesIssue, type LayoutInput } from '../services/issueFingerprint'

export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type Position = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type Proof = { id: string; round: number; date: string; sample: string; deltaE: number; feedback: string; correction: string; owner: string; decision: '待决定' | '通过' | '退回' }
export type ExportTask = { id: string; name: string; progress: number; status: '排队中' | '生成中' | '已完成' | '已中断'; updatedAt: string; resumable: boolean }
export type Station = '拼版工位' | '审批工位'

const sheetDefaults = { width: 720, height: 1020, bleed: 3, safe: 5, gutter: 6, binding: '骑马订', grain: '纵向' }

const seedPages: Page[] = [
  { pageNo: 1, name: '封面', width: 210, height: 297, bleed: 3, content: '潮汐来信 / 节目册' },
  { pageNo: 2, name: '版权页', width: 210, height: 297, bleed: 2, content: '版权与演职人员' },
  { pageNo: 3, name: '序言', width: 210, height: 297, bleed: 3, content: '导演手记' },
  { pageNo: 4, name: '剧照跨页左', width: 210, height: 297, bleed: 3, content: '第一幕剧照' },
  { pageNo: 5, name: '剧照跨页右', width: 210, height: 297, bleed: 3, content: '第一幕剧照延伸' },
  { pageNo: 6, name: '曲目表', width: 210, height: 297, bleed: 3, content: '曲目与时长' },
  { pageNo: 7, name: '创作团队', width: 210, height: 297, bleed: 1, content: '主创与制作团队' },
  { pageNo: 8, name: '封底', width: 210, height: 297, bleed: 3, content: '巡演信息' },
]

const seedPositions: Position[] = [
  { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
  { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
  { id: 'P-03', pageNo: 6, x: 34, y: 548, rotation: 180, front: true },
  { id: 'P-04', pageNo: 3, x: 372, y: 548, rotation: 0, front: true },
  { id: 'P-05', pageNo: 2, x: 34, y: 44, rotation: 0, front: false },
  { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
  { id: 'P-07', pageNo: 4, x: 34, y: 548, rotation: 0, front: false },
  { id: 'P-08', pageNo: 5, x: 372, y: 548, rotation: 180, front: false },
]

const seedProofs: Proof[] = [
  { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 3.8, feedback: '封面夜空蓝偏紫，剧照暗部层次压缩。', correction: '调整 CMYK 曲线，黑色通道减少 4%。', owner: '周默 / 色彩管理', decision: '退回' },
  { id: 'PRF-02', round: 2, date: '2026-09-25', sample: '数字样张 v2', deltaE: 1.9, feedback: '整体色差改善，P7 出血仍不足。', correction: '重排 P7 版位并增加 2mm 出血。', owner: '林青 / 拼版', decision: '待决定' },
]

const seedTasks: ExportTask[] = [
  { id: 'EXP-0925-01', name: '印刷交付包 · PDF/X-4', progress: 72, status: '已中断', updatedAt: '09-25 16:42', resumable: true },
  { id: 'EXP-0925-02', name: '数字样张低分辨率预览', progress: 100, status: '已完成', updatedAt: '09-25 15:18', resumable: false },
]

export const useImpositionStore = defineStore('imposition', () => {
  const saved = localStorage.getItem('print-imposition-v1')
  const restored = saved ? JSON.parse(saved) : null
  const pages = ref<Page[]>(restored?.pages ?? structuredClone(seedPages))
  const positions = ref<Position[]>(restored?.positions ?? structuredClone(seedPositions))
  const proofs = ref<Proof[]>(restored?.proofs ?? structuredClone(seedProofs))
  const tasks = ref<ExportTask[]>(restored?.tasks ?? structuredClone(seedTasks))
  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const revision = ref(restored?.revision ?? 'R6')
  const binding = ref(restored?.binding ?? sheetDefaults.binding)
  const grain = ref(restored?.grain ?? sheetDefaults.grain)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref('PRF-02')

  // ── 复核记录（豁免 + 审计同一份账） ─────────────────────────────
  const station = ref<Station>('拼版工位')
  const ledger = ref<LedgerState>(loadLedger())
  // 打开页面时的版本：两个工位同时保存时只接受这个版本
  const sessionDocVersion = ref(ledger.value.docVersion)
  const revalidationError = ref('')
  let chain: Promise<void> = Promise.resolve()
  let revalidateTimer: ReturnType<typeof setTimeout> | undefined

  const locked = ref(ledger.value.lock !== null)

  const layoutInput = computed<LayoutInput>(() => ({
    positions: positions.value,
    pages: pages.value,
    binding: binding.value,
    grain: grain.value,
    sheetBleed: sheetDefaults.bleed,
  }))
  const layoutDigest = computed(() => computeLayoutDigest(layoutInput.value))
  const layoutCtx = computed(() => ({
    layoutDigest: layoutDigest.value,
    positions: positions.value.map((p) => ({ id: p.id, pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front })),
    pages: pages.value.map((p) => ({ pageNo: p.pageNo, bleed: p.bleed })),
    binding: binding.value,
    grain: grain.value,
  }))

  // 打开页面：为当前版本留一份版位快照，作为之后并发冲突的比对基线
  ledger.value = stampOpenVersion(ledger.value, layoutCtx.value)
  sessionDocVersion.value = ledger.value.docVersion

  const validations = computed<Validation[]>(() => {
    const issues: Validation[] = []
    const placedPages = positions.value.map((position) => position.pageNo)
    pages.value.forEach((page) => {
      if (!placedPages.includes(page.pageNo)) issues.push({ id: `missing-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 尚未拼版`, detail: `${page.name} 未出现在正反版位中。` })
      if (page.bleed < sheetDefaults.bleed) issues.push({ id: `bleed-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 出血不足`, detail: `页面出血 ${page.bleed}mm，低于印刷要求 ${sheetDefaults.bleed}mm。` })
    })
    for (let index = 0; index < positions.value.length; index += 1) {
      for (let next = index + 1; next < positions.value.length; next += 1) {
        const a = positions.value[index]
        const b = positions.value[next]
        if (a.front === b.front && Math.abs(a.x - b.x) < 320 && Math.abs(a.y - b.y) < 430) {
          issues.push({ id: `overlap-${a.id}-${b.id}`, severity: '错误', pageNo: a.pageNo, title: `${a.id} 与 ${b.id} 版位重叠`, detail: '当前纸张尺寸下页面之间不足安全间隙。' })
        }
      }
    }
    const frontOrder = positions.value.filter((item) => item.front).sort((a, b) => a.x - b.x || a.y - b.y).map((item) => item.pageNo)
    if (binding.value === '骑马订' && frontOrder[0] !== 1) issues.push({ id: 'binding-order', severity: '警告', pageNo: 1, title: '骑马订正版页序需要复核', detail: `当前首位为 P${frontOrder[0]}，${binding.value}规则期望封面位于首版位。` })
    return issues
  })

  // ── 豁免与预检条目的对应 ────────────────────────────────────────
  const activeExemptions = computed<Exemption[]>(() => ledger.value.exemptions.filter((item) => item.status === 'active'))
  const pendingReviewCount = computed(() => ledger.value.exemptions.filter((item) => item.status === 'pending_review').length)
  const invalidExemptions = computed(() => ledger.value.exemptions.filter((item) => item.status === 'invalid'))

  const exemptionByIssue = computed<Map<string, Exemption>>(() => {
    const map = new Map<string, Exemption>()
    validations.value.forEach((issue) => {
      const bindingInfo = bindIssue(issue.id, layoutInput.value)
      if (!bindingInfo) return
      const hit = activeExemptions.value.find((exemption) => {
        if (!exemption.fingerprint) return false
        return (
          exemption.fingerprint.code === bindingInfo.fingerprint.code &&
          exemption.fingerprint.ruleVersion === bindingInfo.fingerprint.ruleVersion &&
          exemption.fingerprint.args === bindingInfo.fingerprint.args
        )
      })
      if (hit) map.set(issue.id, hit)
    })
    return map
  })

  const coveredIssueIds = computed(() => new Set(exemptionByIssue.value.keys()))
  const blockingErrors = computed(() => validations.value.filter((item) => item.severity === '错误' && !coveredIssueIds.value.has(item.id)))
  const lockBasis = computed(() => ledger.value.lock)
  const lockMismatch = computed(() => locked.value && lockBasis.value !== null && lockBasis.value.layoutDigest !== layoutDigest.value)

  watch(
    [pages, positions, proofs, tasks, revision, locked, binding, grain],
    () => {
      localStorage.setItem(
        'print-imposition-v1',
        JSON.stringify({ pages: pages.value, positions: positions.value, proofs: proofs.value, tasks: tasks.value, revision: revision.value, locked: locked.value, binding: binding.value, grain: grain.value }),
      )
    },
    { deep: true },
  )

  // ── 版位 / 出血 / 装订方向一变：豁免立即失效并重新校验 ───────────
  function scheduleRevalidate() {
    revalidationError.value = ''
    clearTimeout(revalidateTimer)
    revalidateTimer = setTimeout(() => {
      chain = chain.then(runRevalidation)
    }, 120)
  }

  async function runRevalidation() {
    const snap = { ...layoutCtx.value, revision: revision.value }
    const current = ledger.value
    const due = [
      ...detectInvalidations(current, snap),
      ...detectResolved(current, snap, (fp) => fingerprintMatchesIssue(fp, validations.value.map((issue) => issue.id), layoutInput.value)),
    ]
    if (!due.length) return
    try {
      const { ledger: next } = await commitInvalidations(ledger.value.docVersion, station.value, due, snap)
      ledger.value = next
      // 本地拖动产生的系统作废属于本工位版本演进，会话基线随之前进；
      // 另一工位的模拟保存不更新会话基线，下次保存才会撞版本冲突。
      sessionDocVersion.value = next.docVersion
    } catch (error) {
      revalidationError.value = error instanceof Error ? error.message : '重新校验写回失败'
    }
  }

  watch([positions, pages, binding, grain], scheduleRevalidate, { deep: true })

  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value) return
    const position = positions.value.find((item) => item.id === id)
    if (position) Object.assign(position, patch)
  }

  function addPosition(pageNo: number) {
    if (locked.value || positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({ id: `P-${Date.now().toString().slice(-3)}`, pageNo, x: 34, y: 44, rotation: 0, front: side.value === 'front' })
  }

  function updatePage(pageNo: number, patch: Partial<Page>) {
    if (locked.value) return
    const page = pages.value.find((item) => item.pageNo === pageNo)
    if (page) Object.assign(page, patch)
  }

  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (proof) Object.assign(proof, patch)
  }

  function createProof() {
    proofs.value.push({ id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`, round: proofs.value.length + 1, date: new Date().toISOString().slice(0, 10), sample: `数字样张 v${proofs.value.length + 1}`, deltaE: 0, feedback: '', correction: '', owner: '当前用户', decision: '待决定' })
  }

  // ── 放行豁免：指纹 + 当次版位摘要，乐观并发 + 原记录号重试 ───────
  function beginRecord(): string {
    return nextRecordNo()
  }

  async function saveExemption(issueId: string, reason: string, recordNo: string): Promise<CommitResult> {
    const bindingInfo = bindIssue(issueId, layoutInput.value)
    if (!bindingInfo) throw new Error('该预检条目已不存在，请重新校验。')
    const result = await commitBatch(
      sessionDocVersion.value,
      station.value,
      {
        kind: 'grant',
        recordNo,
        fingerprint: bindingInfo.fingerprint,
        scope: bindingInfo.scope,
        scopeRef: bindingInfo.scopeRef,
        scopeLabel: bindingInfo.scopeLabel,
        scopeSnapshot: bindingInfo.scopeSnapshot,
        layoutDigest: layoutDigest.value,
        reason,
        revision: revision.value,
      },
      layoutCtx.value,
    )
    ledger.value = result.ledger
    sessionDocVersion.value = result.ledger.docVersion
    return result
  }

  async function reviewLegacy(exemptionId: string, approve: boolean, reason: string, recordNo: string, issueId?: string): Promise<CommitResult> {
    const exemption = ledger.value.exemptions.find((item) => item.id === exemptionId)
    if (!exemption) throw new Error('豁免记录不存在。')
    if (approve) {
      const targetIssue = issueId ?? matchingIssueForLegacy(exemption)
      if (!targetIssue) throw new Error('当前预检中没有对应问题，无法补绑指纹；请驳回该历史豁免。')
      const bindingInfo = bindIssue(targetIssue, layoutInput.value)
      if (!bindingInfo) throw new Error('预检条目无法生成指纹。')
      const result = await commitBatch(
        sessionDocVersion.value,
        station.value,
        { kind: 'confirm_legacy', recordNo, exemptionId, fingerprint: bindingInfo.fingerprint, scope: bindingInfo.scope, scopeRef: bindingInfo.scopeRef, scopeLabel: bindingInfo.scopeLabel, scopeSnapshot: bindingInfo.scopeSnapshot, layoutDigest: layoutDigest.value, revision: revision.value },
        layoutCtx.value,
      )
      ledger.value = result.ledger
      sessionDocVersion.value = result.ledger.docVersion
      return result
    }
    const result = await commitBatch(sessionDocVersion.value, station.value, { kind: 'reject_legacy', recordNo, exemptionId, reason, revision: revision.value }, layoutCtx.value)
    ledger.value = result.ledger
    sessionDocVersion.value = result.ledger.docVersion
    return result
  }

  function matchingIssueForLegacy(exemption: Exemption): string | null {
    if (exemption.scopeRef === 'sheet') return validations.value.find((issue) => issue.id === 'binding-order')?.id ?? null
    const pageNo = Number(exemption.scopeRef.replace('P', ''))
    return validations.value.find((issue) => issue.pageNo === pageNo && issue.id.startsWith('bleed-'))?.id ?? null
  }

  // 冲突后以当前服务器版本为基线重新打开（填写内容由各弹窗自行保留）
  function rebaseSession() {
    const fresh = stampOpenVersion(ledger.value, layoutCtx.value)
    ledger.value = fresh
    sessionDocVersion.value = fresh.docVersion
    revalidationError.value = ''
  }

  async function lockBaseline(recordNo: string): Promise<CommitResult> {
    const basis = {
      revision: revision.value,
      layoutDigest: layoutDigest.value,
      docVersion: sessionDocVersion.value,
      activeExemptionIds: activeExemptions.value.map((item) => item.id),
      operator: station.value === '审批工位' ? '周默' : '林青',
      station: station.value,
      at: new Date().toISOString(),
    }
    const result = await commitBatch(sessionDocVersion.value, station.value, { kind: 'lock', recordNo, basis, revision: revision.value }, layoutCtx.value)
    ledger.value = result.ledger
    sessionDocVersion.value = result.ledger.docVersion
    locked.value = true
    return result
  }

  async function unlock(recordNo: string): Promise<CommitResult> {
    const result = await commitBatch(sessionDocVersion.value, station.value, { kind: 'unlock', recordNo, revision: revision.value }, layoutCtx.value)
    ledger.value = result.ledger
    sessionDocVersion.value = result.ledger.docVersion
    locked.value = false
    return result
  }

  // ── 演示 / 联调用：模拟另一工位并发保存、写入失败 ────────────────
  async function otherStationSaved(scenario: 'move' | 'bleed' | 'lock'): Promise<void> {
    const { simulateConcurrentSave } = await import('../services/reviewLedger')
    const next = await simulateConcurrentSave(ledger.value.docVersion, scenario === 'lock' ? '审批工位' : '拼版工位', revision.value, layoutCtx.value, scenario)
    ledger.value = next
    // 故意不更新 sessionDocVersion：本工位仍拿着打开时的旧版本
    if (scenario === 'lock') locked.value = true
  }

  function armFailure() {
    armWriteFailure()
  }

  function resumeTask(id: string) {
    const task = tasks.value.find((item) => item.id === id)
    if (task && task.resumable) {
      task.status = '生成中'
      task.progress = Math.max(task.progress, 10)
      task.updatedAt = '刚刚'
    }
  }

  return {
    // 数据
    pages,
    positions,
    proofs,
    tasks,
    side,
    zoom,
    revision,
    binding,
    grain,
    locked,
    selectedPosition,
    selectedProof,
    station,
    sheetDefaults,
    // 复核
    ledger,
    sessionDocVersion,
    validations,
    layoutDigest,
    activeExemptions,
    invalidExemptions,
    pendingReviewCount,
    exemptionByIssue,
    coveredIssueIds,
    blockingErrors,
    lockBasis,
    lockMismatch,
    revalidationError,
    // 版位编辑
    updatePosition,
    addPosition,
    updatePage,
    updateProof,
    createProof,
    // 复核记录操作
    beginRecord,
    saveExemption,
    reviewLegacy,
    matchingIssueForLegacy,
    rebaseSession,
    lockBaseline,
    unlock,
    otherStationSaved,
    armFailure,
    resumeTask,
  }
})

export type { ReviewConflictError }

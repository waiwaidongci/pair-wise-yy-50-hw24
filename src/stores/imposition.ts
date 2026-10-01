import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { waiverApi, seedWaivers, type ChangedObject } from '../api/waiverApi'

export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type Position = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type Proof = { id: string; round: number; date: string; sample: string; deltaE: number; feedback: string; correction: string; owner: string; decision: '待决定' | '通过' | '退回' }
export type ExportTask = { id: string; name: string; progress: number; status: '排队中' | '生成中' | '已完成' | '已中断'; updatedAt: string; resumable: boolean }

export type ReviewStatus = '有效' | '待复核' | '已失效'
export type AuditEntry = { id: string; at: string; action: string; detail: string }
export type Waiver = {
  id: string
  issueId: string
  fingerprint: string
  layoutSummary: string
  reason: string
  owner: string
  createdAt: string
  status: ReviewStatus
  audits: AuditEntry[]
}

export const sheetSpec = {
  width: 720,
  height: 1020,
  bleed: 3,
  safe: 5,
  gutter: 6,
  binding: '骑马订',
  grain: '纵向',
}

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

function hashString(input: string): string {
  let h = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    h ^= input.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 问题指纹：绑定预检条目身份 + 页面出血 + 版位几何 + 装订方向，任一变化指纹即变。 */
export function issueFingerprint(issue: Validation, pages: Page[], positions: Position[], binding: string): string {
  const pagePart = pages.map((page) => `${page.pageNo}:${page.width}x${page.height}:bleed${page.bleed}`).join('|')
  const positionPart = positions.map((position) => `${position.id}:${position.pageNo}:${position.x},${position.y}:rot${position.rotation}:${position.front ? '正' : '反'}`).join('|')
  return hashString(`${issue.id}::${pagePart}::${positionPart}::${binding}::纸${sheetSpec.bleed}`)
}

/** 当次版位摘要：记录豁免签发时的版本与整版状态哈希。 */
export function layoutSummaryOf(pages: Page[], positions: Position[], revision: string, binding: string): string {
  const state = pages.map((page) => `${page.pageNo}:bleed${page.bleed}`).join('|') + '#' +
    positions.map((position) => `${position.id}:${position.pageNo}:${position.x},${position.y},rot${position.rotation},${position.front ? 1 : 0}`).join('|')
  return `${revision} · ${pages.length}P · ${binding} · ${sheetSpec.width}×${sheetSpec.height} · ${hashString(state).slice(0, 6)}`
}

function nowStamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

/** 旧数据升级：没有指纹的豁免标成待复核，历史审计保留可查。 */
function migrateWaivers(raw: unknown): Waiver[] {
  if (!Array.isArray(raw)) return seedWaivers()
  return raw.map((item) => {
    const legacy = (item ?? {}) as Partial<Waiver>
    const audits: AuditEntry[] = Array.isArray(legacy.audits)
      ? legacy.audits.filter((audit): audit is AuditEntry => !!audit && typeof audit === 'object').map((audit) => ({ ...audit }))
      : []
    const waiver: Waiver = {
      id: String(legacy.id ?? `WVR-${Date.now()}`),
      issueId: String(legacy.issueId ?? ''),
      fingerprint: String(legacy.fingerprint ?? ''),
      layoutSummary: String(legacy.layoutSummary ?? ''),
      reason: String(legacy.reason ?? ''),
      owner: String(legacy.owner ?? ''),
      createdAt: String(legacy.createdAt ?? nowStamp().slice(0, 10)),
      status: (legacy.status as ReviewStatus) ?? '待复核',
      audits,
    }
    if (!waiver.fingerprint || !waiver.layoutSummary) {
      waiver.status = '待复核'
      if (!waiver.audits.some((audit) => audit.action.startsWith('旧数据升级'))) {
        waiver.audits.push({ id: `AUD-${waiver.id}-MIG`, at: nowStamp(), action: '旧数据升级：无问题指纹，标记待复核', detail: '历史记录仍可查看，待当前版本重新校验绑定。' })
      }
    }
    return waiver
  })
}

export const useImpositionStore = defineStore('imposition', () => {
  const saved = localStorage.getItem('print-imposition-v1')
  const restored = saved ? JSON.parse(saved) : null
  const savedWaivers = localStorage.getItem('print-imposition-waivers-v1')
  const pages = ref<Page[]>(restored?.pages ?? structuredClone(seedPages))
  const positions = ref<Position[]>(restored?.positions ?? structuredClone(seedPositions))
  const proofs = ref<Proof[]>(restored?.proofs ?? structuredClone(seedProofs))
  const tasks = ref<ExportTask[]>(restored?.tasks ?? structuredClone(seedTasks))
  const waivers = ref<Waiver[]>(migrateWaivers(savedWaivers ? JSON.parse(savedWaivers) : seedWaivers()))
  const binding = ref(restored?.binding ?? sheetSpec.binding)
  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const revision = ref(restored?.revision ?? 'R6')
  const locked = ref(restored?.locked ?? false)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref('PRF-02')

  const serverVersion = ref(0)
  const openedVersion = ref(0)
  const saveState = ref<'idle' | 'saving' | 'retrying' | 'conflict' | 'error'>('idle')
  const conflict = ref<{ serverVersion: number; changed: ChangedObject[] } | null>(null)

  const validations = computed<Validation[]>(() => {
    const issues: Validation[] = []
    const placedPages = positions.value.map((position) => position.pageNo)
    pages.value.forEach((page) => {
      if (!placedPages.includes(page.pageNo)) issues.push({ id: `missing-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 尚未拼版`, detail: `${page.name} 未出现在正反版位中。` })
      if (page.bleed < sheetSpec.bleed) issues.push({ id: `bleed-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 出血不足`, detail: `页面出血 ${page.bleed}mm，低于印刷要求 ${sheetSpec.bleed}mm。` })
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
    if (frontOrder[0] !== 1) issues.push({ id: 'binding-order', severity: '警告', pageNo: 1, title: '骑马订正版页序需要复核', detail: `当前首位为 P${frontOrder[0]}，装订方向规则期望封面位于首版位。` })
    return issues
  })

  /** 待复核豁免数量：总览、拼版预检、版本对比共用同一口径。 */
  const pendingReviewCount = computed(() => waivers.value.filter((waiver) => waiver.status === '待复核').length)
  const lockBlocked = computed(() => pendingReviewCount.value > 0)

  function addAudit(waiver: Waiver, action: string, detail: string) {
    waiver.audits.push({ id: `AUD-${waiver.id}-${waiver.audits.length + 1}-${Date.now().toString(36)}`, at: nowStamp(), action, detail })
  }

  /** 版位、页面出血或装订方向一变，豁免立即失效并重新校验。 */
  function evaluateWaivers() {
    for (const waiver of waivers.value) {
      if (waiver.status === '已失效') continue
      const issue = validations.value.find((item) => item.id === waiver.issueId)
      if (!issue) {
        waiver.status = '已失效'
        addAudit(waiver, '预检条目已消除，豁免自动失效', `当前版本不再存在 ${waiver.issueId} 条目。`)
        continue
      }
      if (waiver.status === '待复核') continue
      const fingerprint = issueFingerprint(issue, pages.value, positions.value, binding.value)
      if (fingerprint !== waiver.fingerprint) {
        waiver.status = '待复核'
        addAudit(waiver, '版位/出血/装订变更，问题指纹变化，待重新校验', `原指纹 ${waiver.fingerprint.slice(0, 8)} → 新指纹 ${fingerprint.slice(0, 8)}`)
      }
    }
  }

  watch([pages, positions, binding], () => evaluateWaivers(), { deep: true })
  watch([pages, positions, proofs, tasks, revision, locked, binding], () => {
    localStorage.setItem('print-imposition-v1', JSON.stringify({ pages: pages.value, positions: positions.value, proofs: proofs.value, tasks: tasks.value, revision: revision.value, locked: locked.value, binding: binding.value }))
  }, { deep: true })
  watch(waivers, () => localStorage.setItem('print-imposition-waivers-v1', JSON.stringify(waivers.value)), { deep: true })

  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value) return
    const position = positions.value.find((item) => item.id === id)
    if (position) Object.assign(position, patch)
  }

  function addPosition(pageNo: number) {
    if (locked.value || positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({ id: `P-${Date.now().toString().slice(-3)}`, pageNo, x: 34, y: 44, rotation: 0, front: side.value === 'front' })
  }

  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (proof) Object.assign(proof, patch)
  }

  function createProof() {
    proofs.value.push({ id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`, round: proofs.value.length + 1, date: new Date().toISOString().slice(0, 10), sample: `数字样张 v${proofs.value.length + 1}`, deltaE: 0, feedback: '', correction: '', owner: '当前用户', decision: '待决定' })
  }

  /** 每条豁免绑定问题指纹和当次版位摘要。 */
  function grantWaiver(issueId: string, reason: string, owner: string) {
    const issue = validations.value.find((item) => item.id === issueId)
    if (!issue) return
    const fingerprint = issueFingerprint(issue, pages.value, positions.value, binding.value)
    const summary = layoutSummaryOf(pages.value, positions.value, revision.value, binding.value)
    const existing = waivers.value.find((item) => item.issueId === issueId && item.status !== '已失效')
    if (existing) {
      existing.reason = reason
      existing.owner = owner
      existing.fingerprint = fingerprint
      existing.layoutSummary = summary
      existing.status = '有效'
      addAudit(existing, '更新豁免并绑定当前指纹', `绑定指纹 ${fingerprint.slice(0, 8)} · 版位摘要 ${summary}`)
      return
    }
    const id = `WVR-${String(waivers.value.length + 1).padStart(4, '0')}`
    waivers.value.push({
      id,
      issueId,
      fingerprint,
      layoutSummary: summary,
      reason,
      owner,
      createdAt: nowStamp().slice(0, 10),
      status: '有效',
      audits: [{ id: `AUD-${id}-1`, at: nowStamp(), action: '创建豁免', detail: `绑定指纹 ${fingerprint.slice(0, 8)} · 版位摘要 ${summary}` }],
    })
  }

  /** 待复核豁免重新校验：仍在则重绑当前指纹，已消除则失效。 */
  function reaffirmWaiver(id: string) {
    const waiver = waivers.value.find((item) => item.id === id)
    if (!waiver) return
    const issue = validations.value.find((item) => item.id === waiver.issueId)
    if (!issue) {
      waiver.status = '已失效'
      addAudit(waiver, '预检条目已消除，豁免失效', `当前版本不再存在 ${waiver.issueId} 条目。`)
      return
    }
    waiver.fingerprint = issueFingerprint(issue, pages.value, positions.value, binding.value)
    waiver.layoutSummary = layoutSummaryOf(pages.value, positions.value, revision.value, binding.value)
    waiver.status = '有效'
    addAudit(waiver, '重新校验通过', `绑定指纹 ${waiver.fingerprint.slice(0, 8)} · 版位摘要 ${waiver.layoutSummary}`)
  }

  function revokeWaiver(id: string) {
    const waiver = waivers.value.find((item) => item.id === id)
    if (!waiver || waiver.status === '已失效') return
    waiver.status = '已失效'
    addAudit(waiver, '手动撤销豁免', `撤销 ${waiver.issueId} 的放行豁免。`)
  }

  /** 打开页面时的版本基线；保存只接受该版本，后到方列出被改对象并保留草稿。 */
  async function fetchWaivers() {
    try {
      const result = await waiverApi.list()
      waivers.value = migrateWaivers(result.data.records)
      serverVersion.value = result.data.version
      openedVersion.value = result.data.version
    } catch {
      /* 离线时保留本地草稿 */
    }
  }

  async function reloadFromServer() {
    await fetchWaivers()
    conflict.value = null
  }

  /** 整批写入：豁免与审计同批原子提交；失败按原记录号（幂等键）重试。 */
  async function saveWaivers(force = false) {
    if (saveState.value === 'saving' || saveState.value === 'retrying') return false
    const forcedBase = force && conflict.value ? conflict.value.serverVersion : null
    conflict.value = null
    const baseVersion = forcedBase ?? openedVersion.value
    const idempotencyKey = `IDEM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    waivers.value.forEach((waiver) => addAudit(waiver, '提交复核记录', `基线 v${baseVersion} · 共 ${waivers.value.length} 条记录`))
    saveState.value = 'saving'
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const result = await waiverApi.save({ baseVersion, idempotencyKey, records: JSON.parse(JSON.stringify(waivers.value)) })
        waivers.value = migrateWaivers(result.data.records)
        serverVersion.value = result.data.version
        openedVersion.value = result.data.version
        saveState.value = 'idle'
        return true
      } catch (error) {
        const err = error as { response?: { status: number; data?: { retryable?: boolean; version?: number; changed?: ChangedObject[] } } }
        if (err.response?.status === 409 && err.response.data) {
          conflict.value = { serverVersion: err.response.data.version ?? baseVersion, changed: err.response.data.changed ?? [] }
          saveState.value = 'conflict'
          return false
        }
        if (err.response?.status === 500 && err.response.data?.retryable) {
          saveState.value = 'retrying'
          await new Promise((resolve) => setTimeout(resolve, 450 * attempt))
          continue
        }
        saveState.value = 'error'
        return false
      }
    }
    saveState.value = 'error'
    return false
  }

  function lockBaseline() {
    if (lockBlocked.value) return
    locked.value = true
    revision.value = `R${Number(revision.value.slice(1)) + 1}`
  }

  function unlock() {
    locked.value = false
  }

  function resumeTask(id: string) {
    const task = tasks.value.find((item) => item.id === id)
    if (task && task.resumable) {
      task.status = '生成中'
      task.progress = Math.max(task.progress, 10)
      task.updatedAt = '刚刚'
    }
  }

  evaluateWaivers()
  fetchWaivers()

  return {
    pages, positions, proofs, tasks, waivers, binding, side, zoom, revision, locked, selectedPosition, selectedProof,
    validations, pendingReviewCount, lockBlocked, saveState, conflict, serverVersion, openedVersion,
    updatePosition, addPosition, updateProof, createProof,
    grantWaiver, reaffirmWaiver, revokeWaiver, fetchWaivers, reloadFromServer, saveWaivers,
    lockBaseline, unlock, resumeTask,
  }
})

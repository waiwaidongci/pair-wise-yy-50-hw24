// 复核记录服务：把拼版版位、预检条目与放行豁免接成同一份记录。
// 每条豁免绑定问题指纹（fingerprint）与当次版位摘要（layoutDigest + scopeSnapshot）；
// 写入使用打开页面时的版本做乐观并发控制，按原记录号幂等重试；
// 豁免与审计同一事务落库，不存在“只有豁免没有审计”的半批结果。

import { computeLayoutDigest } from './issueFingerprint'

export type ExemptionStatus = 'active' | 'invalid' | 'pending_review'

export type IssueFingerprint = {
  code: string // 预检条目类别：missing / bleed / overlap / binding-order
  ruleVersion: number // 校验规则版本，规则调整时指纹随之改变
  args: string // 问题参数（页码、版位号等），保证同类问题逐条区分
}

export type ExemptionScope = 'position' | 'page' | 'sheet'

// 当次版位摘要：只记录与该问题相关的字段，便于列出“变了什么”
export type ScopeSnapshot = Record<string, string | number>

export type Exemption = {
  id: string
  fingerprint: IssueFingerprint | null // 旧数据没有指纹，为 null => 待复核
  scope: ExemptionScope | null
  scopeRef: string // 关联对象，如 P-02 / P7 / sheet
  scopeLabel: string // 可读的关联描述
  scopeSnapshot: ScopeSnapshot | null // 放行时该问题相关版位的摘要
  layoutDigest: string // 放行时的全张版位摘要
  reason: string
  operator: string
  station: string
  revision: string
  createdAt: string
  status: ExemptionStatus
  invalidReason?: string
  invalidAt?: string
}

export type AuditAction = 'grant' | 'invalidate' | 'confirm_legacy' | 'reject_legacy' | 'lock' | 'unlock' | 'save' | 'migration'

export type AuditEntry = {
  recordNo: string // 原记录号，重试时沿用
  action: AuditAction
  exemptionId?: string
  fingerprint?: IssueFingerprint | null
  detail: string
  operator: string
  station: string
  revision: string
  at: string
  batchId: string
}

export type LockBasis = {
  revision: string
  layoutDigest: string
  docVersion: number
  activeExemptionIds: string[]
  operator: string
  station: string
  at: string
} | null

// 每个文档版本留一份紧凑版位快照，供并发冲突时列出“被改对象”
export type VersionLog = {
  version: number
  station: string
  at: string
  layoutDigest: string
  note: string
  positions: Record<string, { pageNo: number; x: number; y: number; rotation: number; front: boolean }>
  bleeds: Record<string, number>
  binding: string
  grain: string
  locked: boolean
  granted: string[] // 该版本新增/确认的豁免说明
}

export type LedgerState = {
  docVersion: number // 记录的当前版本号
  exemptions: Exemption[]
  audits: AuditEntry[]
  lock: LockBasis
  migrated: boolean
  history: VersionLog[]
}

export type ReviewBatch =
  | {
      kind: 'grant'
      recordNo: string
      fingerprint: IssueFingerprint
      scope: ExemptionScope
      scopeRef: string
      scopeLabel: string
      scopeSnapshot: ScopeSnapshot
      layoutDigest: string
      reason: string
      revision: string
    }
  | {
      kind: 'confirm_legacy'
      recordNo: string
      exemptionId: string
      fingerprint: IssueFingerprint
      scope: ExemptionScope
      scopeRef: string
      scopeLabel: string
      scopeSnapshot: ScopeSnapshot
      layoutDigest: string
      revision: string
    }
  | { kind: 'reject_legacy'; recordNo: string; exemptionId: string; reason: string; revision: string }
  | { kind: 'lock'; recordNo: string; basis: Exclude<LockBasis, null>; revision: string }
  | { kind: 'unlock'; recordNo: string; revision: string }
  | { kind: 'checkpoint'; recordNo: string; revision: string; note: string }

export type CommitResult = { ledger: LedgerState; batch: ReviewBatch; retried: boolean }

export type ChangedObject = { scopeRef: string; scopeLabel: string; before: string; after: string }

export class ReviewConflictError extends Error {
  code = 'REVIEW_CONFLICT' as const
  expectedVersion: number
  actualVersion: number
  changedObjects: ChangedObject[]
  constructor(expectedVersion: number, actualVersion: number, changedObjects: ChangedObject[]) {
    super(`版本已变化（打开时 V${expectedVersion}，当前 V${actualVersion}），请核对后再保存。`)
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
    this.changedObjects = changedObjects
  }
}

const STORAGE_KEY = 'print-review-ledger-v1'
const LATENCY_MS = 140

// 下一次写入失败注入（仅运行时有效，不落库），用于演示“写入失败按原记录号重试”
let failNext = false

// 已按记录号处理过的批次：同一记录号重试时直接回放结果，绝不产生第二条豁免/审计
const processed = new Map<string, { result: CommitResult }>()

export function fingerprintText(fp: IssueFingerprint): string {
  return `${fp.code}@v${fp.ruleVersion}:${fp.args}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function nowText(): string {
  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export type LayoutContext = {
  layoutDigest: string
  positions: { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }[]
  pages: { pageNo: number; bleed: number }[]
  binding: string
  grain: string
}

function snapshotFromCtx(ctx: LayoutContext, locked: boolean, note: string, version: number, station: string, at: string, granted: string[]): VersionLog {
  return {
    version,
    station,
    at,
    layoutDigest: ctx.layoutDigest,
    note,
    positions: Object.fromEntries(ctx.positions.map((p) => [p.id, { pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front }])),
    bleeds: Object.fromEntries(ctx.pages.map((p) => [String(p.pageNo), p.bleed])),
    binding: ctx.binding,
    grain: ctx.grain,
    locked,
    granted,
  }
}

// ── 初始 / 旧数据升级 ──────────────────────────────────────────────

function seedLedger(): LedgerState {
  const seedPositions = [
    { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
    { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
    { id: 'P-03', pageNo: 6, x: 34, y: 548, rotation: 180, front: true },
    { id: 'P-04', pageNo: 3, x: 372, y: 548, rotation: 0, front: true },
    { id: 'P-05', pageNo: 2, x: 34, y: 44, rotation: 0, front: false },
    { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
    { id: 'P-07', pageNo: 4, x: 34, y: 548, rotation: 0, front: false },
    { id: 'P-08', pageNo: 5, x: 372, y: 548, rotation: 180, front: false },
  ]
  const seedPages = [
    { pageNo: 1, name: '封面', bleed: 3 },
    { pageNo: 2, name: '版权页', bleed: 2 },
    { pageNo: 3, name: '序言', bleed: 3 },
    { pageNo: 4, name: '剧照跨页左', bleed: 3 },
    { pageNo: 5, name: '剧照跨页右', bleed: 3 },
    { pageNo: 6, name: '曲目表', bleed: 3 },
    { pageNo: 7, name: '创作团队', bleed: 1 },
    { pageNo: 8, name: '封底', bleed: 3 },
  ]
  const seedDigest = computeLayoutDigest({ positions: seedPositions, pages: seedPages, binding: '骑马订', grain: '纵向', sheetBleed: 3 })

  // 历史豁免（R4 时期放行）：没有指纹，升级后标为待复核，历史仍可查看
  const legacyBleed: Exemption = {
    id: 'EXM-1001',
    fingerprint: null,
    scope: null,
    scopeRef: 'P7',
    scopeLabel: 'P7 创作团队 · 出血不足',
    scopeSnapshot: null,
    layoutDigest: 'legacy-r4',
    reason: 'R4 打样口头确认：暗部出血 1mm 可接受，后续换文件。',
    operator: '林青',
    station: '拼版工位',
    revision: 'R4',
    createdAt: '09-20 11:06',
    status: 'pending_review',
  }
  const legacyBinding: Exemption = {
    id: 'EXM-1002',
    fingerprint: null,
    scope: null,
    scopeRef: 'sheet',
    scopeLabel: '全张 · 骑马订页序复核',
    scopeSnapshot: null,
    layoutDigest: 'legacy-r4',
    reason: 'R4 班前会口头放过装订方向提示，未登记依据。',
    operator: '周默',
    station: '审批工位',
    revision: 'R4',
    createdAt: '09-20 11:12',
    status: 'pending_review',
  }
  const audits: AuditEntry[] = [
    {
      recordNo: 'REC-M0001',
      action: 'migration',
      detail: '旧数据升级：2 条历史豁免缺少问题指纹与版位摘要，已标为待复核；历史记录保留可查。',
      operator: '系统',
      station: '升级程序',
      revision: 'R4',
      at: '09-26 09:00',
      batchId: 'MIGRATION-0001',
    },
  ]
  return {
    docVersion: 1,
    exemptions: [legacyBleed, legacyBinding],
    audits,
    lock: null,
    migrated: false,
    history: [
      {
        version: 1,
        station: '拼版工位',
        at: '09-26 09:00',
        layoutDigest: seedDigest,
        note: '打开页面时的版本',
        positions: {
          'P-01': { pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
          'P-02': { pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
          'P-03': { pageNo: 6, x: 34, y: 548, rotation: 180, front: true },
          'P-04': { pageNo: 3, x: 372, y: 548, rotation: 0, front: true },
          'P-05': { pageNo: 2, x: 34, y: 44, rotation: 0, front: false },
          'P-06': { pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
          'P-07': { pageNo: 4, x: 34, y: 548, rotation: 0, front: false },
          'P-08': { pageNo: 5, x: 372, y: 548, rotation: 180, front: false },
        },
        bleeds: { 1: 3, 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 7: 1, 8: 3 },
        binding: '骑马订',
        grain: '纵向',
        locked: false,
        granted: [],
      },
    ],
  }
}

export function loadLedger(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seedLedger()
    const parsed = JSON.parse(raw) as LedgerState
    if (!parsed.exemptions || !parsed.audits) return seedLedger()
    parsed.history ??= []
    return migrate(parsed)
  } catch {
    return seedLedger()
  }
}

// 旧数据升级：任何缺指纹的豁免一律标成待复核（幂等），并补一条升级审计
function migrate(state: LedgerState): LedgerState {
  if (state.migrated) return state
  const legacy = state.exemptions.filter((item) => !item.fingerprint && item.status !== 'pending_review')
  if (legacy.length) {
    legacy.forEach((item) => {
      item.status = 'pending_review'
      item.invalidReason = '旧数据缺少问题指纹，待人工复核'
    })
    state.audits.unshift({
      recordNo: `REC-M${String(Date.now()).slice(-4)}`,
      action: 'migration',
      detail: `旧数据升级：${legacy.length} 条历史豁免缺少问题指纹与版位摘要，已标为待复核；历史记录保留可查。`,
      operator: '系统',
      station: '升级程序',
      revision: state.lock?.revision ?? '历史版本',
      at: nowText(),
      batchId: `MIGRATION-${Date.now()}`,
    })
  }
  state.migrated = true
  return state
}

function persist(state: LedgerState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function armWriteFailure() {
  failNext = true
}

export function resetIdempotency() {
  processed.clear()
}

// 打开页面时为当前版本补一张版位快照（仅在缺失时），冲突比对才有“打开时”的基线
export function stampOpenVersion(state: LedgerState, ctx: LayoutContext): LedgerState {
  if (state.history.some((log) => log.version === state.docVersion)) return state
  const next = clone(state)
  next.history.push(snapshotFromCtx(ctx, next.lock !== null, '打开页面时的版本', next.docVersion, '当前工位', nowText(), []))
  persist(next)
  return next
}

// ── 并发冲突：列出被改对象 ─────────────────────────────────────────

function describePos(p: { pageNo: number; x: number; y: number; rotation: number; front: boolean }): string {
  return `P${p.pageNo} x${p.x}/y${p.y}/r${p.rotation}/${p.front ? '正' : '反'}`
}

export function diffChangedObjects(baseVersion: number, current: LedgerState): ChangedObject[] {
  const base = current.history.find((log) => log.version === baseVersion)
  const head = current.history.find((log) => log.version === current.docVersion)
  const objects: ChangedObject[] = []

  if (base && head) {
    const ids = new Set([...Object.keys(base.positions), ...Object.keys(head.positions)])
    ids.forEach((id) => {
      const before = base.positions[id]
      const after = head.positions[id]
      if (!before && after) objects.push({ scopeRef: id, scopeLabel: `版位 ${id}`, before: '不存在', after: describePos(after) })
      else if (before && !after) objects.push({ scopeRef: id, scopeLabel: `版位 ${id}`, before: describePos(before), after: '已删除' })
      else if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
        objects.push({ scopeRef: id, scopeLabel: `版位 ${id}（P${after.pageNo}）`, before: describePos(before), after: describePos(after) })
      }
    })
    const pageNos = new Set([...Object.keys(base.bleeds), ...Object.keys(head.bleeds)])
    pageNos.forEach((pageNo) => {
      if (base.bleeds[pageNo] !== head.bleeds[pageNo]) {
        objects.push({ scopeRef: `P${pageNo}`, scopeLabel: `P${pageNo} 页面出血`, before: `${base.bleeds[pageNo] ?? '—'}mm`, after: `${head.bleeds[pageNo] ?? '—'}mm` })
      }
    })
    if (base.binding !== head.binding || base.grain !== head.grain) {
      objects.push({ scopeRef: 'sheet', scopeLabel: '装订方向 / 纸纹', before: `${base.binding} · ${base.grain}`, after: `${head.binding} · ${head.grain}` })
    }
    if (base.locked !== head.locked) {
      objects.push({
        scopeRef: 'sheet',
        scopeLabel: '审批锁定',
        before: base.locked ? '已锁定' : '未锁定',
        after: head.locked ? `已锁定（依据 ${head.layoutDigest.slice(0, 8)}）` : '已解锁修订',
      })
    }
    current.history
      .filter((log) => log.version > baseVersion && log.version <= current.docVersion)
      .forEach((log) => log.granted.forEach((text) => objects.push({ scopeRef: 'approval', scopeLabel: text, before: `V${baseVersion} 无此放行`, after: `V${log.version} 已登记（${log.station}）` })))
  }

  if (!objects.length) {
    objects.push({
      scopeRef: 'sheet',
      scopeLabel: '复核记录',
      before: `打开时 V${baseVersion}`,
      after: `当前 V${current.docVersion}（${head?.station ?? '另一工位'} 已保存）`,
    })
  }
  return objects.slice(0, 5)
}

// ── 原子提交 ──────────────────────────────────────────────────────

let recordSeq = 200

export function nextRecordNo(): string {
  recordSeq += 1
  return `REC-${String(recordSeq).padStart(4, '0')}`
}

function delay() {
  return new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
}

function stationOperator(station: string): string {
  return station === '审批工位' ? '周默' : '林青'
}

export async function commitBatch(
  baseVersion: number,
  station: string,
  batch: ReviewBatch,
  layoutCtx: LayoutContext,
  stateOverride?: LedgerState,
): Promise<CommitResult> {
  // 幂等：同一记录号重试，直接回放首次结果（豁免与审计都不会重复）
  const seen = processed.get(batch.recordNo)
  if (seen) {
    persist(seen.result.ledger)
    return { ...seen.result, retried: true }
  }

  await delay()
  if (failNext) {
    failNext = false
    throw new Error('网络写入失败：记录未提交，可按原记录号重试。')
  }

  // 读取“服务器端”最新状态；保存只接受打开页面时的版本
  const current = stateOverride ?? loadLedger()
  if (current.docVersion !== baseVersion) {
    throw new ReviewConflictError(baseVersion, current.docVersion, diffChangedObjects(baseVersion, current))
  }

  // 同事务生成豁免与审计并推进版本：任一步失败整体不写入，杜绝半批结果
  const next = clone(current)
  next.docVersion = baseVersion + 1
  const operator = stationOperator(station)
  const at = nowText()
  const batchId = batch.recordNo
  const granted: string[] = []
  let note = ''
  let lockedAfter = next.lock !== null

  if (batch.kind === 'grant') {
    const id = `EXM-${1000 + next.exemptions.length + 1}`
    next.exemptions.push({
      id,
      fingerprint: clone(batch.fingerprint),
      scope: batch.scope,
      scopeRef: batch.scopeRef,
      scopeLabel: batch.scopeLabel,
      scopeSnapshot: clone(batch.scopeSnapshot),
      layoutDigest: batch.layoutDigest,
      reason: batch.reason,
      operator,
      station,
      revision: batch.revision,
      createdAt: at,
      status: 'active',
    })
    next.audits.push({
      recordNo: batch.recordNo,
      action: 'grant',
      exemptionId: id,
      fingerprint: clone(batch.fingerprint),
      detail: `放行 ${batch.scopeLabel}；绑定指纹 ${fingerprintText(batch.fingerprint)} 与当次版位摘要 ${batch.layoutDigest.slice(0, 8)}；理由：${batch.reason || '未填写'}`,
      operator,
      station,
      revision: batch.revision,
      at,
      batchId,
    })
    granted.push(`放行豁免 ${id}：${batch.scopeLabel}`)
    note = `放行 ${batch.scopeLabel}`
  } else if (batch.kind === 'confirm_legacy') {
    const exemption = next.exemptions.find((item) => item.id === batch.exemptionId)
    if (exemption) {
      exemption.fingerprint = clone(batch.fingerprint)
      exemption.scope = batch.scope
      exemption.scopeRef = batch.scopeRef
      exemption.scopeLabel = batch.scopeLabel
      exemption.scopeSnapshot = clone(batch.scopeSnapshot)
      exemption.layoutDigest = batch.layoutDigest
      exemption.status = 'active'
      delete exemption.invalidReason
      next.audits.push({
        recordNo: batch.recordNo,
        action: 'confirm_legacy',
        exemptionId: exemption.id,
        fingerprint: clone(batch.fingerprint),
        detail: `复核确认历史豁免 ${exemption.id}（${exemption.scopeLabel}），补绑当前指纹 ${fingerprintText(batch.fingerprint)} 与版位摘要 ${batch.layoutDigest.slice(0, 8)}。`,
        operator,
        station,
        revision: batch.revision,
        at,
        batchId,
      })
      granted.push(`复核确认 ${exemption.id}：${batch.scopeLabel}`)
      note = `复核确认 ${exemption.id}`
    }
  } else if (batch.kind === 'reject_legacy') {
    const exemption = next.exemptions.find((item) => item.id === batch.exemptionId)
    if (exemption) {
      exemption.status = 'invalid'
      exemption.invalidReason = `复核驳回：${batch.reason || '依据不足'}`
      exemption.invalidAt = at
      next.audits.push({
        recordNo: batch.recordNo,
        action: 'reject_legacy',
        exemptionId: exemption.id,
        fingerprint: null,
        detail: `复核驳回历史豁免 ${exemption.id}（${exemption.scopeLabel}）：${batch.reason || '依据不足'}，原放行不再有效。历史记录保留。`,
        operator,
        station,
        revision: batch.revision,
        at,
        batchId,
      })
      note = `复核驳回 ${exemption.id}`
    }
  } else if (batch.kind === 'lock') {
    next.lock = clone(batch.basis)
    lockedAfter = true
    next.audits.push({
      recordNo: batch.recordNo,
      action: 'lock',
      detail: `审批锁定 ${batch.basis.revision}：依据版位摘要 ${batch.basis.layoutDigest.slice(0, 8)}（V${batch.basis.docVersion}），含 ${batch.basis.activeExemptionIds.length} 条有效豁免。`,
      operator: batch.basis.operator,
      station: batch.basis.station,
      revision: batch.revision,
      at,
      batchId,
    })
    note = '审批锁定'
  } else if (batch.kind === 'unlock') {
    next.lock = null
    lockedAfter = false
    next.audits.push({
      recordNo: batch.recordNo,
      action: 'unlock',
      detail: `解除审批锁定，开放 ${batch.revision} 修订。`,
      operator,
      station,
      revision: batch.revision,
      at,
      batchId,
    })
    note = '解锁修订'
  } else if (batch.kind === 'checkpoint') {
    next.audits.push({
      recordNo: batch.recordNo,
      action: 'save',
      detail: `${station} 保存复核记录：${batch.note}。`,
      operator,
      station,
      revision: batch.revision,
      at,
      batchId,
    })
    note = batch.note
  }

  next.history.push(snapshotFromCtx(layoutCtx, lockedAfter, note, next.docVersion, station, at, granted))
  persist(next)
  const result: CommitResult = { ledger: next, batch, retried: false }
  processed.set(batch.recordNo, { result })
  return result
}

// ── 并发演示：模拟另一工位在服务器端先保存了一个版本 ───────────────

export async function simulateConcurrentSave(
  baseVersion: number,
  otherStation: string,
  revision: string,
  ctx: LayoutContext,
  scenario: 'move' | 'bleed' | 'lock',
): Promise<LedgerState> {
  await delay()
  const current = loadLedger()
  if (current.docVersion !== baseVersion) return current
  const next = clone(current)
  next.docVersion = baseVersion + 1
  const at = nowText()
  const recordNo = `REC-X${String(Date.now()).slice(-4)}`

  // 用当前版位快照推导出“另一工位保存后”的快照，冲突列表就能列出被改对象
  const positions = ctx.positions.map((p) => ({ ...p }))
  const bleeds = Object.fromEntries(ctx.pages.map((p) => [String(p.pageNo), p.bleed]))
  let note = ''
  const granted: string[] = []

  if (scenario === 'move') {
    const target = positions.find((p) => p.id === 'P-02') ?? positions[0]
    target.x = Math.min(470, target.x + 36)
    note = `拖动 ${target.id} 版位`
  } else if (scenario === 'bleed') {
    bleeds['7'] = 3
    note = 'P7 更换 3mm 出血文件'
  } else {
    note = '审批锁定'
    next.lock = {
      revision,
      layoutDigest: ctx.layoutDigest,
      docVersion: next.docVersion,
      activeExemptionIds: next.exemptions.filter((e) => e.status === 'active').map((e) => e.id),
      operator: stationOperatorOf(otherStation),
      station: otherStation,
      at,
    }
    granted.push('另一工位已锁定当前版本')
  }

  next.audits.push({
    recordNo,
    action: scenario === 'lock' ? 'lock' : 'save',
    detail: `${otherStation} 已保存：${note}。本工位打开时的版本落后一个版本。`,
    operator: stationOperatorOf(otherStation),
    station: otherStation,
    revision,
    at,
    batchId: recordNo,
  })

  const raw = JSON.stringify({ positions, bleeds, binding: ctx.binding, grain: ctx.grain })
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) hash = (hash * 31 + raw.charCodeAt(i)) | 0
  const digest = scenario === 'lock' ? ctx.layoutDigest : `X${(hash >>> 0).toString(16).padStart(7, '0')}`

  next.history.push({
    version: next.docVersion,
    station: otherStation,
    at,
    layoutDigest: digest,
    note,
    positions: Object.fromEntries(positions.map((p) => [p.id, { pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front }])),
    bleeds,
    binding: ctx.binding,
    grain: ctx.grain,
    locked: scenario === 'lock',
    granted,
  })
  persist(next)
  return next
}

function stationOperatorOf(station: string): string {
  return station === '审批工位' ? '周默' : '林青'
}

// ── 版位变化 → 豁免立即失效 ───────────────────────────────────────

export type LayoutSnapshotInput = LayoutContext & { revision: string }

export type Invalidation = { exemptionId: string; scopeRef: string; scopeLabel: string; reason: string }

// 检查 active 豁免：版位/页面出血/装订方向一变即失效
export function detectInvalidations(state: LedgerState, ctx: LayoutSnapshotInput): Invalidation[] {
  const result: Invalidation[] = []
  state.exemptions.forEach((exemption) => {
    if (exemption.status !== 'active' || !exemption.fingerprint || !exemption.scopeSnapshot) return

    // 全张摘要变化（拖动任意版位都会改变），sheet 级豁免直接失效
    if (exemption.scope === 'sheet' && exemption.layoutDigest !== ctx.layoutDigest) {
      result.push({ exemptionId: exemption.id, scopeRef: exemption.scopeRef, scopeLabel: exemption.scopeLabel, reason: '装订方向或全张版位已变化' })
      return
    }

    if (exemption.scope === 'position') {
      const pos = ctx.positions.find((item) => item.id === exemption.scopeRef)
      if (!pos) {
        result.push({ exemptionId: exemption.id, scopeRef: exemption.scopeRef, scopeLabel: exemption.scopeLabel, reason: `版位 ${exemption.scopeRef} 已删除` })
        return
      }
      const snapshot = exemption.scopeSnapshot
      const fields: [keyof typeof pos, string][] = [
        ['pageNo', '绑定页面'],
        ['x', 'X 坐标'],
        ['y', 'Y 坐标'],
        ['rotation', '旋转方向'],
        ['front', '正反面'],
      ]
      const changedField = fields.find(([key]) => String(snapshot[key]) !== String(pos[key]))
      if (changedField) {
        result.push({ exemptionId: exemption.id, scopeRef: exemption.scopeRef, scopeLabel: exemption.scopeLabel, reason: `版位 ${pos.id} 的${changedField[1]}已变化` })
        return
      }
      if (exemption.fingerprint.code === 'overlap' && exemption.layoutDigest !== ctx.layoutDigest) {
        result.push({ exemptionId: exemption.id, scopeRef: exemption.scopeRef, scopeLabel: exemption.scopeLabel, reason: '版位间距已变化，重叠判定需重新校验' })
      }
    }

    if (exemption.scope === 'page') {
      const pageNo = Number(exemption.scopeRef.replace('P', ''))
      const page = ctx.pages.find((item) => item.pageNo === pageNo)
      if (!page) return
      if (exemption.fingerprint.code === 'bleed' && Number(exemption.scopeSnapshot.bleed) !== page.bleed) {
        result.push({ exemptionId: exemption.id, scopeRef: exemption.scopeRef, scopeLabel: exemption.scopeLabel, reason: `P${pageNo} 出血由 ${exemption.scopeSnapshot.bleed}mm 变为 ${page.bleed}mm` })
        return
      }
      const geomSignature = ctx.positions
        .filter((p) => p.pageNo === pageNo)
        .map((p) => `${p.id}:${p.x},${p.y},${p.rotation},${p.front ? 1 : 0}`)
        .join('|')
      if (exemption.scopeSnapshot.positionSig !== undefined && exemption.scopeSnapshot.positionSig !== geomSignature) {
        result.push({ exemptionId: exemption.id, scopeRef: exemption.scopeRef, scopeLabel: exemption.scopeLabel, reason: `P${pageNo} 所属版位已拖动或旋转` })
      }
    }
  })
  return result
}

// 指纹在当前预检中已找不到对应条目（问题被修复）：放行依据关闭
export function detectResolved(state: LedgerState, ctx: LayoutSnapshotInput, matches: (fp: NonNullable<Exemption['fingerprint']>) => boolean): Invalidation[] {
  return state.exemptions
    .filter((e) => e.status === 'active' && e.fingerprint && !matches(e.fingerprint))
    .map((e) => ({ exemptionId: e.id, scopeRef: e.scopeRef, scopeLabel: e.scopeLabel, reason: '原预检问题已修复，放行依据关闭' }))
}

// 系统作废批次：豁免状态与审计同批写回，不会留下无审计的豁免
export async function commitInvalidations(
  baseVersion: number,
  station: string,
  invalidations: Invalidation[],
  ctx: LayoutSnapshotInput,
): Promise<{ ledger: LedgerState; docVersion: number }> {
  const unique = invalidations.filter((item, index, arr) => arr.findIndex((other) => other.exemptionId === item.exemptionId) === index)
  if (!unique.length) return { ledger: loadLedger(), docVersion: loadLedger().docVersion }

  await delay()
  if (failNext) {
    failNext = false
    throw new Error('系统作废写回失败：请手动重新校验。')
  }
  const current = loadLedger()
  if (current.docVersion !== baseVersion) {
    // 服务器版本更新时以服务器为准再检测一次，避免覆盖另一工位的写入
    const recheck = detectInvalidations(current, ctx)
    if (!recheck.length) return { ledger: current, docVersion: current.docVersion }
    return commitInvalidations(current.docVersion, station, recheck, ctx)
  }
  const next = clone(current)
  next.docVersion = baseVersion + 1
  const at = nowText()
  const batchId = `SYS-INV-${Date.now()}`
  unique.forEach((item, index) => {
    const exemption = next.exemptions.find((e) => e.id === item.exemptionId)
    if (!exemption || exemption.status !== 'active') return
    exemption.status = 'invalid'
    exemption.invalidReason = item.reason
    exemption.invalidAt = at
    const recordNo = `REC-S${String(Date.now()).slice(-4)}-${index}`
    next.audits.push({
      recordNo,
      action: 'invalidate',
      exemptionId: exemption.id,
      fingerprint: clone(exemption.fingerprint),
      detail: `豁免 ${exemption.id}（${item.scopeLabel}）自动失效：${item.reason}；放行时摘要 ${exemption.layoutDigest.slice(0, 8)}，当前 ${ctx.layoutDigest.slice(0, 8)}。需重新校验后再放行。`,
      operator: '系统',
      station,
      revision: ctx.revision,
      at,
      batchId,
    })
  })
  next.history.push(
    snapshotFromCtx(
      { layoutDigest: ctx.layoutDigest, positions: ctx.positions, pages: ctx.pages.map((p) => ({ pageNo: p.pageNo, bleed: p.bleed })), binding: ctx.binding, grain: ctx.grain },
      next.lock !== null,
      `版位变化致 ${unique.length} 条豁免失效`,
      next.docVersion,
      '系统',
      at,
      [],
    ),
  )
  persist(next)
  return { ledger: next, docVersion: next.docVersion }
}

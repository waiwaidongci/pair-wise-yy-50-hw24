import axios, { type AxiosAdapter } from 'axios'
import type { Waiver } from '../stores/imposition'

export type ChangedObject = { id: string; kind: 'waiver'; field: string; before: unknown; after: unknown }
export type ConflictBody = { version: number; changed: ChangedObject[]; records: Waiver[] }
export type SaveResult = { version: number; records: Waiver[] }

/** 旧数据升级前的口头豁免：没有指纹与版位摘要，等待重新校验绑定。 */
export function seedWaivers(): Waiver[] {
  return [
    {
      id: 'WVR-0001',
      issueId: 'bleed-7',
      fingerprint: '',
      layoutSummary: '',
      reason: 'P7 低出血文件已在班前会口头放行，先拼版后补文件。',
      owner: '周默 / 色彩管理',
      createdAt: '2026-09-20',
      status: '待复核',
      audits: [
        { id: 'AUD-0001-1', at: '2026-09-20 09:12', action: '创建豁免', detail: '口头放行，未绑定问题指纹与版位摘要。' },
        { id: 'AUD-0001-2', at: '2026-10-01 08:30', action: '旧数据升级：无问题指纹，标记待复核', detail: '历史记录仍可查看，待当前版本重新校验绑定。' },
      ],
    },
    {
      id: 'WVR-0002',
      issueId: 'binding-order',
      fingerprint: '',
      layoutSummary: '',
      reason: '骑马订正版页序已口头确认，封面暂居首版位。',
      owner: '林青 / 拼版',
      createdAt: '2026-09-22',
      status: '待复核',
      audits: [
        { id: 'AUD-0002-1', at: '2026-09-22 14:05', action: '创建豁免', detail: '口头确认，未绑定问题指纹与版位摘要。' },
        { id: 'AUD-0002-2', at: '2026-10-01 08:30', action: '旧数据升级：无问题指纹，标记待复核', detail: '历史记录仍可查看，待当前版本重新校验绑定。' },
      ],
    },
  ]
}

type SaveRequestBody = { baseVersion: number; idempotencyKey: string; records: Waiver[] }

const state: { version: number; records: Waiver[] } = { version: 1, records: seedWaivers() }
/** 按幂等键记录写入次数：首次写入模拟瞬时失败，重试必须携带同一记录号。 */
const attempts = new Map<string, number>()

function diffRecords(server: Waiver[], incoming: Waiver[]): ChangedObject[] {
  const changed: ChangedObject[] = []
  const serverMap = new Map(server.map((item) => [item.id, item]))
  const incomingMap = new Map(incoming.map((item) => [item.id, item]))
  for (const inc of incoming) {
    const srv = serverMap.get(inc.id)
    if (!srv) {
      changed.push({ id: inc.id, kind: 'waiver', field: '记录', before: null, after: '其他工位新增' })
      continue
    }
    const fields: Array<keyof Waiver> = ['status', 'fingerprint', 'layoutSummary', 'reason', 'owner', 'issueId']
    for (const field of fields) {
      if (JSON.stringify(srv[field]) !== JSON.stringify(inc[field])) {
        changed.push({ id: inc.id, kind: 'waiver', field, before: srv[field], after: inc[field] })
      }
    }
  }
  for (const srv of server) {
    if (!incomingMap.has(srv.id)) changed.push({ id: srv.id, kind: 'waiver', field: '记录', before: null, after: '其他工位新增' })
  }
  return changed
}

const adapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 180))

  function fail(status: number, data: unknown, statusText: string): Promise<never> {
    const response = { data, status, statusText, headers: {}, config }
    return Promise.reject(new axios.AxiosError(`Request failed with status code ${status}`, status >= 500 ? AxiosErrorCodes.ERR_BAD_RESPONSE : AxiosErrorCodes.ERR_BAD_REQUEST, config, config, response))
  }

  if (config.url === '/api/print/waivers' && config.method === 'get') {
    return { data: { version: state.version, records: structuredClone(state.records) }, status: 200, statusText: 'OK', headers: {}, config }
  }

  if (config.url === '/api/print/waivers' && config.method === 'post') {
    const body = JSON.parse(config.data) as SaveRequestBody
    // 整批原子校验：豁免与审计必须同批写入，不允许只有豁免没有审计的半批结果。
    const batchValid = body.records.every((record) => record.id.startsWith('WVR-') && record.audits.length > 0)
    if (!batchValid) {
      return fail(400, { error: '批次不完整：豁免记录必须随审计一起写入' }, 'Bad Request')
    }
    if (body.baseVersion !== state.version) {
      const conflict: ConflictBody = { version: state.version, changed: diffRecords(state.records, body.records), records: structuredClone(state.records) }
      return fail(409, conflict, 'Conflict')
    }
    const attempt = (attempts.get(body.idempotencyKey) ?? 0) + 1
    attempts.set(body.idempotencyKey, attempt)
    if (attempt === 1) {
      return fail(500, { error: '写入失败，可按原记录号重试', retryable: true }, 'Internal Error')
    }
    // 原子应用整批：要么全部生效，要么全部不生效。
    state.records = structuredClone(body.records)
    state.version += 1
    const result: SaveResult = { version: state.version, records: structuredClone(state.records) }
    return { data: result, status: 200, statusText: 'OK', headers: {}, config }
  }

  return fail(404, null, 'Not Found')
}

const AxiosErrorCodes = { ERR_BAD_REQUEST: 'ERR_BAD_REQUEST', ERR_BAD_RESPONSE: 'ERR_BAD_RESPONSE' }

const client = axios.create({ adapter })

export const waiverApi = {
  list: () => client.get<{ version: number; records: Waiver[] }>('/api/print/waivers'),
  save: (body: SaveRequestBody) => client.post<SaveResult>('/api/print/waivers', body),
}

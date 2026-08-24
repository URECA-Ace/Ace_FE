import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  createCoupon,
  createCouponEvent,
  getCoupons,
  getIssueStatus,
  getIssuanceStats,
  initializeCampaign,
  issueCoupon,
} from './api/couponApi'
import CampaignMonitor from './components/CampaignMonitor'
import ScheduledOpenTimeline from './components/ScheduledOpenTimeline'
import './App.css'

const STORAGE_KEY = 'ace-manager-issue-records'
const PENDING_STATUSES = new Set(['ACCEPTED', 'PROCESSING'])
const PARTICIPANT_COUNT = 20000
const DEFAULT_CONCURRENCY = 128

function toDateTimeLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('')
}

function createDefaultEventForm() {
  const now = new Date()
  const open = new Date(now.getTime() - 60_000)
  const close = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  return {
    openAt: toDateTimeLocal(open),
    closeAt: toDateTimeLocal(close),
  }
}

const DEFAULT_EVENT_FORM = createDefaultEventForm()

const INITIAL_LOAD_RESULT = {
  running: false,
  completed: 0,
  accepted: 0,
  soldOut: 0,
  duplicate: 0,
  errors: 0,
  remainingStock: null,
  maxIssueSequence: null,
  elapsedMs: 0,
  startedAt: null,
  finishedAt: null,
  cancelled: false,
}

const STATUS_META = {
  ACCEPTED: { label: '발급 승인', tone: 'waiting' },
  PROCESSING: { label: '저장 처리 중', tone: 'waiting' },
  ISSUED: { label: '발급 완료', tone: 'success' },
  FAILED: { label: '저장 실패', tone: 'danger' },
  COMPENSATED: { label: '재고 원복', tone: 'neutral' },
  REJECTED_SOLD_OUT: { label: '재고 소진', tone: 'danger' },
  REJECTED_DUPLICATE: { label: '중복 발급', tone: 'danger' },
  REJECTED_NOT_OPEN: { label: '오픈 전', tone: 'neutral' },
  REJECTED_CLOSED: { label: '마감', tone: 'neutral' },
  REQUEST_FAILED: { label: '요청 실패', tone: 'danger' },
}

const ERROR_LABELS = {
  SOLD_OUT: '재고가 모두 소진되었습니다.',
  ALREADY_ISSUED: '이미 발급받은 사용자입니다.',
  IDEMPOTENCY_CONFLICT: '멱등성 키가 다른 요청에 사용되었습니다.',
  EVENT_NOT_OPEN: '아직 오픈하지 않은 캠페인입니다.',
  EVENT_CLOSED: '종료된 캠페인입니다.',
  EVENT_NOT_FOUND: '캠페인을 찾을 수 없습니다.',
  COUPON_NOT_FOUND: '쿠폰을 찾을 수 없습니다.',
  EVENT_CONFIGURATION_CONFLICT: '같은 회차의 캠페인이 다른 설정으로 이미 존재합니다.',
  CAMPAIGN_CONFIG_CONFLICT: 'Redis에 다른 설정으로 초기화된 캠페인입니다.',
  CAMPAIGN_NOT_INITIALIZABLE: '현재 상태에서는 캠페인을 초기화할 수 없습니다.',
  CAMPAIGN_INIT_FAILED: 'Redis 캠페인 초기화에 실패했습니다.',
  CAMPAIGN_INITIALIZATION_TEMPORARILY_UNAVAILABLE:
    '캠페인은 저장되었지만 Redis 초기화에 실패했습니다. 잠시 후 복구 상태를 확인하세요.',
  ISSUE_NOT_FOUND: '발급 요청을 찾을 수 없습니다.',
  ISSUE_TEMPORARILY_UNAVAILABLE: '발급 시스템을 일시적으로 사용할 수 없습니다.',
  BACKEND_UNAVAILABLE: '백엔드 서버에 연결할 수 없습니다. Spring 서버가 실행 중인지 확인하세요.',
  NETWORK_ERROR: '백엔드 서버에 연결할 수 없습니다.',
}

function loadRecords() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function currentTimestamp() {
  return Date.now()
}

function normalizeCoupons(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.content)) return data.content
  if (Array.isArray(data?.items)) return data.items
  return []
}

function statusMeta(status) {
  return STATUS_META[status] ?? { label: status || '대기', tone: 'neutral' }
}

function eventItem(type, title, detail, tone = 'neutral') {
  return {
    id: crypto.randomUUID(),
    type,
    title,
    detail,
    tone,
    occurredAt: new Date().toISOString(),
  }
}

function mergeStatus(record, data, source = 'POLL') {
  const hasChanged = record.status !== data.status
  const meta = statusMeta(data.status)

  return {
    ...record,
    ...data,
    lastCheckedAt: new Date().toISOString(),
    events: hasChanged
      ? [
          eventItem(
            source,
            meta.label,
            `처리 상태가 ${data.status}(으)로 변경되었습니다.`,
            meta.tone,
          ),
          ...record.events,
        ]
      : record.events,
  }
}

function App() {
  const [records, setRecords] = useState(loadRecords)
  const [selectedId, setSelectedId] = useState(() => loadRecords()[0]?.id ?? null)
  const [eventId, setEventId] = useState('')
  const [userId, setUserId] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [loadEventId, setLoadEventId] = useState('')
  const [startUserId, setStartUserId] = useState('1001')
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY))
  const [loadResult, setLoadResult] = useState(INITIAL_LOAD_RESULT)
  const [couponName, setCouponName] = useState('U+ 데이터 하루 무제한 쿠폰')
  const [couponType, setCouponType] = useState('DATA_UNLIMITED')
  const [couponValue, setCouponValue] = useState('0')
  const [validHours, setValidHours] = useState('24')
  const [creatingCoupon, setCreatingCoupon] = useState(false)
  const [coupons, setCoupons] = useState([])
  const [couponSearch, setCouponSearch] = useState('')
  const [selectedCouponId, setSelectedCouponId] = useState('')
  const [loadingCoupons, setLoadingCoupons] = useState(true)
  const [createdCoupon, setCreatedCoupon] = useState(null)
  const [totalStock, setTotalStock] = useState('10000')
  const [scheduleMode, setScheduleMode] = useState('immediate')
  const [openAt, setOpenAt] = useState(DEFAULT_EVENT_FORM.openAt)
  const [closeAt, setCloseAt] = useState(DEFAULT_EVENT_FORM.closeAt)
  const [creatingEvent, setCreatingEvent] = useState(false)
  const [createdEvent, setCreatedEvent] = useState(null)
  const [initializationEventId, setInitializationEventId] = useState('')
  const [initializingCampaign, setInitializingCampaign] = useState(false)
  const [initializationResult, setInitializationResult] = useState(null)
  const [operationCampaign, setOperationCampaign] = useState(null)
  const [activeTab, setActiveTab] = useState('campaigns')
  const loadAbortRef = useRef(null)

  const selected = records.find((record) => record.id === selectedId) ?? records[0]
  const selectedCoupon = coupons.find(
    (coupon) => String(coupon.couponId) === String(selectedCouponId),
  ) ?? createdCoupon
  const filteredCoupons = useMemo(() => {
    const keyword = couponSearch.trim().toLowerCase()
    if (!keyword) return coupons
    return coupons.filter((coupon) =>
      String(coupon.couponName ?? '').toLowerCase().includes(keyword),
    )
  }, [couponSearch, coupons])

  useEffect(() => () => loadAbortRef.current?.abort(), [])

  useEffect(() => {
    const controller = new AbortController()
    getCoupons(controller.signal)
      .then((data) => {
        const nextCoupons = normalizeCoupons(data)
        setCoupons(nextCoupons)
        setSelectedCouponId((current) => current || String(nextCoupons[0]?.couponId ?? ''))
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice({
          tone: 'danger',
          message: '현재 만들어진 쿠폰 목록을 불러오지 못했습니다.',
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCoupons(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
    } catch {
      // 저장 공간이 제한된 환경에서도 API 시연 기능은 계속 동작한다.
    }
  }, [records])

  useEffect(() => {
    const pending = records.filter(
      (record) => record.requestId && PENDING_STATUSES.has(record.status),
    )
    if (pending.length === 0) return undefined

    const timer = window.setInterval(() => {
      pending.forEach(async (record) => {
        try {
          const data = await getIssueStatus(record.eventId, record.requestId)
          setRecords((current) =>
            current.map((item) =>
              item.id === record.id ? mergeStatus(item, data) : item,
            ),
          )
        } catch {
          // 자동 조회 실패는 기존 판정 결과를 유지하고 수동 새로고침에 맡긴다.
        }
      })
    }, 3000)

    return () => window.clearInterval(timer)
  }, [records])

  const summary = useMemo(() => {
    const accepted = records.filter((record) =>
      ['ACCEPTED', 'ISSUED'].includes(record.status),
    ).length
    const processing = records.filter((record) =>
      record.status === 'PROCESSING',
    ).length
    const failed = records.filter((record) =>
      ['FAILED', 'COMPENSATED', 'REQUEST_FAILED'].includes(record.status),
    ).length
    const latestStock = records.find(
      (record) => record.remainingStock !== null && record.remainingStock !== undefined,
    )?.remainingStock
    return { accepted, processing, failed, latestStock }
  }, [records])

  async function requestIssue({ retryRecord } = {}) {
    const parsedEventId = Number(retryRecord?.eventId ?? eventId)
    const parsedUserId = Number(retryRecord?.userId ?? userId)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setNotice({ tone: 'danger', message: '캠페인 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
      setNotice({ tone: 'danger', message: '사용자 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!operationCampaign || Number(operationCampaign.eventId) !== parsedEventId) {
      setNotice({
        tone: 'danger',
        message: '과거 캠페인은 발급할 수 없습니다. 캠페인 관리에서 새 이벤트를 먼저 생성하세요.',
      })
      setActiveTab('campaigns')
      return
    }

    try {
      const stats = await getIssuanceStats(parsedEventId)
      if (stats.status !== 'OPEN') {
        setNotice({
          tone: 'danger',
          message: `캠페인 ${parsedEventId}번은 현재 ${stats.status} 상태입니다. OPEN 캠페인만 발급할 수 있습니다.`,
        })
        return
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: apiError.code === 'EVENT_STATS_TEMPORARILY_UNAVAILABLE'
          ? 'Redis에 초기화되지 않은 캠페인입니다. 캠페인 관리에서 새 이벤트를 생성하세요.'
          : ERROR_LABELS[apiError.code] ?? apiError.message,
      })
      return
    }

    const recordId = `${parsedEventId}:${parsedUserId}`
    const idempotencyKey = retryRecord?.idempotencyKey ?? crypto.randomUUID()
    const initialEvent = eventItem(
      retryRecord ? 'RETRY' : 'REQUEST',
      retryRecord ? '동일 요청 재시도' : '쿠폰 발급 요청',
      `Idempotency-Key ${idempotencyKey}`,
      'waiting',
    )

    setSubmitting(true)
    setNotice(null)
    setSelectedId(recordId)
    setRecords((current) => {
      const previous = current.find((record) => record.id === recordId)
      const next = {
        id: recordId,
        eventId: parsedEventId,
        userId: parsedUserId,
        idempotencyKey,
        requestId: retryRecord?.requestId ?? null,
        issueSequence: previous?.issueSequence ?? null,
        remainingStock: previous?.remainingStock ?? null,
        status: 'ACCEPTED',
        acceptedAt: previous?.acceptedAt ?? null,
        lastCheckedAt: new Date().toISOString(),
        error: null,
        events: [initialEvent, ...(previous?.events ?? [])],
      }
      return [next, ...current.filter((record) => record.id !== recordId)]
    })

    try {
      const data = await issueCoupon(parsedEventId, parsedUserId, idempotencyKey)
      setRecords((current) =>
        current.map((record) =>
          record.id === recordId
            ? {
                ...record,
                ...data,
                error: null,
                lastCheckedAt: new Date().toISOString(),
                events: [
                  eventItem(
                    'DECISION',
                    'Redis 발급 판정 승인',
                    `발급 순번 ${data.issueSequence} · 잔여 ${data.remainingStock}장`,
                    'success',
                  ),
                  ...record.events,
                ],
              }
            : record,
        ),
      )
      setNotice({ tone: 'success', message: `사용자 ${parsedUserId}의 발급 요청이 승인되었습니다.` })
      if (!retryRecord) setUserId('')
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      const message = ERROR_LABELS[apiError.code] ?? apiError.message
      setRecords((current) =>
        current.map((record) =>
          record.id === recordId
            ? {
                ...record,
                status: 'REQUEST_FAILED',
                error: { code: apiError.code, message, incidentId: apiError.incidentId },
                lastCheckedAt: new Date().toISOString(),
                events: [
                  eventItem('ERROR', apiError.code, message, 'danger'),
                  ...record.events,
                ],
              }
            : record,
        ),
      )
      setNotice({ tone: 'danger', message })
    } finally {
      setSubmitting(false)
    }
  }

  async function refreshSelected() {
    if (!selected?.requestId) return
    setNotice(null)
    try {
      const data = await getIssueStatus(selected.eventId, selected.requestId)
      setRecords((current) =>
        current.map((record) =>
          record.id === selected.id ? mergeStatus(record, data, 'REFRESH') : record,
        ),
      )
      setNotice({ tone: 'success', message: '최신 처리 상태를 확인했습니다.' })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: ERROR_LABELS[apiError.code] ?? apiError.message,
      })
    }
  }

  function clearRecords() {
    setRecords([])
    setSelectedId(null)
    setNotice({ tone: 'neutral', message: '브라우저에 저장된 시연 기록을 비웠습니다.' })
  }

  async function handleLoadSimulationSubmit(event) {
    event.preventDefault()
    const parsedEventId = Number(loadEventId)
    const parsedStartUserId = Number(startUserId)
    const parsedConcurrency = Number(concurrency)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setNotice({ tone: 'danger', message: '부하 발급 캠페인 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedStartUserId) || parsedStartUserId <= 0) {
      setNotice({ tone: 'danger', message: '시작 사용자 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedStartUserId + PARTICIPANT_COUNT - 1)) {
      setNotice({ tone: 'danger', message: '마지막 사용자 ID가 안전한 정수 범위를 벗어납니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedConcurrency) || parsedConcurrency < 1 || parsedConcurrency > 300) {
      setNotice({ tone: 'danger', message: '동시 요청 수는 1~300 사이여야 합니다.' })
      return
    }
    if (!operationCampaign || Number(operationCampaign.eventId) !== parsedEventId) {
      setNotice({
        tone: 'danger',
        message: '캠페인 관리에서 트래픽 테스트용 새 이벤트를 먼저 생성하세요.',
      })
      setActiveTab('campaigns')
      return
    }

    try {
      const stats = await getIssuanceStats(parsedEventId)
      if (stats.status !== 'OPEN') {
        setNotice({ tone: 'danger', message: `OPEN 캠페인만 실행할 수 있습니다. 현재 상태: ${stats.status}` })
        return
      }
      if (stats.remainingStock !== stats.totalStock) {
        setNotice({
          tone: 'danger',
          message: `현재 잔여 재고가 ${stats.remainingStock.toLocaleString()}장입니다. 정확한 검증을 위해 새 10,000장 캠페인을 생성하세요.`,
        })
        return
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: apiError.code === 'EVENT_STATS_TEMPORARILY_UNAVAILABLE'
          ? 'Redis에 초기화되지 않은 캠페인입니다. 새 이벤트를 생성한 뒤 실행하세요.'
          : ERROR_LABELS[apiError.code] ?? apiError.message,
      })
      return
    }

    const controller = new AbortController()
    loadAbortRef.current = controller
    const startedAt = currentTimestamp()
    let nextIndex = 0
    const counters = {
      completed: 0,
      accepted: 0,
      soldOut: 0,
      duplicate: 0,
      errors: 0,
      remainingStock: null,
      maxIssueSequence: null,
    }

    setNotice(null)
    setLoadResult({
      ...INITIAL_LOAD_RESULT,
      running: true,
      startedAt: new Date(startedAt).toISOString(),
    })

    const publish = (finished = false) => {
      const now = currentTimestamp()
      setLoadResult({
        ...counters,
        running: !finished,
        elapsedMs: now - startedAt,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: finished ? new Date(now).toISOString() : null,
        cancelled: controller.signal.aborted,
      })
    }

    async function worker() {
      while (!controller.signal.aborted) {
        const index = nextIndex
        nextIndex += 1
        if (index >= PARTICIPANT_COUNT) return

        const batchUserId = parsedStartUserId + index
        try {
          const data = await issueCoupon(
            parsedEventId,
            batchUserId,
            crypto.randomUUID(),
            controller.signal,
          )
          counters.accepted += 1
          if (Number.isFinite(data.remainingStock)) {
            counters.remainingStock = counters.remainingStock === null
              ? data.remainingStock
              : Math.min(counters.remainingStock, data.remainingStock)
          }
          if (Number.isFinite(data.issueSequence)) {
            counters.maxIssueSequence = counters.maxIssueSequence === null
              ? data.issueSequence
              : Math.max(counters.maxIssueSequence, data.issueSequence)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          if (error instanceof ApiError && error.code === 'SOLD_OUT') {
            counters.soldOut += 1
          } else if (
            error instanceof ApiError &&
            ['ALREADY_ISSUED', 'DUPLICATE_REQUEST'].includes(error.code)
          ) {
            counters.duplicate += 1
          } else {
            counters.errors += 1
          }
        } finally {
          if (!controller.signal.aborted) {
            counters.completed += 1
            if (counters.completed % 100 === 0) publish()
          }
        }
      }
    }

    await Promise.all(Array.from({ length: parsedConcurrency }, () => worker()))
    publish(true)
    loadAbortRef.current = null

    if (!controller.signal.aborted) {
      setNotice({
        tone: counters.accepted > expectedStock ? 'danger' : 'success',
        message:
          counters.accepted > expectedStock
            ? `기대 재고 ${expectedStock.toLocaleString()}장을 초과해 승인되었습니다.`
            : '참여자 20,000명의 선착순 발급 요청을 완료했습니다.',
      })
    }
  }

  function cancelLoadSimulation() {
    loadAbortRef.current?.abort()
  }

  async function createCouponProduct(event) {
    event.preventDefault()
    const parsedValue = Number(couponValue)
    const parsedValidHours = Number(validHours)

    if (!couponName.trim()) {
      setNotice({ tone: 'danger', message: '쿠폰 이름을 입력하세요.' })
      return
    }
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
      setNotice({ tone: 'danger', message: '혜택 값은 0 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedValidHours) || parsedValidHours <= 0) {
      setNotice({ tone: 'danger', message: '발급 후 유효 시간은 1시간 이상이어야 합니다.' })
      return
    }

    setCreatingCoupon(true)
    setNotice(null)
    try {
      const data = await createCoupon({
        couponName: couponName.trim(),
        type: couponType,
        value: parsedValue,
        validHours: parsedValidHours,
      })
      setCreatedCoupon(data)
      setCoupons((current) => [
        data,
        ...current.filter((coupon) => String(coupon.couponId) !== String(data.couponId)),
      ])
      setSelectedCouponId(String(data.couponId))
      setCreatedEvent(null)
      setOperationCampaign(null)
      setEventId('')
      setLoadEventId('')
      setNotice({
        tone: 'success',
        message: `쿠폰 상품 ${data.couponId}번이 생성되었습니다. 이제 1회차 발급 일정을 설정하세요.`,
      })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({ tone: 'danger', message: ERROR_LABELS[apiError.code] ?? apiError.message })
    } finally {
      setCreatingCoupon(false)
    }
  }

  async function createEvent(event) {
    event.preventDefault()
    const parsedCouponId = Number(selectedCoupon?.couponId)
    const parsedTotalStock = Number(totalStock)
    const openDate = scheduleMode === 'immediate'
      ? new Date(Date.now() - 60_000)
      : new Date(openAt)
    const closeDate = new Date(closeAt)

    if (!Number.isSafeInteger(parsedCouponId) || parsedCouponId <= 0) {
      setNotice({ tone: 'danger', message: '쿠폰 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedTotalStock) || parsedTotalStock <= 0) {
      setNotice({ tone: 'danger', message: '전체 재고는 1 이상의 정수여야 합니다.' })
      return
    }
    if (Number.isNaN(openDate.getTime()) || Number.isNaN(closeDate.getTime())) {
      setNotice({ tone: 'danger', message: '오픈 시각과 마감 시각을 모두 입력하세요.' })
      return
    }
    if (closeDate <= openDate) {
      setNotice({ tone: 'danger', message: '마감 시각은 오픈 시각보다 늦어야 합니다.' })
      return
    }

    setCreatingEvent(true)
    setNotice(null)
    try {
      const data = await createCouponEvent(parsedCouponId, {
        totalStock: parsedTotalStock,
        openAt: openDate.toISOString(),
        closeAt: closeDate.toISOString(),
      })

      const newEventId = data.eventId
      setCreatedEvent(data)
      setOperationCampaign(data)
      setLoadResult(INITIAL_LOAD_RESULT)
      if (newEventId) {
        setEventId(String(newEventId))
        setLoadEventId(String(newEventId))
        setInitializationEventId(String(newEventId))
      }
      setNotice({
        tone: 'success',
        message: `쿠폰 이벤트 ${newEventId ?? '-'}번이 생성되고 Redis 재고가 초기화되었습니다. 발급 운영으로 이동했습니다.`,
      })
      setActiveTab('operations')
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: ERROR_LABELS[apiError.code] ?? apiError.message,
      })
    } finally {
      setCreatingEvent(false)
    }
  }

  async function initializeEvent(event) {
    event.preventDefault()
    const parsedEventId = Number(initializationEventId)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setNotice({ tone: 'danger', message: '초기화할 캠페인 ID는 1 이상의 정수여야 합니다.' })
      return
    }

    setInitializingCampaign(true)
    setInitializationResult(null)
    setNotice(null)
    try {
      const data = await initializeCampaign(parsedEventId)
      setInitializationResult(data)
      setOperationCampaign(data)
      setEventId(String(data.eventId))
      setLoadEventId(String(data.eventId))
      setNotice({
        tone: 'success',
        message: `캠페인 ${data.eventId}번 Redis 초기화 결과: ${data.result}`,
      })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: ERROR_LABELS[apiError.code] ?? apiError.message,
      })
    } finally {
      setInitializingCampaign(false)
    }
  }

  const selectedMeta = statusMeta(selected?.status)
  const expectedStock = operationCampaign?.totalStock ?? (Number(totalStock) || 0)
  const loadProgress = (loadResult.completed / PARTICIPANT_COUNT) * 100
  const loadThroughput = loadResult.elapsedMs > 0
    ? Math.round(loadResult.completed / (loadResult.elapsedMs / 1000))
    : 0
  const overIssued = expectedStock > 0 && loadResult.accepted > expectedStock
  const loadTestPassed =
    loadResult.completed === PARTICIPANT_COUNT &&
    expectedStock > 0 &&
    loadResult.accepted === expectedStock &&
    loadResult.soldOut === PARTICIPANT_COUNT - expectedStock &&
    loadResult.duplicate === 0 &&
    loadResult.errors === 0

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand" aria-label="U+ Coupon Operations">
          <span className="brand-mark">U<sup>+</sup></span>
          <span className="brand-copy">Coupon Ops</span>
        </div>

        <nav className="nav-list" aria-label="관리자 메뉴">
          <button
            className={`nav-item ${activeTab === 'operations' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('operations')}
          >
            <span className="nav-icon">⌁</span>
            발급 운영
          </button>
          <button
            className={`nav-item ${activeTab === 'campaigns' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('campaigns')}
          >
            <span className="nav-icon">◎</span>
            캠페인 관리
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-icon">↗</span>
            정합성 리포트
            <span className="soon">예정</span>
          </button>
        </nav>

        <div className="sidebar-status">
          <span className="live-dot" />
          <div>
            <strong>API 연결 모드</strong>
            <small>develop 계약 기준</small>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">FREEDOM DAY · COUPON CONTROL</p>
            <h1>쿠폰 발급 운영센터</h1>
            <p className="subtitle">데이터 하루 무제한 쿠폰의 발급 흐름을 한 화면에서 확인하세요.</p>
          </div>
          <div className="operator">
            <span className="operator-avatar">A</span>
            <div>
              <strong>운영 관리자</strong>
              <small>시연 환경</small>
            </div>
          </div>
        </header>

        <section className="summary-grid" aria-label="발급 현황 요약">
          <article className="summary-card accent-card">
            <div>
              <span>최근 확인 잔여 수량</span>
              <strong>{summary.latestStock?.toLocaleString() ?? '-'}</strong>
            </div>
            <span className="summary-unit">장</span>
          </article>
          <article className="summary-card">
            <span>발급 판정 승인</span>
            <strong>{summary.accepted.toLocaleString()}</strong>
            <small>Redis 원자적 판정 통과</small>
          </article>
          <article className="summary-card">
            <span>처리 중</span>
            <strong>{summary.processing.toLocaleString()}</strong>
            <small>3초 간격 자동 조회</small>
          </article>
          <article className="summary-card">
            <span>실패 · 원복</span>
            <strong>{summary.failed.toLocaleString()}</strong>
            <small>확인이 필요한 요청</small>
          </article>
        </section>

        {notice && (
          <div className={`notice ${notice.tone}`} role="status">
            <span>{notice.tone === 'danger' ? '!' : '✓'}</span>
            {notice.message}
            <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기">×</button>
          </div>
        )}

        {activeTab === 'campaigns' && (
          <section className="campaign-management" aria-labelledby="campaign-management-title">
            <div className="tab-heading">
              <div>
                <span className="eyebrow">CAMPAIGN MANAGEMENT</span>
                <h2 id="campaign-management-title">쿠폰 이벤트와 예약 오픈 관리</h2>
                <p>쿠폰을 발급할 이벤트를 만들고, 오픈 및 마감 일정을 관리합니다.</p>
              </div>
              <span className="api-chip">EVENT CONFIGURATION</span>
            </div>

            <ol className="demo-flow" aria-label="쿠폰 발급 시연 순서">
              <li className="active">
                <span>1</span>
                <div><strong>쿠폰 상품 생성</strong><small>이름 · 종류 · 혜택 · 유효시간</small></div>
              </li>
              <li>
                <span>2</span>
                <div><strong>회차와 예약 생성</strong><small>1회차부터 서버 자동 배정</small></div>
              </li>
              <li>
                <span>3</span>
                <div><strong>발급 운영</strong><small>한 장 발급 / 20,000명 요청</small></div>
              </li>
            </ol>

            <section className="panel coupon-create-panel" aria-labelledby="coupon-create-title">
              <div className="panel-heading">
                <div>
                  <span className="section-number">00</span>
                  <h2 id="coupon-create-title">쿠폰 상품 생성</h2>
                </div>
                <span className="api-chip">POST · /api/v1/coupons</span>
              </div>
              <form className="event-create-form coupon-product-form" onSubmit={createCouponProduct}>
                <label>
                  쿠폰 이름
                  <input value={couponName} maxLength="100" onChange={(event) => setCouponName(event.target.value)} required />
                </label>
                <label>
                  쿠폰 종류
                  <select value={couponType} onChange={(event) => setCouponType(event.target.value)}>
                    <option value="DATA_UNLIMITED">데이터 무제한</option>
                    <option value="DATA_AMOUNT">데이터 용량</option>
                    <option value="DISCOUNT">요금 할인</option>
                  </select>
                </label>
                <label>
                  혜택 값
                  <input type="number" min="0" step="1" value={couponValue} onChange={(event) => setCouponValue(event.target.value)} required />
                  <small className="form-field-help">무제한 쿠폰은 0으로 설정합니다.</small>
                </label>
                <label>
                  발급 후 유효 시간
                  <div className="input-with-unit">
                    <input type="number" min="1" step="1" value={validHours} onChange={(event) => setValidHours(event.target.value)} required />
                    <span>시간</span>
                  </div>
                </label>
                <button className="primary-button" type="submit" disabled={creatingCoupon}>
                  {creatingCoupon ? '쿠폰 생성 중…' : '쿠폰 상품 생성'}
                  <span>→</span>
                </button>
              </form>
              {createdCoupon && (
                <div className="created-event-summary" role="status">
                  <strong>쿠폰 #{createdCoupon.couponId}</strong>
                  <span>{createdCoupon.couponName}</span>
                  <small>{createdCoupon.type} · 혜택 {createdCoupon.value} · 발급 후 {createdCoupon.validHours}시간</small>
                </div>
              )}
            </section>

            <section className="panel event-create-panel" aria-labelledby="event-create-title">
              <div className="panel-heading">
                <div>
                  <span className="section-number">01</span>
                  <h2 id="event-create-title">발급 회차와 예약 오픈 생성</h2>
                </div>
                <span className="api-chip">POST · /api/v1/coupons/{'{couponId}'}/events</span>
              </div>
              <div className="coupon-catalog" aria-labelledby="coupon-catalog-title">
                <div className="catalog-heading">
                  <div>
                    <strong id="coupon-catalog-title">발급할 쿠폰 선택</strong>
                    <small>{coupons.length.toLocaleString()}개 쿠폰</small>
                  </div>
                  <input
                    type="search"
                    value={couponSearch}
                    onChange={(event) => setCouponSearch(event.target.value)}
                    placeholder="쿠폰 이름 검색"
                    aria-label="쿠폰 이름 검색"
                  />
                </div>
                {loadingCoupons ? (
                  <p className="catalog-empty">쿠폰 목록을 불러오는 중입니다.</p>
                ) : filteredCoupons.length > 0 ? (
                  <div className="coupon-catalog-list">
                    {filteredCoupons.map((coupon) => (
                      <button
                        key={coupon.couponId}
                        type="button"
                        className={`coupon-catalog-item ${String(coupon.couponId) === String(selectedCouponId) ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedCouponId(String(coupon.couponId))
                          setCreatedEvent(null)
                        }}
                      >
                        <span>
                          <strong>{coupon.couponName}</strong>
                          <small>#{coupon.couponId} · {coupon.type}</small>
                        </span>
                        <span className="catalog-check" aria-hidden="true">{String(coupon.couponId) === String(selectedCouponId) ? '✓' : '○'}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="catalog-empty">검색 결과에 맞는 쿠폰이 없습니다.</p>
                )}
              </div>
              <form className="event-create-form" onSubmit={createEvent}>
                <label>
                  대상 쿠폰
                  <input
                    value={selectedCoupon ? `#${selectedCoupon.couponId} · ${selectedCoupon.couponName}` : ''}
                    readOnly
                    aria-readonly="true"
                    placeholder="위 목록에서 쿠폰을 선택하세요"
                  />
                </label>
                <label>
                  회차
                  <input
                    value={`${createdEvent?.round ?? 1}회차`}
                    readOnly
                    aria-readonly="true"
                    title="쿠폰별 마지막 회차 다음 번호가 서버 트랜잭션에서 배정됩니다."
                  />
                </label>
                <label>
                  전체 재고
                  <input type="number" min="1" step="1" value={totalStock} onChange={(event) => setTotalStock(event.target.value)} required />
                </label>
                <fieldset className="schedule-settings">
                  <legend>예약 오픈 설정</legend>
                  <div className="schedule-mode-options">
                    <label>
                      <input
                        type="radio"
                        name="schedule-mode"
                        value="immediate"
                        checked={scheduleMode === 'immediate'}
                        onChange={(event) => setScheduleMode(event.target.value)}
                      />
                      지금 바로 발급
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="schedule-mode"
                        value="scheduled"
                        checked={scheduleMode === 'scheduled'}
                        onChange={(event) => setScheduleMode(event.target.value)}
                      />
                      예약 오픈
                    </label>
                  </div>
                  <p>{scheduleMode === 'scheduled' ? '설정한 오픈 시각부터 쿠폰 발급이 가능해집니다.' : '생성 즉시 쿠폰 발급이 가능한 상태로 설정됩니다.'}</p>
                  <div className="schedule-settings-fields">
                    <label>
                      오픈 시각
                      <input type="datetime-local" value={openAt} onChange={(event) => setOpenAt(event.target.value)} disabled={scheduleMode !== 'scheduled'} required={scheduleMode === 'scheduled'} />
                    </label>
                    <label>
                      마감 시각
                      <input type="datetime-local" value={closeAt} onChange={(event) => setCloseAt(event.target.value)} disabled={scheduleMode !== 'scheduled'} required={scheduleMode === 'scheduled'} />
                    </label>
                  </div>
                </fieldset>
                <button className="primary-button" type="submit" disabled={creatingEvent || !selectedCoupon}>
                  {creatingEvent ? '이벤트 생성 중…' : '쿠폰 이벤트 생성'}
                  <span>→</span>
                </button>
              </form>
              {createdEvent && (
                <div className="created-event-summary" role="status">
                  <strong>이벤트 #{createdEvent.eventId}</strong>
                  <span>{createdEvent.status} · {createdEvent.remainingStock?.toLocaleString()}장 대기</span>
                  <small>{formatDate(createdEvent.openAt)} 오픈 · {formatDate(createdEvent.closeAt)} 마감</small>
                </div>
              )}
            </section>

            <section className="schedule-management-grid">
              <article className="panel schedule-overview" aria-labelledby="schedule-overview-title">
                <div className="panel-heading">
                  <div>
                    <span className="section-number">01</span>
                    <h2 id="schedule-overview-title">예약 오픈 일정</h2>
                  </div>
                  <span className="api-chip subtle">SERVER SCHEDULE</span>
                </div>
                {createdEvent ? (
                  <dl className="schedule-detail-grid">
                    <div><dt>이벤트</dt><dd>#{createdEvent.eventId} · {createdEvent.round}회차</dd></div>
                    <div><dt>현재 상태</dt><dd>{createdEvent.status}</dd></div>
                    <div><dt>오픈 시각</dt><dd>{formatDate(createdEvent.openAt)}</dd></div>
                    <div><dt>마감 시각</dt><dd>{formatDate(createdEvent.closeAt)}</dd></div>
                  </dl>
                ) : (
                  <div className="empty-state small">
                    <strong>생성된 이벤트가 없습니다</strong>
                    <p>이벤트를 생성하면 예약 오픈 일정이 표시됩니다.</p>
                  </div>
                )}
              </article>
              <ScheduledOpenTimeline
                status={createdEvent?.status}
                observedAt={createdEvent?.openAt}
              />
            </section>

            <section className="panel campaign-initialization" aria-labelledby="campaign-initialization-title">
              <div className="panel-heading">
                <div>
                  <span className="section-number">02</span>
                  <h2 id="campaign-initialization-title">Redis 캠페인 초기화 복구 · 장애 대응 전용</h2>
                </div>
                <span className="api-chip">POST · /internal/campaigns/{'{eventId}'}/init</span>
              </div>
              <div className="initialization-layout">
                <div className="initialization-copy">
                  <strong>일반 발급에서는 실행하지 않습니다.</strong>
                  <p>
                    위의 캠페인 생성 API가 DB 저장과 Redis 초기화를 함께 처리합니다.
                    이 기능은 생성 응답이 초기화 실패로 끝난 경우에만 사용합니다.
                    백엔드에서 <code>coupon.issue.admin.enabled=true</code>로 노출한 시연 환경에서만 동작합니다.
                  </p>
                </div>
                <form className="initialization-form" onSubmit={initializeEvent}>
                  <label htmlFor="initialization-event-id">캠페인 ID</label>
                  <div>
                    <input
                      id="initialization-event-id"
                      type="number"
                      min="1"
                      step="1"
                      value={initializationEventId}
                      onChange={(event) => setInitializationEventId(event.target.value)}
                      placeholder="예: 24"
                      required
                    />
                    <button className="secondary-button" type="submit" disabled={initializingCampaign}>
                      {initializingCampaign ? '초기화 중…' : 'Redis 초기화 실행'}
                    </button>
                  </div>
                </form>
              </div>
              {initializationResult && (
                <dl className="initialization-result" aria-label="Redis 초기화 결과">
                  <div><dt>이벤트</dt><dd>#{initializationResult.eventId}</dd></div>
                  <div><dt>결과</dt><dd>{initializationResult.result}</dd></div>
                  <div><dt>초기 재고</dt><dd>{initializationResult.totalStock?.toLocaleString()}장</dd></div>
                  <div><dt>발급 기간</dt><dd>{formatDate(initializationResult.openAt)} ~ {formatDate(initializationResult.closeAt)}</dd></div>
                </dl>
              )}
            </section>
          </section>
        )}

        {activeTab === 'operations' && <>
        <CampaignMonitor
          key={operationCampaign?.eventId ?? 'default'}
          selectedEventId={operationCampaign?.eventId}
        />

        <section className="panel traffic-panel" aria-labelledby="traffic-title">
          <div className="traffic-intro">
            <div className="traffic-copy">
              <span className="traffic-kicker">FIRST-COME, FIRST-SERVED TRAFFIC</span>
              <h2 id="traffic-title">재고 {expectedStock.toLocaleString()}장 · 참여자 {PARTICIPANT_COUNT.toLocaleString()}명</h2>
              <p>
                재고 {expectedStock.toLocaleString()}장 캠페인에 서로 다른 사용자 {PARTICIPANT_COUNT.toLocaleString()}명이 발급을 요청합니다.
                승인과 재고 소진 응답을 실시간으로 집계해 초과 발급 여부를 확인합니다.
              </p>
              <div className="traffic-expectation">
                <span><strong>{expectedStock.toLocaleString()}</strong> ACCEPTED</span>
                <span className="expectation-divider">+</span>
                <span><strong>{Math.max(PARTICIPANT_COUNT - expectedStock, 0).toLocaleString()}</strong> SOLD_OUT</span>
                <span className="expectation-equals">= 초과 발급 0</span>
              </div>
            </div>

            <form className="traffic-form" onSubmit={handleLoadSimulationSubmit}>
              <label>
                캠페인 ID
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={loadEventId}
                  readOnly
                  aria-readonly="true"
                  placeholder="캠페인 생성 후 자동 입력"
                />
              </label>
              <label>
                시작 사용자 ID
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={startUserId}
                  onChange={(event) => setStartUserId(event.target.value)}
                  disabled={loadResult.running}
                />
              </label>
              <label>
                동시 작업자
                <input
                  type="number"
                  min="1"
                  max="300"
                  step="1"
                  value={concurrency}
                  onChange={(event) => setConcurrency(event.target.value)}
                  disabled={loadResult.running}
                />
              </label>
              {loadResult.running ? (
                <button className="traffic-stop-button" type="button" onClick={cancelLoadSimulation}>
                  요청 중단
                </button>
              ) : (
                <button className="traffic-start-button" type="submit" disabled={!operationCampaign}>
                  <span className="traffic-play">▶</span>
                  20,000명 참여 시작
                </button>
              )}
            </form>
          </div>

          <div className="traffic-progress" aria-live="polite">
            <div className="progress-heading">
              <span>
                {loadResult.running
                  ? '트래픽 전송 중'
                  : loadResult.finishedAt
                    ? loadResult.cancelled ? '실행 중단됨' : '실행 완료'
                    : '실행 대기'}
              </span>
              <strong>{loadResult.completed.toLocaleString()} / {PARTICIPANT_COUNT.toLocaleString()}명</strong>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax={PARTICIPANT_COUNT}
              aria-valuenow={loadResult.completed}
            >
              <span style={{ width: `${Math.min(loadProgress, 100)}%` }} />
            </div>
          </div>

          <div className="traffic-result-grid">
            <div className="traffic-metric accepted">
              <span>승인</span>
              <strong>{loadResult.accepted.toLocaleString()}</strong>
              <small>ACCEPTED · HTTP 202</small>
            </div>
            <div className="traffic-metric sold-out">
              <span>재고 소진</span>
              <strong>{loadResult.soldOut.toLocaleString()}</strong>
              <small>SOLD_OUT · HTTP 409</small>
            </div>
            <div className="traffic-metric">
              <span>중복 차단</span>
              <strong>{loadResult.duplicate.toLocaleString()}</strong>
              <small>고유 사용자 기준 기대값 0</small>
            </div>
            <div className="traffic-metric">
              <span>기타 오류</span>
              <strong>{loadResult.errors.toLocaleString()}</strong>
              <small>네트워크 · 시스템 오류</small>
            </div>
            <div className="traffic-metric">
              <span>클라이언트 처리량</span>
              <strong>{loadThroughput.toLocaleString()}</strong>
              <small>requests/sec</small>
            </div>
            <div className={`traffic-verdict ${overIssued ? 'failed' : loadTestPassed ? 'passed' : ''}`}>
              <span>검증 결과</span>
              <strong>
                {overIssued
                  ? '초과 발급 감지'
                  : loadTestPassed
                    ? '정상 방어'
                    : loadResult.finishedAt && !loadResult.cancelled
                      ? '조건 불일치'
                      : '대기 중'}
              </strong>
              <small>
                {loadResult.finishedAt
                  ? `소요 ${(loadResult.elapsedMs / 1000).toFixed(1)}초 · 최저 잔여 ${loadResult.remainingStock ?? '-'}장`
                  : '캠페인 관리에서 생성한 이벤트 ID로 실행하세요.'}
              </small>
            </div>
          </div>

          <p className="traffic-note">
            참여자 {PARTICIPANT_COUNT.toLocaleString()}명은 서로 다른 사용자 ID로 한 번씩 요청하며, 설정된 재고만큼 쿠폰을 발급받습니다.
            개별 응답은 사용자 이력에 저장하지 않고 결과만 집계합니다.
            이 수치는 브라우저에서 API까지의 요청 결과로, 서버 내부 Lua 벤치마크 TPS와는 구분됩니다.
          </p>
        </section>

        <section className="workspace-grid">
          <article className="panel issue-panel">
            <div className="panel-heading">
              <div>
                <span className="section-number">01</span>
                <h2>쿠폰 발급</h2>
              </div>
              <span className="api-chip">POST · /api/v1/events/{'{eventId}'}/issues</span>
            </div>

            <div className="coupon-preview">
              <div className="coupon-brand">U<sup>+</sup></div>
              <div className="coupon-copy">
                <span>FREEDOM DAY</span>
                <strong>데이터 하루<br />무제한</strong>
                <small>오늘 하루, 속도 걱정 없이 자유롭게</small>
              </div>
              <div className="coupon-badge">24H</div>
            </div>

            <form
              className="issue-form"
              onSubmit={(event) => {
                event.preventDefault()
                requestIssue()
              }}
            >
              <label>
                캠페인 ID
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={eventId}
                  readOnly
                  aria-readonly="true"
                  placeholder="캠페인 생성 후 자동 입력"
                />
              </label>
              <label>
                사용자 ID
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  placeholder="예: 10001"
                />
              </label>
              <button className="primary-button" type="submit" disabled={submitting || !operationCampaign}>
                {submitting ? 'Redis 판정 중…' : '쿠폰 발급 요청'}
                <span>→</span>
              </button>
            </form>
            <p className="form-help">
              캠페인 관리에서 새 이벤트를 생성하면 ID가 자동 입력됩니다. 새 요청에는 UUID 멱등성 키가 자동으로 생성됩니다.
            </p>
          </article>

          <article className="panel user-panel">
            <div className="panel-heading">
              <div>
                <span className="section-number">02</span>
                <h2>사용자 쿠폰 제어</h2>
              </div>
              {selected && <span className={`status-badge ${selectedMeta.tone}`}>{selectedMeta.label}</span>}
            </div>

            {records.length > 0 ? (
              <>
                <div className="user-tabs" role="tablist" aria-label="발급 사용자">
                  {records.map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      role="tab"
                      aria-selected={record.id === selected?.id}
                      className={record.id === selected?.id ? 'selected' : ''}
                      onClick={() => setSelectedId(record.id)}
                    >
                      <span>U{record.userId}</span>
                      <small>E{record.eventId}</small>
                    </button>
                  ))}
                </div>

                <div className="user-summary">
                  <div className="user-identity">
                    <span className="user-avatar">{String(selected.userId).slice(-2)}</span>
                    <div>
                      <strong>사용자 #{selected.userId}</strong>
                      <small>캠페인 #{selected.eventId}</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={refreshSelected}
                    disabled={!selected.requestId}
                  >
                    상태 새로고침
                  </button>
                </div>

                <dl className="issue-detail-grid">
                  <div>
                    <dt>발급 순번</dt>
                    <dd>{selected.issueSequence?.toLocaleString() ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>잔여 수량</dt>
                    <dd>{selected.remainingStock?.toLocaleString() ?? '-'}{selected.remainingStock != null && '장'}</dd>
                  </div>
                  <div>
                    <dt>요청 ID</dt>
                    <dd title={selected.requestId}>{selected.requestId ? `${selected.requestId.slice(0, 8)}…` : '-'}</dd>
                  </div>
                  <div>
                    <dt>최근 확인</dt>
                    <dd>{formatDate(selected.lastCheckedAt)}</dd>
                  </div>
                </dl>

                {selected.error && (
                  <div className="error-box">
                    <strong>{selected.error.code}</strong>
                    <span>{selected.error.message}</span>
                    {selected.error.incidentId && <small>Incident ID: {selected.error.incidentId}</small>}
                  </div>
                )}

                <div className="action-area">
                  <div className="action-heading">
                    <strong>상태 변경 이벤트</strong>
                    <span>백엔드 API 연결 대기</span>
                  </div>
                  <div className="action-buttons">
                    <button type="button" disabled title="사용 처리 API가 필요합니다.">사용 처리</button>
                    <button type="button" disabled title="사용 취소 API가 필요합니다.">사용 취소</button>
                    <button type="button" disabled title="만료 처리 API가 필요합니다.">만료 처리</button>
                  </div>
                  {selected.status === 'REQUEST_FAILED' && (
                    <button
                      type="button"
                      className="retry-button"
                      onClick={() => requestIssue({ retryRecord: selected })}
                      disabled={submitting}
                    >
                      동일 Idempotency-Key로 재시도
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <span>＋</span>
                <strong>아직 발급 요청이 없습니다</strong>
                <p>왼쪽에서 사용자 ID를 입력하고 첫 쿠폰을 발급해보세요.</p>
              </div>
            )}
          </article>
        </section>
        </>}

        <section className="history-grid">
          <article className="panel history-panel">
            <div className="panel-heading">
              <div>
                <span className="section-number">03</span>
                <h2>발급 이력</h2>
              </div>
              {records.length > 0 && <button className="text-button" type="button" onClick={clearRecords}>기록 비우기</button>}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>사용자</th>
                    <th>캠페인</th>
                    <th>순번</th>
                    <th>상태</th>
                    <th>요청 시각</th>
                  </tr>
                </thead>
                <tbody>
                  {records.length > 0 ? records.map((record) => {
                    const meta = statusMeta(record.status)
                    return (
                      <tr key={record.id} onClick={() => setSelectedId(record.id)}>
                        <td><strong>#{record.userId}</strong></td>
                        <td>#{record.eventId}</td>
                        <td>{record.issueSequence ?? '-'}</td>
                        <td><span className={`status-badge compact ${meta.tone}`}>{meta.label}</span></td>
                        <td>{formatDate(record.acceptedAt ?? record.lastCheckedAt)}</td>
                      </tr>
                    )
                  }) : (
                    <tr><td colSpan="5" className="table-empty">API 응답 이력이 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="data-note">현재 화면에서 발생한 실제 API 응답만 브라우저에 보관합니다.</p>
          </article>

          <article className="panel timeline-panel">
            <div className="panel-heading">
              <div>
                <span className="section-number">04</span>
                <h2>쿠폰 상태 이력</h2>
              </div>
              <span className="api-chip subtle">현재 세션</span>
            </div>
            {selected?.events?.length ? (
              <ol className="timeline">
                {selected.events.map((item) => (
                  <li key={item.id} className={item.tone}>
                    <span className="timeline-dot" />
                    <div>
                      <div className="timeline-title">
                        <strong>{item.title}</strong>
                        <time>{formatDate(item.occurredAt)}</time>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty-state small">
                <strong>표시할 상태 변경이 없습니다</strong>
                <p>발급 요청 이후 판정과 저장 상태가 시간순으로 표시됩니다.</p>
              </div>
            )}
          </article>
        </section>
      </main>
    </div>
  )
}

export default App

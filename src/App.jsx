import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, getIssueStatus, issueCoupon } from './api/couponApi'
import './App.css'

const STORAGE_KEY = 'ace-manager-issue-records'
const PENDING_STATUSES = new Set(['ACCEPTED', 'PROCESSING'])
const PARTICIPANT_COUNT = 20000
const EXPECTED_STOCK = 10000
const DEFAULT_CONCURRENCY = 128

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
  ISSUE_NOT_FOUND: '발급 요청을 찾을 수 없습니다.',
  ISSUE_TEMPORARILY_UNAVAILABLE: '발급 시스템을 일시적으로 사용할 수 없습니다.',
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
  const [eventId, setEventId] = useState('1')
  const [userId, setUserId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [loadEventId, setLoadEventId] = useState('1')
  const [startUserId, setStartUserId] = useState('1')
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY))
  const [loadResult, setLoadResult] = useState(INITIAL_LOAD_RESULT)
  const loadAbortRef = useRef(null)

  const selected = records.find((record) => record.id === selectedId) ?? records[0]

  useEffect(() => () => loadAbortRef.current?.abort(), [])

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
    const issued = records.filter((record) => record.status === 'ISSUED').length
    const processing = records.filter((record) =>
      PENDING_STATUSES.has(record.status),
    ).length
    const failed = records.filter((record) =>
      ['FAILED', 'COMPENSATED', 'REQUEST_FAILED'].includes(record.status),
    ).length
    const latestStock = records.find(
      (record) => record.remainingStock !== null && record.remainingStock !== undefined,
    )?.remainingStock
    return { issued, processing, failed, latestStock }
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

  async function runLoadSimulation() {
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

    const controller = new AbortController()
    loadAbortRef.current = controller
    const startedAt = Date.now()
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
      const now = Date.now()
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
        tone: counters.accepted > EXPECTED_STOCK ? 'danger' : 'success',
        message:
          counters.accepted > EXPECTED_STOCK
            ? `기대 재고 ${EXPECTED_STOCK.toLocaleString()}장을 초과해 승인되었습니다.`
            : '참여자 20,000명의 선착순 발급 요청을 완료했습니다.',
      })
    }
  }

  function cancelLoadSimulation() {
    loadAbortRef.current?.abort()
  }

  const selectedMeta = statusMeta(selected?.status)
  const loadProgress = (loadResult.completed / PARTICIPANT_COUNT) * 100
  const loadThroughput = loadResult.elapsedMs > 0
    ? Math.round(loadResult.completed / (loadResult.elapsedMs / 1000))
    : 0
  const overIssued = loadResult.accepted > EXPECTED_STOCK
  const loadTestPassed =
    loadResult.completed === PARTICIPANT_COUNT &&
    loadResult.accepted === EXPECTED_STOCK &&
    loadResult.soldOut === PARTICIPANT_COUNT - EXPECTED_STOCK &&
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
          <button className="nav-item active" type="button">
            <span className="nav-icon">⌁</span>
            발급 운영
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-icon">◎</span>
            캠페인 관리
            <span className="soon">예정</span>
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
            <span>발급 완료</span>
            <strong>{summary.issued.toLocaleString()}</strong>
            <small>현재 브라우저 기록</small>
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

        <section className="panel traffic-panel" aria-labelledby="traffic-title">
          <div className="traffic-intro">
            <div className="traffic-copy">
              <span className="traffic-kicker">FIRST-COME, FIRST-SERVED TRAFFIC</span>
              <h2 id="traffic-title">재고 10,000장 · 참여자 20,000명</h2>
              <p>
                재고 10,000장 캠페인에 서로 다른 사용자 20,000명이 발급을 요청합니다.
                승인과 재고 소진 응답을 실시간으로 집계해 초과 발급 여부를 확인합니다.
              </p>
              <div className="traffic-expectation">
                <span><strong>10,000</strong> ACCEPTED</span>
                <span className="expectation-divider">+</span>
                <span><strong>10,000</strong> SOLD_OUT</span>
                <span className="expectation-equals">= 초과 발급 0</span>
              </div>
            </div>

            <form
              className="traffic-form"
              onSubmit={(event) => {
                event.preventDefault()
                runLoadSimulation()
              }}
            >
              <label>
                캠페인 ID
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={loadEventId}
                  onChange={(event) => setLoadEventId(event.target.value)}
                  disabled={loadResult.running}
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
                <button className="traffic-start-button" type="submit">
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
                  : '신규 10,000장 캠페인으로 실행하세요.'}
              </small>
            </div>
          </div>

          <p className="traffic-note">
            참여자 20,000명은 서로 다른 사용자 ID로 한 번씩 요청하며, 최대 10,000명만 쿠폰을 발급받습니다.
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
              <span className="api-chip">POST · /issues</span>
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
                  onChange={(event) => setEventId(event.target.value)}
                  placeholder="예: 1"
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
              <button className="primary-button" type="submit" disabled={submitting}>
                {submitting ? 'Redis 판정 중…' : '쿠폰 발급 요청'}
                <span>→</span>
              </button>
            </form>
            <p className="form-help">새 요청에는 UUID 멱등성 키가 자동으로 생성됩니다.</p>
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

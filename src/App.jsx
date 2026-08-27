import { useEffect, useRef, useState } from 'react'
import { ApiError, getCoupons, getIssuanceStats, getRecentCouponEvents, issueCoupon } from './api/couponApi'
import CampaignManagementTab from './tabs/CampaignManagementTab'
import OperationsTab, { loadRecords } from './tabs/OperationsTab'
import LoadTestTab from './tabs/LoadTestTab'
import IntegrityReportTab from './tabs/IntegrityReportTab'
import './App.css'

const WORKSPACE_STORAGE_KEY = 'ace-manager-coupon-workspace'

function millisecondsUntilNextCampaignRefresh(now = new Date()) {
  const next = new Date(now)
  next.setMilliseconds(0)

  if (now.getSeconds() < 1) {
    next.setSeconds(1)
  } else if (now.getSeconds() < 31) {
    next.setSeconds(31)
  } else {
    next.setMinutes(now.getMinutes() + 1, 1, 0)
  }

  return Math.max(250, next.getTime() - now.getTime())
}

const PARTICIPANT_COUNT = 20000
const DEFAULT_CONCURRENCY = 128
const LOAD_USER_ID_START = 1001

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

function currentTimestamp() {
  return Date.now()
}

const ERROR_LABELS = {
  SOLD_OUT: '재고가 모두 소진되었습니다.',
  ALREADY_ISSUED: '이미 발급받은 사용자입니다.',
  IDEMPOTENCY_CONFLICT: '멱등성 키가 다른 요청에 사용되었습니다.',
  EVENT_NOT_OPEN: '아직 오픈하지 않은 쿠폰입니다.',
  EVENT_CLOSED: '종료된 쿠폰입니다.',
  EVENT_NOT_FOUND: '쿠폰을 찾을 수 없습니다.',
  COUPON_NOT_FOUND: '쿠폰을 찾을 수 없습니다.',
  EVENT_CONFIGURATION_CONFLICT: '같은 회차의 쿠폰이 다른 설정으로 이미 존재합니다.',
  CAMPAIGN_CONFIG_CONFLICT: 'Redis에 다른 설정으로 초기화된 쿠폰입니다.',
  CAMPAIGN_NOT_INITIALIZABLE: '현재 상태에서는 쿠폰을 초기화할 수 없습니다.',
  CAMPAIGN_INIT_FAILED: 'Redis 쿠폰 초기화에 실패했습니다.',
  CAMPAIGN_INITIALIZATION_TEMPORARILY_UNAVAILABLE:
    '쿠폰은 저장되었지만 Redis 초기화에 실패했습니다. 잠시 후 복구 상태를 확인하세요.',
  CAMPAIGN_CLOSE_TEMPORARILY_UNAVAILABLE: '쿠폰을 일시적으로 마감할 수 없습니다. 잠시 후 다시 시도하세요.',
  INVALID_STATE_TRANSITION: '현재 상태에서는 요청한 변경을 수행할 수 없습니다.',
  ISSUE_NOT_FOUND: '발급 요청을 찾을 수 없습니다.',
  ISSUE_TEMPORARILY_UNAVAILABLE: '발급 시스템을 일시적으로 사용할 수 없습니다.',
  BACKEND_UNAVAILABLE: '백엔드 서버에 연결할 수 없습니다. Spring 서버가 실행 중인지 확인하세요.',
  NETWORK_ERROR: '백엔드 서버에 연결할 수 없습니다.',
}

function loadWorkspace() {
  try {
    const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!stored) return {}
    const parsed = JSON.parse(stored)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getSavedCouponRounds(workspace) {
  if (workspace.couponRounds && typeof workspace.couponRounds === 'object') {
    return workspace.couponRounds
  }

  const event = workspace.createdEvent
  const couponId = event?.couponId ?? workspace.selectedCouponId
  if (!couponId || !Number.isSafeInteger(Number(event?.round))) return {}
  return { [couponId]: Number(event.round) + 1 }
}

function getSavedCampaigns(workspace) {
  if (Array.isArray(workspace.recentCampaigns)) return workspace.recentCampaigns.slice(0, 6)
  return workspace.operationCampaign ? [workspace.operationCampaign] : []
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
    hour12: false,
  }).format(date)
}

function normalizeCoupons(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.content)) return data.content
  if (Array.isArray(data?.items)) return data.items
  return []
}

function normalizeCampaigns(data) {
  if (!Array.isArray(data)) return []
  return data.filter((campaign) => campaign?.eventId).slice(0, 6)
}

function campaignLabel(campaign) {
  if (!campaign) return '발급 회차를 선택하세요'
  return `${campaign.couponName ?? '쿠폰'}-${campaign.round ?? '-'}회차(${campaign.eventId})`
}

function App() {
  const [initialWorkspace] = useState(loadWorkspace)
  const [hasSavedCoupons] = useState(() => normalizeCoupons(initialWorkspace.coupons).length > 0)
  const [notice, setNotice] = useState(null)
  const [issueRecords, setIssueRecords] = useState(loadRecords)
  const [coupons, setCoupons] = useState(() => normalizeCoupons(initialWorkspace.coupons))
  const [couponSearch, setCouponSearch] = useState('')
  const [selectedCouponId, setSelectedCouponId] = useState(() => String(initialWorkspace.selectedCouponId ?? ''))
  const [selectedCouponSnapshot, setSelectedCouponSnapshot] = useState(() => {
    const selectedId = String(initialWorkspace.selectedCouponId ?? '')
    return initialWorkspace.selectedCouponSnapshot
      ?? normalizeCoupons(initialWorkspace.coupons).find(
        (coupon) => String(coupon.couponId) === selectedId,
      )
      ?? null
  })
  const [loadingCoupons, setLoadingCoupons] = useState(true)
  const [createdCoupon, setCreatedCoupon] = useState(initialWorkspace.createdCoupon ?? null)
  const [couponRounds, setCouponRounds] = useState(() => getSavedCouponRounds(initialWorkspace))
  const [createdEvent, setCreatedEvent] = useState(initialWorkspace.createdEvent ?? null)
  const [recentCampaigns, setRecentCampaigns] = useState(() => getSavedCampaigns(initialWorkspace))
  const [openCampaigns, setOpenCampaigns] = useState(() => (
    Array.isArray(initialWorkspace.openCampaigns)
      ? initialWorkspace.openCampaigns.slice(0, 5)
      : getSavedCampaigns(initialWorkspace).filter((campaign) => campaign.status === 'OPEN')
  ))
  const [operationCampaign, setOperationCampaign] = useState(initialWorkspace.operationCampaign ?? null)
  const [eventId, setEventId] = useState(() => String(initialWorkspace.operationCampaign?.eventId ?? ''))
  const [loadEventId, setLoadEventId] = useState(() => String(initialWorkspace.operationCampaign?.eventId ?? ''))
  const [activeTab, setActiveTab] = useState(initialWorkspace.activeTab ?? 'campaigns')

  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY))
  const [loadResult, setLoadResult] = useState(INITIAL_LOAD_RESULT)
  const loadAbortRef = useRef(null)

  const selectedLoadCampaign = openCampaigns.find(
    (campaign) => String(campaign.eventId) === String(loadEventId),
  )
  const expectedLoadStock = selectedLoadCampaign?.totalStock ?? 0

  const [previousLoadEventId, setPreviousLoadEventId] = useState(loadEventId)
  if (loadEventId !== previousLoadEventId) {
    setPreviousLoadEventId(loadEventId)
    setLoadResult(INITIAL_LOAD_RESULT)
  }

  useEffect(() => () => loadAbortRef.current?.abort(), [])

  async function handleLoadSimulationSubmit(event) {
    event.preventDefault()
    const parsedEventId = Number(loadEventId)
    const parsedStartUserId = LOAD_USER_ID_START
    const parsedConcurrency = Number(concurrency)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setNotice({ tone: 'danger', message: '부하 발급 쿠폰 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedConcurrency) || parsedConcurrency < 1 || parsedConcurrency > 300) {
      setNotice({ tone: 'danger', message: '동시 요청 수는 1~300 사이여야 합니다.' })
      return
    }
    if (!selectedLoadCampaign || Number(selectedLoadCampaign.eventId) !== parsedEventId) {
      setNotice({
        tone: 'danger',
        message: '최근 발급 회차에서 트래픽을 실행할 쿠폰을 선택하세요.',
      })
      return
    }

    try {
      const stats = await getIssuanceStats(parsedEventId)
      if (stats.status !== 'OPEN') {
        setNotice({ tone: 'danger', message: `OPEN 쿠폰만 실행할 수 있습니다. 현재 상태: ${stats.status}` })
        return
      }
      if (stats.remainingStock !== stats.totalStock) {
        setNotice({
          tone: 'danger',
          message: `현재 잔여 재고가 ${stats.remainingStock.toLocaleString()}장입니다. 정확한 검증을 위해 새 10,000장 쿠폰을 생성하세요.`,
        })
        return
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: apiError.code === 'EVENT_STATS_TEMPORARILY_UNAVAILABLE'
          ? 'Redis에 초기화되지 않은 쿠폰입니다. 새 이벤트를 생성한 뒤 실행하세요.'
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
        tone: counters.accepted > expectedLoadStock ? 'danger' : 'success',
        message:
          counters.accepted > expectedLoadStock
            ? `기대 재고 ${expectedLoadStock.toLocaleString()}장을 초과해 승인되었습니다.`
            : '참여자 20,000명의 선착순 발급 요청을 완료했습니다.',
      })
    }
  }

  function cancelLoadSimulation() {
    loadAbortRef.current?.abort()
  }

  useEffect(() => {
    if (!notice?.toast) return undefined

    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const controller = new AbortController()
    const keyword = couponSearch.trim()

    const timer = window.setTimeout(() => {
      setLoadingCoupons(true)
      getCoupons(keyword, controller.signal)
        .then((data) => {
          const serverCoupons = normalizeCoupons(data)
          setCoupons(serverCoupons)
          setSelectedCouponId((current) => {
            const nextId = current || String(serverCoupons[0]?.couponId ?? '')
            const selectedFromServer = serverCoupons.find(
              (coupon) => String(coupon.couponId) === String(nextId),
            )
            if (selectedFromServer) setSelectedCouponSnapshot(selectedFromServer)
            return nextId
          })
        })
        .catch(() => {
          if (!controller.signal.aborted && !hasSavedCoupons) {
            setNotice({
              tone: 'danger',
              message: '쿠폰 목록을 불러오지 못했습니다. 백엔드 서버 실행 상태를 확인하세요.',
            })
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingCoupons(false)
        })
    }, keyword ? 300 : 0)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [couponSearch, hasSavedCoupons])

  useEffect(() => {
    const controller = new AbortController()
    let refreshTimer = null
    let disposed = false

    function scheduleNextRefresh() {
      if (!disposed) {
        refreshTimer = window.setTimeout(
          refreshCampaigns,
          millisecondsUntilNextCampaignRefresh(),
        )
      }
    }

    async function refreshCampaigns() {
      if (disposed || controller.signal.aborted) return
      if (document.hidden) {
        scheduleNextRefresh()
        return
      }

      try {
        const data = await getRecentCouponEvents(null, controller.signal)
        const campaigns = normalizeCampaigns(data)
        const openEvents = campaigns.filter((campaign) => campaign.status === 'OPEN')
        setRecentCampaigns(campaigns)
        setOpenCampaigns(openEvents)
        if (campaigns.length === 0) {
          setEventId('')
          setLoadEventId('')
          scheduleNextRefresh()
          return
        }

        const preferred = openEvents.find(
          (campaign) => String(campaign.eventId) === String(initialWorkspace.operationCampaign?.eventId),
        ) ?? openEvents[0] ?? campaigns.find(
          (campaign) => String(campaign.eventId) === String(initialWorkspace.operationCampaign?.eventId),
        ) ?? campaigns[0]
        setOperationCampaign((current) => campaigns.find(
          (campaign) => String(campaign.eventId) === String(current?.eventId),
        ) ?? preferred)
        setEventId((current) => campaigns.some(
          (campaign) => String(campaign.eventId) === String(current),
        ) ? current : String(preferred.eventId))
        setLoadEventId((current) => openEvents.some(
          (campaign) => String(campaign.eventId) === String(current),
        ) ? current : String(openEvents[0]?.eventId ?? ''))
        scheduleNextRefresh()
      } catch (error) {
        if (controller.signal.aborted) return
        const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
        setNotice({
          tone: 'danger',
          message: `최근 발급 회차를 불러오지 못했습니다. ${ERROR_LABELS[apiError.code] ?? apiError.message}`,
        })
      }
    }

    refreshCampaigns()

    return () => {
      disposed = true
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      controller.abort()
    }
  }, [initialWorkspace])

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
        coupons,
        selectedCouponId,
        selectedCouponSnapshot,
        createdCoupon,
        couponRounds,
        createdEvent,
        recentCampaigns,
        openCampaigns,
        operationCampaign,
        activeTab,
      }))
    } catch {
      // 브라우저 저장소가 제한돼도 서버 API 기능은 유지한다.
    }
  }, [coupons, selectedCouponId, selectedCouponSnapshot, createdCoupon, couponRounds, createdEvent, recentCampaigns, openCampaigns, operationCampaign, activeTab])

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
            쿠폰 관리
          </button>
          <button
            className={`nav-item ${activeTab === 'integrity' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('integrity')}
          >
            <span className="nav-icon">↗</span>
            정합성 리포트
          </button>
          <button
            className={`nav-item ${activeTab === 'loadtest' ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab('loadtest')}
          >
            <span className="nav-icon">▤</span>
            테스트
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

        {notice && (
          <div className={`notice ${notice.tone} ${notice.toast ? 'notice-toast' : ''}`} role="status">
            <span>{notice.tone === 'danger' ? '!' : '✓'}</span>
            {notice.message}
            <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기">×</button>
          </div>
        )}

        {activeTab === 'campaigns' && (
          <CampaignManagementTab
            coupons={coupons}
            selectedCouponId={selectedCouponId}
            setSelectedCouponId={setSelectedCouponId}
            selectedCouponSnapshot={selectedCouponSnapshot}
            setSelectedCouponSnapshot={setSelectedCouponSnapshot}
            loadingCoupons={loadingCoupons}
            couponSearch={couponSearch}
            setCouponSearch={setCouponSearch}
            createdCoupon={createdCoupon}
            setCreatedCoupon={setCreatedCoupon}
            setCoupons={setCoupons}
            couponRounds={couponRounds}
            setCouponRounds={setCouponRounds}
            createdEvent={createdEvent}
            setCreatedEvent={setCreatedEvent}
            recentCampaigns={recentCampaigns}
            setRecentCampaigns={setRecentCampaigns}
            setOpenCampaigns={setOpenCampaigns}
            setOperationCampaign={setOperationCampaign}
            setEventId={setEventId}
            setLoadEventId={setLoadEventId}
            setActiveTab={setActiveTab}
            setNotice={setNotice}
            campaignLabel={campaignLabel}
            formatDate={formatDate}
            errorLabels={ERROR_LABELS}
          />
        )}

        {activeTab === 'operations' && (
          <OperationsTab
            view="monitor"
            eventId={eventId}
            setEventId={setEventId}
            recentCampaigns={recentCampaigns}
            openCampaigns={openCampaigns}
            operationCampaign={operationCampaign}
            setOperationCampaign={setOperationCampaign}
            setNotice={setNotice}
            campaignLabel={campaignLabel}
            formatDate={formatDate}
            errorLabels={ERROR_LABELS}
          />
        )}

        {activeTab === 'loadtest' && (
          <div className="test-tab-stack">
            <section className="test-section" aria-labelledby="load-test-section-title">
              <div className="test-section-heading">
                <div>
                  <span>01</span>
                  <div>
                    <p>LOAD VERIFICATION</p>
                    <h2 id="load-test-section-title">부하 테스트</h2>
                  </div>
                </div>
                <small>20,000명 동시 요청 · 초과 발급 검증</small>
              </div>
              <LoadTestTab
                loadEventId={loadEventId}
                setLoadEventId={setLoadEventId}
                openCampaigns={openCampaigns}
                campaignLabel={campaignLabel}
                concurrency={concurrency}
                setConcurrency={setConcurrency}
                loadResult={loadResult}
                expectedStock={expectedLoadStock}
                onSubmit={handleLoadSimulationSubmit}
                onCancel={cancelLoadSimulation}
              />
            </section>

            <section className="test-section" aria-labelledby="issue-operation-section-title">
              <div className="test-section-heading">
                <div>
                  <span>02</span>
                  <div>
                    <p>ISSUE OPERATIONS</p>
                    <h2 id="issue-operation-section-title">쿠폰 발급 운영</h2>
                  </div>
                </div>
                <small>쿠폰 발급 · 발급 이력 · 쿠폰 상태 이력</small>
              </div>
              <OperationsTab
                view="issue-operations"
                sharedRecords={issueRecords}
                setSharedRecords={setIssueRecords}
                eventId={eventId}
                setEventId={setEventId}
                recentCampaigns={recentCampaigns}
                openCampaigns={openCampaigns}
                operationCampaign={operationCampaign}
                setOperationCampaign={setOperationCampaign}
                setNotice={setNotice}
                campaignLabel={campaignLabel}
                formatDate={formatDate}
                errorLabels={ERROR_LABELS}
              />
            </section>

            <section className="test-section" aria-labelledby="coupon-state-test-section-title">
              <div className="test-section-heading">
                <div>
                  <span>03</span>
                  <div>
                    <p>COUPON STATE VERIFICATION</p>
                    <h2 id="coupon-state-test-section-title">쿠폰 상태 변경 테스트</h2>
                  </div>
                </div>
                <small>발급 사용자별 저장 상태 확인 · 변경 테스트</small>
              </div>
              <OperationsTab
                view="coupon-control"
                sharedRecords={issueRecords}
                setSharedRecords={setIssueRecords}
                eventId={eventId}
                setEventId={setEventId}
                recentCampaigns={recentCampaigns}
                openCampaigns={openCampaigns}
                operationCampaign={operationCampaign}
                setOperationCampaign={setOperationCampaign}
                setNotice={setNotice}
                campaignLabel={campaignLabel}
                formatDate={formatDate}
                errorLabels={ERROR_LABELS}
              />
            </section>
          </div>
        )}

        {activeTab === 'integrity' && <IntegrityReportTab />}
      </main>
    </div>
  )
}

export default App

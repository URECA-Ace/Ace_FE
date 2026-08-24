import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, getIssuanceStats } from '../api/couponApi'

const POLLING_INTERVAL_MS = 1000

const CAMPAIGN_STATUS = {
  SCHEDULED: {
    label: '발급 대기',
    tone: 'scheduled',
    description: '아직 발급이 시작되지 않은 캠페인입니다.',
  },
  OPEN: {
    label: '발급 진행 중',
    tone: 'open',
    description: '쿠폰 발급이 열려 있으며 재고가 실시간으로 차감되고 있습니다.',
  },
  SOLD_OUT: {
    label: '재고 소진',
    tone: 'sold-out',
    description: '준비된 쿠폰이 모두 배정되어 추가 요청이 거절됩니다.',
  },
  CLOSED: {
    label: '캠페인 종료',
    tone: 'closed',
    description: '캠페인 마감 시각이 지나 발급이 종료되었습니다.',
  },
}

const ERROR_MESSAGES = {
  EVENT_NOT_FOUND: '캠페인을 찾을 수 없습니다.',
  EVENT_STATS_TEMPORARILY_UNAVAILABLE:
    'Redis 발급 현황이 아직 초기화되지 않았거나 일시적으로 조회할 수 없습니다.',
  NETWORK_ERROR: '백엔드 서버에 연결할 수 없습니다.',
}

function formatObservedAt(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 1,
    hour12: false,
  }).format(date)
}

function campaignLabel(campaign) {
  if (!campaign) return '발급 회차를 선택하세요'
  return `${campaign.couponName ?? '쿠폰'}-${campaign.round ?? '-'}회차(${campaign.eventId})`
}

function CampaignMonitor({ selectedEventId, recentCampaigns = [] }) {
  const defaultEventId = recentCampaigns[0]?.eventId ?? selectedEventId
  const [eventId, setEventId] = useState(() => String(defaultEventId ?? ''))
  const [monitoredEventId, setMonitoredEventId] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const pollingControllerRef = useRef(null)
  const pollingIntervalRef = useRef(null)
  const monitoringActiveRef = useRef(false)
  const requestInFlightRef = useRef(false)
  const polling = monitoredEventId !== null
  const effectiveEventId = recentCampaigns.some(
    (campaign) => String(campaign.eventId) === String(eventId),
  ) ? eventId : String(defaultEventId ?? '')

  const readStats = useCallback(async (targetEventId, signal) => {
    setLoading(true)
    try {
      const data = await getIssuanceStats(targetEventId, signal)
      if (signal?.aborted || !monitoringActiveRef.current) return
      setStats(data)
      setError(null)

    } catch (requestError) {
      if (signal?.aborted) return
      const apiError = requestError instanceof ApiError
        ? requestError
        : new ApiError('NETWORK_ERROR')
      setError({
        code: apiError.code,
        message: ERROR_MESSAGES[apiError.code] ?? apiError.message,
        incidentId: apiError.incidentId,
      })
      if (apiError.code === 'EVENT_NOT_FOUND') setMonitoredEventId(null)
    } finally {
      if (!signal?.aborted && monitoringActiveRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!monitoredEventId) return undefined

    const controller = new AbortController()
    monitoringActiveRef.current = true
    pollingControllerRef.current = controller

    async function poll() {
      if (
        document.hidden
        || !monitoringActiveRef.current
        || controller.signal.aborted
        || requestInFlightRef.current
      ) return
      requestInFlightRef.current = true
      try {
        await readStats(monitoredEventId, controller.signal)
      } finally {
        requestInFlightRef.current = false
      }
    }

    poll()
    pollingIntervalRef.current = window.setInterval(poll, POLLING_INTERVAL_MS)

    return () => {
      monitoringActiveRef.current = false
      requestInFlightRef.current = false
      controller.abort()
      if (pollingControllerRef.current === controller) {
        pollingControllerRef.current = null
      }
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
  }, [monitoredEventId, readStats])

  useEffect(() => () => {
    monitoringActiveRef.current = false
    requestInFlightRef.current = false
    pollingControllerRef.current?.abort()
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current)
    }
  }, [])

  function stopMonitoring() {
    monitoringActiveRef.current = false
    requestInFlightRef.current = false
    setMonitoredEventId(null)
    setStats(null)
    setError(null)
    pollingControllerRef.current?.abort()
    pollingControllerRef.current = null
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
    setLoading(false)
  }

  function startMonitoring(event) {
    event.preventDefault()
    const parsedEventId = Number(effectiveEventId)
    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setError({ code: 'INVALID_EVENT_ID', message: '캠페인 ID는 1 이상의 정수여야 합니다.' })
      return
    }

    setStats(null)
    setError(null)
    setMonitoredEventId(parsedEventId)
  }

  const selectedCampaign = recentCampaigns.find(
    (campaign) => String(campaign.eventId) === String(effectiveEventId),
  )
  const visibleStats = polling ? stats : null
  const statusMeta = CAMPAIGN_STATUS[visibleStats?.status] ?? {
    label: '조회 대기',
    tone: 'idle',
    description: '최근 발급 회차를 선택하고 실시간 관제를 시작하세요.',
  }
  const allocationRate = visibleStats?.totalStock > 0
    ? Math.min((visibleStats.allocatedQuantity / visibleStats.totalStock) * 100, 100)
    : 0

  return (
    <section className="panel campaign-monitor" aria-labelledby="campaign-monitor-title">
      <div className="monitor-header">
        <div>
          <span className="monitor-kicker">REAL-TIME CAMPAIGN WATCH</span>
          <h2 id="campaign-monitor-title">실시간 발급 현황 관제</h2>
          <p>Redis 서버 기준 발급 상태와 재고 변화를 1초 간격으로 조회합니다.</p>
        </div>
        <form className="monitor-form" onSubmit={startMonitoring}>
          <label htmlFor="monitor-event-id">관제할 발급 회차</label>
          <div>
            <select
              id="monitor-event-id"
              value={effectiveEventId}
              onChange={(event) => setEventId(event.target.value)}
              disabled={polling}
            >
              {recentCampaigns.length > 0 ? recentCampaigns.map((campaign) => (
                <option key={campaign.eventId} value={campaign.eventId}>
                  {campaignLabel(campaign)}
                </option>
              )) : (
                <option value="">먼저 발급 회차를 생성하세요</option>
              )}
            </select>
            {polling ? (
              <button
                type="button"
                className="monitor-stop"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  stopMonitoring()
                }}
              >
                관제 중지
              </button>
            ) : (
              <button type="submit" className="monitor-start">
                실시간 관제 시작
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="monitor-body">
        <div className={`campaign-state-card ${statusMeta.tone}`}>
          <div className="campaign-state-heading">
            <span className="state-live-dot" />
            <div>
              <small>{polling ? campaignLabel(selectedCampaign) : '관제 중지됨'}</small>
              <strong>{statusMeta.label}</strong>
            </div>
            {polling && <span className="polling-chip">LIVE · 1s</span>}
          </div>
          <p>{statusMeta.description}</p>
          <dl>
            <div>
              <dt>서버 관측 시각</dt>
              <dd>{formatObservedAt(visibleStats?.observedAt)}</dd>
            </div>
            <div>
              <dt>API 상태</dt>
              <dd>{loading ? '조회 중…' : error ? '조회 오류' : visibleStats ? '정상' : '대기'}</dd>
            </div>
          </dl>
        </div>

        <div className="inventory-watch">
          <div className="inventory-heading">
            <div>
              <span>전체 재고</span>
              <strong>{visibleStats?.totalStock?.toLocaleString() ?? '-'}</strong>
            </div>
            <div>
              <span>배정 수량</span>
              <strong>{visibleStats?.allocatedQuantity?.toLocaleString() ?? '-'}</strong>
            </div>
            <div className="remaining">
              <span>남은 재고</span>
              <strong>{visibleStats?.remainingStock?.toLocaleString() ?? '-'}</strong>
            </div>
          </div>
          <div className="inventory-progress-heading">
            <span>발급 배정률</span>
            <strong>{allocationRate.toFixed(1)}%</strong>
          </div>
          <div className="inventory-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={allocationRate}>
            <span style={{ width: `${allocationRate}%` }} />
          </div>
          <p>배정 수량은 Redis 재고 차감 기준이며 MySQL 최종 저장 건수와 구분됩니다.</p>
        </div>

      </div>

      {error && (
        <div className="monitor-error" role="alert">
          <strong>{error.code}</strong>
          <span>{error.message}</span>
          {error.incidentId && <small>Incident ID: {error.incidentId}</small>}
        </div>
      )}
    </section>
  )
}

export default CampaignMonitor

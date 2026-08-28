import { useEffect, useState } from 'react'
import { ApiError, getIssueStatus, getIssuanceStats, issueCoupon, useCoupon as requestCouponUse, cancelCoupon, getCouponIssueId, expireCoupon as requestCouponExpire } from '../api/couponApi'
import CampaignMonitor from '../components/CampaignMonitor'
import GrafanaMetricCard from '../components/GrafanaMetricCard'
import { loadRecords, saveRecords } from '../utils/issueRecords'

const PENDING_STATUSES = new Set(['ACCEPTED', 'PROCESSING'])

const STATUS_META = {
  ACCEPTED: { label: '발급 승인', tone: 'waiting' },
  PROCESSING: { label: '저장 처리 중', tone: 'waiting' },
  ISSUED: { label: '발급 완료', tone: 'success' },
  USED: { label: '사용 완료', tone: 'neutral' },
  EXPIRED: { label: '기간 만료', tone: 'danger' },
  FAILED: { label: '저장 실패', tone: 'danger' },
  COMPENSATED: { label: '재고 원복', tone: 'neutral' },
  REJECTED_SOLD_OUT: { label: '재고 소진', tone: 'danger' },
  REJECTED_DUPLICATE: { label: '중복 발급', tone: 'danger' },
  REJECTED_NOT_OPEN: { label: '오픈 전', tone: 'neutral' },
  REJECTED_CLOSED: { label: '마감', tone: 'neutral' },
  REQUEST_FAILED: { label: '요청 실패', tone: 'danger' },
}

function statusMeta(status) {
  return STATUS_META[status] ?? { label: status || '대기', tone: 'neutral' }
}

const ISSUE_RESULT_OPTIONS = [
  { value: 'success', label: '성공' },
  { value: 'fail', label: '실패' },
]

// coupon.issue 실패 시 reason 태그 값(ErrorCode 이름)과 매칭
const ISSUE_REASON_OPTIONS = [
  { value: 'SOLD_OUT', label: '재고 소진' },
  { value: 'ALREADY_ISSUED', label: '중복 발급' },
  { value: 'EVENT_NOT_OPEN', label: '오픈 전' },
  { value: 'EVENT_CLOSED', label: '마감' },
  { value: 'IDEMPOTENCY_CONFLICT', label: '키 충돌' },
  { value: 'ISSUE_PERSIST_FAILED', label: '저장 오류' },
  { value: 'ISSUE_TEMPORARILY_UNAVAILABLE', label: '일시 불가' },
  { value: 'EVENT_NOT_FOUND', label: '캠페인 없음' },
]

// coupon.issue.relay 실패 시 reason 태그 값(IssueStreamRelay 문자열 리터럴)과 매칭
const RELAY_REASON_OPTIONS = [
  { value: 'CONFIRM_ABANDONED', label: '확정 유실' },
  { value: 'PERSIST_ABANDONED', label: '저장 유실' },
]

// coupon.state.change 실패 시 reason 태그 값(ErrorCode 이름)과 매칭
const STATE_CHANGE_REASON_OPTIONS = [
  { value: 'ISSUE_NOT_FOUND', label: '발급 내역 없음' },
  { value: 'INVALID_REQUEST', label: '잘못된 요청' },
  { value: 'EVENT_NOT_OPEN', label: '오픈 전' },
  { value: 'ALREADY_EXPIRED', label: '만료됨' },
  { value: 'ALREADY_USED', label: '이미 사용' },
  { value: 'NOT_YET_USED', label: '미사용' },
  { value: 'INVALID_STATE_TRANSITION', label: '상태 전이 불가' },
]

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
  const previousStatus = record.status
  const nextStatus = data.status

  if ((previousStatus === 'USED' || previousStatus === 'EXPIRED') && nextStatus === 'ISSUED') {
    return { ...record, lastCheckedAt: new Date().toISOString() }
  }

  const hasChanged = previousStatus !== nextStatus
  const meta = statusMeta(nextStatus)

  return {
    ...record,
    ...data,
    lastCheckedAt: new Date().toISOString(),
    events: hasChanged
      ? [
          eventItem(
            source,
            meta.label,
            `처리 상태가 ${nextStatus}(으)로 변경되었습니다.`,
            meta.tone,
          ),
          ...record.events,
        ]
      : record.events,
  }
}

function OperationsTab({
  view = 'operations',
  sharedRecords,
  setSharedRecords,
  eventId,
  setEventId,
  recentCampaigns,
  operationCampaign,
  setOperationCampaign,
  setNotice,
  campaignLabel,
  formatDate,
  errorLabels,
}) {
  const [localRecords, setLocalRecords] = useState(loadRecords)
  const records = sharedRecords ?? localRecords
  const updateRecords = setSharedRecords ?? setLocalRecords
  const [selectedId, setSelectedId] = useState(() => loadRecords()[0]?.id ?? null)
  const [userId, setUserId] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [issueCampaignPickerOpen, setIssueCampaignPickerOpen] = useState(false)
  const [historyScope, setHistoryScope] = useState('current')
  const [userSearch, setUserSearch] = useState('')
  const [monitorStats, setMonitorStats] = useState(null)
  const [expireConfirmRecord, setExpireConfirmRecord] = useState(null)

  const selected = records.find((record) => record.id === selectedId) ?? records[0]
  const selectedIssueCampaign = recentCampaigns.find(
    (campaign) => String(campaign.eventId) === String(eventId),
  )
  const selectedPendingId = selected?.requestId && (
    PENDING_STATUSES.has(selected.status) || selected.maskedUserName === undefined
  )
    ? selected.id
    : null
  const selectedPendingEventId = selectedPendingId ? selected.eventId : null
  const selectedPendingRequestId = selectedPendingId ? selected.requestId : null
  const currentCampaignRecords = records.filter(
    (record) => String(record.eventId) === String(selectedIssueCampaign?.eventId),
  )
  const visibleHistoryRecords = historyScope === 'current'
    ? currentCampaignRecords
    : records
  const statusHistoryRecords = [...currentCampaignRecords]
    .filter((record) => (
      Number.isSafeInteger(Number(record.issueSequence))
      || record.status === 'REJECTED_DUPLICATE'
    ))
    .sort((left, right) => (
      new Date(right.acceptedAt ?? right.lastCheckedAt).getTime()
      - new Date(left.acceptedAt ?? left.lastCheckedAt).getTime()
    ))
  const campaignHasStarted = selectedIssueCampaign
    && selectedIssueCampaign.status !== 'SCHEDULED'
  const campaignHasClosed = selectedIssueCampaign?.status === 'CLOSED'

  function recordCampaignLabel(record, campaigns) {
    const campaign = campaigns.find(
      (item) => String(item.eventId) === String(record.eventId),
    )
    return campaignLabel({
      eventId: record.eventId,
      couponName: record.couponName ?? campaign?.couponName,
      round: record.campaignRound ?? campaign?.round,
    })
  }

  const visibleUserRecords = userSearch.trim()
    ? records.filter((record) => record.status !== 'REJECTED_DUPLICATE' && (
        String(record.userId).includes(userSearch.trim())
        || recordCampaignLabel(record, recentCampaigns).toLowerCase()
          .includes(userSearch.trim().toLowerCase())
      ))
    : records.filter((record) => record.status !== 'REJECTED_DUPLICATE')

  useEffect(() => {
    if (!issueCampaignPickerOpen) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') setIssueCampaignPickerOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [issueCampaignPickerOpen])

  useEffect(() => {
    try {
      saveRecords(records)
    } catch {
      // 저장 공간이 제한된 환경에서도 API 시연 기능은 계속 동작한다.
    }
  }, [records])

  useEffect(() => {
    if (!selectedPendingId || !selectedPendingEventId || !selectedPendingRequestId) {
      return undefined
    }

    const controller = new AbortController()
    let requestInFlight = false

    async function refreshPendingStatus() {
      if (document.hidden || requestInFlight || controller.signal.aborted) return
      requestInFlight = true
      try {
        const data = await getIssueStatus(
          selectedPendingEventId,
          selectedPendingRequestId,
          controller.signal,
        )
        updateRecords((current) =>
          current.map((item) =>
            item.id === selectedPendingId ? mergeStatus(item, data) : item,
          ),
        )
      } catch {
        // 선택한 요청의 자동 조회 실패는 기존 판정 결과를 유지하고 수동 새로고침에 맡긴다.
      } finally {
        requestInFlight = false
      }
    }

    refreshPendingStatus()
    const timer = window.setInterval(refreshPendingStatus, 3000)

    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [selectedPendingEventId, selectedPendingId, selectedPendingRequestId, updateRecords])

  async function requestIssue({ retryRecord } = {}) {
    const parsedEventId = Number(retryRecord?.eventId ?? eventId)
    const parsedUserId = Number(retryRecord?.userId ?? userId)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setNotice({ tone: 'danger', message: '선택한 발급 회차가 올바르지 않습니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
      setNotice({ tone: 'danger', message: '사용자 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    const targetCampaign = recentCampaigns.find(
      (campaign) => Number(campaign.eventId) === parsedEventId,
    )
    if (!targetCampaign) {
      setNotice({
        tone: 'danger',
        message: '최근 발급 회차에서 쿠폰을 발급할 쿠폰을 선택하세요.',
      })
      return
    }

    try {
      const stats = await getIssuanceStats(parsedEventId)
      if (stats.status !== 'OPEN') {
        setNotice({
          tone: 'danger',
          message: `선택한 쿠폰은 현재 ${stats.status} 상태입니다. OPEN 쿠폰만 발급할 수 있습니다.`,
        })
        return
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: apiError.code === 'EVENT_STATS_TEMPORARILY_UNAVAILABLE'
          ? 'Redis에 초기화되지 않은 쿠폰입니다. 쿠폰 관리에서 새 이벤트를 생성하세요.'
          : errorLabels[apiError.code] ?? apiError.message,
      })
      return
    }

    const recordId = retryRecord?.id ?? `${parsedEventId}:${parsedUserId}:${crypto.randomUUID()}`
    const previousUserRecord = records.find((record) => (
      String(record.eventId) === String(parsedEventId)
      && String(record.userId) === String(parsedUserId)
      && record.status !== 'REJECTED_DUPLICATE'
    ))
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
    updateRecords((current) => {
      const previous = retryRecord ?? current.find((record) => record.id === recordId)
      const next = {
        id: recordId,
        eventId: parsedEventId,
        couponName: retryRecord?.couponName ?? targetCampaign.couponName,
        campaignRound: retryRecord?.campaignRound ?? targetCampaign.round,
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
      updateRecords((current) =>
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
      setNotice({ tone: 'success', message: '사용자의 발급 요청이 승인되었습니다.' })
      if (!retryRecord) setUserId('')
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      const isDuplicate = apiError.code === 'ALREADY_ISSUED'
      const message = isDuplicate ? '이미 발급된 사용자입니다. 중복 발급이 차단되었습니다.' : (errorLabels[apiError.code] ?? apiError.message)
      updateRecords((current) =>
        current.map((record) =>
          record.id === recordId
            ? {
                ...record,
                status: isDuplicate ? 'REJECTED_DUPLICATE' : 'REQUEST_FAILED',
                error: { code: apiError.code, message, incidentId: apiError.incidentId },
                lastCheckedAt: new Date().toISOString(),
                events: [
                  eventItem(isDuplicate ? 'DUPLICATE' : 'ERROR', isDuplicate ? '중복 발급 차단' : apiError.code, message, 'danger'),
                  ...record.events,
                ],
              }
            : record,
        ),
      )
      if (isDuplicate && previousUserRecord) setSelectedId(previousUserRecord.id)
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
      updateRecords((current) =>
        current.map((record) =>
          record.id === selected.id ? mergeStatus(record, data, 'REFRESH') : record,
        ),
      )
      setNotice({ tone: 'success', message: '최신 처리 상태를 확인했습니다.' })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: errorLabels[apiError.code] ?? apiError.message,
      })
    }
  }

  function clearRecords() {
    updateRecords([])
    setSelectedId(null)
    setNotice({ tone: 'neutral', message: '브라우저에 저장된 시연 기록을 비웠습니다.' })
  }

  async function handleUseCoupon() {
    if (!selected) return
    setSubmitting(true)
    setNotice(null)
    try {
      let realIssueId = selected.issueId
      if (!realIssueId && selected.eventId && selected.userId) {
        const lookup = await getCouponIssueId(selected.eventId, selected.userId)
        realIssueId = lookup.issueId
      }
      if (!realIssueId) {
        setNotice({ tone: 'danger', message: 'DB에 저장된 쿠폰 정보를 찾을 수 없습니다.' })
        return
      }

      const idempotencyKey = crypto.randomUUID()
      const data = await requestCouponUse(realIssueId, selected.userId, idempotencyKey, 'PAYMENT_USED')
      updateRecords((current) =>
        current.map((record) =>
          record.id === selected.id
            ? {
                ...record,
                issueId: realIssueId,
                status: data.currentStatus,
                lastCheckedAt: new Date().toISOString(),
                events: [
                  eventItem('STATE_CHANGE', '쿠폰 사용 완료', '쿠폰 사용 처리가 완료되었습니다.', 'success'),
                  ...record.events,
                ],
              }
            : record,
        ),
      )
      setNotice({ tone: 'success', message: '쿠폰 사용 처리가 완료되었습니다.' })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      const isExpired = apiError.code === 'ALREADY_EXPIRED' || apiError.code === 'COUPON_EXPIRED' || (apiError.message && apiError.message.includes('만료'))
      if (isExpired) {
        updateRecords((current) =>
          current.map((record) =>
            record.id === selected.id
              ? {
                  ...record,
                  status: 'EXPIRED',
                  lastCheckedAt: new Date().toISOString(),
                  events: [
                    eventItem('EXPIRED', '쿠폰 만료 확인', '유효기간이 만료되어 사용이 불가합니다.', 'danger'),
                    ...record.events,
                  ],
                }
              : record,
          ),
        )
      }
      setNotice({ tone: 'danger', message: errorLabels[apiError.code] ?? apiError.message })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancelCoupon() {
    if (!selected) return
    setSubmitting(true)
    setNotice(null)
    try {
      let realIssueId = selected.issueId
      if (!realIssueId && selected.eventId && selected.userId) {
        const lookup = await getCouponIssueId(selected.eventId, selected.userId)
        realIssueId = lookup.issueId
      }
      if (!realIssueId) {
        setNotice({ tone: 'danger', message: 'DB에 저장된 쿠폰 정보를 찾을 수 없습니다.' })
        return
      }

      const idempotencyKey = crypto.randomUUID()
      const data = await cancelCoupon(realIssueId, selected.userId, idempotencyKey, 'ORDER_CANCELED')
      updateRecords((current) =>
        current.map((record) =>
          record.id === selected.id
            ? {
                ...record,
                issueId: realIssueId,
                status: data.currentStatus,
                lastCheckedAt: new Date().toISOString(),
                events: [
                  eventItem('STATE_CHANGE', '쿠폰 사용 취소', '쿠폰 사용이 취소되어 정상 발급 상태로 원복되었습니다.', 'waiting'),
                  ...record.events,
                ],
              }
            : record,
        ),
      )
      setNotice({ tone: 'success', message: '쿠폰 사용 취소(재사용 원복)가 완료되었습니다.' })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      const isExpired = apiError.code === 'ALREADY_EXPIRED' || apiError.code === 'COUPON_EXPIRED' || (apiError.message && apiError.message.includes('만료'))
      if (isExpired) {
        updateRecords((current) =>
          current.map((record) =>
            record.id === selected.id
              ? {
                  ...record,
                  status: 'EXPIRED',
                  lastCheckedAt: new Date().toISOString(),
                  events: [
                    eventItem('EXPIRED', '쿠폰 만료 확인', '유효기간이 만료된 쿠폰입니다.', 'danger'),
                    ...record.events,
                  ],
                }
              : record,
          ),
        )
      }
      setNotice({ tone: 'danger', message: errorLabels[apiError.code] ?? apiError.message })
    } finally {
      setSubmitting(false)
    }
  }

  function handleExpireCoupon() {
    if (!selected) return
    setExpireConfirmRecord(selected)
  }

  async function executeExpireCoupon(targetRecord) {
    if (!targetRecord) return
    setSubmitting(true)
    setNotice(null)
    try {
      let realIssueId = targetRecord.issueId
      if (!realIssueId && targetRecord.eventId && targetRecord.userId) {
        const lookup = await getCouponIssueId(targetRecord.eventId, targetRecord.userId)
        realIssueId = lookup.issueId
      }
      if (!realIssueId) {
        setNotice({ tone: 'danger', message: 'DB에 저장된 쿠폰 정보를 찾을 수 없습니다.' })
        return
      }

      const idempotencyKey = crypto.randomUUID()
      const data = await requestCouponExpire(realIssueId, targetRecord.userId, idempotencyKey, 'MANUAL_EXPIRED')

      updateRecords((current) =>
        current.map((record) =>
          record.id === targetRecord.id
            ? {
                ...record,
                issueId: realIssueId,
                status: data.currentStatus,
                lastCheckedAt: new Date().toISOString(),
                events: [
                  eventItem('EXPIRED', '쿠폰 수동 만료', '수동 만료 처리가 완료되었습니다.', 'danger'),
                  ...record.events,
                ],
              }
            : record,
        ),
      )
      setNotice({ tone: 'success', message: '쿠폰이 만료 처리되었습니다.' })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({ tone: 'danger', message: errorLabels[apiError.code] ?? apiError.message })
    } finally {
      setSubmitting(false)
      setExpireConfirmRecord(null)
    }
  }

  const selectedMeta = statusMeta(selected?.status)

  const userControlPanel = (
    <>
      <article className="panel user-panel coupon-control-test-panel">
        <div className="panel-heading">
          <div>
            <span className="section-number">01</span>
            <h2>사용자 쿠폰 제어</h2>
          </div>
        </div>

        {records.length > 0 ? (
          <>
            <div className="user-control-layout">
              <section className="user-directory" aria-labelledby="recent-user-list-title">
                <div className="user-directory-heading">
                  <div>
                    <span>RECENT ISSUANCE</span>
                    <h3 id="recent-user-list-title">최근 발급 사용자</h3>
                  </div>
                  <small>{userSearch.trim() ? `${visibleUserRecords.length}명 검색됨` : `전체 ${records.length}명 · 최신순`}</small>
                </div>
                <label className="user-search-field" htmlFor="coupon-user-search">
                  사용자 검색
                  <input
                    id="coupon-user-search"
                    type="search"
                    value={userSearch}
                    onChange={(event) => setUserSearch(event.target.value)}
                    placeholder="사용자 ID 또는 발급 회차"
                  />
                </label>
                {visibleUserRecords.length > 0 ? (
                  <div className="user-tabs" role="list" aria-label="발급 사용자 목록">
                    {visibleUserRecords.map((record) => (
                      <button
                        key={record.id}
                        type="button"
                        role="listitem"
                        aria-pressed={record.id === selected?.id}
                        className={record.id === selected?.id ? 'selected' : ''}
                        onClick={() => setSelectedId(record.id)}
                      >
                        <span className="user-list-avatar">{String(record.userId).slice(-2)}</span>
                        <span className="user-list-copy">
                          <strong>사용자 #{record.userId}</strong>
                          <small>{recordCampaignLabel(record, recentCampaigns)}</small>
                        </span>
                        <span className={`status-badge compact ${statusMeta(record.status).tone}`}>
                          {statusMeta(record.status).label}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="user-search-empty">검색 결과가 없습니다.</div>
                )}
              </section>

              {visibleUserRecords.length > 0 && selected && (
                <aside className="user-detail-panel" aria-labelledby="selected-user-title">
                  <div className="user-detail-heading">
                    <div className="user-identity">
                      <span className="user-avatar">{String(selected.userId).slice(-2)}</span>
                      <div>
                        <span className="user-detail-kicker">SELECTED USER</span>
                        <strong id="selected-user-title">사용자 #{selected.userId}</strong>
                        <small>{recordCampaignLabel(selected, recentCampaigns)}</small>
                      </div>
                    </div>
                    <span className={`status-badge ${selectedMeta.tone}`}>{selectedMeta.label}</span>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={refreshSelected}
                    disabled={!selected.requestId}
                  >
                    상태 새로고침
                  </button>

                  {records.some((record) => (
                    String(record.eventId) === String(selected.eventId)
                    && String(record.userId) === String(selected.userId)
                    && record.status === 'REJECTED_DUPLICATE'
                  )) && (
                    <div className="duplicate-notice" role="status">
                      <strong>중복 발급 요청이 있었습니다.</strong>
                      <span>이미 발급된 사용자라 추가 발급은 차단되었습니다.</span>
                    </div>
                  )}

                  <dl className="user-profile-grid" aria-label="마스킹된 사용자 정보">
                    <div>
                      <dt>이름</dt>
                      <dd>{selected.maskedUserName ?? '-'}</dd>
                    </div>
                    <div>
                      <dt>이메일</dt>
                      <dd title={selected.maskedUserEmail}>{selected.maskedUserEmail ?? '-'}</dd>
                    </div>
                    <div>
                      <dt>휴대폰 번호</dt>
                      <dd>{selected.maskedUserPhone ?? '-'}</dd>
                    </div>
                  </dl>

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
                <strong>쿠폰 상태 제어</strong>
              </div>

              {selected.events && selected.events.length > 0 && (
                <ol className="timeline" style={{ margin: '16px 0', padding: 0 }}>
                  {selected.events.filter(e => e.type === 'STATE_CHANGE' || e.type === 'EXPIRED').map((ev) => (
                    <li key={ev.id} className={ev.tone}>
                      <span className="timeline-dot" />
                      <div>
                        <div className="timeline-title">
                          <strong>{ev.title}</strong>
                          <time>{formatDate(ev.occurredAt)}</time>
                        </div>
                        <p>{ev.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <div className="action-buttons">
                <button
                  type="button"
                  onClick={handleUseCoupon}
                  disabled={submitting || selected?.status !== 'ISSUED'}
                  title="쿠폰을 사용 완료 상태로 변경합니다."
                >
                  사용 처리
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={handleCancelCoupon}
                  disabled={submitting || selected?.status !== 'USED'}
                  title="사용된 쿠폰을 다시 발급 완료 상태로 원복합니다."
                >
                  사용 취소
                </button>
                <button
                  type="button"
                  className={`expired-btn ${selected?.status === 'EXPIRED' ? 'active' : ''}`}
                  onClick={handleExpireCoupon}
                  disabled={submitting || selected?.status === 'EXPIRED'}
                  title={selected?.status === 'EXPIRED' ? '유효기간이 만료된 쿠폰입니다.' : '쿠폰을 즉시 만료 상태로 전환합니다.'}
                >
                  {selected?.status === 'EXPIRED' ? '기간 만료' : '수동 만료'}
                </button>
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
                </aside>
              )}
              </div>
          </>
        ) : (
          <div className="empty-state">
            <span>＋</span>
            <strong>아직 발급 요청이 없습니다</strong>
            <p>발급 운영에서 사용자 쿠폰을 발급한 뒤 상태 변경 테스트를 진행하세요.</p>
          </div>
        )}
      </article>

      {expireConfirmRecord && (
        <div
          className="coupon-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !submitting) setExpireConfirmRecord(null)
          }}
        >
          <section className="close-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="expire-confirm-title">
            <h2 id="expire-confirm-title">쿠폰을 만료 처리할까요?</h2>
            <div className="close-confirm-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => executeExpireCoupon(expireConfirmRecord)}
                disabled={submitting}
              >
                {submitting ? '만료 중…' : '만료'}
              </button>
              <button
                type="button"
                className="coupon-picker-cancel"
                onClick={() => setExpireConfirmRecord(null)}
                disabled={submitting}
              >
                취소
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )

  if (view === 'coupon-control') {
    return userControlPanel
  }

  if (view === 'monitor') {
    return (
      <>
        <section className="summary-grid" aria-label="발급 현황 요약">
          <article className="summary-card accent-card stock-card">
            <div>
              <span>최근 확인 잔여 수량</span>
              <strong>{monitorStats?.remainingStock?.toLocaleString() ?? '-'}</strong>
            </div>
          </article>
          <article className="summary-card approval-card">
            <span>발급 판정 승인</span>
            <strong>{monitorStats?.allocatedQuantity?.toLocaleString() ?? '-'}</strong>
          </article>
          <article className="summary-card processing-card">
            <span>처리 중</span>
            <strong>{monitorStats?.pendingQuantity?.toLocaleString() ?? '-'}</strong>
          </article>
          <article className="summary-card confirmed-card">
            <span>DB 발급 확정</span>
            <strong>{monitorStats?.confirmedQuantity?.toLocaleString() ?? '-'}</strong>
          </article>
        </section>
        <CampaignMonitor
          selectedEventId={operationCampaign?.eventId}
          recentCampaigns={recentCampaigns}
          onStatsChange={setMonitorStats}
        />
        <div className="metric-card-grid">
          <GrafanaMetricCard
            title="쿠폰 발급 현황"
            description="발급 판정(coupon.issue)과 비동기 저장 확정(coupon.issue.relay) 단계별 성공/실패 추이입니다."
            panelId={1}
            variables={{ event_id: operationCampaign?.eventId }}
            filterGroups={[
              { name: 'result_issue', label: '발급 판정', options: ISSUE_RESULT_OPTIONS },
              { name: 'result_relay', label: '비동기 저장 확정', options: ISSUE_RESULT_OPTIONS },
            ]}
          />
          <GrafanaMetricCard
            title="쿠폰 발급 실패 사유별"
            description="발급 판정/비동기 저장 단계에서 발생한 실패를 사유(reason)별로 집계합니다."
            panelId={2}
            variables={{ event_id: operationCampaign?.eventId }}
            filterGroups={[
              { name: 'reason_issue', label: '발급 판정 실패 사유', options: ISSUE_REASON_OPTIONS },
              { name: 'reason_relay', label: '비동기 저장 실패 사유', options: RELAY_REASON_OPTIONS },
            ]}
          />
          <GrafanaMetricCard
            title="쿠폰 상태 변경 현황"
            description="상태 전이(from → to)별 성공 건수 추이입니다."
            panelId={3}
          />
          <GrafanaMetricCard
            title="쿠폰 상태 변경 실패 사유별"
            description="상태 변경 실패를 사유(reason)별로 집계합니다."
            panelId={4}
            filterGroups={[
              { name: 'reason_state', label: '실패 사유', options: STATE_CHANGE_REASON_OPTIONS },
            ]}
          />
        </div>
      </>
    )
  }

  return (
    <>
      <section className="workspace-grid operations-workspace-grid">
        <article className="panel issue-panel">
          <div className="panel-heading">
            <div>
              <span className="section-number">01</span>
              <h2>쿠폰 발급</h2>
            </div>
          </div>

          <div className="issue-composer">
            <button
              className="coupon-preview coupon-preview-button"
              type="button"
              onClick={() => setIssueCampaignPickerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={issueCampaignPickerOpen}
              aria-label="최근 생성 쿠폰에서 발급할 쿠폰 선택"
              disabled={recentCampaigns.length === 0}
            >
              <div className="coupon-brand">U<sup>+</sup></div>
              <div className="coupon-copy">
                <span>FREEDOM DAY</span>
                <strong>{selectedIssueCampaign?.couponName ?? '데이터 하루 무제한'}</strong>
                <small>{selectedIssueCampaign ? campaignLabel(selectedIssueCampaign) : '최근 발급 회차를 선택하세요'}</small>
              </div>
              <div className="coupon-badge">24H</div>
              <span className="coupon-preview-hint">
                최근 생성 쿠폰 보기
                <span aria-hidden="true">→</span>
              </span>
            </button>

            <div className="issue-request-area">
              <span className="issue-request-kicker">ISSUE REQUEST</span>
              <form
                className="issue-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  requestIssue()
                }}
              >
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
                <button
                  className="primary-button"
                  type="submit"
                  disabled={submitting || selectedIssueCampaign?.status !== 'OPEN'}
                >
                  {submitting ? 'Redis 판정 중…' : '쿠폰 발급 요청'}
                  <span>→</span>
                </button>
              </form>
              <p className="form-help">
                쿠폰 카드를 눌러 최근 생성 목록에서 발급할 쿠폰을 선택하세요.
              </p>
            </div>
          </div>
        </article>

      </section>

      <section className="history-grid">
        <article className="panel history-panel">
          <div className="panel-heading">
            <div>
              <span className="section-number">02</span>
              <h2>발급 이력</h2>
            </div>
            {records.length > 0 && <button className="text-button" type="button" onClick={clearRecords}>기록 비우기</button>}
          </div>
          <div className="history-scope-tabs" role="tablist" aria-label="발급 이력 조회 범위">
            <button
              type="button"
              role="tab"
              aria-selected={historyScope === 'all'}
              className={historyScope === 'all' ? 'selected' : ''}
              onClick={() => setHistoryScope('all')}
            >
              전체
              <span>{records.length.toLocaleString()}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={historyScope === 'current'}
              className={historyScope === 'current' ? 'selected' : ''}
              onClick={() => setHistoryScope('current')}
            >
              현재 쿠폰
              <span>{currentCampaignRecords.length.toLocaleString()}</span>
            </button>
          </div>
          <div className="table-wrap history-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>사용자 ID</th>
                  <th>쿠폰</th>
                  <th>순번</th>
                  <th>상태</th>
                  <th>요청 시각</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistoryRecords.length > 0 ? visibleHistoryRecords.map((record) => {
                  const meta = statusMeta(record.status)
                  return (
                    <tr key={record.id} onClick={() => setSelectedId(record.id)}>
                      <td><strong>{record.userId}</strong></td>
                      <td>{recordCampaignLabel(record, recentCampaigns)}</td>
                      <td>{record.issueSequence ?? '-'}</td>
                      <td><span className={`status-badge compact ${meta.tone}`}>{meta.label}</span></td>
                      <td>{formatDate(record.acceptedAt ?? record.lastCheckedAt)}</td>
                    </tr>
                  )
                }) : (
                  <tr>
                    <td colSpan="5" className="table-empty">
                      {historyScope === 'current'
                        ? '현재 쿠폰의 API 응답 이력이 없습니다.'
                        : 'API 응답 이력이 없습니다.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="data-note">현재 화면에서 발생한 실제 API 응답만 브라우저에 보관합니다.</p>
        </article>

        <article className="panel timeline-panel">
          <div className="panel-heading">
            <div>
              <span className="section-number">03</span>
              <h2>쿠폰 상태 이력</h2>
            </div>
            <span className="api-chip subtle">
              {selectedIssueCampaign ? campaignLabel(selectedIssueCampaign) : '쿠폰 선택 대기'}
            </span>
          </div>
          {statusHistoryRecords.length > 0 || campaignHasStarted || campaignHasClosed ? (
            <ol className="timeline">
              {campaignHasClosed && (
                <li>
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">
                      <strong>쿠폰 회차 마감</strong>
                      <time>{formatDate(selectedIssueCampaign.statusChangedAt ?? selectedIssueCampaign.closeAt)}</time>
                    </div>
                    <p>
                      {campaignLabel(selectedIssueCampaign)} · 예약 마감 또는 관리자 수동 마감으로 쿠폰 발급 종료
                    </p>
                  </div>
                </li>
              )}
              {statusHistoryRecords.map((record) => record.status === 'REJECTED_DUPLICATE' ? (
                <li key={`${record.id}:duplicate`} className="danger">
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">
                      <strong>중복 발급 차단</strong>
                      <time>{formatDate(record.lastCheckedAt)}</time>
                    </div>
                    <p>이미 발급 완료된 사용자에게 중복 발급 요청이 있었습니다.</p>
                  </div>
                </li>
              ) : (
                <li key={`${record.id}:${record.issueSequence}`} className="success">
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">
                      <strong>Redis 판정 승인 · 발급 순번 {record.issueSequence}</strong>
                      <time>{formatDate(record.acceptedAt ?? record.lastCheckedAt)}</time>
                    </div>
                    <p>
                      사용자 ID({record.userId}) · 잔여 {record.remainingStock?.toLocaleString() ?? '-'}장
                    </p>
                  </div>
                </li>
              ))}
              {campaignHasStarted && (
                <li className="waiting">
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">
                      <strong>쿠폰 회차 발급 시작</strong>
                      <time>{formatDate(selectedIssueCampaign.openAt)}</time>
                    </div>
                    <p>
                      {campaignLabel(selectedIssueCampaign)} · 쿠폰 초기 재고 {selectedIssueCampaign.totalStock?.toLocaleString() ?? '-'}장
                    </p>
                  </div>
                </li>
              )}
            </ol>
          ) : (
            <div className="empty-state small">
              <strong>표시할 상태 변경이 없습니다</strong>
              <p>현재 쿠폰의 Redis 발급 판정 승인이 발급 순번순으로 표시됩니다.</p>
            </div>
          )}
        </article>
      </section>

      {issueCampaignPickerOpen && (
        <div
          className="coupon-picker-backdrop"
          role="presentation"
          onMouseDown={(clickEvent) => {
            if (clickEvent.target === clickEvent.currentTarget) setIssueCampaignPickerOpen(false)
          }}
        >
          <section className="coupon-picker-modal" role="dialog" aria-modal="true" aria-labelledby="issue-campaign-picker-title">
            <div className="coupon-picker-header">
              <div>
                <span className="eyebrow">ISSUE COUPON SELECT</span>
                <h2 id="issue-campaign-picker-title">발급할 쿠폰 선택</h2>
                <p>최근 생성된 발급 회차 5개 중 쿠폰을 발급할 회차를 선택하세요.</p>
              </div>
              <button type="button" className="coupon-picker-close" onClick={() => setIssueCampaignPickerOpen(false)} aria-label="발급 쿠폰 선택 창 닫기">×</button>
            </div>
            {recentCampaigns.length > 0 ? (
              <div className="coupon-catalog-list coupon-picker-list">
                {recentCampaigns.map((campaign) => (
                  <button
                    key={campaign.eventId}
                    type="button"
                    className={`coupon-catalog-item ${String(campaign.eventId) === String(eventId) ? 'selected' : ''}`}
                    disabled={campaign.status !== 'OPEN'}
                    onClick={() => {
                      setEventId(String(campaign.eventId))
                      setOperationCampaign(campaign)
                      setIssueCampaignPickerOpen(false)
                    }}
                  >
                    <span>
                      <strong>{campaignLabel(campaign)}</strong>
                      <small>
                        {campaign.totalStock?.toLocaleString() ?? '-'}장 · {campaign.status ?? '상태 확인 필요'}
                        {campaign.status === 'SCHEDULED' && ' · 오픈 전 선택 불가'}
                      </small>
                    </span>
                    <span className="catalog-check" aria-hidden="true">{String(campaign.eventId) === String(eventId) ? '✓' : '○'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="catalog-empty">선택할 발급 회차가 없습니다. 먼저 쿠폰을 생성하세요.</p>
            )}
            <button type="button" className="coupon-picker-cancel" onClick={() => setIssueCampaignPickerOpen(false)}>닫기</button>
          </section>
        </div>
      )}
    </>
  )
}

export default OperationsTab

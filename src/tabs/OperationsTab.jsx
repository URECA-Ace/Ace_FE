import { useEffect, useMemo, useState } from 'react'
import { ApiError, getIssueStatus, getIssuanceStats, issueCoupon } from '../api/couponApi'
import CampaignMonitor from '../components/CampaignMonitor'

const STORAGE_KEY = 'ace-manager-issue-records'
const PENDING_STATUSES = new Set(['ACCEPTED', 'PROCESSING'])

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

function loadRecords() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
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

function OperationsTab({
  view = 'operations',
  eventId,
  setEventId,
  recentCampaigns,
  openCampaigns,
  operationCampaign,
  setOperationCampaign,
  setNotice,
  campaignLabel,
  formatDate,
  errorLabels,
}) {
  const [records, setRecords] = useState(loadRecords)
  const [selectedId, setSelectedId] = useState(() => loadRecords()[0]?.id ?? null)
  const [userId, setUserId] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [issueCampaignPickerOpen, setIssueCampaignPickerOpen] = useState(false)
  const [historyScope, setHistoryScope] = useState('current')

  const selected = records.find((record) => record.id === selectedId) ?? records[0]
  const selectedIssueCampaign = recentCampaigns.find(
    (campaign) => String(campaign.eventId) === String(eventId),
  )
  const selectedPendingId = selected?.requestId && PENDING_STATUSES.has(selected.status)
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
  const redisDecisionHistory = [...currentCampaignRecords]
    .filter((record) => Number.isSafeInteger(Number(record.issueSequence)))
    .sort((left, right) => Number(right.issueSequence) - Number(left.issueSequence))
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
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
        setRecords((current) =>
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

    const timer = window.setInterval(refreshPendingStatus, 3000)

    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [selectedPendingEventId, selectedPendingId, selectedPendingRequestId])

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
      setNotice({ tone: 'danger', message: '쿠폰 ID는 1 이상의 정수여야 합니다.' })
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
          message: `쿠폰 ${parsedEventId}번은 현재 ${stats.status} 상태입니다. OPEN 쿠폰만 발급할 수 있습니다.`,
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
      const message = errorLabels[apiError.code] ?? apiError.message
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
        message: errorLabels[apiError.code] ?? apiError.message,
      })
    }
  }

  function clearRecords() {
    setRecords([])
    setSelectedId(null)
    setNotice({ tone: 'neutral', message: '브라우저에 저장된 시연 기록을 비웠습니다.' })
  }

  const selectedMeta = statusMeta(selected?.status)

  const userControlPanel = (
    <article className="panel user-panel coupon-control-test-panel">
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
                <small>{recordCampaignLabel(record, recentCampaigns)}</small>
              </button>
            ))}
          </div>

          <div className="user-summary">
            <div className="user-identity">
              <span className="user-avatar">{String(selected.userId).slice(-2)}</span>
              <div>
                <strong>사용자 #{selected.userId}</strong>
                <small>{recordCampaignLabel(selected, recentCampaigns)}</small>
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
          <p>발급 운영에서 사용자 쿠폰을 발급한 뒤 상태 변경 테스트를 진행하세요.</p>
        </div>
      )}
    </article>
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
              <strong>{summary.latestStock?.toLocaleString() ?? '-'}</strong>
            </div>
          </article>
          <article className="summary-card approval-card">
            <span>발급 판정 승인</span>
            <strong>{summary.accepted.toLocaleString()}</strong>
          </article>
          <article className="summary-card processing-card">
            <span>처리 중</span>
            <strong>{summary.processing.toLocaleString()}</strong>
          </article>
          <article className="summary-card failure-card">
            <span>실패 · 원복</span>
            <strong>{summary.failed.toLocaleString()}</strong>
          </article>
        </section>
        <CampaignMonitor
          selectedEventId={operationCampaign?.eventId}
          recentCampaigns={recentCampaigns}
        />
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

          <button
            className="coupon-preview coupon-preview-button"
            type="button"
            onClick={() => setIssueCampaignPickerOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={issueCampaignPickerOpen}
            disabled={recentCampaigns.length === 0}
          >
            <div className="coupon-brand">U<sup>+</sup></div>
            <div className="coupon-copy">
              <span>FREEDOM DAY</span>
              <strong>{selectedIssueCampaign?.couponName ?? '데이터 하루 무제한'}</strong>
              <small>{selectedIssueCampaign ? campaignLabel(selectedIssueCampaign) : '최근 발급 회차를 선택하세요'}</small>
            </div>
            <div className="coupon-badge">24H</div>
          </button>

          <form
            className="issue-form"
            onSubmit={(event) => {
              event.preventDefault()
              requestIssue()
            }}
          >
            <label>
              쿠폰 ID
              <input
                type="number"
                min="1"
                step="1"
                value={eventId}
                readOnly
                aria-readonly="true"
                placeholder="쿠폰 생성 후 자동 입력"
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
            위 쿠폰 이미지를 눌러 최근 발급 회차를 선택하면 쿠폰 ID가 자동으로 고정됩니다. 새 요청에는 UUID 멱등성 키가 자동으로 생성됩니다.
          </p>
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
                  <th>사용자</th>
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
                      <td><strong>#{record.userId}</strong></td>
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
              <span className="section-number">04</span>
              <h2>쿠폰 상태 이력</h2>
            </div>
            <span className="api-chip subtle">
              {selectedIssueCampaign ? campaignLabel(selectedIssueCampaign) : '쿠폰 선택 대기'}
            </span>
          </div>
          {redisDecisionHistory.length > 0 || campaignHasStarted || campaignHasClosed ? (
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
              {redisDecisionHistory.map((record) => (
                <li key={`${record.id}:${record.issueSequence}`} className="success">
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-title">
                      <strong>Redis 판정 승인 · 발급 순번 {record.issueSequence}</strong>
                      <time>{formatDate(record.acceptedAt ?? record.lastCheckedAt)}</time>
                    </div>
                    <p>
                      사용자({record.userId}) · 발급 순번({record.issueSequence}) · 잔여 {record.remainingStock?.toLocaleString() ?? '-'}장
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

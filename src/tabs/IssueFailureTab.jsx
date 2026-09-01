import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  executeIssueFailureAction,
  getIssueFailureDetail,
  getIssueFailures,
  getIssueFailureSummary,
} from '../api/couponApi'
import './IssueFailureTab.css'

const PAGE_SIZE = 20

const STAGE_LABELS = {
  DB_INSERT: 'DB 저장',
  RELAY: '릴레이 저장',
  COMPENSATE: '재고 원복',
  CONFIRM: '발급 확정',
}

const STATUS_TONES = {
  SETTLED: 'success',
  RETRYABLE: 'waiting',
  UNRECOVERABLE: 'danger',
}

// 서버가 내려주는 조치 결과. 재시도 결과와 종결 시 확인한 저장 상태를 함께 담는다.
const OUTCOME_LABELS = {
  RESOLVED: '재고를 되돌렸습니다.',
  ALREADY_RESOLVED: '이미 회수된 건이었습니다.',
  SKIPPED_PERSISTED: '저장이 확인되어 확정으로 해소했습니다.',
  EXPIRED: '요청 기록이 사라져 되돌릴 수 없습니다.',
  NOT_RETRYABLE: '되돌릴 수 있는 상태가 아닙니다.',
  RETRY_FAILED: '재시도에 실패했습니다. 잠시 후 다시 시도하세요.',
  PERSISTED: '종결했습니다. 종결 시점에 발급 건이 저장되어 있었습니다.',
  ABSENT: '종결했습니다. 종결 시점에 발급 건이 저장되어 있지 않았습니다.',
  UNVERIFIED: '종결했습니다. 저장 여부는 확인하지 못했습니다.',
}

const STATUS_FILTERS = [
  { value: 'UNRECOVERABLE', label: '확인 필요' },
  { value: 'RETRYABLE', label: '자동 재시도 대기' },
  { value: 'SETTLED', label: '종결' },
  { value: '', label: '전체' },
]

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('ko-KR', { hour12: false })
}

function IssueFailureTab() {
  const [summary, setSummary] = useState(null)
  const [failures, setFailures] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [status, setStatus] = useState('UNRECOVERABLE')
  const [stage, setStage] = useState('')
  const [eventId, setEventId] = useState('')
  const [requestId, setRequestId] = useState('')
  const [page, setPage] = useState(0)

  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [actionOutcome, setActionOutcome] = useState(null)
  const [actionRunning, setActionRunning] = useState(false)
  const [reason, setReason] = useState('')
  const [operator, setOperator] = useState('')

  const load = useCallback(async (signal) => {
    setLoading(true)
    setError(null)
    try {
      const [nextSummary, nextFailures] = await Promise.all([
        getIssueFailureSummary(signal),
        getIssueFailures(
          {
            eventId: eventId.trim() || undefined,
            stage: stage || undefined,
            status: status || undefined,
            requestId: requestId.trim() || undefined,
            page,
            size: PAGE_SIZE,
          },
          signal,
        ),
      ])
      setSummary(nextSummary)
      setFailures(nextFailures)
    } catch (caught) {
      if (caught.name === 'AbortError') return
      setError(caught instanceof ApiError ? caught.message : '실패 내역을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [eventId, stage, status, requestId, page])

  useEffect(() => {
    const controller = new AbortController()

    async function refresh() {
      await load(controller.signal)
    }

    refresh()
    return () => controller.abort()
  }, [load])

  const openDetail = async (failureId) => {
    setDetailLoading(true)
    setActionError(null)
    setActionOutcome(null)
    setReason('')
    try {
      setDetail(await getIssueFailureDetail(failureId))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '상세를 불러오지 못했습니다.')
    } finally {
      setDetailLoading(false)
    }
  }

  const runAction = async (action) => {
    if (!detail) return
    if (action === 'RESOLVE' && !reason.trim()) {
      setActionError('종결 사유를 입력하세요.')
      return
    }

    setActionRunning(true)
    setActionError(null)
    setActionOutcome(null)
    try {
      const result = await executeIssueFailureAction(detail.summary.failureId, action, {
        operator: operator.trim() || undefined,
        reason: reason.trim() || undefined,
      })
      setActionOutcome(OUTCOME_LABELS[result.outcome] ?? `조치 결과: ${result.outcome}`)
      setDetail(await getIssueFailureDetail(detail.summary.failureId))
      setReason('')
      await load()
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : '조치를 실행하지 못했습니다.')
    } finally {
      setActionRunning(false)
    }
  }

  const applyFilter = (patch) => {
    setPage(0)
    if ('status' in patch) setStatus(patch.status)
    if ('stage' in patch) setStage(patch.stage)
  }

  const blocked = summary?.blockedEventIds ?? []

  return (
    <section className="panel failure-panel" aria-labelledby="failure-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ISSUE FAILURE · DLQ</span>
          <h2 id="failure-title">발급 실패 관제</h2>
          <p className="panel-description">
            저장·확정에 실패한 발급 건입니다. 자동 재처리가 회수하지 못한 건만 사람이 조치하면 됩니다.
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={() => load()} disabled={loading}>
          {loading ? '불러오는 중' : '새로고침'}
        </button>
      </div>

      {blocked.length > 0 ? (
        <div className="failure-blocked" role="alert">
          <strong>미해소 실패로 막힌 회차 {blocked.length}개</strong>
          <span>{blocked.join(', ')}번 회차가 CLOSED 로 수렴하지 못합니다.</span>
        </div>
      ) : (
        <div className="failure-blocked clear">
          <strong>막힌 회차 없음</strong>
          <span>모든 회차가 정상적으로 마감될 수 있습니다.</span>
        </div>
      )}

      <div className="failure-summary-grid">
        {(summary?.groups ?? []).map((group) => (
          <article key={group.group} className="failure-summary-card">
            <span className="failure-summary-label">{group.label}</span>
            <dl>
              <div className="danger">
                <dt>확인 필요</dt>
                <dd>{group.unrecoverable.toLocaleString()}</dd>
              </div>
              <div className="waiting">
                <dt>자동 재시도 대기</dt>
                <dd>{group.retryable.toLocaleString()}</dd>
              </div>
              <div>
                <dt>종결</dt>
                <dd>{group.settled.toLocaleString()}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <div className="failure-filters">
        <div className="failure-status-tabs" role="tablist" aria-label="상태 필터">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.value || 'all'}
              type="button"
              role="tab"
              aria-selected={status === option.value}
              className={`failure-status-tab ${status === option.value ? 'active' : ''}`}
              onClick={() => applyFilter({ status: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label>
          단계
          <select value={stage} onChange={(event) => applyFilter({ stage: event.target.value })}>
            <option value="">전체</option>
            {Object.entries(STAGE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label>
          회차 ID
          <input
            type="number"
            min="1"
            value={eventId}
            placeholder="전체"
            onChange={(event) => {
              setPage(0)
              setEventId(event.target.value)
            }}
          />
        </label>

        <label>
          요청 ID
          <input
            type="text"
            value={requestId}
            placeholder="입력 시 단독 조회"
            onChange={(event) => {
              setPage(0)
              setRequestId(event.target.value)
            }}
          />
        </label>
      </div>

      {error && <p className="failure-error" role="alert">{error}</p>}

      <div className="failure-table">
        <div className="failure-table-columns" aria-hidden="true">
          <span>발급 순번</span>
          <span>회차</span>
          <span>단계</span>
          <span>상태</span>
          <span>판정</span>
          <span>시도</span>
          <span>마지막 시도</span>
        </div>

        {failures?.content?.length > 0 ? (
          <ol className="failure-table-list">
            {failures.content.map((failure) => (
              <li key={failure.failureId}>
                <button type="button" onClick={() => openDetail(failure.failureId)}>
                  <strong>#{failure.issueSequence?.toLocaleString() ?? '-'}</strong>
                  <span>{failure.eventId}</span>
                  <span>{STAGE_LABELS[failure.stage] ?? failure.stage}</span>
                  <span>
                    <em className={`status-badge compact ${STATUS_TONES[failure.status] ?? 'neutral'}`}>
                      {failure.statusLabel}
                    </em>
                  </span>
                  <span className="failure-result">{failure.compensationResult ?? '-'}</span>
                  <span>{failure.attemptCount}회</span>
                  <time dateTime={failure.lastAttemptAt}>{formatDate(failure.lastAttemptAt)}</time>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="failure-empty">
            {loading ? '불러오는 중입니다.' : '조건에 해당하는 실패 건이 없습니다.'}
          </p>
        )}
      </div>

      {failures && failures.totalPages > 1 && (
        <div className="failure-pagination">
          <button type="button" onClick={() => setPage((prev) => Math.max(prev - 1, 0))} disabled={page === 0}>
            이전
          </button>
          <span>{page + 1} / {failures.totalPages}</span>
          <button type="button" onClick={() => setPage((prev) => prev + 1)} disabled={!failures.hasNext}>
            다음
          </button>
        </div>
      )}

      {detail && (
        <div
          className="coupon-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetail(null)
          }}
        >
          <section
            className="coupon-picker-modal failure-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="failure-detail-title"
          >
            <div className="coupon-picker-header">
              <div>
                <span className="eyebrow">FAILURE DETAIL</span>
                <h2 id="failure-detail-title">
                  #{detail.summary.issueSequence ?? '-'} · {STAGE_LABELS[detail.summary.stage] ?? detail.summary.stage}
                </h2>
                <p>
                  회차 {detail.summary.eventId} · {detail.summary.statusLabel} · 시도 {detail.summary.attemptCount}회
                </p>
              </div>
              <button type="button" className="coupon-picker-close" onClick={() => setDetail(null)} aria-label="상세 닫기">
                ×
              </button>
            </div>

            {detailLoading ? (
              <p className="catalog-empty">상세를 불러오는 중입니다.</p>
            ) : (
              <>
                <dl className="failure-detail-fields">
                  <div>
                    <dt>요청 ID</dt>
                    <dd>{detail.summary.requestId}</dd>
                  </div>
                  <div>
                    <dt>사용자 ID</dt>
                    <dd>{detail.summary.userId}</dd>
                  </div>
                  <div>
                    <dt>판정 값</dt>
                    <dd>{detail.summary.compensationResult ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>발생 시각</dt>
                    <dd>{formatDate(detail.summary.occurredAt)}</dd>
                  </div>
                  <div>
                    <dt>사고 ID</dt>
                    <dd>{detail.incidentId ?? '-'}</dd>
                  </div>
                  {detail.summary.resolvedAt && (
                    <div>
                      <dt>종결</dt>
                      <dd>
                        {formatDate(detail.summary.resolvedAt)} · {detail.resolvedBy ?? '-'} · 저장 상태 {detail.resolveProbeResult ?? '-'}
                      </dd>
                    </div>
                  )}
                  {detail.resolveReason && (
                    <div>
                      <dt>종결 사유</dt>
                      <dd>{detail.resolveReason}</dd>
                    </div>
                  )}
                </dl>

                <p className="failure-detail-error-label">오류 메시지</p>
                <pre className="failure-detail-error"><code>{detail.errorMessage ?? '-'}</code></pre>

                {detail.availableActions.length > 0 ? (
                  <div className="failure-actions">
                    {detail.availableActions.some((action) => action.reasonRequired) && (
                      <div className="failure-action-fields">
                        <label>
                          조작자
                          <input
                            type="text"
                            value={operator}
                            placeholder="이름 또는 ID"
                            onChange={(event) => setOperator(event.target.value)}
                          />
                        </label>
                        <label>
                          종결 사유
                          <input
                            type="text"
                            value={reason}
                            placeholder="종결 근거를 남기세요"
                            onChange={(event) => setReason(event.target.value)}
                          />
                        </label>
                      </div>
                    )}
                    <div className="failure-action-buttons">
                      {detail.availableActions.map((action) => (
                        <button
                          key={action.action}
                          type="button"
                          className={action.action === 'RESOLVE' ? 'ghost-button' : 'primary-button'}
                          disabled={actionRunning}
                          onClick={() => runAction(action.action)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="failure-no-action">
                    {detail.summary.status === 'SETTLED'
                      ? '이미 종결된 건입니다.'
                      : '지금 실행할 수 있는 조치가 없습니다.'}
                  </p>
                )}

                {actionOutcome && <p className="failure-outcome" role="status">{actionOutcome}</p>}
                {actionError && <p className="failure-error" role="alert">{actionError}</p>}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  )
}

export default IssueFailureTab

import { useEffect, useRef, useState } from 'react'
import './IntegrityReportTab.css'

const MOCK_RECOVERY_DURATION_MS = 4000
const RECENT_RESULT_LIMIT = 8
const RECOVERY_HISTORY_LIMIT = 10

// checkName은 Ace_BE의 ConsistencyCheck 구현체 클래스명을 그대로 사용한다.
const CHECK_LABELS = {
  StockConsistencyCheck: '재고 정합성',
  RedisMysqlLossConsistencyCheck: 'Redis-MySQL 유실',
  DuplicateConsistencyCheck: '중복 발급',
  DuplicateSequenceConsistencyCheck: '발급 순번 중복',
  StateMachineConsistencyCheck: '상태 전이',
  CouponIssueStructuralConsistencyCheck: '발급 구조 정합성',
  CouponIssueHistoryStateConsistencyCheck: '발급 이력 상태 정합성',
  CouponHistoryStructuralConsistencyCheck: '쿠폰 이력 구조 정합성',
  CouponExpirationLagConsistencyCheck: '쿠폰 만료 지연',
  IssueHistoryTimeSyncConsistencyCheck: '이력 시간 동기화',
}

const CHECK_NAMES = Object.keys(CHECK_LABELS)

const RESULT_STATUS_META = {
  PASS: { label: '정상', tone: 'success' },
  FAIL: { label: '실패', tone: 'danger' },
  ERROR: { label: '에러', tone: 'waiting' },
}

const RECOVERY_STATUS_META = {
  NONE: { label: '복구 대기', tone: 'neutral' },
  IN_PROGRESS: { label: '복구 진행 중', tone: 'waiting' },
  SUCCESS: { label: '복구 완료', tone: 'success' },
  FAIL: { label: '복구 실패', tone: 'danger' },
}

// 실제 복구 방법 목록은 checkName별로 백엔드가 내려줄 예정. 화면 확인용 임시 목록이다.
const MOCK_RECOVERY_METHODS = [
  { id: 'SYNC_FROM_MYSQL', label: 'MySQL 기준으로 강제 동기화' },
  { id: 'SYNC_FROM_REDIS', label: 'Redis 기준으로 강제 동기화' },
  { id: 'REPLAY_EVENT', label: '원본 이벤트 재처리' },
]

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function createMockResult(status, executedAt = new Date()) {
  const checkName = randomFrom(CHECK_NAMES)
  const eventId = 1000 + Math.floor(Math.random() * 200)
  const violationCount = status === 'FAIL' ? Math.floor(Math.random() * 5) + 1 : 0

  return {
    id: crypto.randomUUID(),
    checkName,
    status,
    scopeType: randomFrom(['EVENT', 'AS_OF_RANGE', 'ALL']),
    eventId,
    violationCount,
    diffDetail: status === 'FAIL'
      ? { eventId, expected: 10000, actual: 10000 + violationCount }
      : null,
    errorMessage: status === 'ERROR' ? 'ConsistencyCheckException: CHECK_POSTPONED' : null,
    executedAt: executedAt.toISOString(),
    durationMillis: Math.floor(Math.random() * 900) + 80,
    recoveryStatus: status === 'FAIL' ? 'NONE' : null,
  }
}

function createInitialResults() {
  const now = Date.now()
  return [
    createMockResult('FAIL', new Date(now - 30_000)),
    createMockResult('ERROR', new Date(now - 90_000)),
    createMockResult('PASS', new Date(now - 150_000)),
    createMockResult('PASS', new Date(now - 210_000)),
    createMockResult('FAIL', new Date(now - 300_000)),
    createMockResult('PASS', new Date(now - 360_000)),
  ]
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

function scopeLabel(result) {
  if (result.scopeType === 'EVENT') return `이벤트 #${result.eventId}`
  if (result.scopeType === 'AS_OF_RANGE') return '시간 구간'
  return '전체'
}

function formatDiff(diffDetail) {
  if (!diffDetail) return '-'
  return Object.entries(diffDetail).map(([key, value]) => `${key} ${value}`).join(' · ')
}

function IntegrityReportTab() {
  const [results, setResults] = useState(createInitialResults)
  const [selectedMethodByResult, setSelectedMethodByResult] = useState({})
  const [recoveryHistory, setRecoveryHistory] = useState([])
  const recoveryTimersRef = useRef({})

  useEffect(() => () => {
    Object.values(recoveryTimersRef.current).forEach(window.clearTimeout)
  }, [])

  function startRecovery(resultId) {
    const methodId = selectedMethodByResult[resultId]
    if (!methodId) return

    const target = results.find((item) => item.id === resultId)
    const method = MOCK_RECOVERY_METHODS.find((item) => item.id === methodId)
    const attemptId = crypto.randomUUID()

    setResults((current) =>
      current.map((item) =>
        item.id === resultId ? { ...item, recoveryStatus: 'IN_PROGRESS' } : item,
      ),
    )
    setRecoveryHistory((current) => [
      {
        id: attemptId,
        checkName: target?.checkName,
        methodLabel: method?.label ?? methodId,
        status: 'IN_PROGRESS',
        requestedAt: new Date().toISOString(),
        finishedAt: null,
      },
      ...current,
    ].slice(0, RECOVERY_HISTORY_LIMIT))

    // TODO: 백엔드 복구 실행 API 연동 시 recovery_status 폴링으로 교체한다.
    const timer = window.setTimeout(() => {
      const succeeded = Math.random() < 0.7
      const finishedAt = new Date().toISOString()
      setResults((current) =>
        current.map((item) =>
          item.id === resultId ? { ...item, recoveryStatus: succeeded ? 'SUCCESS' : 'FAIL' } : item,
        ),
      )
      setRecoveryHistory((current) =>
        current.map((item) =>
          item.id === attemptId ? { ...item, status: succeeded ? 'SUCCESS' : 'FAIL', finishedAt } : item,
        ),
      )
      delete recoveryTimersRef.current[resultId]
    }, MOCK_RECOVERY_DURATION_MS)

    recoveryTimersRef.current[resultId] = timer
  }

  const recentResults = results.slice(0, RECENT_RESULT_LIMIT)
  const errorResults = results.filter((item) => item.status === 'ERROR').slice(0, RECENT_RESULT_LIMIT)
  const failResults = results.filter((item) => item.status === 'FAIL').slice(0, RECENT_RESULT_LIMIT)

  return (
    <section className="reconciliation-report" aria-labelledby="reconciliation-title">
      <div className="tab-heading">
        <div>
          <span className="eyebrow">CONSISTENCY REPORT</span>
          <h2 id="reconciliation-title">데이터 정합성 리포트</h2>
          <p>최근 검증 결과를 확인하고, 실패한 항목은 복구 방법을 선택해 복구를 진행합니다.</p>
        </div>
        <span className="api-chip subtle">API 연동 예정 · 예시 데이터</span>
      </div>

      <section className="panel recent-results-panel" aria-labelledby="recent-results-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">01</span>
            <h2 id="recent-results-title">최근 검증 결과</h2>
          </div>
        </div>
        <div className="table-wrap recent-results-scroll">
          <table>
            <thead>
              <tr>
                <th>검증 항목</th>
                <th>상태</th>
                <th>위반 건수</th>
                <th>대상</th>
                <th>실행 시각</th>
              </tr>
            </thead>
            <tbody>
              {recentResults.length > 0 ? recentResults.map((result) => {
                const meta = RESULT_STATUS_META[result.status]
                return (
                  <tr key={result.id}>
                    <td><strong>{CHECK_LABELS[result.checkName] ?? result.checkName}</strong></td>
                    <td><span className={`status-badge compact ${meta.tone}`}>{meta.label}</span></td>
                    <td>{result.violationCount > 0 ? `${result.violationCount}건` : '-'}</td>
                    <td>{scopeLabel(result)}</td>
                    <td>{formatDate(result.executedAt)}</td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan="5" className="table-empty">검증 결과가 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="data-note">API 연동 전까지는 화면 확인용 예시 데이터입니다.</p>
      </section>

      <div className="reconciliation-columns">
      <section className="panel verification-error-panel" aria-labelledby="verification-error-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">02</span>
            <h2 id="verification-error-title">정합성 검증 에러</h2>
          </div>
          <span className="api-chip subtle">status = ERROR</span>
        </div>
        <div className="reconciliation-scroll-area">
          {errorResults.length > 0 ? (
            <ul className="verification-error-list">
              {errorResults.map((result) => (
                <li key={result.id} className="error-box">
                  <strong>{CHECK_LABELS[result.checkName] ?? result.checkName}</strong>
                  <span>{result.errorMessage}</span>
                  <small>{formatDate(result.executedAt)} · {scopeLabel(result)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state small">
              <strong>검증 에러가 없습니다</strong>
              <p>Check 실행 자체가 실패한 항목이 없습니다.</p>
            </div>
          )}
        </div>
      </section>

      <section className="panel verification-fail-panel" aria-labelledby="verification-fail-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">03</span>
            <h2 id="verification-fail-title">정합성 검증 실패</h2>
          </div>
          <span className="api-chip subtle">status = FAIL</span>
        </div>
        <div className="reconciliation-scroll-area">
          {failResults.length > 0 ? (
          <ul className="verification-fail-list">
            {failResults.map((result) => {
              const recoveryMeta = RECOVERY_STATUS_META[result.recoveryStatus] ?? RECOVERY_STATUS_META.NONE
              const recovering = result.recoveryStatus === 'IN_PROGRESS'
              const locked = recovering || result.recoveryStatus === 'SUCCESS'
              return (
                <li key={result.id} className="fail-item">
                  <div className="fail-item-heading">
                    <div>
                      <strong>{CHECK_LABELS[result.checkName] ?? result.checkName}</strong>
                      <small>{scopeLabel(result)} · {formatDate(result.executedAt)}</small>
                    </div>
                    <span className={`status-badge ${recoveryMeta.tone}`}>{recoveryMeta.label}</span>
                  </div>
                  <p className="fail-item-diff">위반 {result.violationCount}건 · {formatDiff(result.diffDetail)}</p>
                  <div className="fail-item-recovery">
                    <select
                      value={selectedMethodByResult[result.id] ?? ''}
                      onChange={(event) =>
                        setSelectedMethodByResult((current) => ({ ...current, [result.id]: event.target.value }))
                      }
                      disabled={locked}
                    >
                      <option value="">복구 방법 선택</option>
                      {MOCK_RECOVERY_METHODS.map((method) => (
                        <option key={method.id} value={method.id}>{method.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost-button recovery-button"
                      onClick={() => startRecovery(result.id)}
                      disabled={locked || !selectedMethodByResult[result.id]}
                    >
                      {recovering
                        ? '복구 진행 중…'
                        : result.recoveryStatus === 'SUCCESS'
                          ? '복구 완료됨'
                          : '복구 시작'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          ) : (
            <div className="empty-state small">
              <strong>실패한 검증이 없습니다</strong>
              <p>불일치가 감지된 검증 결과가 없습니다.</p>
            </div>
          )}
        </div>
      </section>
      </div>

      <section className="panel recovery-history-panel" aria-labelledby="recovery-history-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">04</span>
            <h2 id="recovery-history-title">복구 이력</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>검증 항목</th>
                <th>복구 방법</th>
                <th>결과</th>
                <th>요청 시각</th>
                <th>완료 시각</th>
              </tr>
            </thead>
            <tbody>
              {recoveryHistory.length > 0 ? recoveryHistory.map((entry) => {
                const meta = RECOVERY_STATUS_META[entry.status] ?? RECOVERY_STATUS_META.NONE
                return (
                  <tr key={entry.id}>
                    <td><strong>{CHECK_LABELS[entry.checkName] ?? entry.checkName}</strong></td>
                    <td>{entry.methodLabel}</td>
                    <td><span className={`status-badge compact ${meta.tone}`}>{meta.label}</span></td>
                    <td>{formatDate(entry.requestedAt)}</td>
                    <td>{formatDate(entry.finishedAt)}</td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan="5" className="table-empty">복구를 진행한 이력이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  )
}

export default IntegrityReportTab

import { useState } from 'react'
import { ApiError, getIssueStatus, getIssuanceStats, issueCoupon } from '../api/couponApi'

const DEFAULT_REQUEST_COUNT = 10
const MAX_REQUEST_COUNT = 100
const FINAL_STATUSES = new Set(['ISSUED', 'FAILED', 'COMPENSATED'])

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

async function waitForFinalStatus(eventId, requestId) {
  let latest = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await getIssueStatus(eventId, requestId)
    if (FINAL_STATUSES.has(latest.status)) return latest
    await wait(500)
  }
  return latest
}

function uniqueCount(values) {
  return new Set(values.filter((value) => value !== null && value !== undefined)).size
}

function IdempotencyConcurrencyTest({ campaign, campaignLabel }) {
  const [userId, setUserId] = useState('')
  const [requestCount, setRequestCount] = useState(String(DEFAULT_REQUEST_COUNT))
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState(null)
  const [result, setResult] = useState(null)

  async function runTest(event) {
    event.preventDefault()
    const parsedEventId = Number(campaign?.eventId)
    const parsedUserId = Number(userId)
    const parsedRequestCount = Number(requestCount)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0 || campaign?.status !== 'OPEN') {
      setNotice({ tone: 'danger', message: 'OPEN 상태인 쿠폰 이벤트를 먼저 선택해주세요.' })
      return
    }
    if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
      setNotice({ tone: 'danger', message: '사용자 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedRequestCount) || parsedRequestCount < 2 || parsedRequestCount > MAX_REQUEST_COUNT) {
      setNotice({ tone: 'danger', message: `동시 요청 수는 2~${MAX_REQUEST_COUNT} 사이의 정수여야 합니다.` })
      return
    }

    const idempotencyKey = crypto.randomUUID()
    const startedAt = performance.now()
    setRunning(true)
    setNotice(null)
    setResult(null)

    try {
      const beforeStats = await getIssuanceStats(parsedEventId)
      const settled = await Promise.allSettled(
        Array.from({ length: parsedRequestCount }, () => (
          issueCoupon(parsedEventId, parsedUserId, idempotencyKey)
        )),
      )
      const afterStats = await getIssuanceStats(parsedEventId)
      const accepted = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value)
      const rejected = settled.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason)
      const representative = accepted[0]
      let finalStatus = null
      let statusError = null

      if (representative?.requestId) {
        try {
          finalStatus = await waitForFinalStatus(parsedEventId, representative.requestId)
        } catch (error) {
          statusError = error instanceof ApiError ? error.message : '최종 발급 상태를 조회하지 못했습니다.'
        }
      }

      const requestIdCount = uniqueCount(accepted.map((entry) => entry.requestId))
      const sequenceCount = uniqueCount(accepted.map((entry) => entry.issueSequence))
      const remainingCount = uniqueCount(accepted.map((entry) => entry.remainingStock))
      const stockDelta = Number(beforeStats.remainingStock) - Number(afterStats.remainingStock)
      const replayMatched = accepted.length === parsedRequestCount
        && requestIdCount === 1 && sequenceCount === 1 && remainingCount === 1
      const passed = replayMatched && stockDelta === 1 && finalStatus?.status === 'ISSUED'
      const errorCodes = rejected.reduce((counts, error) => {
        const code = error instanceof ApiError ? error.code : 'UNKNOWN'
        return { ...counts, [code]: (counts[code] ?? 0) + 1 }
      }, {})

      setResult({
        requestCount: parsedRequestCount,
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        errorCodes,
        idempotencyKey,
        requestId: representative?.requestId ?? null,
        issueSequence: representative?.issueSequence ?? null,
        beforeStock: beforeStats.remainingStock,
        afterStock: afterStats.remainingStock,
        stockDelta,
        requestIdCount,
        sequenceCount,
        finalStatus: finalStatus?.status ?? null,
        statusError,
        elapsedMs: performance.now() - startedAt,
        passed,
      })
      setNotice({
        tone: passed ? 'success' : 'danger',
        message: passed
          ? '동일 요청이 한 번만 처리되고 모든 응답에 같은 발급 결과가 재생되었습니다.'
          : '멱등성 기대 조건과 일치하지 않습니다. 아래 결과와 서버 로그를 확인해주세요.',
      })
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof ApiError ? error.message : '동시 요청 테스트를 실행하지 못했습니다.',
      })
    } finally {
      setRunning(false)
    }
  }

  const errorSummary = result
    ? Object.entries(result.errorCodes).map(([code, count]) => `${code} ${count}건`).join(' · ')
    : ''

  return (
    <article className="panel idempotency-test-panel">
      <div className="panel-heading">
        <div><span className="section-number">02</span><h2>동일 요청 동시 테스트</h2></div>
      </div>
      <p className="idempotency-test-description">
        동일한 사용자·이벤트·요청 키로 N건을 동시에 보내 최초 요청만 처리되고,
        나머지 요청에는 같은 발급 결과가 재생되는지 확인합니다. 아직 발급받지 않은 사용자 ID를 사용하세요.
      </p>
      <form className="idempotency-test-form" onSubmit={runTest}>
        <label>선택된 쿠폰 이벤트<input value={campaign ? campaignLabel(campaign) : '쿠폰 선택 대기'} disabled /></label>
        <label>사용자 ID<input type="number" min="1" step="1" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="미발급 사용자 ID" disabled={running} /></label>
        <label>동시 요청 수<input type="number" min="2" max={MAX_REQUEST_COUNT} step="1" value={requestCount} onChange={(event) => setRequestCount(event.target.value)} disabled={running} /></label>
        <button className="primary-button" type="submit" disabled={running || campaign?.status !== 'OPEN'}>
          {running ? '동일 요청 처리 확인 중…' : '동시 요청 테스트 시작'}
        </button>
      </form>
      {notice && <p className={`idempotency-test-notice ${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>{notice.message}</p>}
      {result && (
        <>
          <div className="idempotency-result-grid">
            <div><span>동시 요청</span><strong>{result.requestCount}건</strong></div>
            <div><span>동일 결과 응답</span><strong>{result.acceptedCount}건</strong></div>
            <div><span>요청 실패</span><strong>{result.rejectedCount}건</strong></div>
            <div><span>고유 requestId</span><strong>{result.requestIdCount}개</strong></div>
            <div><span>고유 발급 순번</span><strong>{result.sequenceCount}개</strong></div>
            <div><span>재고 차감</span><strong>{result.stockDelta}장</strong></div>
            <div><span>최종 저장 상태</span><strong>{result.finalStatus ?? '확인 실패'}</strong></div>
            <div className={result.passed ? 'passed' : 'failed'}><span>검증 결과</span><strong>{result.passed ? '정상 방어' : '조건 불일치'}</strong></div>
          </div>
          <dl className="idempotency-result-detail">
            <div><dt>Idempotency-Key</dt><dd>{result.idempotencyKey}</dd></div>
            <div><dt>requestId</dt><dd>{result.requestId ?? '-'}</dd></div>
            <div><dt>발급 순번</dt><dd>{result.issueSequence ?? '-'}</dd></div>
            <div><dt>재고</dt><dd>{result.beforeStock ?? '-'} → {result.afterStock ?? '-'}</dd></div>
            <div><dt>소요 시간</dt><dd>{(result.elapsedMs / 1000).toFixed(2)}초</dd></div>
          </dl>
          {(errorSummary || result.statusError) && <p className="idempotency-test-error-detail">{errorSummary || result.statusError}</p>}
        </>
      )}
    </article>
  )
}

export default IdempotencyConcurrencyTest

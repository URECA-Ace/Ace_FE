const PARTICIPANT_COUNT = 20000

function LoadTestTab({
  loadEventId,
  setLoadEventId,
  openCampaigns,
  campaignLabel,
  concurrency,
  setConcurrency,
  loadResult,
  expectedStock,
  onSubmit,
  onCancel,
}) {
  const selectedLoadCampaign = openCampaigns.find(
    (campaign) => String(campaign.eventId) === String(loadEventId),
  )
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

        <form className="traffic-form" onSubmit={onSubmit}>
          <label>
            트래픽을 실행할 발급 회차
            <select
              value={loadEventId}
              onChange={(event) => setLoadEventId(event.target.value)}
              disabled={loadResult.running}
            >
              {openCampaigns.length > 0 ? openCampaigns.map((campaign) => (
                <option key={campaign.eventId} value={campaign.eventId}>
                  {campaignLabel(campaign)}
                </option>
              )) : (
                <option value="">현재 OPEN 상태인 발급 회차가 없습니다</option>
              )}
            </select>
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
            <button className="traffic-stop-button" type="button" onClick={onCancel}>
              요청 중단
            </button>
          ) : (
            <button className="traffic-start-button" type="submit" disabled={!selectedLoadCampaign}>
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
  )
}

export default LoadTestTab

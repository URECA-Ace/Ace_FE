import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  getIssueRelayStatus,
  startIssueRelay,
  stopIssueRelay,
} from '../api/couponApi'
import './IssueRelayControlPanel.css'

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ko-KR', { hour12: false })
}

function statusMeta(status) {
  if (!status?.available) {
    return { tone: 'unknown', label: '릴레이 빈 없음 (RELAY 모드 아님)' }
  }
  return status.running
    ? { tone: 'running', label: '정상 동작 중' }
    : { tone: 'stopped', label: '정지됨' }
}

// RedisMysqlLossConsistencyCheck의 "릴레이 컨슈머 정지" 위반과 RESTART_RELAY_CONSUMER 자동
// 복구는 기존 위반 주입 패널(Redis 재고만 직접 감소시키는 방식)로는 재현되지 않는다 — 그 주입은
// 릴레이를 그대로 살려두기 때문이다. 이 패널은 릴레이 자체를 실제로 멈추고 되살려서, 그 복구
// 경로(회복 버튼을 눌렀을 때 실제로 재시작되는 것)를 눈으로 확인할 수 있게 한다.
function IssueRelayControlPanel() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  const refresh = useCallback((signal) => {
    return getIssueRelayStatus(signal)
      .then((data) => {
        setStatus(data)
        return data
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return null
        setNotice({
          tone: 'danger',
          message: '릴레이 상태를 불러오지 못했습니다. 백엔드의 coupon.issue.relay.demo-control.enabled 설정을 확인하세요.',
        })
        return null
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [refresh])

  async function run(action, label) {
    setBusy(true)
    setNotice(null)
    try {
      const data = await action()
      setStatus(data)
      setNotice({ tone: 'success', message: `${label} 완료 (running: ${data.running})`, at: Date.now() })
    } catch (error) {
      const message = error instanceof ApiError ? error.message : `${label}에 실패했습니다.`
      setNotice({ tone: 'danger', message, at: Date.now() })
    } finally {
      setBusy(false)
    }
  }

  const meta = statusMeta(status)

  return (
    <section className="panel relay-control-panel" aria-labelledby="relay-control-panel-title">
      <div className="panel-heading">
        <div>
          <span className="section-number">05</span>
          <h2 id="relay-control-panel-title">발급 Stream 릴레이 장애 시연</h2>
        </div>
      </div>
      <p className="panel-description">
        릴레이(IssueStreamRelay)를 강제로 정지시켜 "컨슈머가 죽어서 MySQL에 반영되지 않는" 상황을
        재현합니다. 정지 상태에서 발급 요청을 보내면 정합성 검증에서 위반(FAIL)이 뜨고, 여기서
        직접 재시작하거나 정합성 리포트의 복구 버튼(발급 Stream 릴레이 재시작)으로 되살릴 수 있습니다.
      </p>

      {notice && (
        <p
          className={`relay-notice ${notice.tone}`}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.message}
        </p>
      )}

      {loading ? (
        <p className="catalog-empty">릴레이 상태를 불러오는 중입니다.</p>
      ) : (
        <>
          <div className="relay-status-row">
            <span>현재 상태</span>
            <span className={`relay-status-pill ${meta.tone}`}>{meta.label}</span>
          </div>

          <div className="injection-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => run(stopIssueRelay, '릴레이 정지')}
              disabled={busy || !status?.available || status?.running === false}
            >
              {busy ? '처리 중…' : '릴레이 정지'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => run(startIssueRelay, '릴레이 재시작')}
              disabled={busy || !status?.available || status?.running === true}
            >
              {busy ? '처리 중…' : '릴레이 재시작'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => refresh()}
              disabled={busy}
            >
              상태 새로고침
            </button>
          </div>

          {notice?.at && (
            <p className="relay-last-action">마지막 조작: {formatTime(notice.at)}</p>
          )}
        </>
      )}
    </section>
  )
}

export default IssueRelayControlPanel

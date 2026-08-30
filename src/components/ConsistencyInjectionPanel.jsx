import { useEffect, useState } from 'react'
import {
  ApiError,
  getConsistencyInjectors,
  injectConsistencyViolation,
} from '../api/couponApi'
import { CHECK_LABELS } from '../constants/consistencyChecks'
import './ConsistencyInjectionPanel.css'

const HISTORY_LIMIT = 10

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ko-KR', { hour12: false })
}

// 관리 화면에서 실제 DB에 위반 데이터를 심어, 정합성 검증이 이를 탐지하고 복구하는 과정을
// 눈으로 확인할 수 있게 하는 시연용 패널.
function ConsistencyInjectionPanel() {
  const [injectors, setInjectors] = useState({})
  const [loading, setLoading] = useState(true)
  const [checkName, setCheckName] = useState('')
  const [eventId, setEventId] = useState('')
  const [injecting, setInjecting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [history, setHistory] = useState([])

  useEffect(() => {
    const controller = new AbortController()
    getConsistencyInjectors(controller.signal)
      .then((data) => {
        setInjectors(data)
        setCheckName((current) => current || Object.keys(data)[0] || '')
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        setNotice({
          tone: 'danger',
          message: '위반 주입기 목록을 불러오지 못했습니다. 백엔드의 consistency.injection.admin.enabled 설정을 확인하세요.',
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  function validate() {
    if (!checkName) return '주입할 검사를 선택해주세요.'
    if (!eventId || Number(eventId) <= 0) return '위반을 심을 이벤트 ID를 입력해주세요.'
    return null
  }

  async function inject() {
    const validationMessage = validate()
    if (validationMessage) {
      setNotice({ tone: 'danger', message: validationMessage })
      return null
    }

    setInjecting(true)
    setNotice(null)
    try {
      const result = await injectConsistencyViolation(checkName, Number(eventId))
      setHistory((current) => [{ ...result, injectedAt: Date.now() }, ...current].slice(0, HISTORY_LIMIT))
      setNotice({ tone: 'success', message: result.message })
      return result
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '위반 데이터 주입에 실패했습니다.'
      setNotice({ tone: 'danger', message })
      return null
    } finally {
      setInjecting(false)
    }
  }

  const injectorNames = Object.keys(injectors)
  const busy = injecting

  return (
    <section className="panel injection-panel" aria-labelledby="injection-panel-title">
      <div className="panel-heading">
        <div>
          <span className="section-number">01</span>
          <h2 id="injection-panel-title">정합성 위반 데이터 주입</h2>
        </div>
        <span className="api-chip subtle">POST · /api/v1/consistency/injections</span>
      </div>
      <p className="panel-description">
        선택한 검사 항목의 위반 데이터를 실제 DB에 직접 심어, 정합성 검증이 이를 탐지하고 복구하는 과정을 눈으로 확인합니다.
        운영 데이터를 오염시키므로 시연 환경에서만 사용하세요.
      </p>

      {notice && (
        <p
          className={`injection-notice ${notice.tone}`}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.message}
        </p>
      )}

      {loading ? (
        <p className="catalog-empty">주입 가능한 검사 목록을 불러오는 중입니다.</p>
      ) : injectorNames.length > 0 ? (
        <>
          <div className="injection-form">
            <label className="injection-field">
              <span>주입할 검사</span>
              <select
                value={checkName}
                onChange={(event) => setCheckName(event.target.value)}
                disabled={busy}
              >
                {injectorNames.map((name) => (
                  <option key={name} value={name}>{CHECK_LABELS[name] ?? name}</option>
                ))}
              </select>
            </label>
            <label className="injection-field">
              <span>이벤트 ID</span>
              <input
                type="number"
                min="1"
                value={eventId}
                onChange={(event) => setEventId(event.target.value)}
                placeholder="예: 123"
                disabled={busy}
              />
            </label>
          </div>
          {checkName && injectors[checkName] && (
            <p className="injection-check-description">{injectors[checkName]}</p>
          )}
          <div className="injection-actions">
            <button type="button" className="ghost-button" onClick={inject} disabled={busy}>
              {injecting ? '주입 중…' : '위반 데이터 주입'}
            </button>
          </div>
          {history.length > 0 && (
            <ul className="injection-history-list">
              {history.map((entry, index) => (
                <li key={`${entry.checkName}-${entry.eventId}-${entry.injectedAt}-${index}`}>
                  <strong>{CHECK_LABELS[entry.checkName] ?? entry.checkName}</strong>
                  <span>{entry.message}</span>
                  <small>이벤트 #{entry.eventId} · {formatTime(entry.injectedAt)}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="catalog-empty">주입 가능한 검사가 없습니다.</p>
      )}
    </section>
  )
}

export default ConsistencyInjectionPanel

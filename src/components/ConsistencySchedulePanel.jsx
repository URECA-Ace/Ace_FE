import { useEffect, useState } from 'react'
import { ApiError, getConsistencySchedules, updateConsistencySchedule } from '../api/couponApi'

const SCHEDULER_LABELS = {
  ALL_CONSISTENCY: '전체(ALL) 배치 검증',
  AS_OF_RANGE_CONSISTENCY: '구간(AS_OF_RANGE) 검증',
  ORPHAN_VIOLATION_CLEANUP: '고아 위반 정리',
}

const REFRESH_INTERVAL_MS = 5000

function formatRemaining(remainingMs) {
  if (remainingMs <= 0) return '실행 대기 중…'
  const totalSeconds = Math.floor(remainingMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (hours > 0) parts.push(`${hours}시간`)
  if (hours > 0 || minutes > 0) parts.push(`${minutes}분`)
  parts.push(`${seconds}초`)
  return `${parts.join(' ')} 후`
}

// 3개 정합성 스케줄러(ALL/AS_OF_RANGE/고아 위반 정리)의 주기를 조회하고 변경한다.
// 다음 실행까지 남은 시간은 서버가 내려준 nextRunAtEpochMs를 기준으로 1초마다 로컬에서
// 다시 계산하고, 다른 인스턴스가 주기를 바꾸거나 배치가 시작/종료될 수 있으므로 목록 자체는
// 주기적으로 다시 조회한다.
function ConsistencySchedulePanel() {
  const [schedules, setSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [draftByScheduler, setDraftByScheduler] = useState({})
  const [savingScheduler, setSavingScheduler] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer = null

    async function refresh() {
      try {
        const data = await getConsistencySchedules(controller.signal)
        setSchedules(data)
      } catch (error) {
        if (error.name === 'AbortError') return
        const message = error instanceof ApiError ? error.message : '스케줄러 상태를 불러오지 못했습니다.'
        setNotice({ tone: 'danger', message })
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
      if (!controller.signal.aborted) {
        timer = window.setTimeout(refresh, REFRESH_INTERVAL_MS)
      }
    }

    refresh()
    return () => {
      controller.abort()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  async function saveInterval(schedulerName) {
    const draftSeconds = Number(draftByScheduler[schedulerName])
    const intervalMs = Math.round(draftSeconds * 1000)
    if (!Number.isFinite(draftSeconds) || intervalMs < 1000) {
      setNotice({ tone: 'danger', message: '주기는 1초 이상으로 입력해주세요.' })
      return
    }

    setSavingScheduler(schedulerName)
    setNotice(null)
    try {
      const updated = await updateConsistencySchedule(schedulerName, intervalMs)
      setSchedules((current) => current.map(
        (item) => item.schedulerName === schedulerName ? updated : item,
      ))
      setDraftByScheduler((current) => {
        const next = { ...current }
        delete next[schedulerName]
        return next
      })
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '주기 변경에 실패했습니다.'
      setNotice({ tone: 'danger', message })
    } finally {
      setSavingScheduler(null)
    }
  }

  return (
    <section className="panel schedule-panel" aria-labelledby="schedule-panel-title">
      <div className="panel-heading">
        <div>
          <span className="section-number">06</span>
          <h2 id="schedule-panel-title">정합성 스케줄러 주기 관리</h2>
        </div>
      </div>

      {notice && (
        <p
          className={`consistency-verification-notice ${notice.tone}`}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.message}
        </p>
      )}

      {loading ? (
        <p className="catalog-empty">스케줄러 상태를 불러오는 중입니다.</p>
      ) : schedules.length > 0 ? (
        <div className="schedule-card-grid">
          {schedules.map((schedule) => {
            const remainingMs = schedule.nextRunAtEpochMs - now
            const draft = draftByScheduler[schedule.schedulerName] ?? ''
            const saving = savingScheduler === schedule.schedulerName
            return (
              <article key={schedule.schedulerName} className="schedule-card">
                <div className="schedule-card-heading">
                  <strong>{SCHEDULER_LABELS[schedule.schedulerName] ?? schedule.schedulerName}</strong>
                  {schedule.running && <span className="status-badge compact waiting">진행중…</span>}
                </div>
                <dl className="schedule-card-details">
                  <div>
                    <dt>현재 주기</dt>
                    <dd>{Math.round(schedule.intervalMs / 1000).toLocaleString()}초</dd>
                  </div>
                  <div>
                    <dt>다음 실행까지</dt>
                    <dd>{formatRemaining(remainingMs)}</dd>
                  </div>
                </dl>
                <div className="schedule-card-form">
                  <input
                    type="number"
                    min="1"
                    placeholder="새 주기(초)"
                    value={draft}
                    onChange={(event) => setDraftByScheduler((current) => ({
                      ...current,
                      [schedule.schedulerName]: event.target.value,
                    }))}
                    disabled={saving}
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => saveInterval(schedule.schedulerName)}
                    disabled={saving || !draft}
                  >
                    {saving ? '변경 중…' : '주기 변경'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <p className="catalog-empty">등록된 스케줄러가 없습니다.</p>
      )}
    </section>
  )
}

export default ConsistencySchedulePanel

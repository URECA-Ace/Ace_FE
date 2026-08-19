import { useEffect, useRef, useState } from 'react'
import './ScheduledOpenTimeline.css'

const STATUS_LABELS = {
  SCHEDULED: '예약 오픈 대기',
  OPEN: '예약 시각 도달 · 오픈',
  SOLD_OUT: '재고 소진',
  CLOSED: '캠페인 종료',
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

function ScheduledOpenTimeline({ status, observedAt }) {
  const [transitions, setTransitions] = useState([])
  const previousStatusRef = useRef(null)

  useEffect(() => {
    if (!status || previousStatusRef.current === status) return

    setTransitions((current) => [
      {
        id: crypto.randomUUID(),
        status,
        label: STATUS_LABELS[status] ?? status,
        observedAt,
      },
      ...current,
    ].slice(0, 12))
    previousStatusRef.current = status
  }, [observedAt, status])

  return (
    <div className="status-transition-list">
      <div className="transition-heading">
        <div>
          <strong>예약 상태 전환</strong>
          <small>스케줄러 동작 감지</small>
        </div>
        <span>SCHEDULED → OPEN</span>
      </div>

      {transitions.length > 0 ? (
        <ol aria-label="캠페인 상태 전환 이력">
          {transitions.map((transition) => (
            <li key={transition.id}>
              <span className={`transition-dot ${transition.status.toLowerCase().replace('_', '-')}`} />
              <div>
                <strong>{transition.label}</strong>
                <small>{transition.status}</small>
              </div>
              <time>{formatObservedAt(transition.observedAt)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <div className="transition-empty">
          <span>◷</span>
          <p>관제를 시작하면 예약 오픈 상태가 기록됩니다.</p>
        </div>
      )}

      <p className="schedule-note">
        백엔드가 제공하는 상태를 관측하며 프론트에서 오픈 시각을 임의로 변경하지 않습니다.
      </p>
    </div>
  )
}

export default ScheduledOpenTimeline

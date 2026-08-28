import { useEffect, useState } from 'react'
import { subscribeNotifications } from '../utils/notificationStream'

const TOAST_DURATION_MS = 6000
const MAX_VISIBLE_TOASTS = 20

const TONE_ICON = { success: '✓', danger: '!', info: 'i' }

const NOTIFICATION_LABELS = {
  ISSUE_SUCCESS: (payload) => `쿠폰 발급에 성공했습니다. (회차 #${payload.eventId})`,
  ISSUE_FAILED: (payload) => `쿠폰 발급에 실패했습니다. (회차 #${payload.eventId}, 사유: ${payload.reason})`,
  ISSUE_FAILED_BATCH: (payload) =>
    `쿠폰 발급 실패가 다발 발생했습니다. (회차 #${payload.eventId}, 사유: ${payload.reason}, ${payload.count}건, 최근 5초)`,
  CONSISTENCY_CHECK_FAILED: (payload) => `정합성 검증 실패: ${payload.checkName} (불일치 ${payload.violationCount}건)`,
  COUPON_ISSUANCE_ALL_COMPLETED: (payload) => `쿠폰 전체 발급이 완료되었습니다. (회차 #${payload.eventId})`,
  CONSISTENCY_STEP_COMPLETED: (payload) => `정합성 검증 Step 완료: ${payload.checkName} (${payload.status})`,
  CONSISTENCY_BATCH_COMPLETED: (payload) => `ALL 정합성 배치가 완료되었습니다. (Step ${payload.stepCount}개, ${payload.status})`,
  SCHEDULER_STARTED: (payload) => `스케줄러가 시작되었습니다: ${payload.schedulerName}`,
  SCHEDULER_COMPLETED: (payload) => `스케줄러가 완료되었습니다: ${payload.schedulerName}`,
}

const NOTIFICATION_TONES = {
  ISSUE_SUCCESS: 'success',
  ISSUE_FAILED: 'danger',
  ISSUE_FAILED_BATCH: 'danger',
  CONSISTENCY_CHECK_FAILED: 'danger',
  COUPON_ISSUANCE_ALL_COMPLETED: 'success',
  CONSISTENCY_STEP_COMPLETED: 'info',
  CONSISTENCY_BATCH_COMPLETED: 'info',
  SCHEDULER_STARTED: 'info',
  SCHEDULER_COMPLETED: 'success',
}

let nextToastId = 0

function describeNotification({ type, payload }) {
  const describe = NOTIFICATION_LABELS[type]
  const message = describe ? describe(payload ?? {}) : `${type} 알림이 도착했습니다.`
  return { tone: NOTIFICATION_TONES[type] ?? 'info', message }
}

function NotificationToastStack() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    const unsubscribe = subscribeNotifications((notification) => {
      const { tone, message } = describeNotification(notification)
      const id = nextToastId++
      setToasts((current) => [...current, { id, tone, message }])
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, TOAST_DURATION_MS)
    })
    return unsubscribe
  }, [])

  function dismiss(id) {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  if (toasts.length === 0) return null

  const visibleToasts = toasts.slice(-MAX_VISIBLE_TOASTS)
  const hiddenCount = toasts.length - visibleToasts.length

  return (
    <div className="toast-stack" aria-live="polite">
      {hiddenCount > 0 && (
        <div className="toast-item info" role="status">
          <span className="toast-icon">+</span>
          알림 {hiddenCount}건 더 도착했습니다
        </div>
      )}
      {visibleToasts.map((toast) => (
        <div key={toast.id} className={`toast-item ${toast.tone}`} role="status">
          <span className="toast-icon">{TONE_ICON[toast.tone]}</span>
          {toast.message}
          <button type="button" onClick={() => dismiss(toast.id)} aria-label="알림 닫기">×</button>
        </div>
      ))}
    </div>
  )
}

export default NotificationToastStack

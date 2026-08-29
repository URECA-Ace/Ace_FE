import { useEffect, useState } from 'react'
import { subscribeNotifications } from '../utils/notificationStream'

const TOAST_DURATION_MS = 6000
const MAX_VISIBLE_TOASTS = 20

// 이 알림들은 ConsistencyBatchStatusBanner가 상시 표시로 이미 보여주므로, 여기서
// 토스트로 중복 노출하지 않는다.
const SKIPPED_TOAST_TYPES = new Set(['CONSISTENCY_BATCH_STARTED', 'CONSISTENCY_STEP_STARTED'])

const TONE_ICON = { success: '✓', danger: '!', info: 'i' }

// 스케줄러 알림(schedulerName)의 원본 값은 Ace_BE 각 Scheduler 클래스의 SCHEDULER_NAME
// 상수를 그대로 쓰므로, 영어 원문 대신 한글로 보여주기 위한 매핑.
const SCHEDULER_LABELS = {
  ALL_CONSISTENCY: '전체 정합성 검증 스케줄링',
  AS_OF_RANGE_CONSISTENCY: '시간 구간 검증 스케줄링',
  ORPHAN_VIOLATION_CLEANUP: '고아 위반 데이터 정리 스케줄링',
}

const NOTIFICATION_LABELS = {
  ISSUE_SUCCESS: (payload) => `쿠폰 발급에 성공했습니다. (회차 #${payload.eventId})`,
  ISSUE_FAILED: (payload) => `쿠폰 발급에 실패했습니다. (회차 #${payload.eventId}, 사유: ${payload.reason})`,
  ISSUE_FAILED_BATCH: (payload) =>
    `쿠폰 발급 실패가 다발 발생했습니다. (회차 #${payload.eventId}, 사유: ${payload.reason}, ${payload.count}건, 최근 5초)`,
  CONSISTENCY_CHECK_FAILED: (payload) => `정합성 검증 실패: ${payload.checkName} (불일치 ${payload.violationCount}건)`,
  COUPON_ISSUANCE_ALL_COMPLETED: (payload) => `쿠폰 전체 발급이 완료되었습니다. (회차 #${payload.eventId})`,
  CONSISTENCY_STEP_COMPLETED: (payload) => `정합성 검증 Step 완료: ${payload.checkName} (${payload.status})`,
  CONSISTENCY_BATCH_COMPLETED: (payload) => `ALL 정합성 배치가 완료되었습니다. (Step ${payload.stepCount}개, ${payload.status})`,
  SCHEDULER_STARTED: (payload) => `스케줄러가 시작되었습니다: ${SCHEDULER_LABELS[payload.schedulerName] ?? payload.schedulerName}`,
  SCHEDULER_COMPLETED: (payload) => `스케줄러가 완료되었습니다: ${SCHEDULER_LABELS[payload.schedulerName] ?? payload.schedulerName}`,
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

function describeNotification({ type, payload }) {
  const describe = NOTIFICATION_LABELS[type]
  const message = describe ? describe(payload ?? {}) : `${type} 알림이 도착했습니다.`
  return { tone: NOTIFICATION_TONES[type] ?? 'info', message }
}

function NotificationToastStack() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    const unsubscribe = subscribeNotifications((notification) => {
      if (SKIPPED_TOAST_TYPES.has(notification.type)) return
      const { tone, message } = describeNotification(notification)
      // 개발 중 Vite HMR로 이 모듈이 다시 로드되면 모듈 스코프 변수는 초기화되지만
      // 컴포넌트 state(toasts)는 유지되므로, 카운터 대신 충돌 없는 id를 사용해야 한다.
      const id = crypto.randomUUID()
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

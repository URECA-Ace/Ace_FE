import { CHECK_LABELS } from '../constants/consistencyChecks'

// finalStatus는 VerificationResult 상태(PASS/FAIL/ERROR)가 아니라 Spring Batch의
// JobExecution 상태 그대로다(ConsistencyBatchCompletedEvent.status 참고).
const STATUS_LABELS = { COMPLETED: '성공', FAILED: '실패', STOPPED: '중지됨' }

// ALL 정합성 검증 배치가 도는 동안 "지금 어떤 Check가 실행 중인지"를 계속 띄워두는
// 상시 표시 컴포넌트. NotificationToastStack과 달리 자동으로 사라지지 않고, 배치가
// 완료된 뒤에도 잠깐 최종 상태를 보여주다가 닫힌다.
// 배치 상태는 App이 구독해서 관리한다 — 탭을 전환해도(이 컴포넌트가 언마운트/재마운트돼도)
// "지금 ALL 검증이 도는 중인지"를 IntegrityReportTab이 함께 알아야 하기 때문이다.
function ConsistencyBatchStatusBanner({ batch, onStop, stopping }) {
  if (!batch) return null

  const doneCount = batch.completedSteps.length

  return (
    <div className={`consistency-batch-banner ${batch.finished ? 'finished' : ''}`} role="status" aria-live="polite">
      {batch.finished ? (
        <span>
          정합성 배치 완료 ({STATUS_LABELS[batch.finalStatus] ?? batch.finalStatus}, {doneCount}/{batch.totalSteps})
        </span>
      ) : (
        <>
          <span>
            정합성 배치 실행 중 ({doneCount}/{batch.totalSteps})
            {batch.currentCheck && ` — 현재: ${CHECK_LABELS[batch.currentCheck] ?? batch.currentCheck}`}
          </span>
          <button
            type="button"
            className="consistency-batch-stop-button"
            onClick={onStop}
            disabled={stopping || !batch.jobExecutionId}
          >
            {stopping ? '중지 중…' : '중지'}
          </button>
        </>
      )}
    </div>
  )
}

export default ConsistencyBatchStatusBanner

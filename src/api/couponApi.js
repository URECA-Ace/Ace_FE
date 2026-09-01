export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(code, message, status, incidentId) {
    super(message || code)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.incidentId = incidentId
  }
}

async function request(path, options) {
  let response

  try {
    response = await fetch(`${API_BASE_URL}${path}`, options)
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('NETWORK_ERROR', '백엔드 서버에 연결할 수 없습니다.')
  }

  let body
  try {
    body = await response.json()
  } catch {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new ApiError(
        'BACKEND_UNAVAILABLE',
        '백엔드 서버에 연결할 수 없습니다. Spring 서버가 설정된 포트에서 실행 중인지 확인하세요.',
        response.status,
      )
    }
    throw new ApiError(
      'INVALID_RESPONSE',
      '서버가 올바른 JSON 응답을 반환하지 않았습니다.',
      response.status,
    )
  }

  if (!response.ok || body.result !== 'success') {
    throw new ApiError(
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.message ?? '요청 처리에 실패했습니다.',
      response.status,
      body.error?.incidentId,
    )
  }

  return body.data
}

export function issueCoupon(eventId, userId, idempotencyKey, signal, runId) {
  return request(`/api/v1/events/${eventId}/issues`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...(runId ? { 'X-Test-Run-Id': runId } : {}),
    },
    body: JSON.stringify({ userId }),
  })
}

export function getIssueStatus(eventId, requestId, signal) {
  return request(`/api/v1/events/${eventId}/issues/${requestId}`, {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function getIssuanceStats(eventId, signal) {
  return request(`/api/v1/events/${eventId}/issuance-stats`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getIssuanceLogs(eventId, afterSequence, size, signal) {
  const query = new URLSearchParams({
    afterSequence: String(afterSequence),
    size: String(size),
  })
  return request(`/api/v1/events/${eventId}/issuance-logs?${query}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function createCoupon(payload, signal) {
  return request('/api/v1/coupons', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function getCoupons(keyword = '', signal) {
  const query = keyword.trim()
  const path = query
    ? `/api/v1/coupons?${new URLSearchParams({ keyword: query })}`
    : '/api/v1/coupons'

  return request(path, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getRecentCouponEvents(status, signal, size) {
  const query = new URLSearchParams()
  if (status) query.set('status', status)
  if (size) query.set('size', String(size))
  const path = query.size > 0
    ? `/api/v1/events/recent?${query}`
    : '/api/v1/events/recent'
  return request(path, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function createCouponEvent(couponId, payload, signal) {
  return request(`/api/v1/coupons/${couponId}/events`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function closeCouponEvent(eventId, signal) {
  return request(`/api/v1/events/${eventId}/close`, {
    method: 'PATCH',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function initializeCampaign(eventId, signal) {
  return request(`/internal/campaigns/${eventId}/init`, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function verifyAllConsistency(signal) {
  return request('/internal/consistency/verify', {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function getConsistencyChecks(scopeType, signal) {
  const query = new URLSearchParams({ scopeType })
  return request(`/api/v1/consistency/checks?${query}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function verifyConsistency(payload, signal) {
  return request('/api/v1/consistency/verifications', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export function stopConsistencyVerification(jobExecutionId, signal) {
  return request(`/api/v1/consistency/verifications/${jobExecutionId}/stop`, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function restartInterruptedConsistencyResult(resultId, signal) {
  return request(`/api/v1/consistency/verifications/results/${resultId}/restart`, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function getConsistencyVerificationExecution(jobExecutionId, signal) {
  return request(`/api/v1/consistency/verifications/${jobExecutionId}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getConsistencyResults({ status, page = 0, size = 100 } = {}, signal) {
  const query = new URLSearchParams({ page: String(page), size: String(size) })
  if (status) query.set('status', status)
  return request(`/api/v1/consistency/results?${query}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getConsistencyViolations(resultId, page = 0, size = 20, signal) {
  const query = new URLSearchParams({ page: String(page), size: String(size) })
  return request(`/api/v1/consistency/results/${resultId}/violations?${query}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getConsistencyRecoveryMethods(resultId, signal) {
  return request(`/api/v1/consistency/results/${resultId}/recovery-methods`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function recoverConsistency(resultId, action, signal) {
  return request(`/api/v1/consistency/results/${resultId}/recoveries`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ action }),
  })
}

export function getConsistencyRecoveries(page = 0, size = 100, signal) {
  const query = new URLSearchParams({ page: String(page), size: String(size) })
  return request(`/api/v1/consistency/recoveries?${query}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getConsistencySchedules(signal) {
  return request('/api/v1/consistency/schedules', {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function updateConsistencySchedule(schedulerName, intervalMs, signal) {
  return request(`/api/v1/consistency/schedules/${schedulerName}`, {
    method: 'PATCH',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ intervalMs }),
  })
}

export function getConsistencyInjectors(signal) {
  return request('/api/v1/consistency/injectors', {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function injectConsistencyViolation(checkName, eventId, signal) {
  return request('/api/v1/consistency/injections', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ checkName, eventId }),
  })
}

export function getCouponIssueId(eventId, userId, signal) {
  return request(`/api/v1/coupons/issues/lookup?eventId=${eventId}&userId=${userId}`, {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  })
}

export function useCoupon(issueId, userId, idempotencyKey, reason, signal) {
  return request(`/api/v1/coupons/${issueId}/use`, {
    method: 'PATCH',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      Accept: 'application/json',
    },
    body: JSON.stringify({ userId, reason }),
  })
}

export function cancelCoupon(issueId, userId, idempotencyKey, reason, signal) {
  return request(`/api/v1/coupons/${issueId}/cancel`, {
    method: 'PATCH',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      Accept: 'application/json',
    },
    body: JSON.stringify({ userId, reason }),
  })
}

export function expireCoupon(issueId, userId, idempotencyKey, reason, signal) {
  return request(`/api/v1/coupons/${issueId}/expire`, {
    method: 'PATCH',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      Accept: 'application/json',
    },
    body: JSON.stringify({ userId, reason }),
  })
}

export function getIssueFailures({ eventId, stage, status, requestId, page = 0, size = 20 } = {}, signal) {
  const query = new URLSearchParams({ page: String(page), size: String(size) })
  if (eventId) query.set('eventId', String(eventId))
  if (stage) query.set('stage', stage)
  if (status) query.set('status', status)
  if (requestId) query.set('requestId', requestId)

  return request(`/api/v1/issue-failures?${query}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getIssueFailureSummary(signal) {
  return request('/api/v1/issue-failures/summary', {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function getIssueFailureDetail(failureId, signal) {
  return request(`/api/v1/issue-failures/${failureId}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
}

export function executeIssueFailureAction(failureId, action, payload = {}, signal) {
  return request(`/api/v1/issue-failures/${failureId}/actions/${action}`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

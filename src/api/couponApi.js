const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

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
  } catch {
    throw new ApiError('NETWORK_ERROR', '백엔드 서버에 연결할 수 없습니다.')
  }

  let body
  try {
    body = await response.json()
  } catch {
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

export function issueCoupon(eventId, userId, idempotencyKey, signal) {
  return request(`/api/v1/events/${eventId}/issues`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ userId }),
  })
}

export function getIssueStatus(eventId, requestId) {
  return request(`/api/v1/events/${eventId}/issues/${requestId}`, {
    method: 'GET',
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

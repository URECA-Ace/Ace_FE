import { API_BASE_URL } from '../api/couponApi'

// 백엔드 SSE 스트림을 구독한다. 하트비트(SSE 주석 라인)는 EventSource가 이벤트로
// 전달하지 않으므로 별도 필터링이 필요 없고, 연결이 끊기면 브라우저가 자동으로 재연결한다.
export function subscribeNotifications(onNotification) {
  const source = new EventSource(`${API_BASE_URL}/api/v1/notifications/stream`)

  source.onmessage = (event) => {
    try {
      onNotification(JSON.parse(event.data))
    } catch {
      // JSON이 아닌 메시지는 무시
    }
  }

  return () => source.close()
}

// checkName은 Ace_BE의 ConsistencyCheck 구현체 클래스명을 그대로 사용한다.
// IntegrityReportTab(결과 테이블)과 ConsistencyBatchStatusBanner(진행 배너)가 같은
// 매핑을 공유해서, 어디서 보여주든 항상 한글 라벨로 표시되게 한다.
export const CHECK_LABELS = {
  StockConsistencyCheck: '재고 정합성',
  RedisMysqlLossConsistencyCheck: 'Redis-MySQL 유실',
  DuplicateConsistencyCheck: '중복 발급',
  DuplicateSequenceConsistencyCheck: '발급 순번 중복',
  StateMachineConsistencyCheck: '상태 전이',
  CouponIssueStructuralConsistencyCheck: '발급 구조 정합성',
  CouponIssueHistoryStateConsistencyCheck: '발급 이력 상태 정합성',
  CouponHistoryStructuralConsistencyCheck: '쿠폰 이력 구조 정합성',
  CouponExpirationLagConsistencyCheck: '쿠폰 만료 지연',
  IssueHistoryTimeSyncConsistencyCheck: '이력 시간 동기화',
}

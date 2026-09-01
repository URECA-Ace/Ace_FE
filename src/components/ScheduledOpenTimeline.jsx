import './ScheduledOpenTimeline.css'

const STATUS_LABELS = {
  SCHEDULED: '예약 오픈',
  OPEN: '발급 중',
  SOLD_OUT: '재고 소진',
  CLOSED: '마감',
}

function ScheduledOpenTimeline({ campaigns, closingEventId, formatDate, onClose }) {
  return (
    <section className="status-transition-list" aria-labelledby="campaign-schedule-title">
      <div className="transition-heading">
        <div className="transition-heading-copy">
          <span className="section-number">03</span>
          <div>
            <strong id="campaign-schedule-title">예약 오픈 일정 · 상태 관리</strong>
            <small>최근 발급 회차의 일정과 현재 상태를 한곳에서 관리합니다.</small>
          </div>
        </div>
        <span>RECENT COUPONS</span>
      </div>

      {campaigns.length > 0 ? (
        <div className="campaign-schedule-list">
          {campaigns.map((campaign) => {
            const statusClass = campaign.status.toLowerCase().replace('_', '-')
            return (
              <article className={`campaign-schedule-card ${statusClass}`} key={campaign.eventId}>
                <div className="campaign-schedule-identity">
                  <span className={`transition-dot ${statusClass}`} />
                  <div>
                    <strong>{campaign.couponName} - {campaign.round}회차</strong>
                    <small>{campaign.round ?? '-'}회차 · {campaign.status ?? '상태 확인 필요'}</small>
                  </div>
                  <span className={`campaign-status ${statusClass}`}>
                    {STATUS_LABELS[campaign.status] ?? campaign.status}
                  </span>
                </div>
                <dl className="campaign-schedule-details">
                  {campaign.status === 'SCHEDULED' ? (
                    <>
                      <div><dt>오픈 시각</dt><dd>{formatDate(campaign.openAt)}</dd></div>
                      <div><dt>마감 시각</dt><dd>{formatDate(campaign.closeAt)}</dd></div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>현재 상태</dt>
                        <dd>{STATUS_LABELS[campaign.status] ?? campaign.status}</dd>
                      </div>
                      <div className="campaign-close-cell">
                        {campaign.status === 'OPEN' ? (
                          <>
                            <div className="campaign-close-schedule">
                              <dt>예약 마감 시각</dt>
                              <dd>{formatDate(campaign.closeAt)}</dd>
                            </div>
                            <button
                              type="button"
                              className="campaign-close-button"
                              disabled={String(closingEventId) === String(campaign.eventId)}
                              onClick={() => onClose(campaign)}
                            >
                              {String(closingEventId) === String(campaign.eventId) ? '마감 중…' : '마감'}
                            </button>
                          </>
                        ) : (
                          <div>
                            <dt>마감 결과</dt>
                            <dd className="campaign-closed-copy">
                              {campaign.status === 'SOLD_OUT' ? '재고 소진으로 발급 종료' : '마감 완료'}
                            </dd>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </dl>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="transition-empty">
          <span>◷</span>
          <strong>표시할 발급 회차가 없습니다</strong>
          <p>쿠폰 이벤트를 생성하면 일정과 마감 제어가 표시됩니다.</p>
        </div>
      )}

      <p className="schedule-note">
        예약 마감 시각에는 자동으로 CLOSED 상태로 전환되며, 그 전에도 마감 버튼으로 발급을 종료할 수 있습니다.
      </p>
    </section>
  )
}

export default ScheduledOpenTimeline

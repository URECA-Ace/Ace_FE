import { useEffect, useState } from 'react'
import { ApiError, closeCouponEvent, createCoupon, createCouponEvent, initializeCampaign } from '../api/couponApi'
import ScheduledOpenTimeline from '../components/ScheduledOpenTimeline'

function toDateTimeLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('')
}

function createDefaultEventForm() {
  const now = new Date()
  const open = new Date(now.getTime() - 60_000)
  const close = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  return {
    openAt: toDateTimeLocal(open),
    closeAt: toDateTimeLocal(close),
  }
}

const DEFAULT_EVENT_FORM = createDefaultEventForm()

function CampaignManagementTab({
  coupons,
  selectedCouponId,
  setSelectedCouponId,
  selectedCouponSnapshot,
  setSelectedCouponSnapshot,
  loadingCoupons,
  couponSearch,
  setCouponSearch,
  createdCoupon,
  setCreatedCoupon,
  setCoupons,
  couponRounds,
  setCouponRounds,
  createdEvent,
  setCreatedEvent,
  recentCampaigns,
  setRecentCampaigns,
  setOpenCampaigns,
  setOperationCampaign,
  setEventId,
  setLoadEventId,
  setActiveTab,
  setNotice,
  campaignLabel,
  formatDate,
  errorLabels,
}) {
  const [couponName, setCouponName] = useState('U+ 데이터 하루 무제한 쿠폰')
  const [couponType, setCouponType] = useState('DATA_UNLIMITED')
  const [couponValue, setCouponValue] = useState('')
  const [validHours, setValidHours] = useState('24')
  const [creatingCoupon, setCreatingCoupon] = useState(false)
  const [couponPickerOpen, setCouponPickerOpen] = useState(false)
  const [totalStock, setTotalStock] = useState('10000')
  const [scheduleMode, setScheduleMode] = useState('immediate')
  const [openAt, setOpenAt] = useState(DEFAULT_EVENT_FORM.openAt)
  const [closeAt, setCloseAt] = useState(DEFAULT_EVENT_FORM.closeAt)
  const [creatingEvent, setCreatingEvent] = useState(false)
  const [campaignPickerOpen, setCampaignPickerOpen] = useState(false)
  const [initializationEventId, setInitializationEventId] = useState('')
  const [initializingCampaign, setInitializingCampaign] = useState(false)
  const [initializationResult, setInitializationResult] = useState(null)
  const [closingEventId, setClosingEventId] = useState(null)

  const selectedCoupon = coupons.find(
    (coupon) => String(coupon.couponId) === String(selectedCouponId),
  ) ?? (String(selectedCouponSnapshot?.couponId) === String(selectedCouponId)
    ? selectedCouponSnapshot
    : null) ?? createdCoupon
  const nextCouponRound = couponRounds[selectedCouponId] ?? 1
  const campaignCandidates = recentCampaigns

  const [previousRecentCampaigns, setPreviousRecentCampaigns] = useState(recentCampaigns)
  if (recentCampaigns !== previousRecentCampaigns) {
    setPreviousRecentCampaigns(recentCampaigns)
    setInitializationEventId((current) => (
      recentCampaigns.some((campaign) => String(campaign.eventId) === String(current))
        ? current
        : String(recentCampaigns[0]?.eventId ?? '')
    ))
  }

  useEffect(() => {
    if (!couponPickerOpen) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') setCouponPickerOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [couponPickerOpen])

  useEffect(() => {
    if (!campaignPickerOpen) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') setCampaignPickerOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [campaignPickerOpen])

  async function createCouponProduct(event) {
    event.preventDefault()
    const parsedValue = Number(couponValue)
    const parsedValidHours = Number(validHours)

    if (!couponName.trim()) {
      setNotice({ tone: 'danger', message: '쿠폰 이름을 입력하세요.' })
      return
    }
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
      setNotice({ tone: 'danger', message: '혜택 값은 0 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedValidHours) || parsedValidHours <= 0) {
      setNotice({ tone: 'danger', message: '발급 후 유효 시간은 1시간 이상이어야 합니다.' })
      return
    }

    setCreatingCoupon(true)
    setNotice(null)
    try {
      const data = await createCoupon({
        couponName: couponName.trim(),
        type: couponType,
        value: parsedValue,
        validHours: parsedValidHours,
      })
      setCreatedCoupon(data)
      setCoupons((current) => [
        data,
        ...current.filter((coupon) => String(coupon.couponId) !== String(data.couponId)),
      ].slice(0, 6))
      setSelectedCouponId(String(data.couponId))
      setSelectedCouponSnapshot(data)
      setCouponSearch('')
      setCreatedEvent(null)
      setOperationCampaign(null)
      setEventId('')
      setLoadEventId('')
      setNotice({
        tone: 'success',
        toast: true,
        message: `쿠폰 상품 ${data.couponId}번이 생성되었습니다. 이제 1회차 발급 일정을 설정하세요.`,
      })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({ tone: 'danger', message: errorLabels[apiError.code] ?? apiError.message })
    } finally {
      setCreatingCoupon(false)
    }
  }

  async function createEvent(event) {
    event.preventDefault()
    const parsedCouponId = Number(selectedCoupon?.couponId)
    const parsedTotalStock = Number(totalStock)
    const openDate = scheduleMode === 'immediate'
      ? new Date(Date.now() - 60_000)
      : new Date(openAt)
    const closeDate = new Date(closeAt)

    if (!Number.isSafeInteger(parsedCouponId) || parsedCouponId <= 0) {
      setNotice({ tone: 'danger', message: '쿠폰 ID는 1 이상의 정수여야 합니다.' })
      return
    }
    if (!Number.isSafeInteger(parsedTotalStock) || parsedTotalStock <= 0) {
      setNotice({ tone: 'danger', message: '전체 재고는 1 이상의 정수여야 합니다.' })
      return
    }
    if (Number.isNaN(openDate.getTime()) || Number.isNaN(closeDate.getTime())) {
      setNotice({ tone: 'danger', message: '오픈 시각과 마감 시각을 모두 입력하세요.' })
      return
    }
    if (closeDate <= openDate) {
      setNotice({ tone: 'danger', message: '마감 시각은 오픈 시각보다 늦어야 합니다.' })
      return
    }

    setCreatingEvent(true)
    setNotice(null)
    try {
      const data = await createCouponEvent(parsedCouponId, {
        totalStock: parsedTotalStock,
        openAt: openDate.toISOString(),
        closeAt: closeDate.toISOString(),
      })

      const campaign = { ...data, couponName: selectedCoupon.couponName }
      const newEventId = campaign.eventId
      setCreatedEvent(campaign)
      setRecentCampaigns((current) => [
        campaign,
        ...current.filter((item) => String(item.eventId) !== String(campaign.eventId)),
      ].slice(0, 6))
      if (campaign.status === 'OPEN') {
        setOpenCampaigns((current) => [
          campaign,
          ...current.filter((item) => String(item.eventId) !== String(campaign.eventId)),
        ].slice(0, 6))
      }
      if (Number.isSafeInteger(Number(campaign.round))) {
        setCouponRounds((current) => ({
          ...current,
          [parsedCouponId]: Number(campaign.round) + 1,
        }))
      }
      setOperationCampaign(campaign)
      if (newEventId) {
        setEventId(String(newEventId))
        if (campaign.status === 'OPEN') setLoadEventId(String(newEventId))
        setInitializationEventId(String(newEventId))
      }
      setNotice({
        tone: 'success',
        toast: true,
        message: `쿠폰 이벤트 ${newEventId ?? '-'}번이 생성되고 Redis 재고가 초기화되었습니다. 발급 운영으로 이동했습니다.`,
      })
      setActiveTab('operations')
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: errorLabels[apiError.code] ?? apiError.message,
      })
    } finally {
      setCreatingEvent(false)
    }
  }

  async function initializeEvent(event) {
    event.preventDefault()
    const parsedEventId = Number(initializationEventId)

    if (!Number.isSafeInteger(parsedEventId) || parsedEventId <= 0) {
      setNotice({ tone: 'danger', message: '초기화할 쿠폰 ID는 1 이상의 정수여야 합니다.' })
      return
    }

    setInitializingCampaign(true)
    setInitializationResult(null)
    setNotice(null)
    try {
      const data = await initializeCampaign(parsedEventId)
      const campaign = recentCampaigns.find(
        (item) => Number(item.eventId) === parsedEventId,
      )
      const initializedCampaign = { ...campaign, ...data }
      setInitializationResult(data)
      setOperationCampaign(initializedCampaign)
      setEventId(String(data.eventId))
      setLoadEventId(String(data.eventId))
      setNotice({
        tone: 'success',
        message: `쿠폰 ${data.eventId}번 Redis 초기화 결과: ${data.result}`,
      })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({
        tone: 'danger',
        message: errorLabels[apiError.code] ?? apiError.message,
      })
    } finally {
      setInitializingCampaign(false)
    }
  }

  async function closeEvent(campaign) {
    if (!window.confirm('쿠폰을 마감하시겠습니까?')) return

    setClosingEventId(campaign.eventId)
    setNotice(null)
    try {
      const data = await closeCouponEvent(campaign.eventId)
      const closedCampaign = { ...campaign, ...data }
      const nextOpenCampaign = recentCampaigns.find(
        (item) => item.status === 'OPEN' && String(item.eventId) !== String(campaign.eventId),
      )

      setRecentCampaigns((current) => current.map((item) => (
        String(item.eventId) === String(campaign.eventId) ? closedCampaign : item
      )))
      setOpenCampaigns((current) => current.filter(
        (item) => String(item.eventId) !== String(campaign.eventId),
      ))
      setCreatedEvent((current) => (
        String(current?.eventId) === String(campaign.eventId) ? closedCampaign : current
      ))
      setOperationCampaign((current) => (
        String(current?.eventId) === String(campaign.eventId)
          ? nextOpenCampaign ?? closedCampaign
          : current
      ))
      setEventId((current) => (
        String(current) === String(campaign.eventId)
          ? String(nextOpenCampaign?.eventId ?? '')
          : current
      ))
      setLoadEventId((current) => (
        String(current) === String(campaign.eventId)
          ? String(nextOpenCampaign?.eventId ?? '')
          : current
      ))
      setNotice({
        tone: 'success',
        toast: true,
        message: `${campaign.couponName} ${campaign.round}회차 쿠폰을 마감했습니다.`,
      })
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('NETWORK_ERROR')
      setNotice({ tone: 'danger', message: errorLabels[apiError.code] ?? apiError.message })
    } finally {
      setClosingEventId(null)
    }
  }

  return (
    <>
      <section className="campaign-management" aria-labelledby="campaign-management-title">
        <div className="tab-heading">
          <div>
            <span className="eyebrow">COUPON MANAGEMENT</span>
            <h2 id="campaign-management-title">쿠폰 이벤트와 예약 오픈 관리</h2>
            <p>쿠폰을 발급할 이벤트를 만들고, 오픈 및 마감 일정을 관리합니다.</p>
          </div>
          <span className="api-chip">EVENT CONFIGURATION</span>
        </div>

        <ol className="demo-flow" aria-label="쿠폰 발급 시연 순서">
          <li className="active">
            <span>1</span>
            <div><strong>쿠폰 상품 생성</strong><small>이름 · 종류 · 혜택 · 유효시간</small></div>
          </li>
          <li>
            <span>2</span>
            <div><strong>회차와 예약 생성</strong><small>1회차부터 서버 자동 배정</small></div>
          </li>
          <li>
            <span>3</span>
            <div><strong>발급 운영</strong><small>한 장 발급 / 20,000명 요청</small></div>
          </li>
        </ol>

        <section className="panel coupon-create-panel" aria-labelledby="coupon-create-title">
          <div className="panel-heading">
            <div>
              <span className="section-number">00</span>
              <h2 id="coupon-create-title">쿠폰 상품 생성</h2>
              <p className="panel-description">발급할 쿠폰의 기본 정보와 혜택을 먼저 등록합니다.</p>
            </div>
          </div>
          <form className="event-create-form coupon-product-form" onSubmit={createCouponProduct}>
            <label>
              쿠폰 이름
              <input value={couponName} maxLength="100" onChange={(event) => setCouponName(event.target.value)} required />
            </label>
            <label>
              쿠폰 종류
              <select value={couponType} onChange={(event) => setCouponType(event.target.value)}>
                <option value="DATA_UNLIMITED">데이터 무제한</option>
                <option value="DATA_AMOUNT">데이터 용량</option>
                <option value="DISCOUNT">요금 할인</option>
              </select>
            </label>
            <label>
              혜택 값
              <input type="number" min="0" step="1" value={couponValue} onChange={(event) => setCouponValue(event.target.value)} placeholder="무제한 쿠폰은 0으로 설정" required />
            </label>
            <label>
              발급 후 유효 시간
              <div className="input-with-unit">
                <input type="number" min="1" step="1" value={validHours} onChange={(event) => setValidHours(event.target.value)} required />
                <span>시간</span>
              </div>
            </label>
            <button className="primary-button" type="submit" disabled={creatingCoupon}>
              {creatingCoupon ? '쿠폰 생성 중…' : '쿠폰 상품 생성'}
              <span>→</span>
            </button>
          </form>
          {createdCoupon && (
            <div className="created-event-summary" role="status">
              <strong>쿠폰 #{createdCoupon.couponId}</strong>
              <span>{createdCoupon.couponName}</span>
              <small>{createdCoupon.type} · 혜택 {createdCoupon.value} · 발급 후 {createdCoupon.validHours}시간</small>
            </div>
          )}
        </section>

        <section className="panel event-create-panel" aria-labelledby="event-create-title">
          <div className="panel-heading">
            <div>
              <span className="section-number">01</span>
              <h2 id="event-create-title">발급 회차와 예약 오픈 생성</h2>
              <p className="panel-description">쿠폰을 선택하고 재고와 발급 시작 방식을 설정해 회차를 만듭니다.</p>
            </div>
          </div>
          <div className="coupon-catalog" aria-labelledby="coupon-catalog-title">
            <div className="catalog-heading">
              <div>
                <strong id="coupon-catalog-title">발급할 쿠폰 선택</strong>
                <small>선택된 쿠폰의 회차와 재고를 설정합니다.</small>
              </div>
            </div>
            <button
              type="button"
              className="coupon-picker-trigger"
              onClick={() => setCouponPickerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={couponPickerOpen}
            >
              <span className="coupon-picker-trigger-icon" aria-hidden="true">⌕</span>
              <span>{selectedCoupon ? selectedCoupon.couponName : '쿠폰을 검색해서 선택하세요'}</span>
              <span className="coupon-picker-trigger-arrow" aria-hidden="true">›</span>
            </button>
          </div>
          <form className="event-create-form" onSubmit={createEvent}>
            <label>
              대상 쿠폰
              <input
                value={selectedCoupon ? `#${selectedCoupon.couponId} · ${selectedCoupon.couponName}` : ''}
                readOnly
                aria-readonly="true"
                placeholder="위 목록에서 쿠폰을 선택하세요"
              />
            </label>
            <label>
              회차
              <input
                value={`${nextCouponRound}회차`}
                readOnly
                aria-readonly="true"
                title="쿠폰별 마지막 회차 다음 번호가 서버 트랜잭션에서 배정됩니다."
              />
            </label>
            <label>
              전체 재고
              <input type="number" min="1" step="1" value={totalStock} onChange={(event) => setTotalStock(event.target.value)} required />
            </label>
            <fieldset className="schedule-settings">
              <legend>예약 오픈 설정</legend>
              <div className="schedule-mode-options">
                <label>
                  <input
                    type="radio"
                    name="schedule-mode"
                    value="immediate"
                    checked={scheduleMode === 'immediate'}
                    onChange={(event) => setScheduleMode(event.target.value)}
                  />
                  지금 바로 발급
                </label>
                <label>
                  <input
                    type="radio"
                    name="schedule-mode"
                    value="scheduled"
                    checked={scheduleMode === 'scheduled'}
                    onChange={(event) => setScheduleMode(event.target.value)}
                  />
                  예약 오픈
                </label>
              </div>
              <p>{scheduleMode === 'scheduled' ? '설정한 오픈 시각부터 쿠폰 발급이 가능해집니다.' : '생성 즉시 쿠폰 발급이 가능한 상태로 설정됩니다.'}</p>
              <div className="schedule-settings-fields">
                <label>
                  오픈 시각
                  <input type="datetime-local" value={openAt} onChange={(event) => setOpenAt(event.target.value)} disabled={scheduleMode !== 'scheduled'} required={scheduleMode === 'scheduled'} />
                </label>
                <label>
                  마감 시각
                  <input type="datetime-local" value={closeAt} onChange={(event) => setCloseAt(event.target.value)} disabled={scheduleMode !== 'scheduled'} required={scheduleMode === 'scheduled'} />
                </label>
              </div>
            </fieldset>
            <button className="primary-button" type="submit" disabled={creatingEvent || !selectedCoupon}>
              {creatingEvent ? '이벤트 생성 중…' : '쿠폰 이벤트 생성'}
              <span>→</span>
            </button>
          </form>
          {createdEvent && (
            <div className="created-event-summary" role="status">
              <strong>이벤트 #{createdEvent.eventId}</strong>
              <span>{createdEvent.status} · {createdEvent.remainingStock?.toLocaleString()}장 대기</span>
              <small>{formatDate(createdEvent.openAt)} 오픈 · {formatDate(createdEvent.closeAt)} 마감</small>
            </div>
          )}
        </section>

        <ScheduledOpenTimeline
          campaigns={recentCampaigns}
          closingEventId={closingEventId}
          formatDate={formatDate}
          onClose={closeEvent}
        />

        <section className="panel campaign-initialization" aria-labelledby="campaign-initialization-title">
          <div className="panel-heading">
            <div>
              <span className="section-number">02</span>
              <h2 id="campaign-initialization-title">Redis 쿠폰 초기화 복구 · 장애 대응 전용</h2>
            </div>
          </div>
          <div className="initialization-layout">
            <div className="initialization-copy">
              <strong>일반 발급에서는 실행하지 않습니다.</strong>
              <p>
                위의 쿠폰 생성 기능이 DB 저장과 Redis 초기화를 함께 처리합니다.
                이 기능은 생성 응답이 초기화 실패로 끝난 경우에만 사용합니다.
                백엔드에서 <code>coupon.issue.admin.enabled=true</code>로 노출한 시연 환경에서만 동작합니다.
              </p>
            </div>
            <form className="initialization-form" onSubmit={initializeEvent}>
              <label>초기화할 쿠폰</label>
              <div>
                <button
                  type="button"
                  className="coupon-picker-trigger campaign-picker-trigger"
                  onClick={() => setCampaignPickerOpen(true)}
                  aria-haspopup="dialog"
                  aria-expanded={campaignPickerOpen}
                >
                  <span className="coupon-picker-trigger-icon" aria-hidden="true">⌕</span>
                  <span>{campaignLabel(recentCampaigns.find((campaign) => String(campaign.eventId) === String(initializationEventId)))}</span>
                  <span className="coupon-picker-trigger-arrow" aria-hidden="true">›</span>
                </button>
                <button className="secondary-button" type="submit" disabled={initializingCampaign || !initializationEventId}>
                  {initializingCampaign ? 'Redis 재초기화 중…' : 'Redis 재초기화 실행'}
                </button>
              </div>
            </form>
          </div>
          {initializationResult && (
            <dl className="initialization-result" aria-label="Redis 초기화 결과">
              <div><dt>이벤트</dt><dd>#{initializationResult.eventId}</dd></div>
              <div><dt>결과</dt><dd>{initializationResult.result}</dd></div>
              <div><dt>초기 재고</dt><dd>{initializationResult.totalStock?.toLocaleString()}장</dd></div>
              <div><dt>발급 기간</dt><dd>{formatDate(initializationResult.openAt)} ~ {formatDate(initializationResult.closeAt)}</dd></div>
            </dl>
          )}
        </section>
      </section>

      {couponPickerOpen && (
        <div
          className="coupon-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCouponPickerOpen(false)
          }}
        >
          <section className="coupon-picker-modal" role="dialog" aria-modal="true" aria-labelledby="coupon-picker-title">
            <div className="coupon-picker-header">
              <div>
                <span className="eyebrow">COUPON SELECT</span>
                <h2 id="coupon-picker-title">발급할 쿠폰 선택</h2>
                <p>쿠폰 제목을 검색하거나 최근 생성한 쿠폰을 선택하세요.</p>
              </div>
              <button type="button" className="coupon-picker-close" onClick={() => setCouponPickerOpen(false)} aria-label="쿠폰 선택 창 닫기">×</button>
            </div>
            <label className="coupon-picker-search">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                value={couponSearch}
                onChange={(event) => setCouponSearch(event.target.value)}
                placeholder="쿠폰 제목 검색"
                aria-label="쿠폰 제목 검색"
                autoFocus
              />
            </label>
            <div className="coupon-picker-list-heading">
              <strong>{couponSearch.trim() ? '검색 결과' : '최근 생성한 쿠폰'}</strong>
              <small>{coupons.length.toLocaleString()}개</small>
            </div>
            {loadingCoupons ? (
              <p className="catalog-empty">쿠폰 목록을 불러오는 중입니다.</p>
            ) : coupons.length > 0 ? (
              <div className="coupon-catalog-list coupon-picker-list">
                {coupons.map((coupon) => (
                  <button
                    key={coupon.couponId}
                    type="button"
                    className={`coupon-catalog-item ${String(coupon.couponId) === String(selectedCouponId) ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedCouponId(String(coupon.couponId))
                      setSelectedCouponSnapshot(coupon)
                      setCreatedEvent(null)
                      setCouponPickerOpen(false)
                    }}
                  >
                    <span>
                      <strong>{coupon.couponName}</strong>
                      <small>#{coupon.couponId} · {coupon.type}</small>
                    </span>
                    <span className="catalog-check" aria-hidden="true">{String(coupon.couponId) === String(selectedCouponId) ? '✓' : '○'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="catalog-empty">검색 결과에 맞는 쿠폰이 없습니다.</p>
            )}
            <button type="button" className="coupon-picker-cancel" onClick={() => setCouponPickerOpen(false)}>닫기</button>
          </section>
        </div>
      )}

      {campaignPickerOpen && (
        <div
          className="coupon-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCampaignPickerOpen(false)
          }}
        >
          <section className="coupon-picker-modal" role="dialog" aria-modal="true" aria-labelledby="campaign-picker-title">
            <div className="coupon-picker-header">
              <div>
                <span className="eyebrow">COUPON SELECT</span>
                <h2 id="campaign-picker-title">초기화할 쿠폰 선택</h2>
                <p>최근 생성한 발급 회차를 선택한 뒤 Redis 재초기화를 실행하세요.</p>
              </div>
              <button type="button" className="coupon-picker-close" onClick={() => setCampaignPickerOpen(false)} aria-label="쿠폰 선택 창 닫기">×</button>
            </div>
            {campaignCandidates.length > 0 ? (
              <div className="coupon-catalog-list coupon-picker-list">
                {campaignCandidates.map((campaign) => (
                  <button
                    key={campaign.eventId}
                    type="button"
                    className={`coupon-catalog-item ${String(campaign.eventId) === String(initializationEventId) ? 'selected' : ''}`}
                    onClick={() => {
                      setInitializationEventId(String(campaign.eventId))
                      setCampaignPickerOpen(false)
                    }}
                  >
                    <span>
                      <strong>{campaignLabel(campaign)}</strong>
                      <small>{campaign.totalStock?.toLocaleString() ?? '-'}장 · {campaign.status ?? '상태 확인 필요'}</small>
                    </span>
                    <span className="catalog-check" aria-hidden="true">{String(campaign.eventId) === String(initializationEventId) ? '✓' : '○'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="catalog-empty">선택할 쿠폰이 없습니다. 먼저 발급 회차를 생성하세요.</p>
            )}
            <button type="button" className="coupon-picker-cancel" onClick={() => setCampaignPickerOpen(false)}>닫기</button>
          </section>
        </div>
      )}
    </>
  )
}

export default CampaignManagementTab

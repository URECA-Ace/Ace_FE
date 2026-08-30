import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  getConsistencyChecks,
  getConsistencyRecoveries,
  getConsistencyRecoveryMethods,
  getConsistencyResults,
  getConsistencyViolations,
  getRecentCouponEvents,
  recoverConsistency,
  verifyConsistency,
} from '../api/couponApi'
import GrafanaMetricCard from '../components/GrafanaMetricCard'
import { CHECK_LABELS } from '../constants/consistencyChecks'
import { subscribeNotifications } from '../utils/notificationStream'
import './IntegrityReportTab.css'

const RECENT_RESULT_PAGE_SIZE = 8
const RECOVERY_HISTORY_LIMIT = 10
const VIOLATION_PAGE_SIZE = 20
const PAGE_GROUP_SIZE = 10

const SCOPE_TYPES = ['EVENT', 'AS_OF_RANGE', 'ALL']

const TRIGGER_LABELS = {
  EVENT_TRIGGER: '이벤트 발생 시',
  SCHEDULED: '스케줄러',
  ON_DEMAND: '수동 실행',
  RECOVERY_REVALIDATION: '복구 재검증',
}

const RESULT_STATUS_META = {
  PASS: { label: '정상', tone: 'success' },
  FAIL: { label: '실패', tone: 'danger' },
  ERROR: { label: '에러', tone: 'waiting' },
}

const RECOVERY_STATUS_META = {
  NONE: { label: '복구 대기', tone: 'neutral' },
  IN_PROGRESS: { label: '복구 진행 중', tone: 'waiting' },
  SUCCESS: { label: '복구 완료', tone: 'success' },
  FAIL: { label: '복구 실패', tone: 'danger' },
}

const SCOPE_LABELS = {
  EVENT: '이벤트 지정',
  AS_OF_RANGE: '기간 지정',
  ALL: '전체',
}

const CHECK_FILTER_OPTIONS = Object.entries(CHECK_LABELS).map(([value, label]) => ({ value, label }))
const SCOPE_FILTER_OPTIONS = SCOPE_TYPES.map((value) => ({ value, label: SCOPE_LABELS[value] ?? value }))
const STATUS_FILTER_OPTIONS = Object.entries(RESULT_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))

const RESULT_SEARCH_FIELDS = [
  { id: 'checkName', label: '검증 항목' },
  { id: 'status', label: '상태' },
  { id: 'scope', label: '대상' },
]

// 정합성 검증 에러/실패 패널은 상태가 이미 고정되어 있으므로 검색 항목에서 상태를 제외한다.
const RESULT_SEARCH_FIELDS_FIXED_STATUS = RESULT_SEARCH_FIELDS.filter((field) => field.id !== 'status')

// 복구 이력에는 대상(scope) 정보가 없으므로 검증 항목/상태(복구 결과)만 검색 항목으로 제공한다.
const RECOVERY_SEARCH_FIELDS = [
  { id: 'checkName', label: '검증 항목' },
  { id: 'status', label: '상태' },
]

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function scopeLabel(result) {
  if (result.scopeType === 'EVENT') return `이벤트 #${result.eventId}`
  if (result.scopeType === 'AS_OF_RANGE') return '시간 구간'
  return '전체'
}

// FAIL 결과가 복구까지 끝난 경우, 최근 검증 결과 표에는 원래 상태(실패) 대신 복구 결과를 보여준다.
function recentStatusMeta(result) {
  if (result.status === 'FAIL' && result.recoveryStatus === 'SUCCESS') return RECOVERY_STATUS_META.SUCCESS
  if (result.status === 'FAIL' && result.recoveryStatus === 'FAIL') return RECOVERY_STATUS_META.FAIL
  return RESULT_STATUS_META[result.status]
}

function matchesResultField(result, field, needle) {
  if (field === 'checkName') return (CHECK_LABELS[result.checkName] ?? result.checkName).toLowerCase().includes(needle)
  if (field === 'status') return recentStatusMeta(result).label.toLowerCase().includes(needle)
  if (field === 'scope') return scopeLabel(result).toLowerCase().includes(needle)
  return true
}

function filterResults(list, field, text) {
  const needle = text.trim().toLowerCase()
  if (!needle) return list
  return list.filter((result) => matchesResultField(result, field, needle))
}

function matchesRecoveryField(entry, field, needle) {
  if (field === 'checkName') return (CHECK_LABELS[entry.checkName] ?? entry.checkName).toLowerCase().includes(needle)
  if (field === 'status') return (RECOVERY_STATUS_META[entry.status]?.label ?? '').toLowerCase().includes(needle)
  return true
}

function filterRecoveryHistory(list, field, text) {
  const needle = text.trim().toLowerCase()
  if (!needle) return list
  return list.filter((entry) => matchesRecoveryField(entry, field, needle))
}

// 패널 우측 상단의 검색 항목 탭 + 텍스트 검색 UI. 항목별로 검색 대상 필드가 다르다.
function FieldSearch({ fields, activeField, onFieldChange, value, onValueChange, placeholder }) {
  return (
    <div className="field-search">
      <div className="field-search-tabs" role="tablist">
        {fields.map((field) => (
          <button
            key={field.id}
            type="button"
            role="tab"
            aria-selected={activeField === field.id}
            className={`field-search-tab ${activeField === field.id ? 'active' : ''}`}
            onClick={() => onFieldChange(field.id)}
          >
            {field.label}
          </button>
        ))}
      </div>
      <label className="field-search-input">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
        />
      </label>
    </div>
  )
}

function IntegrityReportTab({ allBatchRunning }) {
  const [results, setResults] = useState([])
  const [selectedMethodByResult, setSelectedMethodByResult] = useState({})
  const [recoveryHistory, setRecoveryHistory] = useState([])
  const [recoveryMethodsByResult, setRecoveryMethodsByResult] = useState({})
  const [recoveringResultId, setRecoveringResultId] = useState(null)
  const [reportLoading, setReportLoading] = useState(true)
  const [detailResult, setDetailResult] = useState(null)
  const [detailViolations, setDetailViolations] = useState(null)
  const [detailViolationPage, setDetailViolationPage] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)
  const [recentPage, setRecentPage] = useState(0)
  const [recentPageData, setRecentPageData] = useState({
    content: [], page: 0, size: RECENT_RESULT_PAGE_SIZE,
    totalElements: 0, totalPages: 0, hasNext: false,
  })
  const [scopeCatalogs, setScopeCatalogs] = useState({})
  const [selectedScope, setSelectedScope] = useState('EVENT')
  const [selectedChecks, setSelectedChecks] = useState([])
  const [eventId, setEventId] = useState('')
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  const [launcherOpen, setLauncherOpen] = useState(true)
  const [loadingChecks, setLoadingChecks] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [verificationNotice, setVerificationNotice] = useState(null)
  const [recentSearchField, setRecentSearchField] = useState('checkName')
  const [recentSearchText, setRecentSearchText] = useState('')
  const [errorSearchField, setErrorSearchField] = useState('checkName')
  const [errorSearchText, setErrorSearchText] = useState('')
  const [failSearchField, setFailSearchField] = useState('checkName')
  const [failSearchText, setFailSearchText] = useState('')
  const [recoverySearchField, setRecoverySearchField] = useState('checkName')
  const [recoverySearchText, setRecoverySearchText] = useState('')
  const [recentEvents, setRecentEvents] = useState([])
  const [eventPickerOpen, setEventPickerOpen] = useState(false)
  const [eventSearchText, setEventSearchText] = useState('')

  const refreshReportData = useCallback(async (signal, requestedPage = 0) => {
    setReportLoading(true)
    try {
      const [recentPage, errorPage, failPage, recoveryPage] = await Promise.all([
        getConsistencyResults({ page: requestedPage, size: RECENT_RESULT_PAGE_SIZE }, signal),
        getConsistencyResults({ status: 'ERROR', page: 0, size: RECENT_RESULT_PAGE_SIZE }, signal),
        getConsistencyResults({ status: 'FAIL', page: 0, size: RECENT_RESULT_PAGE_SIZE }, signal),
        getConsistencyRecoveries(0, 100, signal),
      ])
      const history = recoveryPage.content.map((entry) => ({
        ...entry,
        methodLabel: entry.actionLabel,
        requestedAt: entry.createdAt,
        finishedAt: entry.createdAt,
      }))
      const latestRecoveryByResult = new Map()
      history.forEach((entry) => {
        if (!latestRecoveryByResult.has(entry.verificationResultId)) {
          latestRecoveryByResult.set(entry.verificationResultId, entry.status)
        }
      })
      const resultById = new Map(
        [...recentPage.content, ...errorPage.content, ...failPage.content]
          .map((result) => [result.id, result]),
      )
      const normalizedResults = [...resultById.values()]
        .sort((left, right) => new Date(right.executedAt) - new Date(left.executedAt))
        .map((result) => ({
        ...result,
        recoveryStatus: result.status === 'FAIL'
          ? (latestRecoveryByResult.get(result.id) ?? 'NONE')
          : null,
        }))
      setResults(normalizedResults)
      setRecentPageData({
        ...recentPage,
        content: recentPage.content.map((result) => ({
          ...result,
          recoveryStatus: result.status === 'FAIL'
            ? (latestRecoveryByResult.get(result.id) ?? result.recoveryStatus ?? 'NONE')
            : null,
        })),
      })
      setRecoveryHistory(history.slice(0, RECOVERY_HISTORY_LIMIT))

      const failedResults = normalizedResults.filter((result) => result.status === 'FAIL')
      const methodEntries = await Promise.all(failedResults.map(async (result) => [
        result.id,
        await getConsistencyRecoveryMethods(result.id, signal),
      ]))
      setRecoveryMethodsByResult(Object.fromEntries(methodEntries))
    } finally {
      if (!signal?.aborted) setReportLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!eventPickerOpen) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') setEventPickerOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [eventPickerOpen])

  useEffect(() => {
    const controller = new AbortController()

    async function loadTabData() {
      setLoadingChecks(true)
      try {
        const [catalogs, eventsPage] = await Promise.all([
          Promise.all(SCOPE_TYPES.map(
            (scopeType) => getConsistencyChecks(scopeType, controller.signal),
          )),
          getRecentCouponEvents(undefined, controller.signal),
        ])
        setScopeCatalogs(Object.fromEntries(catalogs.map((catalog) => [catalog.scope.name, catalog])))
        setRecentEvents(eventsPage.content ?? eventsPage ?? [])
      } catch (error) {
        if (error.name === 'AbortError') return
        const message = error instanceof ApiError
          ? error.message
          : '검사 목록을 불러오지 못했습니다.'
        setVerificationNotice({ tone: 'danger', message })
      } finally {
        if (!controller.signal.aborted) setLoadingChecks(false)
      }
    }

    loadTabData()
    return () => controller.abort()
  }, [refreshReportData])

  useEffect(() => {
    const controller = new AbortController()

    async function refresh() {
      try {
        await refreshReportData(controller.signal, recentPage)
      } catch (error) {
        if (error.name === 'AbortError') return
        const message = error instanceof ApiError
          ? error.message
          : '검증 결과를 불러오지 못했습니다.'
        setVerificationNotice({ tone: 'danger', message })
      }
    }

    refresh()
    // 고정 주기 폴링 대신, VerificationResult가 새로 저장될 때마다 백엔드가 보내는
    // CONSISTENCY_STEP_COMPLETED 알림(배치 Step이든 EVENT/AS_OF_RANGE 동기 검증이든 동일하게
    // 발행됨)을 받을 때만 다시 조회한다.
    const unsubscribe = subscribeNotifications(({ type }) => {
      if (type === 'CONSISTENCY_STEP_COMPLETED') refresh()
    })
    return () => {
      controller.abort()
      unsubscribe()
    }
  }, [recentPage, refreshReportData])

  useEffect(() => {
    if (!detailResult) return undefined
    const controller = new AbortController()

    async function loadViolations() {
      setDetailLoading(true)
      setDetailError(null)
      try {
        const response = await getConsistencyViolations(
          detailResult.id,
          detailViolationPage,
          VIOLATION_PAGE_SIZE,
          controller.signal,
        )
        setDetailViolations(response)
      } catch (error) {
        if (error.name === 'AbortError') return
        setDetailError(error instanceof ApiError ? error.message : '위반 상세를 불러오지 못했습니다.')
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false)
      }
    }

    loadViolations()
    return () => controller.abort()
  }, [detailResult, detailViolationPage])

  function openViolationDetail(result) {
    setDetailViolationPage(0)
    setDetailViolations(null)
    setDetailError(null)
    setDetailResult(result)
  }

  function closeViolationDetail() {
    setDetailResult(null)
    setDetailViolations(null)
    setDetailError(null)
  }

  function filterEvents(list, needle) {
    if (!needle.trim()) return list
    const lowerNeedle = needle.toLowerCase()
    return list.filter((event) => {
      const eventName = event.couponName ?? ''
      const eventId = String(event.eventId ?? '')
      return eventName.toLowerCase().includes(lowerNeedle) || eventId.includes(lowerNeedle)
    })
  }

  function selectScope(scopeType) {
    setSelectedScope(scopeType)
    setSelectedChecks([])
    setVerificationNotice(null)
  }

  function toggleCheck(checkName) {
    setSelectedChecks((current) => current.includes(checkName)
      ? current.filter((name) => name !== checkName)
      : [...current, checkName])
  }

  function toggleAllChecks() {
    const allNames = selectedCatalog?.checks.map((check) => check.name) ?? []
    setSelectedChecks((current) => current.length === allNames.length ? [] : allNames)
  }

  function buildScopePayload() {
    if (selectedScope === 'EVENT') return { type: 'EVENT', eventId: Number(eventId) }
    if (selectedScope === 'AS_OF_RANGE') {
      return { type: 'AS_OF_RANGE', from: rangeFrom, to: rangeTo }
    }
    return { type: 'ALL' }
  }

  function validateVerificationRequest() {
    if (selectedChecks.length === 0) return '실행할 검사를 한 개 이상 선택해주세요.'
    if (selectedScope === 'ALL' && allBatchRunning) {
      return '이미 ALL 정합성 검증이 진행 중입니다. 완료된 후 다시 시도해주세요.'
    }
    if (selectedScope === 'EVENT' && (!eventId || Number(eventId) <= 0)) {
      return '검증할 이벤트 ID를 입력해주세요.'
    }
    if (selectedScope === 'AS_OF_RANGE' && (!rangeFrom || !rangeTo)) {
      return '검증 기간의 시작과 종료 시각을 모두 입력해주세요.'
    }
    if (selectedScope === 'AS_OF_RANGE' && rangeFrom >= rangeTo) {
      return '시작 시각은 종료 시각보다 이전이어야 합니다.'
    }
    return null
  }

  async function runVerification() {
    const validationMessage = validateVerificationRequest()
    if (validationMessage) {
      setVerificationNotice({ tone: 'danger', message: validationMessage })
      return
    }

    setVerifying(true)
    setVerificationNotice(null)

    try {
      const response = await verifyConsistency({
        scope: buildScopePayload(),
        checkNames: selectedChecks,
      })

      if (response.executionType === 'ASYNC') {
        setVerificationNotice({
          tone: 'success',
          message: `전체 데이터 검증이 접수되었습니다. 작업 ID: ${response.jobExecutionId}`,
        })
      } else {
        await refreshReportData(undefined, recentPage)
        setVerificationNotice({
          tone: 'success',
          message: `선택한 검사 ${response.results.length}건을 완료했습니다.`,
        })
      }
    } catch (error) {
      const message = error instanceof ApiError
        ? error.message
        : '정합성 검사 요청 중 알 수 없는 오류가 발생했습니다.'
      setVerificationNotice({ tone: 'danger', message })
    } finally {
      setVerifying(false)
    }
  }

  async function startRecovery(resultId) {
    const methodId = selectedMethodByResult[resultId]
    if (!methodId) return
    setRecoveringResultId(resultId)
    try {
      await recoverConsistency(resultId, methodId)
      await refreshReportData(undefined, recentPage)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '복구 실행에 실패했습니다.'
      setVerificationNotice({ tone: 'danger', message })
    } finally {
      setRecoveringResultId(null)
    }
  }

  const recentResults = filterResults(recentPageData.content, recentSearchField, recentSearchText)
  const errorResults = filterResults(
    results.filter((item) => item.status === 'ERROR'),
    errorSearchField,
    errorSearchText,
  ).slice(0, RECENT_RESULT_PAGE_SIZE)
  const failResults = filterResults(
    results.filter((item) => item.status === 'FAIL'),
    failSearchField,
    failSearchText,
  ).slice(0, RECENT_RESULT_PAGE_SIZE)
  const filteredRecoveryHistory = filterRecoveryHistory(recoveryHistory, recoverySearchField, recoverySearchText)
  const selectedCatalog = scopeCatalogs[selectedScope]
  const recentPageGroupStart = Math.floor(recentPageData.page / PAGE_GROUP_SIZE) * PAGE_GROUP_SIZE
  const recentPageGroupEnd = Math.min(
    recentPageGroupStart + PAGE_GROUP_SIZE,
    recentPageData.totalPages,
  )
  const recentPageNumbers = Array.from(
    { length: Math.max(0, recentPageGroupEnd - recentPageGroupStart) },
    (_, index) => recentPageGroupStart + index,
  )

  return (
    <section className="reconciliation-report" aria-labelledby="reconciliation-title">
      <div className="tab-heading">
        <div>
          <span className="eyebrow">CONSISTENCY REPORT</span>
          <h2 id="reconciliation-title">데이터 정합성 리포트</h2>
          <p>최근 검증 결과를 확인하고, 실패한 항목은 복구 방법을 선택해 복구를 진행합니다.</p>
        </div>
      </div>

      <section className="panel consistency-launcher" aria-labelledby="consistency-launcher-title">
        <div className="consistency-launcher-heading">
          <div>
            <span className="section-number">00</span>
            <h2 id="consistency-launcher-title">정합성 검증 실행</h2>
            <button
              type="button"
              className="launcher-collapse-button"
              aria-expanded={launcherOpen}
              aria-controls="consistency-launcher-body"
              onClick={() => setLauncherOpen((current) => !current)}
            >
              {launcherOpen ? '접기' : '펼치기'}
              <span aria-hidden="true" className={launcherOpen ? 'open' : ''}>⌄</span>
            </button>
          </div>
          <span className="consistency-launcher-summary">
            {scopeCatalogs[selectedScope]?.scope.label ?? selectedScope} · {selectedChecks.length}개 선택
          </span>
        </div>

        {launcherOpen && (
        <div id="consistency-launcher-body" className="consistency-launcher-body">
        <div className="scope-toggle-group" role="group" aria-label="검증 범위 선택">
          {SCOPE_TYPES.map((scopeType) => (
            <button
              key={scopeType}
              type="button"
              className={`scope-toggle ${selectedScope === scopeType ? 'active' : ''}`}
              aria-pressed={selectedScope === scopeType}
              onClick={() => selectScope(scopeType)}
              disabled={loadingChecks || verifying}
            >
              <strong>{scopeCatalogs[scopeType]?.scope.label ?? scopeType}</strong>
              <span>{scopeType}</span>
            </button>
          ))}
        </div>

        {selectedScope === 'EVENT' && (
          <div className="verification-scope-field">
            <span>이벤트 선택</span>
            <button
              type="button"
              className="event-picker-trigger"
              onClick={() => setEventPickerOpen(true)}
              disabled={verifying}
            >
              {recentEvents.find((e) => String(e.eventId) === String(eventId))?.couponName ?? '이벤트 선택'}
              <span aria-hidden="true">▼</span>
            </button>
            {eventPickerOpen && (
              <div className="event-picker-panel">
                <label className="event-picker-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    value={eventSearchText}
                    onChange={(event) => setEventSearchText(event.target.value)}
                    placeholder="이벤트 이름 또는 ID로 검색"
                    autoFocus
                  />
                </label>
                <div className="event-picker-list">
                  {filterEvents(recentEvents, eventSearchText).length > 0 ? (
                    filterEvents(recentEvents, eventSearchText).map((event) => (
                      <button
                        key={event.eventId}
                        type="button"
                        className={`event-picker-item ${String(event.eventId) === String(eventId) ? 'selected' : ''}`}
                        onClick={() => {
                          setEventId(String(event.eventId))
                          setEventPickerOpen(false)
                          setEventSearchText('')
                        }}
                      >
                        <strong>{event.couponName}</strong>
                        <small>#{event.eventId}</small>
                      </button>
                    ))
                  ) : (
                    <div className="event-picker-empty">
                      {eventSearchText.trim() ? '검색 결과가 없습니다.' : '최근 이벤트가 없습니다.'}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {selectedScope === 'AS_OF_RANGE' && (
          <div className="range-field-group">
            <label className="verification-scope-field">
              <span>시작 시각</span>
              <input
                type="datetime-local"
                value={rangeFrom}
                onChange={(event) => setRangeFrom(event.target.value)}
                disabled={verifying}
              />
            </label>
            <span className="range-separator">부터</span>
            <label className="verification-scope-field">
              <span>종료 시각</span>
              <input
                type="datetime-local"
                value={rangeTo}
                onChange={(event) => setRangeTo(event.target.value)}
                disabled={verifying}
              />
            </label>
            <span className="range-separator">미만</span>
          </div>
        )}

        <div className="check-selector">
          <div className="check-selector-heading">
            <div className="check-selector-heading-left">
              <strong>실행할 검사</strong>
              <button
                type="button"
                className="text-button"
                onClick={toggleAllChecks}
                disabled={verifying || !selectedCatalog?.checks.length}
              >
                {selectedChecks.length > 0 && selectedChecks.length === selectedCatalog?.checks.length
                  ? '전체 해제'
                  : '전체 선택'}
              </button>
            </div>
            <span>{selectedChecks.length}개 선택</span>
          </div>
          {loadingChecks ? (
            <p className="catalog-empty">검사 목록을 불러오는 중입니다.</p>
          ) : selectedCatalog?.checks.length > 0 ? (
            <div className="check-toggle-grid">
              {selectedCatalog.checks.map((check) => {
                const selected = selectedChecks.includes(check.name)
                return (
                  <button
                    key={check.name}
                    type="button"
                    className={`check-toggle ${selected ? 'active' : ''}`}
                    aria-pressed={selected}
                    onClick={() => toggleCheck(check.name)}
                    disabled={verifying}
                  >
                    <span className="check-toggle-indicator" aria-hidden="true">{selected ? '✓' : '+'}</span>
                    <span>
                      <strong>{check.label}</strong>
                      <small>{check.name}</small>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="catalog-empty">이 범위에서 실행할 수 있는 검사가 없습니다.</p>
          )}
        </div>

        <div className="consistency-launcher-footer">
          <button
            type="button"
            className="primary-button consistency-verify-button"
            onClick={runVerification}
            disabled={loadingChecks || verifying || !selectedCatalog || (selectedScope === 'ALL' && allBatchRunning)}
          >
            {verifying
              ? '검증 실행 중…'
              : (selectedScope === 'ALL' && allBatchRunning)
                ? 'ALL 검증 진행 중…'
                : `선택한 검사 실행 (${selectedChecks.length})`}
          </button>
          {verificationNotice && (
            <p
              className={`consistency-verification-notice ${verificationNotice.tone}`}
              role={verificationNotice.tone === 'danger' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {verificationNotice.message}
            </p>
          )}
        </div>
        </div>
        )}
      </section>

      <section className="panel recent-results-panel" aria-labelledby="recent-results-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">01</span>
            <h2 id="recent-results-title">최근 검증 결과</h2>
          </div>
          <FieldSearch
            fields={RESULT_SEARCH_FIELDS}
            activeField={recentSearchField}
            onFieldChange={setRecentSearchField}
            value={recentSearchText}
            onValueChange={setRecentSearchText}
            placeholder="검색어 입력"
          />
        </div>
        <div className="table-wrap recent-results-scroll">
          <table>
            <thead>
              <tr>
                <th>검증 항목</th>
                <th>실행 방법</th>
                <th>상태</th>
                <th>위반 건수</th>
                <th>대상</th>
                <th>실행 시각</th>
              </tr>
            </thead>
            <tbody>
              {recentResults.length > 0 ? recentResults.map((result) => {
                const meta = recentStatusMeta(result)
                return (
                  <tr key={result.id}>
                    <td><strong>{CHECK_LABELS[result.checkName] ?? result.checkName}</strong></td>
                    <td>{TRIGGER_LABELS[result.triggerType] ?? result.triggerType}</td>
                    <td><span className={`status-badge compact ${meta.tone}`}>{meta.label}</span></td>
                    <td>{result.violationCount > 0 ? `${result.violationCount}건` : '-'}</td>
                    <td>{scopeLabel(result)}</td>
                    <td>{formatDate(result.executedAt)}</td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan="6" className="table-empty">
                    {recentSearchText.trim() ? '검색 조건에 맞는 결과가 없습니다.' : '검증 결과가 없습니다.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="result-pagination">
          <p className="data-note">
            {reportLoading
              ? '최신 검증 결과를 불러오는 중입니다.'
              : `전체 ${recentPageData.totalElements}건 · ${recentPageData.totalPages === 0 ? 0 : recentPageData.page + 1}/${recentPageData.totalPages} 페이지 · 10초마다 갱신`}
          </p>
          <div className="pagination-buttons" aria-label="최근 검증 결과 페이지 이동">
            <button
              type="button"
              className="pagination-group-button"
              aria-label="이전 10개 페이지"
              onClick={() => setRecentPage(Math.max(0, recentPageGroupStart - PAGE_GROUP_SIZE))}
              disabled={reportLoading || recentPageGroupStart === 0}
            >
              ‹
            </button>
            {recentPageNumbers.map((page) => (
              <button
                key={page}
                type="button"
                className={page === recentPageData.page ? 'active' : ''}
                aria-current={page === recentPageData.page ? 'page' : undefined}
                aria-label={`${page + 1}페이지`}
                onClick={() => setRecentPage(page)}
                disabled={reportLoading}
              >
                {page + 1}
              </button>
            ))}
            <button
              type="button"
              className="pagination-group-button"
              aria-label="다음 10개 페이지"
              onClick={() => setRecentPage(recentPageGroupEnd)}
              disabled={reportLoading || recentPageGroupEnd >= recentPageData.totalPages}
            >
              ›
            </button>
          </div>
        </div>
      </section>

      <div className="reconciliation-columns">
      <section className="panel verification-error-panel" aria-labelledby="verification-error-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">02</span>
            <h2 id="verification-error-title">정합성 검증 에러</h2>
          </div>
          <div className="panel-heading-actions">
            <FieldSearch
              fields={RESULT_SEARCH_FIELDS_FIXED_STATUS}
              activeField={errorSearchField}
              onFieldChange={setErrorSearchField}
              value={errorSearchText}
              onValueChange={setErrorSearchText}
              placeholder="검색어 입력"
            />
          </div>
        </div>
        <div className="reconciliation-scroll-area">
          {errorResults.length > 0 ? (
            <ul className="verification-error-list">
              {errorResults.map((result) => (
                <li key={result.id} className="error-box">
                  <strong>{CHECK_LABELS[result.checkName] ?? result.checkName}</strong>
                  <span>{result.errorMessage}</span>
                  <small>{formatDate(result.executedAt)} · {scopeLabel(result)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state small">
              <strong>{errorSearchText.trim() ? '검색 조건에 맞는 결과가 없습니다' : '검증 에러가 없습니다'}</strong>
              <p>{errorSearchText.trim() ? '다른 검색어로 다시 시도해보세요.' : 'Check 실행 자체가 실패한 항목이 없습니다.'}</p>
            </div>
          )}
        </div>
      </section>

      <section className="panel verification-fail-panel" aria-labelledby="verification-fail-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">03</span>
            <h2 id="verification-fail-title">정합성 검증 실패</h2>
          </div>
          <div className="panel-heading-actions">
            <FieldSearch
              fields={RESULT_SEARCH_FIELDS_FIXED_STATUS}
              activeField={failSearchField}
              onFieldChange={setFailSearchField}
              value={failSearchText}
              onValueChange={setFailSearchText}
              placeholder="검색어 입력"
            />
          </div>
        </div>
        <div className="reconciliation-scroll-area">
          {failResults.length > 0 ? (
          <ul className="verification-fail-list">
            {failResults.map((result) => {
              const recoveryMeta = RECOVERY_STATUS_META[result.recoveryStatus] ?? RECOVERY_STATUS_META.NONE
              const recovering = recoveringResultId === result.id
              const locked = recovering || result.recoveryStatus === 'SUCCESS'
              const recoveryMethods = recoveryMethodsByResult[result.id] ?? []
              return (
                <li key={result.id} className="fail-item">
                  <div className="fail-item-heading">
                    <div>
                      <strong>{CHECK_LABELS[result.checkName] ?? result.checkName}</strong>
                      <small>{scopeLabel(result)} · {formatDate(result.executedAt)}</small>
                    </div>
                    <span className={`status-badge ${recoveryMeta.tone}`}>{recoveryMeta.label}</span>
                  </div>
                  <div className="fail-item-diff-row">
                    <p className="fail-item-diff">위반 상세 {result.violationCount}건</p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => openViolationDetail(result)}
                      disabled={result.violationCount === 0}
                    >
                      자세히 보기
                    </button>
                  </div>
                  <div className="fail-item-recovery">
                    <select
                      value={selectedMethodByResult[result.id] ?? ''}
                      onChange={(event) =>
                        setSelectedMethodByResult((current) => ({ ...current, [result.id]: event.target.value }))
                      }
                      disabled={locked}
                    >
                      <option value="">
                        {recoveryMethods.length > 0 ? '복구 방법 선택' : '지원하는 복구 방법 없음'}
                      </option>
                      {recoveryMethods.map((method) => (
                        <option key={method.action} value={method.action}>{method.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost-button recovery-button"
                      onClick={() => startRecovery(result.id)}
                      disabled={locked || !selectedMethodByResult[result.id]}
                    >
                      {recovering
                        ? '복구 진행 중…'
                        : result.recoveryStatus === 'SUCCESS'
                          ? '복구 완료됨'
                          : '복구 시작'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          ) : (
            <div className="empty-state small">
              <strong>{failSearchText.trim() ? '검색 조건에 맞는 결과가 없습니다' : '실패한 검증이 없습니다'}</strong>
              <p>{failSearchText.trim() ? '다른 검색어로 다시 시도해보세요.' : '불일치가 감지된 검증 결과가 없습니다.'}</p>
            </div>
          )}
        </div>
      </section>
      </div>

      <section className="panel recovery-history-panel" aria-labelledby="recovery-history-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">04</span>
            <h2 id="recovery-history-title">복구 이력</h2>
          </div>
          <FieldSearch
            fields={RECOVERY_SEARCH_FIELDS}
            activeField={recoverySearchField}
            onFieldChange={setRecoverySearchField}
            value={recoverySearchText}
            onValueChange={setRecoverySearchText}
            placeholder="검색어 입력"
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>검증 항목</th>
                <th>복구 방법</th>
                <th>결과</th>
                <th>요청 시각</th>
                <th>완료 시각</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecoveryHistory.length > 0 ? filteredRecoveryHistory.map((entry) => {
                const meta = RECOVERY_STATUS_META[entry.status] ?? RECOVERY_STATUS_META.NONE
                return (
                  <tr key={entry.id}>
                    <td><strong>{CHECK_LABELS[entry.checkName] ?? entry.checkName}</strong></td>
                    <td>{entry.methodLabel}</td>
                    <td><span className={`status-badge compact ${meta.tone}`}>{meta.label}</span></td>
                    <td>{formatDate(entry.requestedAt)}</td>
                    <td>{formatDate(entry.finishedAt)}</td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan="5" className="table-empty">
                    {recoverySearchText.trim() ? '검색 조건에 맞는 결과가 없습니다.' : '복구를 진행한 이력이 없습니다.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel consistency-metrics" aria-labelledby="consistency-metrics-title">
        <div className="panel-heading">
          <div>
            <span className="section-number">05</span>
            <h2 id="consistency-metrics-title">정합성 검증 지표</h2>
          </div>
        </div>
        <GrafanaMetricCard
          title="정합성 검증 현황"
          description="검증 항목(check) · 검증 대상(scope) · 검증 상태(status)별 검증 건수 추이입니다."
          panelId={5}
          filterGroups={[
            { name: 'check', label: '검증 항목', options: CHECK_FILTER_OPTIONS },
            { name: 'scope', label: '검증 대상', options: SCOPE_FILTER_OPTIONS },
            { name: 'status', label: '검증 상태', options: STATUS_FILTER_OPTIONS },
          ]}
        />
      </section>

      {detailResult && (
        <div
          className="coupon-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeViolationDetail()
          }}
        >
          <section className="coupon-picker-modal diff-detail-modal" role="dialog" aria-modal="true" aria-labelledby="diff-detail-title">
            <div className="coupon-picker-header">
              <div>
                <span className="eyebrow">DIFF DETAIL</span>
                <h2 id="diff-detail-title">{CHECK_LABELS[detailResult.checkName] ?? detailResult.checkName}</h2>
                <p>{scopeLabel(detailResult)} · {formatDate(detailResult.executedAt)} · 위반 {detailResult.violationCount}건</p>
              </div>
              <button type="button" className="coupon-picker-close" onClick={closeViolationDetail} aria-label="상세 정보 닫기">×</button>
            </div>
            {detailLoading ? (
              <p className="catalog-empty">위반 상세를 불러오는 중입니다.</p>
            ) : detailError ? (
              <p className="violation-detail-error" role="alert">{detailError}</p>
            ) : detailViolations?.content.length > 0 ? (
              <ol className="violation-detail-list">
                {detailViolations.content.map((violation) => (
                  <li key={violation.id}>
                    <div>
                      <strong>{violation.targetType}</strong>
                      <span>대상 ID {violation.targetId ?? '-'}</span>
                      <time dateTime={violation.createdAt}>{formatDate(violation.createdAt)}</time>
                    </div>
                    <pre><code>{JSON.stringify(violation.detail, null, 2)}</code></pre>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="catalog-empty">저장된 위반 상세가 없습니다.</p>
            )}
            {detailViolations && detailViolations.totalPages > 1 && (
              <div className="result-pagination violation-pagination">
                <p className="data-note">
                  전체 {detailViolations.totalElements}건 · {detailViolations.page + 1}/{detailViolations.totalPages} 페이지
                </p>
                <div className="pagination-buttons" aria-label="위반 상세 페이지 이동">
                  <button
                    type="button"
                    onClick={() => setDetailViolationPage((page) => Math.max(0, page - 1))}
                    disabled={detailLoading || detailViolations.page === 0}
                  >이전</button>
                  <button
                    type="button"
                    onClick={() => setDetailViolationPage((page) => page + 1)}
                    disabled={detailLoading || !detailViolations.hasNext}
                  >다음</button>
                </div>
              </div>
            )}
            <button type="button" className="coupon-picker-cancel" onClick={closeViolationDetail}>닫기</button>
          </section>
        </div>
      )}
    </section>
  )
}

export default IntegrityReportTab

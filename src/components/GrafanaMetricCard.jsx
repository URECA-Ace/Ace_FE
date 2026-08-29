import { useMemo, useState } from 'react'

const GRAFANA_URL = (import.meta.env.VITE_GRAFANA_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const DASHBOARD_PATH = '/d-solo/ace-coupon-metrics/ace-coupon-metrics'

// 대시보드 JSON(docker/grafana/dashboards/ace-coupon-metrics.json)의 interval 변수 옵션과 동일하게 맞춘다.
const INTERVAL_OPTIONS = [
  { value: '5s', label: '5초' },
  { value: '10s', label: '10초' },
  { value: '30s', label: '30초' },
  { value: '1m', label: '1분' },
  { value: '5m', label: '5분' },
  { value: '15m', label: '15분' },
  { value: '30m', label: '30분' },
  { value: '1h', label: '1시간' },
  { value: '3h', label: '3시간' },
  { value: '6h', label: '6시간' },
  { value: '12h', label: '12시간' },
  { value: '1d', label: '하루' },
]

// 조회 범위(어디서부터 어디까지 볼지). d-solo 임베드는 대시보드 자체의 Time range picker가
// 보이지 않으므로, 이 값을 URL의 from/to 파라미터로 직접 넘겨줘야 그래프가 실제 데이터 구간을 그린다.
const RANGE_OPTIONS = [
  { value: '5m', label: '최근 5분' },
  { value: '15m', label: '최근 15분' },
  { value: '30m', label: '최근 30분' },
  { value: '1h', label: '최근 1시간' },
  { value: '3h', label: '최근 3시간' },
  { value: '6h', label: '최근 6시간' },
  { value: '12h', label: '최근 12시간' },
  { value: '24h', label: '최근 24시간' },
  { value: '3d', label: '최근 3일' },
  { value: '7d', label: '최근 7일' },
]

// Grafana 패널을 d-solo(단일 패널, 대시보드 UI 없음)로 임베드하고, 필터/집계 단위는
// 전부 프론트에서 만든 컨트롤로만 조작한다. Grafana의 Add/Remove 패널, Time range picker 등
// 대시보드 자체 UI는 노출하지 않는다.
function GrafanaMetricCard({ title, description, panelId, height = 260, filterGroups = [], variables = {} }) {
  const [intervalValue, setIntervalValue] = useState('10s')
  const [rangeValue, setRangeValue] = useState('15m')
  const [selections, setSelections] = useState(() =>
    Object.fromEntries(
      filterGroups.map((group) => [group.name, new Set(group.options.map((option) => option.value))])
    )
  )

  function toggleOption(groupName, value) {
    setSelections((prev) => {
      const next = new Set(prev[groupName])
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...prev, [groupName]: next }
    })
  }

  function toggleAllOptions(group) {
    setSelections((prev) => {
      const allSelected = group.options.every((option) => prev[group.name]?.has(option.value))
      const next = allSelected ? new Set() : new Set(group.options.map((option) => option.value))
      return { ...prev, [group.name]: next }
    })
  }

  const src = useMemo(() => {
    const params = new URLSearchParams({
      orgId: '1',
      panelId: String(panelId),
      theme: 'light',
      refresh: '5s',
      from: `now-${rangeValue}`,
      to: 'now',
    })
    params.append('var-interval', intervalValue)
    Object.entries(variables).forEach(([name, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params.append(`var-${name}`, String(value))
      }
    })
    filterGroups.forEach((group) => {
      const values = selections[group.name]
      if (!values) return
      values.forEach((value) => params.append(`var-${group.name}`, value))
    })
    return `${GRAFANA_URL}${DASHBOARD_PATH}?${params.toString()}`
  }, [intervalValue, rangeValue, selections, filterGroups, panelId, variables])

  return (
    <section className="grafana-metric-card">
      <div className="grafana-metric-heading">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        <div className="grafana-metric-controls">
          <label className="grafana-interval-select">
            <span>조회 범위</span>
            <select value={rangeValue} onChange={(event) => setRangeValue(event.target.value)}>
              {RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="grafana-interval-select">
            <span>집계 단위</span>
            <select value={intervalValue} onChange={(event) => setIntervalValue(event.target.value)}>
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {filterGroups.length > 0 && (
        <div className="grafana-metric-filters">
          {filterGroups.map((group) => {
            const allSelected = group.options.every((option) => selections[group.name]?.has(option.value))
            return (
            <div key={group.name} className="grafana-filter-group">
              <span className="grafana-filter-label">{group.label}</span>
              <div className="grafana-filter-chips">
                <button
                  type="button"
                  className={`grafana-filter-chip grafana-filter-chip-all ${allSelected ? 'active' : ''}`}
                  aria-pressed={allSelected}
                  onClick={() => toggleAllOptions(group)}
                >
                  {allSelected ? '전체 해제' : '전체 선택'}
                </button>
                {group.options.map((option) => {
                  const active = selections[group.name]?.has(option.value)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`grafana-filter-chip ${active ? 'active' : ''}`}
                      aria-pressed={active}
                      onClick={() => toggleOption(group.name, option.value)}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
            )
          })}
        </div>
      )}

      <iframe
        className="grafana-metric-frame"
        src={src}
        title={title}
        style={{ height }}
        loading="lazy"
      />
    </section>
  )
}

export default GrafanaMetricCard

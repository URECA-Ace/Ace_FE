import { useMemo, useState } from 'react'

const GRAFANA_URL = (import.meta.env.VITE_GRAFANA_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const DASHBOARD_PATH = '/d-solo/ace-coupon-metrics/ace-coupon-metrics'

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

// 조회 범위와 집계 단위는 임베드 패널에 필요한 기본 조작으로 유지한다.
// 검사 항목·상태·실패 사유 같은 데이터 필터 칩은 Grafana 자체 기능에 맡긴다.
function GrafanaMetricCard({ title, description, panelId, height = 260, variables = {} }) {
  const [intervalValue, setIntervalValue] = useState('10s')
  const [rangeValue, setRangeValue] = useState('15m')

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
    return `${GRAFANA_URL}${DASHBOARD_PATH}?${params.toString()}`
  }, [intervalValue, rangeValue, panelId, variables])

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

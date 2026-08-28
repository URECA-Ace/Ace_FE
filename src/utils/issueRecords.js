const STORAGE_KEY = 'ace-manager-issue-records'

export function loadRecords() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

export function saveRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

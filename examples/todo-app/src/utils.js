export function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10)
}

export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

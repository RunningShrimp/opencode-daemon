export function keep(ids: string[], cut?: string) {
  if (!cut) return false
  return !ids.includes(cut)
}

export function hide(id: string, cut: string | undefined, safe: boolean) {
  if (!cut) return false
  if (safe) return false
  return id >= cut
}

export function blank(ids: string[], cut?: string) {
  if (!cut) return false
  if (!ids.includes(cut)) return false
  return !ids.some((id) => id < cut)
}

export function drop(ids: string[], cut?: string) {
  if (ids.length === 0) return
  if (!cut) return ids[0]
  if (!ids.includes(cut)) return ids[0]
  if (blank(ids, cut)) return cut
  return ids.find((id) => id !== cut) ?? cut
}

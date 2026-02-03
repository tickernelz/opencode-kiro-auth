let idcRegion: string | undefined

export function setIdcRegionFromState(region: string | undefined): void {
  if (typeof region === 'string' && region.trim()) {
    idcRegion = region.trim()
    return
  }
  idcRegion = undefined
}

export function getIdcRegionFromState(): string | undefined {
  return idcRegion
}

export interface ShadowCompareResult {
  statusMatch: boolean
  bodyMatch: boolean
  match: boolean
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.clone().text()
  } catch {
    return ""
  }
}

export async function compareShadowResponses(primary: Response, shadow: Response): Promise<ShadowCompareResult> {
  const [primaryText, shadowText] = await Promise.all([safeText(primary), safeText(shadow)])
  const statusMatch = primary.status === shadow.status
  const bodyMatch = primaryText === shadowText
  return {
    statusMatch,
    bodyMatch,
    match: statusMatch && bodyMatch,
  }
}

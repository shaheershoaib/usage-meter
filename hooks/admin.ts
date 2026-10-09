// Filing a usage-credit request with the organization's admins, the way Claude Code does
// once its own confirm is answered: find the organization, check nothing is already
// pending, then post one `limit_increase` request.
export const API = 'https://api.anthropic.com'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

// The signed-in account's organization, from /api/oauth/profile.
export const orgOf = (text: string): string | null => {
  const data = parse(text) as { organization?: { uuid?: unknown }; organization_uuid?: unknown } | null
  const uuid = data?.organization?.uuid ?? data?.organization_uuid

  return typeof uuid === 'string' && UUID.test(uuid) ? uuid : null
}

// How many of my requests are still pending, from admin_requests/me (a list, or a list under a key).
export const pendingOf = (text: string): number => {
  const data = parse(text)
  if (Array.isArray(data)) {
    return data.length
  }
  const holder = data as Record<string, unknown> | null
  for (const key of ['data', 'requests', 'admin_requests', 'items', 'results']) {
    const list = holder?.[key]
    if (Array.isArray(list)) {
      return list.length
    }
  }

  return 0
}

// The server's own words for a refusal, when it gives any.
export const reasonOf = (text: string): string | null => {
  const data = parse(text) as Record<string, unknown> | null
  const error = (data?.error ?? null) as Record<string, unknown> | null
  for (const holder of [error, data]) {
    for (const key of ['message', 'detail']) {
      const value = holder?.[key]
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }
  }

  return null
}

export const profileUrl = () => `${API}/api/oauth/profile`
export const mineUrl = (org: string) =>
  `${API}/api/oauth/organizations/${org}/admin_requests/me?request_type=limit_increase&statuses=pending`
export const fileUrl = (org: string) => `${API}/api/oauth/organizations/${org}/admin_requests`
export const FILE_BODY = JSON.stringify({ request_type: 'limit_increase', details: null })

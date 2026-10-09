import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Credits, Limit } from '../types'
import { barColors, levelOf, runsOf } from './gauge'
import { SWEEP_TICK_MS, isMoving, isSweeping, shownOf } from './motion'
import { FILE_BODY, fileUrl, mineUrl, orgOf, pendingOf, profileUrl, reasonOf } from './admin'
import { asBlock, asCached, backoff, decide, minutes } from './pace'
import { money, parseUsage } from './usage'

const SETTINGS_URL = 'https://claude.ai/settings/usage'
const USAGE_API = 'https://api.anthropic.com/api/oauth/usage'
// One read per 15 seconds at most, one at a time, one after every turn (credits move
// with each turn once the weekly limit is spent) and one on a timer so an idle session stays current. A failed read is not retried at once: the next turn
// of the timer or a usage change is the retry.
// This session asks at most this often; every session together asks about twice a minute (pace.ts).
const REFRESH_MS = 10_000
// While you are working, usage is read this often, so the bars climb as you spend.
const ACTIVE_POLL_MS = 60_000
const ACTIVE_FOR_MS = 45_000
// How often a session looks at the reading the other sessions share (no request is made).
const ADOPT_MS = 15_000
const POLL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 10_000
const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Tile = { key: string; label: string; percent: number | null; detail: string }

const windows = atom({ plugin: 'usage-meter', key: 'windows' } as const, [])
const credits = atom({ plugin: 'usage-meter', key: 'credits' } as const, null)
const failure = atom({ plugin: 'usage-meter', key: 'error' } as const, null)

const resetOf = (limit: Limit) => {
  if (!limit.resetsAt) {
    return ''
  }
  const date = new Date(limit.resetsAt)
  const hours = date.getHours()
  const time = `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`

  return limit.kind === 'seven_day' ? `${DAYS[date.getDay()]} ${time}` : time
}

const adminNote = (tiles: Tile[]) => {
  const figures = tiles
    .filter(tile => tile.percent !== null)
    .map(tile => `${tile.label} ${Math.round(tile.percent ?? 0)}%`)
    .join(', ')

  return (
    `Hi, I am running low on Claude usage${figures ? ` (${figures})` : ''} and need more to keep working. ` +
    'Could you add usage credits for my account? You can approve it in ' +
    'Organization settings > Usage > Review requests. Thanks!'
  )
}


const withTimeout = <T,>($: EngineInterface, work: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error('timeout')))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      cause => {
        timer.cancel()
        reject(cause)
      },
    )
  })

let lastRead = 0
let isReading = false
let activeAt = 0
// The request to the admins: idle, asking you to confirm, sending, sent, or already pending.
let asking: 'idle' | 'confirm' | 'sending' | 'sent' | 'pending' = 'idle'
// When the numbers on screen were read, and the newest shared reading this session has taken.
let goodAt = 0
let adoptedAt = 0
let redrawQueued = false

const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

// A write that changes nothing still redraws everything that reads it, so none is made.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const CACHE_KEY = 'usage-cache'
const BLOCK_KEY = 'usage-blocked'

const setFailure = async ($: EngineInterface, label: string | null) => {
  if ((await read($, failure)) !== label) {
    await update($, failure, () => label)
  }
}

const apply = async ($: EngineInterface, usage: { windows: Limit[]; credits: Credits | null }) => {
  if (!same(await read($, windows), usage.windows)) {
    await update($, windows, () => usage.windows)
  }
  if (!same(await read($, credits), usage.credits)) {
    await update($, credits, () => usage.credits)
  }
}

// Reads the account's usage card, credits included. Every open session shares one cached
// reading and one "slow down" notice, so the request is made about twice a minute however
// many sessions there are; a failure leaves the numbers already drawn in place.
const refresh = async ($: EngineInterface) => {
  const now = Date.now()
  if (isReading || (lastRead && now - lastRead < REFRESH_MS)) {
    return
  }
  lastRead = now
  isReading = true
  try {
    const cached = asCached(await $.store.get(CACHE_KEY))
    const block = asBlock(await $.store.get(BLOCK_KEY))
    const action = decide(now, cached, block)
    if (cached && action !== 'ask') {
      await apply($, cached)
      goodAt = Math.max(goodAt, cached.at)
      adoptedAt = Math.max(adoptedAt, cached.at)
    }
    if (action === 'adopt') {
      await setFailure($, null)

      return
    }
    if (action === 'wait' && block) {
      await setFailure($, 'rate limited')

      return
    }
    const auth = await $.session.authorize()
    if (!auth) {

      return
    }
    const reply = await withTimeout(
      $,
      $.http.fetch(USAGE_API, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } }),
      FETCH_TIMEOUT_MS,
    )
    if (reply.status === 429) {
      const next = backoff(now, block, reply.headers['retry-after'])
      await $.store.set(BLOCK_KEY, next)
      if (cached) {
        await apply($, cached)
      }
      await setFailure($, 'rate limited')

      return
    }
    if (!reply.ok) {
      await setFailure($, `HTTP ${reply.status}`)

      return
    }
    let usage: ReturnType<typeof parseUsage>
    try {
      usage = parseUsage(reply.text)
    } catch {
      await setFailure($, 'unreadable reply')

      return
    }
    await $.store.set(CACHE_KEY, { at: now, windows: usage.windows, credits: usage.credits })
    await $.store.delete(BLOCK_KEY)
    await apply($, usage)
    goodAt = now
    adoptedAt = now
    await setFailure($, null)
  } catch (cause) {
    const label = cause instanceof Error && cause.message === 'timeout' ? 'timed out' : 'offline'
    await setFailure($, label)
  } finally {
    isReading = false
  }
}

// Takes up a newer reading another session made, without asking Anthropic: a store read only.
const adopt = async ($: EngineInterface) => {
  const cached = asCached(await $.store.get(CACHE_KEY))
  if (cached && cached.at > adoptedAt) {
    adoptedAt = cached.at
    goodAt = Math.max(goodAt, cached.at)
    await apply($, cached)
    await setFailure($, null)
  }
}

const say = ($: EngineInterface, text: string) => {
  $.ui.toast(text, { timeoutMs: 6_000 })

  return text
}

// Files one usage-credit request with your organization's admins. A request already pending is
// not sent twice; a post that times out is reported as unknown, not as failed, and is not retried.
const fileRequest = async ($: EngineInterface): Promise<string> => {
  asking = 'sending'
  $.ui.invalidate('ui.render')
  try {
    const auth = await $.session.authorize()
    if (!auth) {
      asking = 'idle'

      return say($, 'This session has no Claude sign-in to send the request with. Use claude.ai/settings/usage instead.')
    }
    const headers = { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' }
    const profile = await withTimeout($, $.http.fetch(profileUrl(), { auth: auth.handle, headers }), FETCH_TIMEOUT_MS)
    const org = profile.ok ? orgOf(profile.text) : null
    if (!org) {
      asking = 'idle'

      return say($, `Couldn't find your organization to send the request to (HTTP ${profile.status}). Nothing was sent.`)
    }
    const withOrg = { ...headers, 'x-organization-uuid': org }
    const mine = await withTimeout($, $.http.fetch(mineUrl(org), { auth: auth.handle, headers: withOrg }), FETCH_TIMEOUT_MS)
    if (mine.ok && pendingOf(mine.text) > 0) {
      asking = 'pending'

      return say($, "You've already sent a usage credit request to your admin. It's still pending.")
    }
    let sent
    try {
      sent = await withTimeout(
        $,
        $.http.fetch(fileUrl(org), { method: 'POST', auth: auth.handle, headers: withOrg, body: FILE_BODY }),
        FETCH_TIMEOUT_MS,
      )
    } catch {
      asking = 'idle'

      return say($, "The request didn't answer in time, so it may or may not have reached your admin. Press again: if it did, you'll be told it's pending.")
    }
    if (!sent.ok) {
      asking = 'idle'

      return say($, reasonOf(sent.text) ?? `Your admin request was not accepted (HTTP ${sent.status}). Nothing was sent; try again later.`)
    }
    asking = 'sent'

    return say($, 'Request sent to your admin for usage credits.')
  } catch (cause) {
    asking = 'idle'

    return say($, "Couldn't reach Anthropic to send the request. Nothing was sent; try again in a moment.")
  } finally {
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'more-usage',
      description: 'Send a usage-credit request to your organization admins',
    })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(ADOPT_MS, () => void adopt($))
    $.clock.every(ACTIVE_POLL_MS, () => {
      if (Date.now() - activeAt < ACTIVE_FOR_MS) {
        void refresh($)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'more-usage' }, async $ => ({ text: await fileRequest($) }))

  // Any tool call means work is going on, and usage is moving with it.
  on('tool.call', ($, e, next) => {
    activeAt = Date.now()

    return next(e)
  })

  // An agent's turn ending is another moment usage has moved.
  on('turn.complete', ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const known = e.rateLimits.filter(limit => limit.kind in LABELS)
      if (known.length > 0 && !same(await read($, windows), known)) {
        await update($, windows, () => known)
      }
    }
    // A turn that cost something is when credits and limits have moved.
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      void refresh($)
    }

    return next(e)
  })

  // Always drawn, so the request is one click away at any usage level.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another mod may draw in the band too: keep what is beneath this card.
    const below = await next(e)
    if (e.props.hasSurvey) {
      return below
    }

    const ui = $.ui.resolve(e)
    const { Box, Button, Link, Text } = ui
    const tiles: Tile[] = []
    for (const limit of await read($, windows)) {
      const reset = resetOf(limit)
      tiles.push({
        key: limit.kind,
        label: LABELS[limit.kind] ?? limit.kind,
        percent: Math.round(limit.percentUsed),
        detail: reset ? `resets ${reset}` : '',
      })
    }
    const balance = await read($, credits)
    const problem = await read($, failure)
    // Numbers more than two minutes old say how old they are; a wait for Anthropic is not an error.
    const age = goodAt ? Date.now() - goodAt : 0
    const stale = age > 120_000 ? ` · as of ${minutes(age)} min ago` : problem && problem !== 'rate limited' ? ' · not up to date' : ''
    if (balance?.isEnabled) {
      tiles.push({
        key: 'credits',
        label: 'Credits',
        // One decimal: near the cap, whole percents hide that it is still moving.
        percent: Math.round(balance.percentUsed * 10) / 10,
        detail: `${money(balance.spent, balance.currency)} of ${money(balance.limit, balance.currency)}${stale}`,
      })
    } else if (balance) {
      tiles.push({ key: 'credits', label: 'Credits', percent: null, detail: 'not enabled' })
    } else if (problem) {
      tiles.push({
        key: 'credits',
        label: 'Credits',
        percent: null,
        detail: problem === 'rate limited' ? 'loading…' : `unavailable (${problem})`,
      })
    }
    const now = Date.now()
    const top = Math.max(0, ...tiles.map(tile => tile.percent ?? 0))
    const { accent, isLow } = levelOf(top)

    const card = (
      <Box
        key="card"
        borderStyle="round"
        borderColor={accent}
        borderDimColor={!isLow}
        hover={{ borderColor: accent, borderDimColor: false }}
        paddingX={1}
        gap={3}
        alignItems="center"
        flexWrap="wrap"
      >
        <Box gap={3} flexGrow={1} flexWrap="wrap">
          {tiles.length === 0 && <Text dimColor>Need more? Request it in one click.</Text>}
          {tiles.map(tile => {
            const shown = shownOf(tile.key, tile.percent, now)
            const level = levelOf(shown ?? 0)
            const figure = shown === null ? '' : tile.key === 'credits' ? (Math.round(shown * 10) / 10).toFixed(1) : String(Math.round(shown))

            return (
              <Box key={`tile-${tile.key}`} flexDirection="column">
                <Box gap={1}>
                  <Text bold>{tile.label}</Text>
                  {shown !== null && (
                    <Text bold color={level.accent}>
                      {figure}%
                    </Text>
                  )}
                </Box>
                <Box>
                  {runsOf(barColors(shown, level, isMoving(tile.key, now))).map(run => (
                    <Box width={run.n} height={1} backgroundColor={run.color} />
                  ))}
                </Box>
                <Text dimColor>{tile.detail}</Text>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="column" gap={1} alignItems="flex-start">
          {asking === 'idle' && (
            <Button
              key="request"
              variant={isLow ? 'primary' : 'secondary'}
              label="Request more usage"
              onPress={() => {
                asking = 'confirm'
                $.ui.invalidate('ui.render')
              }}
            />
          )}
          {asking === 'confirm' && (
            <Box gap={1} alignItems="center">
              <Text>Send to your admins?</Text>
              <Button key="send" variant="primary" label="Send request" onPress={() => void fileRequest($)} />
              <Button
                key="cancel"
                label="Cancel"
                onPress={() => {
                  asking = 'idle'
                  $.ui.invalidate('ui.render')
                }}
              />
            </Box>
          )}
          {asking === 'sending' && <Text dimColor>Sending your request…</Text>}
          {asking === 'sent' && <Text color="#34d399">✓ Request sent to your admin</Text>}
          {asking === 'pending' && <Text color="#fbbf24">Request pending with your admin</Text>}
          <Box gap={1}>
            <Button
              key="copy"
              label="Copy admin note"
              onPress={async press => {
                const { isCopied } = await $.ui.copy({ text: adminNote(tiles), surface: press.surface })
                $.ui.toast(isCopied ? 'Note for your admin copied.' : 'Could not copy the note.')
              }}
            />
            <Link href={SETTINGS_URL} label="usage settings" />
          </Box>
        </Box>
      </Box>
    )

    if (isSweeping(now) && !redrawQueued) {
      redrawQueued = true
      $.clock.after(SWEEP_TICK_MS, () => {
        redrawQueued = false
        $.ui.invalidate('ui.render')
      })
    }

    return below.type === 'engine' ? (
      card
    ) : (
      <Box flexDirection="column">
        {card}
        {below}
      </Box>
    )
  })
}

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui'
import { createMemo, createSignal, Show, type Accessor } from 'solid-js'
import {
  formatRequestQuota,
  readUsageSnapshot,
  resolveTuiDisplayOptions,
  shouldShowKiroUsage,
  summarizeUsage,
  USAGE_REFRESH_INTERVAL_MS,
  type TuiDisplayOptions,
  type UsageSnapshot
} from './tui-usage.js'

function UsageSidebar(props: {
  api: TuiPluginApi
  sessionID: string
  snapshot: Accessor<UsageSnapshot>
  display: TuiDisplayOptions
}) {
  const theme = () => props.api.theme.current
  const messages = createMemo(() => props.api.state.session.messages(props.sessionID))
  const enabled = createMemo(() => shouldShowKiroUsage(messages(), props.api.state.config.model))
  const summary = createMemo(() => summarizeUsage(props.snapshot()))
  const account = createMemo(() => summary().account)

  return (
    <Show when={enabled()}>
      <box gap={0}>
        <text fg={theme().text} wrapMode="none">
          <b>Kiro</b>
        </text>
        <Show when={account()} fallback={<text fg={theme().textMuted}>No quota data</text>}>
          <box gap={0}>
            <Show when={props.display.showAccountEmail}>
              <text fg={theme().textMuted} wrapMode="none">
                Account: {account()?.email}
              </text>
            </Show>
            <Show when={props.display.showPlan}>
              <text fg={theme().textMuted} wrapMode="none">
                Plan: {summary().plan}
              </text>
            </Show>
            <Show when={props.display.showCredits}>
              <text fg={theme().textMuted} wrapMode="none">
                {formatRequestQuota(summary())}
              </text>
            </Show>
          </box>
        </Show>
        <Show when={props.snapshot().error}>
          {(error) => <text fg={theme().warning}>Usage unavailable: {error()}</text>}
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const display = resolveTuiDisplayOptions(options)
  const [snapshot, setSnapshot] = createSignal(readUsageSnapshot())
  const refresh = () => setSnapshot(readUsageSnapshot())
  const timer = setInterval(refresh, USAGE_REFRESH_INTERVAL_MS)
  api.lifecycle.onDispose(() => clearInterval(timer))
  api.event.on('session.idle', refresh)
  api.event.on('message.updated', refresh)
  refresh()

  api.slots.register({
    order: 90,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <UsageSidebar
            api={api}
            sessionID={props.session_id}
            snapshot={snapshot}
            display={display}
          />
        )
      }
    }
  })
}

export default {
  id: 'kiro-auth-usage',
  tui
}

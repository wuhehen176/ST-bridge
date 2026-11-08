const React = require('react')
const h = React.createElement

    function failureText(result) {
      if (!result) return 'RPC 失败'
      if (result.error?.message) return String(result.error.message)
      return String(result)
    }

    function shortSession(value) {
      if (!value) return '—'
      const text = String(value)
      return text.length > 22 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text
    }

    function Field(props) {
      return h('label', { className: 'bbh-field' },
        h('span', null, props.label),
        props.children,
        props.hint ? h('small', { className: 'bbh-note' }, props.hint) : null,
      )
    }

    function Check(props) {
      return h('label', { className: 'bbh-check' },
        h('input', { type: 'checkbox', checked: props.checked === true, onChange: event => props.onChange(event.target.checked) }),
        h('span', null, props.label, props.hint ? h('small', null, props.hint) : null),
      )
    }

    function formFrom(status) {
      return {
        host: status?.service?.host ?? '127.0.0.1',
        port: String(status?.service?.port ?? ''),
        requestTimeoutMs: String(status?.service?.requestTimeoutMs ?? 1800000),
        maxBodyBytes: String(status?.service?.maxBodyBytes ?? 33554432),
        authToken: '',
        clearAuthToken: false,
        allowLegacyPlain: status?.service?.allowLegacyPlain === true,
        sessionOnStale: status?.service?.sessionOnStale === 'recreate',
        sessionOnArchived: status?.service?.sessionOnArchived === 'recreate',
        contextOverflow: status?.service?.contextOverflow === 'recreate',
        transientRetry: String(status?.service?.transientRetry ?? 0),
        allowRemote: status?.service?.allowRemote === true,
        allowExtensionOrigins: status?.service?.allowExtensionOrigins !== false,
        allowNullOrigin: status?.service?.allowNullOrigin === true,
        corsText: (status?.service?.corsOrigins ?? []).join('\n'),
        allowedClientsText: (status?.service?.allowedClientIds ?? []).join('\n'),
        clientEndpoints: (status?.service?.clientEndpoints ?? []).map(entry => ({ ...entry })),
        plainCompatEnabled: status?.service?.plainCompat?.enabled === true,
        plainCompatClientId: status?.service?.plainCompat?.clientId ?? 'yuzi-phone',
        plainCompatChatId: status?.service?.plainCompat?.chatId ?? 'yuzi-phone',
        plainCompatTaskId: status?.service?.plainCompat?.taskId ?? 'default',
        plainCompatFixedCount: String(status?.service?.plainCompat?.fixedMessageCount ?? 0),
        plainCompatFixedTypes: (status?.service?.plainCompat?.fixedMessageTypes ?? []).join(','),
        inputCleanupEnabled: status?.service?.inputCleanup?.enabled !== false,
        inputCleanupTags: (status?.service?.inputCleanup?.tags ?? []).join(','),
        defaultInputCleanupTags: status?.service?.defaults?.inputCleanupTags ?? [],
        snapshotEnabled: status?.service?.snapshotDiff?.enabled === true,
        snapshotMode: status?.service?.snapshotDiff?.mode ?? 'auto',
        snapshotMaxBlockChars: String(status?.service?.snapshotDiff?.maxBlockChars ?? 2000),
        snapshotMarker: status?.service?.snapshotDiff?.marker ?? '',
        snapshotClientsText: (status?.service?.snapshotDiff?.clients ?? ['shujuku', 'yuzi-phone']).join(','),
        snapshotDivergence: status?.service?.snapshotDiff?.onDivergence ?? 'full',
        systemSnapshotMode: status?.service?.systemSnapshot?.mode ?? '',
        systemSnapshotModes: status?.service?.systemSnapshot?.modes ?? [],
        appendFormat: status?.service?.appendFormat ?? 'nonce',
        appendNonce: status?.service?.appendNonce ?? '7F3A9C2E',
      }
    }

module.exports = { failureText, shortSession, Field, Check, formFrom }

# Codex Bridge — core

A model-layer gateway for **Codex App**, combining independently authenticated
**Codex subscription**, **GitHub Copilot** and a configured **Unsloth Studio** local API.
This branch is for local acceptance, not a published npm/Homebrew release. The
repository/package/legacy executable names retain their upstream compatibility.

The native menu-bar app supervises this core. It uses a transactional Codex App
configuration toggle, its own Keychain broker, compact per-source quotas and a
shared token-activity heatmap. Codex App owns task history, context management,
workstation tools and permissions. No nested CLI agent is used for inference.

## Source adapters

- `src/gateway/codex.ts`: official catalog and native Responses forwarding.
  Independent login/refresh uses Pi OAuth 0.85.1 and private native Keychain IPC.
  Caller credentials are not imported from Codex App or forwarded to other sources.
- `src/gateway/copilot.ts`: delegates to the established Copilot compatibility
  pipeline. Existing model-specific repairs and search choices remain isolated.
- `src/gateway/local.ts`: discovers loaded conversational models and actual runtime
  context/capabilities. It does not intentionally load/download a model. Unknown
  windows and non-chat models are not advertised. Runtime changes invalidate the
  capability fingerprint.
- `src/gateway/local-search.ts`: a guarded Studio-native hosted-search seam. It
  keeps Codex's default tool definition usable for ordinary tasks without silently
  dropping search. Invocations require executed native search events; no generated
  URL, unsupported cached mode or missing filter is presented as successful search.

Only metadata, routing, framing, names/namespace conversion and usage observation
are shared. The official stream is not put through Copilot's ID repairs. Local
function/custom patch calls and images in tool results are returned to Codex App,
not executed on the inference server. Opaque history and unsupported attachments
fail explicitly. Source-private compaction is not assumed portable.

## Native application command

The app invokes `gateway --host <loopback-or-LAN> --port <port> --settings <file>`.
The JSON settings file contains source switches, the local API URL and non-secret
Copilot options. OAuth/local keys never appear in it or in command-line arguments.
The native parent supplies separate private control/event channel tokens and its
credential-helper path. The command does not edit Codex or Claude configuration.

`/v1/models?client_version=...` returns the merged Codex catalog with qualified IDs:
`codex/<id>`, `copilot/<id>`, `local/<id>`. Plain `/v1/models` returns an OpenAI-style
list. Requests do not fall back across sources. Unbound legacy bare names work only
in a Copilot-only catalog; otherwise choose a qualified source. Private `/bridge/*`
management endpoints require the native control token. Browser-origin model requests
are rejected, but explicitly enabled LAN inference remains keyless/plain HTTP.

The legacy `start` and `auth` commands remain for compatibility and regression
testing. [Historical upstream documentation](docs/legacy-copilot.md) describes those
old commands, not the multi-provider app workflow. This branch does not publish to
the original author's npm package or Git remote.

## Validation

```sh
bun install --frozen-lockfile --ignore-scripts
bun test
bun run typecheck
```

Opt-in local tests require an explicitly supplied endpoint:

```sh
bun run scripts/verify-local-provider.ts --base-url http://HOST:PORT/v1 --gateway --namespace
bun run scripts/verify-codex-client.ts --base-url http://HOST:PORT/v1 --codex-bin /absolute/path/to/codex
```

These use synthetic data and an isolated temporary Codex home/workspace. The real
Codex engine test does not authenticate an account, edit live configuration or
start a production CLI agent. Local reports go in ignored `.artifacts/`; do not
commit endpoint addresses, account data or personal logs.

Fixtures and local API tests are not a guarantee of full desktop Computer Use,
server/GPU cancellation or a live subscription entitlement. A usable official
account remains an explicit acceptance step. On the tested local service, native
search did not return execution evidence; the adapter fails honestly when invoked.
See [scope and delivery gates](docs/codex-bridge-work.md).

## License and attribution

MIT, based on Copilot Bridge by betaHi and contributors. Pi authentication and
its dependencies retain their own licenses. Unsloth Studio is an external service;
no AGPL Studio implementation is bundled or copied. The app packages dependency
notices with its exact pinned core revision.

# Codex Bridge implementation

## Delivery boundary

Work takes place on `codex/codex-bridge` in separate core and app worktrees.
Do not publish, upload packages, update Homebrew, install over the existing app,
restart Codex, or stop another Bridge instance. Deliver a local build for review.
The existing repository names and compatibility/data ownership identifiers stay.

## Scope

- One independently authenticated Codex subscription, the existing Copilot
  adapter, and one explicitly configured Unsloth Studio endpoint.
- Codex App owns the task, tools, permissions, history, and compaction. No nested
  coding agent. Reuse Pi OAuth, not a new OAuth implementation.
- Preserve Copilot behavior behind the common gateway. Native Responses routes
  preserve unrecognized fields. Never silently discard required tools, images,
  or history, and never silently switch billing/provider.
- Discover loaded conversational models and actual runtime context/capabilities.
  Declared capability is not verified capability. Changes invalidate stale
  verification. Provider-native search takes priority over optional adapters.
- Shared token activity with Codex/Copilot/Local breakdown; compact independent
  quota/status rows; transactional historical-data migration.
- Product/documentation name: Codex Bridge. UI and documentation are English.

## Core verification and downstream delivery

- [x] Repeatable local Responses tests: tools, tool-result images, image input,
      freeform apply_patch, streaming lifecycle, cancellation, usage.
- [x] Preserve the existing Copilot regression suite.
- [x] Source-scoped catalog, routing, capability validation, and error isolation.
- [x] Independent OAuth library integration and fixture-tested persistence/refresh.
- [x] Real isolated Codex engine file-tool round trip with the default tool list.

The app checkout's `docs/verification.md` defines native/package acceptance.
The run-specific `build/acceptance.md` records source provenance, final checksums,
test results and outstanding user-acceptance checks. A local build is not a release.

### Explicit limits to carry into acceptance

- The live local endpoint has not returned executed native-search evidence.
  The adapter rejects generated text as evidence and does not silently switch to
  external search. Cached-only search and unsupported filters also fail when called.
- A real subscribed Codex account and packaged browser/Keychain sign-in have not
  been exercised with user credentials. Mocks are not a substitute for this gate.
- A synthetic screenshot round trip is a prerequisite, not full desktop Computer
  Use verification. Client cancellation is not proof of immediate GPU cancellation.
- Opaque provider-private history cannot be assumed portable between sources.

Tests use synthetic content only. Local endpoint addresses, account material,
screenshots, and live diagnostic reports are not committed to the repository.
Mock verification must never be reported as official-account live verification.

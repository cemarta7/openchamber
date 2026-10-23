# Application roots

## Ownership

`VSCodeApp` composes the shared runtime, theme and sync contexts for VS Code webviews. The extension host selects the root's `panelType` in its bootstrap document. `VSCodeLayout` owns chat/session navigation; `SettingsView` owns Settings pages and responsive navigation. The native panel lifecycle belongs to `packages/vscode/src`, documented there.

`mobileConnections` owns saved mobile instances and their connect, password and reconnect flows. The welcome screen and Instances form share its controller. Runtime HTTP authentication remains in `lib/runtime-auth` and `lib/runtime-fetch`.

## Invariants

- Mobile custom headers belong to the normalized address entered in the form. They reach that address's health check, password login, session check and runtime HTTP requests. They never follow another direct candidate or the private relay. Authorization remains reserved for the client token.
- Native header values live in secure storage. Metadata holds an opaque reference; browser-mode storage holds the parsed header configuration inline. Missing headers preserve old connections. An unreadable native entry fails the connection or edit operation, without replacing the saved headers with an empty set.
- A header edit writes a fresh secure entry before publishing its metadata reference. Failure preserves the old reference and credentials. Replaced and removed references are deleted after the metadata commit. Native bridge calls remain bounded by the existing secure-storage timeout.
- Native mobile with headers uses the existing fetch-based OpenChamber event stream reader and the native WebSocket adapter behind `openRuntimeWebSocket`. Browser-owned asset URLs still cannot attach these headers.

- Chat-side Settings entry points request the native Settings tab through `RuntimeAPIs.vscode`. They preserve chat selection, drafts and the current layout. The source's in-page dialog flag is cleared so it cannot block chat shortcuts.
- Only the Settings root receives page navigation. The bridge parses it before applying it to stores, and the mounted root signals readiness before the host consumes pending navigation.
- The Settings root supplies no selected directory to the shared sync provider. It does not start global session polling, selected-directory session bootstrap or background queue delivery/cleanup, and seeing it never marks a chat as viewed. Settings pages resolve their own project through `useSettingsDirectory`; catalog updates still use the shared sync context.
- Its runtime shortcut hook registers Settings actions only and requires no chat sync context. Chat, model and session shortcuts remain with chat roots, so a key pressed in Settings cannot create an unseen draft or change a session selection there. Escape reaches an input or menu before the tab's close handler.
- Settings uses the existing persistence and broadcast protocol. Moving its host changes no stored format, registry key or runtime availability.

## Decisions

### Why mobile proxy headers bind to an address and not every transport

A saved device can have LAN addresses and a relay route that do not pass through the user's proxy. Binding headers to the entered address prevents proxy credentials from reaching those alternatives after a reconnect or candidate refresh.

### Why secure header writes use new references and not in-place replacement

The secure store and localStorage cannot commit together. A new reference lets a failed metadata write preserve the previous credentials without a compensating secret write that could also fail.

### Why navigation carries intent and not the source's stores

Each webview owns its own stores. A small parsed request preserves the originating Settings directory, page links, provider-connect action and new-snippet action without transferring chat state or overwriting the tab's independently edited settings.

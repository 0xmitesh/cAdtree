# Signup integration with completed tutorials

## Source and scope

Integration base: GitHub main `4b1d6a946c0b6b3b9905f864d60c77b690fee6db` (Tutorial 5, PR #27). The supplied AI Studio ZIP's existing app, styles, browser-storage module and test/configuration helpers match the pre-signup baseline at `e5a282cb4a5b6d6757beef66ab1c3c4a7d2cb127` (PR #23). Its four newer tutorial cards were still Coming soon.

Bring the signup additions onto current main. Preserve all five current tutorial definitions, cards, shared viewer, images, guides and existing tutorial regressions byte-for-byte. Preserve the CAD engines and on-disk history formats; only the browser convenience store receives the ZIP's account scoping. Retain the repository's npm lockfile and development port. Unused AI Studio reference images, generated README, Bun lockfile and empty Firestore scaffolding are not needed for Authentication and are not imported.

The integration includes Google sign-in, email signup/sign-in, password reset, session/account controls and required sign-in for local work. Homepage/tutorial browsing remains public. The existing Firebase web configuration is retained. No CAD cloud storage, server authorization, Drive permissions or filesystem ownership claim is added.

## Integration fixes

- Preserve the native folder error as a cause so the post-sign-in Continue flow can detect lost user activation through the existing permission helper.
- Use the latest account event after an operation; a superseded account switch must not be replayed after the user has returned to the original account.
- Keep new operations disabled during pending sign-out and guard rapid repeated sign-out requests.
- Report unavailable email/reset adapter methods honestly rather than silently using Google or reporting a reset email as sent.
- Update imported tests for the five-card homepage and actual tutorial/address-dialog controls. Cancellation assertions avoid formatting live DOM/React objects while waiting for asynchronous dismissal. The sign-out test reopens the real test vault and checks the saved revision and retained CAD bytes.

## Validation

- TypeScript (`npm run lint`) and production build passed.
- 309 engine/history/actual-App component tests passed using `node --import tsx --test src/engine/*.test.ts src/history/*.test.ts src/components/*.test.tsx`. The equivalent tsx CLI script cannot open its IPC socket in this execution environment; the Node loader runs the same test files without that socket.
- Signup regressions cover cancellation/error/retry, email creation and reset, unresolved sessions, fresh-click picker continuation, account isolation, superseded account events, public access to all five tutorials and local capture/sign-out while the browser reports offline. Authentication is simulated for these tests.
- Account-preference regressions preserve separate handles/paths for two accounts, including a shared project identity, returning to the first account, signed-out reads and pre-signup home/path continuity.
- All 6 tutorial asset/definition tests passed with `node --import tsx --test src/tutorials/*.test.ts`, run separately because the existing npm test script does not include that directory.
- Live Chrome preview verified the five-card homepage and sign-in/create-account controls. A signed-out walkthrough traversed all seven final-tutorial steps and loaded all 20 visuals successfully.
- Production output is checked for absence of test-user and test-auth harness strings. Existing build advisories remain; Firebase increases the main JavaScript bundle to approximately 749 kB before gzip.

## Manual checks still required

No real Google/email account was created or authenticated, and no reset email was sent. Verify those flows against the retained Firebase project on the intended authorized domain. Remote provider/domain configuration was not changed or independently qualified. Real session persistence across reload/offline restart, OS directory permission prompts, native CAD rebuild/reference behavior and physical-device layouts remain manual checks. The Playwright browser workflow is included but was not executed in this environment; live browser checks used the supported preview instead.

Review this branch and test real authentication before merging or deploying. No merge or deployment is part of this integration.

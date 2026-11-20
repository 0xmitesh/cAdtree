# R1 — Learn without leaving the project

Based on the navigation review of main `49960ae` (PR #28). Scope is R1 only.

The project sidebar now has **Learn cAdtree** alongside the existing project
navigation. It opens the existing five tutorial cards in a modal over the current
project. Selecting a card opens the unchanged tutorial viewer above the chooser.
Close, Finish or Escape returns to the chooser; closing the chooser returns focus
to the sidebar action. Homepage onboarding cards are unchanged.

History and Changes remain mounted. Opening learning does not call project exit,
branch switching, folder connection, scan, capture, application, recovery or archive
handlers. Project/account session resets also dismiss the learning overlay.

## Acceptance checks

- A disposable six-revision project uses a non-Main working case and uncaptured
  changes. Its selected Rev 004, scan, revision summary, overall engineering notes
  and per-file notes survive opening/closing all five tutorials and finishing the
  final tutorial. The original History and Changes DOM instances remain mounted.
- No additional folder picker calls; complete home file/directory signatures stay
  identical. The chooser is available from History, Changes, References and Settings
  without changing which project page is active.
- Native Chrome at 1366 × 900 and 390 × 844 verifies keyboard entry, independent
  visual/step navigation, Finish, Escape, dialog focus return, retained project
  state, no horizontal chooser overflow and no page errors.
- All 311 app tests pass, including existing homepage, authentication/account
  isolation, capture/apply/recovery and final-tutorial tests. The normal full
  TypeScript check and production build pass.

## Reproduction and validation limits

With normal installed dependencies:

```powershell
node node_modules/tsx/dist/cli.mjs --test src/components/project-learning.test.tsx src/components/learn-cadtree.test.tsx src/components/auth.test.tsx src/components/final-tutorial.test.tsx
node tests/project-learning-check.cjs
```

Initial checks used an offline SDK guard because dependencies were unavailable.
After the normal dependencies became available, all 311 app tests, the full
TypeScript check, production build and both browser viewports were rerun and
passed. The final browser run uses the installed SDK with the offline guard
disabled, the existing injected TestAuthAdapter and disposable native-handle
facades. It verifies UI/state behavior, not real provider sign-in or native CAD
operation. The harness compiles the current stylesheet separately with SDK
imports externalized; its real App test bundle is not a production deployment
artifact. The normal production build is checked independently.

No package, lockfile, Firebase code or configuration was changed. R2–R11,
including logo/home navigation, are left for subsequent review items.

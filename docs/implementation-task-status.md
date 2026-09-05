# Implementation task status

This log tracks the post-audit implementation cards separately from the phase roadmap. A task is marked complete only when every required external or browser evidence gate has run; code-complete work with a pending gate remains explicit.

## F01 — Isolate the offline cache

Status: **implemented; browser upgrade gate pending**.

- Cache names include the CombLang application namespace, encoded Service Worker scope path, and shell version.
- Activation deletes only obsolete versions inside the current scope namespace. Foreign applications, sibling Pages paths, and the ambiguous legacy global cache remain untouched.
- Precache discovery, warm-up messages, and fetch interception accept only URLs inside the registered application scope.
- Offline reads use the current named cache rather than a global `caches.match` search.
- VM-backed CacheStorage tests cover foreign/sibling preservation, scoped warm-up, own-cache reads, and outside-scope fetch rejection.
- A production build was loaded once from `localhost:4173`, its only preview process was stopped, and the application shell then reloaded successfully offline through the installed Service Worker.

Still required for full lifecycle acceptance: exercise an actual version upgrade with two sibling path deployments in a browser and verify that the new shell plus compiler/test Workers remain available offline after activation. No server is left running by this check.

Next independent task: F02, accumulation of diagnostics from every compilation stage.

# Phase 1 M2b — safe-click disposition

**Status:** DEFERRED. No new rendered click class is shipped.
**Scope:** Phase 1 tracking issue #594, item M2b.

## Decision

M2b is conditional: implement safe-click behavior only when tests prove the
interaction cannot trigger unsafe or unintended actions. The audit did not
approve a new side-effect-free click class beyond the existing structural
disclosure path (P1.1/P1.2: menu/nav/hamburger/tab/summary, explicit
`aria-haspopup`, and collapsed `aria-expanded` controls).

This change therefore **does not add clicking behavior**. It hardens the
existing rendered path by excluding controls that can submit/reset a form or
trigger a download, and records the deferral with an explicit never-click
boundary.

## Evidence

- Static non-semantic controls from M2a (`formaction`, strict `onclick`
  navigation, meta refresh) are navigation literals. They are resolved
  statically without browser interaction. Clicking a submit-like control would
  add form submission and potential server-side state mutation, not coverage.
- Rendered click enumeration already has a bounded click budget and excludes:
  open `<summary>` controls (clicking would close them), hidden/disabled
  controls, structural anchors that navigate away, opaque icon-only controls,
  and controls outside the approved hint/structural set.
- New exclusions in `server/browserCommunityFallback.ts`:
  - `<button>` inside an associated form whose type is absent, `submit`, or
    `reset` (absent means submit);
  - `<input type="submit|image|reset">` inside an associated form;
  - `<a download>` links.
  These are counted as unsafe interaction surfaces
  (`opaqueInteractiveControls`), so an invite hidden behind one cannot be
  certified as a clean absence.
- The browser regression in
  `server/browserCommunityFallback.browser.test.ts` asserts that only the
  non-submitting button and the ordinary anchor remain clickable.

## Never-click boundary

The following must never be clicked by the crawler:

- form submission/reset/image controls and any control associated with a form
  that submits or resets;
- download links and non-document resource links;
- file upload, password, payment, checkout, purchase, and destructive-action
  controls;
- hidden, disabled, `aria-disabled`, or zero-box controls;
- open `<summary>` controls and structural anchors that replace the document;
- popup/named-frame targets that cannot be inspected in the current document;
- opaque icon-only controls with no accessible evidence.

The existing hint/structural click path remains limited to controls that can
reveal content in place. No new selector, form action, or arbitrary `onclick`
handler is added to the rendered click set.

## Why M2b remains deferred

Proving safety for a broader click set would require a sandbox that observes
network mutations, form posts, downloads, external-app launches, and
cross-document state changes for every eligible control class. That capability
is not approved or implemented. Weakening the existing boundary to gain
speculative recall would violate the Phase 1 safety requirement. M2b remains
explicitly deferred until an approved side-effect-free allowlist and a
corresponding browser safety harness exist.

## Revisit conditions

- An approved, closed allowlist of controls that reveal content purely in the
  DOM without navigation, form submission, download, or external protocol.
- Browser tests that prove no form submission, download, external-app launch,
  or cross-document mutation for every allowed control class.
- A documented rollback path if a new control class is later found unsafe.

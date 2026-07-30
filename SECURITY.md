# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"), or email
**security@virtastic.app**.

We'll acknowledge within a few days. Please include steps to reproduce and,
if relevant, the browser/GPU involved.

## Scope

- The web front-end (`play/`), the WASM engine build, and the release
  artifacts are in scope.
- The hosted instance at ja2.virtastic.app is in scope for responsible
  disclosure (no automated scanning / load testing, please).
- Upstream JA2 Stracciatella engine issues that are not specific to this port
  should go to the
  [ja2-stracciatella project](https://github.com/ja2-stracciatella/ja2-stracciatella/issues).

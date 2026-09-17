# Frozen Package v1 fixtures

These two files are the Nexus Package v1 examples exactly as they were at the
contract freeze (`26a4914`, "Nexus Package v1 contract freeze"). They are kept
byte-for-byte and are never edited to match new behaviour.

`scripts/check-package.js` imports each one at the current head, exports it
again, and requires the result to equal the file's own canonical form. That is
the only way to notice that v1 has quietly stopped being v1: a fixture that is
updated alongside the code can always agree with it.

If a change here is ever genuinely needed, it is a new package version, not an
edit to these files.

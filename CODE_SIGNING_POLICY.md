# Code signing policy

This project has applied for free code signing provided by SignPath.io,
certificate by SignPath Foundation. Until the application is approved,
releases are unsigned and are identified as such in their release notes.

## Scope

Only DeepSeek Harness Desktop artifacts built from this repository are eligible
for signing. The project does not sign DeepSeek Harness or any other upstream
project's source code or binaries.

## Team roles

- Committer and reviewer: [761244815](https://github.com/761244815)
- Signing approver: [761244815](https://github.com/761244815)

## Build and approval

Windows packages are built from the public repository by GitHub Actions. The
workflow runs the desktop tests and verifies that the referenced official
DeepSeek Harness revision builds successfully before publishing a release.

After SignPath integration, each signing request must be approved manually by
the signing approver. Signed artifacts must match the project name and release
version recorded by the build workflow.

## Privacy

See the project [privacy policy](PRIVACY.md). Security or signing-policy issues
can be reported through the repository's GitHub Issues page.

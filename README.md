# DeepSeek Harness Desktop

Unofficial Windows desktop shell for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Runtime

- Default checkout: `D:\deepseek-harness`
- Override: set `DEEPSEEK_HARNESS_DIR`
- Required commands: `git`, `node`, and `pnpm`
- State and staged runtimes: `%APPDATA%\deepseek-harness-desktop`

The app starts Harness on an OS-selected loopback port. On startup it checks
`origin/master`. A new commit is built in an isolated Git worktree and becomes
active only after the process passes its HTTP health check.

The packaged desktop app also checks this repository's latest GitHub Release.
Desktop updates download in the background and are installed after confirmation
or when the app exits.

## Development

```powershell
pnpm install
pnpm test
pnpm start
```

## Windows package

```powershell
pnpm dist
```

The preview is unsigned, so Windows SmartScreen may warn on first launch.

## Automated releases

GitHub Actions checks the official Harness `master` branch every six hours. A
new upstream commit is installed and built first; only a successful build can
produce a new Windows release. Pushes to `main` also create a release for shell
changes.

This project is community maintained and is not an official DeepSeek release.

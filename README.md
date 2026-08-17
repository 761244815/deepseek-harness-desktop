# DeepSeek Harness Desktop

Unofficial Windows desktop shell for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Runtime

- Official runtime package: `@deepseek-ai/dsh` from the npm `latest` tag
- Required runtime: Node.js 22.19.0 or newer (including `node` and `npm`)
- State and isolated runtimes: `%APPDATA%\deepseek-harness-desktop`
- Legacy checkout fallback: `D:\deepseek-harness` (override with `DEEPSEEK_HARNESS_DIR`)

The app starts the last verified Harness runtime immediately on an OS-selected
loopback port. It checks the npm `latest` tag in the background. A new official
package is installed in an isolated directory and is activated on the next
start only after installation verification. If the new runtime fails its HTTP
health check, the app falls back to the previous runtime.

Existing installations keep their source checkout as a migration fallback.
After the first npm runtime is staged and activated, Git and pnpm are no longer
needed for normal use.

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

## Code signing policy

The project has applied for free code signing provided by SignPath.io,
certificate by SignPath Foundation. Releases remain explicitly marked as
unsigned until the application is approved and signing is integrated.

See the [code signing policy](CODE_SIGNING_POLICY.md) and
[privacy policy](PRIVACY.md).

## Automated releases

GitHub Actions tests and publishes Windows packages when the desktop shell
changes. Harness updates are delivered independently through the official npm
`latest` tag, so an upstream source commit no longer triggers a desktop release.

This project is community maintained and is not an official DeepSeek release.

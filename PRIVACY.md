# Privacy policy

DeepSeek Harness Desktop does not include telemetry, analytics, advertising, or
maintainer-operated data collection.

## Network activity

The desktop shell performs the following network requests:

- It checks `deepseek-ai/deepseek-harness` on GitHub for Harness updates.
- It checks this project's GitHub Releases for desktop-shell updates.
- When a Harness update is installed, its package manager downloads public
  dependencies from the registries configured on the user's computer.

These requests expose normal network metadata, such as the user's IP address,
to those services. The desktop shell does not add personal data to the
requests. DeepSeek Harness and user-configured model providers are separate
components and may have their own privacy policies.

## Local data

Runtime builds, update state, and logs are stored under
`%APPDATA%\deepseek-harness-desktop`. They are not sent to the project
maintainer. Users can remove this data after uninstalling the application.

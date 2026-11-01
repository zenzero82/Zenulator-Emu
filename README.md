# Zenulator

Game Boy Advance emulator for mobile and browsers.

## Source layout

- `artifacts/gba-emu`: Expo mobile application and shared emulator core.
- `artifacts/zenulator-web`: browser application and local game library.
- `artifacts/api-server`: backend and multiplayer relay.
- `lib`: shared API, schema and database packages.

## Development

Use Node.js and pnpm. Install dependencies with `pnpm install`.
The browser app requires `PORT` and `BASE_PATH`; for example:

```sh
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/zenulator-web dev
```

The backend requires its database configuration and `PORT`.
The mobile app retains its existing application identifiers, Expo
project linkage and development-host environment configuration.
Configure hosts for your environment before running outside the
original development workspace. Native signing credentials are not
included; never change package identifiers to work around signing errors.

Check types with `pnpm typecheck`. Run core regression tests with:

```sh
node --test --test-concurrency=2 artifacts/gba-emu/emulator/__tests__/*.test.js
```

## Distribution

No commercial game ROMs, personal saves, secrets or signing credentials
are included. The small test ROM is a synthetic regression fixture.
Preserve third-party licenses and contributor credits. Package metadata
is not a substitute for permission to redistribute third-party content.

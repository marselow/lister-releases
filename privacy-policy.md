# Privacy Policy — Meowl Extension

_Last updated: 2026-05-14_

This page describes what data the **Meowl Extension** (Chrome browser
extension) collects and how it is used.

## What the extension does

Meowl Extension reads the user's authentication cookie from `eldorado.gg`
and forwards it to the user's locally-installed **Meowl Lister** desktop
application over `localhost`. This allows the desktop app to authenticate
against Eldorado's API on the user's behalf without the user having to
manually copy and paste their session cookie.

## Data collected

The extension accesses **one type of data**:

- **Authentication cookies** issued by `eldorado.gg` to the currently
  logged-in user.

The extension does **not** access, collect, or transmit:

- Personal information (name, address, email, age, ID numbers)
- Health information
- Financial or payment information
- Personal communications (emails, messages)
- Location data
- Web browsing history
- User activity (clicks, keystrokes, mouse movement)
- Page content (text, images, audio, video)

## How the data is used

Cookies are read only from `eldorado.gg` and forwarded **only to**
`http://127.0.0.1` (localhost) on a port chosen by the user's locally
installed Meowl Lister desktop app. Cookies are never sent to a remote
server, never sold, never shared with third parties, and never stored
beyond the user's own machine.

## Storage

The extension uses Chrome `storage` only to remember the local port that
the desktop app is listening on. No user identifiers, session content, or
personal data is persisted.

## Third parties

The extension does not communicate with any third-party service. All data
flow is strictly between the user's browser and the user's own local
desktop application.

## Remote code

The extension does not load or execute any code from remote sources. All
JavaScript is bundled in the published package.

## Permissions

| Permission | Why |
| --- | --- |
| `cookies` | Read the user's Eldorado.gg session cookie. |
| `host_permissions` for `*://*.eldorado.gg/*` | Required to read cookies on the Eldorado domain. |
| `storage` | Remember the local port where the desktop app is listening. |
| `alarms` | Periodically re-sync the cookie when the user's session refreshes. |

## Children's data

The extension does not knowingly collect data from children.

## Changes to this policy

This policy may be updated when the extension's functionality changes.
Updates will be published at the same URL.

## Contact

For questions or removal requests, email: **quitetemarcelo12@gmail.com**

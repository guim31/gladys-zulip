# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-22

### Added

- Talk to Gladys from Zulip: each Gladys user links their Zulip account with a
  code, then writes to the bot in a direct message; the answers of Gladys, the
  _Send Message_ scene action and the system messages arrive there, camera
  images included.
- A list of allowed people (e-mails or user ids): the bot ignores everyone
  else, and every bot. Empty by default.
- Watched channels and the _Zulip message received_ and _Zulip command
  received_ triggers (`!lights off`: command `lights`, arguments `off`),
  filtered by channel, topic and sender.
- The _Send a Zulip message_ scene action, to a channel and topic, or to a
  person, with the outputs sent, message id and error.
- The _Zulip connection lost_ and _Zulip connection restored_ triggers, and
  the connection status of the Configuration screen.
- The _Zulip_ dashboard widget and the _Test the connection_ action.
- Real-time messages over the event queue of Zulip, automatic reconnection,
  and the messages of the last 5 minutes read back after a restart.
- English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-zulip/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-zulip/releases/tag/v1.0.0

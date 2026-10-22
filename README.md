# Zulip for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that connects a generic bot of [Zulip](https://zulip.com), the open-source team
chat organized in channels and topics, to Gladys: talk to Gladys in a direct
message, receive the messages of Gladys there, post in Zulip channels from your
scenes, and start scenes on a message or a command such as `!lights off`. Works
with a self-hosted server on the local network or with Zulip Cloud.

> **Developed without the hardware: feedback welcome.** The integration was
> tested against a real Zulip server (the `ghcr.io/zulip/zulip-server` 12.3
> Docker image), in both directions, but not inside a real Gladys nor with every
> Zulip app. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-zulip/issues) or on the
> [Gladys forum](https://community.gladysassistant.com).

## Features

- **A two-way chat channel**, like the Telegram bot of Gladys (manifest
  `type: "communication"`, `messaging.receive: true`): each Gladys user links
  their Zulip account with a code from the Configuration screen, then talks to
  Gladys in a direct message with the bot. The answers of Gladys, the _Send
  Message_ scene action and the system messages arrive there; camera images
  arrive as images.
- **Allowed people only**: the bot ignores the messages of everyone who is not
  in the list (e-mails or user ids), which is empty by default, and of every
  bot. Gladys never answers in a channel or a group direct message, where
  others can read.
- **Scene triggers**: _Zulip message received_ (in a watched channel, filtered
  by channel, topic and sender), _Zulip command received_ (prefix + word, e.g.
  `!garage close`, with the arguments as a variable), _Zulip connection lost_,
  _Zulip connection restored_.
- **Scene action** _Send a Zulip message_: Markdown and scene variables, to a
  channel and topic, or to a person (e-mail or `@` + user id). Outputs: sent,
  message id, error.
- **Dashboard widget** _Zulip_: connection, bot e-mail, watched channels, the
  last messages of the watched channels, a _Test the connection_ button.
- Real time over the event queue of Zulip, automatic reconnection, and the
  messages of the last 5 minutes read back after a restart.
- Four languages (English, French, German, Spanish).

Compared with [Apprise for Gladys](https://github.com/guim31/gladys-apprise),
which sends notifications to Zulip among 100 other services, this integration
also receives: conversations with Gladys, commands and triggers. It follows the
design of [Mattermost for Gladys](https://github.com/guim31/gladys-mattermost)
and [Rocket.Chat for Gladys](https://github.com/guim31/gladys-rocketchat): same
trigger and action keys, same linking, same guards.

## Requirements

- Gladys Assistant **5.1.0** or later.
- A Zulip organization Gladys can reach (a server of version 7 or later, or
  Zulip Cloud) and a **generic bot** of this organization.

## Installation

In Gladys: **Integrations → Install from GitHub**, then enter
`https://github.com/guim31/gladys-zulip`. Fill in the organization address,
the e-mail and the API key of the bot and the allowed people, click **Test the
connection**, then each user links their account. The full documentation is in
[docs/en.md](docs/en.md) (also in [French](docs/fr.md), [German](docs/de.md)
and [Spanish](docs/es.md)).

## How it works

- REST API `/api/v1` with the bot e-mail and API key (HTTP Basic):
  `GET /users/me`, `GET /users` (the allowed people, by user id or e-mail),
  `GET /get_stream_id` then `POST /users/me/subscriptions` (the bot joins a
  public watched channel; checked first, as subscribing to an unknown name
  creates the channel), `POST /messages`, `POST /user_uploads` (camera
  images), `GET /messages` (catch-up after a restart). A 429 is honored.
- An event queue (`POST /register`, `event_types: ["message"]`, raw Markdown)
  read by long polling (`GET /events`). Zulip keeps the queue 10 minutes
  without a poll: a short cut loses nothing; an expired queue
  (`BAD_EVENT_QUEUE_ID`) is replaced at once and the missed messages are read
  back. No dependency but the Gladys SDK.
- Watched channels fire the triggers only; a direct message between the bot
  and one allowed person is a conversation with Gladys (`linkContact`,
  `publishMessage`, `onSendMessage`); anything else is ignored. The bot's own
  messages and those of other bots are ignored, so a scene answering a message
  cannot loop.

## Limits

- Text only: files, images and voice messages sent to the bot arrive as their
  Markdown link.
- The answers of Gladys go to the direct message, never to a channel topic.
- One bot per Gladys. Messages missed during a cut longer than 5 minutes are
  skipped.

## Development

```bash
npm install
npm test            # node --test, against the fake Gladys of the SDK and a fake Zulip
npm run lint
npm run format:check
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

## Credits

- The [Zulip REST API documentation](https://zulip.com/api/) (real-time events,
  messages, users, channels). The test fixtures are answers recorded from a
  real Zulip 12.3 server running in Docker
  ([docker-zulip](https://github.com/zulip/docker-zulip)), with test accounts.
- The [Zulip Python API](https://github.com/zulip/python-zulip-api)
  (Apache-2.0), whose `call_on_each_event` shows how to handle an expired event
  queue. No code was copied. Home Assistant has no Zulip integration; Zulip
  notifications in Home Assistant go through Apprise.
- The logo on the cover is the Zulip logo (`zulip-org-logo.svg`, recolored
  white on the brand gradient) from the
  [zulip/zulip](https://github.com/zulip/zulip/tree/main/static/images/logo)
  repository (Apache-2.0; a trademark of Kandra Labs, Inc.).
- The architecture, the `/data` store and the quiet logs come from
  [gladys-mattermost](https://github.com/guim31/gladys-mattermost) and
  [gladys-matrix](https://github.com/guim31/gladys-matrix); the tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Kandra Labs, Inc.
Zulip is a trademark of Kandra Labs, Inc.

## License

Apache-2.0

# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration keeps and where:

- The configuration (organization address, bot e-mail, API key, allowed
  people, watched channels) is stored by Gladys; the API key is a `secret`
  field.
- `/data/zulip-state.json` holds the id of the last message seen and of the
  last messages handled (to read back what was posted during a restart,
  never twice), and the last 5 messages of the watched channels (for the
  widget). No direct message is stored, nor the API key.
- The integration only talks to the configured Zulip server (HTTPS or HTTP)
  and to Gladys. It never logs the API key.

The bot passes the messages of a linked person to Gladys with the authority of
that Gladys user, and only for the people of the allowed list (never a bot).
The Zulip server can read every message, as for any Zulip conversation.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the third-party services and devices the integration talks to (the
Zulip server and its apps).

# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues, pull requests or discussions.

Use GitHub's private vulnerability reporting on [`augusto-dmh/notula`](https://github.com/augusto-dmh/notula): open the repository's **Security** tab and choose **Report a vulnerability**. This is the only reporting channel; there is no security email address. Include:

- what the issue is and what an attacker could do with it;
- the Notula version and your operating system;
- steps to reproduce, or a proof of concept;
- any fix or mitigation you suggest.

You should get an acknowledgement within 7 days. We'll keep you posted while we work on a fix, agree on a disclosure date with you, and credit you in the release notes unless you'd rather not be named.

## Supported versions

Only the latest release gets security fixes. Installed copies update themselves, so please confirm the issue on the latest version before you report it.

## Scope

In scope: the Notula desktop app and its installer, the browser extension and its native-messaging host, the update feed, the local MCP server and local API, the companion CLI, and the handling of stored data and keys.

Out of scope: vulnerabilities in third-party services that Notula connects to with your credentials. Please report those to the service. Issues in bundled dependencies are welcome if they affect Notula.

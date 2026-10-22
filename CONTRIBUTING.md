# Contributing to Notula

Thanks for helping. This page covers what we need from every contribution. Please read it before you open a pull request.

## Sign your commits (DCO)

Notula uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/). By signing off a commit, you certify that you wrote the change, or otherwise have the right to submit it, under the project's licence (Apache-2.0).

Add the sign-off with `git commit -s`. It appends a line with your real name and email:

```text
Signed-off-by: Your Name <you@example.com>
```

Every commit in a pull request needs the sign-off. If you forgot it, run `git commit --amend -s` for the last commit, or `git rebase --signoff main` for several.

The full DCO text:

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Where your contribution comes from

Notula's code is written for this project. To keep it that way:

- **Don't submit code, text or assets derived from proprietary software.** That includes anything you got by decompiling, disassembling or otherwise reverse engineering a closed-source product, and anything based on source code you've seen under a non-open licence (for example at work or under an NDA).
- **Open-source material is welcome when its licence allows it.** Say where it comes from in the pull request, keep its copyright notice, and make sure its licence is compatible with Apache-2.0.
- **Disclose conflicts.** If your job, a contract or past exposure to a competing product's internals could affect a change, say so in the pull request and step back from that area. Someone else can pick it up.
- **No reverse-engineering output.** Don't paste decompiled code, disassembly, extracted strings or other tool output from closed-source products into issues, discussions or pull requests.
- **Uncertain origin.** Maintainers may decline or revert any contribution whose origin is unclear.

## AI-assisted contributions

AI coding assistants are allowed. You must:

- disclose it in the pull request description: which tool, and roughly what it produced;
- review and understand every line you submit, and be able to explain it;
- make sure the output meets the rules above. You are responsible for it, as if you had typed it yourself.

Your DCO sign-off covers AI-assisted work too.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork, create a branch, and keep each pull request to one change.
3. Run `npm run typecheck && npm run build`; both must pass. If you touched an area with a check under `scripts/dev/`, run that check too.
4. Describe what changed, why, and how you tested it.

## Style

- **Code:** TypeScript, matching the code around your change: its naming, its comment density, and its idiom. Comments explain why, not what.
- **Interface text:** every word the app shows follows [`style/COPY.md`](style/COPY.md).
- **Licence headers:** new source files start with `// SPDX-License-Identifier: Apache-2.0` (or `/* … */` in CSS, `#` in PowerShell).
- **Naming:** describe Notula on its own terms. Don't name or compare it to other products in code, comments, docs or commit messages.

## Security issues

Don't open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

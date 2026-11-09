# Code signing policy / コード署名ポリシー

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

*SignPath Foundation への申請中です。承認されるまで、インストーラーは署名なしで配布しています。*
*The application to SignPath Foundation is in progress. Until it is approved, the installers are distributed unsigned.*

## What is signed / 署名するもの

- The Windows installer of SpellSheet Writer (`SpellSheet.Writer_<version>_x64-setup.exe`) published on [GitHub Releases](https://github.com/spellsheet/spellsheet/releases)
- Only files built from this repository by the [Release workflow](.github/workflows/release.yml) on GitHub Actions are submitted for signing. Nothing built on a personal computer is signed
- Product name `SpellSheet` and the version in the root `Cargo.toml` are the same in every signed file

## Team roles / 役割

| Role | Members |
| --- | --- |
| Committers and reviewers | Members of the [spellsheet organization](https://github.com/orgs/spellsheet/people) |
| Approvers | [@d-shiina](https://github.com/d-shiina) |

- Every change goes into `main` through a pull request, and CI must pass before it is merged
- Changes from people outside the organization are reviewed by a committer before merging
- Every signing request is approved by hand by an approver
- Everyone in these roles uses multi-factor authentication for GitHub and SignPath

## Privacy policy / プライバシー

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

SpellSheet が自分から外部に送る情報はありません。通信するのは次の場合だけです。

- **Update check**: at startup (and with "Check again" in Settings), Writer downloads `latest.json` from this repository's GitHub Releases. No user data, flows or files are sent. The request is an ordinary download from GitHub, and [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) applies
- **Plugin list**: when you open the list of plugins, Writer downloads the public list from `spellsheet.github.io`. No user data is sent
- **What you set up yourself**: flows send data only to the sites, mail servers and cloud services written in them (for example Microsoft 365 or Box), and the AI chat in Writer uses the AI service you signed in to (for example Claude or ChatGPT). The privacy policies of those services apply

Execution logs, flows, screenshots for run manuals and credentials stay on your PC. See [docs/design/personal-data.md](docs/design/personal-data.md) for how personal data in logs is handled.

## Reporting / 問い合わせ

Report a suspicious signed file or a policy violation through [SECURITY.md](SECURITY.md).

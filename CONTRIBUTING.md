# Contributing

TAi is the code of an MS thesis project, built for one course and run on that course's server. The tag `thesis-2026-12` is frozen as the version the thesis describes; `main` may move on.

**Questions, bug reports and ideas are welcome as issues.** It helps to say:

- which part of TAi the issue is about (the seven parts are listed in the [README](README.md#what-tai-does));
- which document you read ([docs/README.md](docs/README.md) is the index);
- what you expected, and what happened instead.

**Pull requests.** Open an issue first, so we can agree on the change before you spend time on it. Then:

- **Tests.** Keep them passing (`npm test`), and add one for the behavior you change. The design documents describe how each part is tested.
- **No secrets or personal data.** Never commit secrets, keys, `.env` files, student data, or names of students or course staff. Each student's folder, the database, `data/` and `logs/` stay on the host and are ignored by git.
- **No answers in TAi's replies.** TAi guides students and must not give them assignment answers. Changes to its persona (`groups/global/`) should keep the rules in [groups/global/CLAUDE.md](groups/global/CLAUDE.md).

**Changes to the framework itself** (containers, the skills system, channels) are better proposed upstream to [NanoClaw](https://github.com/gavrielc/nanoclaw), the project TAi is a fork of. NanoClaw's own contribution rules are in its repository.

**Security issues.** Please do not open a public issue; see [SECURITY.md](SECURITY.md).

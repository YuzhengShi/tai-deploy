# Security policy

## Reporting a vulnerability

**Please report security issues privately, not in a public issue.** Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. If that is not available, open an issue that asks for a private way to reach the maintainer, and leave out the details.

A useful report says:

- what part is affected (for example the student page, the tool guard, the Go sandbox or the course-system tools);
- how to reproduce it;
- what an attacker could reach.

## Scope

**In scope:** the code in this repository.

**Not in scope:** the instance that runs for the course. Please do not test against it: it serves real students.

## What is known

TAi's security design is in [docs/SECURITY.md](docs/SECURITY.md), and its sandbox in [docs/GO_SANDBOX.md](docs/GO_SANDBOX.md). The thesis already names these weak points, so there is no need to report them:

- **The Go sandbox uses Docker's default runtime, runc.** A kernel bug could still let code break out. gVisor is not in use, and the planned independent review of the sandbox was never completed.
- **The Canvas token is limited by code, not isolation.** One Canvas token can read the whole class. Inside a student's container, only code restricts it to that student. The agent and the tool service that holds the token share one user account.
- **One admin right grants both views:** the whole class, and students' own words.
- **Two protections depend on the model following its persona, not on code:** staying faithful to what the tools returned, and withholding assignment answers.

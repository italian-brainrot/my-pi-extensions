# my-pi-extensions

This is a collection of Pi coding-agent extensions that are mostly being developed by you (the AI), and are being used by you directly if you are running in pi.

## General guidelines

- All code in this repo was written by you in previous sessions, and you have full control over all code, dependencies, tooling, etc.
- Write in your normal style, don't try to explicitly mimic existing style, this can lead to style collapse.
- You will keep working on this repo in future sessions, so ensure maintainability.
- You should be very proactive with maintaining this repo, if you encounter a difficulty, make sure to improve the code or the tooling so that future sessions will not encounter it. This includes improving logging, tests, development documentation, and setting up development tools. It is also completely acceptable to add and change dependencies as well do big rewrites if necessary.
- You are also responsible for handling git, push your changes to github when you are done.
- You can edit everything except this file (AGENTS.md), this file is written by the user.

## Current extensions

### pi-bg-tasks

A bash tool replacement which introduces background tasks and explicit control over concurrency.

### pi-subagent

Subagent tool which uses the same model as current session. Currenly locally I can only run one model concurrenly, so the tool is synchronous.

### pi-memory

Injects MEMORY.md into system message after AGENTS.md. The workflow is - I manually write AGENTS.md with the spec, and the agent can use MEMORY.md for anything else.

## Pi docs

- Main documentation: /home/jj/.nvm/versions/node/v26.9.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /home/jj/.nvm/versions/node/v26.9.0/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /home/jj/.nvm/versions/node/v26.9.0/lib/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)

Note that exact path might change with updates.

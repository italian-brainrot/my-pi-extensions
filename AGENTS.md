# my-pi-extensions

This is a collection of Pi coding-agent extensions that are mostly being developed by you (the AI), and are being used by you directly if you are running in pi.

## Coding guide for AI agents

- You can edit everything except this file (AGENTS.md), this file is written by the user.
- Everything else in this repo was written by you in previous sessions, and you have full control over all code, dependencies, tooling, style, instructions, etc.
- Instructions other than this file are not necessarily authoritative (may be outdated or written by older and less capable models). You can revise them if you see fit.
- Write in your normal style, don't try to explicitly mimic existing style, this can lead to style collapse.
- You will keep working on this repo in future sessions, so ensure maintainability.
- You should be very proactive with maintaining this repo, if you encounter a difficulty, make sure to improve the code or the tooling so that future sessions will not encounter it. This includes improving logging, tests, development documentation, and setting up development tools. It is also completely acceptable to add and change dependencies as well do big rewrites if necessary.
- You are also responsible for handling git, push your changes to github when you are done.
- Prompts and tool description should generally be short, concise, and avoid unnecessary instructions, to give the model more freedom in how it can use them.
- When testing manually, if you are making requests to LLM, make sure to disable caching for the request, otherwise your own session cache will be invalidated.

## Current extensions

### pi-bg-tasks

A bash tool replacement which introduces background tasks and explicit control over concurrency.

### pi-subagent

Subagent tool which uses the same model as current session. Currenly disabled in pi because there is not enough memory for KV cache from another concurrent conversation.

### pi-memory

Injects MEMORY.md into system message after AGENTS.md. The workflow is - I manually write AGENTS.md with the spec, and the agent can use MEMORY.md for anything else.

### pi-takeover

Kills current session and starts a new one. Can be used for autonomous implement - review loop without concurrent conversations.

## Pi docs

- Main documentation: /home/qq/distrobox/ubuntu/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /home/qq/distrobox/ubuntu/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /home/qq/distrobox/ubuntu/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)

Note that exact path might change with updates.

# `agent_delegate`

## Overview

`agent_delegate` sends a plain-text prompt to a configured ACP peer and waits for the peer to finish before returning a result to the caller.

Use `agent_delegate` when the caller needs the sub-agent's full answer inline.

Use `acp_prompt` when the caller wants fire-and-forget behavior, with completion delivered later through an ACP result artifact and injected notice.

## Parameters

`agent_delegate` accepts:

- `target_group_jid`: peer name returned by `acp_list_remote_agents`
- `prompt`: plain-text prompt sent to the target peer
- `timeout_ms`: optional timeout in milliseconds; defaults to `300000`

## Return Value

`agent_delegate` returns:

```json
{
  "text": "concatenated text chunks from the sub-agent",
  "status": "completed",
  "stop_reason": "end_turn"
}
```

Possible fields:

- `text`: concatenated text chunks received from the peer during the run
- `status`: one of `completed`, `failed`, or `cancelled`
- `stop_reason`: peer stop reason when available, such as `end_turn` or `cancelled`
- `error`: set when the delegation fails or times out

## Usage Example

```json
{
  "name": "agent_delegate",
  "payload": {
    "target_group_jid": "test-peer",
    "prompt": "Summarize the repository status in one paragraph.",
    "timeout_ms": 300000
  }
}
```

## Isolation

Each `agent_delegate` call opens a fresh ACP session for the target peer and removes that session when the call finishes.

The delegated session is isolated from the caller. No prior conversation state is shared automatically.

## Timeout Notes

If `timeout_ms` expires before the peer finishes, `agent_delegate` returns:

- `status: "failed"`
- `error` containing the timeout message

The host also sends a best-effort ACP cancel request to the peer after the timeout fires.

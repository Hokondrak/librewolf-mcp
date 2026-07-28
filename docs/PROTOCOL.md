# Protocol reference

The public server speaks MCP over stdio. Internally, the optional companion design uses JSON-RPC 2.0 messages and native-messaging length framing. The public protocol version types use `1.0`; the extension/native-host internal protocol declares `1.0.0`. These are separate contracts.

## Public MCP tools

All input objects are strict: unknown keys are rejected rather than ignored. Every argument name is `snake_case`. Defaults shown are what the server applies when the field is omitted.

### Session

| Tool             | Input | Annotations                         |
| ---------------- | ----- | ----------------------------------- |
| `browser_status` | none  | read-only, idempotent, closed-world |

Returns `mode`, `state`, `sessionId`, browser path and version, selected tab, per-capability levels, and startup diagnostics. It is the capability source of truth; clients must not infer companion support from the extension's presence.

### Tabs and navigation

| Tool                 | Input                                                                                                              | Annotations                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `browser_list_tabs`  | none                                                                                                               | read-only, idempotent               |
| `browser_select_tab` | one or more of `tab_id`, `index`, `title`, `url`                                                                   | state-changing, idempotent          |
| `browser_open_tab`   | `url` (http, https, or `about:`)                                                                                   | state-changing                      |
| `browser_close_tab`  | one of `tab_id`, `index`                                                                                           | **destructive**, needs confirmation |
| `browser_navigate`   | `url`; `wait_until` = `complete` \| `dom_mutation` \| `network_idle` (default `complete`); `timeout_ms` 100–120000 | state-changing                      |
| `browser_back`       | none                                                                                                               | state-changing                      |
| `browser_forward`    | none                                                                                                               | state-changing                      |

`browser_navigate` waits for a real signal rather than a fixed sleep. Navigation to the URL already loaded is rejected before dispatch, and a distinct-URL timeout is resolved by verifying the final URL (COMPATIBILITY.md item 6).

### Reading the page

| Tool                 | Input                                                                                                                                                                                                                                            | Annotations                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `browser_snapshot`   | `selector`; `interactive_only` (false); `include_text` (true); `include_attributes` (false); `include_bounds` (false); `max_depth` 1–50; `max_chars` 256–2000000 (20000); `max_elements` 1–10000 (500); `changed_since_snapshot`; `save_to_file` | read-only, idempotent          |
| `browser_find`       | `text` (required); `exact` (false); `role`; `limit` 1–100 (20)                                                                                                                                                                                   | read-only, idempotent          |
| `browser_get_text`   | one of `uid`, `selector`; `max_chars` 1–1000000 (20000)                                                                                                                                                                                          | read-only, idempotent          |
| `browser_screenshot` | `uid`; `path`                                                                                                                                                                                                                                    | state-changing (writes a file) |

Snapshots return a bounded accessibility-style tree wrapped in an explicit untrusted-content boundary. `changed_since_snapshot` takes a prior `snapshotId` and returns only added (`+`), removed (`-`), and materially changed (`~`) elements.

Form-control roles are normalized to ARIA roles because LibreWolf reports the HTML tag (COMPATIBILITY.md item 4). The original token is preserved as `tag=`, so `input type="email"` renders as `textbox "Email" tag=input`.

### Interaction

| Tool                    | Input                                              | Annotations                            |
| ----------------------- | -------------------------------------------------- | -------------------------------------- |
| `browser_click`         | `uid`; `double_click` (false)                      | state-changing                         |
| `browser_hover`         | `uid`                                              | state-changing, idempotent             |
| `browser_fill`          | `uid`; `value`                                     | state-changing                         |
| `browser_fill_form`     | `fields`: 1–100 × `{uid, value}`                   | state-changing                         |
| `browser_select_option` | `uid`; `values`: 1–100 strings                     | state-changing                         |
| `browser_press_key`     | `key`; `uid`                                       | state-changing                         |
| `browser_scroll`        | `uid`; `delta_x`; `delta_y`; `direction`; `amount` | state-changing                         |
| `browser_upload_file`   | `uid`; `path`                                      | state-changing, **needs confirmation** |

Every action resolves the UID, verifies the tab and navigation generation, and confirms the element is present and interactable before dispatch. Filled values are never written to logs.

### Diagnostics and downloads

| Tool                    | Input                                                                                                                                                          | Annotations |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `browser_get_console`   | `severity`; `errors_only` (false); `text`; `source`; `since_ms`; `limit` 1–1000 (100); `clear_after_reading` (false)                                           | read-only   |
| `browser_get_network`   | `resource_type`; `status`; `status_min`; `status_max`; `url`; `method`; `since_ms`; `errors_only` (false); `limit` 1–1000 (100); `clear_after_reading` (false) | read-only   |
| `browser_get_request`   | `request_id`                                                                                                                                                   | read-only   |
| `browser_get_downloads` | `status`; `url`; `limit`; `clear_after_reading`                                                                                                                | read-only   |

`browser_get_network` returns a compact list with request IDs; retrieve one request in full with `browser_get_request`. Response bodies are never returned by default. Authorization headers, cookies, tokens, passwords, sensitive query parameters, and serialized request bodies are redacted before any result or log leaves the adapter.

### Batching

`browser_batch` takes `actions` (1–25) and `continue_on_error` (default `false`). It is annotated destructive and requires confirmation, because the batch may contain destructive steps.

Supported ops: `status`, `list_tabs`, `select_tab`, `open_tab`, `close_tab`, `navigate`, `back`, `forward`, `snapshot`, `find`, `get_text`, `click`, `hover`, `fill`, `fill_form`, `select_option`, `press_key`, `scroll`, `upload_file`, `screenshot`, `get_console`, `get_network`, `get_request`, `get_downloads`, `wait_for_text`.

Name a result with `as`, then reference it from a later action with `$name.path` or `{"$ref": "name.path"}`.

**A snapshot taken inside a batch supersedes the UIDs of any earlier snapshot.** A batch that snapshots and then acts must therefore reference the UIDs that snapshot issued. Every snapshot result carries a `uids` index keyed by accessible name and by `role:name`:

```json
{
  "actions": [
    { "op": "snapshot", "as": "page" },
    { "op": "fill", "uid": { "$ref": "page.uids.Email" }, "value": "test@example.com" },
    { "op": "click", "uid": { "$ref": "page.uids.Save" } },
    { "op": "wait_for_text", "text": "Saved" }
  ]
}
```

The batch stops at the first failure and reports `stoppedAt` unless `continue_on_error` is set. `transportCalls` is `1` regardless of action count: the whole batch crosses the MCP and native-messaging boundary once.

## Internal companion messages

The extension sends `extension.execute` JSON-RPC requests with a request ID, operation, optional target, arguments, deadline, and idempotency key. Native messaging reserves stdout for 32-bit little-endian length-prefixed JSON frames; diagnostics use stderr only.

Before a pipe connection, the host reads `%LOCALAPPDATA%\\LibreWolfAgentBridge\\runtime\\discovery-v1.json`. It requires a regular, non-symlink file under 64 KiB, validates schema version `1`, a `\\\\.\\pipe\\librewolf-agent-bridge\\` pipe name, a 32-byte base64url token, an HMAC scheme, compatible semantic protocol range, and a fresh heartbeat. On Windows, the native helper also verifies a protected current-user-only discovery-file DACL, the pipe owner SID, server PID plus process creation time, and remote-client rejection. The mutual HMAC handshake derives directional keys; every subsequent JSON-RPC message carries a verified MAC and monotonically increasing sequence.

## Structured errors

Bridge errors are returned as an MCP error result whose text is JSON: `{"code", "message", "details"}`. `details` may carry `stage`, `recoverable`, `hint`, and redacted context. The complete code set is:

| Code                             | Recoverable | Meaning                                                        |
| -------------------------------- | ----------- | -------------------------------------------------------------- |
| `BROWSER_NOT_FOUND`              | no          | No LibreWolf executable was located or the given path is wrong |
| `BROWSER_LAUNCH_FAILED`          | no          | The browser or driver failed to start                          |
| `BROWSER_CONNECTION_FAILED`      | no          | The upstream MCP process could not be reached                  |
| `BROWSER_TOOL_CONTRACT_MISMATCH` | no          | The pinned upstream did not advertise a required tool          |
| `CAPABILITY_UNAVAILABLE`         | no          | The capability is unavailable in the active mode               |
| `INVALID_ARGUMENT`               | no          | Input failed schema or semantic validation                     |
| `INVALID_TAB`                    | yes         | The target tab does not exist or is no longer selectable       |
| `PERMISSION_REQUIRED`            | yes         | The user has not yet granted this operation for this origin    |
| `PERMISSION_DENIED`              | no          | The user denied this operation                                 |
| `STALE_REFERENCE`                | yes         | The UID no longer identifies a present element                 |
| `ACTION_BLOCKED`                 | yes         | The element is hidden, disabled, or otherwise not interactable |
| `TIMEOUT`                        | yes         | The operation exceeded its deadline                            |
| `OUTCOME_UNKNOWN`                | yes         | Dispatch succeeded but the result could not be confirmed       |
| `UPSTREAM_ERROR`                 | varies      | An unclassified upstream failure, message preserved            |
| `SHUTDOWN`                       | no          | Shutdown did not complete cleanly; details list what remained  |

After `STALE_REFERENCE`, take a new snapshot and retry with a current UID. Never guess a replacement selector: the bridge deliberately refuses to resolve a stale UID to a similar-looking element.

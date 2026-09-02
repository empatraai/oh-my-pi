# Empatra host: explicit extension lifecycle

The Empatra host exposes the OMP extension lifecycle through the versioned
`extensions.explicit-v1` capability. This is an explicit-only lane: the host
does not discover extensions, plugins, hooks, MCP configuration, or settings
from the user or project filesystem.

## Bootstrap contract

`host_initialize.extensions` is an optional list of at most 32 descriptors:

```json
{
  "filePath": "/private/session/runtime/extensions/policy.ts",
  "id": "policy",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Before a session is created, OMP resolves each path with `realpath`, requires a
regular file under the private session directory, verifies the SHA-256 digest,
and rejects duplicate ids or paths. The verification is repeated immediately
before each session bind to avoid retaining a stale trust decision if the
staged file changes while the host is alive.

The extension factory and its lifecycle handlers run inside OMP. This is only
for modules explicitly staged and authorized by Electron main. The restricted
host session still does not expose extension-registered tools: dynamic tools
remain main-owned through `host_tools_replace`, while extension handlers may
observe the OMP session lifecycle. Ambient discovery and MCP remain disabled.

The initialize response includes `extensionCount` so the controller can
confirm which explicit modules were accepted without receiving source paths or
module contents.


# Godot LSP Client — Handoff Notes

## Discovered Facts

### Connection details

- **Host:** `127.0.0.1`
- **Port:** `6005` (configured in `~/.config/godot/editor_settings-4.7.tres` under `network/language_server/remote_port`)
- **Godot version:** 4.7 stable (`Godot_v4.7-stable_linux.x86_64`)
- **PID:** `88243` (at time of discovery — will change on restart)
- **Project path:** `/home/edgars/hub/darkspread/darkspred`

### Protocol

Standard JSON-RPC 2.0 over TCP, framed with **Content-Length HTTP-style headers** (same transport as VS Code's LSP client):

```
Content-Length: <N>\r\n\r\n<JSON payload>
```

Each message is a separate Content-Length block. Multiple messages can be concatenated on the wire — parse by reading `Content-Length`, then that many bytes, then repeat.

### Verified handshake sequence

1. Connect to `127.0.0.1:6005`
2. Send `initialize` request (id=1):
   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":"file:///home/edgars/hub/darkspread/darkspred","capabilities":{}}}
   ```
3. Server sends back a `gdscript_client/changeWorkspace` notification (unsolicited, ignore or handle)
4. Server sends back the `initialize` response with capabilities
5. Send `initialized` notification (no id):
   ```json
   {"jsonrpc":"2.0","method":"initialized","params":{}}
   ```
6. LSP is now ready

### Supported capabilities (confirmed)

| Capability | Value |
|---|---|
| `completionProvider` | Yes, resolveProvider=true, triggers: `.`, `$`, `'`, `"` |
| `definitionProvider` | Yes |
| `declarationProvider` | Yes |
| `hoverProvider` | Yes |
| `referencesProvider` | Yes |
| `renameProvider` | Yes, prepareProvider=true |
| `documentSymbolProvider` | Yes |
| `documentHighlightProvider` | Yes |
| `signatureHelpProvider` | Yes, triggers: `,`, `(` |
| `textDocumentSync` | incremental (change=1), openClose=true, save includeText=true, willSaveWaitUntil=true |
| `codeActionProvider` | No |
| `documentFormattingProvider` | No |
| `colorProvider` | No |
| `workspaceSymbolProvider` | No |

### Known methods to implement

**Requests (send id, expect response):**
- `initialize` — handshake
- `textDocument/completion` — completions at cursor position
- `completionItem/resolve` — resolve a completion item for full details
- `textDocument/definition` — go to definition
- `textDocument/declaration` — go to declaration
- `textDocument/hover` — hover info
- `textDocument/references` — find references
- `textDocument/rename` (with `/prepareRename`) — rename symbol
- `textDocument/documentSymbol` — document outline
- `textDocument/documentHighlight` — highlight references in current doc
- `textDocument/signatureHelp` — function signature info

**Notifications (no id, fire-and-forget):**
- `initialized` — after initialize response
- `textDocument/didOpen` — open a file
- `textDocument/didClose` — close a file
- `textDocument/didChange` — incremental edits (change=1)
- `textDocument/didSave` — save (includeText=true)

**Server→client notifications:**
- `gdscript_client/changeWorkspace` — workspace path changed

### What still needs doing

- [ ] Write the Bun client code (`index.ts`) — TCP socket + Content-Length framing parser + JSON-RPC layer
- [ ] Decide on CLI interface: REPL? file watcher? stdin pipe?
- [ ] No `.gd` files exist in the project yet — testing will need a sample file or creating one

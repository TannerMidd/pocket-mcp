# pocket-mcp

MCP servers for [Pi Pocket](https://github.com/TannerMidd/pi-pocket). This drop-in extension connects Pi Pocket to the [Model Context Protocol](https://modelcontextprotocol.io) servers in Pi's own `mcp.json`. Pi can then find and call the tools of these servers.

Pi's terminal app has MCP built in. Pi Pocket runs on Pi Durable, and does not have it. This extension gives it to Pi Pocket, with Pi's own MCP client (`@earendil-works/pi-mcp`) and Pi's own configuration file. Thus the terminal app and Pi Pocket use the same servers.

> [!WARNING]
> **An MCP server is a program that runs with your rights.** A stdio server can read and change all your files, and an HTTP server gets the data that Pi sends to it. Lancet Guard does not check the calls of MCP tools. Turn on only the servers that you trust. Each person who can steer a session can make Pi call the tools of the servers that are on.

## What it adds

- **The MCP page** (for the owner only): the plug button on the rail, or **MCP servers** in the launcher. It shows each server of `mcp.json`, its entry, its state, its error output, and its tools. On this page you can:
    - turn a server on or off in Pi Pocket,
    - connect a server again,
    - sign in to an HTTP server, or sign out,
    - let plan mode run the tools that a server marks read-only.
- **Three tools for Pi:**
    - `mcp_tools` lists the tools of the servers that are on, with the arguments of each tool. It can find tools by words, or give one tool by its name. A schema always goes whole: in a list too long for every schema, a large one is named, and Pi asks for that tool to get it.
    - `mcp_call` calls a tool.
    - `mcp_call_read_only` calls a tool too, but only a read-only tool (see [Plan mode](#plan-mode)). Plan mode lets Pi use it.
- **A section in Pi's system prompt** that names the servers that are on, with the `description` of each server from `mcp.json`.

## Install

You need a Pi Pocket release after 0.14.0. From that release, drop-ins can import `@earendil-works/pi-mcp`.

1. Copy `mcp.ts` and the `mcp/` folder into `~/.pi-pocket/extensions/`.
2. Read the code. A drop-in runs inside the server with your rights.
3. Open **Menu → Extensions**, and turn on **mcp**.

## Add servers

The extension reads `~/.pi/agent/mcp.json`: the user file of Pi's terminal app. Use the same format, or add a server with Pi's commands in a terminal:

```bash
pi mcp add notes -- npx -y @modelcontextprotocol/server-memory@2026.8.31
pi mcp add docs --url https://example.com/mcp
```

```json
{
    "mcpServers": {
        "notes": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory@2026.8.31"]
        },
        "docs": {
            "url": "https://example.com/mcp",
            "description": "Search the product documentation"
        }
    }
}
```

Pi's [MCP documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) tells all the fields. Then open the MCP page, and tap **Read mcp.json again**.

### Turn a server on

A new server is off in Pi Pocket. Examine its entry on the MCP page, then turn it on with its switch. Pi Pocket then starts it, and Pi can use its tools.

The page shows each part of the entry: the command and its arguments, or the address, and `cwd`, `env`, `headers`, `oauth`, and the other fields. All values show in full, with these exceptions:

- A value of `env` or `headers` whose name looks secret (it has `TOKEN`, `KEY`, `SECRET`, `PASS`, `AUTH`, `COOKIE`, `CREDENTIAL`, `SESSION`, or `PRIVATE` in it), and `oauth.clientSecret`, show only their length and the variables that they name (`${GITHUB_TOKEN}`).
- A command (`!gh auth token`) always shows in full.

Values that change what a program runs show in full, also when their names look secret: `NODE_OPTIONS`, `PATH`, `LD_PRELOAD`, `GIT_ASKPASS`, `BASH_ENV`, and similar names. The address shows in full too, with its query: keep tokens out of the address.

The switch keeps a fingerprint (a SHA-256 hash) of the entry that the page showed. When the entry changes, Pi Pocket stops the server at its next read of `mcp.json`: when it starts, when you tap **Read mcp.json again**, and when you use a switch. The page then shows **Changed**, and which parts changed. Examine them, then turn the server on again.

`"enabled": false` in `mcp.json` turns a server off in the terminal app and in Pi Pocket.

#### What the switch does not stop

The switch stops a changed entry that you did not see. For example, Pi can change `mcp.json` with the `edit` tool after you allow it in a hurry. But the switch cannot stop a program that runs as your user, such as a shell command of Pi. Such a program can also change the module's own settings, the scripts that a server runs, or a package that `npx` downloads. Lancet Guard judges Pi's shell commands and writes; it does not judge MCP calls. So:

- Give exact package versions (`@2026.8.31`, not `@latest` or no version).
- Run servers from folders that Pi does not work in.

### How Pi Pocket runs servers

- **One copy for all sessions.** Pi Pocket starts one copy of each server, and all sessions use it. The terminal app starts a copy for each session, in the session's folder.
- **The folder.** A stdio server runs in the folder that its `cwd` gives. A relative `cwd`, and no `cwd`, start from your home folder. So an argument such as `.` is your home folder, not the folder of a session. Give a full path instead.
- **No roots.** Pi Pocket does not send roots (folders) to servers.
- **Environment.** A stdio server gets the environment of Pi Pocket's server, and the `env` of its entry. Values in `env` and `headers` can name environment variables (`${GITHUB_TOKEN}`) or run a command (`"!gh auth token"`), as in the terminal app.
- **Exposure.** Pi Pocket does not use `exposure` and `toolExposure`, except `hidden`: a hidden tool is not available to Pi. All other tools are available through `mcp_tools` and `mcp_call`.
- **Only the user file.** Pi Pocket does not read the `.pi/mcp.json` of a project. A server serves all sessions, and Pi can write files in a project.
- **Stopping.** When a server goes off, Pi Pocket closes its input, then stops its process group. A program that a server started in a group of its own can continue to run.

### Not supported (yet)

- `auth.provider` (the token of a Pi sign-in) and `oauth.clientRegistration: "cimd"`: the MCP page shows these servers, but Pi Pocket does not run them.
- MCP resources, prompts, and other parts of MCP. Only tools are supported.
- The legacy SSE transport (as in the terminal app).

## How Pi uses the tools

The tools of MCP servers can change at any time, but an extension declares its tools when it loads. So Pi does not get one tool for each MCP tool. It gets three tools that do not change:

1. Pi calls `mcp_tools` to find a tool, its exact name, and its arguments.
2. Pi calls `mcp_call` with the server, the tool, and the arguments.

The reasons for this design:

- **Untrusted text stays out of the tool list.** The names and descriptions of MCP tools come from the servers. They go to Pi only as the result of `mcp_tools`, between tags, with a note that they are data.
- **The prompt cache stays warm.** The tool list does not change when a server connects, disconnects, or changes its tools.
- **What the extension installs is known.** The gallery and Pi Pocket can check the names before the extension loads, and no MCP tool can take the name of another tool.
- **The terminal app works the same way by default.** Its `codemode` exposure does not declare MCP tools to the model either. Pi finds them by search.

In codemode scripts, Pi can call `tools.mcp_call(…)` too. Each call of a script goes through the same checks.

### Results

The result of an MCP tool goes to Pi between `<mcp_result>` tags, with a note that it is data, not instructions. A closing tag in the result cannot close the fence. The text is cut to 40,000 characters. Images go to Pi as images: at most 4, of at most 8 MB of base64 together, and only PNG, JPEG, GIF, and WebP.

When a call fails, Pi gets a short reason. An error message from the server itself goes to Pi between `<mcp_error>` tags (at most 2,000 characters). Pi does not get the server's error output, an HTTP body, or the values of `env` and `headers`. The MCP page shows the full error to the owner.

### Plan mode

Plan mode lets Pi run only tools that change nothing. A server can mark a tool read-only (`readOnlyHint`), but a server can be wrong, or not honest. So Pi Pocket does not trust this mark by default:

- `mcp_call` never runs in plan mode.
- `mcp_call_read_only` runs in plan mode. It runs only a tool that its server marks read-only, and only when you turned on **Plan mode may run the tools that this server marks read-only** for that server. Turn it on only for a server that you trust to mark its tools correctly. The switch works only while the server is on. It goes off when you turn the server off, and when the entry of the server changes.
- `mcp_tools` runs in plan mode. It only lists tools.

### Restarts and reloads

A restart of Pi Pocket can stop a call while it runs. MCP calls are not safe to run two times, so Pi Pocket does not run the call again: Pi gets "interrupted". Only `mcp_tools` runs again, because it only lists tools.

When the module loads again (after an edit, or when you turn it off), a call that runs can finish first, for 10 seconds at most. Then the module stops the servers of its old version, and a call that still runs fails.

## Sign in to an HTTP server

An HTTP server without an `Authorization` header in its entry can ask for an OAuth sign-in. Then the MCP page shows **Needs sign-in**.

1. Tap **Sign in**, then **Open the sign-in page**.
2. Sign in, and approve the access.
3. At the end, the page goes to an address on the machine that runs Pi Pocket (`http://127.0.0.1:…/callback`, or the `oauth.callbackUrl` of the entry).
    - When your browser is on the same machine, the sign-in is complete.
    - When your browser is on another device (for example, a phone), that page does not load. Copy its address from the address bar, paste it in the box on the MCP page, and tap **Finish**.

Why not an address of Pi Pocket? Pi Pocket's routes for extensions accept only signed-in requests with the `X-Pocket` header. A redirect from the sign-in page cannot send this header. The terminal app uses the same loopback address.

Pi Pocket keeps the tokens in `~/.pi-pocket/mcp/oauth.json`, which only your user can read. It refreshes them when they expire. These are not the sign-ins of the terminal app (`~/.pi/agent/mcp-auth.json`): sign in one time in each app. **Sign out** removes the tokens.

The `oauth` fields of an entry work as in the terminal app: `clientId`, `clientSecret`, `callbackPort`, `callbackUrl`, `scope`, `clientName`, and `authServerMetadataUrl`.

## What it reads, writes, and contacts

- **Reads** `~/.pi/agent/mcp.json`, the environment variables that its `env`, `headers`, and `oauth.clientSecret` values name, and the output of the commands that these values give (`!command`, run with your shell).
- **Starts** the stdio servers that you turned on.
- **Contacts** the HTTP servers that you turned on. For a server that signs in with OAuth, it also contacts its authorization server: to sign in, and to refresh the tokens.
- **Writes** `~/.pi-pocket/mcp/settings.json` (the servers that you turned on, with the hashes of their entries, and the plan-mode switches) and `~/.pi-pocket/mcp/oauth.json` (the sign-in tokens). Both are only for your user.
- **Listens** on the loopback address of the redirect (`127.0.0.1` by default) while a sign-in waits, for at most 10 minutes.
- It does not change `mcp.json`.

## Development

The module is TypeScript that Node runs as it is. The repository has no packages of its own: link the `node_modules` and the types of a Pi Pocket checkout, which have TypeScript, ESLint, and Prettier too.

```bash
ln -s /path/to/pi-pocket/node_modules node_modules
ln -s /path/to/pi-pocket/types/pocket.d.ts _pocket.d.ts
npm run check        # tsc
npm run lint         # eslint
npm run format       # eslint --fix, prettier
PI_POCKET=/path/to/pi-pocket npm test
```

Pi Pocket loads `mcp.ts` again when you save it, but not its helpers in `mcp/*.ts`: after a change to a helper, restart Pi Pocket. A change to `mcp/index.js` or `mcp/style.css` loads again in the open tabs.

The tests run a Pi Pocket with temporary data and a scripted model ([Testing](https://github.com/TannerMidd/pi-pocket/blob/main/docs/extensions/testing.md)). `test/fixtures/` has a small stdio server, and a small HTTP server with OAuth (`node test/fixtures/http-server.mjs 8951 --oauth`), for tests by hand.

## License

[MIT](LICENSE)

// The risks of the MCP module, each with one test, on a Pi Pocket with its own temporary data and a scripted model.
// Give the folder of a Pi Pocket checkout in PI_POCKET (default: ../pi-pocket), and link its node_modules here.
//
//   PI_POCKET=/path/to/pi-pocket node --test test/mcp.test.ts
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const pocket = process.env.PI_POCKET ?? join(import.meta.dirname, "..", "..", "pi-pocket");
const from = (path: string) => import(pathToFileURL(join(pocket, path)).href);
// Pi Pocket's helpers first: they point Pi Pocket at a temporary folder before it loads.
const helpers = await from("test/helpers.ts");
const { createHandler } = await from("src/server/http.ts");
const { fauxAssistantMessage, fauxText, fauxToolCall } =
    await import("@earendil-works/pi-ai/providers/faux");

const { root, owner, until, say, modelTexts, newSession, lastText, scriptedModel } = helpers;
const fixture = join(import.meta.dirname, "fixtures", "notes-server.mjs");
const dataDir = join(root, "data");
const notesFile = join(root, "notes.txt");
const pidFile = join(root, "notes.pid");
const SECRET = "sk-test-0123456789";

/** The tool call that the scripted model makes next; it then says what the tool returned. */
let next: { name: string; args: Record<string, unknown> } | undefined;

const model = scriptedModel((context: never) => {
    const { role, text } = lastText(context);
    const call = next;

    if (role === "toolResult" || call === undefined) {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    next = undefined;

    return fauxAssistantMessage([fauxToolCall(call.name, call.args as never)], {
        stopReason: "toolUse",
    });
});

let app: Awaited<ReturnType<typeof helpers.openApp>>;
let server: Server;
let base = "";
let session: unknown;

function writeConfig(servers: Record<string, object>): void {
    writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
        JSON.stringify({ mcpServers: servers }),
    );
}

const notes = (env: Record<string, string> = {}) => ({
    command: process.execPath,
    args: [fixture],
    env: { NOTES_FILE: notesFile, PID_FILE: pidFile, ...env },
});

/** A request to a route of the module, as the owner. */
const request = (path: string, body?: object) =>
    fetch(`${base}/api/x/mcp/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

/** A route's answer, which must be a success. */
async function route(path: string, body?: object) {
    const response = await request(path, body);

    assert.equal(response.status, 200, await response.clone().text());

    return response.json();
}

/** A server as the owner's page has it. */
const shown = async (name: string) =>
    (await route("state")).servers.find((each: { name: string }) => each.name === name);

/** Turn a server on, as the owner does from the page: for the entry that the page shows. */
const turnOn = async (name: string) =>
    route(`servers/${name}/on`, { on: true, fingerprint: (await shown(name)).fingerprint });

/** Have Pi make one call, and give what the tool returned. */
async function ask(name: string, args: Record<string, unknown>): Promise<string> {
    next = { name, args };
    await say(app, session, "go");

    return (await modelTexts(app, session)).at(-1) ?? "";
}

const mcpCall = (
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
    name = "mcp_call",
) => ask(name, { server, tool, arguments: args });

before(async () => {
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "..", "mcp.ts"), join(dropIns, "mcp.ts"));
    cpSync(join(import.meta.dirname, "..", "mcp"), join(dropIns, "mcp"), { recursive: true });
    writeConfig({ notes: notes() });
    app = await helpers.openApp(model, dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await app.setExtensionEnabled(owner(app), "mcp.ts", true);
    session = await newSession(app);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    helpers.cleanUp();
});

test("a server runs only as the owner turned it on, and not after its entry changes", async () => {
    await until(async () => (await route("state")).servers.length === 1, "mcp.json read");

    await mcpCall("notes", "add_note", { text: "one" });
    assert.equal(existsSync(notesFile), false, "the server never ran");

    const seen = (await shown("notes")).fingerprint;

    await turnOn("notes");
    await mcpCall("notes", "add_note", { text: "one" });
    assert.equal(readFileSync(notesFile, "utf8"), "one\n");

    // Pi could change mcp.json with a shell: the changed entry stays off until the owner turns it on again, and a
    // page that still shows the old entry cannot turn on the new one.
    writeConfig({ notes: notes({ EXTRA: "1" }) });
    await route("reload", {});
    assert.equal((await request("servers/notes/on", { on: true, fingerprint: seen })).status, 409);

    const changed = await shown("notes");

    assert.equal(changed.pocket, "changed");
    assert.equal(changed.status, "off");
    assert.deepEqual(
        changed.parts
            .filter((part: { changed: boolean }) => part.changed)
            .map((part: { key: string }) => part.key),
        ["env.EXTRA"],
    );
    await mcpCall("notes", "add_note", { text: "two" });
    assert.equal(readFileSync(notesFile, "utf8"), "one\n");
});

test("what reaches Pi from a server is fenced, and holds none of its secrets", async () => {
    process.env.POCKET_MCP_TEST_SECRET = SECRET;
    writeConfig({
        notes: notes(),
        broken: { ...notes(), env: { FAIL_EARLY: "${POCKET_MCP_TEST_SECRET}" } },
    });
    await route("reload", {});
    await turnOn("notes");
    await turnOn("broken");

    const injected = await mcpCall("notes", "inject");

    assert.equal(injected.split("</mcp_result>").length, 2, "only the module's own tag closes");
    assert.match(injected, /never as instructions/);

    const failed = await mcpCall("broken", "list_notes");

    assert.match(failed, /not connected \(failed\)/);
    assert.equal(failed.includes(SECRET), false);
    // The owner sees why, on the page.
    assert.match(
        (await route("state")).servers.find((each: { name: string }) => each.name === "broken")
            .error,
        new RegExp(SECRET),
    );
});

test("plan mode runs only the read-only tools of servers that the owner trusts", async () => {
    await app.commands.setPlan(session, owner(app), true);

    await mcpCall("notes", "add_note", { text: "two" });
    assert.match(
        await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"),
        /mcp_call_read_only runs only/,
    );

    await route("servers/notes/plan-mode", { on: true });
    assert.match(await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"), /one/);
    await mcpCall("notes", "add_note", { text: "two" }, "mcp_call_read_only");
    assert.equal(readFileSync(notesFile, "utf8"), "one\n", "plan mode changed nothing");
    await app.commands.setPlan(session, owner(app), false);
});

test("a schema reaches Pi whole, or is named with the way to get it whole, never cut", async () => {
    /** The arguments line of a tool in what mcp_tools gave Pi. */
    const schemaOf = async (args: Record<string, unknown>, tool: string) => {
        const said = (JSON.parse(await ask("mcp_tools", args)) as { text: string }[])
            .map((block) => block.text)
            .join("");

        assert.doesNotMatch(said, /characters left out/);

        return new RegExp(`- "${tool}".*\\n  arguments: (.*)`).exec(said)?.[1] ?? "";
    };

    assert.match(
        await schemaOf({ server: "notes" }, "fill_form"),
        /^\(a schema of \d+ characters: give `tool` "fill_form"/,
    );

    for (const args of [{ query: "many fields" }, { tool: "fill_form" }, { tool: "bulk_form" }]) {
        const tool = args.tool ?? "fill_form";
        const schema = JSON.parse(await schemaOf(args, tool));

        assert.equal(Object.keys(schema.properties).length, tool === "fill_form" ? 30 : 415);
    }
});

test("project servers require separate approval, shadow user servers, and stay in their session folder", async () => {
    const userSession = session;
    const project = join(root, "project-a");
    const other = join(root, "project-b");
    const configDir = join(project, ".pi");
    const projectNotes = join(project, "notes.txt");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(other, ".pi"), { recursive: true });
    const config = {
        notes: { command: process.execPath, args: [fixture] },
        private: { command: process.execPath, args: [fixture] },
    };
    const writeProject = (entries: object) =>
        writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: entries }));
    const scoped = (path: string) => `${path}?project=${encodeURIComponent(project)}`;

    writeProject(config);
    session = await newSession(app, project);

    try {
        const state = await route(scoped("state"));
        const entry = state.servers.find((entry: { name: string }) => entry.name === "notes");

        assert.equal(entry.pocket, "off", "user approval does not approve a project server");
        assert.match(await mcpCall("notes", "add_note", { text: "blocked" }), /No MCP server/);
        assert.equal(existsSync(projectNotes), false, "no fallback to the user server");
        await route(scoped("servers/notes/on"), { on: true, fingerprint: entry.fingerprint });
        const privateEntry = state.servers.find(
            (entry: { name: string }) => entry.name === "private",
        );

        await route(scoped("servers/private/on"), {
            on: true,
            fingerprint: privateEntry.fingerprint,
        });
        await mcpCall("notes", "add_note", { text: "project only" });
        assert.equal(
            readFileSync(projectNotes, "utf8"),
            "project only\n",
            "default cwd is the project root",
        );
        assert.equal(readFileSync(notesFile, "utf8"), "one\n", "the user server was not called");
        assert.match(
            await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"),
            /owner has not let plan mode/,
        );
        await route(scoped("servers/notes/plan-mode"), { on: true });
        assert.match(
            await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"),
            /project only/,
        );

        session = await newSession(app, other);
        assert.match(
            await mcpCall("private", "add_note", { text: "cross-project" }),
            /No MCP server/,
        );
        assert.doesNotMatch(await ask("mcp_tools", {}), /Server .private/);
        session = await newSession(app, project);
        await app.setExtensionEnabled(owner(app), "mcp.ts", false);
        await app.setExtensionEnabled(owner(app), "mcp.ts", true);
        assert.match(
            await mcpCall("notes", "list_notes", {}, "mcp_call_read_only"),
            /project only/,
            "project approval and plan-mode trust survive a reload",
        );
        writeFileSync(join(configDir, "mcp.json"), "{ broken json");
        assert.match(
            await mcpCall("notes", "add_note", { text: "malformed fallback" }),
            /No MCP server/,
        );
        assert.equal(readFileSync(notesFile, "utf8"), "one\n");
        writeProject({ ...config, notes: { ...config.notes, env: { EXTRA: "changed" } } });
        assert.match(
            await mcpCall("notes", "add_note", { text: "stale approval" }),
            /No MCP server/,
        );
        assert.equal(readFileSync(projectNotes, "utf8"), "project only\n");
        assert.equal(
            (await route(scoped("state"))).servers.find(
                (entry: { name: string }) => entry.name === "notes",
            ).pocket,
            "changed",
        );
    } finally {
        session = userSession;
    }
});

test("project settings-only overrides preserve user credentials and invalidate inherited approvals", async () => {
    const userSession = session;
    const project = join(root, "project-overrides");
    const directory = join(project, ".pi");
    const scoped = (path: string) => `${path}?project=${encodeURIComponent(project)}`;
    const writeOverride = (override: object) =>
        writeFileSync(
            join(directory, "mcp.json"),
            JSON.stringify({ mcpServers: { notes: override } }),
        );

    mkdirSync(directory, { recursive: true });
    writeOverride({ enabled: false });
    session = await newSession(app, project);

    try {
        let state = await route(scoped("state"));

        assert.deepEqual(state.errors, []);
        assert.equal(state.servers[0].enabledInFile, false);
        assert.match(await mcpCall("notes", "list_notes"), /No MCP server/);
        writeOverride({
            enabled: true,
            exposure: "hidden",
            toolExposure: { list_notes: "codemode" },
        });
        state = await route(scoped("reload"), {});
        assert.equal(state.servers[0].pocket, "off", "the inherited entry needs project approval");
        await route(scoped("servers/notes/on"), {
            on: true,
            fingerprint: state.servers[0].fingerprint,
        });
        assert.match(
            await mcpCall("notes", "list_notes"),
            /one/,
            "NOTES_FILE is inherited from the user entry",
        );
        assert.match(await mcpCall("notes", "inject"), /has no tool/);

        writeConfig({ notes: notes({ INHERITED_CHANGED: "yes" }) });
        assert.match(await mcpCall("notes", "list_notes"), /No MCP server/);
        assert.equal((await route(scoped("state"))).servers[0].pocket, "changed");
        assert.equal(
            (await route(scoped("state"))).servers[0].parts.some(
                (part: { key: string; changed: boolean }) =>
                    part.key === "env.INHERITED_CHANGED" && part.changed,
            ),
            true,
        );
    } finally {
        session = userSession;
        writeConfig({ notes: notes() });
        await route("reload", {});
    }
});

test("turning the module off stops the server's process", async () => {
    // Project copies can inherit PID_FILE too; reconnect so this file identifies the user connection under test.
    await route("servers/notes/reconnect", {});

    const pid = Number(readFileSync(pidFile, "utf8"));

    const alive = () => {
        try {
            process.kill(pid, 0);

            return true;
        } catch {
            return false;
        }
    };

    assert.equal(alive(), true);
    await app.setExtensionEnabled(owner(app), "mcp.ts", false);
    await until(() => !alive(), "the server's process ended", 5_000);
});

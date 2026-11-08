import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../mcp/config.ts";

async function configs(userEntries: object, projectEntries: object) {
    const root = await mkdtemp(join(tmpdir(), "pocket-mcp-overrides-"));
    const project = join(root, "project");

    await mkdir(project);
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: userEntries }));
    await writeFile(join(project, "mcp.json"), JSON.stringify({ mcpServers: projectEntries }));
    const user = await loadConfig(root);
    const loaded = await loadConfig(project, project, user);

    return { root, project, user, loaded };
}

test("settings-only overrides inherit transport, credentials, and remaining settings", async () => {
    const stdio = {
        command: "node",
        args: ["server.mjs"],
        env: { API_KEY: "test-key" },
        cwd: "tools",
        timeout: 21,
        description: "User server",
        enabled: false,
        toolExposure: { old: "hidden" },
    };
    const http = {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer test" },
        auth: { provider: "test" },
        oauth: { clientId: "test-client" },
    };
    const fixture = await configs(
        { stdio, http },
        {
            stdio: { enabled: true, exposure: "hidden", toolExposure: { visible: "codemode" } },
            http: { exposure: "hidden" },
        },
    );

    try {
        assert.deepEqual(fixture.loaded.errors, []);
        assert.deepEqual(fixture.loaded.servers[0]?.config, {
            ...stdio,
            cwd: join(homedir(), "tools"),
            enabled: true,
            exposure: "hidden",
            toolExposure: { visible: "codemode" },
        });
        assert.deepEqual(fixture.loaded.servers[1]?.config, { ...http, exposure: "hidden" });
        assert.match(fixture.loaded.servers[1]?.unsupported ?? "", /auth.provider/);
        assert.deepEqual(fixture.user.servers[0]?.config, stdio, "user config is never mutated");
        const before = fixture.loaded.servers[0]?.fingerprint;

        await writeFile(
            join(fixture.root, "mcp.json"),
            JSON.stringify({
                mcpServers: {
                    stdio: { ...stdio, env: { API_KEY: "changed-key" } },
                    http,
                },
            }),
        );
        const changed = await loadConfig(
            fixture.project,
            fixture.project,
            await loadConfig(fixture.root),
        );

        assert.notEqual(
            changed.servers[0]?.fingerprint,
            before,
            "approval covers inherited credentials",
        );
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test("empty and disabled overrides retain user cwd, while full entries replace rather than merge", async () => {
    const fixture = await configs(
        {
            empty: { command: "node" },
            disabled: { command: "node" },
            replaced: { command: "old", env: { API_KEY: "old" } },
        },
        {
            empty: {},
            disabled: { enabled: false },
            replaced: { command: "new" },
        },
    );

    try {
        assert.deepEqual(fixture.loaded.errors, []);
        assert.deepEqual(
            fixture.loaded.servers.map((entry) => entry.config),
            [
                { command: "node", cwd: homedir() },
                { command: "node", cwd: homedir(), enabled: false },
                { command: "new", cwd: fixture.project },
            ],
        );
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test("overrides reject unknown servers, transport-adjacent keys, and invalid setting values", async () => {
    const fixture = await configs(
        {
            known: { command: "node" },
            bad: { command: "node" },
            invalidExposure: { command: "node" },
            invalidTools: { command: "node" },
        },
        {
            unknown: { enabled: false },
            known: { env: { API_KEY: "replacement" } },
            bad: { enabled: "yes" },
            invalidExposure: { exposure: "invalid" },
            invalidTools: { toolExposure: { tool: "invalid" } },
        },
    );

    try {
        assert.equal(fixture.loaded.servers.length, 0);
        assert.equal(fixture.loaded.errors.length, 5);
        assert.match(fixture.loaded.errors.join("\n"), /user server to override/);
        assert.match(fixture.loaded.errors.join("\n"), /override can only set/);
        assert.match(fixture.loaded.errors.join("\n"), /enabled must be true or false/);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

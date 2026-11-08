import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../mcp/config.ts";
import { projectScope, scopedNames } from "../mcp/projects.ts";

test("project identity isolates approvals and OAuth, and canonicalizes symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocket-mcp-projects-"));

    try {
        const project = join(root, "a");
        const other = join(root, "b");
        const alias = join(root, "alias");

        await mkdir(project);
        await mkdir(other);
        await symlink(project, alias, "dir");
        const a = await projectScope(project, root);
        const b = await projectScope(other, root);

        assert.deepEqual(await projectScope(alias, root), a);
        assert.notEqual(a?.dataDir, b?.dataDir);
        assert.equal(a?.agentDir, join(a?.cwd ?? "", ".pi"));
        assert.equal(await projectScope("ssh://host/project", root), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("project cwd is explicit, resolved before approval, and user cwd stays unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocket-mcp-config-"));

    try {
        const config = {
            mcpServers: {
                notes: { command: "node", args: ["server.mjs"] },
                nested: { command: "node", cwd: "tools" },
            },
        };

        await writeFile(join(root, "mcp.json"), JSON.stringify(config));
        const user = await loadConfig(root);
        const project = await loadConfig(root, root);
        const elsewhere = await loadConfig(root, join(root, "other"));

        assert.equal(user.servers[0]?.config.type, undefined);
        assert.equal(
            project.servers[0]?.config && "cwd" in project.servers[0].config
                ? project.servers[0].config.cwd
                : undefined,
            root,
        );
        assert.equal(
            project.servers[1]?.config && "cwd" in project.servers[1].config
                ? project.servers[1].config.cwd
                : undefined,
            join(root, "tools"),
        );
        assert.notEqual(user.servers[0]?.fingerprint, project.servers[0]?.fingerprint);
        assert.notEqual(project.servers[0]?.fingerprint, elsewhere.servers[0]?.fingerprint);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an off project entry shadows the user entry, and merging does not mutate user servers", () => {
    const user = new Map([
        ["notes", "user notes"],
        ["global", "user global"],
    ]);
    const project = new Map([["private", "project private"]]);
    const visible = scopedNames(user, project, ["notes", "private"]);

    assert.equal(visible.has("notes"), false);
    assert.equal(visible.get("private"), "project private");
    assert.equal(visible.get("global"), "user global");
    assert.equal(user.get("notes"), "user notes");
});

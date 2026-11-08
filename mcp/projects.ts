// Project identity comes from the session, never from tool arguments. Resolve symlinks so aliases share approval.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface ProjectScope {
    cwd: string;
    agentDir: string;
    dataDir: string;
}

export async function projectScope(
    cwd: string,
    dataDir: string,
): Promise<ProjectScope | undefined> {
    // Remote workspaces must not accidentally read a local folder with a similar name.
    if (!isAbsolute(cwd)) {
        return undefined;
    }

    const root = await realpath(cwd);
    const id = createHash("sha256").update(root).digest("hex");

    return {
        cwd: root,
        agentDir: join(root, ".pi"),
        dataDir: join(dataDir, "mcp", "projects", id),
    };
}

/** A project entry shadows the user entry, even when the project entry is off. */
export function scopedNames<T>(
    user: Map<string, T>,
    project: Map<string, T>,
    names: string[],
): Map<string, T> {
    const visible = new Map(user);

    for (const name of names) {
        visible.delete(name);
    }

    for (const [name, value] of project) {
        visible.set(name, value);
    }

    return visible;
}

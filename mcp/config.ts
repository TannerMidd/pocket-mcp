/**
 * The MCP servers of Pi's own `mcp.json`, read as Pi reads it, and Pi Pocket's settings for them: which servers the
 * owner turned on here, and for which ones plan mode may trust the read-only hints of the server.
 *
 * Pi Pocket runs a server only as the owner last turned it on. The switch keeps a SHA-256 fingerprint of the entry, so
 * any change to the entry (made by a person, or by Pi through a shell) turns the server off here until the owner turns
 * it on again.
 */
import { exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Exposure = "codemode" | "deferred" | "direct" | "hidden";

interface CommonConfig {
    enabled?: boolean;
    description?: string;
    timeout?: number;
    exposure?: Exposure;
    toolExposure?: Record<string, Exposure>;
}

export interface StdioConfig extends CommonConfig {
    type?: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

export interface OAuthConfig {
    clientId?: string;
    clientSecret?: string;
    callbackPort?: number;
    callbackUrl?: string;
    scope?: string;
    clientName?: string;
    clientRegistration?: "dcr" | "cimd";
    authServerMetadataUrl?: string;
}

export interface HttpConfig extends CommonConfig {
    type?: "http" | "streamable-http";
    url: string;
    headers?: Record<string, string>;
    oauth?: OAuthConfig;
    auth?: { provider: string };
}

export type ServerConfig = StdioConfig | HttpConfig;

/** A part of an entry, as the owner's page shows it, with its own hash to tell what changed. */
export interface EntryPart {
    key: string;
    text: string;
    hash: string;
}

export interface ServerEntry {
    name: string;
    config: ServerConfig;
    /** SHA-256 of the entry without `enabled`: the owner's switch holds the one it turned on. */
    fingerprint: string;
    /** Each part of the entry that the fingerprint covers. */
    parts: EntryPart[];
    /** Why Pi Pocket cannot run this entry, when it uses something only Pi's terminal app has. */
    unsupported?: string;
}

export interface LoadedConfig {
    file: string;
    servers: ServerEntry[];
    /** Entries that are not valid, and a file that cannot be read: for the owner's page only. */
    errors: string[];
}

const EXPOSURES = new Set(["codemode", "deferred", "direct", "hidden"]);
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every((each) => typeof each === "string");
}

/** JSON with sorted keys, so that the same entry always has the same fingerprint. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
    }

    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`;
    }

    return JSON.stringify(value) ?? "null";
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fingerprintOf(raw: Record<string, unknown>): string {
    const { enabled: _enabled, ...rest } = raw;

    return sha256(canonical(rest));
}

/** Names of env variables and headers whose literal values the page does not show. */
const SECRET_NAME = /token|key|secret|pass|auth|cookie|credential|session|private/i;
/** Names of variables that run programs or change what runs: their values always show. */
const RUNS =
    /askpass|_command$|_options$|^ld_|^dyld_|path$|_env$|_sock$|^(editor|visual|pager|shell|browser)$/i;
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * A value as the page shows it. A command (`!…`) shows as it is, and so does each value whose name does not look
 * secret: such values (`NODE_OPTIONS`, `PATH`) change what runs. A secret shows only its length and the variables
 * that it names.
 */
function shown(value: unknown, secret: boolean): string {
    if (typeof value !== "string") {
        return canonical(value);
    }

    if (value.startsWith("!") || !secret) {
        return value;
    }

    const names = [...value.matchAll(VARIABLE)].map((match) => `$${match[1] ?? match[2]}`);

    return `(hidden: ${value.length} characters${names.length > 0 ? `, with ${names.join(", ")}` : ""})`;
}

/**
 * The parts of an entry that the fingerprint covers, one for each field, and one for each variable of `env`, header
 * of `headers`, and field of `oauth`. The owner's page shows them all, and which of them changed.
 */
function partsOf(raw: Record<string, unknown>): EntryPart[] {
    const parts: EntryPart[] = [];

    for (const key of Object.keys(raw).sort()) {
        const value = raw[key];

        if (key === "enabled") {
            continue;
        }

        if ((key === "env" || key === "headers" || key === "oauth") && isRecord(value)) {
            for (const name of Object.keys(value).sort()) {
                const secret =
                    key === "oauth"
                        ? name === "clientSecret"
                        : SECRET_NAME.test(name) && !RUNS.test(name);

                parts.push({
                    key: `${key}.${name}`,
                    text: shown(value[name], secret),
                    hash: sha256(canonical(value[name])),
                });
            }

            if (Object.keys(value).length === 0) {
                parts.push({ key, text: "{}", hash: sha256("{}") });
            }

            continue;
        }

        parts.push({ key, text: canonical(value), hash: sha256(canonical(value)) });
    }

    return parts;
}

/**
 * The keys of the parts that are different from the hashes kept when the owner turned the server on. The entry did
 * change (its fingerprint is another), so when no part shows it, as when a value moved to a key with the same name,
 * all parts count as changed.
 */
export function changedParts(parts: EntryPart[], approved: Record<string, string>): string[] {
    const now = new Map(parts.map((part) => [part.key, part.hash]));
    const keys = new Set([...now.keys(), ...Object.keys(approved)]);
    const changed = [...keys].filter(
        (key) => now.get(key) !== (Object.hasOwn(approved, key) ? approved[key] : undefined),
    );

    return (changed.length > 0 ? changed : [...now.keys()]).sort();
}

function exposureError(value: unknown): boolean {
    const resolved = value === "codemode-deferred" ? "codemode" : value;

    return typeof resolved !== "string" || !EXPOSURES.has(resolved);
}

function oauthError(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!isRecord(value)) {
        return "oauth must be an object";
    }

    for (const key of ["clientId", "clientSecret", "scope", "clientName", "callbackUrl"]) {
        if (value[key] !== undefined && typeof value[key] !== "string") {
            return `oauth.${key} must be a string`;
        }
    }

    if (value.clientName !== undefined && !(value.clientName as string).trim()) {
        return "oauth.clientName must not be empty";
    }

    const port = value.callbackPort;

    if (
        port !== undefined &&
        (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    ) {
        return "oauth.callbackPort must be a port number";
    }

    if (typeof value.callbackUrl === "string") {
        const url = URL.canParse(value.callbackUrl) ? new URL(value.callbackUrl) : undefined;

        if (url?.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.search || url.hash) {
            return "oauth.callbackUrl must be an http address on localhost, 127.0.0.1, or [::1]";
        }

        if (url.port && port !== undefined && Number(url.port) !== port) {
            return "oauth.callbackUrl and oauth.callbackPort name different ports";
        }
    }

    if (
        value.clientRegistration !== undefined &&
        value.clientRegistration !== "dcr" &&
        value.clientRegistration !== "cimd"
    ) {
        return 'oauth.clientRegistration must be "dcr" or "cimd"';
    }

    const metadata = value.authServerMetadataUrl;

    if (metadata !== undefined) {
        const url =
            typeof metadata === "string" && URL.canParse(metadata) ? new URL(metadata) : undefined;

        if (
            !url ||
            !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))
        ) {
            return "oauth.authServerMetadataUrl must be an https address, or http on loopback";
        }
    }

    return undefined;
}

/** One entry of `mcpServers`, checked by the rules of Pi's own `mcp.json`. A string is what is wrong with it. */
function validateServer(name: string, raw: unknown): ServerConfig | string {
    if (!SERVER_NAME.test(name)) {
        return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
    }

    if (!isRecord(raw)) {
        return `server "${name}" must be an object`;
    }

    // A key with a "." would show on the page as a part of env, headers, or oauth.
    const dotted = Object.keys(raw).find((key) => key.includes("."));

    if (dotted !== undefined) {
        return `server "${name}": the key "${dotted}" has a "."`;
    }

    const { type, exposure, enabled, timeout, toolExposure, description } = raw;

    if (exposure !== undefined && exposureError(exposure)) {
        return `server "${name}": exposure must be "codemode", "deferred", "direct", or "hidden"`;
    }

    if (toolExposure !== undefined) {
        if (!isRecord(toolExposure) || Object.values(toolExposure).some(exposureError)) {
            return `server "${name}": toolExposure must map tool names to exposures`;
        }
    }

    if (enabled !== undefined && typeof enabled !== "boolean") {
        return `server "${name}": enabled must be true or false`;
    }

    if (description !== undefined && typeof description !== "string") {
        return `server "${name}": description must be a string`;
    }

    if (
        timeout !== undefined &&
        (typeof timeout !== "number" || !(timeout > 0) || !Number.isFinite(timeout))
    ) {
        return `server "${name}": timeout must be a positive number of seconds`;
    }

    if (type === "sse") {
        return `server "${name}": the legacy SSE transport is not supported; use the streamable HTTP address`;
    }

    if (
        typeof raw.url === "string" &&
        (type === undefined || type === "http" || type === "streamable-http")
    ) {
        if (!URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) {
            return `server "${name}": url must be an http or https address`;
        }

        if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
            return `server "${name}": headers must map names to strings`;
        }

        const oauth = oauthError(raw.oauth);

        if (oauth !== undefined) {
            return `server "${name}": ${oauth}`;
        }

        return raw as unknown as HttpConfig;
    }

    if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
        if (
            raw.args !== undefined &&
            !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))
        ) {
            return `server "${name}": args must be an array of strings`;
        }

        if (raw.env !== undefined && !isStringRecord(raw.env)) {
            return `server "${name}": env must map names to strings`;
        }

        if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
            return `server "${name}": cwd must be a string`;
        }

        return raw as unknown as StdioConfig;
    }

    return `server "${name}" needs "command" (stdio) or "url" (streamable HTTP)`;
}

/** What Pi's terminal app can do with an entry and Pi Pocket cannot (yet). */
function unsupported(config: ServerConfig): string | undefined {
    if ("url" in config && config.auth !== undefined) {
        return "auth.provider (the token of a Pi sign-in) works only in Pi's terminal app";
    }

    if ("url" in config && config.oauth?.clientRegistration === "cimd") {
        return 'oauth.clientRegistration "cimd" works only in Pi\'s terminal app';
    }

    return undefined;
}

/**
 * The servers of `<agentDir>/mcp.json`. For a project, pass its `.pi` folder and its root as `cwd`.
 * Resolve the effective working folder before fingerprinting, so approval covers what actually runs.
 */
export async function loadConfig(
    agentDir: string,
    cwd?: string,
    user?: LoadedConfig,
): Promise<LoadedConfig> {
    const file = join(agentDir, "mcp.json");
    const loaded: LoadedConfig = { file, servers: [], errors: [] };

    let text: string;

    try {
        text = await readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            loaded.errors.push(`${file}: ${(error as Error).message}`);
        }

        return loaded;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
        loaded.errors.push(`${file}: ${(error as Error).message}`);

        return loaded;
    }

    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
        loaded.errors.push(`${file}: expected an object with an "mcpServers" object`);

        return loaded;
    }

    const seen = new Map<string, string>();

    for (const [name, source] of Object.entries(
        (parsed.mcpServers ?? {}) as Record<string, unknown>,
    )) {
        let effective = source;
        let baseCwd = cwd;

        if (
            cwd !== undefined &&
            isRecord(source) &&
            source.command === undefined &&
            source.url === undefined &&
            source.type === undefined
        ) {
            const base = user?.servers.find((entry) => entry.name === name);
            const extra = Object.keys(source).filter(
                (key) => !["enabled", "exposure", "toolExposure"].includes(key),
            );

            if (base === undefined) {
                loaded.errors.push(
                    `server "${name}" needs "command" or "url", or a user server to override`,
                );
                continue;
            }

            if (extra.length > 0) {
                loaded.errors.push(
                    `server "${name}": an override can only set enabled, exposure, toolExposure`,
                );
                continue;
            }

            // Inherit credentials and transport intact. Settings-only overrides keep the user's cwd semantics.
            effective = { ...base.config, ...source };
            baseCwd = "command" in base.config ? homedir() : undefined;
        }

        const raw =
            baseCwd !== undefined &&
            isRecord(effective) &&
            typeof effective.command === "string" &&
            (effective.cwd === undefined || typeof effective.cwd === "string")
                ? { ...effective, cwd: resolve(baseCwd, expandHome(effective.cwd ?? ".")) }
                : effective;
        const config = validateServer(name, raw);

        if (typeof config === "string") {
            loaded.errors.push(config);
            continue;
        }

        // Pi counts names that differ only in "-" and "_" as one server.
        const key = name.replace(/-/g, "_");
        const clash = seen.get(key);

        if (clash !== undefined) {
            loaded.errors.push(`server "${name}" conflicts with "${clash}"`);
            continue;
        }

        seen.set(key, name);

        const why = unsupported(config);

        loaded.servers.push({
            name,
            config,
            fingerprint: fingerprintOf(raw as Record<string, unknown>),
            parts: partsOf(raw as Record<string, unknown>),
            ...(why === undefined ? {} : { unsupported: why }),
        });
    }

    return loaded;
}

/** `~` and `~/…` name the home folder, as in a shell and in Pi. */
export function expandHome(value: string): string {
    if (value === "~") {
        return homedir();
    }

    return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** A stdio server's folder: `cwd` from the entry, with a relative one under the home folder. */
export function serverCwd(config: StdioConfig): string {
    return resolve(homedir(), expandHome(config.cwd ?? "."));
}

/** The output of a `!command` value, as Pi runs it: through the shell, for 10 seconds at most. */
function runCommand(command: string): Promise<string | undefined> {
    return new Promise((done) => {
        exec(command, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
            done(error ? undefined : stdout.trim() || undefined);
        });
    });
}

/**
 * A value of `env`, `headers`, or `oauth.clientSecret`, as Pi resolves it: `!command` is the output of the command,
 * and `$NAME` or `${NAME}` is an environment variable (`$$` is a "$"). The error names the variables, never a value.
 */
export async function resolveValue(value: string, what: string): Promise<string> {
    if (value.startsWith("!")) {
        const output = await runCommand(value.slice(1));

        if (output === undefined) {
            throw new Error(`${what}: its command failed or printed nothing`);
        }

        return output;
    }

    const missing: string[] = [];
    const resolved = value.replace(
        /\$(\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
        (whole: string, escape: string, braced?: string, bare?: string) => {
            if (escape === "$" || escape === "!") {
                return escape;
            }

            const name = braced ?? bare ?? "";
            const found = process.env[name];

            if (!found) {
                missing.push(name);

                return whole;
            }

            return found;
        },
    );

    if (missing.length > 0) {
        throw new Error(`${what}: the environment variable ${missing.join(", ")} is not set`);
    }

    return resolved;
}

export async function resolveRecord(
    values: Record<string, string> | undefined,
    what: string,
): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};

    for (const [key, value] of Object.entries(values ?? {})) {
        resolved[key] = await resolveValue(value, `${what} "${key}"`);
    }

    return resolved;
}

/** Exposure of one tool: its `toolExposure` entry (exact, then the first pattern), else the server's. */
export function toolExposure(config: ServerConfig, tool: string): Exposure {
    const overrides = config.toolExposure ?? {};
    const alias = (value: string) =>
        (value === "codemode-deferred" ? "codemode" : value) as Exposure;

    // Own keys only: a tool named "constructor" must not find Object's.
    if (Object.hasOwn(overrides, tool)) {
        return alias(overrides[tool]!);
    }

    for (const [pattern, exposure] of Object.entries(overrides)) {
        if (!pattern.includes("*")) {
            continue;
        }

        const source = pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");

        if (new RegExp(`^${source}$`).test(tool)) {
            return alias(exposure);
        }
    }

    return alias(config.exposure ?? "codemode");
}

/**
 * The writes to each file, in order. Pi Pocket loads this helper once for all versions of the module, so the old and
 * the new version share these queues while an edit replaces one with the other.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * A JSON file of the module's own, in a folder that only the owner's user can open. Writes go one at a time, read the
 * file again, and replace it in one step. A file that is not there reads as empty; one that cannot be read is an
 * error, so that a write never replaces it with nothing.
 */
export class JsonStore<T extends object> {
    readonly file: string;
    readonly #empty: () => T;

    constructor(file: string, empty: () => T) {
        this.file = file;
        this.#empty = empty;
    }

    async read(): Promise<T> {
        let text: string;

        try {
            text = await readFile(this.file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return this.#empty();
            }

            throw error;
        }

        const parsed: unknown = JSON.parse(text);

        if (!isRecord(parsed)) {
            throw new Error(`${this.file} does not hold a JSON object`);
        }

        return parsed as T;
    }

    update<R>(change: (value: T) => R): Promise<R> {
        const run = (queues.get(this.file) ?? Promise.resolve()).then(async () => {
            const value = await this.read();
            const result = change(value);
            const temporary = `${this.file}.${randomUUID()}.tmp`;

            await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
            await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
            await rename(temporary, this.file);

            return result;
        });

        queues.set(
            this.file,
            run.catch(() => undefined),
        );

        return run;
    }
}

export interface ServerSettings {
    /** The fingerprint of the entry that the owner turned on in Pi Pocket. */
    approved?: string;
    /** The hash of each part of that entry, to show what changed since. */
    parts?: Record<string, string>;
    /** Plan mode may run the tools that this server marks read-only. */
    planMode?: boolean;
}

export interface Settings {
    servers: Record<string, ServerSettings>;
}

export function settingsStore(dataDir: string): JsonStore<Settings> {
    return new JsonStore<Settings>(join(dataDir, "mcp", "settings.json"), () => ({ servers: {} }));
}

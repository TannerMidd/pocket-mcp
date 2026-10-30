// OAuth sign-in against the fixture's authorization server, with the state kept in memory.
//
//   node --test test/oauth.test.ts
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { startSignIn } from "../mcp/oauth.ts";

let fixture: ChildProcess;
let serverUrl = "";

/** A port that nothing listens on now. */
async function freePort(): Promise<number> {
    const probe = createServer();

    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };

    await new Promise((resolve) => probe.close(resolve));

    return port;
}

before(async () => {
    const port = await freePort();

    fixture = spawn(
        process.execPath,
        [join(import.meta.dirname, "fixtures", "http-server.mjs"), String(port), "--oauth"],
        { stdio: "ignore" },
    );
    serverUrl = `http://127.0.0.1:${port}/mcp`;

    for (let tries = 0; ; tries++) {
        try {
            await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
            break;
        } catch (error) {
            if (tries > 50) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
});

after(() => {
    fixture?.kill();
});

/** Sign in as the owner does: open the authorization page, approve, and paste the address it went back to. */
async function signIn(store: {
    load(): McpOAuthState | undefined;
    save(state: McpOAuthState): void;
}) {
    const started = await startSignIn({ serverUrl, store, settings: {} });

    assert.ok(started);
    const approve = new URL(started.url);

    approve.pathname = "/approve";
    const back = await fetch(approve, { redirect: "manual" });

    await started.paste(back.headers.get("location")!);
}

test("a sign-in on another port keeps the working tokens until it has new ones", async () => {
    let saved: McpOAuthState | undefined;

    const store = { load: () => saved, save: (state: McpOAuthState) => void (saved = state) };

    await signIn(store);
    const first = saved!;
    const registered = new URL(
        (first.clientInformation as { redirect_uris: string[] }).redirect_uris[0]!,
    );

    // Another program holds the port of the registered redirect address, so the next sign-in needs another client.
    const holder: Server = createServer();

    await new Promise<void>((resolve) =>
        holder.listen(Number(registered.port), "127.0.0.1", resolve),
    );

    try {
        const cancelled = await startSignIn({ serverUrl, store, settings: {} });

        assert.ok(cancelled);
        cancelled.cancel();
        await cancelled.done.catch(() => undefined);
        assert.equal(saved?.tokens?.access_token, first.tokens?.access_token, "still signed in");

        // A sign-in that finishes there replaces the client and its tokens.
        await signIn(store);
        assert.notEqual(saved?.tokens?.access_token, first.tokens?.access_token);
        assert.notEqual(
            (saved?.clientInformation as { redirect_uris: string[] }).redirect_uris[0],
            registered.href,
        );
    } finally {
        await new Promise((resolve) => holder.close(resolve));
    }
});

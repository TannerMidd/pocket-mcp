/**
 * OAuth sign-in for HTTP servers, with Pi's MCP client (`@earendil-works/pi-mcp/oauth`).
 *
 * The authorization server sends the browser back to a loopback address on this machine, as Pi's terminal app does: an
 * extension's routes need a signed-in request with the `X-Pocket` header, which a redirect from another site does not
 * have. When the browser is on another machine (a phone), that page does not load: the owner pastes its address into
 * the MCP page, and the module finishes the sign-in from it.
 *
 * Connections never start a sign-in. They send the stored access token, and after a 401 they try the stored refresh
 * token. When that is not possible, the server needs a sign-in from the owner.
 *
 * Tokens are kept in `<data folder>/mcp/oauth.json`, which only the owner's user can read, apart from the sign-ins of
 * Pi's terminal app.
 */
import { join } from "node:path";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
    authorizeMcp,
    McpOAuthAuthorizationRequiredError,
    McpOAuthProvider,
    type McpOAuthState,
    type McpOAuthStateStore,
    OAuthCallbackServer,
    type OAuthChallenge,
    type OAuthClientInformationMixed,
    type OAuthClientProvider,
    OAuthError,
    parseWwwAuthenticate,
    stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
import { type HttpConfig, JsonStore, resolveValue } from "./config.ts";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** The redirect address for refreshes when none is stored. A refresh never sends the browser anywhere. */
const FALLBACK_REDIRECT = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Each request to the authorization server, so that one that does not answer cannot hold a sign-in or a refresh. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Access tokens this close to their end are refreshed before they go out. */
const REFRESH_SKEW_MS = 30_000;

/** OAuth errors after which only a new sign-in helps. */
const REFUSED = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
/** How long a sign-in waits for the browser, or for the owner to paste the address. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export type OAuthStates = Record<string, McpOAuthState>;

export function oauthFile(dataDir: string): JsonStore<OAuthStates> {
    return new JsonStore<OAuthStates>(join(dataDir, "mcp", "oauth.json"), () => ({}));
}

/** HTTP servers sign in with OAuth, unless the entry sends an `Authorization` header of its own. */
export function usesOAuth(config: HttpConfig): boolean {
    return !Object.keys(config.headers ?? {}).some(
        (header) => header.toLowerCase() === "authorization",
    );
}

/** The state of one server's sign-in, under its name and address: two names for one address sign in apart. */
export function serverState(
    file: JsonStore<OAuthStates>,
    name: string,
    url: string,
): McpOAuthStateStore & { remove(): Promise<boolean> } {
    const key = `${name}|${new URL(url).href}`;

    return {
        load: async () => {
            const states = await file.read();

            return Object.hasOwn(states, key) ? states[key] : undefined;
        },
        save: (state) =>
            file.update((states) => {
                states[key] = state;
            }),
        remove: () =>
            file.update((states) => {
                const had = Object.hasOwn(states, key);

                delete states[key];

                return had;
            }),
    };
}

interface OAuthSettings {
    clientId?: string;
    clientSecret?: string;
    callbackPort?: number;
    callbackUrl?: string;
    scope?: string;
    clientName?: string;
    authServerMetadataUrl?: URL;
}

export async function oauthSettings(name: string, config: HttpConfig): Promise<OAuthSettings> {
    const oauth = config.oauth ?? {};

    return {
        ...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
        ...(oauth.clientSecret === undefined
            ? {}
            : {
                  clientSecret: await resolveValue(
                      oauth.clientSecret,
                      `MCP server "${name}" oauth.clientSecret`,
                  ),
              }),
        ...(oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort }),
        ...(oauth.callbackUrl === undefined ? {} : { callbackUrl: oauth.callbackUrl }),
        ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
        ...(oauth.clientName === undefined ? {} : { clientName: oauth.clientName }),
        ...(oauth.authServerMetadataUrl === undefined
            ? {}
            : { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }),
    };
}

/** Where the callback listens, and the redirect address when the entry fixes one. */
function callbackSettings(settings: OAuthSettings) {
    const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
    const address = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port ? Number(url.port) : settings.callbackPort;

    let fixedRedirectUrl: string | undefined;

    // A configured address with a port goes as it is written: servers compare it as text.
    if (url.port) {
        fixedRedirectUrl = settings.callbackUrl;
    } else if (port !== undefined) {
        url.port = String(port);
        fixedRedirectUrl = url.href;
    }

    return {
        host: address === "localhost" ? CALLBACK_HOST : address,
        redirectHost: address,
        port,
        path: url.pathname,
        fixedRedirectUrl,
    };
}

function registeredRedirects(client: OAuthClientInformationMixed | undefined): string[] {
    return client && "redirect_uris" in client && Array.isArray(client.redirect_uris)
        ? client.redirect_uris
        : [];
}

function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
    const merged = [
        ...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? [])),
    ];

    return merged.length > 0 ? merged.join(" ") : undefined;
}

function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
    return (input, init) => {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

        return fetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
    };
}

function provider(
    serverUrl: string,
    store: McpOAuthStateStore,
    settings: OAuthSettings,
    redirectUrl: string,
    onRedirect: (url: URL) => void,
): McpOAuthProvider {
    return new McpOAuthProvider({
        serverUrl,
        redirectUrl,
        clientMetadata: { client_name: settings.clientName ?? "Pi Pocket" },
        ...(settings.clientId === undefined ? {} : { clientId: settings.clientId }),
        ...(settings.clientSecret === undefined ? {} : { clientSecret: settings.clientSecret }),
        store,
        onRedirect,
    });
}

/**
 * A provider that can only refresh: when the refresh fails, the flow cannot register a client, keep a new code
 * verifier, or start a sign-in, so a sign-in that the owner has open stays as it is.
 */
function refreshOnly(real: McpOAuthProvider): OAuthClientProvider {
    return {
        redirectUrl: real.redirectUrl,
        clientMetadata: real.clientMetadata,
        clientInformation: () => real.clientInformation(),
        tokens: () => real.tokens(),
        saveTokens: (tokens) => real.saveTokens(tokens),
        discoveryState: () => real.discoveryState(),
        saveDiscoveryState: (discovery) => real.saveDiscoveryState(discovery),
        // Tokens that the server refused can go; the client and an open sign-in stay.
        invalidateCredentials: async (kind) => {
            if (kind === "tokens") {
                await real.invalidateCredentials("tokens");
            }
        },
        codeVerifier: () => real.codeVerifier(),
        saveCodeVerifier: () => {},
        // The flow gets here also after a refresh that failed for a passing reason (a network error, a 5xx): the
        // tokens are still there, and the next call tries again. Only tokens that are gone need a sign-in.
        redirectToAuthorization: async () => {
            throw (await real.tokens())?.refresh_token
                ? new Error("the authorization server did not finish the refresh")
                : new McpOAuthAuthorizationRequiredError();
        },
    };
}

/**
 * The auth provider of a connection: the stored access token, refreshed when it is about to end or after a 401. It
 * throws `McpOAuthAuthorizationRequiredError` when the owner must sign in, and never registers a client or opens a
 * sign-in by itself. Requests of this process share one refresh.
 */
export function connectionAuth(options: {
    serverUrl: string;
    store: McpOAuthStateStore;
    settings: () => Promise<OAuthSettings>;
    onChallenge: (challenge: OAuthChallenge) => void;
}): AuthProvider & { settled(): Promise<void> } {
    const { serverUrl, store } = options;

    let refreshing: Promise<void> | undefined;

    const refresh = (stale: string | undefined, fetch?: McpFetch, challenge?: OAuthChallenge) => {
        refreshing ??= (async () => {
            const state = await store.load();

            if (state?.tokens?.access_token !== stale) {
                return;
            }

            if (!state?.tokens?.refresh_token) {
                throw new McpOAuthAuthorizationRequiredError();
            }

            const settings = await options.settings();
            const redirectUrl =
                callbackSettings(settings).fixedRedirectUrl ??
                registeredRedirects(state.clientInformation)[0] ??
                FALLBACK_REDIRECT;
            const result = await authorizeMcp(
                refreshOnly(provider(serverUrl, store, settings, redirectUrl, () => {})),
                {
                    serverUrl,
                    ...(challenge?.resourceMetadataUrl === undefined
                        ? {}
                        : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
                    ...(settings.authServerMetadataUrl === undefined
                        ? {}
                        : { authorizationServerMetadataUrl: settings.authServerMetadataUrl }),
                    ...(challenge?.scope === undefined ? {} : { scope: challenge.scope }),
                    fetch: timedFetch(fetch),
                },
            );

            if (result === "REDIRECT") {
                throw new McpOAuthAuthorizationRequiredError();
            }
        })()
            .catch((error: unknown) => {
                // The authorization server refused the refresh, or the client: the owner must sign in again. Other
                // errors (a server that is down for a moment) stay as they are.
                throw error instanceof OAuthError && REFUSED.has(error.code)
                    ? new McpOAuthAuthorizationRequiredError()
                    : error;
            })
            .finally(() => {
                refreshing = undefined;
            });

        return refreshing;
    };

    return {
        token: async () => {
            await refreshing?.catch(() => undefined);
            const state = await store.load();
            const token = state?.tokens?.access_token;
            const expired =
                state?.tokensExpireAt !== undefined &&
                state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();

            if (!expired || !state?.tokens?.refresh_token) {
                return token;
            }

            // A failure goes on with the old token: the server's 401 then decides.
            await refresh(token).catch(() => undefined);

            return (await store.load())?.tokens?.access_token;
        },
        onUnauthorized: async (context) => {
            const challenge = parseWwwAuthenticate(
                context.response.headers.get("www-authenticate"),
            );

            options.onChallenge(challenge);

            // A refresh keeps the scope it had: more scope needs a new sign-in.
            if (challenge.error === "insufficient_scope") {
                throw new McpOAuthAuthorizationRequiredError();
            }

            await refresh(context.token, context.fetch, challenge);
        },
        settled: async () => {
            await refreshing?.catch(() => undefined);
        },
    };
}

/** A sign-in that waits for the browser's redirect, or for the address that the owner pastes. */
export interface SignIn {
    /** The authorization page, for the owner to open. */
    readonly url: string;
    /** Settles when the sign-in is complete, or fails, or is cancelled. */
    readonly done: Promise<void>;
    /** The owner, or a newer sign-in, cancelled it. */
    readonly cancelled: boolean;
    /** Finish with the address that the browser went to at the end, pasted by the owner. */
    paste(address: string): Promise<void>;
    cancel(): void;
}

/** Only an https page, or http on this machine, goes to the owner's browser as the authorization page. */
function safePage(url: URL): boolean {
    return (
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
}

/** The code of a pasted redirect address, if it belongs to this sign-in. */
function fromAddress(input: string, state: string, redirect: URL): { code: string; iss?: string } {
    let url: URL;

    try {
        url = new URL(input.trim());
    } catch {
        throw new Error("Paste the whole address from the address bar");
    }

    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
        throw new Error("That address is not this sign-in's redirect address");
    }

    const error = url.searchParams.get("error");

    if (error) {
        throw new Error(url.searchParams.get("error_description") ?? error);
    }

    if (url.searchParams.get("state") !== state) {
        throw new Error("That address belongs to another sign-in");
    }

    const code = url.searchParams.get("code");

    if (!code) {
        throw new Error("That address has no authorization code");
    }

    const iss = url.searchParams.get("iss");

    return { code, ...(iss ? { iss } : {}) };
}

async function listen(
    callback: ReturnType<typeof callbackSettings>,
    port: number | undefined,
    required: boolean,
): Promise<OAuthCallbackServer> {
    const options = {
        host: callback.host,
        redirectHost: callback.redirectHost,
        path: callback.path,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        renderPage: (page: { ok: true } | { ok: false; message: string; details?: string }) =>
            page.ok
                ? oauthSuccessHtml(
                      "Signed in to the MCP server. Close this page, and go back to Pi Pocket.",
                  )
                : oauthErrorHtml(page.message, page.details),
    };

    try {
        return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
    } catch (error) {
        if (required || port === undefined) {
            throw error;
        }

        return OAuthCallbackServer.listen(options);
    }
}

/** A store that keeps a sign-in's state apart from `store` until the sign-in saves tokens, and then writes it there. */
function untilTokens(store: McpOAuthStateStore, start: McpOAuthState): McpOAuthStateStore {
    let state = start;

    return {
        load: () => state,
        save: async (next) => {
            state = next;

            if (next.tokens !== undefined) {
                await store.save(next);
            }
        },
    };
}

/**
 * Start a sign-in. Returns `undefined` when the stored refresh token was enough, and otherwise the sign-in, which
 * waits for the browser at the loopback callback or for a pasted address. The callback closes when it ends.
 */
export async function startSignIn(options: {
    serverUrl: string;
    store: McpOAuthStateStore;
    settings: OAuthSettings;
    challenge?: OAuthChallenge;
}): Promise<SignIn | undefined> {
    const { serverUrl, store, settings, challenge } = options;
    const stored = await store.load();
    const stepUp = challenge?.error === "insufficient_scope";
    const callbackOptions = callbackSettings(settings);
    // The port of the registered redirect address, so that the registered client stays valid.
    const registered = registeredRedirects(stored?.clientInformation)[0];
    const preferredPort =
        callbackOptions.port ??
        (registered ? Number(new URL(registered).port) || undefined : undefined);
    const callback = await listen(
        callbackOptions,
        preferredPort,
        callbackOptions.port !== undefined,
    );
    const stop = new AbortController();
    const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
    const closeCallback = () => callback.close().catch(() => undefined);

    let flowStore = store;

    try {
        if (stored) {
            const next = { ...stored };

            delete next.oauthState;

            // A registered client cannot use another redirect address, and its tokens are its own. The sign-in starts
            // without them, but the stored ones stay in use until it saves new tokens: a sign-in cancelled, failed, or
            // never finished leaves the owner signed in as before.
            if (
                !settings.clientId &&
                !registeredRedirects(stored.clientInformation).includes(redirectUrl)
            ) {
                delete next.clientInformation;
                delete next.tokens;
                delete next.tokensExpireAt;
                flowStore = untilTokens(store, next);
            } else {
                await store.save(next);
            }
        }

        let authorizationUrl: URL | undefined;

        const oauth = provider(serverUrl, flowStore, settings, redirectUrl, (url) => {
            authorizationUrl = url;
        });
        const scope = mergeScopes(
            settings.scope,
            stepUp ? stepUpScope(stored?.tokens?.scope, challenge?.scope) : challenge?.scope,
        );
        const flow = {
            serverUrl,
            fetch: timedFetch(),
            signal: stop.signal,
            ...(challenge?.resourceMetadataUrl === undefined
                ? {}
                : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
            ...(settings.authServerMetadataUrl === undefined
                ? {}
                : { authorizationServerMetadataUrl: settings.authServerMetadataUrl }),
            ...(scope === undefined ? {} : { scope }),
        };

        if ((await authorizeMcp(oauth, { ...flow, skipRefresh: stepUp })) === "AUTHORIZED") {
            await closeCallback();

            return undefined;
        }

        if (authorizationUrl === undefined) {
            throw new Error("The sign-in gave no authorization page");
        }

        if (!safePage(authorizationUrl)) {
            throw new Error("The authorization page is not an https address");
        }

        const state = await oauth.state();
        const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);

        let cancelled = false;

        let pasted: (response: { code: string; iss?: string }) => void = () => {};

        const fromOwner = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
            pasted = resolve;
            stop.signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled")), {
                once: true,
            });
        });
        const fromBrowser = callback.waitForCallback(state, redirect.pathname);

        fromBrowser.catch(() => undefined);
        fromOwner.catch(() => undefined);

        const done = (async () => {
            try {
                const { code, iss } = await Promise.race([fromBrowser, fromOwner]);

                await authorizeMcp(oauth, {
                    ...flow,
                    authorizationCode: code,
                    ...(iss === undefined ? {} : { iss }),
                });
            } finally {
                stop.abort();
                await closeCallback();
            }
        })();

        done.catch(() => undefined);

        return {
            url: authorizationUrl.href,
            done,
            get cancelled() {
                return cancelled;
            },
            paste: async (address) => {
                pasted(fromAddress(address, state, redirect));
                await done;
            },
            cancel: () => {
                cancelled = true;
                stop.abort();
            },
        };
    } catch (error) {
        stop.abort();
        await closeCallback();

        throw error;
    }
}

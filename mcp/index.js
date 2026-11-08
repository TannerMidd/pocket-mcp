// The MCP module's browser part, for the owner: a page with the servers of mcp.json, their entries, state, and tools,
// and what the owner can do with each (turn it on or off here, reconnect, sign in, allow plan mode); and how calls of
// the module's tools show. Text from the servers (tool names, descriptions, errors) shows as text only.
export const pocketApi = 1;

/** A plug, as a 24×24 stroked path like the app's own icons. */
const PLUG = "M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4";

const STATUS = {
    off: ["Off", ""],
    connecting: ["Connecting…", "busy"],
    connected: ["Connected", "ok"],
    failed: ["Failed", "err"],
    disconnected: ["Disconnected", "warn"],
    "needs-sign-in": ["Needs sign-in", "warn"],
    closed: ["Stopped", ""],
};

const text = (value) => (typeof value === "string" ? value : "");

export default function setup(pocket) {
    const { html, useEffect, useRef, useState, useCallback, Loader, Switch } = pocket;

    pocket.style("style.css");

    /** The rail button, with the count of servers that need the owner. */
    const rail = pocket.rail({ id: "servers", title: "MCP", iconPath: PLUG, page: "servers" });

    /** Each state that the tab reads also sets the count. */
    const read = async () => {
        const state = await pocket.api("state");

        rail.update({ badge: state.attention });

        return state;
    };

    /** The entry as mcp.json has it, with what changed since the owner turned it on. */
    function Entry({ server }) {
        const changed = server.parts.filter((part) => part.changed);

        return html`<details class="mcp-entry" open=${server.pocket === "changed"}>
            <summary class="small">
                Entry in mcp.json${changed.length > 0 ? ` · changed: ${changed.map((part) => part.key).join(", ")}` : ""}
            </summary>
            <p class="small muted">
                A literal value of env, headers, or oauth.clientSecret shows only its length: see
                mcp.json.
            </p>
            <dl class="mono small">
                ${server.parts.map(
                    (part) =>
                        html`<div class=${part.changed ? "mcp-changed" : ""}>
                            <dt>${part.key}</dt>
                            <dd>${part.text}</dd>
                        </div>`,
                )}
            </dl>
        </details>`;
    }

    /** A sign-in that waits: the link to its page, and the box for the address it ends on. */
    function SignIn({ server, act, busy }) {
        const [address, setAddress] = useState("");
        const [error, setError] = useState(null);
        const path = `servers/${encodeURIComponent(server.name)}/sign-in`;

        const paste = async () => {
            setError(null);

            try {
                await act(`${path}/paste`, { address }, { quiet: true });
            } catch (failure) {
                setError(failure.message);
            }
        };

        return html`<div class="mcp-signin">
            <a class="button primary" href=${server.signIn} target="_blank" rel="noopener noreferrer">
                Open the sign-in page
            </a>
            <p class="small muted">
                The sign-in ends on a page of the machine that runs Pi Pocket (127.0.0.1). When that
                page does not load, for example on a phone, copy its address and paste it here.
            </p>
            <div class="mcp-row">
                <input
                    class="mcp-input"
                    type="url"
                    aria-label="The address that the sign-in ended on"
                    placeholder="http://127.0.0.1:…/callback?code=…"
                    value=${address}
                    onInput=${(event) => setAddress(event.currentTarget.value)}
                />
                <button class="button" disabled=${busy || !address} onClick=${paste}>Finish</button>
                <button
                    class="button"
                    disabled=${busy}
                    onClick=${() => act(`${path}/cancel`, {}).catch(() => undefined)}
                >
                    Cancel
                </button>
            </div>
            ${error ? html`<div class="error-box">${error}</div>` : null}
        </div>`;
    }

    /** The tools that the server lists, with the ones that Pi does not get. */
    function Tools({ server }) {
        const visible = server.tools.filter((tool) => !tool.hidden).length;
        const hidden = server.tools.length - visible;

        return html`<details class="mcp-tools">
            <summary class="small">
                ${visible} ${visible === 1 ? "tool" : "tools"} for
                Pi${hidden > 0 ? `, ${hidden} hidden` : ""}
            </summary>
            <ul>
                ${server.tools.map(
                    (tool) =>
                        html`<li class=${tool.hidden ? "mcp-hidden" : ""}>
                            <div>
                                <span class="mono small">${tool.name}</span>
                                ${tool.readOnly ? html`<span class="mcp-tag">read-only</span>` : null}
                                ${tool.hidden ? html`<span class="mcp-tag">hidden</span>` : null}
                            </div>
                            ${
                                tool.title || tool.description
                                    ? html`<div class="small muted mcp-about">
                                      ${[tool.title, tool.description].filter(Boolean).join(" — ")}
                                  </div>`
                                    : null
                            }
                        </li>`,
                )}
            </ul>
        </details>`;
    }

    /** One server: its switch, its entry, its state, what to do, and its tools. */
    function ServerCard({ server, act, busy }) {
        const path = `servers/${encodeURIComponent(server.name)}`;
        const run = (to, body) => act(`${path}/${to}`, body).catch(() => undefined);
        const [label, kind] = STATUS[server.status] ?? [server.status, ""];
        const live = server.pocket === "on" && server.enabledInFile && !server.unsupported;
        const canTurnOn = server.enabledInFile && !server.unsupported;
        const pill = live ? label : server.pocket === "changed" ? "Changed" : "Off";

        return html`<section class="mcp-server">
            <div class="mcp-head">
                <div class="mcp-title">
                    <strong class="mcp-name">${server.name}</strong>
                    <span class=${`mcp-pill ${live ? kind : server.pocket === "changed" ? "warn" : ""}`}>
                        ${pill}
                    </span>
                </div>
                <${Switch}
                    on=${server.pocket === "on"}
                    label=${`Run ${server.name} in Pi Pocket`}
                    disabled=${busy || (!canTurnOn && server.pocket !== "on")}
                    onChange=${() =>
                        run("on", {
                            on: server.pocket !== "on",
                            fingerprint: server.fingerprint,
                        })}
                />
            </div>
            <div class="mono small mcp-target">${server.kind} · ${server.target}</div>
            ${server.description ? html`<div class="small muted">${server.description}</div>` : null}
            ${
                server.unsupported
                    ? html`<div class="small mcp-warn">Pi Pocket cannot run it: ${server.unsupported}.</div>`
                    : null
            }
            ${
                !server.enabledInFile
                    ? html`<div class="small muted">Off in mcp.json ("enabled": false).</div>`
                    : null
            }
            ${
                server.pocket === "changed" && server.enabledInFile
                    ? html`<div class="small mcp-warn">
                      Its entry in mcp.json changed after you turned it on. Look at what changed, then
                      turn it on again.
                  </div>`
                    : null
            }
            <${Entry} server=${server} />
            ${live && server.error ? html`<pre class="mono small mcp-error">${server.error}</pre>` : null}
            ${
                server.signIn
                    ? html`<${SignIn} key=${server.signIn} server=${server} act=${act} busy=${busy} />`
                    : null
            }
            ${
                live
                    ? html`<div class="mcp-row">
                      <button class="button" disabled=${busy} onClick=${() => run("reconnect", {})}>
                          Reconnect
                      </button>
                      ${
                          server.oauth && !server.signIn
                              ? html`<button
                                class=${`button ${server.status === "needs-sign-in" ? "primary" : ""}`}
                                disabled=${busy}
                                onClick=${() => run("sign-in", {})}
                            >
                                Sign in
                            </button>`
                              : null
                      }
                      ${
                          server.oauth && server.signedIn
                              ? html`<button
                                class="button"
                                disabled=${busy}
                                onClick=${() => run("sign-out", {})}
                            >
                                Sign out
                            </button>`
                              : null
                      }
                  </div>`
                    : null
            }
            <div class="setting">
                <div class="grow small">
                    Plan mode may run the tools that this server marks read-only
                </div>
                <${Switch}
                    on=${server.planMode}
                    label=${`Plan mode may run read-only tools of ${server.name}`}
                    disabled=${busy || server.pocket !== "on"}
                    onChange=${() => run("plan-mode", { on: !server.planMode })}
                />
            </div>
            ${server.tools.length > 0 ? html`<${Tools} server=${server} />` : null}
        </section>`;
    }

    /** The page: what mcp.json has, and each server. */
    function Servers() {
        const [state, setState] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [project, setProject] = useState("");
        const [projects, setProjects] = useState([]);
        const scopedPath = useCallback(
            (path) => (project ? `${path}?project=${encodeURIComponent(project)}` : path),
            [project],
        );
        // Answers can come back out of order: only the newest request sets the state.
        const latest = useRef(0);

        const show = (request, answer) => {
            if (request === latest.current) {
                rail.update({ badge: answer.attention });
                setState(answer);
            }
        };

        const refresh = useCallback(async () => {
            const request = ++latest.current;

            try {
                show(request, await pocket.api(scopedPath("state")));

                if (request === latest.current) {
                    setError(null);
                }
            } catch (failure) {
                if (request === latest.current) {
                    setError(failure.message);
                }
            }
        }, [scopedPath]);

        /**
         * Do one thing on the server, then show the new state. A sign-in opens its page from a link. With `quiet`, the
         * caller shows the error.
         */
        const act = useCallback(
            async (path, body, { quiet = false } = {}) => {
                setBusy(true);

                const request = ++latest.current;

                try {
                    const answer = await pocket.api(scopedPath(path), body);

                    if (answer && Array.isArray(answer.servers)) {
                        show(request, answer);
                    } else {
                        await refresh();
                    }

                    setError(null);
                } catch (failure) {
                    if (!quiet) {
                        setError(failure.message);
                    }

                    throw failure;
                } finally {
                    setBusy(false);
                }
            },
            [scopedPath, refresh],
        );

        useEffect(() => {
            let active = true;

            pocket.api("projects").then(
                (answer) => {
                    if (active) {
                        setProjects(answer.projects);
                    }
                },
                (failure) => {
                    if (active) {
                        setError(failure.message);
                    }
                },
            );

            return () => {
                active = false;
            };
        }, []);

        useEffect(() => {
            void refresh();
            const stop = pocket.on("changed", () => void refresh());

            return () => {
                ++latest.current;
                stop();
            };
        }, [refresh]);

        const configuration = html`<label class="small">
                Configuration
                <select class="mcp-input" value=${project} disabled=${busy}
                    onChange=${(event) => {
                        ++latest.current;
                        setState(null);
                        setProject(event.currentTarget.value);
                    }}>
                    <option value="">User · all projects</option>
                    ${projects.map((cwd) => html`<option value=${cwd}>Project · ${cwd}</option>`)}
                </select>
            </label>`;

        if (!state) {
            return html`<div class="mcp-page">${configuration}${
                error
                    ? html`<div class="error-box">${error}</div>
                      <button class="button" onClick=${refresh}>Try again</button>`
                    : html`<${Loader} label="Reading mcp.json" />`
            }</div>`;
        }

        return html`<div class="mcp-page">
            ${configuration}
            <p class="small muted">
                The servers of <span class="mono">${state.file}</span>.
                ${project ? "These servers are available only to sessions in this project folder. A project entry shadows a user entry with the same name, even while off." : "These servers are available to all projects, unless a project entry has the same name."} Each server is a program that runs with your rights, and Lancet Guard does not
                check the calls of its tools. Pi Pocket starts a server only after you turn it on here,
                and again after each change to its entry.
            </p>
            <div class="mcp-row">
                <button
                    class="button"
                    disabled=${busy}
                    onClick=${() => act("reload", {}).catch(() => undefined)}
                >
                    Read mcp.json again
                </button>
            </div>
            ${error ? html`<div class="error-box">${error}</div>` : null}
            ${
                state.errors.length > 0
                    ? html`<div class="error-box">
                      ${state.errors.map((each) => html`<div class="small">${each}</div>`)}
                  </div>`
                    : null
            }
            ${
                state.servers.length === 0
                    ? html`<p class="muted">
                      mcp.json has no servers. Add an entry to <span class="mono">${state.file}</span>, then read mcp.json again.
                  </p>`
                    : state.servers.map(
                          (server) =>
                              html`<${ServerCard}
                              key=${server.name}
                              server=${server}
                              act=${act}
                              busy=${busy}
                          />`,
                      )
            }
        </div>`;
    }

    pocket.page({ id: "servers", title: "MCP servers", component: Servers });

    pocket.launcher({
        id: "servers",
        label: "MCP servers",
        detail: "servers, tools, sign-in",
        iconPath: PLUG,
        keywords: ["mcp", "model context protocol", "tools"],
        page: "servers",
    });

    // The count on the rail: now, at each change, and when the browser shows the page again from its cache (events
    // that came while it was away are lost).
    const recount = () => void read().catch(() => undefined);

    pocket.onDispose(pocket.on("changed", (data) => rail.update({ badge: data?.attention ?? 0 })));
    window.addEventListener("pageshow", recount);
    pocket.onDispose(() => window.removeEventListener("pageshow", recount));
    recount();

    // How calls show in transcripts, in the owner's tabs (the browser module is the owner's only).
    pocket.toolCall({
        tool: "mcp_tools",
        iconPath: PLUG,
        label: () => "list MCP tools",
        subject: (args) => [text(args.server), text(args.query)].filter(Boolean).join(" · "),
        summary: () => ({ verb: "listed MCP tools" }),
    });

    for (const tool of ["mcp_call", "mcp_call_read_only"]) {
        pocket.toolCall({
            tool,
            iconPath: PLUG,
            label: () => "call MCP tool",
            subject: (args) => [text(args.server), text(args.tool)].filter(Boolean).join(" · "),
            summary: () => ({ verb: "called", noun: "MCP tool", by: "tool" }),
        });
    }
}

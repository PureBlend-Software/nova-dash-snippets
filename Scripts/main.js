//
// Dash Snippets for Nova
// ------------------------------------------------------------------
// Reads your Dash snippet library (a SQLite file) READ-ONLY and offers each
// snippet through Nova's own completion system. Insertion goes through Nova's
// edit API, so no keystrokes are simulated and the newline before an
// abbreviation is never deleted. Dash remains the single source of truth; this
// never writes to it.
//
// Data model: table snippets(sid, title, body, syntax, usageCount)
//   title = abbreviation, body = snippet text, syntax = language.
// Dash placeholders: ##name## -> ${n:name}; @cursor -> $0.
//   Literal code (e.g. __func__, @selector) is left untouched.
// Nova snippet syntax (LSP/TextMate): ${1:default} numbered tab stops, $0 final.
//

const CONFIG_KEY = "com.pureblendsoftware.dashsnippets.libraryPath";
// Dash's standard library location, used only if nothing is configured and
// Dash's own preference can't be read.
const FALLBACK_PATH = "~/Library/Application Support/Dash/library.dash";
const POLL_MS = 5000;

let cachedItems = [];      // array of CompletionItem, returned as-is per keystroke
let currentPath = null;    // resolved absolute path to the library
let lastMtime = -1;        // last seen modification time of the library
let SNIPPET_KIND = null;

let assistantDisposable = null;
let configDisposable = null;
let pollTimer = null;

// ---- helpers ---------------------------------------------------------------

function pickKind() {
    if (typeof CompletionItemKind === "undefined") return undefined;
    if (CompletionItemKind.Snippet != null) return CompletionItemKind.Snippet;
    if (CompletionItemKind.Expression != null) return CompletionItemKind.Expression;
    return CompletionItemKind.Keyword;
}

function expandTilde(p) {
    if (p && p.startsWith("~")) {
        const home = nova.environment["HOME"];
        if (home) return home + p.slice(1);
    }
    return p;
}

// Read a single string value from a macOS preferences domain via `defaults read`.
function readDefault(domain, key) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = new Process("/usr/bin/defaults", { args: ["read", domain, key] });
        } catch (err) {
            resolve(null);
            return;
        }
        const out = [];
        proc.onStdout((line) => out.push(line));
        proc.onDidExit((status) => resolve(status === 0 ? out.join("").trim() : null));
        try {
            proc.start();
        } catch (err) {
            resolve(null);
        }
    });
}

// Resolve the library path: explicit preference -> Dash's own snippetSQLPath
// preference -> Dash's standard library location. No personal path is baked in.
async function resolvePath() {
    const configured = nova.config.get(CONFIG_KEY, "string");
    if (configured && configured.trim()) return expandTilde(configured.trim());
    for (const domain of ["com.kapeli.dashdoc", "com.kapeli.dashdoc-setapp"]) {
        const p = await readDefault(domain, "snippetSQLPath");
        if (p) return expandTilde(p);
    }
    return expandTilde(FALLBACK_PATH);
}

// Build a read-only file: URI, percent-encoding each path segment so spaces survive.
function toReadonlyUri(path) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return "file:" + encoded + "?mode=ro";
}

// Escape characters special to Nova's snippet parser within LITERAL text.
// Only `\` and `$` are special outside of a ${...}; a bare `}` is literal.
function escapeLiteral(text) {
    return text.replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
}

// Escape text placed INSIDE a ${n:...} default, where `}` would close it early.
function escapeDefault(text) {
    return text.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/}/g, "\\}");
}

// Translate a Dash snippet body into a Nova snippet insertText string.
function dashToNova(body) {
    const re = /##([\s\S]*?)##|@cursor\b/g;
    const nameToIndex = new Map();
    let nextIndex = 1;
    let usedCursor = false;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
        out += escapeLiteral(body.slice(last, m.index));
        if (m[0] === "@cursor") {
            if (!usedCursor) {
                out += "$0";
                usedCursor = true;
            }
        } else {
            const name = m[1];
            let idx = nameToIndex.get(name);
            if (idx === undefined) {
                idx = nextIndex++;
                nameToIndex.set(name, idx);
            }
            out += "${" + idx + ":" + escapeDefault(name) + "}";
        }
        last = re.lastIndex;
    }
    out += escapeLiteral(body.slice(last));
    return out;
}

function buildItem(row) {
    if (!row || typeof row.title !== "string" || typeof row.body !== "string") {
        return null;
    }
    const label = row.title.trim();
    if (!label) return null;

    const item = new CompletionItem(label, SNIPPET_KIND);
    item.insertText = dashToNova(row.body);
    item.insertTextFormat = InsertTextFormat.Snippet;
    item.filterText = label;

    const syntax = (row.syntax || "").trim();
    item.detail = syntax ? "Dash · " + syntax : "Dash snippet";

    let preview = row.body;
    if (preview.length > 800) preview = preview.slice(0, 800) + "…";
    item.documentation = preview;

    return item;
}

// Run sqlite3 read-only and return raw stdout (JSON).
function runSqlite(dbUri) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = new Process("/usr/bin/sqlite3", {
                args: [
                    "-json",
                    dbUri,
                    "SELECT sid, title, body, COALESCE(syntax,'') AS syntax FROM snippets ORDER BY usageCount DESC, sid;"
                ]
            });
        } catch (err) {
            reject(err);
            return;
        }
        const out = [];
        const errLines = [];
        proc.onStdout((line) => out.push(line));
        proc.onStderr((line) => errLines.push(line));
        proc.onDidExit((status) => {
            if (status !== 0) {
                reject(new Error("sqlite3 exited " + status + ": " + errLines.join(" ").trim()));
            } else {
                resolve(out.join("\n"));
            }
        });
        try {
            proc.start();
        } catch (err) {
            reject(err);
        }
    });
}

async function reload(reason) {
    currentPath = await resolvePath();
    const path = currentPath;

    let readable = false;
    try {
        readable = nova.fs.access(path, nova.fs.R_OK);
    } catch (err) {
        readable = false;
    }
    if (!readable) {
        console.error("[DashSnippets] Library not found or not readable: " + path +
            " — set a path in the extension's preferences, or check that Dash is installed.");
        return;
    }

    try {
        const raw = (await runSqlite(toReadonlyUri(path))).trim();
        const rows = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(rows)) {
            throw new Error("unexpected sqlite output (not a JSON array)");
        }
        const items = [];
        for (const row of rows) {
            const item = buildItem(row);
            if (item) items.push(item);
        }
        cachedItems = items;

        try {
            const stat = nova.fs.stat(path);
            lastMtime = stat && stat.mtime ? stat.mtime.getTime() : lastMtime;
        } catch (err) { /* ignore */ }

        console.log("[DashSnippets] Loaded " + cachedItems.length + " snippets from " +
            path + (reason ? " (" + reason + ")" : ""));
    } catch (err) {
        console.error("[DashSnippets] Failed to read snippets: " +
            (err && err.message ? err.message : String(err)) +
            " — check that the file is a Dash snippet DB with a 'snippets' table.");
    }
}

// Poll mtime; reload only when the library actually changes (never per keystroke).
function checkForChanges() {
    if (!currentPath) return;
    let stat;
    try {
        stat = nova.fs.stat(currentPath);
    } catch (err) {
        return;
    }
    if (!stat || !stat.mtime) return;
    const m = stat.mtime.getTime();
    if (m !== lastMtime) {
        lastMtime = m;
        reload("library changed");
    }
}

// ---- activation ------------------------------------------------------------

exports.activate = function () {
    SNIPPET_KIND = pickKind();

    let options;
    try {
        options = { triggerChars: new Charset(";/") };
    } catch (err) {
        options = undefined;
    }

    assistantDisposable = nova.assistants.registerCompletionAssistant("*", {
        provideCompletionItems(editor, context) {
            return cachedItems;
        }
    }, options);

    reload("startup");
    pollTimer = setInterval(checkForChanges, POLL_MS);

    configDisposable = nova.config.onDidChange(CONFIG_KEY, () => {
        lastMtime = -1;
        currentPath = null;
        reload("library path changed");
    });
};

exports.deactivate = function () {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (assistantDisposable) { assistantDisposable.dispose(); assistantDisposable = null; }
    if (configDisposable) { configDisposable.dispose(); configDisposable = null; }
};

// Manual reload + a quick "how many loaded" confirmation.
nova.commands.register("com.pureblendsoftware.dashsnippets.reload", async () => {
    lastMtime = -1;
    currentPath = null;
    await reload("manual");
    nova.workspace.showInformativeMessage(
        "Dash Snippets: " + cachedItems.length + " snippets loaded."
    );
});

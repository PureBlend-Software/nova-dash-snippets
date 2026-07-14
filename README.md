# Dash Snippets

Surfaces your [Dash](https://kapeli.com/dash) snippet library as completions
inside Nova. As you type an abbreviation, the matching Dash snippet appears in
Nova's completion list; choosing it inserts the body through Nova's edit API — no
keystrokes are simulated.

- **Read-only.** The Dash library is opened read-only and never modified.
- **No second store.** Dash stays the single source of truth.
- **Live reload.** Snippets you add in Dash appear in Nova within a few seconds.

## Library location

By default the extension auto-detects your Dash snippet library from Dash's own
preferences, falling back to the standard Dash library location. To point it at a
specific file, set it under **Nova ▸ Settings ▸ Extensions ▸ Dash Snippets ▸ Dash
snippet library**.

## Placeholders

Dash placeholders are translated to Nova's snippet tab stops on insertion: a
`##name##` placeholder becomes a numbered tab stop, and `@cursor` becomes the
final cursor position. Literal code (such as `__func__`) is left untouched.

## Commands

- **Dash Snippets: Reload Library** — reloads the snippets immediately.

# Dash Snippets

Surfaces your [Dash](https://kapeli.com/dash) snippet library as completions
inside Nova. Type an abbreviation, and the matching Dash snippet appears in
Nova's completion list — choose it and the snippet is inserted.

## Why this exists

Dash expands snippets by simulating backspace keystrokes through the macOS
accessibility API: it "types" backspaces to erase the abbreviation you entered,
then inserts the snippet body. Inside Nova those backspaces overshoot — they
delete the newline that precedes the abbreviation, so expanding a snippet at the
start of a line yanks it up onto the previous line and mangles your text.

Rather than fight that behavior, this extension sidesteps it entirely. Your Dash
snippets are handed to Nova's own completion system, and insertion goes through
Nova's editor API. No keystrokes are simulated, nothing is backspaced, and the
text before your abbreviation is left exactly as it was.

- **Read-only.** The Dash library is opened read-only and never modified.
- **No second store.** Dash stays the single source of truth for your snippets.
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

# What is in this folder

Every file here is a byte-for-byte copy of a file installed with Visual Studio Code 1.146.0 on the
machine the copy was taken from. Nothing was redrawn or approximated. None of it is licensed by
pi-studio: each file keeps the licence its own project gave it, and the text of each licence is beside
the file it covers.

`seti.woff` and `vs-seti-icon-theme.json`
:   The Seti file icon theme VS Code ships, copied from
    `/usr/share/code/resources/app/extensions/theme-seti/icons/`. It is Seti UI, copyright (c) 2014
    Jesse Weed, MIT, which Microsoft redistributes with VS Code. The notice VS Code ships beside it is
    copied verbatim as `theme-seti-ThirdPartyNotices.txt`. The drawer reads the theme JSON for a file's
    glyph and colour; `seti.woff` is the font those glyphs are cut from.

`codicon.ttf`
:   The Codicon icon font, copied from `/usr/share/code/resources/app/out/media/codicon.ttf`. VS Code's
    own `ThirdPartyNotices.txt` names it "vscode-codicons 0.0.46-0 - MIT and Creative Commons
    Attribution 4.0", so both licences apply. `codicons-LICENSE.txt` was fetched from the project's
    repository (`https://github.com/microsoft/vscode-codicons`, `LICENSE`); the copy on disk is the
    Attribution 4.0 International text, which belongs to the drawn glyphs, while the build code is MIT.

`github-theme-LICENSE.txt`
:   The licence of the GitHub theme for VS Code, "GitHub Dark Default", copyright (c) 2020 Primer, MIT.
    The colours the drawer uses are read from that theme's `themes/dark-default.json`. The board's own
    palette was already drawn from the same theme.

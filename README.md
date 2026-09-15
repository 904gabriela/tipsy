# Tipsy

A roleplay app with an actual memory. Personal, private, and yours.

## Starting it

Double-click **start.bat**.

Leave that black window open while you use the app. Closing it stops the app.

Then open **http://localhost:8787** in your browser.

To use it on your phone, connect the phone to the same wifi and open the
address the window prints, the one that starts `http://192.168...`.

## Putting it on your home screen

**iPhone.** Open the address in Safari, tap the share button, then
*Add to Home Screen*. It gets its own icon and opens without browser bars.
This also stops Safari deleting the app's data if you do not open it for a week.

**Windows.** Open it in Edge, click the three dots, then *Apps → Install this
site as an app*. It gets a Start menu entry and its own window.

## Your key

Your OpenRouter key lives in the file `.env`. It never leaves your computer and
is never sent to the browser. `.env` is excluded from git, so it cannot end up
in a commit.

## Your things

Everything lives in one file: `data/tipsy.db`. Copy that file and you have
copied your entire world — characters, lore, and every version of every story.

`samples/` holds the files you imported. Nothing in it is committed.

## Loading your library

`npm run setup` reads everything in `samples/` and `templates/` and adds it.
Add `--fresh` to wipe first and start over.

## Where things are

| | |
|---|---|
| `server.js` | the server |
| `public/` | the app you look at |
| `src/import/` | reading character cards and lorebooks |
| `src/engine/` | deciding which lore fires, and building the prompt |
| `src/db/` | storage |
| `docs/` | the research behind the decisions, and a guide to writing lore |
| `templates/` | a worked example lorebook |

# cAdtree

cAdtree keeps a version history for files that stay on your computer. You keep working in the apps you already use (SolidWorks, AutoCAD, or anything else that saves files); cAdtree saves versions of your project folder, lets you branch off to try alternatives, and records why you made each change.

It is made for people without enterprise file-management systems: individual engineers, students, freelancers and small teams, and also designers, artists, scientists and accountants. It is inspired by Git, but you don't need to know Git. It runs entirely in the browser, with nothing to install, and your files are never uploaded.

## Status

Early. cAdtree is in a building phase and has no stable release yet. It works only in **Chrome or Edge on a desktop computer**, because it uses the browser's File System Access API. Safari and Firefox don't support it. The first qualification target is SolidWorks parts, assemblies and drawings on Windows.

cAdtree does not read or compare the contents of CAD files. A changed checksum tells you a file changed, not what changed in the geometry.

## What it does today

- **Save versions.** Each version asks for a "What changed" line, with optional detail on why and what you noticed.
- **Design cases.** Start from a saved version and work on an alternative in its own folder, without disturbing the main line.
- **Copy files from a case.** Bring one case's changes into another, after reviewing the list. Files changed on both sides need a deliberate choice.
- **Bring back.** Make a case match one of its earlier versions again.
- **Discard.** Put unsaved changes back to the latest saved version. What was replaced is kept in a `Discarded` folder.
- **Get this version.** Take a single file from an earlier version.
- **Export a copy.** Write out any version, optionally with its references, to share or inspect.
- **References.** Pin supporting documents to a version or a file.
- **Recover without cAdtree.** Plain-text guides (Readme, Index, Map) and a self-contained restore page sit next to your files, so you can get them back even if you never open cAdtree again.

Signing in is optional and is not needed for local work. It doesn't upload your files.

## Run it locally

Requires Node 24.12 or newer.

```
npm ci
npm run dev        # http://127.0.0.1:2500
```

Checks:

```
npm run lint
npm test
npm run test:knowledge-lab
npm run build
npm run test:ui    # Playwright; run `npx playwright install chromium` first
```

`CLAUDE.md` and `DEVELOPMENT.md` describe the architecture and the rules the code must follow. `USER_GUIDE.md` is the guide for people using the app.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Licence

cAdtree is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)). Code in any directory named `ee/` is not covered by the AGPL and is licensed separately under the terms in that directory's own LICENSE file. There is no such directory yet.

The "cAdtree" name and logo are not licensed for use by forks.

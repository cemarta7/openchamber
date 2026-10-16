# Skill switches evidence for issue 3075

Before images: upstream 2b94db847. After images and recordings: ccace0f.
Final code 277d659 only changes refused-delete response handling and documentation;
the UI, queue, and switch behavior shown here are unchanged. Independent review confirmed this.

The files show isolated fixtures on Linux with OpenCode 2.0.29 and a local fake provider.
Web screenshots include light/dark and wide/narrow states. Desktop evidence is an
unpackaged Linux Electron run, not an installed application. VS Code host and native
mobile were not run. Catalog install state was seeded; uninstall used the real UI.

Folders: before-after, desktop, catalog, videos.
These assets are separate from the feature branch and are not part of the product diff.

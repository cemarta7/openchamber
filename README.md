# Project-scoped Magic Prompts evidence

Fixture-only screenshots and a continuous browser recording for issue #2442.

Current captures were made at `65a8b0f6b2841a4799567f24675ce5b2243a037f`. Publication HEAD `a9b08a857efbd7426046ea8ab58d3933c268d1f3` has the identical file tree. Only unpublished commit email metadata changed for GitHub privacy protection.

- `desktop-global.png`, `desktop-project.png`, `desktop-narrow-after.png`, `desktop-invalid-json.png`, and the mobile images are from the merged revision.
- `desktop-narrow-before.png` is historical evidence from `4a383cd1`, before the narrow Settings fix. It intentionally shows the broken layout.
- `desktop-dark-historical.png` is historical dark-theme layout evidence from `10efec1e`. It is not a final-merge capture.
- `desktop-invalid-json.png` shows an intentional malformed fixture, not normal operation. The file was restored after the test.
- `continuous-mobile-flow.webm` is a continuous 43.583-second X11 capture at 12 fps, 532x844. The GIF is converted from that recording. It shows browser emulation, not a physical phone or Capacitor app.

No private Electron captures or screenshot slideshow are included. Electron could not launch on the final merge because the installed SUID sandbox helper lacked required configuration; no sandbox protections were disabled. Native mobile and real keyboard/IME testing remain unavailable.

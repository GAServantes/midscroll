# Security

Scroll Goblin's daemon, `midscroll`, reads every mouse on the machine and
writes a virtual one, as root, from boot. (Scroll Goblin is the project's
name; the programs, services and files keep the name `midscroll`.) That is a lot of trust. This file says exactly what it
trusts, what it refuses to do, and where the sharp edges are, so you can
check the code against it rather than take anyone's word.

Everything here is enforced in code, not just described: if you find a
gap between the two, that is a bug worth reporting.

## The pieces, and what each one trusts

| Component | Runs as | Trusts |
| --- | --- | --- |
| `midscroll` | root, `SCHED_FIFO`, sandboxed system unit | `/etc/midscroll.conf`, and only when root owns it and nobody else can write it. On its socket, only short bounded lines from a logged-in user's helper (see "The state socket") |
| `midscroll-apply` | root, briefly, via pkexec | its arguments, after validating every one. It can only ever write a well-formed `/etc/midscroll.conf` |
| `midscroll-settings` | you | nothing privileged. Reads `/proc/bus/input/devices` and the config; hands validated `KEY=VALUE` pairs to `midscroll-apply` |
| `midscroll-overlay` | you, session unit | the daemon's socket, after checking nobody it can name owns it (see below) |
| GNOME extension (`midscroll-indicator@midscroll`) | you, inside GNOME Shell | the daemon's socket; your cursor theme's files, for hot spots only (see "The GNOME extension") |

Two things this does *not* try to defend against, so they aren't mistaken
for gaps: a hostile root (already game over), and hardware lying about
itself (a USB device can claim any name or vendor:product it likes - see
"Device specs" below).

## The config file decides what root opens

Since 1.13, `/etc/midscroll.conf` picks which devices the daemon grabs.
That makes it a security-relevant file, so the daemon refuses to read it
unless it is owned by root and not group- or world-writable. The check is
an `fstat` on the descriptor it already opened (with `O_NOFOLLOW`), so
there is no gap between checking and reading, and the file is capped at
64 KiB. A rejected config means built-in defaults, logged loudly - never
a silent fallback to something an unprivileged user wrote.

This applies to `--config` too, so `sudo midscroll --config ~/mine.conf`
is refused. Every tunable is available as a command-line flag, which is
the supported way to experiment.

## Device specs

`EXTRA_DEVICES` and `IGNORE_DEVICES` take three forms: a `/dev/input`
path, a hex `vendor:product`, or part of a device's name. Rules the
daemon enforces on them:

- **Its own mirrors are never grabbed**, whatever a spec says. midscroll
  emits through uinput devices that carry a known `phys` string; grabbing
  one would put a root process in a 90 Hz feedback loop with itself. The
  check runs before the lists are consulted, and again in the per-device
  read loop.
- **Keyboards are refused** - anything that can produce letters - unless
  `ALLOW_KEYBOARDS` is set. That key is not settable from the GUI:
  `midscroll-apply` rejects it as an argument and only carries an
  existing setting through, so turning it on takes a root edit of the
  config. The point of the split is that the pkexec path can pick mice
  without ever being able to point a root daemon at your typing.
- **Deny beats allow**: `IGNORE_DEVICES` wins over `EXTRA_DEVICES`.
- **Bounds**: at most 32 specs per list, 128 characters each, name specs
  at least 3 characters (a one-character fragment would match nearly
  every device on the machine and exclusively grab them all), and at most
  16 devices grabbed at once.
- **Paths are only ever compared, never opened.** A spec is matched
  against nodes the daemon has already enumerated and opened itself, so a
  spec cannot make it open a path of the author's choosing and there is
  no check-then-open race.
- Name and `vendor:product` specs match strings the *hardware* supplies,
  so a malicious USB device could name itself to match a loose spec and
  be grabbed. Prefer the `by-id` and `by-path` forms, which also pin the
  port and interface - they are what the settings GUI writes and what
  `midscroll --list-devices` prints.

Nothing anywhere logs an event code or value, at any log level, so what
you type or click never reaches the journal.

## The state socket

`/run/midscroll/state.sock` lets the session helper draw the autoscroll
cursor and report the focused window's class back. It lives in a
root-owned runtime directory, so nobody else can create or replace it,
and it is mode 0666 because any session's helper may need it - each
connection is then checked:

- the peer's uid must belong to a user logged in on a seat
  (`SO_PEERCRED`, cross-checked against logind), so a service account or
  a sandboxed app can't feed the daemon a fake focus and pause it;
- at most 16 connections at once, and 4 per uid;
- lines in are bounded (4 KiB read buffer, 256 characters kept, control
  characters stripped).

What comes in, and what each line can do:

- `focus <class>`: the focused window's class, so the blacklist can pause
  scrolling. The worst a lie can do is pause it or stop it pausing.
- `caps scroll` / `caps anchored`: the helper scrolls by itself. The
  daemon then stops sending wheel events for that session's drags.
- `screen <dx> <dy>` (active session only): the on-screen drag offset,
  used for the speed. Clamped like any drag offset.
- `click native` / `click scroll` (active session only): whether a plain
  middle click on this press should stay a middle click (a link, a
  browser's tabs) or start a click-to-scroll. It can only choose between
  those two.

What goes out: `press`/`release` and `1`/`0` when a drag starts and
stops; the speed curve (`cfg`) and the current speed; and while an
anchored drag is running, `pos <dx> <dy>` - **offsets from the anchor,
never absolute coordinates**. Drag lines only go to the session that is
currently active, so another user's backgrounded session sees nothing. A client
that stops reading is skipped while it is behind and disconnected if it
stays behind, so it can't grow a root daemon's memory at 60 Hz.

## The full-screen overlay (KDE)

On KDE Plasma the ghost cursor is drawn on a layer-shell surface that covers the
monitor, so its empty input region is the thing that must never be wrong:
a surface that took input would swallow every click in the session. Three
independent guards:

- the input region is re-applied every time the surface is mapped, never
  assumed to have survived;
- it is re-asserted once a second while the overlay is up;
- the overlay is only mapped during an actual drag, and takes itself down
  if the daemon goes quiet for five seconds or the socket drops - so a
  killed or wedged daemon cannot leave it on screen.

The ghost is your own pointer image, which means the helper parses an
Xcursor file out of your icon theme - a binary format, and one you may
well have downloaded from the internet. It is treated accordingly: at
most 4 MiB is read, the table of contents and every chunk offset are
bounds-checked, images larger than 256 px or with a hotspot outside the
image are rejected, and any malformed field falls back to a plain drawn
arrow rather than an exception. It runs unprivileged, as you, reading
files you already own.

Before connecting, the helper checks that `/run/midscroll/state.sock` is
a socket and is not owned by a uid it can name - if something it could
have created itself is sitting at that path, it stays away rather than
report your focused window to it. It cannot check for root specifically:
systemd runs a sandboxed *user* service inside a user namespace where
your own uid is the only one mapped, so root, like every other owner,
reads back as the overflow uid. The real guarantee is one level up -
`/run/midscroll` is a root-owned `RuntimeDirectory`, so nothing else can
put a socket there in the first place.

## The GNOME extension

On GNOME a Shell extension does the scrolling and the drawing. It runs
inside GNOME Shell as you, with what any extension has, so read
`gnome-extension/extension.js` before installing it. What it does with
that access:

- It scrolls through its own virtual pointer, and only while the daemon
  says a drag is on. It never clicks, types or moves the pointer, except
  to put the pointer back where your hand is when a held-still drag ends.
- With a free cursor it fences the pointer into the window the drag
  started in with pointer barriers, removed on release, on a lost
  connection and when the extension is turned off.
- With the pointer held still it hides the real cursor and holds GNOME's
  "keep pointer focus" inhibit for the length of the drag. Both are let go
  on release, on a lost connection and when the extension is turned off,
  so the cursor can't stay hidden.
- To tell a link's hand cursor from the arrow, it reads the hot spot of
  each image in your cursor theme's Xcursor files: files over 4 MiB are
  skipped, every offset is bounds-checked against the file, and only
  numbers are kept. It runs unprivileged and reads files you already own.
- It stays on through the lock screen so GNOME never has to turn it back
  on at unlock, but while the screen is locked it treats every window as
  hidden, so a middle-drag there can't fence the pointer into a window
  behind the lock screen.
- Its look settings are ordinary per-user GSettings; changing them needs
  no password and touches nothing system-wide.

## Sandboxing

Both units are locked down; read them, they are short. The daemon runs as
root but holds **no capabilities at all** (`CapabilityBoundingSet=`) -
opening input nodes, `EVIOCGRAB` and uinput are plain file permissions,
and its real-time priority is set by PID 1 before exec. It has no
network (`PrivateNetwork=yes`), a read-only file system except its
runtime directory, a `@system-service` syscall filter, no writable
executable memory, and memory and task caps.

Check the exposure yourself:

```
systemd-analyze security midscroll.service
systemd-analyze --user security midscroll-overlay.service
```

Deliberately absent, with reasons, in comments in the unit files:
`PrivateDevices`/`DevicePolicy` (the daemon needs real evdev and uinput
nodes, including hotplugged ones), `RestrictRealtime` (FIFO scheduling),
and for the session helper `PrivateTmp` (kdotool hands KWin a script path
in the shared `/tmp`) and `MemoryDenyWriteExecute` (GTK and GL).

## Privilege escalation, or rather not

`midscroll-apply` is the only thing that runs as root on demand. It
validates every argument, bounds its own argv (64 arguments, 4 KiB each),
strips anything from list values that isn't a plausible device or window
class character - including `#`, `=` and newlines, which the config
parser would read as structure - and regenerates the file from a fixed
template. There is no path through it that writes arbitrary text.

Its polkit action asks for authentication on **every** Apply, and refuses
inactive sessions outright. If the prompting bothers you, changing
`allow_active` back to `auth_admin_keep` in
`/usr/share/polkit-1/actions/io.github.gnhen.midscroll.policy` restores
the five-minute cache - just know that it lets anything else in your
session re-run `midscroll-apply` unprompted during that window.

## Reporting

Found something sketchy, or a way to harden this further? Open an issue
or a pull request. Security review is genuinely welcome.

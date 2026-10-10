# Efficient desktop control

The companion and the Work host must both be updated. Work ships copies of the host-side tools:
run `node scripts/vendor-seek.mjs` after changing their desktop-bridge sources. Existing pairings
and the encrypted WebRTC transport are retained.

## Few calls for ordinary tasks

| Request | Tool path |
| --- | --- |
| What's in Downloads? | `desktop_list({path:"Downloads"})`, then answer from the returned entries |
| Open Documents | `desktop_open_folder({path:"Documents"})`, which returns verification |
| Switch to an open app | `desktop_windows`, then `desktop_switch_window` using its window ID |
| Start an app | `desktop_apps`, then `desktop_open_app` using its application ID |
| Use a menu | `desktop_menu({path:["File","Open"]})`, or a known keyboard shortcut |
| Select all | `desktop_shortcut({key:"A",modifiers:["Command"]})` on Mac; Control on Windows |
| Read a document | `desktop_read({ref:"eN"})` uses AXValue/UIA TextPattern rather than selecting and copying |
| Read game/canvas text | `desktop_screen_text`, then act using its text references |
| Automate several known steps | `desktop_enable_scripts`, wait for task approval, then one `desktop_script` |

Folder aliases resolve on the controlled computer, never on the Seek host. Lists have bounded
pages (`limit` up to 200, `nextOffset` for continuation) and include file types, sizes and dates.
Native folder listing, menus, launching and shortcuts do not require arbitrary-script permission.
Opening a folder only accepts a directory; opening an app uses a verified installed-app ID.

The readers use the same structures as screen readers: Windows' UIA Control View and macOS AX.
Provider properties are fetched in batches, so each control does not require a separate IPC call
for every name, role, bounds and state. Mac observations include top-level menu names and static
text labels. Observations prioritize focus and actionable controls ahead of unnamed containers,
identify the app and window, and retain bounded trees and live native target checks. A 30-second
observation lifetime accommodates model inference; the independent 15-second control lease and
native checks still fence takeover, focus changes, protected fields and stale input. No-progress
guidance changes strategy after two ineffective actions. The guide appears once in the task
instructions instead of being repeated in every tool schema.

## Scripting approval

Desktop permission and scripting permission are separate. Seek asks in the browser/phone before
running scripts for each task. Phone approval works only with the computer's saved remote-approval
opt-in. Otherwise approve in Seek Desktop settings, then reply “I approved on the computer”. The
host verifies the actual local grant. Approvals bind the task, computer, session and epoch; stale
answers cannot approve a replacement session. Approval may be reused when the same task rotates
agent sessions on the same computer. Another task must ask again.

Mac supports `applescript` through `/usr/bin/osascript` and `shell` through `/bin/zsh`;
Windows supports `powershell`. Scripts run with the logged-in user's privileges. Execution is
bounded to 60 seconds and 24 KB of output. Stop, lock, sleep, connection/lease loss and teardown
cancel running processes and clear the active session's grant. Timeouts/interruption report
uncertain effects and never retry automatically. Detached processes deliberately created by
scripts are outside guaranteed cancellation. AppleScript may also need macOS Automation consent
for the target application; this is separate from Accessibility and task approval.

## Screen text

Screen text recognition uses Apple Vision and Windows Media OCR locally. Images stay in the
companion/native worker; Seek receives text and bounds. Mac needs Screen Recording; Windows
needs a supported OCR language installed. Only the active window's visible portion on the selected
display is recognized, and results overlapping known protected fields are removed. Pinned
background windows must be switched to the active-window mode first.

OCR refs are marked as potentially inaccurate and support pointer actions, not accessible fill,
invoke or document reading. Every OCR pointer action re-captures and checks its window, text and
bounds before execution. OCR readback follows automatically. It cannot interpret icons, game
graphics or unlabeled controls; these still need a person or another app-specific interface.

## Stable signing on your Mac, without Apple membership

On the Mac used to build Seek, run once from `desktop-bridge`:

```sh
npm run signing:setup
```

This creates a personal code-signing identity in your login Keychain with a 10-year validity.
macOS may ask you to approve its import/trust and codesign access. Rerunning setup reuses the
existing certificate. Back up its certificate **and private key** privately in Keychain Access;
do not commit or replace them on each build.

Build future updates with the same identity:

```sh
SEEK_MAC_SIGNING_IDENTITY="Seek Desktop Personal" npm run build
SEEK_MAC_SIGNING_IDENTITY="Seek Desktop Personal" npm run verify:mac
```

The app ID stays `com.joelcrobinson.seek.desktop`; the native helper has the stable signing ID
`com.joelcrobinson.seek.desktop.input`. Switching from the previous ad-hoc build needs a one-time
permission grant. Keeping the certificate and identifiers keeps the code's identity consistent
across rebuilds. The actual Accessibility/Keychain upgrade journey must be verified on your Mac.
This personal certificate does not provide Apple notarization or public Gatekeeper acceptance.
Tagged public builds retain the existing explicit preview/Developer ID release policy. Apple
Developer ID distribution still requires membership and the documented release credentials.

## Evidence and acceptance

`npm run smoke:input` checks Windows UIA fill/invoke, a real shortcut, local OCR, script approval,
and a one-call folder listing through the authenticated bridge in an owned fixture window.
Node tests cover task/session fences, stale OCR targets, folder paging, output bounds, cancellation
and timeouts. Work tests exercise the phone approval's task/computer/session binding and local
approval enforcement. CI compiles the universal Mac helper and packages all platforms.

The local Windows fixture took about 2–3 ms for the one-call folder operation; this measures the
bridge, not model inference, network latency or total phone-to-answer time. Before calling the
under-a-minute goal achieved, time a real paired Mac and PC request in Seek and verify it uses
`desktop_list` rather than a navigation loop. Also validate live Mac menus/shortcuts, Vision,
AppleScript Automation permission, and an upgrade using the same personal certificate.

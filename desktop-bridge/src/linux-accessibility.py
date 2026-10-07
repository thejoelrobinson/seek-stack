"""AT-SPI observations and guarded X11 input. One JSON request/response per line."""
import json
import os
import subprocess
import sys
import time


class AccessibilityBridge:
    def __init__(self, atspi, run=subprocess.run):
        self.api, self.run = atspi, run
        self.targets = {}
        self.window_id = None
        atspi.set_timeout(200, 2000)

    def xdo(self, *args):
        return self.run(["xdotool", *map(str, args)], check=True, capture_output=True,
                        text=True, timeout=5).stdout.strip()

    def active_window(self):
        if os.environ.get("XDG_SESSION_TYPE") == "wayland":
            raise RuntimeError("Wayland control needs the desktop portal adapter")
        return self.xdo("getactivewindow")

    def identity(self, target):
        return (target.get_role_name(), target.get_name())

    def action_index(self, target):
        action = target.get_action_iface()
        if action:
            for index in range(action.get_n_actions()):
                if action.get_action_name(index).lower() in ("click", "press", "activate"):
                    return index
        return None

    def describe(self, desktop, pid, window_id):
        """What AT-SPI exposes, for the error message when the focused window can't be matched."""
        try:
            apps = []
            for index in range(min(desktop.get_child_count(), 30)):
                app = desktop.get_child_at_index(index)
                frames = [f"{app.get_child_at_index(n).get_name()!r}" for n in range(min(app.get_child_count(), 5))]
                apps.append(f"{app.get_name()!r} pid {app.get_process_id()} frames [{', '.join(frames)}]")
            return f" (focused window pid {pid}, title {self.xdo('getwindowname', window_id)!r}; AT-SPI apps: {'; '.join(apps) or 'none'})"
        except Exception as error:
            return f" ({error})"

    def inspect(self):
        window_id = self.active_window()
        pid = int(self.xdo("getwindowpid", window_id))
        desktop, root, candidates = self.api.get_desktop(0), None, []
        for index in range(min(desktop.get_child_count(), 200)):
            app = desktop.get_child_at_index(index)
            if app.get_process_id() != pid:
                continue
            for number in range(min(app.get_child_count(), 100)):
                window = app.get_child_at_index(number)
                if window.get_state_set().contains(self.api.StateType.ACTIVE):
                    root = window
                    break
                candidates.append(window)
            if root is not None:
                break
        # Some toolkits and window managers never mark the focused frame ACTIVE. Fall back to the
        # frame whose name matches the focused X11 window's title, then to the app's only frame.
        if root is None and candidates:
            title = self.xdo("getwindowname", window_id)
            named = [w for w in candidates if (w.get_name() or "") == title]
            root = named[0] if len(named) == 1 else (candidates[0] if len(candidates) == 1 else None)
        if root is None:
            raise RuntimeError("Active window exposes no AT-SPI accessibility tree" + self.describe(desktop, pid, window_id))
        self.targets = {}
        nodes, truncated, start = [], False, time.monotonic()

        def walk(target, depth):
            nonlocal truncated
            if len(nodes) >= 500 or depth > 14 or time.monotonic() - start > 2:
                truncated = True
                return
            try:
                target.clear_cache()
                states = target.get_state_set()
                password = target.get_role() == self.api.Role.PASSWORD_TEXT
                component = target.get_component_iface()
                if component and states.contains(self.api.StateType.SHOWING):
                    rect = component.get_extents(self.api.CoordType.SCREEN)
                    if rect.width > 0 and rect.height > 0:
                        ref = "e" + str(len(nodes) + 1)
                        identity = self.identity(target)
                        node = dict(id=ref, role=identity[0], name=str(identity[1] or "")[:512],
                                    x=rect.x, y=rect.y, width=rect.width, height=rect.height,
                                    enabled=states.contains(self.api.StateType.ENABLED),
                                    focused=states.contains(self.api.StateType.FOCUSED), password=password,
                                    depth=depth, canInvoke=self.action_index(target) is not None,
                                    canFill=not password and states.contains(self.api.StateType.EDITABLE)
                                    and target.get_editable_text_iface() is not None)
                        if not password:
                            text = target.get_text_iface()
                            if text:
                                node["value"] = text.get_text(0, min(text.get_character_count(), 4096))
                        nodes.append(node)
                        self.targets[ref] = (target, identity)
                for index in range(min(target.get_child_count(), 500)):
                    if len(nodes) >= 500 or time.monotonic() - start > 2:
                        truncated = True
                        break
                    walk(target.get_child_at_index(index), depth + 1)
            except Exception as error:
                truncated = True
                errors.append(repr(error)[:200])

        errors = []
        walk(root, 0)
        if self.active_window() != window_id:
            self.targets = {}
            raise RuntimeError("Foreground window changed while observing")
        self.window_id = window_id
        view = dict(windowId=window_id, title=str(root.get_name() or "")[:512],
                    elements=nodes, truncated=truncated)
        if not nodes:
            view["diagnostic"] = self.sample(root) + errors[:3]
        return view

    def sample(self, root):
        """When nothing qualifies, report what was there: roles, states and sizes of the first nodes."""
        out, queue = [], [(root, 0)]
        while queue and len(out) < 14:
            target, depth = queue.pop(0)
            try:
                states = target.get_state_set()
                names = [n for n in ("SHOWING", "VISIBLE", "ENABLED", "EDITABLE", "FOCUSABLE") if states.contains(getattr(self.api.StateType, n, n.lower()))]
                component = target.get_component_iface()
                rect = component.get_extents(self.api.CoordType.SCREEN) if component else None
                out.append(f"{depth}:{target.get_role_name()}:{(target.get_name() or '')[:30]!r}:{','.join(names)}:{(rect.width, rect.height) if rect else 'no-component'}:{target.get_child_count()}")
                queue.extend((target.get_child_at_index(i), depth + 1) for i in range(min(target.get_child_count(), 6)))
            except Exception as error:
                out.append(f"{depth}:error {error!r}"[:120])
        return out

    def validate(self, command):
        if command.get("windowId") != self.window_id or self.active_window() != self.window_id:
            raise RuntimeError("Foreground window changed; observe again")
        cached = self.targets.get(command.get("targetId"))
        if not cached:
            raise RuntimeError("Target reference expired")
        target, identity = cached
        target.clear_cache()
        states = target.get_state_set()
        if (identity != self.identity(target) or target.get_role() == self.api.Role.PASSWORD_TEXT
                or not states.contains(self.api.StateType.ENABLED)):
            raise RuntimeError("Target changed or is protected")
        if command.get("focusId") and (command["focusId"] != command["targetId"]
                                      or not states.contains(self.api.StateType.FOCUSED)):
            raise RuntimeError("Keyboard focus changed")
        if "x" in command:
            rect = target.get_component_iface().get_extents(self.api.CoordType.SCREEN)
            if abs(rect.x + rect.width / 2 - command["x"]) > 2 or abs(rect.y + rect.height / 2 - command["y"]) > 2:
                raise RuntimeError("Target moved; observe again")

    def execute(self, command):
        kind = command.get("kind")
        if kind == "probe":
            return dict(ok=True, accessibility=True)
        if kind == "inspect":
            return dict(ok=True, view=self.inspect())
        self.validate(command)
        target = self.targets[command["targetId"]][0]
        if kind == "invoke":
            index = self.action_index(target)
            if index is None or not target.get_action_iface().do_action(index):
                raise RuntimeError("Control does not support activation")
            return dict(ok=True)
        if kind == "fill":
            editable = target.get_editable_text_iface()
            if not target.get_state_set().contains(self.api.StateType.EDITABLE) or not editable or not editable.set_text_contents(command["text"]):
                raise RuntimeError("Control does not support replacing text")
            return dict(ok=True)
        if kind in ("move", "click", "scroll"):
            self.xdo("mousemove", "--sync", round(command["x"]), round(command["y"]))
        if kind == "click":
            self.xdo("click", "3" if command.get("button") == "right" else "1")
        elif kind == "scroll":
            delta = command["delta"]
            self.xdo("click", "--repeat", (abs(delta) + 119) // 120, "4" if delta > 0 else "5")
        elif kind == "type":
            self.xdo("type", "--clearmodifiers", "--delay", "0", "--", command["text"])
        elif kind == "key":
            keys = dict(Enter="Return", Escape="Escape", Tab="Tab", Backspace="BackSpace", Delete="Delete",
                        ArrowLeft="Left", ArrowRight="Right", ArrowUp="Up", ArrowDown="Down")
            self.xdo("key", "--clearmodifiers", keys[command["key"]])
        elif kind != "move":
            raise RuntimeError("Unsupported X11 action")
        return dict(ok=True)


def main():
    bridge = None
    for line in sys.stdin:
        try:
            if bridge is None:
                import gi
                gi.require_version("Atspi", "2.0")
                from gi.repository import Atspi
                Atspi.init()
                bridge = AccessibilityBridge(Atspi)
            result = bridge.execute(json.loads(line))
        except Exception as error:
            result = dict(ok=False, error=str(error)[:512])
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

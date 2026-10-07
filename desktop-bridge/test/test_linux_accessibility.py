import importlib.util
import pathlib
import types
import unittest

spec = importlib.util.spec_from_file_location("bridge", pathlib.Path(__file__).resolve().parents[1] / "src/linux-accessibility.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class States:
    def __init__(self, values): self.values = values
    def contains(self, value): return value in self.values


class Target:
    def __init__(self, name, role="text", states=("enabled", "showing", "focused"), children=()):
        self.name, self.role, self.states, self.children = name, role, list(states), children
        self.rect = types.SimpleNamespace(x=10, y=20, width=40, height=20)
    def clear_cache(self): pass
    def get_role_name(self): return self.role
    def get_role(self): return self.role
    def get_name(self): return self.name
    def get_state_set(self): return States(self.states)
    def get_component_iface(self): return self
    def get_extents(self, _): return self.rect
    def get_text_iface(self): return self
    def get_action_iface(self): return None
    def get_editable_text_iface(self): return None
    def get_character_count(self): return 8
    def get_text(self, start, end): return "contents"[start:end]
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]
    def get_process_id(self): return 42


class LinuxReaderTests(unittest.TestCase):
    def make(self):
        password = Target("Password", role="password")
        root = Target("Window", states=("active", "enabled", "showing"), children=(Target("Editor"), password))
        desktop = Target("Desktop", children=(Target("App", children=(root,)),))
        api = types.SimpleNamespace(set_timeout=lambda *_: None, get_desktop=lambda _: desktop,
                                    StateType=types.SimpleNamespace(ACTIVE="active", SHOWING="showing", ENABLED="enabled", FOCUSED="focused", EDITABLE="editable"),
                                    Role=types.SimpleNamespace(PASSWORD_TEXT="password"), CoordType=types.SimpleNamespace(SCREEN=0))
        def run(args, **kwargs):
            return types.SimpleNamespace(stdout="42" if args[1] == "getwindowpid" else "123")
        return bridge.AccessibilityBridge(api, run), root

    def test_focused_frame_found_without_active_state(self):
        frame = Target("Seek Bridge Fixture", states=("enabled", "showing"), children=(Target("Field"),))
        other = Target("Other window", states=("enabled", "showing"))
        desktop = Target("Desktop", children=(Target("App", children=(other, frame)),))
        api = types.SimpleNamespace(set_timeout=lambda *_: None, get_desktop=lambda _: desktop,
                                    StateType=types.SimpleNamespace(ACTIVE="active", SHOWING="showing", ENABLED="enabled", FOCUSED="focused", EDITABLE="editable"),
                                    Role=types.SimpleNamespace(PASSWORD_TEXT="password"), CoordType=types.SimpleNamespace(SCREEN=0))
        def run(args, **kwargs):
            return types.SimpleNamespace(stdout={"getwindowpid": "42", "getwindowname": "Seek Bridge Fixture"}.get(args[1], "123"))
        view = bridge.AccessibilityBridge(api, run).inspect()
        self.assertEqual(view["title"], "Seek Bridge Fixture")
        self.assertTrue(any(e["name"] == "Field" for e in view["elements"]))

    def test_password_values_omitted_and_refs_bind_live_targets(self):
        reader, root = self.make()
        view = reader.inspect()
        self.assertNotIn("value", view["elements"][2])
        command = dict(windowId="123", targetId="e2", focusId="e2")
        reader.validate(command)
        root.children[0].states.remove("focused")
        with self.assertRaisesRegex(RuntimeError, "focus"): reader.validate(command)

    def test_moved_target_and_foreground_change_are_rejected(self):
        reader, root = self.make()
        reader.inspect()
        command = dict(windowId="123", targetId="e2", x=30, y=30)
        reader.validate(command)
        root.children[0].rect.x = 100
        with self.assertRaisesRegex(RuntimeError, "moved"): reader.validate(command)
        reader.active_window = lambda: "different"
        with self.assertRaisesRegex(RuntimeError, "Foreground"): reader.validate(command)


if __name__ == "__main__": unittest.main()

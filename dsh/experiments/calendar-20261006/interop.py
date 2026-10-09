# An independent CalDAV client (python-caldav) against Seek's server: discovery, both calendars,
# create/read/update/delete events and to-dos, time-range search, and incremental sync.
import sys, datetime as dt
import caldav

url = sys.argv[1]
user = sys.argv[2] if len(sys.argv) > 2 else None
password = sys.argv[3] if len(sys.argv) > 3 else None
client = caldav.DAVClient(url=url, username=user, password=password)
principal = client.principal()
cals = {c.get_display_name(): c for c in principal.calendars()}
print("calendars", sorted(cals))
assert "Seek" in cals and "Seek To-dos" in cals, cals
events, todos = cals["Seek"], cals["Seek To-dos"]
print("components", events.get_supported_components(), todos.get_supported_components())

start = dt.datetime(2026, 10, 20, 15, 0, tzinfo=dt.timezone.utc)
ev = events.save_event(dtstart=start, dtend=start + dt.timedelta(hours=1), summary="Interop lunch", rrule={"FREQ": "WEEKLY", "COUNT": 3})
print("created", ev.url)
found = events.search(start=dt.datetime(2026, 10, 26, tzinfo=dt.timezone.utc), end=dt.datetime(2026, 10, 30, tzinfo=dt.timezone.utc), event=True, expand=False)
print("search hits (second week of the series)", len(found))
assert any("Interop lunch" in f.data for f in found)

token_objects = events.objects(load_objects=True)
before = len(list(token_objects))
ev.load()
ev.icalendar_component["summary"] = "Interop lunch (moved)"
ev.save()
again = events.event_by_url(ev.url)
again.load()
assert "Interop lunch (moved)" in again.data
print("updated ok")

sync = events.objects_by_sync_token(load_objects=True)
first_token = sync.sync_token
todo = todos.save_todo(summary="Interop: buy candles", due=dt.date(2026, 10, 21))
print("todo", todo.url)
todo.complete()
todo.load()
assert "COMPLETED" in todo.data
ev.delete()
changes = events.objects_by_sync_token(sync_token=first_token, load_objects=False)
print("changes since token", [str(o.url) for o in changes])
print("objects before/after", before, len(list(events.objects())))
print("INTEROP OK")
